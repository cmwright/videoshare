/**
 * Recording engines (docs/SPEC.md §6).
 *
 * Two implementations behind one `RecorderEngine`:
 *
 * 1. `WebCodecsEngine` (Chrome/Edge) — frames come off the capture tracks
 *    through `MediaStreamTrackProcessor`, go into a `VideoEncoder` running in
 *    quantizer (constant-quality) mode wherever the encoder allows it, and are
 *    muxed as they are produced. Constant quality is what makes screen text
 *    legible: bits follow the content instead of a fixed bitrate.
 * 2. `MediaRecorderEngine` (Firefox, Safari, anything older) — the browser's
 *    own recorder, at the configured fallback bitrate.
 *
 * The WebCodecs engine encodes whichever codec `EngineOptions.codec` asks for
 * and this browser can actually produce (§6): H.264 — hardware-accelerated where
 * the machine has an encoder — muxed as **fragmented MP4** by `mp4-muxer`, or
 * VP9/AV1 muxed as WebM by `webm-muxer`. The two muxers sit behind one internal
 * `MuxerAdapter`, so the keyframe clock, the heartbeat, the backpressure valve,
 * the timestamp rebase and the audio silence fill exist exactly once, above it.
 *
 * Both engines hand muxed container bytes to `ondata`, strictly in order,
 * exactly like MediaRecorder's `dataavailable` used to: the recorder page slices
 * those bytes into 8 MiB plaintext chunks and streams them to S3 (§7), so
 * nothing downstream — crypto, upload, player — knows which engine or which
 * container produced them. The player reads `meta.mimeType` and nothing else.
 *
 * Nothing here touches a browser global at import time, so the pure parts
 * (codec strings, the rate-control tables, the selection matrix) run under Node
 * in tests.
 */

import { Muxer as Mp4Muxer, StreamTarget as Mp4StreamTarget } from "mp4-muxer";
import { Muxer as WebmMuxer, StreamTarget as WebmStreamTarget } from "webm-muxer";
import type { CodecChoice, Quality } from "./types";

// --- Public API (SPEC §6) ----------------------------------------------------

/**
 * Re-exported so §6's engine API reads on its own; both unions live in types.ts
 * because `Settings` is written in terms of them (§9, §11).
 *
 * `CodecChoice` is what the user asked for. `"auto"` is the default and the
 * only value that promises nothing: it takes hardware H.264 where there is one
 * and VP9 otherwise. The other three are honoured wherever the browser can
 * encode them and fall down the same chain where it cannot — a recording that
 * happens in a different codec, never one that does not happen.
 */
export type { CodecChoice, Quality };

export interface EngineOptions {
  quality: Quality;
  codec: CodecChoice;
  /** MediaRecorder fallback only — the WebCodecs engine is constant-quality. */
  fallbackVideoBitsPerSecond: number;
}

export interface RecorderEngine {
  /**
   * The exact container/codec string in use, MSE-compatible so the player can
   * feed it to a `SourceBuffer` (§8). This is what `meta.mimeType` must carry
   * (§5) — never the requested string. It is final once the first `ondata`
   * lands, and always final by the time `stop()` resolves; before that it is
   * the engine's best guess (the WebCodecs engine only learns the frame size
   * and confirms codec support once capture is running).
   */
  readonly mimeType: string;
  /** Muxed container bytes, strictly in order. */
  ondata: (bytes: Uint8Array) => void;
  /**
   * The engine died mid-recording — a crashed GPU process taking `VideoEncoder`
   * with it, a `MediaRecorder` that gave up. Both engines go quiet at that
   * point: no further `ondata`, no rejection until `stop()` is called. Without
   * this channel the page would keep a timer running over a recording that
   * stopped producing bytes minutes ago, so it is the one signal that must not
   * wait for `stop()`.
   *
   * Fires at most once per engine, and never for a failure raised inside
   * `stop()` itself — that one rejects the returned promise instead. Whatever
   * was captured before the failure is still valid and still emitted.
   */
  onerror: (err: Error) => void;
  start(stream: MediaStream): void;
  /** Flushes; resolves after the final `ondata` call, rejects if encoding failed. */
  stop(): Promise<void>;
}

/** Video codecs the WebCodecs engine can produce (§6). */
export type VideoCodec = "h264" | "vp9" | "av1";

/** Which muxer carries a codec: H.264 goes in fragmented MP4, the rest in WebM. */
export type Container = "mp4" | "webm";

/** Audio codecs this engine encodes. AAC only ever rides in MP4 (§6). */
export type AudioCodec = "aac" | "opus";

export type EngineKind = "webcodecs" | "mediarecorder";

// --- Tuning ------------------------------------------------------------------

/**
 * Force a keyframe at least this often in media time (§6). Clusters stay
 * bounded, MSE seeking lands somewhere useful, and a lost part costs 8 s at
 * worst rather than the rest of the recording.
 */
export const KEYFRAME_INTERVAL_US = 8_000_000;

/**
 * Frames allowed in flight before delta frames start getting dropped — about
 * 130 ms at 30 fps. Software VP9/AV1 can fall behind on a busy machine; queuing
 * frames instead of dropping them would grow latency and memory without bound,
 * and holding VideoFrames open stalls the capture pipeline outright.
 */
export const MAX_ENCODE_QUEUE = 4;

/**
 * Heartbeat (§6): how long the video timeline may stand still before the last
 * frame is re-encoded at the current media time.
 *
 * Screen capture is variable frame rate — a still screen delivers nothing at
 * all — and the backpressure valve above drops delta frames whenever the
 * encoder falls behind. Both leave a hole in the video timeline. Played as a
 * file that is invisible (the decoder holds the last picture for longer), but
 * MSE splits its buffered ranges at a hole and the player stops dead at the
 * edge of the first one (§8). One repeated frame costs almost nothing in
 * quantizer mode — it is a delta against a picture it is identical to — so the
 * timeline is kept continuous instead.
 */
export const HEARTBEAT_IDLE_MS = 1000;

/**
 * How often that idle check runs. Half the idle threshold, so the hole a
 * heartbeat can leave behind is bounded by roughly 1.5 × the threshold rather
 * than 2 × it, and the check itself is a comparison against a timestamp.
 */
export const HEARTBEAT_INTERVAL_MS = 500;

/** Everything the heartbeat decision looks at, as plain numbers (SPEC §13). */
export interface HeartbeatInput {
  /** Wall clock now, in milliseconds. */
  nowMs: number;
  /** Wall clock when a frame was last handed to the video encoder. */
  lastEncodeAtMs: number;
  /** `VideoEncoder.encodeQueueSize` at this instant. */
  queueSize: number;
  /** A clone of the last delivered frame is being held, on a started clock. */
  hasFrame: boolean;
  /** The engine is still recording: encoder configured, not stopped, not failed. */
  recording: boolean;
}

/**
 * Whether to emit a heartbeat frame right now (§6).
 *
 * The queue test is the important one: a heartbeat is only free when the
 * encoder is idle. Adding frames to an encoder that is already behind is how
 * the backpressure valve gets tripped in the first place, and it would trade
 * one hole for a bigger one.
 */
export function heartbeatDue(input: HeartbeatInput): boolean {
  return (
    input.recording &&
    input.hasFrame &&
    input.queueSize <= MAX_ENCODE_QUEUE &&
    input.nowMs - input.lastEncodeAtMs > HEARTBEAT_IDLE_MS
  );
}

/**
 * The media timestamp a heartbeat frame carries: the last encoded timestamp
 * plus the wall time since, so the video clock tracks real time across a still
 * stretch instead of compressing it. Capture timestamps and `performance.now()`
 * are the same clock in the browsers this engine runs on, and the result is
 * always strictly ahead of `lastEncodeUs` — the muxer rejects a video timestamp
 * that is not.
 */
export function heartbeatTimestampUs(
  lastEncodeUs: number,
  lastEncodeAtMs: number,
  nowMs: number,
): number {
  return lastEncodeUs + Math.max(1, Math.round((nowMs - lastEncodeAtMs) * 1000));
}

/** Opus for the mixed mono voice track (§6). */
export const OPUS_BITRATE = 48_000;

/**
 * AAC-LC for the same track when the file is an MP4 (§6). A little more than
 * Opus, because AAC needs it to sound the same at these rates.
 */
export const AAC_BITRATE = 64_000;

/**
 * Silence synthesised after the audio track ends mid-recording, in 20 ms
 * frames — Opus's own frame size, so the encoder packetizes them one for one.
 * See `fillAudioGap()` for why the audio clock may not be allowed to stop.
 */
export const SILENCE_FRAME_US = 20_000;

/**
 * How far that synthetic audio clock is kept ahead of the video clock. The
 * muxer only releases a video block once audio has passed its timestamp, so
 * audio has to lead; a fifth of a second covers encoder latency without putting
 * a noticeable tail of silence on the end of the file.
 */
export const SILENCE_LEAD_US = 200_000;

/**
 * Ceiling on catching that clock up in one go, and so also the widest jump the
 * silence clock may take — a jump leaves a hole in the audio track exactly as
 * wide as the stretch it skipped.
 *
 * It exists for a tab throttled so hard that nothing in this engine runs for
 * minutes: the audio really is missing for that stretch, and filling it 20 ms
 * at a time would block the video pump for tens of thousands of encodes.
 *
 * Which is why it has to stay clear of the heartbeat's cadence. A heartbeat on
 * a still screen advances the video clock by up to `HEARTBEAT_IDLE_MS +
 * HEARTBEAT_INTERVAL_MS` at a time (1.5 s), and clamping anywhere below that
 * would punch a hole in the *audio* track on every single heartbeat. MSE
 * intersects the two tracks' buffered ranges, so an audio hole splits playback
 * exactly as a video hole does (§8) — the heartbeat would be trading the stall
 * it exists to prevent for a periodic version of the same thing.
 *
 * Set to twice that stride: a heartbeat delayed by a busy main thread — the
 * exact condition that drops frames in the first place — still gets its gap
 * filled, and the loop stays bounded at 150 encodes of 20 ms each. Everything
 * after the track ended is silence anyway, so filling more of it costs nothing
 * but those encodes.
 */
export const MAX_SILENCE_CATCHUP_US = 3_000_000;

/**
 * Where the silence clock resumes when it is behind `targetUs`: where it
 * already is (so the gap gets filled frame by frame), or the far end of the
 * catch-up ceiling when the gap is wider than this engine can be responsible
 * for. See `MAX_SILENCE_CATCHUP_US` for which is which and why the boundary
 * sits where it does.
 */
export function silenceCatchUpUs(silenceUs: number, targetUs: number): number {
  return targetUs - silenceUs > MAX_SILENCE_CATCHUP_US ? targetUs - MAX_SILENCE_CATCHUP_US : silenceUs;
}

/** MediaRecorder fallback: audio bitrate and timeslice (§6). */
export const FALLBACK_AUDIO_BITRATE = 64_000;
const FALLBACK_TIMESLICE_MS = 1000;

/** Used when settings carry no usable fallback bitrate (§6.2/§9 default). */
const FALLBACK_VIDEO_BITS_PER_SECOND = 2_500_000;

/** What §6 caps capture at, and what we assume before the first frame arrives. */
const NOMINAL_WIDTH = 1920;
const NOMINAL_HEIGHT = 1080;
const NOMINAL_FRAME_RATE = 30;
/** What the §6 mixing graph produces, and what the AAC probe asks about. */
const NOMINAL_SAMPLE_RATE = 48_000;

