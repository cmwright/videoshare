/**
 * Uploading an existing file (docs/SPEC.md §19, §13).
 *
 * What is worth testing here is the part that decides what `meta.json` will
 * say: the container sniffer, which turns a WebM's track table or an MP4's
 * `moov` into the codec string MSE is fed (§8) and the one bit that says
 * whether MSE can be fed the file at all. Every container below is built by
 * hand, byte for byte, so the cases pin the parser to the layouts the specs
 * describe rather than to whatever some encoder happened to emit.
 *
 * The chunk arithmetic and the session choreography are tested against a fake
 * session; the browser half (a hidden element, a canvas) is not run in Node,
 * for the reason `record.ts` is not.
 */

import { describe, expect, it } from "vitest";
import { CHUNK_SIZE } from "../src/crypto";
import {
  bytesSource,
  createImportJob,
  MAX_TRACKS_BYTES,
  MAX_WEBM_SCAN_BYTES,
  planImport,
  runImport,
  SNIFF_HEAD_BYTES,
  sniffContainer,
  thumbnailRetryTimeMs,
  thumbnailTimeMs,
} from "../src/import";
import { progressiveNote, titleFromFilename } from "../src/import-view";
import type { VideoMeta } from "../src/types";
import type { UploadResult, UploadSession } from "../src/upload";

// --- Byte helpers ------------------------------------------------------------

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function ascii(s: string): Uint8Array {
  return new Uint8Array([...s].map((c) => c.charCodeAt(0)));
}

function be32(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

function be64(n: number): Uint8Array {
  return concat(be32(Math.floor(n / 0x1_0000_0000)), be32(n >>> 0));
}

const zeros = (n: number): Uint8Array => new Uint8Array(n);

// --- EBML / WebM builders ----------------------------------------------------

/** An element id, written with its length marker as it is tabulated. */
function ebmlId(id: number): Uint8Array {
  const bytes: number[] = [];
  let n = id;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n = Math.floor(n / 256);
  }
  return new Uint8Array(bytes);
}

/** The shortest size vint for `n`; the 8-byte form when asked, or for large sizes. */
function ebmlSize(n: number, wide = false): Uint8Array {
  if (!wide && n < 0x7f) return new Uint8Array([0x80 | n]);
  return concat(new Uint8Array([0x01]), be64(n).subarray(1));
}

