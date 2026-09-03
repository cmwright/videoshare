/**
 * Uploading a video that already exists as a file (docs/SPEC.md §19).
 *
 * The recorder makes its bytes and knows everything about them. An imported
 * file is the other way round: the bytes arrive first, and what has to be
 * learned is the one string the player feeds to MSE (`meta.mimeType`, §8) and
 * whether MSE can be fed the file at all. Both come from the container — the
 * track table of a WebM, the `moov` of an MP4 — read from the file's head,
 * never from the whole file. The player never guesses at either: it plays what
 * `meta.json` says, and this module is what says it.
 *
 * Three halves, in the order they run:
 *
 * - **Sniffing** — pure byte parsing over a {@link ByteSource}, so it runs in
 *   Node under test with synthetic containers and in the browser over a `File`.
 * - **Probing** — browser only: a hidden element confirms this browser can
 *   play the file and reports its duration, and paints §3's thumbnail.
 * - **Uploading** — the file goes through the very same `UploadSession` the
 *   recorder uses (§7), one `CHUNK_SIZE` slice at a time, so the bytes in the
 *   bucket are indistinguishable from a recording's and every reader is
 *   untouched.
 */

import { CHUNK_SIZE } from "./crypto";
import { isBlankFrame, THUMB_JPEG_QUALITY, thumbSize } from "./thumbnail";
import type { VideoMeta } from "./types";
import type { UploadResult, UploadSession } from "./upload";

// --- Byte sources ------------------------------------------------------------

/** Random access into a file, the only thing sniffing needs from the browser. */
export interface ByteSource {
  readonly size: number;
  /** Bytes `[offset, offset + length)`, clipped at the end; empty past it. */
  read(offset: number, length: number): Promise<Uint8Array>;
}

export function blobSource(blob: Blob): ByteSource {
  return {
    size: blob.size,
    async read(offset, length) {
      const end = Math.min(blob.size, offset + length);
      if (offset >= end) return new Uint8Array(0);
      return new Uint8Array(await blob.slice(offset, end).arrayBuffer());
    },
  };
}

/** A whole file already in memory — tests, and nothing else. */
export function bytesSource(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.length,
    async read(offset, length) {
      const end = Math.min(bytes.length, offset + length);
      return offset >= end ? new Uint8Array(0) : bytes.slice(offset, end);
    },
  };
}

/**
 * How much of a file's head is read looking for its track table. A WebM's
 * `Tracks` and a faststart MP4's `moov` both sit within the first few KB; the
 * margin is for a `SeekHead`/`Void` reservation or a long `ftyp`/`free`.
 */
export const SNIFF_HEAD_BYTES = 1 << 20;

/**
 * Ceiling on one `moov` read. A `moov` at the end of a multi-GB MP4 is still
 * only its sample tables — a few MB at the very most — so anything past this
 * is not a `moov` this code should be buffering.
 */
export const MAX_MOOV_BYTES = 32 << 20;

/** Ceiling on the WebM `Tracks` element, for the same reason. */
export const MAX_TRACKS_BYTES = 1 << 20;

/**
 * How far into a WebM the walk to `Tracks` may go, head window included. A
 * `SeekHead`/`Void` reservation is tens of KB; a file whose track table is
 * megabytes in is not one this app should be buffering to find out about.
 */
export const MAX_WEBM_SCAN_BYTES = 8 << 20;

// --- What sniffing learns -----------------------------------------------------

export interface ContainerInfo {
  container: "webm" | "matroska" | "mp4";
  /** §5's `mimeType`: the container type with every track's codec, unquoted, as the engines write it. */
  mimeType: string;
  videoCodecs: string[];
  audioCodecs: string[];
  /**
   * Whether the file's bytes can be appended to an MSE `SourceBuffer` as they
   * are (§8). WebM always can. An MP4 can only when it is fragmented — a `moov`
   * carrying `mvex`, with the samples in `moof`/`mdat` pairs — because MSE's
   * ISO BMFF byte stream format has no place for a monolithic `mdat` indexed by
   * a `moov` at the other end of the file, and Chrome errors on one *after*
   * accepting the `moov`, which is too late for the player's fallback.
   */
  progressive: boolean;
}