/**
 * Rate control, table 1 of 2 — quality → per-frame quantizer. In
 * `bitrateMode: "quantizer"` this is the only quality knob: higher is coarser
 * and smaller, and the encoder spends whatever bitrate that costs. It is the
 * primary path for every codec; `BITRATES` below is the fallback for encoders
 * that refuse quantizer mode.
 *
 * Each codec's quantizer means something different, so the three columns are
 * the *same fraction of each codec's own range* — switching codec changes the
 * file size and the CPU cost, not what the recording looks like:
 *
 * - VP9 takes libvpx's quantizer directly (0–63).
 * - AV1 takes an AV1 qindex (0–255), which Chromium divides by 4 to reach the
 *   same internal 0–63 scale — so the AV1 column is exactly 4× the VP9 column
 *   and AV1's better tools show up as a smaller file, not a different picture.
 * - H.264 takes its own QP (0–51, per the WebCodecs AVC registration), so the
 *   column is the VP9 one rescaled by 51/63 and rounded: 38→31, 28→23, 20→16.
 *   Same picture again; H.264's weaker tools show up as a bigger file, which is
 *   the trade a user makes by choosing it for a smooth 4K capture.
 *
 * - `smaller` — visibly compressed photos and video, UI text still legible;
 *   for long recordings where upload size is what hurts.
 * - `standard` — the default: screen text stays clean and ring-free at 1080p,
 *   roughly 1–2 Mbps of typical desktop capture.
 * - `sharper` — near-transparent for screen content (code, diagrams, thin
 *   fonts), at roughly double the bytes of `standard`.
 */
export const QUANTIZERS: Record<VideoCodec, Record<Quality, number>> = {
  h264: { smaller: 31, standard: 23, sharper: 16 },
  vp9: { smaller: 38, standard: 28, sharper: 20 },
  av1: { smaller: 152, standard: 112, sharper: 80 },
};

export function quantizerFor(codec: VideoCodec, quality: Quality): number {
  const table = QUANTIZERS[codec];
  return table[quality] ?? table.standard;
}

/** The frame size {@link BITRATES} is quoted at: 1080p, where the numbers read. */
export const BITRATE_REFERENCE_PIXELS = 1920 * 1080;

/**
 * Rate control, table 2 of 2 — quality → bitrate at {@link
 * BITRATE_REFERENCE_PIXELS}, for `bitrateMode: "variable"`.
 *
 * Per-frame quantizer is a young WebCodecs feature (Chrome 117) and platform
 * encoders vary, so a hardware H.264 encoder may well refuse it. Then there is
 * no way to say "this quality whatever it costs" and the encoder has to be
 * given a number of bits instead — these, scaled by pixel count
 * ({@link bitrateFor}).
 *
 * They are H.264 numbers for screen content: roughly what a `standard`
 * quantizer costs on a busy 1080p desktop, doubled for `sharper` and halved for
 * `smaller`, which is the same spacing the quantizer table has. Screen capture
 * is mostly still, so a variable-bitrate encoder spends well under these except
 * while something is actually moving — which is exactly when it should.
 */
export const BITRATES: Record<Quality, number> = {
  smaller: 2_000_000,
  standard: 4_000_000,
  sharper: 8_000_000,
};

/**
 * Below this a small shared window would be starved: linear scaling alone gives
 * a 320×180 terminal a thirty-sixth of the 1080p bitrate, and screen glyphs do
 * not cost proportionally fewer bits than a photo does — they are the same size
 * in pixels either way.
 */
export const MIN_BITRATE = 250_000;

/**
 * {@link BITRATES} scaled by pixel count (§6), with that floor and no ceiling:
 * a 4K frame really does need four times the bits of a 1080p one, and clamping
 * there would throw away the whole reason for recording at 4K.
 */
export function bitrateFor(quality: Quality, width: number, height: number): number {
  const pixels = Math.max(1, width) * Math.max(1, height);
  const base = BITRATES[quality] ?? BITRATES.standard;
  return Math.max(MIN_BITRATE, Math.round((base * pixels) / BITRATE_REFERENCE_PIXELS));
}

// --- Codec strings -----------------------------------------------------------

/**
 * One entry of a codec's level table. A level is a promise to the decoder about
 * the worst case it must handle, so the smallest level the stream fits in is
 * the friendliest one to declare.
 */
interface CodecLevel {
  /** The number that goes into the codec string. */
  readonly id: number;
  /** Max luma samples per picture. */
  readonly maxPictureSize: number;
  /** Max luma samples per second. */
  readonly maxSampleRate: number;
  readonly maxWidth?: number;
  readonly maxHeight?: number;
}

/**
 * H.264 levels (ITU-T H.264 Annex A, Table A-1), keyed by `level_idc` — the
 * last byte of the codec string, and the level number × 10 (level 4.0 → 40 →
 * `28` in hex). H.264 counts in 16×16 macroblocks rather than luma samples, and
 * a partial macroblock still has to be coded, which is why 1080p is 68 rows of
 * them and not 67.5.
 */
interface H264Level {
  readonly id: number;
  /** MaxFS: macroblocks per frame. */
  readonly maxFrameMacroblocks: number;
  /** MaxMBPS: macroblocks per second. */
  readonly maxMacroblocksPerSecond: number;
}

const H264_LEVELS: readonly H264Level[] = [
  { id: 0x0a, maxMacroblocksPerSecond: 1_485, maxFrameMacroblocks: 99 }, //          1
  { id: 0x0b, maxMacroblocksPerSecond: 3_000, maxFrameMacroblocks: 396 }, //         1.1
  { id: 0x0c, maxMacroblocksPerSecond: 6_000, maxFrameMacroblocks: 396 }, //         1.2
  { id: 0x0d, maxMacroblocksPerSecond: 11_880, maxFrameMacroblocks: 396 }, //        1.3
  { id: 0x14, maxMacroblocksPerSecond: 11_880, maxFrameMacroblocks: 396 }, //        2
  { id: 0x15, maxMacroblocksPerSecond: 19_800, maxFrameMacroblocks: 792 }, //        2.1
  { id: 0x16, maxMacroblocksPerSecond: 20_250, maxFrameMacroblocks: 1_620 }, //      2.2
  { id: 0x1e, maxMacroblocksPerSecond: 40_500, maxFrameMacroblocks: 1_620 }, //      3
  { id: 0x1f, maxMacroblocksPerSecond: 108_000, maxFrameMacroblocks: 3_600 }, //     3.1
  { id: 0x20, maxMacroblocksPerSecond: 216_000, maxFrameMacroblocks: 5_120 }, //     3.2
  { id: 0x28, maxMacroblocksPerSecond: 245_760, maxFrameMacroblocks: 8_192 }, //     4
  { id: 0x29, maxMacroblocksPerSecond: 245_760, maxFrameMacroblocks: 8_192 }, //     4.1
  { id: 0x2a, maxMacroblocksPerSecond: 522_240, maxFrameMacroblocks: 8_704 }, //     4.2
  { id: 0x32, maxMacroblocksPerSecond: 589_824, maxFrameMacroblocks: 22_080 }, //    5
  { id: 0x33, maxMacroblocksPerSecond: 983_040, maxFrameMacroblocks: 36_864 }, //    5.1
  { id: 0x34, maxMacroblocksPerSecond: 2_073_600, maxFrameMacroblocks: 36_864 }, //  5.2
  { id: 0x3c, maxMacroblocksPerSecond: 4_177_920, maxFrameMacroblocks: 139_264 }, // 6
  { id: 0x3d, maxMacroblocksPerSecond: 8_355_840, maxFrameMacroblocks: 139_264 }, // 6.1
  { id: 0x3e, maxMacroblocksPerSecond: 16_711_680, maxFrameMacroblocks: 139_264 }, // 6.2
];

/** VP9 levels (https://www.webmproject.org/vp9/levels/). */
const VP9_LEVELS: readonly CodecLevel[] = [
  { id: 10, maxPictureSize: 36_864, maxSampleRate: 829_440, maxWidth: 512, maxHeight: 512 },
  { id: 11, maxPictureSize: 73_728, maxSampleRate: 2_764_800, maxWidth: 768, maxHeight: 768 },
  { id: 20, maxPictureSize: 122_880, maxSampleRate: 4_608_000, maxWidth: 960, maxHeight: 960 },
  { id: 21, maxPictureSize: 245_760, maxSampleRate: 9_216_000, maxWidth: 1344, maxHeight: 1344 },
  { id: 30, maxPictureSize: 552_960, maxSampleRate: 20_736_000, maxWidth: 2048, maxHeight: 2048 },
  { id: 31, maxPictureSize: 983_040, maxSampleRate: 36_864_000, maxWidth: 2752, maxHeight: 2752 },
  { id: 40, maxPictureSize: 2_228_224, maxSampleRate: 83_558_400, maxWidth: 4160, maxHeight: 4160 },
  { id: 41, maxPictureSize: 2_228_224, maxSampleRate: 160_432_128, maxWidth: 4160, maxHeight: 4160 },
  { id: 50, maxPictureSize: 8_912_896, maxSampleRate: 311_951_360, maxWidth: 8384, maxHeight: 8384 },
  { id: 51, maxPictureSize: 8_912_896, maxSampleRate: 588_251_136, maxWidth: 8384, maxHeight: 8384 },
  { id: 52, maxPictureSize: 8_912_896, maxSampleRate: 1_176_502_272, maxWidth: 8384, maxHeight: 8384 },
  { id: 60, maxPictureSize: 35_651_584, maxSampleRate: 1_176_502_272, maxWidth: 16_832, maxHeight: 16_832 },
  { id: 61, maxPictureSize: 35_651_584, maxSampleRate: 2_353_004_544, maxWidth: 16_832, maxHeight: 16_832 },
  { id: 62, maxPictureSize: 35_651_584, maxSampleRate: 4_706_009_088, maxWidth: 16_832, maxHeight: 16_832 },
];

/**
 * AV1 levels (AV1 Bitstream & Decoding Process Specification, Annex A), keyed by
 * `seq_level_idx` — the number the codec string carries. Only the levels a
 * screen recording can plausibly need are listed; the intermediate ones (2.2,
 * 3.2, …) only raise the frame rate a level allows, so skipping them just
 * rounds up to the next listed level, which is always legal.
 */
const AV1_LEVELS: readonly CodecLevel[] = [
  { id: 0, maxPictureSize: 147_456, maxSampleRate: 4_423_680, maxWidth: 2048, maxHeight: 1152 },
  { id: 1, maxPictureSize: 278_784, maxSampleRate: 8_363_520, maxWidth: 2816, maxHeight: 1584 },
  { id: 4, maxPictureSize: 665_856, maxSampleRate: 19_975_680, maxWidth: 4352, maxHeight: 2448 },
  { id: 5, maxPictureSize: 1_065_024, maxSampleRate: 31_950_720, maxWidth: 5504, maxHeight: 3096 },
  { id: 8, maxPictureSize: 2_359_296, maxSampleRate: 70_778_880, maxWidth: 6144, maxHeight: 3456 },
  { id: 9, maxPictureSize: 2_359_296, maxSampleRate: 141_557_760, maxWidth: 6144, maxHeight: 3456 },
  { id: 12, maxPictureSize: 8_912_896, maxSampleRate: 267_386_880, maxWidth: 8192, maxHeight: 4352 },
  { id: 13, maxPictureSize: 8_912_896, maxSampleRate: 534_773_760, maxWidth: 8192, maxHeight: 4352 },
  { id: 16, maxPictureSize: 35_651_584, maxSampleRate: 1_069_547_520, maxWidth: 16_384, maxHeight: 8704 },
];

