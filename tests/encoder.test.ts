/**
 * Unit tests for the pure parts of `src/encoder.ts` (SPEC §13).
 *
 * Node has no WebCodecs, so the engines themselves are exercised by hand in a
 * browser. What is testable here is the arithmetic and the decisions made
 * *before* any encoder object exists: which codec string describes the frames
 * we are about to feed it, what quantizer (or bitrate) a quality setting means,
 * and — since §6 made the codec a user setting — which codec, container, audio
 * codec and engine a given browser plus a given `Settings.codec` add up to. That
 * only works if `encoder.ts` keeps those decisions in exported pure functions
 * instead of inlining them in the engine classes.
 *
 * The surface these tests expect — all pure, none of it touching a global:
 *
 * ```ts
 * export type CodecChoice = "auto" | "h264" | "vp9" | "av1";  // §9 Settings.codec
 * export type VideoCodec = "h264" | "vp9" | "av1";            // what an engine encodes
 * export type Container = "mp4" | "webm";
 * export type AudioCodec = "aac" | "opus";
 * export type EngineKind = "webcodecs" | "mediarecorder";
 *
 * export interface EngineCapabilities {
 *   videoEncoder: boolean;     // typeof VideoEncoder !== "undefined"
 *   audioEncoder: boolean;     // typeof AudioEncoder !== "undefined"
 *   trackProcessor: boolean;   // typeof MediaStreamTrackProcessor !== "undefined"
 *   mediaRecorder: boolean;    // typeof MediaRecorder !== "undefined"
 * }
 * // What isConfigSupported() answered, as plain flags. `h264Hardware` is
 * // H.264 accepted with hardwareAcceleration: "prefer-hardware"; `h264` is
 * // H.264 accepted at all (Chrome's bundled software encoder counts).
 * // `h264Hardware` implies `h264`.
 * export interface CodecSupport {
 *   h264Hardware: boolean; h264: boolean; vp9: boolean; av1: boolean;
 *   aac: boolean;          // AudioEncoder can produce AAC-LC (mp4a.40.2)
 * }
 *
 * export const OPUS_BITRATE: number;            // 48_000, WebCodecs engine (§6)
 * export const FALLBACK_AUDIO_BITRATE: number;  // 64_000, MediaRecorder engine (§6)
 * export const KEYFRAME_INTERVAL_US: number;    // 8_000_000 — a keyframe every 8 s (§6)
 * export const MAX_ENCODE_QUEUE: number;        // backpressure bound, frames in flight (§6)
 * export const HEARTBEAT_IDLE_MS: number;       // still timeline before a frame is repeated (§6)
 * export const HEARTBEAT_INTERVAL_MS: number;   // how often that is checked
 * export function heartbeatDue(input: HeartbeatInput): boolean;
 * export function heartbeatTimestampUs(lastEncodeUs: number, lastEncodeAtMs: number,
 *   nowMs: number): number;
 * export const SILENCE_FRAME_US: number;        // 20_000 — one Opus frame of silence
 * export const SILENCE_LEAD_US: number;         // how far the audio clock leads video
 * export const MAX_SILENCE_CATCHUP_US: number;  // widest jump that clock may take
 * export function silenceCatchUpUs(silenceUs: number, targetUs: number): number;
 * export const FALLBACK_MIME_TYPES: readonly string[];
 *
 * // Rate control. Quantizer mode is the primary path for every codec; the
 * // bitrate table is the §6 fallback for a (hardware) H.264 encoder that
 * // refuses bitrateMode: "quantizer".
 * export const QUANTIZERS: Record<VideoCodec, Record<Quality, number>>;
 * export function quantizerFor(codec: VideoCodec, quality: Quality): number;
 * export const BITRATE_REFERENCE_PIXELS: number;   // 1920 * 1080 — where BITRATES is quoted
 * export const BITRATES: Record<Quality, number>;  // bits/s at that frame size
 * // Linear in pixel count, with a floor so a small shared window still gets
 * // enough bits for legible text. No ceiling below 4K/`sharper`.
 * export function bitrateFor(quality: Quality, width: number, height: number): number;
 *
 * // Codec strings. H.264 is High profile with no constraint flags —
 * // `avc1.6400` + level_idc as two uppercase hex digits (§6).
 * export function avcCodecString(width: number, height: number, frameRate?: number): string;
 * export function vp9CodecString(width: number, height: number, frameRate?: number): string;
 * export function av1CodecString(width: number, height: number, frameRate?: number): string;
 * export function videoCodecString(codec: VideoCodec, width: number, height: number,
 *   frameRate?: number): string;
 *
 * export const AUDIO_CODEC_STRINGS: Record<AudioCodec, string>;  // aac → "mp4a.40.2"
 * export function containerFor(codec: VideoCodec): Container;    // h264 → mp4, else webm
 * export function containerMimeType(container: Container, videoCodecString: string,
 *   audioCodec: AudioCodec | null): string;
 *
 * export function selectEngineKind(caps: EngineCapabilities): EngineKind | null;
 * export function selectVideoCodec(choice: CodecChoice, support: CodecSupport): VideoCodec | null;
 * export function selectAudioCodec(container: Container, aacSupported: boolean): AudioCodec;
 * export function selectFallbackMimeType(isSupported: (type: string) => boolean): string | null;
 *
 * // The whole decision in one place: what will actually be recorded.
 * export interface EncodingRequest {
 *   codec: CodecChoice; caps: EngineCapabilities; support: CodecSupport;
 *   width: number; height: number; frameRate: number; hasAudio: boolean;
 *   fallbackMimeType: string | null;   // selectFallbackMimeType(), injected
 * }
 * export interface EncodingPlan {
 *   engine: EngineKind;
 *   videoCodec: VideoCodec | null;   // null ⇒ the browser's recorder picked
 *   container: Container | null;
 *   audioCodec: AudioCodec | null;   // null ⇒ no audio, or the browser picked
 *   mimeType: string;                // exactly what meta.mimeType will carry (§5)
 *   substituted: boolean;            // the request could not be honoured (§6 UI note)
 * }
 * export function selectEncoding(request: EncodingRequest): EncodingPlan | null;
 *
 * // What a configured video encoder falls back to when it rejects the config
 * // isConfigSupported() approved (§6 rate-control and hardware rungs).
 * export interface VideoSetup {
 *   codec: VideoCodec; hardware: boolean;
 *   rateControl: "quantizer" | "variable"; contentHint: boolean;
 * }
 * export function videoFallbackSetups(setup: VideoSetup): VideoSetup[];
 * ```
 *
 * `createEngine()` itself is not covered: it reads globals and constructs an
 * engine, which is exactly the part Node cannot run.
 */

import { describe, expect, it } from "vitest";
import {
  AUDIO_CODEC_STRINGS,
  avcCodecString,
  BITRATE_REFERENCE_PIXELS,
  BITRATES,
  bitrateFor,
  type CodecChoice,
  type CodecSupport,
  containerFor,
  containerMimeType,
  type EncodingPlan,
  type EngineCapabilities,
  FALLBACK_AUDIO_BITRATE,
  FALLBACK_MIME_TYPES,
  HEARTBEAT_IDLE_MS,
  HEARTBEAT_INTERVAL_MS,
  type HeartbeatInput,
  heartbeatDue,
  heartbeatTimestampUs,
  KEYFRAME_INTERVAL_US,
  MAX_ENCODE_QUEUE,
  MAX_SILENCE_CATCHUP_US,
  OPUS_BITRATE,
  QUANTIZERS,
  quantizerFor,
  selectAudioCodec,
  selectEncoding,
  selectEngineKind,
  selectFallbackMimeType,
  selectVideoCodec,
  SILENCE_FRAME_US,
  SILENCE_LEAD_US,
  silenceCatchUpUs,
  type VideoCodec,
  videoCodecString,
  videoFallbackSetups,
  type VideoSetup,
} from "../src/encoder";
import { DEFAULT_VIDEO_BITS_PER_SECOND, QUALITIES } from "../src/settings";
import type { Quality } from "../src/types";

/** Every codec the WebCodecs engine can produce (SPEC §6). */
const CODECS = ["h264", "vp9", "av1"] as const satisfies readonly VideoCodec[];

/** Every value `Settings.codec` may hold (SPEC §9). */
const CHOICES = ["auto", "h264", "vp9", "av1"] as const satisfies readonly CodecChoice[];

/**
 * H.264 level limits (ITU-T H.264 Annex A, Table A-1), as
 * `[level_idc in hex — the two digits the codec string carries, MaxMBPS
 *   (macroblocks per second), MaxFS (frame size in macroblocks)]`, ascending.
 * level_idc is the level number × 10, so level 4.0 is 40 = `28` and level 5.1
 * is 51 = `33`.
 */