// --- Small readers -----------------------------------------------------------

function u16(b: Uint8Array, i: number): number {
  return (b[i] << 8) | b[i + 1];
}

function u32(b: Uint8Array, i: number): number {
  return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
}

function u64(b: Uint8Array, i: number): number {
  return u32(b, i) * 0x1_0000_0000 + u32(b, i + 4);
}

function uintN(b: Uint8Array, start: number, end: number): number {
  let value = 0;
  for (let i = start; i < end; i++) value = value * 256 + b[i];
  return value;
}

function ascii(b: Uint8Array, start: number, end: number): string {
  let s = "";
  for (let i = start; i < end; i++) s += String.fromCharCode(b[i]);
  return s;
}

function hex2(n: number): string {
  return n.toString(16).padStart(2, "0").toUpperCase();
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// --- WebM / Matroska (EBML) --------------------------------------------------

const EBML_HEADER = 0x1a45dfa3;
const EBML_DOCTYPE = 0x4282;
const SEGMENT = 0x18538067;
const TRACKS = 0x1654ae6b;
const CLUSTER = 0x1f43b675;
const TRACK_ENTRY = 0xae;
const TRACK_TYPE = 0x83;
const CODEC_ID = 0x86;
const CODEC_PRIVATE = 0x63a2;

const TRACK_TYPE_VIDEO = 1;
const TRACK_TYPE_AUDIO = 2;

interface Vint {
  value: number;
  length: number;
  /** All value bits set: an "unknown size", legal for a master element (Segment, Cluster). */
  unknown: boolean;
}

/**
 * One EBML variable-length integer at `pos`. Element ids keep their length
 * marker (that is how they are tabulated); sizes drop it.
 */
function readVint(b: Uint8Array, pos: number, keepMarker: boolean): Vint | null {
  if (pos >= b.length) return null;
  const first = b[pos];
  if (first === 0) return null;
  let length = 1;
  let mask = 0x80;
  while ((first & mask) === 0) {
    length++;
    mask >>= 1;
  }
  if (length > 8 || pos + length > b.length) return null;
  let value = keepMarker ? first : first & (mask - 1);
  let allOnes = (first & (mask - 1)) === mask - 1;
  for (let i = 1; i < length; i++) {
    value = value * 256 + b[pos + i];
    if (b[pos + i] !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

interface EbmlElement {
  id: number;
  dataStart: number;
  /** Clipped to the bytes being walked; `size` is what the element declared. */
  dataEnd: number;
  size: number;
  unknownSize: boolean;
}

/** The element at `pos`, bounded by `end`; null when the bytes there are not one. */
function ebmlAt(b: Uint8Array, pos: number, end: number): EbmlElement | null {
  const id = readVint(b, pos, true);
  if (!id || id.length > 4) return null;
  const size = readVint(b, pos + id.length, false);
  if (!size) return null;
  const dataStart = pos + id.length + size.length;
  if (dataStart > end) return null;
  const dataEnd = size.unknown ? end : Math.min(end, dataStart + size.value);
  return { id: id.value, dataStart, dataEnd, size: size.unknown ? -1 : size.value, unknownSize: size.unknown };
}

function* ebmlChildren(b: Uint8Array, start: number, end: number): Generator<EbmlElement> {
  let pos = start;
  while (pos < end) {
    const element = ebmlAt(b, pos, end);
    if (!element) return;
    yield element;
    // A master of unknown size runs to the end of what is being walked, so
    // its siblings are not reachable from here; the caller descends instead.
    if (element.unknownSize) return;
    pos = element.dataEnd;
  }
}

interface WebmTrack {
  type: number;
  codecId: string;
  codecPrivate: Uint8Array | null;
}

function parseTracks(b: Uint8Array, start: number, end: number): WebmTrack[] {
  const tracks: WebmTrack[] = [];
  for (const entry of ebmlChildren(b, start, end)) {
    if (entry.id !== TRACK_ENTRY) continue;
    const track: WebmTrack = { type: 0, codecId: "", codecPrivate: null };
    for (const field of ebmlChildren(b, entry.dataStart, entry.dataEnd)) {
      if (field.id === TRACK_TYPE) track.type = uintN(b, field.dataStart, field.dataEnd);
      else if (field.id === CODEC_ID) track.codecId = ascii(b, field.dataStart, field.dataEnd);
      else if (field.id === CODEC_PRIVATE) track.codecPrivate = b.subarray(field.dataStart, field.dataEnd);
    }
    tracks.push(track);
  }
  return tracks;
}

/**
 * The codecs parameter a WebM track contributes, in the spelling the browsers
 * accept for `video/webm` — the short `vp8`/`vp9`/`opus`/`vorbis` MediaRecorder
 * itself writes, and the full `av01.…` string for AV1, which is the one codec
 * whose short name is not universally recognised.
 */
function webmCodec(track: WebmTrack): string {
  const id = track.codecId;
  switch (id) {
    case "V_VP8":
      return "vp8";
    case "V_VP9":
      return "vp9";
    case "V_AV1":
      return av1CodecString(track.codecPrivate);
    case "V_MPEG4/ISO/AVC":
      return avcCodecString("avc1", track.codecPrivate);
    case "V_MPEGH/ISO/HEVC":
      return hevcCodecString("hvc1", track.codecPrivate);
    case "A_OPUS":
      return "opus";
    case "A_VORBIS":
      return "vorbis";
    case "A_FLAC":
      return "flac";
    case "A_AAC":
      return "mp4a.40.2";
    case "A_MPEG/L3":
      return "mp3";
    default:
      // Unknown to this table: hand the browser the id's own last segment,
      // lowercased, and let `isTypeSupported` say no. A miss here only costs
      // the streaming path (§8 falls back to the whole file).
      return id.replace(/^[AV]_/, "").split("/")[0].toLowerCase();
  }
}

/** The longest an element header can be: a 4-byte id and an 8-byte size. */
const EBML_HEADER_MAX = 12;

async function sniffWebm(source: ByteSource, head: Uint8Array): Promise<ContainerInfo | null> {
  const header = ebmlAt(head, 0, head.length);
  if (!header || header.id !== EBML_HEADER || header.unknownSize) return null;

  let docType = "";
  for (const field of ebmlChildren(head, header.dataStart, header.dataEnd)) {
    if (field.id === EBML_DOCTYPE) docType = ascii(head, field.dataStart, field.dataEnd);
  }
  const container = docType === "matroska" ? "matroska" : "webm";

  const segment = ebmlAt(head, header.dataEnd, head.length);
  if (!segment || segment.id !== SEGMENT) return null;

  // The buffer grows only when the walk runs off its end — a `Void` reservation
  // the size of the window, or a track table that straddles it — and then by
  // exactly what is needed, bounded so a walk into garbage cannot buffer a file.
  let buf = head;
  const extend = async (need: number): Promise<boolean> => {
    if (need <= buf.length) return true;
    if (need > MAX_WEBM_SCAN_BYTES || need > source.size) return false;
    const more = await source.read(buf.length, need - buf.length);
    if (more.length < need - buf.length) return false;
    const grown = new Uint8Array(need);
    grown.set(buf, 0);
    grown.set(more, buf.length);
    buf = grown;
    return true;
  };

  let tracks: WebmTrack[] | null = null;
  let pos = segment.dataStart;
  while (pos < source.size) {
    await extend(Math.min(source.size, pos + EBML_HEADER_MAX));
    const child = ebmlAt(buf, pos, buf.length);
    if (!child || child.id === CLUSTER) break;
    if (child.id === TRACKS) {
      if (child.unknownSize || child.size > MAX_TRACKS_BYTES) return null;
      if (!(await extend(child.dataStart + child.size))) return null;
      tracks = parseTracks(buf, child.dataStart, child.dataStart + child.size);
      break;
    }
    // Only Segment and Cluster may legally be unsized; anything else that is
    // cannot be stepped over, and the table is not going to turn up behind it.
    if (child.unknownSize) break;
    pos = child.dataStart + child.size;
  }
  if (!tracks) return null;

  const videoCodecs = tracks.filter((t) => t.type === TRACK_TYPE_VIDEO).map(webmCodec);
  const audioCodecs = tracks.filter((t) => t.type === TRACK_TYPE_AUDIO).map(webmCodec);
  const type = container === "matroska" ? "video/x-matroska" : "video/webm";
  return {
    container,
    mimeType: withCodecs(type, [...videoCodecs, ...audioCodecs]),
    videoCodecs,
    audioCodecs,
    progressive: true,
  };
}

// --- MP4 (ISO BMFF) ----------------------------------------------------------

interface Box {
  type: string;
  /** Where the box's payload starts (after its header). */
  dataStart: number;
  /** Where the box ends: its own end, or `end` for a size-0 "to end of file" box. */
  end: number;
}

/** Header sizes: 8 bytes, or 16 with a 64-bit `largesize`. */
function boxHeader(b: Uint8Array, pos: number, end: number): Box | null {
  if (pos + 8 > end) return null;
  let size = u32(b, pos);
  const type = ascii(b, pos + 4, pos + 8);
  let headerLength = 8;
  if (size === 1) {
    if (pos + 16 > end) return null;
    size = u64(b, pos + 8);
    headerLength = 16;
  } else if (size === 0) {
    size = end - pos;
  }
  if (size < headerLength) return null;
  return { type, dataStart: pos + headerLength, end: Math.min(end, pos + size) };
}

function* boxes(b: Uint8Array, start: number, end: number): Generator<Box> {
  let pos = start;
  while (pos + 8 <= end) {
    const box = boxHeader(b, pos, end);
    if (!box) return;
    yield box;
    if (box.end <= pos) return;
    pos = box.end;
  }
}

function findBox(b: Uint8Array, start: number, end: number, type: string): Box | null {
  for (const box of boxes(b, start, end)) if (box.type === type) return box;
  return null;
}

/** `size + type` at an absolute file offset, from the head window or the source. */
async function boxAtOffset(source: ByteSource, head: Uint8Array, offset: number): Promise<Box | null> {
  if (offset + 16 <= head.length) return boxHeader(head, offset, source.size);
  const bytes = await source.read(offset, 16);
  const box = boxHeader(bytes, 0, 16);
  if (!box) return null;
  // Re-express against the file, not the 16-byte window.
  const headerLength = box.dataStart;
  const size = u32(bytes, 0) === 1 ? u64(bytes, 8) : u32(bytes, 0) || source.size - offset;
  return { type: box.type, dataStart: offset + headerLength, end: Math.min(source.size, offset + size) };
}

function avcCodecString(prefix: string, avcC: Uint8Array | null): string {
  // avcC: configurationVersion, AVCProfileIndication, profile_compatibility, AVCLevelIndication.
  if (!avcC || avcC.length < 4) return prefix;
  return `${prefix}.${hex2(avcC[1])}${hex2(avcC[2])}${hex2(avcC[3])}`;
}

function hevcCodecString(prefix: string, hvcC: Uint8Array | null): string {
  // ISO/IEC 14496-15 Annex E: hvc1.[space]profile.compat.[tier]level.constraints
  if (!hvcC || hvcC.length < 13) return prefix;
  const profileSpace = hvcC[1] >> 6;
  const tier = (hvcC[1] >> 5) & 1;
  const profile = hvcC[1] & 0x1f;
  // The 32 compatibility flags are written reversed, as a hex number.
  let flags = u32(hvcC, 2);
  let reversed = 0;
  for (let i = 0; i < 32; i++) {
    reversed = (reversed << 1) | (flags & 1);
    flags >>>= 1;
  }
  const constraints: string[] = [];
  for (let i = 11; i >= 6; i--) {
    if (constraints.length === 0 && hvcC[i] === 0) continue;
    constraints.unshift(hex2(hvcC[i]));
  }
  const space = ["", "A", "B", "C"][profileSpace];
  const parts = [
    `${space}${profile}`,
    (reversed >>> 0).toString(16).toUpperCase(),
    `${tier ? "H" : "L"}${hvcC[12]}`,
    ...constraints,
  ];
  return `${prefix}.${parts.join(".")}`;
}

function av1CodecString(av1C: Uint8Array | null): string {
  // av1C: marker/version, seq_profile(3) seq_level_idx(5), tier(1) high_bitdepth(1) twelve_bit(1) …
  if (!av1C || av1C.length < 4) return "av01.0.04M.08";
  const profile = av1C[1] >> 5;
  const level = av1C[1] & 0x1f;
  const tier = (av1C[2] >> 7) & 1;
  const high = (av1C[2] >> 6) & 1;
  const twelve = (av1C[2] >> 5) & 1;
  const depth = high ? (twelve ? 12 : 10) : 8;
  return `av01.${profile}.${pad2(level)}${tier ? "H" : "M"}.${pad2(depth)}`;
}

function vpCodecString(prefix: string, vpcC: Uint8Array | null): string {
  // vpcC is a full box: 4 bytes version/flags, then profile, level, bitDepth(4)|chroma(3)|range(1).
  if (!vpcC || vpcC.length < 7) return prefix;
  return `${prefix}.${pad2(vpcC[4])}.${pad2(vpcC[5])}.${pad2(vpcC[6] >> 4)}`;
}

/**
 * `mp4a.{objectTypeIndication}.{audioObjectType}` out of the `esds` descriptor
 * chain; AAC-LC when the chain is not there to say otherwise.
 */
function mp4aCodecString(esds: Uint8Array | null): string {
  if (!esds) return "mp4a.40.2";
  // Skip the full-box header, then walk tag-length descriptors. Lengths are
  // 1–4 bytes, 7 bits each with a continuation bit.
  let pos = 4;
  let oti = 0x40;
  let aot = 2;
  const descriptor = (): { tag: number; start: number; end: number } | null => {
    if (pos >= esds.length) return null;
    const tag = esds[pos++];
    let length = 0;
    for (let i = 0; i < 4 && pos < esds.length; i++) {
      const byte = esds[pos++];
      length = (length << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) break;
    }
    return { tag, start: pos, end: Math.min(esds.length, pos + length) };
  };
  for (let guard = 0; guard < 8; guard++) {
    const d = descriptor();
    if (!d) break;
    if (d.tag === 0x03) {
      // ES_Descriptor: ES_ID(2), flags(1) [+ dependsOn(2)] [+ URL] [+ OCR(2)], then children.
      const flags = esds[d.start + 2];
      pos = d.start + 3;
      if (flags & 0x80) pos += 2;
      if (flags & 0x40) pos += 1 + esds[pos];
      if (flags & 0x20) pos += 2;
      continue;
    }
    if (d.tag === 0x04) {
      oti = esds[d.start];
      pos = d.start + 13; // objectTypeIndication(1) streamType(1) bufferSize(3) maxBitrate(4) avgBitrate(4)
      continue;
    }
    if (d.tag === 0x05) {
      if (d.start < esds.length) aot = esds[d.start] >> 3;
      break;
    }
    pos = d.end;
  }
  return `mp4a.${oti.toString(16).toUpperCase()}.${aot}`;
}

/** Offsets at which a sample entry's child boxes can start, by entry kind and version. */
const VISUAL_ENTRY_CHILDREN = [78];
const AUDIO_ENTRY_CHILDREN = [28, 44, 64];

function sampleEntryChild(b: Uint8Array, entry: Box, kind: "video" | "audio", type: string): Uint8Array | null {
  const starts = kind === "video" ? VISUAL_ENTRY_CHILDREN : AUDIO_ENTRY_CHILDREN;
  for (const start of starts) {
    const child = findBox(b, entry.dataStart + start, entry.end, type);
    if (child) return b.subarray(child.dataStart, child.end);
  }
  return null;
}

function mp4Codec(b: Uint8Array, entry: Box, kind: "video" | "audio"): string {
  const type = entry.type;
  const child = (name: string): Uint8Array | null => sampleEntryChild(b, entry, kind, name);
  switch (type) {
    case "avc1":
    case "avc3":
      return avcCodecString(type, child("avcC"));
    case "hvc1":
    case "hev1":
      return hevcCodecString(type, child("hvcC"));
    case "av01":
      return av1CodecString(child("av1C"));
    case "vp09":
    case "vp08":
      return vpCodecString(type, child("vpcC"));
    case "mp4a":
      return mp4aCodecString(child("esds"));
    case "Opus":
      return "opus";
    case "fLaC":
      return "flac";
    case "ac-3":
    case "ec-3":
    case ".mp3":
      return type === ".mp3" ? "mp3" : type;
    default:
      return type.trim();
  }
}

/** Handler type of a `trak`: `vide`, `soun`, or something this ignores. */
function trackKind(b: Uint8Array, mdia: Box): "video" | "audio" | null {
  const hdlr = findBox(b, mdia.dataStart, mdia.end, "hdlr");
  if (!hdlr || hdlr.dataStart + 12 > hdlr.end) return null;
  const handler = ascii(b, hdlr.dataStart + 8, hdlr.dataStart + 12);
  return handler === "vide" ? "video" : handler === "soun" ? "audio" : null;
}

function parseMoov(b: Uint8Array, moov: Box): Omit<ContainerInfo, "container" | "mimeType"> {
  const videoCodecs: string[] = [];
  const audioCodecs: string[] = [];
  let fragmented = false;

  for (const child of boxes(b, moov.dataStart, moov.end)) {
    if (child.type === "mvex") fragmented = true;
    if (child.type !== "trak") continue;
    const mdia = findBox(b, child.dataStart, child.end, "mdia");
    if (!mdia) continue;
    const kind = trackKind(b, mdia);
    if (!kind) continue;
    const minf = findBox(b, mdia.dataStart, mdia.end, "minf");
    const stbl = minf && findBox(b, minf.dataStart, minf.end, "stbl");
    const stsd = stbl && findBox(b, stbl.dataStart, stbl.end, "stsd");
    if (!stsd || stsd.dataStart + 8 > stsd.end) continue;
    // Full box (4) + entry_count (4), then the sample entries themselves.
    const entries = Array.from(boxes(b, stsd.dataStart + 8, stsd.end));
    const codecs = kind === "video" ? videoCodecs : audioCodecs;
    // The first entry is the one MSE is told about; a second is vanishingly rare.
    if (entries.length > 0) codecs.push(mp4Codec(b, entries[0], kind));
  }
  return { videoCodecs, audioCodecs, progressive: fragmented };
}

async function sniffMp4(source: ByteSource, head: Uint8Array): Promise<ContainerInfo | null> {
  let offset = 0;
  // Walk the top level by size until `moov`. Bounded, because a walk that
  // follows sizes into garbage should give up rather than seek forever.
  for (let guard = 0; guard < 64 && offset + 8 <= source.size; guard++) {
    const box = await boxAtOffset(source, head, offset);
    if (!box || box.end <= offset) return null;
    if (box.type === "moov") {
      const length = box.end - box.dataStart;
      if (length > MAX_MOOV_BYTES) return null;
      const bytes =
        box.end <= head.length ? head.subarray(box.dataStart, box.end) : await source.read(box.dataStart, length);
      const parsed = parseMoov(bytes, { type: "moov", dataStart: 0, end: bytes.length });
      return {
        container: "mp4",
        mimeType: withCodecs("video/mp4", [...parsed.videoCodecs, ...parsed.audioCodecs]),
        ...parsed,
      };
    }
    offset = box.end;
  }
  return null;
}

function withCodecs(type: string, codecs: readonly string[]): string {
  return codecs.length > 0 ? `${type};codecs=${codecs.join(",")}` : type;
}

// --- Entry point -------------------------------------------------------------

/**
 * What the file's container says about itself, or null when it is neither a
 * WebM/Matroska nor an ISO BMFF file this code can read. Null is not "cannot
 * play" — that is the browser's call (`probeMedia`) — it is "cannot describe",
 * and §19 refuses the file because a `meta.mimeType` that names nothing would
 * leave every player guessing.
 */
export async function sniffContainer(source: ByteSource): Promise<ContainerInfo | null> {
  const head = await source.read(0, SNIFF_HEAD_BYTES);
  if (head.length < 12) return null;
  if (u32(head, 0) === EBML_HEADER) return sniffWebm(source, head);
  if (ascii(head, 4, 8) === "ftyp") return sniffMp4(source, head);
  return null;
}

// --- Planning the upload -----------------------------------------------------

export interface ImportDetails {
  title: string;
  mimeType: string;
  durationMs: number;
  progressive: boolean;
  /** ISO 8601; defaults to now. */
  createdAt?: string;
}

/**
 * §5's metadata for a file of `size` bytes: the chunk arithmetic the recorder
 * does incrementally, done once up front. `progressive` is written only when
 * it is false, so the metadata of the common case is byte-for-byte what a
 * recording writes (§5: absent means true).
 */
export function planImport(size: number, details: ImportDetails): VideoMeta {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error("The file is empty.");
  }
  const meta: VideoMeta = {
    v: 1,
    title: details.title,
    mimeType: details.mimeType,
    durationMs: Math.max(0, Math.round(details.durationMs)),
    totalBytes: size,
    chunkSize: CHUNK_SIZE,
    chunkCount: Math.ceil(size / CHUNK_SIZE),
    createdAt: details.createdAt ?? new Date().toISOString(),
  };
  if (!details.progressive) meta.progressive = false;
  return meta;
}

/** One import in flight; `nextChunk` is what a retry resumes from. */
export interface ImportJob {
  file: Blob;
  meta: VideoMeta;
  /** §3's already-encrypted thumbnail block, or null. */
  thumb: Uint8Array | null;
  /** Index of the next full chunk to hand the session. */
  nextChunk: number;
}

export function createImportJob(file: Blob, meta: VideoMeta, thumb: Uint8Array | null): ImportJob {
  return { file, meta, thumb, nextChunk: 0 };
}

async function slice(file: Blob, index: number, chunkSize: number): Promise<Uint8Array> {
  const start = index * chunkSize;
  return new Uint8Array(await file.slice(start, Math.min(file.size, start + chunkSize)).arrayBuffer());
}

/**
 * Feeds the file to the session and finishes it (§7): every full chunk through
 * `addChunk`, the final one through `finish`, one slice in memory at a time.
 * Resumable — `job.nextChunk` advances as chunks are handed over, and
 * `finish()` is already safe to call again — so a failed attempt is retried by
 * calling this again with the same job.
 */
export async function runImport(session: UploadSession, job: ImportJob): Promise<UploadResult> {
  const { meta, file } = job;
  const fullChunks = meta.chunkCount - 1;
  while (job.nextChunk < fullChunks) {
    await session.addChunk(await slice(file, job.nextChunk, meta.chunkSize));
    job.nextChunk++;
  }
  const tail = await slice(file, fullChunks, meta.chunkSize);
  return session.finish(tail, meta, job.thumb);
}

// --- Probing (browser only) --------------------------------------------------

/** How long the hidden element gets to report metadata, or a frame, before an attempt gives up. */
const PROBE_TIMEOUT_MS = 8_000;

export interface MediaProbe {
  durationMs: number;
  width: number;
  height: number;
}

function hiddenElement(url: string): HTMLVideoElement {
  const element = document.createElement("video");
  element.muted = true;
  element.defaultMuted = true;
  element.playsInline = true;
  element.preload = "auto";
  element.setAttribute("aria-hidden", "true");
  element.tabIndex = -1;
  element.style.cssText =
    "position:fixed;left:-10000px;top:0;width:2px;height:2px;opacity:0;pointer-events:none;";
  element.src = url;
  (document.body ?? document.documentElement).append(element);
  return element;
}

/**
 * Resolves with the first of `types` the element fires, or `"timeout"`.
 *
 * The clock only runs while the document is visible: Chrome defers a media
 * element's load in a background tab until the tab is shown again, so a reader
 * who picks a file and switches away would otherwise come back to "did not
 * finish reading the file" for a file that was never given the chance.
 */
function untilEvent(element: HTMLVideoElement, types: readonly string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let timer = 0;
    const finish = (type: string) => (): void => {
      window.clearTimeout(timer);
      for (const [name, handler] of handlers) element.removeEventListener(name, handler);
      resolve(type);
    };
    const handlers = types.map((type) => [type, finish(type)] as const);
    const expire = (): void => {
      if (document.visibilityState === "hidden") {
        timer = window.setTimeout(expire, timeoutMs);
        return;
      }
      finish("timeout")();
    };
    timer = window.setTimeout(expire, timeoutMs);
    for (const [name, handler] of handlers) element.addEventListener(name, handler);
  });
}

function dispose(element: HTMLVideoElement): void {
  element.pause();
  element.removeAttribute("src");
  element.load();
  element.remove();
}

/**
 * Whether *this* browser can play the file, and what it says about it.
 * Rejects with a sentence for the reader when it cannot: an import that this
 * browser cannot play is one no viewer is likely to either, and the reader
 * should hear that before uploading it.
 *
 * A WebM without a duration in its header — every MediaRecorder recording,
 * and every recording this app made — reports `Infinity` until the element is
 * seeked past the end, so the standard probe (§6) runs here too.
 */
export async function probeMedia(url: string): Promise<MediaProbe> {
  const element = hiddenElement(url);
  try {
    const first = await untilEvent(element, ["loadedmetadata", "error"], PROBE_TIMEOUT_MS);
    if (first === "error") throw new Error(mediaErrorText(element));
    if (first === "timeout") throw new Error("This browser did not finish reading the file.");
    if (element.videoWidth === 0 || element.videoHeight === 0) {
      throw new Error("This file has no video track this browser can play.");
    }
    if (element.duration === Infinity) {
      const probed = untilEvent(element, ["durationchange", "error"], PROBE_TIMEOUT_MS);
      element.currentTime = 1e101;
      await probed;
    }
    const seconds = element.duration;
    return {
      durationMs: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0,
      width: element.videoWidth,
      height: element.videoHeight,
    };
  } finally {
    dispose(element);
  }
}

function mediaErrorText(element: HTMLVideoElement): string {
  const code = element.error?.code;
  if (code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED || code === MediaError.MEDIA_ERR_DECODE) {
    return "This browser cannot play this file, so viewers will not be able to either.";
  }
  return "This browser could not read the file.";
}

/** Where §3's thumbnail is taken from: a second in, unless the file is shorter. */
export function thumbnailTimeMs(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 0;
  return Math.min(1000, Math.floor(durationMs / 2));
}

/** The second try, when the first frame painted black (§6's rule, applied at file offsets). */
export function thumbnailRetryTimeMs(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 0;
  return Math.min(Math.max(2500, Math.floor(durationMs / 10)), Math.floor(durationMs / 2));
}

/**
 * One JPEG frame of the file, scaled by §6's rules, or null on any failure —
 * §3's contract: a video without a thumbnail is a working video. Two attempts
 * at two offsets, never a loop, for the same reason the recorder makes two.
 */
export async function captureFileThumbnail(url: string, durationMs: number): Promise<Uint8Array | null> {
  if (typeof document === "undefined") return null;
  const element = hiddenElement(url);
  try {
    const ready = await untilEvent(element, ["loadedmetadata", "error"], PROBE_TIMEOUT_MS);
    if (ready !== "loadedmetadata") return null;
    for (const at of [thumbnailTimeMs(durationMs), thumbnailRetryTimeMs(durationMs)]) {
      const seeked = untilEvent(element, ["seeked", "error"], PROBE_TIMEOUT_MS);
      element.currentTime = at / 1000;
      if ((await seeked) !== "seeked") return null;
      const jpeg = await paintFrame(element);
      if (jpeg) return jpeg;
    }
    return null;
  } catch (err) {
    console.warn("[videoshare] thumbnail capture failed; the upload is unaffected", err);
    return null;
  } finally {
    dispose(element);
  }
}

async function paintFrame(element: HTMLVideoElement): Promise<Uint8Array | null> {
  const size = thumbSize(element.videoWidth, element.videoHeight);
  if (!size) return null;
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(element, 0, 0, size.width, size.height);
  if (isBlankFrame(context.getImageData(0, 0, size.width, size.height))) return null;
  const blob = await new Promise<Blob | null>((resolve) => {
    try {
      canvas.toBlob(resolve, "image/jpeg", THUMB_JPEG_QUALITY);
    } catch {
      resolve(null);
    }
  });
  if (!blob || blob.size === 0) return null;
  return new Uint8Array(await blob.arrayBuffer());
}
