/**
 * Unit tests for the player's buffered-gap arithmetic (SPEC §8, §13).
 *
 * `src/player.ts` itself is a page controller: it reaches for `document` as it
 * loads and starts fetching, so Node cannot import it. What *is* testable is
 * the decision it makes when playback stalls — whether there is a hole in the
 * buffered timeline worth seeking over, and where to land — which lives in
 * `src/gap.ts` as pure functions over a `TimeRanges`-shaped list:
 *
 * ```ts
 * export const GAP_SEEK_EPSILON: number;    // 0.05 s past the far range's start
 * export const GAP_EDGE_TOLERANCE: number;  // how close to a range's end counts as "at" it
 * export const PROGRESS_EPSILON: number;    // advance between polls that counts as progress
 * export function bufferedRanges(ranges: TimeRangesLike): TimeRangeLike[];
 * export function findGapSeek(ranges: readonly TimeRangeLike[], currentTime: number,
 *   epsilon?: number, tolerance?: number): number | null;
 * export function isStalling(previousTime: number, sample: PlaybackSample,
 *   epsilon?: number): boolean;
 * ```
 *
 * The event plumbing around them — the `waiting` listener and the watchdog that
 * polls `currentTime` because Chrome often does not fire `waiting` at a range
 * edge — needs a real media element and is exercised by hand in a browser.
 *
 * The numbers below are from the recording that prompted this: 13.6 s of
 * screen capture whose video packets jump 5.097 → 5.638 s (a 541 ms hole, ~16
 * delta frames the encoder dropped under load), audio continuous throughout.
 * Native playback is fine; MSE splits its buffered ranges at the hole and the
 * player sits at 5.1 s forever.
 */

import { describe, expect, it } from "vitest";
import {
  bufferedRanges,
  findGapSeek,
  GAP_EDGE_TOLERANCE,
  GAP_SEEK_EPSILON,
  isStalling,
  type PlaybackSample,
  PROGRESS_EPSILON,
  type TimeRangeLike,
  type TimeRangesLike,
} from "../src/gap";

/** A stand-in for `HTMLMediaElement.buffered`, which is a live DOM object. */
function timeRanges(...ranges: readonly (readonly [number, number])[]): TimeRangesLike {
  return {
    length: ranges.length,
    start: (index) => ranges[index][0],
    end: (index) => ranges[index][1],
  };
}

function ranges(...pairs: readonly (readonly [number, number])[]): TimeRangeLike[] {
  return pairs.map(([start, end]) => ({ start, end }));
}

/** How the real recording's timeline reaches a SourceBuffer: split at the hole. */
const HOLE = ranges([0, 5.097], [5.638, 13.633]);

/** The same recording as it would be with no dropped frames. */
const WHOLE = ranges([0, 13.633]);

describe("bufferedRanges", () => {
  it("snapshots a live TimeRanges as plain numbers", () => {
    expect(bufferedRanges(timeRanges([0, 5.097], [5.638, 13.633]))).toEqual([
      { start: 0, end: 5.097 },
      { start: 5.638, end: 13.633 },
    ]);
  });

  it("is empty before anything has been appended", () => {
    expect(bufferedRanges(timeRanges())).toEqual([]);
  });

  it("drops ranges the element reports as non-finite", () => {
    // A live MediaSource with no duration yet can hand back Infinity; arithmetic
    // on it would produce a seek target of Infinity.
    expect(bufferedRanges(timeRanges([0, Infinity], [2, 3]))).toEqual([{ start: 2, end: 3 }]);
    expect(bufferedRanges(timeRanges([NaN, 1]))).toEqual([]);
  });
});