const H264_LEVELS = [
  ["0A", 1_485, 99], //          level 1
  ["0B", 3_000, 396], //         level 1.1
  ["0C", 6_000, 396], //         level 1.2
  ["0D", 11_880, 396], //        level 1.3
  ["14", 11_880, 396], //        level 2
  ["15", 19_800, 792], //        level 2.1
  ["16", 20_250, 1_620], //      level 2.2
  ["1E", 40_500, 1_620], //      level 3
  ["1F", 108_000, 3_600], //     level 3.1
  ["20", 216_000, 5_120], //     level 3.2
  ["28", 245_760, 8_192], //     level 4
  ["29", 245_760, 8_192], //     level 4.1
  ["2A", 522_240, 8_704], //     level 4.2
  ["32", 589_824, 22_080], //    level 5
  ["33", 983_040, 36_864], //    level 5.1
  ["34", 2_073_600, 36_864], //  level 5.2
  ["3C", 4_177_920, 139_264], // level 6
  ["3D", 8_355_840, 139_264], // level 6.1
  ["3E", 16_711_680, 139_264], // level 6.2
] as const satisfies readonly (readonly [string, number, number])[];

/**
 * VP9 level limits, from https://www.webmproject.org/vp9/levels/.
 * `[level code as it appears in the codec string, max luma sample rate,
 *   max luma picture size, max width or height]`, in ascending order.
 */
const VP9_LEVELS = [
  ["10", 829_440, 36_864, 512],
  ["11", 2_764_800, 73_728, 768],
  ["20", 4_608_000, 122_880, 960],
  ["21", 9_216_000, 245_760, 1_344],
  ["30", 20_736_000, 552_960, 2_048],
  ["31", 36_864_000, 983_040, 2_752],
  ["40", 83_558_400, 2_228_224, 4_160],
  ["41", 160_432_128, 2_228_224, 4_160],
  ["50", 311_951_360, 8_912_896, 8_384],
  ["51", 588_251_136, 8_912_896, 8_384],
  ["52", 1_176_502_272, 8_912_896, 8_384],
  ["60", 1_176_502_272, 35_651_584, 16_832],
  ["61", 2_353_004_544, 35_651_584, 16_832],
  ["62", 4_706_009_088, 35_651_584, 16_832],
] as const satisfies readonly (readonly [string, number, number, number])[];

/**
 * AV1 level limits (AV1 spec Annex A). The codec string carries `seq_level_idx`
 * as two digits, not the "4.0" spelling: idx = (major - 2) * 4 + minor, so
 * level 4.0 is `08`. Only the `.0` and `.1` sub-levels are defined.
 * `[seq_level_idx, MaxDisplayRate, MaxPicSize, MaxHSize, MaxVSize]`, ascending.
 */
const AV1_LEVELS = [
  ["00", 4_423_680, 147_456, 2_048, 1_152],
  ["01", 8_363_520, 278_784, 2_816, 1_584],
  ["04", 19_975_680, 665_856, 4_352, 2_448],
  ["05", 31_950_720, 1_065_024, 5_504, 3_096],
  ["08", 70_778_880, 2_359_296, 6_144, 3_456],
  ["09", 141_557_760, 2_359_296, 6_144, 3_456],
  ["12", 267_386_880, 8_912_896, 8_192, 4_352],
  ["13", 534_773_760, 8_912_896, 8_192, 4_352],
] as const satisfies readonly (readonly [string, number, number, number, number])[];

/** Each codec's level ladder, keyed the way its codec string spells the level. */
const LEVEL_TABLES: Record<VideoCodec, readonly (readonly [string, ...number[]])[]> = {
  h264: H264_LEVELS,
  vp9: VP9_LEVELS,
  av1: AV1_LEVELS,
};

/** Macroblocks are 16×16, and a partial one still has to be coded. */
function macroblocks(pixels: number): number {
  return Math.ceil(pixels / 16);
}

/** The smallest H.264 level_idc whose limits cover this frame, per Annex A. */
function smallestH264Level(width: number, height: number, frameRate: number): string {
  const wide = macroblocks(width);
  const tall = macroblocks(height);
  const size = wide * tall;
  const level = H264_LEVELS.find(
    ([, maxMbps, maxFs]) =>
      size <= maxFs &&
      size * frameRate <= maxMbps &&
      // Annex A.3.1: neither dimension may exceed sqrt(MaxFS × 8) macroblocks,
      // which is what stops a level covering an absurdly wide 1-MB-tall frame.
      Math.max(wide, tall) <= Math.sqrt(maxFs * 8),
  );
  if (!level) throw new Error(`no H.264 level covers ${width}x${height}@${frameRate}`);
  return level[0];
}

/** The smallest VP9 level whose limits cover this frame, per the table above. */
function smallestVp9Level(width: number, height: number, frameRate: number): string {
  const pixels = width * height;
  const level = VP9_LEVELS.find(
    ([, maxRate, maxPicture, maxDimension]) =>
      pixels * frameRate <= maxRate &&
      pixels <= maxPicture &&
      Math.max(width, height) <= maxDimension,
  );
  if (!level) throw new Error(`no VP9 level covers ${width}x${height}@${frameRate}`);
  return level[0];
}

/** The smallest AV1 seq_level_idx whose limits cover this frame. */
function smallestAv1Level(width: number, height: number, frameRate: number): string {
  const pixels = width * height;
  const level = AV1_LEVELS.find(
    ([, maxRate, maxPicture, maxH, maxV]) =>
      pixels * frameRate <= maxRate && pixels <= maxPicture && width <= maxH && height <= maxV,
  );
  if (!level) throw new Error(`no AV1 level covers ${width}x${height}@${frameRate}`);
  return level[0];
}

function smallestLevel(codec: VideoCodec, width: number, height: number, frameRate: number): string {
  if (codec === "h264") return smallestH264Level(width, height, frameRate);
  if (codec === "vp9") return smallestVp9Level(width, height, frameRate);
  return smallestAv1Level(width, height, frameRate);
}

/**
 * `avc1.6400XX` → `XX`, uppercased.
 *
 * RFC 6381 spells the three bytes as hex digits without saying which case, and
 * both spellings are in the wild (`avc1.42E01E`, `avc1.42e01e`), so everything
 * that only cares *which level was declared* goes through here. Exactly one
 * test below pins the case VideoShare writes.
 */
function avcLevelHex(codecString: string): string {
  const match = /^avc1\.6400([0-9a-fA-F]{2})$/.exec(codecString);
  if (!match) throw new Error(`not an avc1 High-profile codec string: ${codecString}`);
  return (match[1] as string).toUpperCase();
}

/** The level field of a codec string, spelled the way its level table keys it. */
function levelOf(codec: VideoCodec, codecString: string): string {
  if (codec === "h264") return avcLevelHex(codecString);
  const level = codecString.split(".")[2] as string;
  // `av01.0.08M.08` carries the tier letter in the same field; VP9 does not.
  return codec === "vp9" ? level : level.slice(0, -1);
}

/**
 * Sizes a screen capture actually produces. §6 caps capture at 4K and drops to
 * 20 fps above QHD, so the ladder runs all the way up — a 4K capture is the
 * whole reason the H.264 path exists.
 */
const CAPTURE_SIZES = [
  { label: "a small shared window", width: 640, height: 360, frameRate: 30 },
  { label: "720p", width: 1280, height: 720, frameRate: 30 },
  { label: "a 1440x900 laptop display", width: 1440, height: 900, frameRate: 30 },
  { label: "1080p", width: 1920, height: 1080, frameRate: 30 },
  { label: "1440p (QHD)", width: 2560, height: 1440, frameRate: 30 },
  { label: "4K, the §6 capture cap", width: 3840, height: 2160, frameRate: 30 },
] as const;

/** Grammar from the ISO-BMFF codecs-parameter bindings (RFC 6381 §3.3/§3.4). */
const AVC_CODEC_STRING = /^avc1\.[0-9A-Fa-f]{6}$/;
const VP9_CODEC_STRING = /^vp09\.\d{2}\.\d{2}\.\d{2}$/;
const AV1_CODEC_STRING = /^av01\.[0-2]\.\d{2}[MH]\.\d{2}$/;

/**
 * WebCodecs quantizer ranges — they differ per codec, which is the trap. VP9's
 * registration puts the threshold at 0–63, AV1's uses a 0–255 qindex, and AVC's
 * is H.264's own 0–51 QP.
 */
const QUANTIZER_MAX = { h264: 51, vp9: 63, av1: 255 } as const;