const UNKNOWN_SIZE = new Uint8Array([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

function el(id: number, ...payload: Uint8Array[]): Uint8Array {
  const body = concat(...payload);
  return concat(ebmlId(id), ebmlSize(body.length), body);
}

function elUnknown(id: number, ...payload: Uint8Array[]): Uint8Array {
  return concat(ebmlId(id), UNKNOWN_SIZE, ...payload);
}

/** An element whose declared size is not what follows — for the bounds checks. */
function elDeclared(id: number, declared: number, ...payload: Uint8Array[]): Uint8Array {
  return concat(ebmlId(id), ebmlSize(declared, true), ...payload);
}

function uintEl(id: number, n: number): Uint8Array {
  return el(id, new Uint8Array([n]));
}

const EBML = 0x1a45dfa3;
const DOCTYPE = 0x4282;
const SEGMENT = 0x18538067;
const INFO = 0x1549a966;
const TRACKS = 0x1654ae6b;
const CLUSTER = 0x1f43b675;
const VOID = 0xec;
const TRACK_ENTRY = 0xae;
const TRACK_NUMBER = 0xd7;
const TRACK_TYPE = 0x83;
const CODEC_ID = 0x86;
const CODEC_PRIVATE = 0x63a2;

interface Track {
  type: 1 | 2;
  codec: string;
  priv?: Uint8Array;
}

function trackEntry(n: number, t: Track): Uint8Array {
  return el(
    TRACK_ENTRY,
    uintEl(TRACK_NUMBER, n),
    uintEl(TRACK_TYPE, t.type),
    el(CODEC_ID, ascii(t.codec)),
    ...(t.priv ? [el(CODEC_PRIVATE, t.priv)] : []),
  );
}

function tracksEl(tracks: Track[]): Uint8Array {
  return el(TRACKS, ...tracks.map((t, i) => trackEntry(i + 1, t)));
}

interface WebmOptions {
  docType?: string;
  /** Streaming-shaped: the Segment declares no size, the way MediaRecorder and webm-muxer write it. */
  unknownSegment?: boolean;
  /** Bytes of padding before the track table, to push it past the head window. */
  padBefore?: number;
  tracksOverride?: Uint8Array;
}

function webm(tracks: Track[], opts: WebmOptions = {}): Uint8Array {
  const header = el(EBML, el(DOCTYPE, ascii(opts.docType ?? "webm")));
  const info = el(INFO, el(0x2ad7b1, new Uint8Array([0x0f, 0x42, 0x40])));
  const pad = opts.padBefore ? el(VOID, zeros(opts.padBefore)) : new Uint8Array(0);
  const table = opts.tracksOverride ?? tracksEl(tracks);
  const body = [info, pad, table, CLUSTER_EL];
  const segment = opts.unknownSegment ? elUnknown(SEGMENT, ...body) : el(SEGMENT, ...body);
  return concat(header, segment);
}

/** The first Cluster, always last in a built file: what a walk must never read into. */
const CLUSTER_EL = elUnknown(CLUSTER, el(0xe7, new Uint8Array([0])), zeros(64));

const VP9: Track = { type: 1, codec: "V_VP9" };
const VP8: Track = { type: 1, codec: "V_VP8" };
const OPUS: Track = { type: 2, codec: "A_OPUS" };

// --- ISO BMFF / MP4 builders -------------------------------------------------

function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const body = concat(...payload);
  return concat(be32(8 + body.length), ascii(type), body);
}

function fullBox(type: string, ...payload: Uint8Array[]): Uint8Array {
  return box(type, zeros(4), ...payload);
}

/** A box with the 64-bit `largesize` header form. */
function largeBox(type: string, ...payload: Uint8Array[]): Uint8Array {
  const body = concat(...payload);
  return concat(be32(1), ascii(type), be64(16 + body.length), body);
}

function ftyp(): Uint8Array {
  return box("ftyp", ascii("isom"), be32(0x200), ascii("isomiso2avc1mp41"));
}

function visualEntry(type: string, ...children: Uint8Array[]): Uint8Array {
  return box(type, zeros(78), ...children);
}

function audioEntry(type: string, version: 0 | 1 | 2, ...children: Uint8Array[]): Uint8Array {
  const fixed = version === 0 ? 28 : version === 1 ? 44 : 64;
  const head = zeros(fixed);
  head[8] = 0;
  head[9] = version;
  return box(type, head, ...children);
}

function trak(kind: "vide" | "soun" | "hint", entry: Uint8Array): Uint8Array {
  const hdlr = fullBox("hdlr", be32(0), ascii(kind), zeros(12), new Uint8Array([0]));
  const stsd = fullBox("stsd", be32(1), entry);
  return box("trak", box("mdia", hdlr, box("minf", box("stbl", stsd))));
}

function moov(traks: Uint8Array[], fragmented = false): Uint8Array {
  const mvex = fragmented ? [box("mvex", box("trex", zeros(24)))] : [];
  return box("moov", fullBox("mvhd", zeros(96)), ...traks, ...mvex);
}

const AVCC = new Uint8Array([1, 0x64, 0x00, 0x1f, 0xff, 0xe1]);
const AVC1 = visualEntry("avc1", box("avcC", AVCC));
const AAC = audioEntry("mp4a", 0, fullBox("esds", esds(0x40, 2)));

/** ES_Descriptor → DecoderConfigDescriptor → DecoderSpecificInfo, with `oti` and audio object type `aot`. */
function esds(oti: number, aot: number): Uint8Array {
  const dsi = new Uint8Array([0x05, 2, (aot << 3) | 0x04, 0x10]);
  const dcd = concat(new Uint8Array([0x04, 13 + dsi.length, oti, 0x15]), zeros(11), dsi);
  return concat(new Uint8Array([0x03, 3 + dcd.length, 0, 1, 0]), dcd);
}

// --- Sniffing: WebM ----------------------------------------------------------

describe("sniffContainer — WebM", () => {
  it("names the container and every track, in the spelling MediaRecorder writes", async () => {
    const info = await sniffContainer(bytesSource(webm([VP9, OPUS])));
    expect(info).toEqual({
      container: "webm",
      mimeType: "video/webm;codecs=vp9,opus",
      videoCodecs: ["vp9"],
      audioCodecs: ["opus"],
      progressive: true,
    });
  });

  it("reads a streaming-shaped file whose Segment declares no size", async () => {
    // What MediaRecorder and webm-muxer's streaming mode both write — every
    // recording this app has ever made.
    const info = await sniffContainer(bytesSource(webm([VP8, OPUS], { unknownSegment: true })));
    expect(info?.mimeType).toBe("video/webm;codecs=vp8,opus");
  });

  it("is video-only when there is no audio track", async () => {
    const info = await sniffContainer(bytesSource(webm([VP9])));
    expect(info?.mimeType).toBe("video/webm;codecs=vp9");
    expect(info?.audioCodecs).toEqual([]);
  });

  it("spells AV1 out from its CodecPrivate, since its short name is not universal", async () => {
    // av1C: marker|version, profile 0 + level 8 (4.0), main tier, 8-bit.
    const main8 = { type: 1 as const, codec: "V_AV1", priv: new Uint8Array([0x81, 0x08, 0x00, 0x00]) };
    expect((await sniffContainer(bytesSource(webm([main8, OPUS]))))?.mimeType).toBe(
      "video/webm;codecs=av01.0.08M.08,opus",
    );
    // Profile 2, level 13 (5.1), high tier, 10-bit.
    const high10 = { type: 1 as const, codec: "V_AV1", priv: new Uint8Array([0x81, 0x4d, 0xc0, 0x00]) };
    expect((await sniffContainer(bytesSource(webm([high10]))))?.videoCodecs).toEqual(["av01.2.13H.10"]);
    // No CodecPrivate at all: a plausible string rather than nothing, because
    // the level only affects `isTypeSupported`'s answer, never the decode.
    const bare = { type: 1 as const, codec: "V_AV1" };
    expect((await sniffContainer(bytesSource(webm([bare]))))?.videoCodecs).toEqual(["av01.0.04M.08"]);
  });

  it("calls a Matroska file what it is, H.264 and all", async () => {
    const h264 = { type: 1 as const, codec: "V_MPEG4/ISO/AVC", priv: AVCC };
    const info = await sniffContainer(bytesSource(webm([h264, OPUS], { docType: "matroska" })));
    expect(info?.container).toBe("matroska");
    // `isTypeSupported` says no to this, so the player downloads the whole
    // file — which Chrome then plays. The string is still honest.
    expect(info?.mimeType).toBe("video/x-matroska;codecs=avc1.64001F,opus");
  });

  it("hands an unknown codec id to the browser rather than refusing the file", async () => {
    const odd = { type: 2 as const, codec: "A_PCM/INT/LIT" };
    const info = await sniffContainer(bytesSource(webm([VP9, odd])));
    expect(info?.audioCodecs).toEqual(["pcm"]);
  });

  it("reads on past the head window, by exactly what the track table needs", async () => {
    const table = tracksEl([VP9, OPUS]);
    // Two placements: the table's payload straddles the window, and the table's
    // own header falls past it. Both are one short walk, not a second window.
    for (const slack of [table.length - 4, -40]) {
      const reads: [number, number][] = [];
      const bytes = webm([VP9, OPUS], { padBefore: SNIFF_HEAD_BYTES - 40 - slack });
      const source = bytesSource(bytes);
      const info = await sniffContainer({
        size: source.size,
        read(offset, length) {
          reads.push([offset, length]);
          return source.read(offset, length);
        },
      });
      expect(info?.mimeType).toBe("video/webm;codecs=vp9,opus");
      expect(reads[0]).toEqual([0, SNIFF_HEAD_BYTES]);
      // Every later read continues where the buffer ended, and the walk stops
      // at the table's end: never a second window, never into the Cluster.
      let end = SNIFF_HEAD_BYTES;
      for (const [offset, length] of reads.slice(1)) {
        expect(offset).toBe(end);
        end += length;
      }
      expect(reads.length).toBeLessThanOrEqual(3);
      expect(end).toBeLessThanOrEqual(bytes.length - CLUSTER_EL.length);
    }
  });

  it("refuses a track table larger than it will buffer", async () => {
    const huge = elDeclared(TRACKS, MAX_TRACKS_BYTES + 1, zeros(16));
    expect(await sniffContainer(bytesSource(webm([], { tracksOverride: huge })))).toBeNull();
  });

  it("stops walking at the scan ceiling rather than buffering the file", async () => {
    const reads: number[] = [];
    // A reservation so large the table would sit past the ceiling.
    const declaredSize = MAX_WEBM_SCAN_BYTES + 1024;
    const bytes = concat(
      el(EBML, el(DOCTYPE, ascii("webm"))),
      elUnknown(SEGMENT, elDeclared(VOID, declaredSize, zeros(64))),
    );
    const source = {
      size: declaredSize + 4096,
      read(offset: number, length: number) {
        reads.push(length);
        return bytesSource(bytes).read(offset, length);
      },
    };
    expect(await sniffContainer(source)).toBeNull();
    expect(reads.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(SNIFF_HEAD_BYTES + 12);
  });

  it("gives up at the first Cluster when no track table came before it", async () => {
    const bytes = concat(
      el(EBML, el(DOCTYPE, ascii("webm"))),
      elUnknown(SEGMENT, elUnknown(CLUSTER, zeros(32)), tracksEl([VP9])),
    );
    expect(await sniffContainer(bytesSource(bytes))).toBeNull();
  });
});

// --- Sniffing: MP4 -----------------------------------------------------------

describe("sniffContainer — MP4", () => {
  it("reads a faststart file and knows it is not fragmented", async () => {
    const bytes = concat(ftyp(), moov([trak("vide", AVC1), trak("soun", AAC)]), box("mdat", zeros(100)));
    expect(await sniffContainer(bytesSource(bytes))).toEqual({
      container: "mp4",
      mimeType: "video/mp4;codecs=avc1.64001F,mp4a.40.2",
      videoCodecs: ["avc1.64001F"],
      audioCodecs: ["mp4a.40.2"],
      progressive: false,
    });
  });

  it("calls a file with mvex fragmented, and therefore streamable", async () => {
    const bytes = concat(ftyp(), moov([trak("vide", AVC1), trak("soun", AAC)], true), box("moof"), box("mdat"));
    expect((await sniffContainer(bytesSource(bytes)))?.progressive).toBe(true);
  });

  it("seeks to a moov that sits after an mdat larger than the head window", async () => {
    const reads: [number, number][] = [];
    const mdat = largeBox("mdat", zeros(SNIFF_HEAD_BYTES + 4096));
    const tail = moov([trak("vide", AVC1)]);
    const bytes = concat(ftyp(), mdat, tail);
    const source = bytesSource(bytes);
    const info = await sniffContainer({
      size: source.size,
      read(offset, length) {
        reads.push([offset, length]);
        return source.read(offset, length);
      },
    });
    expect(info?.mimeType).toBe("video/mp4;codecs=avc1.64001F");
    expect(info?.progressive).toBe(false);
    // The head, the moov's header at its offset, then exactly the moov's payload.
    const moovAt = ftyp().length + mdat.length;
    expect(reads).toEqual([
      [0, SNIFF_HEAD_BYTES],
      [moovAt, 16],
      [moovAt + 8, tail.length - 8],
    ]);
  });

  it("spells HEVC per Annex E", async () => {
    // General profile space 0, main tier, profile 1; compat flags 0x60000000
    // (reversed: 6); constraint flags B0 and then zeros, which are dropped;
    // level 93.
    const hvcC = new Uint8Array([1, 0x01, 0x60, 0, 0, 0, 0xb0, 0, 0, 0, 0, 0, 93]);
    const entry = visualEntry("hvc1", box("hvcC", hvcC));
    expect((await sniffContainer(bytesSource(concat(ftyp(), moov([trak("vide", entry)])))))?.videoCodecs).toEqual([
      "hvc1.1.6.L93.B0",
    ]);
  });

  it("spells AV1 and VP9 from their configuration boxes", async () => {
    const av01 = visualEntry("av01", box("av1C", new Uint8Array([0x81, 0x08, 0x00, 0x00])));
    const vp09 = visualEntry("vp09", fullBox("vpcC", new Uint8Array([0, 10, 0x80, 0, 0, 0, 0, 0])));
    const both = concat(ftyp(), moov([trak("vide", av01), trak("vide", vp09)]));
    expect((await sniffContainer(bytesSource(both)))?.videoCodecs).toEqual(["av01.0.08M.08", "vp09.00.10.08"]);
  });

  it("reads the audio object type out of esds, and finds it in every sample entry version", async () => {
    const heAac = audioEntry("mp4a", 1, fullBox("esds", esds(0x40, 5)));
    const v2 = audioEntry("mp4a", 2, fullBox("esds", esds(0x40, 2)));
    const opus = audioEntry("Opus", 0, box("dOps", zeros(11)));
    const bytes = concat(ftyp(), moov([trak("vide", AVC1), trak("soun", heAac), trak("soun", v2), trak("soun", opus)]));
    expect((await sniffContainer(bytesSource(bytes)))?.audioCodecs).toEqual(["mp4a.40.5", "mp4a.40.2", "opus"]);
  });

  it("assumes AAC-LC when mp4a carries no esds", async () => {
    const bare = audioEntry("mp4a", 0);
    const bytes = concat(ftyp(), moov([trak("vide", AVC1), trak("soun", bare)]));
    expect((await sniffContainer(bytesSource(bytes)))?.audioCodecs).toEqual(["mp4a.40.2"]);
  });

  it("ignores tracks that are neither video nor audio", async () => {
    const bytes = concat(ftyp(), moov([trak("hint", visualEntry("rtp ")), trak("vide", AVC1)]));
    const info = await sniffContainer(bytesSource(bytes));
    expect(info?.videoCodecs).toEqual(["avc1.64001F"]);
    expect(info?.audioCodecs).toEqual([]);
  });

  it("reports an audio-only file as having no video codec, for the view to refuse", async () => {
    const bytes = concat(ftyp(), moov([trak("soun", AAC)]));
    expect((await sniffContainer(bytesSource(bytes)))?.videoCodecs).toEqual([]);
  });

  it("returns null when there is no moov to find", async () => {
    expect(await sniffContainer(bytesSource(concat(ftyp(), box("mdat", zeros(50)))))).toBeNull();
    // A size that runs off the end of the file cannot be walked past.
    expect(await sniffContainer(bytesSource(concat(ftyp(), be32(1 << 30), ascii("free"))))).toBeNull();
  });
});

describe("sniffContainer — neither", () => {
  it("returns null for anything that is not a WebM or an ISO BMFF file", async () => {
    expect(await sniffContainer(bytesSource(new Uint8Array(0)))).toBeNull();
    expect(await sniffContainer(bytesSource(ascii("hello there, not a video")))).toBeNull();
    expect(await sniffContainer(bytesSource(new Uint8Array([0x1a, 0x45, 0xdf])))).toBeNull();
    // A RIFF/AVI head: recognisable, and not ours.
    expect(await sniffContainer(bytesSource(concat(ascii("RIFF"), be32(100), ascii("AVI LIST"))))).toBeNull();
  });
});

// --- Planning ----------------------------------------------------------------

const details = { title: "Sprint demo", mimeType: "video/webm;codecs=vp9,opus", durationMs: 93250, progressive: true };

describe("planImport", () => {
  it("does §4's chunk arithmetic once, up front", () => {
    const meta = planImport(3 * CHUNK_SIZE + 1, details);
    expect(meta.chunkSize).toBe(CHUNK_SIZE);
    expect(meta.chunkCount).toBe(4);
    expect(meta.totalBytes).toBe(3 * CHUNK_SIZE + 1);
    expect(planImport(2 * CHUNK_SIZE, details).chunkCount).toBe(2);
    expect(planImport(1, details).chunkCount).toBe(1);
  });

  it("writes metadata a recording could have written, field for field", () => {
    const meta = planImport(1000, { ...details, createdAt: "2026-09-03T20:02:27.225Z" });
    expect(meta).toEqual({
      v: 1,
      title: "Sprint demo",
      mimeType: "video/webm;codecs=vp9,opus",
      durationMs: 93250,
      totalBytes: 1000,
      chunkSize: CHUNK_SIZE,
      chunkCount: 1,
      createdAt: "2026-09-03T20:02:27.225Z",
    });
    // Absent, not `true`: §5 says absent means true, and a recording never writes it.
    expect("progressive" in meta).toBe(false);
  });

  it("writes progressive: false, and only false", () => {
    const meta = planImport(1000, { ...details, progressive: false });
    expect(meta.progressive).toBe(false);
  });

  it("rounds a fractional duration and floors a negative one at zero", () => {
    expect(planImport(1, { ...details, durationMs: 1234.6 }).durationMs).toBe(1235);
    expect(planImport(1, { ...details, durationMs: -5 }).durationMs).toBe(0);
  });

  it("refuses an empty file", () => {
    expect(() => planImport(0, details)).toThrow(/empty/);
    expect(() => planImport(-1, details)).toThrow();
    expect(() => planImport(1.5, details)).toThrow();
  });
});

// --- Running -----------------------------------------------------------------

interface FakeSession extends UploadSession {
  chunks: number[];
  finished: { tail: number | null; meta: VideoMeta; thumb: Uint8Array | null } | null;
  failNext: number;
}

function fakeSession(): FakeSession {
  const session: FakeSession = {
    chunks: [],
    finished: null,
    failNext: 0,
    uploadedBytes: 0,
    async addChunk(plain) {
      if (session.failNext > 0) {
        session.failNext--;
        throw new Error("network");
      }
      session.chunks.push(plain.length);
    },
    async finish(tail, meta, thumb): Promise<UploadResult> {
      session.finished = { tail: tail?.length ?? null, meta, thumb: thumb ?? null };
      return { id: "id", link: "view.html#id.key" };
    },
    async abort() {},
  };
  return session;
}

function fileOf(size: number): Blob {
  return new Blob([new Uint8Array(size)]);
}

describe("runImport", () => {
  it("hands every full chunk to addChunk and the tail to finish, in §7's order", async () => {
    const size = 2 * CHUNK_SIZE + 7;
    const session = fakeSession();
    const thumb = new Uint8Array([1, 2, 3]);
    const result = await runImport(session, createImportJob(fileOf(size), planImport(size, details), thumb));
    expect(result.link).toBe("view.html#id.key");
    expect(session.chunks).toEqual([CHUNK_SIZE, CHUNK_SIZE]);
    expect(session.finished?.tail).toBe(7);
    expect(session.finished?.thumb).toBe(thumb);
    expect(session.finished?.meta.chunkCount).toBe(3);
  });

  it("sends a file that is an exact multiple of the chunk size as full chunks plus a full tail", async () => {
    const size = 2 * CHUNK_SIZE;
    const session = fakeSession();
    await runImport(session, createImportJob(fileOf(size), planImport(size, details), null));
    expect(session.chunks).toEqual([CHUNK_SIZE]);
    expect(session.finished?.tail).toBe(CHUNK_SIZE);
  });

  it("sends a small file as nothing but a tail", async () => {
    const session = fakeSession();
    await runImport(session, createImportJob(fileOf(10), planImport(10, details), null));
    expect(session.chunks).toEqual([]);
    expect(session.finished?.tail).toBe(10);
  });

  it("resumes where it left off when retried with the same job", async () => {
    const size = 3 * CHUNK_SIZE + 1;
    const session = fakeSession();
    const job = createImportJob(fileOf(size), planImport(size, details), null);
    session.failNext = 1;
    // The very first chunk throws: nothing has landed, nothing is skipped.
    await expect(runImport(session, job)).rejects.toThrow("network");
    expect(job.nextChunk).toBe(0);
    session.failNext = 0;
    await runImport(session, job);
    // Nothing was sent twice: three full chunks, then the one-byte tail.
    expect(session.chunks).toEqual([CHUNK_SIZE, CHUNK_SIZE, CHUNK_SIZE]);
    expect(session.finished?.tail).toBe(1);
    expect(job.nextChunk).toBe(3);
  });

  it("advances nextChunk past what landed before a failure", async () => {
    const size = 3 * CHUNK_SIZE + 1;
    const session = fakeSession();
    const job = createImportJob(fileOf(size), planImport(size, details), null);
    // First chunk succeeds, second fails.
    const original = session.addChunk;
    let calls = 0;
    session.addChunk = async (plain) => {
      calls++;
      if (calls === 2) throw new Error("network");
      return original(plain);
    };
    await expect(runImport(session, job)).rejects.toThrow("network");
    expect(job.nextChunk).toBe(1);
    session.addChunk = original;
    await runImport(session, job);
    expect(session.chunks).toEqual([CHUNK_SIZE, CHUNK_SIZE, CHUNK_SIZE]);
  });
});

// --- Thumbnail offsets and copy ----------------------------------------------

describe("thumbnail offsets", () => {
  it("takes the first frame a second in, or halfway through a shorter file", () => {
    expect(thumbnailTimeMs(60_000)).toBe(1000);
    expect(thumbnailTimeMs(1200)).toBe(600);
    expect(thumbnailTimeMs(0)).toBe(0);
    expect(thumbnailTimeMs(Infinity)).toBe(0);
  });

  it("retries later, but never past the middle", () => {
    expect(thumbnailRetryTimeMs(60_000)).toBe(6000);
    expect(thumbnailRetryTimeMs(10_000)).toBe(2500);
    expect(thumbnailRetryTimeMs(3000)).toBe(1500);
    expect(thumbnailRetryTimeMs(0)).toBe(0);
  });
});

describe("the view's pure bits", () => {
  it("titles a file by its name without the extension", () => {
    expect(titleFromFilename("alex report demo.webm")).toBe("alex report demo");
    expect(titleFromFilename("Q3.review.final.mp4")).toBe("Q3.review.final");
    expect(titleFromFilename("noext")).toBe("noext");
    expect(titleFromFilename("  spaced .mov ")).toBe("spaced");
    expect(titleFromFilename("x".repeat(300) + ".mp4")).toHaveLength(200);
  });

  it("says nothing about a file that streams, and explains one that does not", () => {
    const base = { container: "mp4" as const, mimeType: "video/mp4", videoCodecs: [], audioCodecs: [] };
    expect(progressiveNote({ ...base, progressive: true })).toBe("");
    expect(progressiveNote({ ...base, progressive: false })).toMatch(/not fragmented/);
  });
});