describe("findGapSeek — the recording that prompted this", () => {
  it("steps over the 541 ms hole when the playhead reaches its edge", () => {
    // The stall the viewer sees: playback stops at 5.097 with 8 s of decoded
    // video sitting on the far side of the hole.
    expect(findGapSeek(HOLE, 5.097)).toBeCloseTo(5.688, 10);
  });

  it("steps over it from just short of the edge", () => {
    // Chrome stops on the last frame it can present and reports a currentTime a
    // frame or so behind the range end, so "at the edge" has to be a tolerance.
    for (const at of [5.09, 5.05, 5.0]) {
      expect(findGapSeek(HOLE, at), `stalled at ${at}`).toBeCloseTo(5.688, 10);
    }
  });

  it("lands inside the far range, past its first sample", () => {
    const target = findGapSeek(HOLE, 5.097);
    expect(target).not.toBeNull();
    expect(target as number).toBeGreaterThan(5.638);
    expect(target as number).toBeLessThan(13.633);
    // Seeking to exactly 5.638 can round back onto the hole; the epsilon is
    // what makes the jump stick.
    expect((target as number) - 5.638).toBeCloseTo(GAP_SEEK_EPSILON, 10);
  });

  it("does nothing while there is still video ahead of the playhead", () => {
    // Mid-range, plenty buffered: a stall here is the network, not a hole, and
    // seeking would skip content the viewer is about to see.
    for (const at of [0, 1, 3, 4.5]) {
      expect(findGapSeek(HOLE, at), `playing at ${at}`).toBeNull();
    }
  });

  it("does nothing once past the hole", () => {
    // Never backwards: the far side of a hole is behind the playhead now.
    for (const at of [5.7, 8, 13.633]) {
      expect(findGapSeek(HOLE, at), `playing at ${at}`).toBeNull();
    }
  });

  it("rescues a viewer who seeked into the hole", () => {
    // Nothing will ever fill 5.097–5.638: those frames were never encoded.
    expect(findGapSeek(HOLE, 5.3)).toBeCloseTo(5.688, 10);
    expect(findGapSeek(HOLE, 5.6)).toBeCloseTo(5.688, 10);
  });
});

describe("findGapSeek — leaves a healthy stream alone", () => {
  it("never seeks a recording with no holes", () => {
    for (let at = 0; at <= 13.633; at += 0.137) {
      expect(findGapSeek(WHOLE, at), `playing at ${at.toFixed(3)}`).toBeNull();
    }
  });

  it("waits at the head of the buffer instead of seeking", () => {
    // Mid-download: chunk 1 has not arrived, so playback stalls at the end of
    // everything appended so far. There is nothing beyond it to jump to, and
    // the append that follows will resume playback on its own.
    expect(findGapSeek(ranges([0, 8]), 8)).toBeNull();
    expect(findGapSeek(ranges([0, 8]), 7.99)).toBeNull();
  });

  it("waits out a seek into a region that has not been fetched yet", () => {
    // SPEC §8: an unbuffered seek waits for the buffer to reach it (v1).
    expect(findGapSeek(ranges([0, 8]), 20)).toBeNull();
  });

  it("does nothing with an empty buffer", () => {
    expect(findGapSeek([], 0)).toBeNull();
    expect(findGapSeek([], 5)).toBeNull();
  });

  it("refuses a nonsense playhead rather than seeking somewhere arbitrary", () => {
    expect(findGapSeek(HOLE, NaN)).toBeNull();
    expect(findGapSeek(HOLE, Infinity)).toBeNull();
  });
});

describe("findGapSeek — general behaviour", () => {
  it("takes the nearest range ahead, not the last one", () => {
    // Two holes: crossing the first must not skip the island between them.
    const islands = ranges([0, 5], [6, 8], [9, 13]);
    expect(findGapSeek(islands, 5)).toBeCloseTo(6.05, 10);
    expect(findGapSeek(islands, 8)).toBeCloseTo(9.05, 10);
  });

  it("does not care what order the element lists ranges in", () => {
    expect(findGapSeek(ranges([9, 13], [6, 8], [0, 5]), 5)).toBeCloseTo(6.05, 10);
  });

  it("only ever moves forward", () => {
    const islands = ranges([0, 5], [6, 8], [9, 13]);
    for (let at = 0; at <= 14; at += 0.25) {
      const target = findGapSeek(islands, at);
      if (target !== null) expect(target, `from ${at}`).toBeGreaterThan(at);
    }
  });

  it("stays inside a range shorter than the epsilon", () => {
    // A single frame stranded between two holes: start + epsilon would land
    // back in the next hole and stall again one poll later.
    const target = findGapSeek(ranges([0, 1], [2, 2.02]), 1);
    expect(target).toBeCloseTo(2.01, 10);
    expect(target as number).toBeLessThan(2.02);
  });

  it("jumps a hole of any size", () => {
    // SPEC §8: a hole the player will not cross costs the viewer everything
    // after it, so size is never the reason to refuse.
    expect(findGapSeek(ranges([0, 5], [5.6, 13]), 5)).toBeCloseTo(5.65, 10);
    expect(findGapSeek(ranges([0, 5], [605, 1200]), 5)).toBeCloseTo(605.05, 10);
  });

  it("takes the tolerance from the trailing edge only", () => {
    const wide = findGapSeek(HOLE, 5.097, GAP_SEEK_EPSILON, 1.0);
    // A generous tolerance still only decides "this range is spent"; it must
    // never let a playhead sitting *before* a range's start count as inside it.
    expect(wide).toBeCloseTo(5.688, 10);
    expect(findGapSeek(HOLE, 5.6, GAP_SEEK_EPSILON, 1.0)).toBeCloseTo(5.688, 10);
    // With no tolerance at all, a playhead one frame short of the edge is
    // considered still playing — which is the stall this fix exists for.
    expect(findGapSeek(HOLE, 5.05, GAP_SEEK_EPSILON, 0)).toBeNull();
  });
});