describe("video codec strings", () => {
  it("builds H.264 High-profile strings for real capture sizes", () => {
    const built = CAPTURE_SIZES.map(({ width, height, frameRate }) =>
      avcLevelHex(avcCodecString(width, height, frameRate)),
    );

    // 4K30 is level 5.1 = `avc1.640033`, the string named in SPEC §6.
    expect(built).toEqual(["1E", "1F", "28", "28", "32", "33"]);
  });

  it("names the levels SPEC §6 promises at 1080p, 1440p and 4K", () => {
    // These three carry no hex letters, so they pin the whole string without
    // depending on which case the level digits are written in.
    expect(avcCodecString(1920, 1080, 30)).toBe("avc1.640028"); // level 4.0
    expect(avcCodecString(2560, 1440, 30)).toBe("avc1.640032"); // level 5.0
    expect(avcCodecString(3840, 2160, 30)).toBe("avc1.640033"); // level 5.1
  });

  it("keeps the 4K level honest at the 20 fps §6 applies above QHD", () => {
    // Above QHD the capture is constrained to 20 fps, which lowers MaxMBPS but
    // not MaxFS — 4K still needs level 5.1, because 32400 macroblocks per frame
    // do not fit in level 5.0's 22080 at any frame rate.
    expect(avcCodecString(3840, 2160, 20)).toBe("avc1.640033");
    expect(avcCodecString(2560, 1440, 20)).toBe("avc1.640032");
  });

  it("spells the level in uppercase hex", () => {
    // RFC 6381 does not say, and MediaSource accepts either; VideoShare writes
    // the spelling the platform strings use (`avc1.42E01E`) so meta.mimeType
    // reads the same everywhere. The only place the case is pinned.
    expect(avcCodecString(1280, 720, 30)).toBe("avc1.64001F");
  });

  it("declares H.264 High profile with no constraint flags", () => {
    // `avc1.PPCCLL`: PP = profile_idc, CC = constraint flags, LL = level_idc.
    // High profile is 0x64, and setting a constraint flag we do not honour
    // would be a lie a strict decoder is entitled to act on.
    for (const { label, width, height, frameRate } of CAPTURE_SIZES) {
      const built = avcCodecString(width, height, frameRate);
      expect(built, `avc at ${label}`).toMatch(AVC_CODEC_STRING);
      expect(built.slice(0, 9).toLowerCase(), `profile+constraints at ${label}`).toBe("avc1.6400");
    }
  });

  it("builds VP9 profile-0 8-bit strings for real capture sizes", () => {
    const built = CAPTURE_SIZES.map(({ width, height, frameRate }) =>
      videoCodecString("vp9", width, height, frameRate),
    );

    // 4K30 is `vp09.00.50.08`, the string named in SPEC §5.
    expect(built).toEqual([
      "vp09.00.21.08",
      "vp09.00.31.08",
      "vp09.00.40.08",
      "vp09.00.40.08",
      "vp09.00.50.08",
      "vp09.00.50.08",
    ]);
  });

  it("builds AV1 main-profile main-tier 8-bit strings for the same sizes", () => {
    const built = CAPTURE_SIZES.map(({ width, height, frameRate }) =>
      videoCodecString("av1", width, height, frameRate),
    );

    // 1080p30 is `av01.0.08M.08` — level 4.0.
    expect(built).toEqual([
      "av01.0.01M.08",
      "av01.0.05M.08",
      "av01.0.08M.08",
      "av01.0.08M.08",
      "av01.0.12M.08",
      "av01.0.12M.08",
    ]);
  });

  it("matches the codecs-parameter grammar for every codec", () => {
    for (const { label, width, height, frameRate } of CAPTURE_SIZES) {
      expect(videoCodecString("h264", width, height, frameRate), `h264 at ${label}`).toMatch(
        AVC_CODEC_STRING,
      );
      expect(videoCodecString("vp9", width, height, frameRate), `vp9 at ${label}`).toMatch(
        VP9_CODEC_STRING,
      );
      expect(videoCodecString("av1", width, height, frameRate), `av1 at ${label}`).toMatch(
        AV1_CODEC_STRING,
      );
    }
  });

  it("routes videoCodecString to the same string as each codec's own builder", () => {
    // The engine reaches for `videoCodecString(codec, …)`; the per-codec
    // builders are what the tables above are written against.
    for (const { width, height, frameRate } of CAPTURE_SIZES) {
      expect(videoCodecString("h264", width, height, frameRate)).toBe(
        avcCodecString(width, height, frameRate),
      );
    }
  });

  it("declares 8-bit 4:2:0 — profile 0 for VP9 and AV1", () => {
    // We only ever encode 8-bit screen content, and VP9 profile 0 / AV1 Main
    // are the profiles every WebM decoder in the support matrix implements.
    for (const { width, height, frameRate } of CAPTURE_SIZES) {
      const vp9 = videoCodecString("vp9", width, height, frameRate).split(".");
      expect([vp9[0], vp9[1], vp9[3]]).toEqual(["vp09", "00", "08"]);

      const av1 = videoCodecString("av1", width, height, frameRate).split(".");
      expect([av1[0], av1[1], av1[3]]).toEqual(["av01", "0", "08"]);
      expect(av1[2]?.endsWith("M"), "main tier").toBe(true);
    }
  });

  it("declares the smallest level that actually covers the frame", () => {
    // Understating the level lies to the decoder; overstating it can make a
    // conservative player refuse a stream it could have played.
    for (const { label, width, height, frameRate } of CAPTURE_SIZES) {
      for (const codec of CODECS) {
        expect(
          levelOf(codec, videoCodecString(codec, width, height, frameRate)),
          `${codec} at ${label}`,
        ).toBe(smallestLevel(codec, width, height, frameRate));
      }
    }
  });

  it("keeps the level sufficient across a sweep of odd window sizes", () => {
    // Shared windows are whatever the user dragged them to, so the level has to
    // come out of the numbers rather than a lookup of the usual suspects.
    // Sufficiency, not minimality: rounding up to a level a table happens to
    // skip is legal, understating one is not.
    const sizes = [
      [320, 180],
      [854, 480],
      [1024, 768],
      [1366, 768],
      [1512, 982],
      [1600, 1200],
      [1920, 1200],
      [2048, 1080],
      [3440, 1440],
      [3024, 1964],
    ] as const;

    for (const [width, height] of sizes) {
      for (const codec of CODECS) {
        const table = LEVEL_TABLES[codec];
        const declared = levelOf(codec, videoCodecString(codec, width, height, 30));
        const needed = smallestLevel(codec, width, height, 30);

        expect(
          table.findIndex(([code]) => code === declared),
          `${width}x${height} ${codec} declares a known level`,
        ).toBeGreaterThanOrEqual(table.findIndex(([code]) => code === needed));
      }
    }
  });

  it("never lowers the level as the frame grows", () => {
    const ladder = [
      [640, 360],
      [1280, 720],
      [1920, 1080],
      [2560, 1440],
      [3840, 2160],
    ] as const;

    for (const codec of CODECS) {
      const table = LEVEL_TABLES[codec];
      const indices = ladder.map(([width, height]) =>
        table.findIndex(([code]) => code === levelOf(codec, videoCodecString(codec, width, height, 30))),
      );

      expect(indices, `${codec} levels are all known`).not.toContain(-1);
      for (let i = 1; i < indices.length; i++) {
        expect(indices[i], `${codec} level at ${ladder[i]?.join("x")}`).toBeGreaterThanOrEqual(
          indices[i - 1] as number,
        );
      }
    }
  });

  it("raises the level for a higher frame rate at the same size", () => {
    // VideoShare caps capture at 30 fps, so this is the helper being correct
    // rather than a path we take: 1080p60 needs H.264 level 4.2 and VP9 4.1.
    expect(avcCodecString(1920, 1080, 30)).toBe("avc1.640028");
    expect(avcLevelHex(avcCodecString(1920, 1080, 60))).toBe("2A");
    expect(videoCodecString("vp9", 1920, 1080, 30)).toBe("vp09.00.40.08");
    expect(videoCodecString("vp9", 1920, 1080, 60)).toBe("vp09.00.41.08");
    expect(videoCodecString("av1", 1920, 1080, 30)).toBe("av01.0.08M.08");
    expect(videoCodecString("av1", 1920, 1080, 60)).toBe("av01.0.09M.08");
  });
});

describe("containers and mime types", () => {
  it("puts H.264 in MP4 and everything else in WebM", () => {
    // SPEC §6: H.264 is muxed as fragmented MP4 (mp4-muxer); VP9 and AV1 keep
    // the WebM path (webm-muxer). WebM cannot carry H.264 at all.
    expect(containerFor("h264")).toBe("mp4");
    expect(containerFor("vp9")).toBe("webm");
    expect(containerFor("av1")).toBe("webm");
  });

  it("names AAC by its ISO-BMFF object type, and Opus by its own name", () => {
    expect(AUDIO_CODEC_STRINGS.aac).toBe("mp4a.40.2");
    expect(AUDIO_CODEC_STRINGS.opus).toBe("opus");
  });

  it("builds the exact strings SPEC §5 and §6 name", () => {
    // meta.mimeType is this string verbatim, and SPEC §8 feeds it straight to
    // MediaSource.isTypeSupported.
    expect(containerMimeType("mp4", avcCodecString(3840, 2160, 30), "aac")).toBe(
      "video/mp4;codecs=avc1.640033,mp4a.40.2",
    );
    expect(containerMimeType("webm", videoCodecString("vp9", 3840, 2160, 30), "opus")).toBe(
      "video/webm;codecs=vp09.00.50.08,opus",
    );
    expect(containerMimeType("webm", videoCodecString("av1", 1920, 1080, 30), "opus")).toBe(
      "video/webm;codecs=av01.0.08M.08,opus",
    );
  });

  it("carries Opus in MP4 where AAC is unavailable", () => {
    // SPEC §6's fallback: Chrome on desktop Linux has no AAC encoder, and an
    // MP4 with an Opus track still plays through MSE in Chrome and Firefox.
    expect(containerMimeType("mp4", avcCodecString(1920, 1080, 30), "opus")).toBe(
      "video/mp4;codecs=avc1.640028,opus",
    );
  });

  it("omits the audio codec entirely when there is no audio track", () => {
    // A display capture the user shared without audio and with the mic off:
    // claiming a track that is not in the file makes MSE reject the buffer.
    expect(containerMimeType("mp4", avcCodecString(1920, 1080, 30), null)).toBe(
      "video/mp4;codecs=avc1.640028",
    );
    expect(containerMimeType("webm", videoCodecString("vp9", 1920, 1080, 30), null)).toBe(
      "video/webm;codecs=vp09.00.40.08",
    );
  });

  it("never emits quoting or whitespace MediaSource has to unpick", () => {
    for (const codec of CODECS) {
      const container = containerFor(codec);
      for (const audio of ["aac", "opus", null] as const) {
        // AAC only ever rides in MP4; skip the combination that cannot occur.
        if (audio === "aac" && container !== "mp4") continue;
        const mimeType = containerMimeType(
          container,
          videoCodecString(codec, 1280, 720, 30),
          audio,
        );

        expect(mimeType.startsWith(`video/${container};codecs=`), mimeType).toBe(true);
        expect(mimeType).not.toContain('"');
        expect(mimeType).not.toContain(" ");
      }
    }
  });
});