function pickLevel(
  levels: readonly CodecLevel[],
  width: number,
  height: number,
  frameRate: number,
): CodecLevel {
  const picture = Math.max(1, width) * Math.max(1, height);
  const rate = picture * Math.max(1, frameRate);
  const fits = levels.find(
    (level) =>
      picture <= level.maxPictureSize &&
      rate <= level.maxSampleRate &&
      width <= (level.maxWidth ?? Number.POSITIVE_INFINITY) &&
      height <= (level.maxHeight ?? Number.POSITIVE_INFINITY),
  );
  return fits ?? levels[levels.length - 1];
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Macroblocks are 16×16 and a partial one still has to be coded. */
function macroblocks(pixels: number): number {
  return Math.ceil(Math.max(1, pixels) / 16);
}

function pickH264Level(width: number, height: number, frameRate: number): H264Level {
  const wide = macroblocks(width);
  const tall = macroblocks(height);
  const size = wide * tall;
  const rate = size * Math.max(1, frameRate);
  const fits = H264_LEVELS.find(
    (level) =>
      size <= level.maxFrameMacroblocks &&
      rate <= level.maxMacroblocksPerSecond &&
      // Annex A.3.1: neither dimension may exceed sqrt(MaxFS × 8) macroblocks,
      // which is what stops a level covering an absurdly wide, 1-mb-tall frame.
      Math.max(wide, tall) <= Math.sqrt(level.maxFrameMacroblocks * 8),
  );
  return fits ?? (H264_LEVELS[H264_LEVELS.length - 1] as H264Level);
}

/**
 * e.g. 1920×1080@30 → `avc1.640028` (High profile, no constraint flags, level
 * 4.0); 4K → `avc1.640033` (level 5.1), the string SPEC §6 names.
 *
 * `avc1.PPCCLL`, all hex: profile_idc, the constraint-flags byte, level_idc.
 * High profile is 0x64 — it is what every hardware encoder in the support
 * matrix produces and every decoder since 2010 reads. The constraint byte stays
 * 0x00: setting a flag we do not actually honour is a lie a strict decoder is
 * entitled to act on. RFC 6381 does not say which case the digits are in, and
 * MediaSource accepts either; uppercase is what the platform strings use
 * (`avc1.42E01E`), so `meta.mimeType` reads the same everywhere.
 */
export function avcCodecString(width: number, height: number, frameRate = NOMINAL_FRAME_RATE): string {
  const level = pickH264Level(width, height, frameRate).id;
  return `avc1.6400${level.toString(16).padStart(2, "0").toUpperCase()}`;
}

/** e.g. 1920×1080@30 → `vp09.00.40.08` (profile 0, level 4.0, 8-bit). */
export function vp9CodecString(width: number, height: number, frameRate = NOMINAL_FRAME_RATE): string {
  return `vp09.00.${pad2(pickLevel(VP9_LEVELS, width, height, frameRate).id)}.08`;
}

/** e.g. 1920×1080@30 → `av01.0.08M.08` (profile 0, level 4.0 Main tier, 8-bit). */
export function av1CodecString(width: number, height: number, frameRate = NOMINAL_FRAME_RATE): string {
  return `av01.0.${pad2(pickLevel(AV1_LEVELS, width, height, frameRate).id)}M.08`;
}

export function videoCodecString(
  codec: VideoCodec,
  width: number,
  height: number,
  frameRate = NOMINAL_FRAME_RATE,
): string {
  if (codec === "h264") return avcCodecString(width, height, frameRate);
  return codec === "av1"
    ? av1CodecString(width, height, frameRate)
    : vp9CodecString(width, height, frameRate);
}

/** How each audio codec is spelled in a `codecs=` parameter. */
export const AUDIO_CODEC_STRINGS: Record<AudioCodec, string> = {
  /** MPEG-4 audio, object type 2 — AAC-LC. */
  aac: "mp4a.40.2",
  opus: "opus",
};

/**
 * WebM cannot carry H.264 at all, and MP4 is where hardware H.264 belongs
 * anyway: the fragmented-MP4 path exists for exactly one codec (§6).
 */
export function containerFor(codec: VideoCodec): Container {
  return codec === "h264" ? "mp4" : "webm";
}

/**
 * The MSE-facing type for a file of these codecs — `meta.mimeType` verbatim
 * (§5), and what the player hands to `MediaSource.isTypeSupported` (§8).
 *
 * `audioCodec` is null when the capture had no audio: claiming a track the file
 * does not contain makes MSE reject the first buffer appended. Unquoted and
 * unspaced, which every MSE implementation parses — WebKit's content-type
 * parser reads an unquoted parameter value up to the next `;`, so the comma
 * between two codecs survives there as it does in Chrome.
 */
export function containerMimeType(
  container: Container,
  videoCodec: string,
  audioCodec: AudioCodec | null,
): string {
  const codecs = audioCodec ? `${videoCodec},${AUDIO_CODEC_STRINGS[audioCodec]}` : videoCodec;
  return `video/${container};codecs=${codecs}`;
}

// --- Engine selection --------------------------------------------------------

export interface EngineCapabilities {
  videoEncoder: boolean;
  audioEncoder: boolean;
  trackProcessor: boolean;
  mediaRecorder: boolean;
}

export function detectCapabilities(): EngineCapabilities {
  const globals = globalThis as Record<string, unknown>;
  return {
    videoEncoder: typeof globals.VideoEncoder === "function",
    audioEncoder: typeof globals.AudioEncoder === "function",
    trackProcessor: typeof globals.MediaStreamTrackProcessor === "function",
    mediaRecorder: typeof globals.MediaRecorder === "function",
  };
}

/**
 * The WebCodecs engine needs all three pieces: encoders for both media types
 * and a way to pull raw frames off the capture tracks. Missing any one of them
 * means the browser's own recorder — and `null` means this browser cannot
 * record at all, which the page has to say out loud rather than discover inside
 * a constructor.
 */
export function selectEngineKind(caps: EngineCapabilities = detectCapabilities()): EngineKind | null {
  if (caps.videoEncoder && caps.audioEncoder && caps.trackProcessor) return "webcodecs";
  return caps.mediaRecorder ? "mediarecorder" : null;
}

/**
 * What `isConfigSupported()` answered, as plain flags so the whole selection
 * matrix is testable without a browser (§13).
 *
 * `h264Hardware` is H.264 accepted with `hardwareAcceleration:
 * "prefer-hardware"`; `h264` is H.264 accepted at all, which includes Chrome's
 * bundled software encoder. The first implies the second.
 */
export interface CodecSupport {
  h264Hardware: boolean;
  h264: boolean;
  vp9: boolean;
  av1: boolean;
  /** `AudioEncoder` can produce AAC-LC (`mp4a.40.2`). */
  aac: boolean;
}

/** One rung of the fallback chain: a codec, and whether it must be hardware. */
export interface CodecCandidate {
  codec: VideoCodec;
  /** Only satisfied by `h264Hardware`; meaningless for the software codecs. */
  hardware: boolean;
}

/**
 * The chain §6 walks, for a given setting: the chosen codec first — in hardware
 * if it can be, in software if not — and then the `"auto"` chain with that
 * codec removed.
 *
 * The `"auto"` chain is hardware H.264, VP9, AV1, software H.264. Hardware
 * H.264 leads because it is the only encoder that keeps up with a
 * native-resolution capture; software H.264 trails everything because it is
 * CPU-bound like VP9 and produces bigger files, so it wins nothing — it is
 * there only so a browser with nothing else still records.
 */
export function codecCandidates(choice: CodecChoice): readonly CodecCandidate[] {
  const auto: readonly CodecCandidate[] = [
    { codec: "h264", hardware: true },
    { codec: "vp9", hardware: false },
    { codec: "av1", hardware: false },
    { codec: "h264", hardware: false },
  ];
  if (choice === "auto") return auto;
  const chosen: readonly CodecCandidate[] =
    choice === "h264"
      ? [{ codec: "h264", hardware: true }, { codec: "h264", hardware: false }]
      : [{ codec: choice, hardware: false }];
  return [...chosen, ...auto.filter((candidate) => candidate.codec !== choice)];
}

/** Whether this browser answered yes to the exact config a candidate needs. */
export function candidateSupported(candidate: CodecCandidate, support: CodecSupport): boolean {
  if (candidate.codec !== "h264") return support[candidate.codec];
  // A browser that accepts "prefer-hardware" but not the plain config is not a
  // thing; belt and braces so a malformed probe cannot lose the codec.
  return candidate.hardware ? support.h264Hardware : support.h264 || support.h264Hardware;
}

/**
 * The first rung of {@link codecCandidates} this browser can actually encode,
 * or null when it can encode none of them — which is not a failure, it just
 * means the MediaRecorder engine records instead (§6.2).
 */
export function selectVideoCodec(choice: CodecChoice, support: CodecSupport): VideoCodec | null {
  return codecCandidates(choice).find((c) => candidateSupported(c, support))?.codec ?? null;
}

/**
 * AAC in MP4 where the browser can encode it, Opus everywhere else (§6).
 *
 * WebM's codec list does not include AAC — Matroska's does, WebM's does not —
 * so the WebM path is Opus whatever the machine can do. In MP4, AAC is what
 * Safari and every hardware decoder want; Opus-in-MP4 is the fallback for
 * Firefox and for Chrome on desktop Linux, neither of which has an AAC encoder.
 */
export function selectAudioCodec(container: Container, aacSupported: boolean): AudioCodec {
  return container === "mp4" && aacSupported ? "aac" : "opus";
}

/** First supported wins (§6). */
export const FALLBACK_MIME_TYPES: readonly string[] = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

export function selectFallbackMimeType(
  isSupported: (type: string) => boolean = mediaRecorderSupports,
): string | null {
  return FALLBACK_MIME_TYPES.find((type) => isSupported(type)) ?? null;
}

/** Everything the §6 decision looks at, as plain values (§13). */
export interface EncodingRequest {
  /** `Settings.codec` (§9). */
  codec: CodecChoice;
  caps: EngineCapabilities;
  support: CodecSupport;
  width: number;
  height: number;
  frameRate: number;
  hasAudio: boolean;
  /** `selectFallbackMimeType()`, injected — null where nothing WebM records. */
  fallbackMimeType: string | null;
}

/** What will actually be recorded. */
export interface EncodingPlan {
  engine: EngineKind;
  /** null ⇒ the browser's own recorder picked, and it does not say what. */
  videoCodec: VideoCodec | null;
  container: Container | null;
  /** null ⇒ no audio track, or the browser's recorder picked. */
  audioCodec: AudioCodec | null;
  /** Exactly what `meta.mimeType` will carry (§5). */
  mimeType: string;
  /** The requested codec could not be honoured — the §6 UI note hangs off this. */
  substituted: boolean;
}

/**
 * The whole §6 decision in one pure place: which engine, which codec, which
 * container, which audio codec, and therefore the one string that describes the
 * file. Returns null when this browser cannot record at all.
 *
 * The engine below makes the same decision with real `isConfigSupported()`
 * answers rather than injected ones, by filling a {@link CodecSupport} as it
 * probes down {@link codecCandidates} and then calling this — so there is one
 * rule, not two that have to be kept in step.
 */
export function selectEncoding(request: EncodingRequest): EncodingPlan | null {
  const kind = selectEngineKind(request.caps);
  if (kind === null) return null;

  if (kind === "webcodecs") {
    const videoCodec = selectVideoCodec(request.codec, request.support);
    if (videoCodec) {
      const container = containerFor(videoCodec);
      const audioCodec = request.hasAudio
        ? selectAudioCodec(container, request.support.aac)
        : null;
      return {
        engine: "webcodecs",
        videoCodec,
        container,
        audioCodec,
        mimeType: containerMimeType(
          container,
          videoCodecString(videoCodec, request.width, request.height, request.frameRate),
          audioCodec,
        ),
        // "auto" asked for nothing in particular, so nothing was substituted.
        substituted: request.codec !== "auto" && videoCodec !== request.codec,
      };
    }
    // WebCodecs is present but could encode nothing we asked of it; the
    // browser's own recorder is still a recorder.
  }

  if (!request.fallbackMimeType) return null;
  return {
    engine: "mediarecorder",
    videoCodec: null,
    // The fallback engine only ever records WebM (§6.2) — Safari's MP4
    // MediaRecorder is not a path here, because there is no
    // MediaStreamTrackProcessor to feed the WebCodecs engine on Safari anyway.
    container: "webm",
    audioCodec: null,
    // Whatever MediaRecorder really produces, never a guess at it (§6).
    mimeType: request.fallbackMimeType,
    substituted: request.codec !== "auto",
  };
}

/** Picks the best engine this browser can run (§6). Throws if it can run none. */
export function createEngine(opts: EngineOptions): RecorderEngine {
  const kind = selectEngineKind();
  if (kind === "webcodecs") return new WebCodecsEngine(opts);
  if (kind === "mediarecorder") return new MediaRecorderEngine(opts);
  throw new Error("This browser cannot record video. Try Chrome, Edge, or Firefox on a desktop.");
}

// --- Browser bits that lib.dom does not describe -----------------------------

/** `MediaStreamTrackProcessor` is Chrome-only and absent from lib.dom. */
interface TrackProcessor<T> {
  readonly readable: ReadableStream<T>;
}

type TrackProcessorCtor = new <T>(init: {
  track: MediaStreamTrack;
  maxBufferSize?: number;
}) => TrackProcessor<T>;

function trackProcessorCtor(): TrackProcessorCtor | null {
  const ctor = (globalThis as { MediaStreamTrackProcessor?: TrackProcessorCtor })
    .MediaStreamTrackProcessor;
  return typeof ctor === "function" ? ctor : null;
}

/**
 * lib.dom only carries the AVC extension of the per-frame encode options (`avc:
 * { quantizer }`, 0–51); the VP9 and AV1 registrations add these, at 0–63 and
 * 0–255 respectively. Three names for one idea, and each range is its own.
 */
interface QuantizerEncodeOptions extends VideoEncoderEncodeOptions {
  vp9?: { quantizer: number };
  av1?: { quantizer: number };
}

/**
 * The AAC registration's encoder extension, which lib.dom does not carry.
 * `"aac"` is the default and the one MP4 wants — raw AAC frames, with the
 * AudioSpecificConfig arriving separately as `decoderConfig.description`; ADTS
 * frames carry their own headers and would have to be stripped before muxing.
 * Named explicitly rather than left to the default, because an unknown
 * dictionary member is ignored by WebIDL while a wrong one is not.
 */
interface AacAudioEncoderConfig extends AudioEncoderConfig {
  aac?: { format: "aac" | "adts" };
}

function mediaRecorderSupports(type: string): boolean {
  const ctor = (globalThis as { MediaRecorder?: { isTypeSupported(t: string): boolean } })
    .MediaRecorder;
  return typeof ctor?.isTypeSupported === "function" ? ctor.isTypeSupported(type) : false;
}

/** True when the player could feed this type to MSE — or when there is no MSE to ask. */
function mseSupported(mimeType: string): boolean {
  const ctor = (globalThis as { MediaSource?: { isTypeSupported(t: string): boolean } }).MediaSource;
  return typeof ctor?.isTypeSupported !== "function" || ctor.isTypeSupported(mimeType);
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

async function cancelReader(reader: ReadableStreamDefaultReader<unknown> | null): Promise<void> {
  if (!reader) return;
  try {
    await reader.cancel();
  } catch {
    // Already closed or errored; the pump has nothing left to hand us.
  }
}

/** Encoders want even dimensions for 4:2:0 chroma. */
function even(n: number): number {
  return Math.max(2, n - (n % 2));
}

/** One encoded chunk's bytes, copied out of the codec's own buffer. */
function chunkBytes(chunk: EncodedVideoChunk | EncodedAudioChunk): Uint8Array {
  const data = new Uint8Array(chunk.byteLength);
  chunk.copyTo(data);
  return data;
}

/**
 * Monotonic wall clock. The same one capture timestamps are measured against,
 * which is what lets the heartbeat carry the media clock forward by elapsed
 * real time (see `heartbeatTimestampUs`).
 */
function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

// --- Muxing adapter ----------------------------------------------------------

/**
 * The two muxers behind one door (§6).
 *
 * Everything that was hard to get right — the keyframe clock, the heartbeat,
 * the backpressure valve, the shared zero point and the monotonicity guard, the
 * audio silence fill — lives above this interface, in the engine, exactly once.
 * All that differs below it is which library writes which boxes.
 *
 * Both implementations are append-only: they hand over bytes at increasing file
 * offsets and never rewrite one, because the §7 upload has already shipped them.
 */
interface MuxerAdapter {
  addVideo(
    chunk: EncodedVideoChunk,
    meta: EncodedVideoChunkMetadata | undefined,
    timestampUs: number,
  ): void;
  addAudio(
    chunk: EncodedAudioChunk,
    meta: EncodedAudioChunkMetadata | undefined,
    timestampUs: number,
  ): void;
  finalize(): void;
}

/**
 * The tracks as the encoders turned out to describe them, which is why the
 * muxer is built late: both decoder configs have to be in hand first.
 */
interface MuxerInit {
  video: { codec: VideoCodec; width: number; height: number; frameRate: number };
  audio: { codec: AudioCodec; sampleRate: number; numberOfChannels: number } | null;
  /** Muxed bytes and the file offset they belong at. */
  onData: (data: Uint8Array, position: number) => void;
}

function createMuxer(init: MuxerInit): MuxerAdapter {
  return containerFor(init.video.codec) === "mp4"
    ? new Mp4MuxerAdapter(init)
    : new WebmMuxerAdapter(init);
}

/** VP9 and AV1 in WebM, Opus audio — the original path, byte for byte (§6). */
class WebmMuxerAdapter implements MuxerAdapter {
  private readonly muxer: WebmMuxer<WebmStreamTarget>;

  constructor(init: MuxerInit) {
    this.muxer = new WebmMuxer({
      target: new WebmStreamTarget({ onData: init.onData }),
      video: {
        // H.264 never reaches here: WebM cannot carry it and `createMuxer`
        // routes it to the MP4 adapter.
        codec: init.video.codec === "av1" ? "V_AV1" : "V_VP9",
        width: init.video.width,
        height: init.video.height,
        frameRate: init.video.frameRate,
      },
      audio: init.audio
        ? {
            // WebM's codec list has no AAC, so this track is always Opus.
            codec: "A_OPUS",
            numberOfChannels: init.audio.numberOfChannels,
            sampleRate: init.audio.sampleRate,
          }
        : undefined,
      // Monotonic, append-only output: the bytes are uploaded as they appear and
      // can never be rewritten (§7). This also drops the container duration,
      // which meta.durationMs carries instead (§6).
      streaming: true,
      type: "webm",
      // Timestamps are already rebased against the engine's shared zero point.
      firstTimestampBehavior: "permissive",
    });
  }

  addVideo(
    chunk: EncodedVideoChunk,
    meta: EncodedVideoChunkMetadata | undefined,
    timestampUs: number,
  ): void {
    this.muxer.addVideoChunk(chunk, meta, timestampUs);
  }

  addAudio(
    chunk: EncodedAudioChunk,
    meta: EncodedAudioChunkMetadata | undefined,
    timestampUs: number,
  ): void {
    this.muxer.addAudioChunk(chunk, meta, timestampUs);
  }

  finalize(): void {
    this.muxer.finalize();
  }
}

/**
 * H.264 in fragmented MP4 (§6), with AAC or Opus audio.
 *
 * `fastStart: "fragmented"` is the fMP4 mode: `ftyp` goes out immediately, the
 * `moov` (with its `mvex`) rides out with the first fragment, and from then on
 * the file is a sequence of self-describing `moof`+`mdat` pairs — an MSE
 * initialization segment followed by media segments, which is exactly what the
 * player appends (§8). Nothing is ever seeked back over: mp4-muxer does patch
 * box sizes in place, but only inside the fragment it is still assembling, and
 * `StreamTarget` coalesces each batch into one contiguous write before it
 * reaches `onData`. The engine's own position check proves it.
 *
 * A fragment is cut when the video track takes a keyframe, so `onData` arrives
 * once per GOP — at most every {@link KEYFRAME_INTERVAL_US} — rather than per
 * block as WebM's streaming mode does. That is the one behavioural difference
 * between the two containers, and it costs one GOP of buffering.
 *
 * The encoder must be configured with `avc: { format: "avc" }` (it is, below):
 * MP4 wants the SPS/PPS in an `avcC` box rather than inline in the bitstream,
 * and that box is `decoderConfig.description`, which the encoder only emits in
 * "avc" format. In "annexb" there is no description and the track would have no
 * decoder configuration at all.
 */
class Mp4MuxerAdapter implements MuxerAdapter {
  private readonly muxer: Mp4Muxer<Mp4StreamTarget>;
  /**
   * Whether each track has had its first sample yet — see {@link firstSampleUs}
   * for why the first one is special.
   */
  private started = { video: false, audio: false };

  constructor(init: MuxerInit) {
    this.muxer = new Mp4Muxer({
      target: new Mp4StreamTarget({ onData: init.onData }),
      video: {
        codec: "avc",
        width: init.video.width,
        height: init.video.height,
        // `frameRate` is deliberately not passed: mp4-muxer would make it the
        // track timescale and round every sample onto a fixed frame grid.
        // Screen capture is variable frame rate — a still screen delivers
        // nothing at all, and the heartbeat lands wherever it lands — so the
        // default 57600 timescale (~17 µs) is what keeps those timestamps.
      },
      audio: init.audio
        ? {
            codec: init.audio.codec,
            numberOfChannels: init.audio.numberOfChannels,
            sampleRate: init.audio.sampleRate,
          }
        : undefined,
      fastStart: "fragmented",
      // mp4-muxer has no "permissive": its strict default rejects any track
      // whose first chunk is not exactly 0, and the second track never is.
      // "cross-track-offset" shifts *both* tracks by the earlier of the two
      // first timestamps, which is what the engine's shared zero point already
      // did — so it is a no-op here, and never the per-track "offset" that
      // would slide the tracks against each other and break sync.
      firstTimestampBehavior: "cross-track-offset",
    });
  }

  /**
   * The timestamp to hand mp4-muxer, which is the real one except for the very
   * first sample of each track, where it is 0.
   *
   * mp4-muxer 5.2.2 assumes every track's first sample decodes at 0: on that
   * sample it sets the track's running clock to 0 outright rather than to where
   * the sample actually is, and then measures the *next* sample's delta against
   * that. The first sample's duration therefore comes out too long by exactly
   * the track's start offset, the running clock stays that far ahead of the
   * `tfdt` each fragment writes from the real timestamps, and the next fragment
   * begins with the audio timeline stepping *backwards*.
   *
   * Only one track can satisfy that assumption here. The engine rebases both
   * tracks against one shared zero (see `noteBase`) precisely so they do not
   * slide against each other, which puts the earlier track at 0 and leaves the
   * later one wherever capture actually started it — and capture always starts
   * them a few tens of milliseconds apart. Measured with a 37 ms skew: the
   * first audio sample claimed a 58 ms duration instead of 21 ms, and the
   * second fragment opened 16 ms behind the end of the first.
   *
   * So the later track's first sample is declared to start at the shared zero.
   * Its duration then absorbs the offset — one frame plays at most a capture
   * skew early, which is inaudible — and every sample after it keeps its true
   * timestamp, so A/V sync is untouched and the running clock is honest from
   * the start. The alternative, `firstTimestampBehavior: "offset"`, would rebase
   * each track to its own zero and desynchronise the whole recording instead.
   *
   * webm-muxer has no such assumption and needs none of this.
   */
  private firstSampleUs(track: "video" | "audio", timestampUs: number): number {
    if (this.started[track]) return timestampUs;
    this.started[track] = true;
    return 0;
  }

  /**
   * The `…Raw` methods rather than the convenience ones, because of the
   * duration.
   *
   * `EncodedVideoChunk.duration` is nullable — it mirrors the source
   * `VideoFrame`'s own nullable duration, which is exactly what a
   * `MediaStreamTrackProcessor` frame may have (and what the letterbox path
   * hands on as `duration: frame.duration ?? undefined`). mp4-muxer's
   * `addVideoChunk` passes that straight into `addVideoChunkRaw`, which
   * validates `Number.isFinite(duration)` and throws a TypeError on null —
   * ending the recording through `write()`'s catch. webm-muxer never reads
   * chunk duration at all, which is why only the fMP4 path ever hit this.
   *
   * Zero is a safe stand-in: mp4-muxer only uses the duration as the
   * *provisional* length of a sample, and refines it the moment the next sample
   * of that track arrives — which happens before the fragment holding it is
   * written. Only the very last sample of the file keeps it, and this container
   * carries no authoritative duration anyway (§6): `meta.durationMs` does.
   */
  addVideo(
    chunk: EncodedVideoChunk,
    meta: EncodedVideoChunkMetadata | undefined,
    timestampUs: number,
  ): void {
    this.muxer.addVideoChunkRaw(
      chunkBytes(chunk),
      chunk.type,
      this.firstSampleUs("video", timestampUs),
      chunk.duration ?? 0,
      meta,
    );
  }

  addAudio(
    chunk: EncodedAudioChunk,
    meta: EncodedAudioChunkMetadata | undefined,
    timestampUs: number,
  ): void {
    this.muxer.addAudioChunkRaw(
      chunkBytes(chunk),
      chunk.type,
      this.firstSampleUs("audio", timestampUs),
      chunk.duration ?? 0,
      meta,
    );
  }

  finalize(): void {
    this.muxer.finalize();
  }
}

// --- WebCodecs engine --------------------------------------------------------

type PendingChunk =
  | { track: "video"; chunk: EncodedVideoChunk; meta: EncodedVideoChunkMetadata | undefined }
  | { track: "audio"; chunk: EncodedAudioChunk; meta: EncodedAudioChunkMetadata | undefined };

/**
 * Everything the video encoder was configured with, decided once by `setup()`
 * and then read all over the engine: which codec is running, whether it is the
 * hardware one, how it is being told what quality to aim for, and whether it
 * accepted the screen-content hint.
 */
export interface VideoSetup {
  codec: VideoCodec;
  /** Configured with `hardwareAcceleration: "prefer-hardware"`. */
  hardware: boolean;
  /**
   * `"quantizer"` is constant quality, the path this engine is built around;
   * `"variable"` is the §6 fallback for an encoder that refuses per-frame QP,
   * and takes a bitrate from {@link bitrateFor} instead.
   */
  rateControl: "quantizer" | "variable";
  /** The probed config carried `contentHint: "text"` (§6 screen-content tuning). */
  contentHint: boolean;
}

/**
 * What is left to try when a video encoder that `isConfigSupported()` approved
 * turns out to reject its config for real, in the order to try it.
 *
 * `isConfigSupported()` is an opinion, not a reservation. A hardware encoder can
 * answer yes and then refuse the session anyway — every NVENC slot taken by
 * another capture app, a GPU driver reset — and per-frame QP in particular is
 * young enough (Chrome 117) that a platform encoder may accept `bitrateMode:
 * "quantizer"` in a probe and reject it once frames arrive. WebCodecs reports
 * both asynchronously, through the encoder's error callback rather than out of
 * `configure()`, so without this the recording simply ended.
 *
 * Only the degradations {@link WebCodecsEngine.probeCandidate} itself models,
 * and only the ones that keep the codec: by the time an encoder can fail this
 * way the muxer has usually already declared the video track — it opens on the
 * first chunk of every declared track, and audio normally gets there first — and
 * a different codec means a different container, a different audio codec and a
 * different `meta.mimeType`, none of which can be taken back once a byte has
 * been uploaded (§7). So per-frame quantizer goes first (H.264 has §6's bitrate
 * table to fall back on; VP9 and AV1 have no such table, so they get no rung
 * here and behave exactly as they did before), then the hardware encoder.
 */
/** A setup in words, for the one console line a fallback is worth. */
function describeSetup(setup: VideoSetup): string {
  return `${setup.codec} ${setup.hardware ? "hardware" : "software"} ${setup.rateControl}`;
}

export function videoFallbackSetups(setup: VideoSetup): VideoSetup[] {
  if (setup.codec !== "h264") return [];
  const variable = (s: VideoSetup): VideoSetup => ({ ...s, rateControl: "variable" });
  const rungs: VideoSetup[] = [];
  if (setup.rateControl === "quantizer") rungs.push(variable(setup));
  if (setup.hardware) {
    const software: VideoSetup = { ...setup, hardware: false };
    rungs.push(software);
    if (software.rateControl === "quantizer") rungs.push(variable(software));
  }
  return rungs;
}

class WebCodecsEngine implements RecorderEngine {
  ondata: (bytes: Uint8Array) => void = () => undefined;
  onerror: (err: Error) => void = () => undefined;

  private videoSetup: VideoSetup;
  private container: Container;
  private audioCodec: AudioCodec = "opus";
  private codecString: string;
  private type: string;
  private hasAudio = true;
  private frameRate = NOMINAL_FRAME_RATE;

  private stream: MediaStream | null = null;
  /** Set when this browser turned out not to support any WebCodecs config. */
  private delegate: MediaRecorderEngine | null = null;

  private muxer: MuxerAdapter | null = null;
  private videoEncoder: VideoEncoder | null = null;
  private audioEncoder: AudioEncoder | null = null;
  private videoSize: { width: number; height: number } | null = null;
  /**
   * The video encoder has produced at least one chunk, so its config is not
   * merely approved but working — after which an error really is a failure and
   * not a late rejection to fall back from (see {@link videoFallbackSetups}).
   */
  private videoStarted = false;
  /** Setups still to try if this one turns out to be rejected. Filled by `setup()`. */
  private videoFallback: VideoSetup[] = [];
  private audioInput: { sampleRate: number; numberOfChannels: number } | null = null;
  /** The encoded audio format, straight from the encoder's `decoderConfig`. */
  private audioOutput: { sampleRate: number; numberOfChannels: number } | null = null;

  /** Chunks encoded before the muxer could be built — see `openMuxer`. */
  private readonly pending: PendingChunk[] = [];
  /** Shared A/V zero point in microseconds; frozen once the muxer exists. */
  private base: number | null = null;
  private lastKeyframeUs = Number.NEGATIVE_INFINITY;

  /**
   * A clone of the last frame off the capture track, held open so the §6
   * heartbeat has something to re-encode when the screen goes still. Sharing
   * the original's pixels, it costs one buffer out of the capture pool — which
   * is why exactly one is ever held and every exit path closes it.
   */
  private retained: VideoFrame | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** Media timestamp of the last frame handed to the video encoder, in µs. */
  private lastEncodeUs = Number.NEGATIVE_INFINITY;
  /** Wall clock when that happened — what "the timeline has stood still" means. */
  private lastEncodeAtMs = 0;

  private videoReader: ReadableStreamDefaultReader<VideoFrame> | null = null;
  private audioReader: ReadableStreamDefaultReader<AudioData> | null = null;
  private pumps: Promise<void> = Promise.resolve();

  /** End of the last audio handed to the encoder, on the capture clock. */
  private audioClockUs: number | null = null;
  /**
   * Set once the audio track has ended but video is still going —
   * `fillAudioGap()`. The buffer is spelled out as `ArrayBuffer`-backed because
   * `AudioDataInit.data` excludes the shared-memory arm of `Float32Array`.
   */
  private silence: {
    timestamp: number;
    frames: number;
    samples: Float32Array<ArrayBuffer>;
  } | null = null;

  /** Bytes handed to `ondata`, used to prove the muxer really is append-only. */
  private written = 0;
  private failure: Error | null = null;
  private stopping: Promise<void> | null = null;
  private stopped = false;

  private canvas: OffscreenCanvas | null = null;
  private context: OffscreenCanvasRenderingContext2D | null = null;

  constructor(private readonly opts: EngineOptions) {
    // The best guess available before anything has been probed: the first rung
    // of this setting's own chain, which on a desktop Chrome is what setup()
    // will confirm anyway. Nothing is committed until then.
    const first = codecCandidates(opts.codec)[0] as CodecCandidate;
    this.videoSetup = {
      codec: first.codec,
      hardware: first.hardware,
      rateControl: "quantizer",
      contentHint: true,
    };
    this.container = containerFor(first.codec);
    this.audioCodec = selectAudioCodec(this.container, true);
    this.codecString = videoCodecString(first.codec, NOMINAL_WIDTH, NOMINAL_HEIGHT);
    this.type = containerMimeType(this.container, this.codecString, this.audioCodec);
  }

  get mimeType(): string {
    return this.delegate ? this.delegate.mimeType : this.type;
  }

  start(stream: MediaStream): void {
    if (this.stream) throw new Error("encoder: start() called twice");
    const video = stream.getVideoTracks()[0];
    if (!video) throw new Error("The capture stream has no video track.");

    this.stream = stream;
    const audio = stream.getAudioTracks()[0] ?? null;
    this.hasAudio = audio !== null;

    // A first honest guess from the track's own settings, so the page has a
    // type to show immediately; setup() and the first frame refine it.
    const settings = video.getSettings();
    // Capture asks for 30 fps (§6) but a browser may hand over more, and the
    // codec level has to describe what is really in the file.
    this.frameRate = Math.max(1, Math.round(settings.frameRate ?? NOMINAL_FRAME_RATE));
    this.retype(
      videoCodecString(
        this.videoSetup.codec,
        settings.width ?? NOMINAL_WIDTH,
        settings.height ?? NOMINAL_HEIGHT,
        this.frameRate,
      ),
    );

    this.pumps = this.run(video, audio, settings);
  }

  stop(): Promise<void> {
    if (this.delegate) return this.delegate.stop();
    this.stopping ??= this.finish();
    return this.stopping;
  }

  // --- Setup -----------------------------------------------------------------

  private async run(
    video: MediaStreamTrack,
    audio: MediaStreamTrack | null,
    settings: MediaTrackSettings,
  ): Promise<void> {
    try {
      await this.setup(settings);
      if (this.delegate || this.stopped) return;
      // allSettled, not all: one pump failing must not leave the other's
      // rejection unhandled, and both still have frames to close either way.
      const settled = await Promise.allSettled(
        audio ? [this.pumpVideo(video), this.pumpAudio(audio)] : [this.pumpVideo(video)],
      );
      for (const result of settled) if (result.status === "rejected") this.fail(result.reason);
    } catch (err) {
      this.fail(err);
    }
  }

  /**
   * Decides what will be recorded (§6): walks this setting's fallback chain,
   * asking `isConfigSupported()` about each rung until one answers yes, then
   * hands the answers to `selectEncoding()` so the decision itself is made in
   * exactly one place — the pure one the tests drive.
   *
   * A codec only wins if the encoder can produce it *and* the player could feed
   * the result to MSE; otherwise every viewer would fall back to downloading
   * the whole file, and another codec is the better trade. Probing stops at the
   * first rung that passes, so the common case (hardware H.264 on `"auto"`) is
   * one probe, not four.
   *
   * The size used here is the track's, which is what the capture constraints
   * asked for; the first frame gets the final say on the level digits.
   */
  private async setup(settings: MediaTrackSettings): Promise<void> {
    const width = settings.width ?? NOMINAL_WIDTH;
    const height = settings.height ?? NOMINAL_HEIGHT;

    // Probed first, because it decides which audio codec goes in the mime type
    // the video probes below have to be playable as.
    const support: CodecSupport = {
      h264Hardware: false,
      h264: false,
      vp9: false,
      av1: false,
      aac: this.hasAudio && (await this.aacUsable()),
    };

    // In chain order, so the flags this fills in are exactly the ones
    // `selectVideoCodec` needs: everything before the winner is a known no.
    let winner: VideoSetup | null = null;
    for (const candidate of codecCandidates(this.opts.codec)) {
      const probed = await this.probeCandidate(candidate, width, height, support.aac);
      if (!probed) continue;
      winner = probed;
      if (candidate.codec === "h264") {
        support.h264 = true;
        support.h264Hardware = candidate.hardware;
      } else {
        support[candidate.codec] = true;
      }
      break;
    }

    const plan = selectEncoding({
      codec: this.opts.codec,
      caps: detectCapabilities(),
      support,
      width,
      height,
      frameRate: this.frameRate,
      hasAudio: this.hasAudio,
      fallbackMimeType: selectFallbackMimeType(),
    });

    if (!winner || plan?.engine !== "webcodecs" || !plan.container) {
      this.startDelegate("no supported WebCodecs configuration");
      return;
    }

    this.videoSetup = winner;
    // What to drop to if the encoder rejects this config for real, once frames
    // are flowing and `isConfigSupported()`'s opinion is behind us.
    this.videoFallback = videoFallbackSetups(winner);
    this.container = plan.container;
    this.audioCodec = plan.audioCodec ?? selectAudioCodec(plan.container, support.aac);
    // `plan.substituted` is deliberately not surfaced on the engine: §6's
    // interface carries `mimeType` and nothing else, and the page names the
    // fallback from that one string — which is also the only answer that stays
    // right when the MediaRecorder engine happens to record the very codec that
    // was asked for.
    this.retype(videoCodecString(winner.codec, width, height, this.frameRate));
  }

  /**
   * Encodable here *and* playable through MSE there, at one rung of the chain.
   * Returns the exact shape that worked, because "supported" is not one answer
   * but four: the codec, the acceleration, how rate control is expressed, and
   * whether the screen-content hint was accepted.
   */
  private async probeCandidate(
    candidate: CodecCandidate,
    width: number,
    height: number,
    aac: boolean,
  ): Promise<VideoSetup | null> {
    const container = containerFor(candidate.codec);
    const codecString = videoCodecString(candidate.codec, width, height, this.frameRate);
    const mimeType = containerMimeType(
      container,
      codecString,
      this.hasAudio ? selectAudioCodec(container, aac) : null,
    );
    if (!mseSupported(mimeType)) return null;

    // Rate control first: constant quality is the whole point of this engine,
    // and a bitrate with the content hint is a worse recording than a quantizer
    // without it. Per-frame QP is young (Chrome 117) and platform encoders
    // vary, so a hardware H.264 encoder refusing it is an expected answer, not
    // a broken one — but only H.264 has the §6 bitrate table to fall back on.
    const modes: readonly VideoSetup["rateControl"][] =
      candidate.codec === "h264" ? ["quantizer", "variable"] : ["quantizer"];

    for (const rateControl of modes) {
      // contentHint is young enough that a browser may know the field and
      // refuse the value, which is no reason to give up a whole codec.
      for (const contentHint of [true, false]) {
        const setup: VideoSetup = { ...candidate, rateControl, contentHint };
        try {
          const support = await VideoEncoder.isConfigSupported(
            this.videoConfig(setup, codecString, even(width), even(height)),
          );
          if (support.supported !== true) continue;
        } catch {
          // A browser that rejects the config outright is telling us the same
          // thing as `supported: false`.
          continue;
        }
        return setup;
      }
    }
    return null;
  }

  /**
   * Whether this browser has an AAC encoder for a given audio format (§6).
   *
   * Asked twice. First at the §6 mix's own shape — 48 kHz mono — before any
   * audio has arrived, so the answer is in hand when the video probes need to
   * know which mime type to check; then again at whatever format the capture
   * actually delivers, because that is the config the encoder will be handed
   * and a probe of a different one proves nothing about it. Missing in Firefox
   * everywhere and in every browser on desktop Linux, where MP4 gets an Opus
   * track instead.
   */
  private async aacUsable(sampleRate = NOMINAL_SAMPLE_RATE, numberOfChannels = 1): Promise<boolean> {
    if (typeof AudioEncoder?.isConfigSupported !== "function") return false;
    try {
      const support = await AudioEncoder.isConfigSupported(
        this.audioConfig("aac", sampleRate, numberOfChannels),
      );
      return support.supported === true;
    } catch {
      return false;
    }
  }

  private videoConfig(
    setup: VideoSetup,
    codec: string,
    width: number,
    height: number,
  ): VideoEncoderConfig {
    const config: VideoEncoderConfig = {
      codec,
      width,
      height,
      framerate: this.frameRate,
      bitrateMode: setup.rateControl,
      // "realtime" runs the fast motion search — 5-10x faster than "quality",
      // which cannot keep up with native-resolution capture (§6). Same
      // quantizer, so text stays as sharp; files run somewhat larger.
      latencyMode: "realtime",
    };
    // In quantizer mode `bitrate` is ignored — every frame carries its own
    // quantizer instead (§6). Only where the encoder refused that does the
    // config carry a number of bits, scaled to the frame.
    if (setup.rateControl === "variable") {
      config.bitrate = bitrateFor(this.opts.quality, width, height);
    }
    if (setup.codec === "h264") {
      // A preference, not a promise — the spec has no "require-hardware", so
      // this is as close as a config gets to asking for the GPU encoder that
      // makes 4K capture free. "no-preference" is the second rung of the H.264
      // chain, where the software encoder is accepted.
      config.hardwareAcceleration = setup.hardware ? "prefer-hardware" : "no-preference";
      // MP4 keeps the SPS/PPS in an `avcC` box, not inline in the bitstream:
      // "avc" is what makes the encoder hand them over as
      // `decoderConfig.description`, which is that box (see `Mp4MuxerAdapter`).
      config.avc = { format: "avc" };
    }
    // Screen content: keep text edges crisp rather than smoothing for motion.
    if (setup.contentHint) config.contentHint = "text";
    return config;
  }

  /** The audio encoder's config, shared by the AAC probe and the real one. */
  private audioConfig(
    codec: AudioCodec,
    sampleRate: number,
    numberOfChannels: number,
  ): AacAudioEncoderConfig {
    const config: AacAudioEncoderConfig = {
      codec: AUDIO_CODEC_STRINGS[codec],
      sampleRate,
      numberOfChannels,
      bitrate: codec === "aac" ? AAC_BITRATE : OPUS_BITRATE,
    };
    // Raw AAC frames; the AudioSpecificConfig arrives as decoderConfig instead.
    if (codec === "aac") config.aac = { format: "aac" };
    return config;
  }

  private startDelegate(reason: string): void {
    const stream = this.stream;
    // Nothing to delegate to if the page already stopped while we were probing.
    if (!stream || this.stopped) return;
    console.warn(`[videoshare] falling back to MediaRecorder: ${reason}`);
    const delegate = new MediaRecorderEngine(this.opts);
    delegate.ondata = (bytes) => this.ondata(bytes);
    delegate.onerror = (err) => this.onerror(err);
    // Only adopt the delegate once it really started, so a failure here still
    // surfaces through stop() instead of being swallowed by delegation.
    delegate.start(stream);
    this.delegate = delegate;
  }

  private retype(codecString: string): void {
    this.codecString = codecString;
    this.type = containerMimeType(
      this.container,
      codecString,
      this.hasAudio ? this.audioCodec : null,
    );
  }

  // --- Video -----------------------------------------------------------------

  private async pumpVideo(track: MediaStreamTrack): Promise<void> {
    const ctor = trackProcessorCtor();
    if (!ctor) throw new Error("MediaStreamTrackProcessor disappeared mid-start.");
    const reader = new ctor<VideoFrame>({ track }).readable.getReader();
    this.videoReader = reader;
    // stop() may have run while setup() was still awaiting; it cancels whatever
    // reader exists at that moment, which could have been none.
    if (this.stopped) {
      await cancelReader(reader);
      return;
    }

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || !value) return;
        try {
          if (this.stopped || this.failure) return;
          if (!this.videoEncoder) this.configureVideo(value);
          // Taken before the encoder sees the frame, and kept after the
          // `finally` below closes it: the heartbeat may need this picture
          // seconds from now, when nothing else has arrived (§6).
          this.retain(value);
          // Before the frame, not after: the muxer will not release a video
          // block until audio has passed its timestamp.
          this.fillAudioGap(value.timestamp);
          this.encodeFrame(value);
        } finally {
          // Every path closes the frame: a leaked VideoFrame stalls capture.
          value.close();
        }
      }
    } finally {
      // The track is done delivering, so there is nothing left to repeat: a
      // heartbeat past this point would only extend the recording with a frozen
      // picture the capture never produced.
      this.releaseHeartbeat();
      await cancelReader(reader);
    }
  }

  private configureVideo(frame: VideoFrame): void {
    // Decided once, from the first frame ever seen: a retry after a rejected
    // config must configure the encoder at the size the muxer already declared,
    // and a window resized in between goes through `fit()` like any other.
    const size = this.videoSize ?? {
      width: even(frame.displayWidth),
      height: even(frame.displayHeight),
    };
    // The real frame size, so the level in the codec string is honest (§5).
    this.retype(videoCodecString(this.videoSetup.codec, size.width, size.height, this.frameRate));

    // Before openMuxer() below, never after: with no audio track the muxer opens
    // on this very call, and it freezes the zero point. Leaving that until
    // encodeFrame() would freeze `base` at null and rebase every chunk to 0.
    this.noteBase(frame.timestamp);

    const encoder = new VideoEncoder({
      output: (chunk, meta) => this.onVideoChunk(chunk, meta),
      error: (err) => this.onVideoEncoderError(encoder, err),
    });
    encoder.configure(this.videoConfig(this.videoSetup, this.codecString, size.width, size.height));
    this.videoEncoder = encoder;
    this.videoSize = size;
    this.openMuxer();
    // There is a picture to repeat from here on, so start watching for
    // stillness. Nothing catches a throw out of a timer callback the way the
    // pumps' `allSettled` does, so a broken encoder has to be routed by hand.
    this.heartbeatTimer ??= setInterval(() => {
      try {
        this.heartbeat();
      } catch (err) {
        this.fail(err);
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  /** A frame straight off the capture track: droppable under backpressure. */
  private encodeFrame(frame: VideoFrame): void {
    this.noteBase(frame.timestamp);
    // A heartbeat can carry the media clock a frame or two past a frame that
    // was captured just before it, because capture timestamps trail delivery.
    // The muxer refuses a video timestamp below the one before it — that would
    // end the recording — and the heartbeat has already put this instant on the
    // timeline, so the straggler is dropped instead.
    if (frame.timestamp <= this.lastEncodeUs) return;
    this.submit(frame, true);
  }

  /**
   * Hands one frame to the video encoder at its own timestamp.
   *
   * `droppable` is the §6 backpressure valve: an incoming delta frame is
   * expendable when the encoder is already behind, because another one is 33 ms
   * away. Keyframes never are — dropping one breaks every frame that
   * references it — and neither is a heartbeat, which only ever runs when the
   * queue is short in the first place.
   */
  private submit(frame: VideoFrame, droppable: boolean): void {
    const encoder = this.videoEncoder;
    if (!encoder || encoder.state !== "configured") return;

    const keyFrame = frame.timestamp - this.lastKeyframeUs >= KEYFRAME_INTERVAL_US;
    if (!keyFrame && droppable && encoder.encodeQueueSize > MAX_ENCODE_QUEUE) return;

    const options: QuantizerEncodeOptions = { keyFrame };
    // Each codec's per-frame quantizer has its own name and its own range, and
    // none of them mean anything to an encoder in variable-bitrate mode.
    if (this.videoSetup.rateControl === "quantizer") {
      const codec = this.videoSetup.codec;
      const quantizer = quantizerFor(codec, this.opts.quality);
      if (codec === "av1") options.av1 = { quantizer };
      else if (codec === "h264") options.avc = { quantizer };
      else options.vp9 = { quantizer };
    }

    const source = this.fit(frame);
    try {
      encoder.encode(source, options);
      this.lastEncodeUs = frame.timestamp;
      this.lastEncodeAtMs = nowMs();
      if (keyFrame) this.lastKeyframeUs = frame.timestamp;
    } finally {
      if (source !== frame) source.close();
    }
  }

  // --- Heartbeat (§6) --------------------------------------------------------

  /** Replaces the retained clone, closing the one it supersedes. */
  private retain(frame: VideoFrame): void {
    let clone: VideoFrame;
    try {
      clone = new VideoFrame(frame);
    } catch (err) {
      // Out of capture buffers, most likely. The clone already held is an
      // older picture but still a valid one, so keep it rather than going blind.
      console.warn("[videoshare] could not retain a frame for the heartbeat", err);
      return;
    }
    this.retained?.close();
    this.retained = clone;
  }

  /**
   * Re-encodes the retained frame at the current media time when nothing has
   * reached the encoder for {@link HEARTBEAT_IDLE_MS} (§6). The picture is
   * unchanged, so in quantizer mode the delta frame costs a few dozen bytes;
   * what it buys is a video timeline with no hole for MSE to split on (§8).
   */
  private heartbeat(): void {
    if (this.stopped || this.failure) {
      this.releaseHeartbeat();
      return;
    }

    const frame = this.retained;
    const encoder = this.videoEncoder;
    const now = nowMs();
    const due = heartbeatDue({
      nowMs: now,
      lastEncodeAtMs: this.lastEncodeAtMs,
      queueSize: encoder?.encodeQueueSize ?? 0,
      // A picture to repeat, and a clock that has actually started.
      hasFrame: frame !== null && Number.isFinite(this.lastEncodeUs),
      recording: encoder?.state === "configured",
    });
    if (!due || !frame) return;

    const timestamp = heartbeatTimestampUs(this.lastEncodeUs, this.lastEncodeAtMs, now);
    let source: VideoFrame;
    try {
      // The retained clone still carries its original timestamp; re-stamping it
      // shares the same pixels rather than copying them.
      source = new VideoFrame(frame, { timestamp });
    } catch (err) {
      console.warn("[videoshare] could not synthesize a heartbeat frame", err);
      return;
    }

    try {
      // Same order as the capture pump, and for the same reason: the muxer
      // holds a video block until the audio clock has passed it, so a heartbeat
      // that skipped this would stop the byte stream instead of feeding it.
      this.fillAudioGap(timestamp);
      // Never droppable: `heartbeatDue` already refused if the queue was long,
      // and a heartbeat that crosses the 8 s deadline is a keyframe like any
      // other frame would be.
      this.submit(source, false);
    } finally {
      source.close();
    }
  }

  /** Stops the heartbeat and gives the retained capture buffer back. */
  private releaseHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    // A VideoFrame left open holds a buffer the capture pipeline needs back.
    this.retained?.close();
    this.retained = null;
  }

  /**
   * The encoder is locked to the size it was configured with, but a shared
   * window can be resized mid-recording. Letterbox other sizes into the original
   * box rather than handing the encoder a frame it may refuse.
   */
  private fit(frame: VideoFrame): VideoFrame {
    const size = this.videoSize;
    if (!size || (frame.displayWidth === size.width && frame.displayHeight === size.height)) {
      return frame;
    }

    // The common case is not a resize at all: `configureVideo` rounded an odd
    // capture down to an even encoder size (1919 → 1918, and a HiDPI screen
    // constrained to 1920 wide lands on an odd height often enough). Scaling
    // every frame by 1918/1919 through a canvas would cost a resample and a
    // fresh allocation 30 times a second, and resampling is exactly what
    // softens the screen text this engine exists to keep crisp. Trimming the
    // spare pixel costs nothing: the crop shares the source's pixels.
    const cropped = this.crop(frame, size);
    if (cropped) return cropped;

    this.canvas ??= new OffscreenCanvas(size.width, size.height);
    this.context ??= this.canvas.getContext("2d");
    const context = this.context;
    if (!context) return frame;

    const scale = Math.min(size.width / frame.displayWidth, size.height / frame.displayHeight);
    const width = Math.max(1, Math.round(frame.displayWidth * scale));
    const height = Math.max(1, Math.round(frame.displayHeight * scale));
    context.fillStyle = "#000";
    context.fillRect(0, 0, size.width, size.height);
    context.drawImage(frame, (size.width - width) / 2, (size.height - height) / 2, width, height);

    return new VideoFrame(this.canvas, {
      timestamp: frame.timestamp,
      duration: frame.duration ?? undefined,
      alpha: "discard",
    });
  }

  /**
   * A view of `frame` trimmed to the encoder's box, or null when trimming is the
   * wrong answer. `visibleRect` is in the source's coded coordinates and the
   * result shares its buffer, so this is a wrapper rather than a copy.
   *
   * Only for the at-most-a-pixel mismatch left by rounding to even dimensions.
   * A real resize is a different picture, and cropping one would silently cut
   * content off the edge of the recording; that goes through the letterbox.
   */
  private crop(frame: VideoFrame, size: { width: number; height: number }): VideoFrame | null {
    const rect = frame.visibleRect;
    if (!rect) return null;
    // Non-square pixels would make a crop in coded space the wrong size on
    // screen. Screen capture never has them, but nothing here guarantees it.
    if (rect.width !== frame.displayWidth || rect.height !== frame.displayHeight) return null;

    const spareX = rect.width - size.width;
    const spareY = rect.height - size.height;
    if (spareX < 0 || spareY < 0 || spareX > 1 || spareY > 1) return null;

    try {
      return new VideoFrame(frame, {
        visibleRect: { x: rect.x, y: rect.y, width: size.width, height: size.height },
        displayWidth: size.width,
        displayHeight: size.height,
      });
    } catch {
      // An odd offset that the pixel format cannot express, or a browser that
      // refuses the override; the letterbox below still produces a frame.
      return null;
    }
  }

  private onVideoChunk(chunk: EncodedVideoChunk, meta: EncodedVideoChunkMetadata | undefined): void {
    // This config works, whatever `isConfigSupported()` thought: from here an
    // encoder error is a real failure, not a late rejection to fall back from.
    this.videoStarted = true;
    this.push({ track: "video", chunk, meta });
  }

  /**
   * A video encoder that gave up. Before it produced anything that is a
   * configuration rejection arriving the only way WebCodecs delivers one — a
   * queued task into this callback, never a throw out of `configure()` — so the
   * next rung of {@link videoFallbackSetups} gets a turn before the recording
   * is declared over. After the first chunk it is what it has always been: the
   * end of the recording.
   */
  private onVideoEncoderError(encoder: VideoEncoder, err: unknown): void {
    // A superseded encoder complaining about the config we already left behind.
    if (this.videoEncoder !== encoder) return;
    if (this.videoStarted || this.stopped || this.failure) {
      this.fail(err);
      return;
    }
    const next = this.videoFallback.shift();
    if (!next) {
      this.fail(err);
      return;
    }
    console.warn(
      `[videoshare] the ${describeSetup(this.videoSetup)} video encoder rejected its ` +
        `configuration; retrying as ${describeSetup(next)}`,
      err,
    );
    this.videoEncoder = null;
    this.videoSetup = next;
    // A fresh encoder starts a fresh GOP, whatever the old one was told.
    this.lastKeyframeUs = Number.NEGATIVE_INFINITY;
    this.restartVideo();
  }

  /**
   * Brings the video encoder back up on the setup now in `videoSetup`, from the
   * retained frame so a screen that has gone still does not have to move again
   * first — the heartbeat submits that frame as soon as the encoder is up.
   * With no frame retained there is nothing to configure from and the next one
   * off the capture track does it instead.
   */
  private restartVideo(): void {
    for (;;) {
      const frame = this.retained;
      if (!frame) return;
      try {
        this.configureVideo(frame);
        return;
      } catch (err) {
        // A synchronous rejection — an invalid config rather than an
        // unsupported one — is the same answer, one rung earlier.
        const next = this.videoFallback.shift();
        if (!next) {
          this.fail(err);
          return;
        }
        this.videoSetup = next;
      }
    }
  }

  // --- Audio -----------------------------------------------------------------

  private async pumpAudio(track: MediaStreamTrack): Promise<void> {
    const ctor = trackProcessorCtor();
    if (!ctor) throw new Error("MediaStreamTrackProcessor disappeared mid-start.");
    const reader = new ctor<AudioData>({ track }).readable.getReader();
    this.audioReader = reader;
    if (this.stopped) {
      await cancelReader(reader);
      return;
    }

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || !value) return;
        try {
          if (this.stopped || this.failure) return;
          // Awaited, so the AAC support question is asked at this capture's
          // real format before an encoder is built on the answer. The pump is
          // sequential, so nothing else reads a half-configured encoder.
          if (!this.audioEncoder) await this.configureAudio(value);
          if (this.stopped || this.failure) return;
          this.noteBase(value.timestamp);
          const encoder = this.audioEncoder;
          if (encoder && encoder.state === "configured") {
            encoder.encode(value);
            // Where silence would have to pick up if this turns out to be the
            // last of the real audio.
            const span = value.sampleRate > 0 ? value.numberOfFrames / value.sampleRate : 0;
            this.audioClockUs = value.timestamp + Math.round(span * 1_000_000);
          }
        } finally {
          // AudioData holds a buffer the capture pipeline reuses.
          value.close();
        }
      }
    } finally {
      await cancelReader(reader);
      if (!this.stopped) await this.audioEnded();
    }
  }

  /**
   * §6 asks for 48 kHz mono, which is what the capture graph produces (the
   * mixing destination is mono and Chrome's AudioContext runs at 48 kHz). The
   * encoder is still told the format it is actually being handed: an encoder
   * fed something other than what it was configured for fails outright, and
   * reporting the real rate keeps the container honest for the device that
   * runs its AudioContext somewhere else.
   */
  private async configureAudio(data: AudioData): Promise<void> {
    // The §6 probe asked about 48 kHz mono, which is what the mixing graph
    // produces — but the AudioContext runs at the device's rate, and a
    // Bluetooth headset in its headset profile hands over 16 kHz. Ask again at
    // the format actually arriving, before an encoder is built on the old
    // answer: for a valid config the platform simply cannot encode, WebCodecs
    // says so through the error callback rather than out of `configure()`, and
    // that callback used to end the recording.
    if (this.audioCodec === "aac" && !(await this.aacUsable(data.sampleRate, data.numberOfChannels))) {
      console.warn("[videoshare] no AAC encoder for this capture's audio format; using Opus in MP4");
      this.useOpus();
    }
    if (this.stopped || this.failure) return;
    this.audioInput = { sampleRate: data.sampleRate, numberOfChannels: data.numberOfChannels };
    this.openAudioEncoder(this.audioCodec, data.sampleRate, data.numberOfChannels);
  }

  private openAudioEncoder(
    codec: AudioCodec,
    sampleRate: number,
    numberOfChannels: number,
  ): void {
    const encoder = new AudioEncoder({
      output: (chunk, meta) => this.onAudioChunk(chunk, meta),
      error: (err) => this.onAudioEncoderError(encoder, err),
    });
    try {
      encoder.configure(this.audioConfig(codec, sampleRate, numberOfChannels));
    } catch (err) {
      // An outright invalid config, which `configure()` does throw for. Nothing
      // has been muxed yet — the muxer opens on the first audio *chunk* — so
      // the track can still become Opus, which every browser with WebCodecs
      // can encode.
      if (codec !== "aac") throw err;
      console.warn("[videoshare] AAC rejected this capture's audio format; using Opus in MP4", err);
      this.useOpus();
      encoder.configure(this.audioConfig("opus", sampleRate, numberOfChannels));
    }
    this.audioEncoder = encoder;
  }

  /**
   * The AAC encoder gave up. Before it produced a chunk that is the platform
   * refusing the config asynchronously — the normal way WebCodecs refuses one —
   * and nothing is committed yet: the muxer opens on the first audio chunk, so
   * the track can still be rebuilt as Opus rather than taking the whole
   * recording down. After the first chunk the header says AAC and the file
   * cannot change its mind, so it is a failure like any other.
   */
  private onAudioEncoderError(encoder: AudioEncoder, err: unknown): void {
    // A superseded encoder complaining about the codec we already left behind.
    if (this.audioEncoder !== encoder) return;
    const input = this.audioInput;
    if (this.audioCodec !== "aac" || this.audioOutput || this.stopped || this.failure || !input) {
      this.fail(err);
      return;
    }
    console.warn("[videoshare] the AAC encoder rejected this capture's audio; using Opus in MP4", err);
    this.useOpus();
    this.audioEncoder = null;
    try {
      this.openAudioEncoder("opus", input.sampleRate, input.numberOfChannels);
    } catch (retryErr) {
      this.fail(retryErr);
    }
  }

  /** Moves the audio track to Opus, and the mime type with it (§5). */
  private useOpus(): void {
    this.audioCodec = "opus";
    this.retype(this.codecString);
  }

  /**
   * The audio track ended on its own — a revoked microphone, an unplugged
   * device — while the video keeps going. Either way the muxer must not be left
   * waiting on an audio track that will never say anything again, because it
   * would stop emitting bytes and the §7 upload streams what it emits.
   */
  private async audioEnded(): Promise<void> {
    // Flush first when nothing has come out yet: if the encoder was holding the
    // very first chunk, it arrives now and there is a real audio track after
    // all. flush() drains an encoder without closing it.
    const held = this.audioEncoder;
    if (held && !this.audioOutput) {
      try {
        if (held.state === "configured") await held.flush();
      } catch (err) {
        this.fail(err);
      }
    }

    // Still nothing: drop the audio track from the plan entirely. Otherwise the
    // muxer waits forever for a decoder config that is never coming and not a
    // byte reaches the uploader.
    if (!this.audioOutput) {
      await this.flushEncoder(this.audioEncoder);
      this.audioEncoder = null;
      if (this.hasAudio) {
        this.hasAudio = false;
        this.retype(this.codecString);
      }
      this.openMuxer();
      return;
    }

    // There *is* an audio track in the file, and it cannot be taken back out:
    // its header is already written. Keep the encoder open and feed it silence
    // instead — see `fillAudioGap()`.
    const input = this.audioInput;
    const encoder = this.audioEncoder;
    if (!input || !encoder || encoder.state !== "configured" || this.audioClockUs === null) return;

    const frames = Math.max(1, Math.round((input.sampleRate * SILENCE_FRAME_US) / 1_000_000));
    this.silence = {
      timestamp: this.audioClockUs,
      frames,
      // The AudioData constructor copies its init data (only buffers named in
      // `transfer` are adopted), so one zero-filled buffer serves every frame.
      samples: new Float32Array(frames * input.numberOfChannels),
    };
  }

  /**
   * Keeps the audio clock ahead of the video clock once the audio track has
   * ended, by encoding real silence.
   *
   * Both muxers interleave the two tracks the same way: a video block is
   * written only once the audio timestamp has passed it, and queued otherwise —
   * webm-muxer to keep a cluster in order, mp4-muxer to fill a fragment. With the
   * audio clock frozen at the moment the track ended, every later video chunk
   * would sit in that queue — no `ondata`, so the streaming upload (§7) stalls,
   * the progress readout freezes, and the whole remainder of the recording
   * accumulates in memory to land in one burst at `finalize()`. Nothing is
   * lost, but nothing is uploaded either, which is the point of recording and
   * uploading at once.
   *
   * Silence rather than a bare timestamp bump because the file keeps a
   * continuous audio track: a hole in it is something MSE has to work around.
   */
  private fillAudioGap(videoTimestamp: number): void {
    const silence = this.silence;
    const input = this.audioInput;
    const encoder = this.audioEncoder;
    if (!silence || !input || !encoder || encoder.state !== "configured") return;

    const target = videoTimestamp + SILENCE_LEAD_US;
    // Normally a no-op: every video frame and every heartbeat comes through
    // here, so the clock is at most a heartbeat behind and gets filled in full.
    silence.timestamp = silenceCatchUpUs(silence.timestamp, target);

    while (silence.timestamp < target) {
      try {
        const data = new AudioData({
          format: "f32-planar",
          sampleRate: input.sampleRate,
          numberOfFrames: silence.frames,
          numberOfChannels: input.numberOfChannels,
          timestamp: Math.round(silence.timestamp),
          data: silence.samples,
        });
        try {
          encoder.encode(data);
        } finally {
          data.close();
        }
      } catch (err) {
        // Losing the silence is not worth losing the video over: give up on it
        // and let the recording finish. Output stops streaming until stop(),
        // exactly as it would have without any of this.
        console.warn("[videoshare] could not synthesize silence for the ended audio track", err);
        this.silence = null;
        return;
      }
      silence.timestamp += SILENCE_FRAME_US;
    }
  }

  private onAudioChunk(chunk: EncodedAudioChunk, meta: EncodedAudioChunkMetadata | undefined): void {
    if (!this.audioOutput) {
      // The decoder config describes what came *out* of the encoder (Opus
      // resamples to 48 kHz internally), which is what the track must declare.
      const config = meta?.decoderConfig;
      this.audioOutput = {
        sampleRate: config?.sampleRate ?? this.audioInput?.sampleRate ?? 48_000,
        numberOfChannels: config?.numberOfChannels ?? this.audioInput?.numberOfChannels ?? 1,
      };
      this.openMuxer();
    }
    this.push({ track: "audio", chunk, meta });
  }

  // --- Muxing ----------------------------------------------------------------

  /**
   * One zero point for both tracks. Rebasing the tracks independently — which
   * is exactly what either muxer's `firstTimestampBehavior: "offset"` does —
   * would slide them against each other and break sync from the first frame,
   * because audio and video never start on the same microsecond. Frozen once
   * the muxer exists, which is only after every track present has produced a
   * chunk, so by then this really is the earliest timestamp of the recording.
   *
   * It is also what lets both adapters be handed timestamps the muxer has no
   * work left to do on: WebM's "permissive" and MP4's "cross-track-offset" both
   * come out as the identity once the earliest chunk written is already 0.
   */
  private noteBase(timestamp: number): void {
    if (this.muxer) return;
    if (this.base === null || timestamp < this.base) this.base = timestamp;
  }

  private rebase(timestamp: number): number {
    return Math.max(0, timestamp - (this.base ?? timestamp));
  }

  /**
   * Built late, and only once every declared track can be described: both
   * muxers write their track headers from the encoders' decoder configs — the
   * Opus/AV1 CodecPrivate blobs in WebM, the `avcC`/`esds` boxes in MP4 — and
   * those have to be in hand by then.
   *
   * `force` is the stop path: whatever we have becomes the file.
   */
  private openMuxer(force = false): void {
    if (this.muxer || this.failure || !this.videoSize) return;
    if (this.hasAudio && !this.audioOutput && !force) return;

    if (this.hasAudio && !this.audioOutput) {
      // Stopped before the audio encoder produced anything: there is no audio
      // track in the file, so the type must not claim one.
      this.hasAudio = false;
      this.retype(this.codecString);
    }

    const audio = this.audioOutput;
    this.muxer = createMuxer({
      video: {
        codec: this.videoSetup.codec,
        width: this.videoSize.width,
        height: this.videoSize.height,
        frameRate: this.frameRate,
      },
      audio: audio
        ? {
            codec: this.audioCodec,
            numberOfChannels: audio.numberOfChannels,
            sampleRate: audio.sampleRate,
          }
        : null,
      onData: (data, position) => this.emit(data, position),
    });

    const queued = this.pending.splice(0).sort((a, b) => a.chunk.timestamp - b.chunk.timestamp);
    for (const entry of queued) this.write(entry);
  }

  private push(entry: PendingChunk): void {
    if (this.muxer) this.write(entry);
    else this.pending.push(entry);
  }

  private write(entry: PendingChunk): void {
    const muxer = this.muxer;
    if (!muxer || this.failure) return;
    const timestamp = this.rebase(entry.chunk.timestamp);
    try {
      if (entry.track === "video") muxer.addVideo(entry.chunk, entry.meta, timestamp);
      else muxer.addAudio(entry.chunk, entry.meta, timestamp);
    } catch (err) {
      this.fail(err);
    }
  }

  private emit(data: Uint8Array, position: number): void {
    if (position !== this.written) {
      // Both muxers are append-only in the modes this engine uses, so this
      // cannot happen — but if it ever did, the bytes already uploaded would be
      // wrong and no rewrite is possible, so stop instead of shipping a corrupt
      // video.
      this.fail(new Error(`encoder: muxer wrote at ${position}, expected ${this.written}`));
      return;
    }
    this.written += data.byteLength;
    this.ondata(data);
  }

  private fail(err: unknown): void {
    console.error("[videoshare] recording engine failed", err);
    if (this.failure) return;
    this.failure = toError(err);
    // Nothing more will be encoded, so the heartbeat has no reason to hold a
    // capture buffer open until stop() eventually arrives.
    this.releaseHeartbeat();
    // Both pumps check `failure` on every read and return, so from here the
    // engine is silent: no more ondata, no rejection until stop() is called.
    // The page has to be told now, while there is still a capture to end.
    // Inside stop() the rejection carries it instead, so it is not repeated.
    if (!this.stopped) this.onerror(this.failure);
  }

  // --- Stop ------------------------------------------------------------------

  private async finish(): Promise<void> {
    this.stopped = true;
    // First, before anything below awaits: a heartbeat landing between the
    // flush and finalize() would encode into an encoder that is being drained.
    this.releaseHeartbeat();
    await cancelReader(this.videoReader);
    await cancelReader(this.audioReader);
    await this.pumps;

    // Flush before finalizing: everything still inside the encoders belongs in
    // the file, and finalize() would otherwise cut it off.
    await this.flushEncoder(this.videoEncoder);
    await this.flushEncoder(this.audioEncoder);

    this.openMuxer(true);
    try {
      this.muxer?.finalize();
    } catch (err) {
      this.fail(err);
    }
    this.muxer = null;

    if (this.failure) throw this.failure;
  }

  private async flushEncoder(encoder: VideoEncoder | AudioEncoder | null): Promise<void> {
    if (!encoder) return;
    try {
      if (encoder.state === "configured") await encoder.flush();
    } catch (err) {
      this.fail(err);
    } finally {
      try {
        encoder.close();
      } catch {
        // Already closed by its own error callback.
      }
    }
  }
}

