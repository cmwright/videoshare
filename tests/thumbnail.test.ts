/**
 * The pure half of `src/thumbnail.ts` (docs/SPEC.md §11, §13).
 *
 * §6 gives the thumbnail two give-up conditions — a frame with no usable size,
 * and a frame that painted all black — and both of them live here as arithmetic
 * over numbers and RGBA bytes:
 *
 * ```ts
 * export function thumbSize(width, height, maxWidth?): { width, height } | null;
 * export function isBlankFrame(frame: FrameData): boolean;
 * ```
 *
 * `captureThumbnail` and `fetchThumbnail` are **not** tested here, for the
 * reason §13 already gives for the encoder: Node has no canvas, no
 * `MediaStream` and no `<video>`, and a stub of all three would test the stub.
 * What they do that is worth testing is the two functions below; what is left is
 * which DOM call happens in which order, and §6's rule that no failure of either
 * ever reaches the user.
 */

import { describe, expect, it } from "vitest";
import {
  type FrameData,
  isBlankFrame,
  THUMB_BLANK_LEVEL,
  THUMB_MAX_WIDTH,
  thumbSize,
} from "../src/thumbnail";

/** A solid RGBA frame, so a test can say what it means in channel values. */
function frame(width: number, height: number, r: number, g: number, b: number, a = 255): FrameData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = a;
  }
  return { width, height, data };
}

function isEven(n: number): boolean {
  return Number.isInteger(n) && n % 2 === 0;
}

describe("thumbSize — the box a frame is drawn into (SPEC §6, §11)", () => {
  it("scales a 4K 16:9 capture to the stored width", () => {
    expect(thumbSize(3840, 2160)).toEqual({ width: 640, height: 360 });
  });

  it("never upscales: a frame narrower than the cap keeps its own size", () => {
    expect(thumbSize(320, 240)).toEqual({ width: 320, height: 240 });
    expect(thumbSize(THUMB_MAX_WIDTH, 360)).toEqual({ width: THUMB_MAX_WIDTH, height: 360 });
    // One pixel under the cap is still its own size, not the cap's.
    expect(thumbSize(THUMB_MAX_WIDTH - 1, 360)?.width).toBe(THUMB_MAX_WIDTH - 2);
  });

  it("preserves the aspect of a capture that is not 16:9", () => {
    // Portrait: the row's 16:9 frame crops it (§17.3), so it is not squashed here.
    const portrait = thumbSize(1080, 1920);
    expect(portrait).toEqual({ width: 640, height: 1136 });

    // 4:3.
    expect(thumbSize(1600, 1200)).toEqual({ width: 640, height: 480 });

    // An extreme panorama — two ultrawides side by side.
    const panorama = thumbSize(5120, 1440);
    expect(panorama).toEqual({ width: 640, height: 180 });
  });

  it("rounds both sides down to even numbers", () => {
    const sizes = [
      thumbSize(3840, 2160),
      thumbSize(1080, 1920),
      thumbSize(1366, 768),
      thumbSize(2561, 1441),
      thumbSize(999, 333),
      thumbSize(321, 241),
    ];
    for (const size of sizes) {
      expect(size).not.toBeNull();
      expect(isEven(size?.width ?? 1), `width ${size?.width ?? "?"} is even`).toBe(true);
      expect(isEven(size?.height ?? 1), `height ${size?.height ?? "?"} is even`).toBe(true);
    }
    // The odd input keeps its aspect rather than its parity.
    expect(thumbSize(321, 241)).toEqual({ width: 320, height: 240 });
  });

  it("never exceeds the cap", () => {
    for (const width of [641, 1280, 1920, 3840, 7680]) {
      expect(thumbSize(width, 1080)?.width).toBeLessThanOrEqual(THUMB_MAX_WIDTH);
    }
  });

  it("returns null for a frame with no usable size — §6's zero-sized give-up", () => {
    expect(thumbSize(0, 0)).toBeNull();
    expect(thumbSize(0, 1080)).toBeNull();
    expect(thumbSize(1920, 0)).toBeNull();
    expect(thumbSize(-1920, 1080)).toBeNull();
    expect(thumbSize(1920, -1080)).toBeNull();
    expect(thumbSize(Number.NaN, 1080)).toBeNull();
    expect(thumbSize(1920, Number.NaN)).toBeNull();
    expect(thumbSize(Number.POSITIVE_INFINITY, 1080)).toBeNull();
    expect(thumbSize(1920, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("returns null rather than a zero-sided box when an aspect rounds one side away", () => {
    // 3840×2 scales to 640×0.33, and a 0-high box is not a thumbnail.
    expect(thumbSize(3840, 2)).toBeNull();
  });

  it("takes an explicit cap", () => {
    expect(thumbSize(1920, 1080, 320)).toEqual({ width: 320, height: 180 });
    // Still never upscales, whatever the cap says.
    expect(thumbSize(160, 90, 640)).toEqual({ width: 160, height: 90 });
  });
});

describe("isBlankFrame — the all-black give-up (SPEC §6, §11)", () => {
  it("calls an all-zero buffer blank", () => {
    // A canvas that was never painted reads as transparent black…
    expect(isBlankFrame(frame(4, 4, 0, 0, 0, 0))).toBe(true);
    // …and so does a screen that has not started delivering. Same answer, on
    // purpose: §6 cannot tell them apart and does not need to.
    expect(isBlankFrame(frame(4, 4, 0, 0, 0, 255))).toBe(true);
  });

  it("pins the threshold rather than implying it", () => {
    expect(isBlankFrame(frame(4, 4, THUMB_BLANK_LEVEL, THUMB_BLANK_LEVEL, THUMB_BLANK_LEVEL))).toBe(
      true,
    );

    const oneStepUp = frame(4, 4, THUMB_BLANK_LEVEL, THUMB_BLANK_LEVEL, THUMB_BLANK_LEVEL + 1);
    expect(isBlankFrame(oneStepUp)).toBe(false);
  });

  it("finds a single bright pixel in an otherwise black frame", () => {
    const dark = frame(8, 8, 0, 0, 0);
    const data = dark.data as Uint8ClampedArray;
    // The last pixel, so a short-circuiting scan has to reach the end.
    data[data.length - 2] = 255;
    expect(isBlankFrame(dark)).toBe(false);
  });

  it("reads channels, not luminance", () => {
    // Bright in green alone: dim by any luma weighting, and not black.
    expect(isBlankFrame(frame(4, 4, 0, 200, 0))).toBe(false);
    expect(isBlankFrame(frame(4, 4, 200, 0, 0))).toBe(false);
    expect(isBlankFrame(frame(4, 4, 0, 0, 200))).toBe(false);
  });

  it("ignores alpha", () => {
    // Fully opaque black and fully transparent black are both blank; a bright
    // pixel is not blank however transparent it is.
    expect(isBlankFrame(frame(4, 4, 0, 0, 0, 255))).toBe(true);
    expect(isBlankFrame(frame(4, 4, 255, 255, 255, 0))).toBe(false);
  });

  it("reads a plain ArrayLike, not just Uint8ClampedArray", () => {
    // The FrameData seam exists so the pure half needs no canvas.
    expect(isBlankFrame({ width: 1, height: 1, data: [0, 0, 0, 255] })).toBe(true);
    expect(isBlankFrame({ width: 1, height: 1, data: [0, 0, 9, 255] })).toBe(false);
  });
});