describe("audio codec selection", () => {
  it("uses AAC in MP4 when the browser can encode it", () => {
    expect(selectAudioCodec("mp4", true)).toBe("aac");
  });

  it("falls back to Opus-in-MP4 where there is no AAC encoder", () => {
    // AAC encoding is missing in Firefox everywhere and in every browser on
    // desktop Linux, so this is a real machine, not a hypothetical one.
    expect(selectAudioCodec("mp4", false)).toBe("opus");
  });

  it("always uses Opus in WebM, AAC encoder or not", () => {
    // WebM's codec list does not include AAC; Matroska's does, WebM's does not.
    expect(selectAudioCodec("webm", true)).toBe("opus");
    expect(selectAudioCodec("webm", false)).toBe("opus");
  });
});

describe("quality → quantizer table", () => {
  it("covers every codec and every quality, and nothing else", () => {
    expect(Object.keys(QUANTIZERS).sort()).toEqual([...CODECS].sort());
    for (const codec of CODECS) {
      expect(Object.keys(QUANTIZERS[codec]).sort(), codec).toEqual([...QUALITIES].sort());
    }
  });

  it("stays inside each codec's WebCodecs quantizer range", () => {
    // The ranges are not the same: the WebCodecs registrations put VP9 at
    // 0-63 (quantizer threshold), AV1 at 0-255 (quantizer index) and AVC at
    // 0-51 (H.264 QP).
    for (const codec of CODECS) {
      for (const quality of QUALITIES) {
        const q = QUANTIZERS[codec][quality];
        expect(Number.isInteger(q), `${codec}/${quality} is an integer`).toBe(true);
        expect(q, `${codec}/${quality} above the floor`).toBeGreaterThan(0);
        expect(q, `${codec}/${quality} within ${QUANTIZER_MAX[codec]}`).toBeLessThanOrEqual(
          QUANTIZER_MAX[codec],
        );
      }
    }
  });

  it("uses AV1's 0-255 index space rather than VP9's 0-63", () => {
    // Reusing VP9-sized numbers for AV1 would silently ask for near-lossless
    // output and blow the file size up, which is the whole point of the setting.
    expect(QUANTIZERS.av1.smaller).toBeGreaterThan(QUANTIZER_MAX.vp9);
  });

  it("keeps H.264 clear of its own scale's degenerate ends", () => {
    // Reusing a VP9 number here is the mirror of the AV1 trap: QP 63 does not
    // exist in H.264 and QP 51 is the blocky worst case, while QP 0 is lossless
    // and would defeat the compression this whole engine is for.
    expect(QUANTIZERS.h264.smaller).toBeLessThan(QUANTIZER_MAX.h264);
    expect(QUANTIZERS.h264.sharper).toBeGreaterThan(0);
  });

  it("asks all three codecs for comparable quality at the same setting", () => {
    // Each codec's quantizer means something different, so the only way to
    // compare them is as a fraction of the codec's own range. Switching codec
    // must change the file size and the CPU cost, not what the recording looks
    // like — a user who flips to H.264 for smooth 4K should not also silently
    // get a different picture.
    for (const quality of QUALITIES) {
      const normalized = CODECS.map((codec) => quantizerFor(codec, quality) / QUANTIZER_MAX[codec]);
      expect(Math.max(...normalized) - Math.min(...normalized), quality).toBeLessThan(0.15);
    }
  });

  it("lowers the quantizer as the quality setting rises", () => {
    // Lower quantizer = finer quality = bigger file, for every codec.
    for (const codec of CODECS) {
      const { smaller, standard, sharper } = QUANTIZERS[codec];
      expect(smaller, `${codec}: smaller is coarser than standard`).toBeGreaterThan(standard);
      expect(standard, `${codec}: standard is coarser than sharper`).toBeGreaterThan(sharper);
    }
  });

  it("is what quantizerFor returns", () => {
    for (const codec of CODECS) {
      for (const quality of QUALITIES) {
        expect(quantizerFor(codec, quality), `${codec}/${quality}`).toBe(
          QUANTIZERS[codec][quality],
        );
      }
    }
  });

  it("has a default that sits between the two extremes", () => {
    // "standard" is the setting nobody changes, so it carries the SPEC §6
    // "visually clean text" promise on its own.
    const standard: Quality = "standard";
    expect(QUALITIES).toContain(standard);
    for (const codec of CODECS) {
      const values = QUALITIES.map((q) => quantizerFor(codec, q));
      expect(Math.max(...values), codec).toBe(quantizerFor(codec, "smaller"));
      expect(Math.min(...values), codec).toBe(quantizerFor(codec, "sharper"));
    }
  });
});

/**
 * SPEC §6's other rate-control path: a hardware H.264 encoder that refuses
 * `bitrateMode: "quantizer"` gets `"variable"` and a bitrate instead. Per-frame
 * QP is a young WebCodecs feature and platform encoders vary, so this table is
 * the one that keeps a 4K recording legible when the fast path is unavailable.
 */
describe("quality → bitrate table (the H.264 variable-bitrate fallback)", () => {
  const pixelsOf = ({ width, height }: { width: number; height: number }) => width * height;

  it("covers every quality and nothing else", () => {
    expect(Object.keys(BITRATES).sort()).toEqual([...QUALITIES].sort());
  });

  it("is quoted at 1080p, the size the numbers are legible at", () => {
    expect(BITRATE_REFERENCE_PIXELS).toBe(1920 * 1080);
    for (const quality of QUALITIES) {
      expect(bitrateFor(quality, 1920, 1080), quality).toBe(BITRATES[quality]);
    }
  });

  it("raises the bitrate as the quality setting rises", () => {
    // The opposite direction from the quantizer table, and easy to get backwards.
    expect(BITRATES.smaller).toBeLessThan(BITRATES.standard);
    expect(BITRATES.standard).toBeLessThan(BITRATES.sharper);
  });

  it("scales linearly with pixel count above the reference frame", () => {
    // SPEC §6: "a quality→bitrate table scaled by pixel count". A 4K frame is
    // four times the pixels of 1080p and needs the bits to match, or the whole
    // reason to record at 4K is thrown away in the encoder.
    for (const quality of QUALITIES) {
      for (const size of [
        { width: 2560, height: 1440 },
        { width: 3440, height: 1440 },
        { width: 3840, height: 2160 },
      ]) {
        const expected = Math.round(
          (BITRATES[quality] * pixelsOf(size)) / BITRATE_REFERENCE_PIXELS,
        );
        expect(
          bitrateFor(quality, size.width, size.height),
          `${quality} at ${size.width}x${size.height}`,
        ).toBe(expected);
      }
    }
    expect(bitrateFor("standard", 3840, 2160)).toBe(4 * BITRATES.standard);
  });

  it("keeps a floor under small windows rather than scaling to nothing", () => {
    // Linear scaling alone would give a 640x360 shared terminal an eighth of
    // the 1080p bitrate. Screen text does not cost proportionally fewer bits
    // than a photo does — the glyphs are the same size in pixels.
    expect(bitrateFor("standard", 640, 360)).toBeGreaterThanOrEqual(400_000);
    expect(bitrateFor("smaller", 320, 180)).toBeGreaterThanOrEqual(250_000);
  });

  it("never falls as the frame grows, at any quality", () => {
    for (const quality of QUALITIES) {
      const ladder = [...CAPTURE_SIZES]
        .sort((a, b) => pixelsOf(a) - pixelsOf(b))
        .map((size) => bitrateFor(quality, size.width, size.height));

      for (let i = 1; i < ladder.length; i++) {
        expect(ladder[i], `${quality} step ${i}`).toBeGreaterThanOrEqual(ladder[i - 1] as number);
      }
    }
  });

  it("returns whole bits per second, and nothing absurd at 4K", () => {
    // `VideoEncoderConfig.bitrate` is an unsigned long long; a fraction is a
    // TypeError waiting to happen, and a 100 Mbps screen recording is a bug.
    for (const quality of QUALITIES) {
      for (const { width, height } of CAPTURE_SIZES) {
        const bitrate = bitrateFor(quality, width, height);
        expect(Number.isInteger(bitrate), `${quality} ${width}x${height}`).toBe(true);
        expect(bitrate, `${quality} ${width}x${height}`).toBeGreaterThan(0);
        expect(bitrate, `${quality} ${width}x${height}`).toBeLessThan(100_000_000);
      }
    }
  });
});