// --- MediaRecorder engine ----------------------------------------------------

class MediaRecorderEngine implements RecorderEngine {
  ondata: (bytes: Uint8Array) => void = () => undefined;
  onerror: (err: Error) => void = () => undefined;

  private type = FALLBACK_MIME_TYPES[0];
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  /** Serializes `blob.arrayBuffer()` so the bytes reach `ondata` in order. */
  private queue: Promise<void> = Promise.resolve();
  private ended: Promise<void> | null = null;
  private failure: Error | null = null;
  /** Set by `stop()`, so a `stop` event nobody asked for reads as what it is. */
  private stopRequested = false;

  constructor(private readonly opts: EngineOptions) {}

  get mimeType(): string {
    return this.type;
  }

  start(stream: MediaStream): void {
    if (this.recorder) throw new Error("encoder: start() called twice");
    const type = selectFallbackMimeType();
    if (!type) throw new Error("This browser cannot record WebM. Try Chrome, Edge, or Firefox.");

    const recorder = new MediaRecorder(stream, {
      mimeType: type,
      videoBitsPerSecond:
        this.opts.fallbackVideoBitsPerSecond > 0
          ? this.opts.fallbackVideoBitsPerSecond
          : FALLBACK_VIDEO_BITS_PER_SECOND,
      audioBitsPerSecond: FALLBACK_AUDIO_BITRATE,
    });
    // The browser's own string is the true one (§6), as long as the player can
    // still recognise it through MSE.
    this.type = recorder.mimeType && mseSupported(recorder.mimeType) ? recorder.mimeType : type;
    this.recorder = recorder;
    this.stream = stream;

    this.ended = new Promise<void>((resolve) => {
      recorder.addEventListener(
        "stop",
        () => {
          resolve();
          this.checkPrematureStop();
        },
        { once: true },
      );
    });
    recorder.addEventListener("error", (event) => {
      const err = (event as ErrorEvent).error;
      this.fail(err instanceof Error ? err : new Error("The recorder failed mid-capture."));
    });
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size === 0) return;
      this.queue = this.queue
        .then(async () => {
          this.ondata(new Uint8Array(await event.data.arrayBuffer()));
        })
        .catch((err: unknown) => {
          this.fail(toError(err));
        });
    });

    recorder.start(FALLBACK_TIMESLICE_MS);
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    const recorder = this.recorder;
    if (!recorder) return;
    if (recorder.state !== "inactive") recorder.stop();
    // `stop` fires after the last `dataavailable`, so the queue read below picks
    // up every blob there will ever be.
    await this.ended;
    await this.queue;
    if (this.failure) throw this.failure;
  }

  private fail(err: Error): void {
    if (this.failure) return;
    this.failure = err;
    // Same rule as the WebCodecs engine: a failure before stop() is the only
    // thing that will ever tell the page, one raised during stop() is already
    // on its way out through the rejection.
    if (!this.stopRequested) this.onerror(err);
  }

  /**
   * MediaRecorder also fires `stop` on its own: the spec ends a recording once
   * its stream goes inactive. When the capture genuinely ended — the browser's
   * "Stop sharing" bar on a stream with no separate audio track — that is not a
   * failure, and the page hears it from the video track's own `ended` event.
   * A `stop` while tracks are still live is the recorder giving up mid-capture,
   * and nothing else would say so.
   *
   * No `failure` is recorded either way: whatever was captured is valid, and
   * `stop()` should hand it over rather than reject.
   */
  private checkPrematureStop(): void {
    if (this.stopRequested || this.failure) return;
    const live = this.stream?.getTracks().some((track) => track.readyState === "live") ?? false;
    if (!live) return;
    this.onerror(new Error("The browser's recorder stopped on its own mid-capture."));
  }
}