describe("isStalling — what the watchdog counts", () => {
  const playing = (currentTime: number): PlaybackSample => ({
    paused: false,
    ended: false,
    currentTime,
  });

  it("forgives an element that is advancing", () => {
    expect(isStalling(5.0, playing(5.033))).toBe(false);
    expect(isStalling(0, playing(13.633))).toBe(false);
  });

  it("counts an element that has not moved", () => {
    // The stall this whole file is about: parked on the last frame before the
    // hole, readyState still HAVE_CURRENT_DATA, no event coming.
    expect(isStalling(5.097, playing(5.097))).toBe(true);
    expect(isStalling(5.097, playing(5.097 + PROGRESS_EPSILON / 2))).toBe(true);
  });

  it("counts a seek that has not landed", () => {
    // The regression this guards: an MSE seek into the hole never completes —
    // nothing will ever append 5.097–5.638 — so the element sits at
    // `seeking = true` with `currentTime` frozen on the target. Excusing that
    // (the element *is* seeking, after all) is what left the viewer stranded.
    // `seeking` is not even in the sample: a stalled seek looks like any other
    // stall from here, which is the point.
    const scrubbedIntoTheHole = playing(5.3);
    expect(isStalling(5.3, scrubbedIntoTheHole)).toBe(true);
    // The first poll after the scrub sees the jump from 1.0 to 5.3 as progress;
    // it is the polls after it, with nothing moving, that add up to a rescue.
    expect(isStalling(1.0, scrubbedIntoTheHole)).toBe(false);
  });

  it("leaves a paused viewer alone", () => {
    // Pausing freezes `currentTime` exactly as a stall does; only this flag
    // separates "the viewer parked here" from "the element gave up".
    expect(isStalling(7, { paused: true, ended: false, currentTime: 7 })).toBe(false);
  });

  it("does not treat the end of the recording as a hole", () => {
    expect(isStalling(13.633, { paused: true, ended: true, currentTime: 13.633 })).toBe(false);
    expect(isStalling(13.633, { paused: false, ended: true, currentTime: 13.633 })).toBe(false);
  });
});

describe("gap constants", () => {
  it("lands far enough past a range start to stick, and not far enough to skip", () => {
    expect(GAP_SEEK_EPSILON).toBeGreaterThan(0);
    expect(GAP_SEEK_EPSILON).toBeLessThan(0.2);
  });

  it("tolerates a playhead within a frame or two of a range's end", () => {
    // 30 fps capture (SPEC §6) is 33 ms per frame.
    expect(GAP_EDGE_TOLERANCE).toBeGreaterThanOrEqual(1 / 30);
    expect(GAP_EDGE_TOLERANCE).toBeLessThan(0.5);
  });

  it("calls anything less than a frame of movement a stall", () => {
    // A playing element covers a quarter second between polls, so the progress
    // threshold only has to clear timer jitter — and has to stay well under a
    // frame time, or slow playback would read as stalled.
    expect(PROGRESS_EPSILON).toBeGreaterThan(0);
    expect(PROGRESS_EPSILON).toBeLessThan(1 / 30);
  });
});