describe("engine selection", () => {
  const NOTHING = {
    videoEncoder: false,
    audioEncoder: false,
    trackProcessor: false,
    mediaRecorder: false,
  };

  it("picks WebCodecs when the whole pipeline is present", () => {
    // Chrome / Edge.
    expect(
      selectEngineKind({
        videoEncoder: true,
        audioEncoder: true,
        trackProcessor: true,
        mediaRecorder: true,
      }),
    ).toBe("webcodecs");
  });

  it("falls back when any one piece of the pipeline is missing", () => {
    const complete = { ...NOTHING, videoEncoder: true, audioEncoder: true, trackProcessor: true };

    for (const missing of ["videoEncoder", "audioEncoder", "trackProcessor"] as const) {
      expect(
        selectEngineKind({ ...complete, [missing]: false, mediaRecorder: true }),
        `without ${missing}`,
      ).toBe("mediarecorder");
    }
  });

  it("falls back for a Firefox-shaped browser: encoders but no track processor", () => {
    expect(
      selectEngineKind({
        videoEncoder: true,
        audioEncoder: true,
        trackProcessor: false,
        mediaRecorder: true,
      }),
    ).toBe("mediarecorder");
  });

  it("falls back for a browser with MediaRecorder and nothing else", () => {
    expect(selectEngineKind({ ...NOTHING, mediaRecorder: true })).toBe("mediarecorder");
  });

  it("reports no engine at all rather than pretending", () => {
    // Nothing to record with; the recorder page has to say so instead of
    // failing somewhere inside a constructor.
    expect(selectEngineKind(NOTHING)).toBeNull();
    expect(selectEngineKind({ ...NOTHING, videoEncoder: true, audioEncoder: true })).toBeNull();
  });
});

/**
 * `Settings.codec` (SPEC §9) against what a browser can actually encode
 * (SPEC §6). The rule, stated once:
 *
 * - `"auto"` takes hardware H.264 if it is there, else VP9. Software H.264 is
 *   *not* preferred over VP9 — it is CPU-bound like VP9 and produces bigger
 *   files, so it wins nothing.
 * - An explicit choice is tried first, hardware or software, and if it cannot
 *   be encoded it falls down the `"auto"` chain and then onto whatever is left.
 */
describe("codec choice", () => {
  const ALL: CodecSupport = {
    h264Hardware: true,
    h264: true,
    vp9: true,
    av1: true,
    aac: true,
  };
  const NONE: CodecSupport = {
    h264Hardware: false,
    h264: false,
    vp9: false,
    av1: false,
    aac: false,
  };

  it("prefers hardware H.264 on auto — the reason §6 changed at all", () => {
    // Software VP9 drops frames at native Retina resolution; a hardware H.264
    // encoder does 4K without touching the CPU budget.
    expect(selectVideoCodec("auto", ALL)).toBe("h264");
  });

  it("stays on VP9 on auto when H.264 would only run in software", () => {
    // Chrome ships a software H.264 encoder (openh264). Choosing it here would
    // trade VP9's smaller files for nothing at all: both are CPU-bound.
    expect(selectVideoCodec("auto", { ...ALL, h264Hardware: false })).toBe("vp9");
  });

  it("honours an explicit codec even where auto would not have chosen it", () => {
    expect(selectVideoCodec("h264", ALL)).toBe("h264");
    expect(selectVideoCodec("vp9", ALL)).toBe("vp9");
    expect(selectVideoCodec("av1", ALL)).toBe("av1");
  });

  it("accepts software H.264 when H.264 is what the user asked for", () => {
    // "prefer-hardware" falling back to no-preference (§6): the user asked for
    // a file that plays everywhere, and software H.264 still produces one.
    expect(selectVideoCodec("h264", { ...ALL, h264Hardware: false })).toBe("h264");
  });

  it("falls down the auto chain when the chosen codec cannot be encoded", () => {
    // Every one of these is a real browser: no H.264 encoder, no AV1 encoder,
    // an encoder that answered `supported: false` for the config we need.
    expect(selectVideoCodec("h264", { ...ALL, h264: false, h264Hardware: false })).toBe("vp9");
    expect(selectVideoCodec("av1", { ...ALL, av1: false })).toBe("h264");
    expect(selectVideoCodec("av1", { ...ALL, av1: false, h264Hardware: false })).toBe("vp9");
    expect(selectVideoCodec("vp9", { ...ALL, vp9: false })).toBe("h264");
  });

  it("takes the last codec standing rather than giving up early", () => {
    expect(selectVideoCodec("h264", { ...NONE, av1: true })).toBe("av1");
    expect(selectVideoCodec("auto", { ...NONE, av1: true })).toBe("av1");
    expect(selectVideoCodec("vp9", { ...NONE, h264: true })).toBe("h264");
  });

  it("reports no codec at all when WebCodecs can encode none of them", () => {
    // Not a failure — the caller drops to the MediaRecorder engine (§6.2).
    for (const choice of CHOICES) {
      expect(selectVideoCodec(choice, NONE), choice).toBeNull();
    }
  });

  it("treats hardware H.264 as implying H.264", () => {
    // The two flags come from two isConfigSupported() calls, and a browser that
    // accepts "prefer-hardware" but not the plain config is not a thing. Belt
    // and braces so a malformed capability probe cannot lose the codec.
    expect(selectVideoCodec("auto", { ...NONE, h264Hardware: true })).toBe("h264");
  });
});

/**
 * The whole §6 decision as one table: every `Settings.codec` value against
 * every capability shape a real browser presents, asserting exactly what
 * `meta.mimeType` will say (§5) and therefore what the player will feed MSE
 * (§8). This is the test that has to fail if the fallback chain moves.
 */
