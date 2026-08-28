/**
 * Unit tests for the pure parts of `src/encoder.ts` (SPEC §13).
 *
 * Node has no WebCodecs, so the engines themselves are exercised by hand in a
 * browser. What is testable here is the arithmetic and the decisions made
 * *before* any encoder object exists: which codec string describes the frames
 * we are about to feed it, what quantizer a quality setting means, and which
 * engine to build at all. That only works if `encoder.ts` keeps those decisions
 * in exported pure functions instead of inlining them in the engine classes.
 *
 * The surface these tests expect — all pure, none of it touching a global:
 *
 * ```ts
 * export type EngineKind = "webcodecs" | "mediarecorder";
 * export type VideoCodec = "vp9" | "av1";
 * export interface EngineCapabilities {
 *   videoEncoder: boolean;     // typeof VideoEncoder !== "undefined"
 *   audioEncoder: boolean;     // typeof AudioEncoder !== "undefined"
 *   trackProcessor: boolean;   // typeof MediaStreamTrackProcessor !== "undefined"
 *   mediaRecorder: boolean;    // typeof MediaRecorder !== "undefined"
 * }
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
 * export const QUANTIZERS: Record<VideoCodec, Record<Quality, number>>;
 * export function quantizerFor(codec: VideoCodec, quality: Quality): number;
 * export function selectEngineKind(caps: EngineCapabilities): EngineKind | null;
 * export function selectVideoCodec(preferAv1: boolean, av1Supported: boolean): VideoCodec;
 * export function videoCodecString(codec: VideoCodec, width: number, height: number,
 *   frameRate: number): string;
 * export function containerMimeType(videoCodec: string): string;
 * export function selectFallbackMimeType(isSupported: (type: string) => boolean): string | null;
 * ```
 *
 * `createEngine()` itself is not covered: it reads globals and constructs an
 * engine, which is exactly the part Node cannot run.
 */

import { describe, expect, it } from "vitest";
import {
  containerMimeType,
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
  selectEngineKind,
  selectFallbackMimeType,
  selectVideoCodec,
  SILENCE_FRAME_US,
  SILENCE_LEAD_US,
  silenceCatchUpUs,
  videoCodecString,
} from "../src/encoder";
import { DEFAULT_VIDEO_BITS_PER_SECOND, QUALITIES } from "../src/settings";
import type { Quality } from "../src/types";

const CODECS = ["vp9", "av1"] as const;

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

/**
 * Sizes a screen capture actually produces. The last one is over the SPEC §6
 * 1080p cap: the cap is a constraint, not a guarantee, and a browser that
 * ignores it must still get a truthful codec string.
 */
const CAPTURE_SIZES = [
  { label: "a small shared window", width: 640, height: 360, frameRate: 30 },
  { label: "720p", width: 1280, height: 720, frameRate: 30 },
  { label: "a 1440x900 laptop display", width: 1440, height: 900, frameRate: 30 },
  { label: "the 1080p capture cap", width: 1920, height: 1080, frameRate: 30 },
  { label: "1440p, over the cap", width: 2560, height: 1440, frameRate: 30 },
] as const;

/** Grammar from the ISO-BMFF codecs-parameter bindings for VP9 and AV1. */
const VP9_CODEC_STRING = /^vp09\.\d{2}\.\d{2}\.\d{2}$/;
const AV1_CODEC_STRING = /^av01\.[0-2]\.\d{2}[MH]\.\d{2}$/;

/** WebCodecs quantizer ranges — they differ per codec, which is the trap. */
const QUANTIZER_MAX = { vp9: 63, av1: 255 } as const;

