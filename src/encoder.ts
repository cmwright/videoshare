/**
 * Recording engines (docs/SPEC.md §6).
 *
 * Two implementations behind one `RecorderEngine`:
 *
 * 1. `WebCodecsEngine` (Chrome/Edge) — frames come off the capture tracks
 *    through `MediaStreamTrackProcessor`, go into a `VideoEncoder` running in
 *    quantizer (constant-quality) mode, and are muxed by `webm-muxer` in
 *    streaming mode. Constant quality is what makes screen text legible: bits
 *    follow the content instead of a fixed bitrate.
 * 2. `MediaRecorderEngine` (Firefox, Safari, anything older) — the browser's
 *    own recorder, at the configured fallback bitrate.
 *
 * Both hand muxed WebM bytes to `ondata`, strictly in order, exactly like
 * MediaRecorder's `dataavailable` used to: the recorder page slices those bytes
 * into 8 MiB plaintext chunks and streams them to S3 (§7), so nothing
 * downstream — crypto, upload, player — knows which engine produced them.
 *
 * Nothing here touches a browser global at import time, so the pure parts
 * (codec strings, quantizer table, engine selection) run under Node in tests.
 */

import { Muxer, StreamTarget } from "webm-muxer";
import type { Quality } from "./types";

// --- Public API (SPEC §6) ----------------------------------------------------

/** Re-exported so §6's engine API reads on its own; the union lives in types.ts. */
export type { Quality };