describe("the encoding selection matrix", () => {
  const WEBCODECS: EngineCapabilities = {
    videoEncoder: true,
    audioEncoder: true,
    trackProcessor: true,
    mediaRecorder: true,
  };
  /** Firefox: MediaRecorder only, as far as this engine is concerned. */
  const NO_WEBCODECS: EngineCapabilities = {
    videoEncoder: false,
    audioEncoder: false,
    trackProcessor: false,
    mediaRecorder: true,
  };

  const SUPPORT = {
    /** Chrome on a Mac or a Windows laptop: hardware H.264, AAC, the lot. */
    hardwareH264: { h264Hardware: true, h264: true, vp9: true, av1: true, aac: true },
    /** Chrome on desktop Linux: openh264 in software, and no AAC encoder. */
    softwareH264: { h264Hardware: false, h264: true, vp9: true, av1: true, aac: false },
    /** A build with no H.264 encoder at all (some Chromium distributions). */
    noH264: { h264Hardware: false, h264: false, vp9: true, av1: true, aac: true },
    /** Hardware H.264, no AAC encoder: the Opus-in-MP4 path, and no AV1. */
    noAac: { h264Hardware: true, h264: true, vp9: true, av1: false, aac: false },
    /** An older Chrome: VP9 and nothing else. */
    vp9Only: { h264Hardware: false, h264: false, vp9: true, av1: false, aac: false },
    /** WebCodecs is present but every config probe said no. */
    none: { h264Hardware: false, h264: false, vp9: false, av1: false, aac: false },
  } as const satisfies Record<string, CodecSupport>;

  type Profile = keyof typeof SUPPORT;

  /** What §6.2's candidate list yields on a browser that supports all of it. */
  const FALLBACK = "video/webm;codecs=vp9,opus";

  const H264_MP4_AAC = "video/mp4;codecs=avc1.640028,mp4a.40.2";
  const H264_MP4_OPUS = "video/mp4;codecs=avc1.640028,opus";
  const VP9_WEBM = "video/webm;codecs=vp09.00.40.08,opus";
  const AV1_WEBM = "video/webm;codecs=av01.0.08M.08,opus";

  /** 1080p30 with audio, so the codec strings above are the expected ones. */
  const plan = (codec: CodecChoice, profile: Profile, caps = WEBCODECS): EncodingPlan | null =>
    selectEncoding({
      codec,
      caps,
      support: SUPPORT[profile],
      width: 1920,
      height: 1080,
      frameRate: 30,
      hasAudio: true,
      fallbackMimeType: FALLBACK,
    });

  interface Row {
    choice: CodecChoice;
    profile: Profile;
    videoCodec: VideoCodec | null;
    container: "mp4" | "webm" | null;
    audioCodec: "aac" | "opus" | null;
    mimeType: string;
    substituted: boolean;
  }

  const MATRIX: readonly Row[] = [
    // "auto" — hardware H.264 first, then VP9. Never a substitution: auto
    // promised nothing, so there is nothing for the UI to apologise for.
    { choice: "auto", profile: "hardwareH264", videoCodec: "h264", container: "mp4", audioCodec: "aac", mimeType: H264_MP4_AAC, substituted: false },
    { choice: "auto", profile: "softwareH264", videoCodec: "vp9", container: "webm", audioCodec: "opus", mimeType: VP9_WEBM, substituted: false },
    { choice: "auto", profile: "noH264", videoCodec: "vp9", container: "webm", audioCodec: "opus", mimeType: VP9_WEBM, substituted: false },
    { choice: "auto", profile: "noAac", videoCodec: "h264", container: "mp4", audioCodec: "opus", mimeType: H264_MP4_OPUS, substituted: false },
    { choice: "auto", profile: "vp9Only", videoCodec: "vp9", container: "webm", audioCodec: "opus", mimeType: VP9_WEBM, substituted: false },
    { choice: "auto", profile: "none", videoCodec: null, container: "webm", audioCodec: null, mimeType: FALLBACK, substituted: false },

    // "h264" — taken in software too, and the audio codec is whatever the
    // machine can encode.
    { choice: "h264", profile: "hardwareH264", videoCodec: "h264", container: "mp4", audioCodec: "aac", mimeType: H264_MP4_AAC, substituted: false },
    { choice: "h264", profile: "softwareH264", videoCodec: "h264", container: "mp4", audioCodec: "opus", mimeType: H264_MP4_OPUS, substituted: false },
    { choice: "h264", profile: "noH264", videoCodec: "vp9", container: "webm", audioCodec: "opus", mimeType: VP9_WEBM, substituted: true },
    { choice: "h264", profile: "noAac", videoCodec: "h264", container: "mp4", audioCodec: "opus", mimeType: H264_MP4_OPUS, substituted: false },
    { choice: "h264", profile: "vp9Only", videoCodec: "vp9", container: "webm", audioCodec: "opus", mimeType: VP9_WEBM, substituted: true },
    { choice: "h264", profile: "none", videoCodec: null, container: "webm", audioCodec: null, mimeType: FALLBACK, substituted: true },

    // "vp9" — the pre-§6 behaviour, unchanged wherever VP9 encodes.
    { choice: "vp9", profile: "hardwareH264", videoCodec: "vp9", container: "webm", audioCodec: "opus", mimeType: VP9_WEBM, substituted: false },
    { choice: "vp9", profile: "softwareH264", videoCodec: "vp9", container: "webm", audioCodec: "opus", mimeType: VP9_WEBM, substituted: false },
    { choice: "vp9", profile: "noH264", videoCodec: "vp9", container: "webm", audioCodec: "opus", mimeType: VP9_WEBM, substituted: false },
    { choice: "vp9", profile: "noAac", videoCodec: "vp9", container: "webm", audioCodec: "opus", mimeType: VP9_WEBM, substituted: false },
    { choice: "vp9", profile: "vp9Only", videoCodec: "vp9", container: "webm", audioCodec: "opus", mimeType: VP9_WEBM, substituted: false },
    { choice: "vp9", profile: "none", videoCodec: null, container: "webm", audioCodec: null, mimeType: FALLBACK, substituted: true },

    // "av1" — and where it cannot be encoded, down the auto chain.
    { choice: "av1", profile: "hardwareH264", videoCodec: "av1", container: "webm", audioCodec: "opus", mimeType: AV1_WEBM, substituted: false },
    { choice: "av1", profile: "softwareH264", videoCodec: "av1", container: "webm", audioCodec: "opus", mimeType: AV1_WEBM, substituted: false },
    { choice: "av1", profile: "noH264", videoCodec: "av1", container: "webm", audioCodec: "opus", mimeType: AV1_WEBM, substituted: false },
    { choice: "av1", profile: "noAac", videoCodec: "h264", container: "mp4", audioCodec: "opus", mimeType: H264_MP4_OPUS, substituted: true },
    { choice: "av1", profile: "vp9Only", videoCodec: "vp9", container: "webm", audioCodec: "opus", mimeType: VP9_WEBM, substituted: true },
    { choice: "av1", profile: "none", videoCodec: null, container: "webm", audioCodec: null, mimeType: FALLBACK, substituted: true },
  ];

  it("covers every codec choice against every capability profile", () => {
    // The matrix is only worth what it covers, and a row quietly dropped in a
    // merge is invisible otherwise.
    const seen = MATRIX.map((row) => `${row.choice}/${row.profile}`);
    const expected = CHOICES.flatMap((choice) =>
      (Object.keys(SUPPORT) as Profile[]).map((profile) => `${choice}/${profile}`),
    );

    expect(seen.slice().sort()).toEqual(expected.slice().sort());
    expect(new Set(seen).size, "no duplicated rows").toBe(seen.length);
  });

  for (const row of MATRIX) {
    it(`records ${row.choice} on ${row.profile} as ${row.mimeType}`, () => {
      expect(plan(row.choice, row.profile)).toEqual({
        engine: row.videoCodec ? "webcodecs" : "mediarecorder",
        videoCodec: row.videoCodec,
        container: row.container,
        audioCodec: row.audioCodec,
        mimeType: row.mimeType,
        substituted: row.substituted,
      } satisfies EncodingPlan);
    });
  }

  it("hands every browser without WebCodecs to MediaRecorder, whatever was asked", () => {
    // Firefox: `Settings.codec` cannot be honoured at all, because the fallback
    // engine's format is the browser's to choose (§6.2).
    for (const choice of CHOICES) {
      expect(plan(choice, "hardwareH264", NO_WEBCODECS), choice).toEqual({
        engine: "mediarecorder",
        videoCodec: null,
        container: "webm",
        audioCodec: null,
        mimeType: FALLBACK,
        // "auto" asked for nothing in particular, so nothing was substituted.
        substituted: choice !== "auto",
      } satisfies EncodingPlan);
    }
  });

  it("reports the fallback engine's own mime type, not a guess at it", () => {
    // meta.mimeType has to be the string the recorder really produced (§6), and
    // a browser that only does VP8 must not be described as producing VP9.
    const vp8 = selectEncoding({
      codec: "auto",
      caps: NO_WEBCODECS,
      support: SUPPORT.none,
      width: 1920,
      height: 1080,
      frameRate: 30,
      hasAudio: true,
      fallbackMimeType: "video/webm;codecs=vp8,opus",
    });

    expect(vp8?.mimeType).toBe("video/webm;codecs=vp8,opus");
    expect(vp8?.engine).toBe("mediarecorder");
  });

  it("reports no plan at all where nothing can record", () => {
    // Safari: no WebCodecs, and a MediaRecorder that never produces WebM, so
    // selectFallbackMimeType() came back null. The page has to say so.
    expect(
      selectEncoding({
        codec: "auto",
        caps: NO_WEBCODECS,
        support: SUPPORT.none,
        width: 1920,
        height: 1080,
        frameRate: 30,
        hasAudio: true,
        fallbackMimeType: null,
      }),
    ).toBeNull();

    expect(
      selectEncoding({
        codec: "auto",
        caps: { videoEncoder: false, audioEncoder: false, trackProcessor: false, mediaRecorder: false },
        support: SUPPORT.hardwareH264,
        width: 1920,
        height: 1080,
        frameRate: 30,
        hasAudio: true,
        fallbackMimeType: null,
      }),
    ).toBeNull();
  });

  it("drops the audio codec from the type when the capture has no audio", () => {
    // Display capture with no system audio and the mic toggled off. Both
    // containers have to stop claiming an audio track, or MSE rejects the
    // first buffer the player appends.
    for (const [profile, mimeType] of [
      ["hardwareH264", "video/mp4;codecs=avc1.640028"],
      ["vp9Only", "video/webm;codecs=vp09.00.40.08"],
    ] as const) {
      const silent = selectEncoding({
        codec: "auto",
        caps: WEBCODECS,
        support: SUPPORT[profile],
        width: 1920,
        height: 1080,
        frameRate: 30,
        hasAudio: false,
        fallbackMimeType: FALLBACK,
      });

      expect(silent?.audioCodec, profile).toBeNull();
      expect(silent?.mimeType, profile).toBe(mimeType);
    }
  });

  it("carries the real capture size into the level, at 4K as at 1080p", () => {
    // The plan's mime type is meta.mimeType verbatim, so the level digits in it
    // are the ones the player hands to MediaSource.isTypeSupported (§8).
    const uhd = selectEncoding({
      codec: "h264",
      caps: WEBCODECS,
      support: SUPPORT.hardwareH264,
      width: 3840,
      height: 2160,
      // §6 constrains capture above QHD to 20 fps.
      frameRate: 20,
      hasAudio: true,
      fallbackMimeType: FALLBACK,
    });

    expect(uhd?.mimeType).toBe("video/mp4;codecs=avc1.640033,mp4a.40.2");
    expect(uhd?.container).toBe("mp4");
  });

  it("keeps the plan's mime type consistent with its own parts", () => {
    // The four fields are what the recorder page reports and what the muxer is
    // configured from; a mime type that disagreed with them would put one
    // string in meta.json and different bytes in the file.
    for (const choice of CHOICES) {
      for (const profile of Object.keys(SUPPORT) as Profile[]) {
        const built = plan(choice, profile);
        if (!built?.videoCodec || !built.container) continue;

        expect(built.container, `${choice}/${profile}`).toBe(containerFor(built.videoCodec));
        expect(built.mimeType, `${choice}/${profile}`).toBe(
          containerMimeType(
            built.container,
            videoCodecString(built.videoCodec, 1920, 1080, 30),
            built.audioCodec,
          ),
        );
      }
    }
  });

  it("only ever reports AAC inside MP4", () => {
    for (const choice of CHOICES) {
      for (const profile of Object.keys(SUPPORT) as Profile[]) {
        const built = plan(choice, profile);
        if (built?.audioCodec !== "aac") continue;
        expect(built.container, `${choice}/${profile}`).toBe("mp4");
        expect(SUPPORT[profile].aac, `${choice}/${profile} probed AAC`).toBe(true);
      }
    }
  });

  it("flags a substitution exactly when the requested codec was not used", () => {
    // What §6's "the UI shows a note naming what was used" hangs off.
    for (const choice of CHOICES) {
      for (const profile of Object.keys(SUPPORT) as Profile[]) {
        const built = plan(choice, profile);
        const honoured = choice === "auto" || built?.videoCodec === choice;
        expect(built?.substituted, `${choice}/${profile}`).toBe(!honoured);
      }
    }
  });
});