describe("video codec strings", () => {
  it("builds VP9 profile-0 8-bit strings for real capture sizes", () => {
    const built = CAPTURE_SIZES.map(({ width, height, frameRate }) =>
      videoCodecString("vp9", width, height, frameRate),
    );

    expect(built).toEqual([
      "vp09.00.21.08",
      "vp09.00.31.08",
      "vp09.00.40.08",
      "vp09.00.40.08",
      "vp09.00.50.08",
    ]);
  });

  it("builds AV1 main-profile main-tier 8-bit strings for the same sizes", () => {
    const built = CAPTURE_SIZES.map(({ width, height, frameRate }) =>
      videoCodecString("av1", width, height, frameRate),
    );

    // 1080p30 is `av01.0.08M.08` — level 4.0, the string named in SPEC §6.
    expect(built).toEqual([
      "av01.0.01M.08",
      "av01.0.05M.08",
      "av01.0.08M.08",
      "av01.0.08M.08",
      "av01.0.12M.08",
    ]);
  });

  it("matches the codecs-parameter grammar for both codecs", () => {
    for (const { label, width, height, frameRate } of CAPTURE_SIZES) {
      expect(videoCodecString("vp9", width, height, frameRate), `vp9 at ${label}`).toMatch(
        VP9_CODEC_STRING,
      );
      expect(videoCodecString("av1", width, height, frameRate), `av1 at ${label}`).toMatch(
        AV1_CODEC_STRING,
      );
    }
  });

  it("declares 8-bit 4:2:0 — profile 0 for both codecs", () => {
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
      expect(videoCodecString("vp9", width, height, frameRate), `vp9 at ${label}`).toBe(
        `vp09.00.${smallestVp9Level(width, height, frameRate)}.08`,
      );
      expect(videoCodecString("av1", width, height, frameRate), `av1 at ${label}`).toBe(
        `av01.0.${smallestAv1Level(width, height, frameRate)}M.08`,
      );
    }
  });

  it("keeps the level sufficient across a sweep of odd window sizes", () => {
    // Shared windows are whatever the user dragged them to, so the level has to
    // come out of the numbers rather than a lookup of the usual suspects.
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
    ] as const;

    for (const [width, height] of sizes) {
      const vp9Level = videoCodecString("vp9", width, height, 30).split(".")[2];
      // `av01.0.08M.08` → the level is the third field with the tier letter dropped.
      const av1Level = videoCodecString("av1", width, height, 30).split(".")[2]?.slice(0, -1);

      expect(VP9_LEVELS.findIndex(([code]) => code === vp9Level), `${width}x${height} vp9`)
        .toBeGreaterThanOrEqual(
          VP9_LEVELS.findIndex(([code]) => code === smallestVp9Level(width, height, 30)),
        );
      expect(AV1_LEVELS.findIndex(([code]) => code === av1Level), `${width}x${height} av1`)
        .toBeGreaterThanOrEqual(
          AV1_LEVELS.findIndex(([code]) => code === smallestAv1Level(width, height, 30)),
        );
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
      const levels = ladder.map(([width, height]) => {
        const parts = videoCodecString(codec, width, height, 30).split(".");
        return codec === "vp9" ? parts[2] : parts[2]?.slice(0, -1);
      });
      const table: readonly (readonly [string, ...number[]])[] =
        codec === "vp9" ? VP9_LEVELS : AV1_LEVELS;
      const indices = levels.map((code) => table.findIndex(([entry]) => entry === code));

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
    // rather than a path we take: 1080p60 needs level 4.1, not 4.0.
    expect(videoCodecString("vp9", 1920, 1080, 30)).toBe("vp09.00.40.08");
    expect(videoCodecString("vp9", 1920, 1080, 60)).toBe("vp09.00.41.08");
    expect(videoCodecString("av1", 1920, 1080, 30)).toBe("av01.0.08M.08");
    expect(videoCodecString("av1", 1920, 1080, 60)).toBe("av01.0.09M.08");
  });
});

describe("containerMimeType", () => {
  it("wraps a video codec string in the WebM type the player will see", () => {
    // SPEC §5: meta.mimeType is exactly this string, and SPEC §8 feeds it
    // straight to MediaSource.isTypeSupported.
    expect(containerMimeType(videoCodecString("vp9", 1920, 1080, 30))).toBe(
      "video/webm;codecs=vp09.00.40.08,opus",
    );
    expect(containerMimeType(videoCodecString("av1", 1920, 1080, 30))).toBe(
      "video/webm;codecs=av01.0.08M.08,opus",
    );
  });

  it("always names WebM and Opus, with no quoting MediaSource has to unpick", () => {
    for (const codec of CODECS) {
      const mimeType = containerMimeType(videoCodecString(codec, 1280, 720, 30));

      expect(mimeType.startsWith("video/webm;codecs=")).toBe(true);
      expect(mimeType.endsWith(",opus")).toBe(true);
      expect(mimeType).not.toContain('"');
      expect(mimeType).not.toContain(" ");
    }
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
    // 0-63 (quantizer threshold) and AV1 at 0-255 (quantizer index).
    for (const codec of CODECS) {
      for (const quality of QUALITIES) {
        const q = QUANTIZERS[codec][quality];
        expect(Number.isInteger(q), `${codec}/${quality} is an integer`).toBe(true);
        expect(q, `${codec}/${quality} above the floor`).toBeGreaterThan(0);
        expect(q, `${codec}/${quality} under ${QUANTIZER_MAX[codec]}`).toBeLessThan(
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

  it("lowers the quantizer as the quality setting rises", () => {
    // Lower quantizer = finer quality = bigger file, for both codecs.
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

describe("video codec choice", () => {
  it("uses AV1 only when it is both asked for and supported", () => {
    expect(selectVideoCodec(true, true)).toBe("av1");
  });

  it("falls back to VP9 when AV1 is asked for but cannot be encoded", () => {
    // preferAv1 is a preference, not a promise: no AV1 encoder means VP9,
    // silently, rather than a failed recording.
    expect(selectVideoCodec(true, false)).toBe("vp9");
  });

  it("stays on VP9 by default even where AV1 would encode", () => {
    // SPEC §9: preferAv1 defaults to false because Safari viewers without
    // hardware AV1 decode cannot play the result.
    expect(selectVideoCodec(false, true)).toBe("vp9");
    expect(selectVideoCodec(false, false)).toBe("vp9");
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
    // Safari's MediaRecorder: it records, just never WebM.
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

describe("encoder constants", () => {
  it("matches the SPEC §6 audio bitrates", () => {
    expect(OPUS_BITRATE).toBe(48_000);
    expect(FALLBACK_AUDIO_BITRATE).toBe(64_000);
  });

  it("forces a keyframe every 8 seconds of media time", () => {
    // Bounds cluster size so MSE seeking works and a mid-stream chunk boundary
    // is never far from a decodable point (SPEC §6, §8).
    expect(KEYFRAME_INTERVAL_US).toBe(8_000_000);
    expect(KEYFRAME_INTERVAL_US / 1_000_000).toBe(8);
  });

  it("defaults the fallback engine to 2.5 Mbps", () => {
    // videoBitsPerSecond only reaches the MediaRecorder engine now; the
    // WebCodecs engine is constant-quality and ignores it (SPEC §6, §9).
    expect(DEFAULT_VIDEO_BITS_PER_SECOND).toBe(2_500_000);
  });
});