export interface EngineOptions {
  quality: Quality;
  preferAv1: boolean;
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

/** Video codecs the WebCodecs engine can produce. */
export type VideoCodec = "vp9" | "av1";

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

/** Used when settings carry no usable fallback bitrate (§9 default). */
const FALLBACK_VIDEO_BITS_PER_SECOND = 1_200_000;

/** What §6 caps capture at, and what we assume before the first frame arrives. */
const NOMINAL_WIDTH = 1920;
const NOMINAL_HEIGHT = 1080;
const NOMINAL_FRAME_RATE = 30;

/**
 * quality → per-frame quantizer. In `bitrateMode: "quantizer"` this is the only
 * quality knob: higher is coarser and smaller, and the encoder spends whatever
 * bitrate that costs.
 *
 * VP9 takes libvpx's quantizer directly (0–63). AV1 takes an AV1 qindex
 * (0–255), which Chromium divides by 4 to reach the same internal 0–63 scale —
 * so the AV1 column is exactly 4× the VP9 column, both codecs land on the same
 * internal quantizer, and AV1's better tools show up as a smaller file rather
 * than a different-looking picture.
 *
 * - `smaller` — visibly compressed photos and video, UI text still legible;
 *   for long recordings where upload size is what hurts.
 * - `standard` — the default: screen text stays clean and ring-free at 1080p,
 *   roughly 1–2 Mbps of typical desktop capture.
 * - `sharper` — near-transparent for screen content (code, diagrams, thin
 *   fonts), at roughly double the bytes of `standard`.
 */
export const QUANTIZERS: Record<VideoCodec, Record<Quality, number>> = {
  vp9: { smaller: 38, standard: 28, sharper: 20 },
  av1: { smaller: 152, standard: 112, sharper: 80 },
};

export function quantizerFor(codec: VideoCodec, quality: Quality): number {
  const table = QUANTIZERS[codec];
  return table[quality] ?? table.standard;
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
  return codec === "av1"
    ? av1CodecString(width, height, frameRate)
    : vp9CodecString(width, height, frameRate);
}

/**
 * AV1 is a preference, not a promise (§9): a browser that cannot encode it
 * quietly records VP9 rather than failing.
 */
export function selectVideoCodec(preferAv1: boolean, av1Supported: boolean): VideoCodec {
  return preferAv1 && av1Supported ? "av1" : "vp9";
}

/** The MSE-facing type for a WebM of `videoCodec` (+ Opus when there is audio). */
export function containerMimeType(videoCodec: string, hasAudio = true): string {
  return hasAudio ? `video/webm;codecs=${videoCodec},opus` : `video/webm;codecs=${videoCodec}`;
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
 * lib.dom only carries the AVC extension of the per-frame encode options; the
 * VP9 and AV1 registrations add these (quantizer 0–63 and 0–255 respectively).
 */
interface QuantizerEncodeOptions extends VideoEncoderEncodeOptions {
  vp9?: { quantizer: number };
  av1?: { quantizer: number };
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

/**
 * Monotonic wall clock. The same one capture timestamps are measured against,
 * which is what lets the heartbeat carry the media clock forward by elapsed
 * real time (see `heartbeatTimestampUs`).
 */
function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

// --- WebCodecs engine --------------------------------------------------------

type PendingChunk =
  | { track: "video"; chunk: EncodedVideoChunk; meta: EncodedVideoChunkMetadata | undefined }
  | { track: "audio"; chunk: EncodedAudioChunk; meta: EncodedAudioChunkMetadata | undefined };

class WebCodecsEngine implements RecorderEngine {
  ondata: (bytes: Uint8Array) => void = () => undefined;
  onerror: (err: Error) => void = () => undefined;

  private videoCodec: VideoCodec;
  private codecString: string;
  private type: string;
  private hasAudio = true;
  private frameRate = NOMINAL_FRAME_RATE;
  /** Whether the probed config carried `contentHint` (§6 screen-content tuning). */
  private contentHint = true;

  private stream: MediaStream | null = null;
  /** Set when this browser turned out not to support any WebCodecs config. */
  private delegate: MediaRecorderEngine | null = null;

  private muxer: Muxer<StreamTarget> | null = null;
  private videoEncoder: VideoEncoder | null = null;
  private audioEncoder: AudioEncoder | null = null;
  private videoSize: { width: number; height: number } | null = null;
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
    this.videoCodec = selectVideoCodec(opts.preferAv1, true);
    this.codecString = videoCodecString(this.videoCodec, NOMINAL_WIDTH, NOMINAL_HEIGHT);
    this.type = containerMimeType(this.codecString, this.hasAudio);
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
        this.videoCodec,
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
   * Picks the codec: AV1 when it was asked for and this browser can encode it,
   * else VP9, else the browser's own recorder (§6). A codec only wins if the
   * encoder can produce it *and* the player could feed the result to MSE —
   * otherwise every viewer would fall back to downloading the whole file, and
   * MediaRecorder's VP9 is the better trade.
   *
   * The size used here is the track's, which is what the capture constraints
   * asked for; the first frame gets the final say on the level digits.
   */
  private async setup(settings: MediaTrackSettings): Promise<void> {
    const width = settings.width ?? NOMINAL_WIDTH;
    const height = settings.height ?? NOMINAL_HEIGHT;

    const av1Supported = this.opts.preferAv1 && (await this.codecUsable("av1", width, height));
    const codec = selectVideoCodec(this.opts.preferAv1, av1Supported);
    if (codec === "av1" || (await this.codecUsable("vp9", width, height))) {
      this.videoCodec = codec;
      this.retype(videoCodecString(codec, width, height, this.frameRate));
      return;
    }

    this.startDelegate("no supported WebCodecs configuration");
  }

  /** Encodable here *and* playable through MSE there. Records the winning shape. */
  private async codecUsable(codec: VideoCodec, width: number, height: number): Promise<boolean> {
    const codecString = videoCodecString(codec, width, height, this.frameRate);
    if (!mseSupported(containerMimeType(codecString, this.hasAudio))) return false;

    // contentHint is young enough that a browser may know the field and refuse
    // the value, which is no reason to give up a whole codec.
    for (const contentHint of [true, false]) {
      try {
        const support = await VideoEncoder.isConfigSupported(
          this.videoConfig(codecString, even(width), even(height), contentHint),
        );
        if (support.supported !== true) continue;
      } catch {
        // A browser that rejects the config outright is telling us the same
        // thing as `supported: false`.
        continue;
      }
      this.contentHint = contentHint;
      return true;
    }
    return false;
  }

  private videoConfig(
    codec: string,
    width: number,
    height: number,
    contentHint: boolean,
  ): VideoEncoderConfig {
    const config: VideoEncoderConfig = {
      codec,
      width,
      height,
      framerate: this.frameRate,
      // Constant quality: `bitrate` is ignored, every frame carries its own
      // quantizer instead (§6).
      bitrateMode: "quantizer",
      // "realtime" runs libvpx's fast motion search — 5-10x faster than
      // "quality", which cannot keep up with native-resolution capture (§6).
      // Same quantizer, so text stays as sharp; files run somewhat larger.
      latencyMode: "realtime",
    };
    // Screen content: keep text edges crisp rather than smoothing for motion.
    if (contentHint) config.contentHint = "text";
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
    this.type = containerMimeType(codecString, this.hasAudio);
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
    const width = even(frame.displayWidth);
    const height = even(frame.displayHeight);
    // The real frame size, so the level in the codec string is honest (§5).
    this.retype(videoCodecString(this.videoCodec, width, height, this.frameRate));

    // Before openMuxer() below, never after: with no audio track the muxer opens
    // on this very call, and it freezes the zero point. Leaving that until
    // encodeFrame() would freeze `base` at null and rebase every chunk to 0.
    this.noteBase(frame.timestamp);

    const encoder = new VideoEncoder({
      output: (chunk, meta) => this.onVideoChunk(chunk, meta),
      error: (err) => this.fail(err),
    });
    encoder.configure(this.videoConfig(this.codecString, width, height, this.contentHint));
    this.videoEncoder = encoder;
    this.videoSize = { width, height };
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
    const quantizer = quantizerFor(this.videoCodec, this.opts.quality);
    if (this.videoCodec === "av1") options.av1 = { quantizer };
    else options.vp9 = { quantizer };

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
    this.push({ track: "video", chunk, meta });
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
          if (!this.audioEncoder) this.configureAudio(value);
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
   * encoder is still told the format it is actually being handed: a mismatch
   * there is rejected outright, and reporting the real rate keeps the container
   * honest for the rare 44.1 kHz device.
   */
  private configureAudio(data: AudioData): void {
    const encoder = new AudioEncoder({
      output: (chunk, meta) => this.onAudioChunk(chunk, meta),
      error: (err) => this.fail(err),
    });
    encoder.configure({
      codec: "opus",
      sampleRate: data.sampleRate,
      numberOfChannels: data.numberOfChannels,
      bitrate: OPUS_BITRATE,
    });
    this.audioEncoder = encoder;
    this.audioInput = { sampleRate: data.sampleRate, numberOfChannels: data.numberOfChannels };
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
   * webm-muxer interleaves the two tracks: it writes a video block only once
   * the audio timestamp has passed it, and queues the block otherwise. With the
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
   * is exactly what the muxer's `firstTimestampBehavior: "offset"` does — would
   * slide them against each other and break sync from the first frame, because
   * audio and video never start on the same microsecond. Frozen once the muxer
   * exists, which is only after every track present has produced a chunk, so by
   * then this really is the earliest timestamp of the recording.
   */
  private noteBase(timestamp: number): void {
    if (this.muxer) return;
    if (this.base === null || timestamp < this.base) this.base = timestamp;
  }

  private rebase(timestamp: number): number {
    return Math.max(0, timestamp - (this.base ?? timestamp));
  }

  /**
   * Built late, and only once every declared track can be described: in
   * streaming mode webm-muxer writes the Tracks element (with the Opus and AV1
   * CodecPrivate blobs) lazily on the first block, and both tracks' decoder
   * configs have to be in hand by then.
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
    this.muxer = new Muxer({
      target: new StreamTarget({ onData: (data, position) => this.emit(data, position) }),
      video: {
        codec: this.videoCodec === "av1" ? "V_AV1" : "V_VP9",
        width: this.videoSize.width,
        height: this.videoSize.height,
        frameRate: this.frameRate,
      },
      audio: audio
        ? { codec: "A_OPUS", numberOfChannels: audio.numberOfChannels, sampleRate: audio.sampleRate }
        : undefined,
      // Monotonic, append-only output: the bytes are uploaded as they appear and
      // can never be rewritten (§7). This also drops the container duration,
      // which meta.durationMs carries instead (§6).
      streaming: true,
      type: "webm",
      // Timestamps are already rebased against the shared zero point above.
      firstTimestampBehavior: "permissive",
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
      if (entry.track === "video") muxer.addVideoChunk(entry.chunk, entry.meta, timestamp);
      else muxer.addAudioChunk(entry.chunk, entry.meta, timestamp);
    } catch (err) {
      this.fail(err);
    }
  }

  private emit(data: Uint8Array, position: number): void {
    if (position !== this.written) {
      // Streaming mode is append-only, so this cannot happen — but if it ever
      // did, the bytes already uploaded would be wrong and no rewrite is
      // possible, so stop instead of shipping a corrupt video.
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