describe("MediaRecorder fallback mime types", () => {
  const supports =
    (...supported: string[]) =>
    (type: string) =>
      supported.includes(type);

  it("is the SPEC §6 candidate list, best first", () => {
    expect([...FALLBACK_MIME_TYPES]).toEqual([
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
    ]);
  });

  it("takes the first candidate the browser admits to", () => {
    expect(selectFallbackMimeType(() => true)).toBe("video/webm;codecs=vp9,opus");
    expect(selectFallbackMimeType(supports("video/webm;codecs=vp8,opus", "video/webm"))).toBe(
      "video/webm;codecs=vp8,opus",
    );
    expect(selectFallbackMimeType(supports("video/webm"))).toBe("video/webm");
  });

  it("returns null where no WebM flavour is supported", () => {
    // Safari's MediaRecorder: it records, just never WebM. The fallback engine
    // has no MP4 path — mp4-muxer is the WebCodecs engine's, and Safari has no
    // MediaStreamTrackProcessor to feed it.
    expect(selectFallbackMimeType(supports("video/mp4;codecs=avc1.42E01E"))).toBeNull();
    expect(selectFallbackMimeType(() => false)).toBeNull();
  });

  it("asks about candidates in order and stops at the match", () => {
    const asked: string[] = [];
    const chosen = selectFallbackMimeType((type) => {
      asked.push(type);
      return type === "video/webm;codecs=vp8,opus";
    });

    expect(chosen).toBe("video/webm;codecs=vp8,opus");
    expect(asked).toEqual(["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus"]);
  });
});

/**
 * The heartbeat (SPEC §6). Screen capture is VFR and the backpressure valve
 * drops delta frames under load, so the video timeline can stand still while
 * the audio track runs on. In a file that is invisible; through MSE it splits
 * the buffered ranges and strands the player at the near edge (§8). The engine
 * answers by re-encoding a retained clone of the last frame — near-free in
 * quantizer mode — and this is the decision it makes on every tick.
 */
describe("heartbeat", () => {
  /** A still timeline, an idle encoder, a frame in hand: the case that fires. */
  const DUE: HeartbeatInput = {
    nowMs: 60_000,
    lastEncodeAtMs: 60_000 - HEARTBEAT_IDLE_MS - 1,
    queueSize: 0,
    hasFrame: true,
    recording: true,
  };

  const after = (stillMs: number): HeartbeatInput => ({
    ...DUE,
    lastEncodeAtMs: DUE.nowMs - stillMs,
  });

  it("fires once the timeline has stood still for more than a second", () => {
    expect(heartbeatDue(DUE)).toBe(true);
    expect(heartbeatDue(after(HEARTBEAT_IDLE_MS + 1))).toBe(true);
    expect(heartbeatDue(after(5_000))).toBe(true);
  });

  it("stays out of the way while frames are arriving", () => {
    // 30 fps capture hits this branch every 33 ms for the whole recording, so
    // the common case must be "no".
    for (const still of [0, 33, 100, 500, 999, HEARTBEAT_IDLE_MS]) {
      expect(heartbeatDue(after(still)), `${still} ms since the last frame`).toBe(false);
    }
  });

  it("skips while the encoder is behind, at the same bound backpressure uses", () => {
    // A heartbeat is only free when the encoder is idle. Pushing frames into a
    // queue that is already over the bound is what makes it drop deltas in the
    // first place — it would trade one hole for a bigger one.
    expect(heartbeatDue({ ...DUE, queueSize: MAX_ENCODE_QUEUE })).toBe(true);
    expect(heartbeatDue({ ...DUE, queueSize: MAX_ENCODE_QUEUE + 1 })).toBe(false);
    expect(heartbeatDue({ ...DUE, queueSize: 100 })).toBe(false);
  });

  it("needs a retained frame to repeat", () => {
    // Before the first capture frame, or after the clone was closed on the way
    // out, there is no picture to encode.
    expect(heartbeatDue({ ...DUE, hasFrame: false })).toBe(false);
  });

  it("stops the moment the recording does", () => {
    // stop() flushes and finalizes; a heartbeat landing after that would encode
    // into an encoder being drained.
    expect(heartbeatDue({ ...DUE, recording: false })).toBe(false);
  });

  it("carries the media clock forward by the wall time that passed", () => {
    // The real recording's hole, as the heartbeat would have covered it: the
    // last frame encoded at 5.097 s, wall clock 541 ms later.
    expect(heartbeatTimestampUs(5_097_000, 1_000, 1_541)).toBe(5_638_000);
  });

  it("always lands strictly ahead of the last encoded frame", () => {
    // The muxer rejects a video timestamp below the one before it outright,
    // which would end the recording rather than dent it.
    expect(heartbeatTimestampUs(1_000_000, 500, 500)).toBeGreaterThan(1_000_000);
    expect(heartbeatTimestampUs(1_000_000, 500, 400)).toBeGreaterThan(1_000_000);
  });

  it("produces whole microseconds from a fractional wall clock", () => {
    // performance.now() has sub-millisecond resolution; VideoFrame timestamps
    // are integers.
    const ts = heartbeatTimestampUs(0, 0.4, 1_234.6789);
    expect(Number.isInteger(ts)).toBe(true);
    expect(ts).toBe(1_234_279);
  });

  it("keeps a hole in a still recording under 1.5 s, and the clock honest", () => {
    // Ten seconds of a completely static screen, ticked at the interval the
    // engine uses. The gap between consecutive encoded frames is what MSE sees
    // as a hole, and it is what has to stay bounded.
    let lastEncodeAtMs = 0;
    let lastEncodeUs = 0;
    const encodedAt = [0];

    for (let nowMs = 0; nowMs <= 10_000; nowMs += HEARTBEAT_INTERVAL_MS) {
      if (!heartbeatDue({ nowMs, lastEncodeAtMs, queueSize: 0, hasFrame: true, recording: true })) {
        continue;
      }
      const timestamp = heartbeatTimestampUs(lastEncodeUs, lastEncodeAtMs, nowMs);
      expect(timestamp, "monotonic").toBeGreaterThan(lastEncodeUs);
      lastEncodeUs = timestamp;
      lastEncodeAtMs = nowMs;
      encodedAt.push(nowMs);
    }

    const holes = encodedAt.slice(1).map((at, i) => at - (encodedAt[i] as number));
    expect(holes.length, "the still screen was kept alive").toBeGreaterThan(5);
    expect(Math.max(...holes)).toBeLessThanOrEqual(HEARTBEAT_IDLE_MS + HEARTBEAT_INTERVAL_MS);
    // Media time tracks wall time: a still stretch is not compressed away.
    expect(lastEncodeUs).toBe(lastEncodeAtMs * 1000);
  });

  it("checks often enough that the threshold is the bound", () => {
    // The worst case is one full interval of bad luck on top of the threshold,
    // so the interval has to be a fraction of it.
    expect(HEARTBEAT_INTERVAL_MS).toBeLessThanOrEqual(HEARTBEAT_IDLE_MS / 2);
    expect(HEARTBEAT_IDLE_MS + HEARTBEAT_INTERVAL_MS).toBeLessThan(2_000);
  });

  it("repeats frames far more often than it forces keyframes", () => {
    // A heartbeat that crosses the 8 s deadline is a keyframe like any other
    // frame; the rest are deltas against an identical picture, which is what
    // makes them nearly free.
    expect(HEARTBEAT_IDLE_MS * 1000).toBeLessThan(KEYFRAME_INTERVAL_US);
  });
});

/**
 * The silence the engine synthesises after the audio track ends mid-recording
 * (`fillAudioGap`), and the one decision inside it: fill the gap to the video
 * clock frame by frame, or give up and jump the clock forward.
 *
 * A jump leaves a hole in the *audio* track, and MSE intersects the two tracks'
 * buffered ranges — so an audio hole strands the player at its near edge just
 * as a video hole does (§8). The heartbeat makes this sharp: it moves the video
 * clock in strides of up to 1.5 s, which the catch-up ceiling has to be able to
 * absorb, or every heartbeat on a still screen would punch a fresh hole.
 *
 * Container-independent: fMP4 fragments are cut on the same interleaving rule
 * WebM clusters are, so the H.264 path inherits this unchanged.
 */
describe("silence catch-up after the audio track ends", () => {
  it("fills a heartbeat-wide gap frame by frame instead of jumping it", () => {
    const silenceUs = 2_000_000;
    const widestStride = (HEARTBEAT_IDLE_MS + HEARTBEAT_INTERVAL_MS) * 1000;
    expect(silenceCatchUpUs(silenceUs, silenceUs + widestStride)).toBe(silenceUs);
  });

  it("keeps the ceiling clear of the heartbeat's stride, with room for jitter", () => {
    // The bound the case above rests on, stated where a change to either
    // constant will trip over it. The factor of two is for a heartbeat that
    // runs late on a loaded main thread, which is when frames get dropped and
    // the heartbeat matters most.
    const stride = (HEARTBEAT_IDLE_MS + HEARTBEAT_INTERVAL_MS) * 1000;
    expect(MAX_SILENCE_CATCHUP_US).toBeGreaterThanOrEqual(2 * stride);
    // And still small enough that filling it is a bounded burst of encodes.
    expect(MAX_SILENCE_CATCHUP_US / SILENCE_FRAME_US).toBeLessThanOrEqual(200);
  });

  it("still jumps a hole no heartbeat could have covered", () => {
    // A tab throttled to one timer callback a minute: that audio really is
    // missing, and encoding it 20 ms at a time would mean 3000 encodes inside
    // the video pump.
    const silenceUs = 2_000_000;
    const target = silenceUs + 60_000_000;
    expect(silenceCatchUpUs(silenceUs, target)).toBe(target - MAX_SILENCE_CATCHUP_US);
  });

  it("never moves the clock backwards", () => {
    // Video frames arrive slightly out of step with the silence already
    // written; the clock must simply stay where it is.
    expect(silenceCatchUpUs(5_000_000, 4_000_000)).toBe(5_000_000);
    expect(silenceCatchUpUs(5_000_000, 5_000_000)).toBe(5_000_000);
  });

  it("leaves no audio hole across a still screen driven only by heartbeats", () => {
    // The failure this exists to catch: audio track ended at 2 s, screen static
    // for the next 30 s, so the only thing moving the video clock is the
    // heartbeat. Both clocks are walked exactly as the engine walks them —
    // `heartbeat()` calls `fillAudioGap()` before every frame it submits.
    const endedAtUs = 2_000_000;
    let lastEncodeAtMs = 2_000;
    let lastEncodeUs = endedAtUs;
    let silenceUs = endedAtUs;
    const frames: number[] = [];

    for (let nowMs = lastEncodeAtMs; nowMs <= 32_000; nowMs += HEARTBEAT_INTERVAL_MS) {
      const due = heartbeatDue({ nowMs, lastEncodeAtMs, queueSize: 0, hasFrame: true, recording: true });
      if (!due) continue;
      const videoUs = heartbeatTimestampUs(lastEncodeUs, lastEncodeAtMs, nowMs);
      lastEncodeUs = videoUs;
      lastEncodeAtMs = nowMs;

      const target = videoUs + SILENCE_LEAD_US;
      silenceUs = silenceCatchUpUs(silenceUs, target);
      while (silenceUs < target) {
        frames.push(silenceUs);
        silenceUs += SILENCE_FRAME_US;
      }
    }

    expect(frames.length, "the audio clock followed the video clock").toBeGreaterThan(1_000);
    expect(frames[0], "silence picks up where the real audio stopped").toBe(endedAtUs);
    // Every Opus frame butts against the one before it: no hole for MSE to
    // split the buffered ranges on, anywhere in the still stretch.
    const gaps = frames.slice(1).map((at, i) => at - (frames[i] as number));
    expect(Math.max(...gaps)).toBe(SILENCE_FRAME_US);
    // And the audio clock still leads the video clock, which is what keeps the
    // muxer releasing video blocks (§7 streaming upload).
    expect(silenceUs).toBeGreaterThan(lastEncodeUs);
  });
});

/**
 * SPEC §6: an `isConfigSupported()` yes is an opinion, not a reservation. A
 * hardware H.264 encoder can approve a config in a probe and then refuse it —
 * every GPU encode session already taken, per-frame QP the platform does not
 * really honour — and WebCodecs delivers that refusal asynchronously, through
 * the encoder's error callback. These are the rungs the engine drops to instead
 * of ending the recording: the same two axes `probeCandidate` walks, and never
 * a different codec, because by then the muxer has declared the track and the
 * container, audio codec and `meta.mimeType` are already in uploaded bytes (§7).
 */
describe("video encoder fallback rungs", () => {
  const setup = (over: Partial<VideoSetup> = {}): VideoSetup => ({
    codec: "h264",
    hardware: true,
    rateControl: "quantizer",
    contentHint: true,
    ...over,
  });

  const shape = (rungs: readonly VideoSetup[]): string[] =>
    rungs.map((s) => `${s.codec}/${s.hardware ? "hw" : "sw"}/${s.rateControl}`);

  it("drops per-frame quantizer before it gives up the hardware encoder", () => {
    // Constant quality is what keeps screen text legible, but a variable-bitrate
    // recording on the GPU still beats a software one, and both beat no
    // recording at all.
    expect(shape(videoFallbackSetups(setup()))).toEqual([
      "h264/hw/variable",
      "h264/sw/quantizer",
      "h264/sw/variable",
    ]);
  });

  it("skips the quantizer rung when the setup never had one", () => {
    expect(shape(videoFallbackSetups(setup({ rateControl: "variable" })))).toEqual([
      "h264/sw/variable",
    ]);
  });

  it("has only the rate-control rung left once it is already in software", () => {
    expect(shape(videoFallbackSetups(setup({ hardware: false })))).toEqual(["h264/sw/variable"]);
    expect(videoFallbackSetups(setup({ hardware: false, rateControl: "variable" }))).toEqual([]);
  });

  it("offers nothing for VP9 or AV1", () => {
    // Neither has a §6 bitrate table to fall back on, and neither is ever the
    // hardware rung — so their behaviour is exactly what it was before.
    for (const codec of ["vp9", "av1"] as const) {
      expect(videoFallbackSetups(setup({ codec, hardware: false })), codec).toEqual([]);
    }
  });

  it("never changes the codec, and so never the container", () => {
    for (const codec of CODECS) {
      for (const hardware of [true, false]) {
        for (const rateControl of ["quantizer", "variable"] as const) {
          const from = setup({ codec, hardware, rateControl });
          for (const rung of videoFallbackSetups(from)) {
            expect(rung.codec, `${codec}/${hardware}/${rateControl}`).toBe(codec);
            expect(containerFor(rung.codec)).toBe(containerFor(codec));
          }
        }
      }
    }
  });

  it("terminates: every rung's own fallbacks are shorter than its parent's", () => {
    const walk = (from: VideoSetup, depth = 0): number => {
      expect(depth, "the fallback chain is bounded").toBeLessThan(8);
      const rungs = videoFallbackSetups(from);
      return rungs.length === 0 ? depth : Math.max(...rungs.map((r) => walk(r, depth + 1)));
    };
    expect(walk(setup())).toBeLessThanOrEqual(3);
  });
});

describe("encoder constants", () => {
  it("matches the SPEC §6 audio bitrates", () => {
    expect(OPUS_BITRATE).toBe(48_000);
    expect(FALLBACK_AUDIO_BITRATE).toBe(64_000);
  });

  it("forces a keyframe every 8 seconds of media time", () => {
    // Bounds cluster and fragment size so MSE seeking works and a mid-stream
    // chunk boundary is never far from a decodable point (SPEC §6, §8).
    expect(KEYFRAME_INTERVAL_US).toBe(8_000_000);
    expect(KEYFRAME_INTERVAL_US / 1_000_000).toBe(8);
  });

  it("defaults the fallback engine to 2.5 Mbps", () => {
    // videoBitsPerSecond only reaches the MediaRecorder engine; the WebCodecs
    // engine is quantizer-driven, and where it cannot be it uses the §6 bitrate
    // table above rather than this setting (SPEC §6, §9).
    expect(DEFAULT_VIDEO_BITS_PER_SECOND).toBe(2_500_000);
  });
});
