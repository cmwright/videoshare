/**
 * Unit tests for the watch arithmetic behind playback analytics
 * (docs/SPEC.md §16.5, §16.9).
 *
 * `src/watch.ts` is pure on purpose: the viewer's beacon and the library
 * dashboard have to agree on what "watched 90% of it" means and on what a heat
 * bucket is, and the only way to hold two sides of a wire to one answer is to
 * give them one function. So both import these, and Node can test them without a
 * media element:
 *
 * ```ts
 * export function playedRanges(played: TimeRangesLike, durationMs: number): Range[];
 * export function coverage(ranges: readonly Range[], durationMs: number): number;
 * export function advance(state: HeatState, currentMs: number, durationMs: number): HeatState;
 * export function heatFromRanges(watched: readonly Range[], durationMs: number, buckets?: number): number[];
 * export function relativeHeat(payloads: readonly WatchPayload[], buckets?: number): number[];
 * export function groupByViewer(sessions: readonly WatchSession[]): ViewerReport[];
 * export function parsePayload(value: unknown): WatchPayload | null;
 * ```
 *
 * Two recurring themes below. The first is that none of this input is
 * trustworthy: `played` comes from a media element that reports seconds as
 * floats and will happily hand back a range that ends a hair before it starts,
 * and `parsePayload`'s input comes off an **unauthenticated** write endpoint
 * (§16.3), so anything holding a share link can put bytes under a video id.
 *
 * The second is that a seek must never look like watching. §16.6 renders these
 * numbers as a picture, and a picture that lies is worse than no picture — so
 * every discontinuity a viewer can produce (a scrub either way, a pause of any
 * length, a stall) is asserted to add nothing while still leaving the state able
 * to measure what comes next.
 */

import { describe, expect, it } from "vitest";
import type { TimeRangesLike } from "../src/gap";
import { formatDuration } from "../src/util";
import {
  advance,
  averageWatchedMs,
  BEACON_INTERVAL_MS,
  beginSeek,
  capRanges,
  COMPLETION_THRESHOLD,
  completionRate,
  coverage,
  createHeatState,
  endSeek,
  groupByViewer,
  HEAT_BUCKETS,
  type HeatState,
  heatFromRanges,
  heatMs,
  isCompleted,
  MAX_PLAYBACK_DELTA_MS,
  MAX_WATCH_RANGES,
  mergeRanges,
  normalizeHeat,
  parsePayload,
  peakBucket,
  playedRanges,
  type Range,
  reanchor,
  relativeHeat,
  sessionHeat,
  sumHeat,
  syncSeek,
  type WatchPayload,
  type WatchPayloadV1,
  type WatchPayloadV2,
  type WatchSession,
  watchedMs,
} from "../src/watch";

/** A stand-in for `HTMLMediaElement.played`, whose entries are in SECONDS. */
function played(...ranges: readonly (readonly [number, number])[]): TimeRangesLike {
  return {
    length: ranges.length,
    start: (index) => ranges[index][0],
    end: (index) => ranges[index][1],
  };
}

/** 50 buckets, all `ms` — one full pass of every slice of a 100 s video. */
function flat(ms: number): number[] {
  return new Array<number>(HEAT_BUCKETS).fill(ms);
}

/** A valid v1 payload, so each case can vary exactly one thing about it. */
function v1(over: Partial<WatchPayloadV1> = {}): WatchPayloadV1 {
  return {
    v: 1,
    browserId: "8f3k2Jd0QpZ1nV7xLmA9Bw",
    sessionId: "Qr4TgYs2Nb6HcE0uWkP1Zx",
    durationMs: 100_000,
    watched: [[0, 50_000]],
    completed: false,
    firstPlayedAt: "2026-08-27T21:04:00.000Z",
    ...over,
  };
}

/** A valid v2 payload — what every beacon writes today. */
function v2(over: Partial<WatchPayloadV2> = {}): WatchPayloadV2 {
  return { ...v1(), v: 2, heat: flat(0), ...over };
}

function session(payload: WatchPayload, lastModified: string): WatchSession {
  return { payload, lastModified };
}

const MINUTE = 60_000;

/** A 100 s video: 50 buckets of exactly 2 000 ms each. */
const DURATION = 100_000;
const BUCKET_MS = DURATION / HEAT_BUCKETS;

/**
 * A 27 s recording — the length the heat jitter was reported against.
 *
 * Its buckets are 540 ms, which is the interesting part: **shorter than
 * `MAX_PLAYBACK_DELTA_MS` and only about twice a foreground `timeupdate`**, so a
 * delta credited whole to one bucket cannot help but be lumpy. Most VideoShare
 * recordings are this length; the 100 s video above, whose 2 000 ms buckets
 * swallow eight steps each, is the case that hid the bug.
 */
const SHORT_DURATION = 27_000;
const SHORT_BUCKET_MS = SHORT_DURATION / HEAT_BUCKETS;

/** What a foreground tab fires `timeupdate` at, near enough (SPEC §16.5). */
const CADENCE_MS = 250;

describe("analytics constants", () => {
  it("matches the SPEC values", () => {
    expect(BEACON_INTERVAL_MS).toBe(30_000);
    expect(MAX_WATCH_RANGES).toBe(200);
    expect(COMPLETION_THRESHOLD).toBe(0.9);
    expect(HEAT_BUCKETS).toBe(50);
    expect(MAX_PLAYBACK_DELTA_MS).toBe(1_500);
  });

  it("buckets the video into whole percents", () => {
    // 50 buckets is one per 2%; a number that did not divide 100 would make the
    // heatmap's axis labels a lie.
    expect(100 % HEAT_BUCKETS).toBe(0);
  });
});

// --- Coverage: unchanged by v2 -----------------------------------------------

describe("playedRanges — what the element says, in milliseconds", () => {
  it("converts seconds to milliseconds by rounding", () => {
    expect(playedRanges(played([1.4999, 3.5001]), 10_000)).toEqual([[1500, 3500]]);
  });

  it("clamps to the video's duration at both ends", () => {
    // A media element can report a played range that runs a frame past its own
    // duration, and a negative start is not unheard of after a seek to 0.
    expect(playedRanges(played([-2, 12]), 10_000)).toEqual([[0, 10_000]]);
    expect(playedRanges(played([9.5, 10.4]), 10_000)).toEqual([[9500, 10_000]]);
  });

  it("leaves ranges unclamped when the duration is unknown", () => {
    // SPEC §16.2: durationMs is 0 when neither meta nor the element knows one.
    // Coverage will read 0, but *what* was watched is still worth recording.
    expect(playedRanges(played([0, 5]), 0)).toEqual([[0, 5000]]);
    expect(playedRanges(played([0, 5]), Number.POSITIVE_INFINITY)).toEqual([[0, 5000]]);
  });

  it("drops a range that rounds away to nothing", () => {
    // A play/pause with no frame in between: sub-millisecond, and an empty
    // range in the payload would be noise the reader has to defend against.
    expect(playedRanges(played([2.0001, 2.0002]), 10_000)).toEqual([]);
    expect(playedRanges(played([3, 3]), 10_000)).toEqual([]);
  });

  it("merges, sorts and dedupes what a scrubbing viewer produces", () => {
    // Elements list `played` in order, but a viewer who jumps around produces
    // overlaps and touching ranges either way, and a stretch watched twice is
    // still one stretch (SPEC §16.2's union semantics).
    expect(playedRanges(played([4, 6], [0, 2], [1.5, 4], [8, 9]), 20_000)).toEqual([
      [0, 6000],
      [8000, 9000],
    ]);
  });

  it("ignores a range the element reports as non-finite", () => {
    // A live MediaSource with no duration yet can hand back Infinity.
    expect(playedRanges(played([0, Number.POSITIVE_INFINITY], [2, 3]), 10_000)).toEqual([[2000, 3000]]);
    expect(playedRanges(played([Number.NaN, 1]), 10_000)).toEqual([]);
  });

  it("reports nothing at all before anything has played", () => {
    // The trigger for "no beacon": a viewer who opens a link and leaves is not
    // a session (SPEC §16.5).
    expect(playedRanges(played(), 10_000)).toEqual([]);
  });

  it("caps a wildly scrubbed session at MAX_WATCH_RANGES", () => {
    const many = Array.from(
      { length: 400 },
      (_, i) => [i * 2, i * 2 + 1] as readonly [number, number],
    );
    expect(playedRanges(played(...many), 1_000_000)).toHaveLength(MAX_WATCH_RANGES);
  });
});

describe("mergeRanges", () => {
  it("merges overlapping ranges", () => {
    expect(mergeRanges([[0, 500], [300, 900]])).toEqual([[0, 900]]);
  });

  it("merges touching ranges, because that is one stretch", () => {
    expect(mergeRanges([[0, 500], [500, 900]])).toEqual([[0, 900]]);
  });

  it("keeps a real gap", () => {
    expect(mergeRanges([[0, 500], [501, 900]])).toEqual([
      [0, 500],
      [501, 900],
    ]);
  });

  it("sorts out-of-order input", () => {
    expect(mergeRanges([[900, 1000], [0, 100], [400, 500]])).toEqual([
      [0, 100],
      [400, 500],
      [900, 1000],
    ]);
  });

  it("swallows a range contained in another", () => {
    expect(mergeRanges([[0, 1000], [200, 300]])).toEqual([[0, 1000]]);
  });

  it("drops empty, backwards and non-finite ranges", () => {
    expect(mergeRanges([[5, 5], [9, 4], [Number.NaN, 10], [0, Number.POSITIVE_INFINITY]])).toEqual([]);
  });

  it("does not mutate its input", () => {
    const input: Range[] = [[300, 900], [0, 500]];
    mergeRanges(input);
    expect(input).toEqual([[300, 900], [0, 500]]);
  });
});

describe("capRanges — closing the smallest gaps first", () => {
  it("leaves a list under the cap alone", () => {
    const ranges: Range[] = [[0, 100], [200, 300]];
    expect(capRanges(ranges, 200)).toEqual(ranges);
  });

  it("closes the narrowest gap, not the first one", () => {
    // The wide gap is the interesting one — it says a whole stretch went
    // unwatched — so it is the last thing to give.
    expect(capRanges([[0, 10], [11, 20], [100, 110]], 2)).toEqual([
      [0, 20],
      [100, 110],
    ]);
  });

  it("keeps closing until it fits", () => {
    expect(capRanges([[0, 10], [11, 20], [100, 110]], 1)).toEqual([[0, 110]]);
  });

  it("keeps the shape of the curve when it has to coalesce 400 ranges", () => {
    // 200 tight ranges, a minute of nothing, then 200 more. Everything about
    // this session that matters is that minute, and it must survive the cap.
    const ranges: Range[] = [];
    for (let i = 0; i < 200; i++) ranges.push([i * 100, i * 100 + 50]);
    for (let i = 0; i < 200; i++) ranges.push([MINUTE + i * 100, MINUTE + i * 100 + 50]);

    const capped = capRanges(ranges);
    expect(capped).toHaveLength(MAX_WATCH_RANGES);
    // The gap is still there, in one piece, and nothing was truncated: the
    // session still starts and ends where it did.
    const gaps = capped.slice(1).map((range, i) => range[0] - capped[i][1]);
    expect(Math.max(...gaps)).toBeGreaterThanOrEqual(MINUTE - 20_000);
    expect(capped[0][0]).toBe(0);
    expect(capped[capped.length - 1][1]).toBe(MINUTE + 199 * 100 + 50);
  });

  it("only ever overstates, and only by the gaps it closed", () => {
    const ranges: Range[] = Array.from({ length: 400 }, (_, i): Range => [i * 100, i * 100 + 50]);
    const capped = capRanges(ranges);

    expect(watchedMs(capped)).toBeGreaterThanOrEqual(watchedMs(ranges));
    // 200 gaps of 50 ms closed — the error is bounded and small.
    expect(watchedMs(capped) - watchedMs(ranges)).toBe(200 * 50);
  });

  it("stays sorted and disjoint, which is what the payload promises", () => {
    // Uneven gaps, so which pair coalesces first actually varies.
    const ranges: Range[] = Array.from(
      { length: 400 },
      (_, i): Range => [i * 100, i * 100 + 20 + (i % 13)],
    );
    const capped = capRanges(ranges);
    for (let i = 1; i < capped.length; i++) {
      expect(capped[i][0], `range ${i} starts after range ${i - 1} ends`).toBeGreaterThan(
        capped[i - 1][1],
      );
    }
  });

  it("never answers with nothing", () => {
    expect(capRanges([[0, 10], [20, 30]], 0)).toEqual([[0, 30]]);
    expect(capRanges([], 200)).toEqual([]);
  });
});

describe("coverage and completion", () => {
  it("is the fraction of the video seen at least once", () => {
    expect(coverage([[0, 50_000]], 100_000)).toBe(0.5);
    expect(coverage([[0, 20_000], [80_000, 100_000]], 100_000)).toBeCloseTo(0.4, 10);
  });

  it("cannot be pushed past 100% by re-watching", () => {
    // The union is why: three passes over the same minute is one minute. Heat
    // is where re-watching shows up (§16.2), and it is a different number.
    expect(coverage(mergeRanges([[0, 60_000], [0, 60_000], [0, 60_000]]), 60_000)).toBe(1);
    // ...and even an over-long range (a payload from elsewhere) is capped.
    expect(coverage([[0, 200_000]], 100_000)).toBe(1);
  });

  it("is 0 when the duration is unknown", () => {
    // SPEC §16.5: no duration means no denominator. The session still counts as
    // a session; it just cannot say what fraction it saw.
    expect(coverage([[0, 50_000]], 0)).toBe(0);
    expect(coverage([[0, 50_000]], -1)).toBe(0);
    expect(coverage([[0, 50_000]], Number.NaN)).toBe(0);
    expect(coverage([], 100_000)).toBe(0);
  });

  it("completes at the threshold, not a millisecond before", () => {
    const duration = 100_000;
    expect(isCompleted([[0, 89_999]], duration)).toBe(false);
    expect(isCompleted([[0, 90_000]], duration)).toBe(true);
    expect(isCompleted([[0, 100_000]], duration)).toBe(true);
  });

  it("counts a skipped middle, not just a reached end", () => {
    // Coverage is what was *seen*, so jumping to the last frame is not a watch.
    expect(isCompleted([[99_000, 100_000]], 100_000)).toBe(false);
    // ...while watching all but the trailing credits is.
    expect(isCompleted([[0, 91_000]], 100_000)).toBe(true);
  });

  it("is never completed without a duration", () => {
    expect(isCompleted([[0, 50_000]], 0)).toBe(false);
  });

  it("agrees with coverage by construction", () => {
    for (const ms of [0, 45_000, 89_999, 90_000, 100_000]) {
      const ranges: Range[] = ms > 0 ? [[0, ms]] : [];
      expect(isCompleted(ranges, 100_000), `${ms} ms watched`).toBe(
        coverage(ranges, 100_000) >= COMPLETION_THRESHOLD,
      );
    }
  });
});

describe("watchedMs", () => {
  it("adds up disjoint ranges", () => {
    expect(watchedMs([[0, 1000], [5000, 5500]])).toBe(1500);
    expect(watchedMs([])).toBe(0);
  });
});

// --- Heat accumulation -------------------------------------------------------

/** Feeds a run of `timeupdate` positions through `advance`, in order. */
function play(state: HeatState, durationMs: number, ...positions: readonly number[]): HeatState {
  return positions.reduce((current, ms) => advance(current, ms, durationMs), state);
}

/**
 * A stretch played straight through at 1×: `timeupdate` every `stepMs` from
 * `fromMs` to `toMs`, the first call only anchoring. This is the event stream a
 * real viewer produces, and the one the jitter showed up in.
 */
function watch(
  state: HeatState,
  durationMs: number,
  fromMs: number,
  toMs: number,
  stepMs: number = CADENCE_MS,
): HeatState {
  let current = advance(state, fromMs, durationMs);
  for (let at = fromMs + stepMs; at <= toMs; at += stepMs) {
    current = advance(current, at, durationMs);
  }
  return current;
}

/** Each bucket as a multiple of one pass through it — what §16.6's tooltip shows. */
function timesOnePass(heat: readonly number[], durationMs: number): number[] {
  const span = durationMs / HEAT_BUCKETS;
  return heat.map((ms) => ms / span);
}

describe("heat accumulation — advance", () => {
  it("starts at all zeros with no observation point", () => {
    const state = createHeatState();
    expect(state.heat).toEqual(flat(0));
    expect(state.lastMs).toBeNull();
  });

  it("takes the first call as the observation point and counts nothing", () => {
    // There is no delta yet: what came before the first `timeupdate` is not
    // this session's to claim.
    const state = advance(createHeatState(), 4000, DURATION);
    expect(state.lastMs).toBe(4000);
    expect(heatMs(state)).toEqual(flat(0));
  });

  it("credits each delta to the buckets its own span covers", () => {
    // 100 s / 50 = one bucket per 2 000 ms.
    const state = play(createHeatState(), DURATION, 0, 500, 1500, 2500);
    const heat = heatMs(state);

    expect(heat[0]).toBe(2000); // 0→500, 500→1500, and 1500→2000 of the last step
    expect(heat[1]).toBe(500); // only the 2 000→2 500 tail of it is in bucket 1
    expect(heat.reduce((sum, ms) => sum + ms, 0)).toBe(2500);
  });

  it("splits a delta that straddles a boundary in proportion to either side", () => {
    // 1 500 → 2 400 is 500 ms of bucket 0 and 400 ms of bucket 1. Crediting the
    // whole 900 to the arriving bucket is what made the heatmap jitter
    // (SPEC §16.5).
    const heat = heatMs(play(createHeatState(), DURATION, 1500, 2400));
    expect(heat[0]).toBe(500);
    expect(heat[1]).toBe(400);
  });

  it("spreads a delta that runs clean over whole buckets across all of them", () => {
    // A 1.4 s step on a 27 s video crosses four of its 540 ms buckets. Landed
    // whole it would read 2.6x in one bucket — the tall spike the owner saw.
    const heat = heatMs(play(createHeatState(), SHORT_DURATION, 10_000, 11_400));

    expect(heat[18]).toBe(260); // 10 000 → 10 260, the rest of bucket 18
    expect(heat[19]).toBe(540); // whole
    expect(heat[20]).toBe(540); // whole
    expect(heat[21]).toBe(60); // 11 340 → 11 400
    expect(heat.reduce((sum, ms) => sum + ms, 0)).toBe(1400);
    expect(Math.max(...heat)).toBeLessThanOrEqual(SHORT_BUCKET_MS);
  });

  it("conserves the delta: what a step spreads adds up to what it was", () => {
    // Splitting must not invent or lose playback time, whatever the geometry.
    for (const [from, to] of [
      [0, 1400],
      [10_000, 11_400],
      [26_800, 27_000],
      [-400, 300],
      [13_490, 13_510],
    ] as const) {
      const heat = heatMs(play(createHeatState(), SHORT_DURATION, from, to));
      const total = heat.reduce((sum, ms) => sum + ms, 0);
      expect(Math.abs(total - (to - from)), `${from}→${to}`).toBeLessThanOrEqual(1);
    }
  });

  it("counts a delta of exactly MAX_PLAYBACK_DELTA_MS and refuses one past it", () => {
    expect(heatMs(play(createHeatState(), DURATION, 0, MAX_PLAYBACK_DELTA_MS))[0]).toBe(1500);
    expect(heatMs(play(createHeatState(), DURATION, 0, MAX_PLAYBACK_DELTA_MS + 1))).toEqual(flat(0));
  });

  it("discards a forwards seek but still moves the observation point", () => {
    // 1 000 → 20 000 is a scrub, not nineteen seconds of watching. The next
    // real step must be measured from 20 000, which is what the second
    // assertion proves.
    const seeked = play(createHeatState(), DURATION, 1000, 20_000);
    expect(heatMs(seeked)).toEqual(flat(0));
    expect(seeked.lastMs).toBe(20_000);

    const heat = heatMs(advance(seeked, 20_500, DURATION));
    expect(heat[10]).toBe(500);
    expect(heat.reduce((sum, ms) => sum + ms, 0)).toBe(500);
  });

  it("discards a backwards seek but still moves the observation point", () => {
    const seeked = play(createHeatState(), DURATION, 20_000, 5000);
    expect(heatMs(seeked)).toEqual(flat(0));
    expect(seeked.lastMs).toBe(5000);

    const heat = heatMs(advance(seeked, 5400, DURATION));
    expect(heat[2]).toBe(400);
  });

  it("discards a zero-length step", () => {
    // Some browsers fire `timeupdate` on a paused element; the delta is 0 and
    // it is not playback.
    const state = play(createHeatState(), DURATION, 3000, 3000, 3000);
    expect(heatMs(state)).toEqual(flat(0));
    expect(state.lastMs).toBe(3000);
  });

  it("accumulates about twice a section's length when it is watched twice", () => {
    // The whole point of heat, and precisely what `watched` refuses to say.
    // Bucket 0 is [0, 2 000) and the viewer played exactly that stretch twice,
    // so it holds twice its own span and bucket 1 — never reached — holds none.
    let state = play(createHeatState(), DURATION, 0, 1000, 2000);
    state = reanchor(state, 0); // the viewer scrubs back to the start
    state = play(state, DURATION, 1000, 2000);

    const heat = heatMs(state);
    expect(heat[0]).toBe(2 * BUCKET_MS);
    expect(heat[1]).toBe(0);
  });

  it("credits a step ending exactly on a bucket edge to the bucket below it", () => {
    // The time was spent in [1 500, 2 000), which is bucket 0's; the arriving
    // position sits on bucket 1's floor but no part of the step was inside it.
    const heat = heatMs(play(createHeatState(), DURATION, 1500, BUCKET_MS));
    expect(heat[0]).toBe(500);
    expect(heat[1]).toBe(0);
  });

  it("credits a step starting exactly on a bucket edge to the bucket above it", () => {
    const heat = heatMs(play(createHeatState(), DURATION, BUCKET_MS, BUCKET_MS + 500));
    expect(heat[0]).toBe(0);
    expect(heat[1]).toBe(500);
  });

  it("puts the very last millisecond in bucket 49, not bucket 50", () => {
    const heat = heatMs(play(createHeatState(), DURATION, DURATION - 500, DURATION));
    expect(heat).toHaveLength(HEAT_BUCKETS);
    expect(heat[HEAT_BUCKETS - 1]).toBe(500);
  });

  it("clamps a position past the duration to the last bucket", () => {
    // An element can report a currentTime a frame past its own duration.
    const heat = heatMs(play(createHeatState(), DURATION, DURATION + 500, DURATION + 900));
    expect(heat[HEAT_BUCKETS - 1]).toBe(400);
  });

  it("clamps a negative position to the first bucket", () => {
    const heat = heatMs(play(createHeatState(), DURATION, -900, -500));
    expect(heat[0]).toBe(400);
  });

  it("accumulates nothing without a usable duration, and still advances", () => {
    for (const durationMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const state = play(createHeatState(), durationMs, 1000, 1400, 1800);
      expect(heatMs(state), String(durationMs)).toEqual(flat(0));
      expect(state.lastMs, String(durationMs)).toBe(1800);
    }
  });

  it("starts counting from the moment a duration turns up mid-playback", () => {
    // SPEC §16.5: a session that only ever learns its duration part-way through
    // accumulates from that moment on, rather than nothing at all.
    let state = play(createHeatState(), 0, 1000, 1400);
    expect(heatMs(state)).toEqual(flat(0));

    state = advance(state, 1800, DURATION);
    expect(heatMs(state)[0]).toBe(400);
  });

  it("ignores a non-finite position rather than poisoning the state", () => {
    // An element with no media loaded reports NaN; anchoring to it would make
    // every later delta NaN.
    const state = play(createHeatState(), DURATION, 1000);
    const same = advance(state, Number.NaN, DURATION);

    expect(same.lastMs).toBe(1000);
    expect(heatMs(advance(same, 1400, DURATION))[0]).toBe(400);
    expect(reanchor(state, Number.POSITIVE_INFINITY).lastMs).toBe(1000);
  });

  it("keeps accumulation in floating milliseconds and rounds only at the end", () => {
    // Rounding four times a second would drift by minutes over a long video.
    let state = advance(createHeatState(), 0, DURATION);
    for (let i = 1; i <= 1000; i++) state = advance(state, i * 0.4, DURATION);
    expect(heatMs(state)[0]).toBe(400);
  });

  it("mutates neither the state it is given nor its heat array", () => {
    const start = play(createHeatState(), DURATION, 0, 500);
    const before = [...start.heat];

    advance(start, 1000, DURATION);
    reanchor(start, 90_000);

    expect(start.lastMs).toBe(500);
    expect([...start.heat]).toEqual(before);
  });

  it("honours a bucket count of its own", () => {
    const state = play(createHeatState(4), DURATION, 0, 500, 60_000, 60_400);
    expect(heatMs(state)).toEqual([500, 0, 400, 0]);
  });
});

describe("heat accumulation — reanchor", () => {
  it("moves the observation point and touches no bucket", () => {
    const state = play(createHeatState(), DURATION, 1000, 1400);
    const moved = reanchor(state, 50_000);

    expect(moved.lastMs).toBe(50_000);
    expect(heatMs(moved)).toEqual(heatMs(state));
  });

  it("drops the delta across a pause, however long the pause was", () => {
    // `beacon.ts` re-anchors on `play`; the video sat still, so nothing about
    // that stretch was watched.
    let state = play(createHeatState(), DURATION, 0, 1000);
    state = reanchor(state, 1000); // resumed where it stopped, an hour later
    state = advance(state, 1400, DURATION);

    expect(heatMs(state)[0]).toBe(1400);
  });

  it("drops the delta across a scrub, so scrubbing adds ~nothing", () => {
    // `seeking`/`seeked` both re-anchor: even a scrub whose landing is within
    // MAX_PLAYBACK_DELTA_MS of where it left costs its delta.
    let state = play(createHeatState(), DURATION, 0, 1000);
    state = reanchor(state, 1900); // seeking
    state = reanchor(state, 90_000); // seeked, somewhere else entirely
    state = advance(state, 90_300, DURATION);

    const heat = heatMs(state);
    expect(heat[0]).toBe(1000);
    expect(heat[45]).toBe(300);
    expect(heat.reduce((sum, ms) => sum + ms, 0)).toBe(1300);
  });

  it("keeps a seek in flight across a re-anchor, so a `play` mid-drag is not an opening", () => {
    // `beacon.ts` re-anchors on `play`, and a viewer can hit play with the
    // scrubber still held. Only `seeked` ends a seek.
    const state = reanchor(beginSeek(createHeatState()), 5000);
    expect(state.seeking).toBe(true);
    expect(heatMs(advance(state, 5300, DURATION))).toEqual(flat(0));
  });
});

// --- The two defects behind the reported heatmap jitter ----------------------

describe("heat accumulation — a steady 1x watch is flat, not sawtoothed", () => {
  it("gives every bucket its own span for a straight-through 1x play", () => {
    // The reported bug. A 27 s video has 540 ms buckets and a foreground tab
    // steps 250 ms, so crediting each step whole to its arriving bucket handed
    // buckets 2 or 3 steps at random — 500 ms next to 750 ms, a ±39% sawtooth
    // in a picture that should have been flat.
    const state = watch(createHeatState(), SHORT_DURATION, 0, SHORT_DURATION);
    const heat = heatMs(state);

    expect(heat.reduce((sum, ms) => sum + ms, 0)).toBe(SHORT_DURATION);
    for (const [bucket, ms] of heat.entries()) {
      expect(Math.abs(ms - SHORT_BUCKET_MS), `bucket ${bucket}`).toBeLessThanOrEqual(1);
    }
  });

  it("reads 1.0x everywhere after one pass, whatever the cadence", () => {
    // A throttled tab, a 2x listen and a foreground tab all step differently;
    // none of them should change the *shape* of one pass through the video.
    for (const step of [100, 250, 400, 500, 1000, 1400]) {
      const heat = heatMs(watch(createHeatState(), SHORT_DURATION, 0, SHORT_DURATION, step));
      const peak = Math.max(...timesOnePass(heat, SHORT_DURATION));
      expect(peak, `${step} ms cadence`).toBeLessThanOrEqual(1.02);
    }
  });

  it("stays flat on a duration whose buckets do not divide the cadence evenly", () => {
    // 41 s / 50 = 820 ms against a 250 ms step: 3.28 steps a bucket, so the old
    // rule alternated 3 and 4 steps forever.
    const heat = heatMs(watch(createHeatState(), 41_000, 0, 41_000));
    const span = 41_000 / HEAT_BUCKETS;
    for (const [bucket, ms] of heat.entries()) {
      expect(Math.abs(ms - span), `bucket ${bucket}`).toBeLessThanOrEqual(1);
    }
  });
});

describe("heat accumulation — a seek in flight", () => {
  /** The drag the owner's screenshot came from: 0→5 s watched, then scrubbed to the end. */
  function scrubbedToTheEnd(state: HeatState): HeatState {
    let current = beginSeek(state);
    // While the pointer is down the element reports the positions it is being
    // dragged over. Hops small enough to pass for playback are the leak.
    for (let at = 5800; at <= 22_000; at += 800) current = advance(current, at, SHORT_DURATION);
    return endSeek(current, 22_000);
  }

  it("accumulates nothing over a span the viewer only scanned", () => {
    const watched = watch(createHeatState(), SHORT_DURATION, 0, 5000);
    const before = heatMs(watched);
    const after = heatMs(scrubbedToTheEnd(watched));

    // Not "a bit less than a watch" — nothing at all. The viewer saw thumbnails.
    expect(after).toEqual(before);
    expect(after.slice(10)).toEqual(new Array<number>(HEAT_BUCKETS - 10).fill(0));
  });

  it("stays suppressed through the repeated seeking events one drag fires", () => {
    // A drag is not one seek: the element starts a new one on every pointer
    // move and only fires `seeked` when the drag settles.
    let state = watch(createHeatState(), SHORT_DURATION, 0, 5000);
    const before = heatMs(state);

    for (let at = 5800; at <= 22_000; at += 800) {
      state = beginSeek(state); // another `seeking`, mid-drag
      state = advance(state, at, SHORT_DURATION);
    }
    state = endSeek(state, 22_000);

    expect(heatMs(state)).toEqual(before);
    expect(state.seeking).toBe(false);
  });

  it("resumes measuring from where the seek landed", () => {
    const state = scrubbedToTheEnd(watch(createHeatState(), SHORT_DURATION, 0, 5000));
    expect(state.seeking).toBe(false);
    expect(state.lastMs).toBe(22_000);

    const heat = heatMs(advance(state, 22_400, SHORT_DURATION));
    expect(heat[40]).toBe(140); // bucket 40 is [21 600, 22 140): 22 000 → 22 140
    expect(heat[41]).toBe(260); // bucket 41 takes the rest, 22 140 → 22 400
    // The step counted for 400 ms and the scanned span still holds nothing.
    expect(heat.slice(10, 40)).toEqual(new Array<number>(30).fill(0));
  });

  it("keeps the observation point moving while it suppresses", () => {
    // Suppression must not leave the anchor stale: a `seeked` the element never
    // delivers would otherwise make the next real step a 17-second fiction.
    const state = advance(beginSeek(reanchor(createHeatState(), 5000)), 5300, SHORT_DURATION);
    expect(state.lastMs).toBe(5300);
    expect(heatMs(state)).toEqual(flat(0));
  });

  it("ends the seek even when the element reports a landing it cannot use", () => {
    // Never leave suppression stuck on: a NaN landing keeps the old anchor but
    // still clears the flag, or the session would silently record no heat.
    const state = endSeek(beginSeek(reanchor(createHeatState(), 5000)), Number.NaN);
    expect(state.seeking).toBe(false);
    expect(state.lastMs).toBe(5000);
  });

  it("leaves the whole reported session reading 1x, with no spike", () => {
    // End to end: watch 5 s, drag over the rest of the video to the end and
    // back, then watch the last 5 s out. The heatmap this produced had the end
    // at ~2x and one bucket at 3.9x, though nothing was rewatched.
    let state = watch(createHeatState(), SHORT_DURATION, 0, 5000);

    state = beginSeek(state);
    for (let at = 6400; at <= 26_000; at += 1400) state = advance(state, at, SHORT_DURATION);
    for (const at of [26_200, 26_500, 26_900, 22_000, 22_200, 22_400]) {
      state = advance(state, at, SHORT_DURATION);
    }
    state = endSeek(state, 22_400);

    state = watch(state, SHORT_DURATION, 22_400, SHORT_DURATION);

    const times = timesOnePass(heatMs(state), SHORT_DURATION);
    // Nothing was watched twice, so nothing may read as watched twice.
    expect(Math.max(...times)).toBeLessThanOrEqual(1.02);
    // The two stretches actually played read as one pass each...
    for (const bucket of [0, 4, 8, 44, 48]) expect(times[bucket]).toBeCloseTo(1, 2);
    // ...and the middle the viewer only scanned reads as nothing.
    for (const bucket of [15, 25, 35]) expect(times[bucket]).toBe(0);
  });
});

describe("heat accumulation — a seek that never ends", () => {
  /** A drag left hanging: `seeking` fired, the positions scanned past, no `seeked`. */
  function dragging(state: HeatState): HeatState {
    let current = beginSeek(state);
    for (let at = 5800; at <= 22_000; at += 800) current = advance(current, at, SHORT_DURATION);
    return current;
  }

  it("recovers when the element never delivers the `seeked`", () => {
    // `seeked` is the only event that ends a seek, so one that is dropped
    // would suppress every remaining delta of the session — and invisibly,
    // because `watched`, coverage and `completed` come off `video.played` and
    // stay exactly right while the heatmap goes to zero.
    const watched = watch(createHeatState(), SHORT_DURATION, 0, 5000);
    const before = heatMs(watched);

    // Without the guard, the same stream after the lost event counts nothing.
    const stuck = watch(dragging(watched), SHORT_DURATION, 22_000, 26_000);
    expect(heatMs(stuck)).toEqual(before);

    // With it, the element's own `seeking` reading false ends the seek at the
    // position it landed on, and playback carries on from there.
    const resumed = syncSeek(dragging(watched), false, 22_000);
    expect(resumed.seeking).toBe(false);
    expect(resumed.lastMs).toBe(22_000);

    const times = timesOnePass(heatMs(watch(resumed, SHORT_DURATION, 22_000, 26_000)), SHORT_DURATION);
    // 22 s → 26 s reads as one pass, and the scanned middle still as nothing.
    for (const bucket of [43, 46]) expect(times[bucket]).toBeCloseTo(1, 2);
    for (const bucket of [15, 25, 35]) expect(times[bucket]).toBe(0);
  });

  it("recovers from a mid-session `load()`, which clears seeking and fires nothing", () => {
    // The media load algorithm clears `seeking` without a `seeked` and resets
    // `currentTime` to 0 — a backwards step `advance` discards on its own. The
    // flag is the only thing that would have stayed stuck.
    const state = syncSeek(dragging(watch(createHeatState(), SHORT_DURATION, 0, 5000)), false, 0);
    expect(state.seeking).toBe(false);
    expect(state.lastMs).toBe(0);

    const times = timesOnePass(heatMs(watch(state, SHORT_DURATION, 0, 2000)), SHORT_DURATION);
    expect(times[1]).toBeCloseTo(2, 2); // played once before the reload and once after
  });

  it("does nothing while the element says the seek is still in flight", () => {
    // The guard runs on every `timeupdate`, including the ones a drag fires,
    // and must not reopen the leak suppression exists to close.
    const watched = watch(createHeatState(), SHORT_DURATION, 0, 5000);
    let state = beginSeek(watched);
    for (let at = 5800; at <= 22_000; at += 800) {
      state = syncSeek(state, true, at);
      state = advance(state, at, SHORT_DURATION);
    }

    expect(state.seeking).toBe(true);
    expect(heatMs(state)).toEqual(heatMs(watched));
  });

  it("leaves an ordinary step alone, anchor included", () => {
    // With no seek in flight it is the identity. Re-anchoring here would
    // swallow the delta of every step it ran before — the whole session.
    const state = watch(createHeatState(), SHORT_DURATION, 0, 5000);
    expect(syncSeek(state, false, 99_000)).toBe(state);
    expect(syncSeek(state, true, 99_000)).toBe(state);

    const guarded = advance(syncSeek(state, false, 5250), 5250, SHORT_DURATION);
    expect(heatMs(guarded)).toEqual(heatMs(advance(state, 5250, SHORT_DURATION)));
  });

  it("lands where the `seeked` would have, when the event does arrive", () => {
    // A conforming browser clears `seeking`, queues `timeupdate`, then queues
    // `seeked`, so the guard always ends a real seek one task early — at the
    // position the event is about to report. Nothing may change hands.
    const dragged = dragging(watch(createHeatState(), SHORT_DURATION, 0, 5000));
    const early = advance(syncSeek(dragged, false, 22_000), 22_000, SHORT_DURATION);

    expect(endSeek(early, 22_000)).toEqual(endSeek(dragged, 22_000));
  });
});

// --- v1 compatibility --------------------------------------------------------

describe("heatFromRanges — a v1 session's heat, derived", () => {
  it("gives a bucket its exact overlap with the union", () => {
    const heat = heatFromRanges([[4000, 6000]], DURATION);
    expect(heat[2]).toBe(BUCKET_MS);
    expect(heat.filter((ms) => ms > 0)).toHaveLength(1);
  });

  it("splits a range that straddles a boundary", () => {
    const heat = heatFromRanges([[1000, 3000]], DURATION);
    expect(heat[0]).toBe(1000);
    expect(heat[1]).toBe(1000);
  });

  it("counts a range that ends on the duration itself", () => {
    // The last bucket ends on `durationMs` inclusive, so watching to the final
    // millisecond cannot fall off the end of the array.
    const heat = heatFromRanges([[98_000, DURATION]], DURATION);
    expect(heat[HEAT_BUCKETS - 1]).toBe(BUCKET_MS);
    expect(heat[HEAT_BUCKETS - 2]).toBe(0);
  });

  it("never exceeds one bucket span — v1 reads as 1x at most", () => {
    // The union is disjoint by construction, so this is a property, not a
    // clamp: a v1 payload cannot know it was replayed (SPEC §16.2).
    for (const watched of [
      [[0, DURATION]] as Range[],
      [[0, DURATION * 2]] as Range[],
      [[0, 20_000], [20_000, 40_000]] as Range[],
    ]) {
      for (const ms of heatFromRanges(watched, DURATION)) {
        expect(ms).toBeLessThanOrEqual(BUCKET_MS);
      }
    }
  });

  it("lights every bucket for a session that watched the whole video", () => {
    expect(heatFromRanges([[0, DURATION]], DURATION)).toEqual(flat(BUCKET_MS));
  });

  it("leaves the gaps a viewer skipped empty", () => {
    const heat = heatFromRanges([[0, 20_000], [80_000, DURATION]], DURATION);
    expect(heat[9]).toBe(BUCKET_MS);
    expect(heat[10]).toBe(0);
    expect(heat[39]).toBe(0);
    expect(heat[40]).toBe(BUCKET_MS);
  });

  it("is all zeros without a usable duration", () => {
    for (const durationMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(heatFromRanges([[0, 5000]], durationMs), String(durationMs)).toEqual(flat(0));
    }
  });

  it("honours a bucket count of its own", () => {
    expect(heatFromRanges([[0, 25_000]], DURATION, 4)).toEqual([25_000, 0, 0, 0]);
    expect(heatFromRanges([], DURATION, 4)).toEqual([0, 0, 0, 0]);
  });
});

describe("sessionHeat — the one place the version matters", () => {
  it("returns a v2 payload's heat as it was sent", () => {
    const heat = flat(0);
    heat[3] = 7777;
    expect(sessionHeat(v2({ heat }))).toEqual(heat);
  });

  it("does not alias a v2 payload's heat array", () => {
    const payload = v2();
    sessionHeat(payload)[0] = 999;
    expect(payload.heat[0]).toBe(0);
  });

  it("derives a v1 payload's heat from its watch union", () => {
    expect(sessionHeat(v1({ watched: [[0, DURATION]] }))).toEqual(flat(BUCKET_MS));
    expect(sessionHeat(v1({ watched: [[4000, 6000]] }))).toEqual(
      heatFromRanges([[4000, 6000]], DURATION),
    );
  });

  it("reads a v1 session that replayed a section as watched-once, not twice", () => {
    // A v1 payload has no way to know, and inventing intensity it never
    // measured would be the picture lying (SPEC §16.2).
    const replayed = sessionHeat(v1({ watched: [[0, 4000]] }));
    expect(replayed[0]).toBe(BUCKET_MS);
    expect(replayed[1]).toBe(BUCKET_MS);
  });

  it("gives every payload the same shape, whatever its version", () => {
    expect(sessionHeat(v1())).toHaveLength(HEAT_BUCKETS);
    expect(sessionHeat(v2())).toHaveLength(HEAT_BUCKETS);
  });
});

// --- Aggregation -------------------------------------------------------------

describe("sumHeat", () => {
  it("adds sessions bucket by bucket", () => {
    const a = flat(0);
    a[0] = 1000;
    const b = flat(0);
    b[0] = 500;
    b[49] = 250;

    const total = sumHeat([v2({ heat: a }), v2({ heat: b })]);
    expect(total[0]).toBe(1500);
    expect(total[49]).toBe(250);
  });

  it("stacks sessions of differing durations, because a bucket is 2% of each", () => {
    // A ten-second video and a ten-minute one both have a "halfway", and the
    // heatmap is about shape, not seconds.
    const short = v1({ durationMs: 10_000, watched: [[0, 5000]] });
    const long = v1({ durationMs: 600_000, watched: [[0, 300_000]] });

    const total = sumHeat([short, long]);
    expect(total[0]).toBe(200 + 12_000);
    expect(total[24]).toBe(200 + 12_000);
    expect(total[25]).toBe(0);
  });

  it("mixes v1 and v2 sessions without either knowing", () => {
    const heat = flat(0);
    heat[0] = 5000;
    const total = sumHeat([v2({ heat }), v1({ watched: [[0, BUCKET_MS]] })]);
    expect(total[0]).toBe(5000 + BUCKET_MS);
  });

  it("answers a whole array for no sessions at all", () => {
    expect(sumHeat([])).toEqual(flat(0));
  });
});

describe("relativeHeat — the x-against-one-pass number", () => {
  it("reads 1.0 for a bucket every session played exactly once through", () => {
    const sessions = [v2({ heat: flat(BUCKET_MS) }), v2({ heat: flat(BUCKET_MS) })];
    for (const times of relativeHeat(sessions)) expect(times).toBeCloseTo(1, 10);
  });

  it("reads 1.0 for a bucket half the sessions played twice", () => {
    // The denominator is one pass per session, so the same total time spread
    // over half the sessions is still one pass on average (SPEC §16.5).
    const twice = flat(0);
    twice[7] = BUCKET_MS * 2;

    const sessions = [v2({ heat: twice }), v2({ heat: twice }), v2(), v2()];
    expect(relativeHeat(sessions)[7]).toBeCloseTo(1, 10);
  });

  it("reads 2.4 for a bucket the sessions played about two and a half times", () => {
    const heat = flat(0);
    heat[12] = BUCKET_MS * 2.4;
    expect(relativeHeat([v2({ heat })])[12]).toBeCloseTo(2.4, 10);
  });

  it("matches bucketMs / (sessions x bucketDurationMs) for equal durations", () => {
    const heat = flat(0);
    heat[3] = 9000;
    const sessions = [v2({ heat }), v2({ heat }), v2({ heat })];

    expect(relativeHeat(sessions)[3]).toBeCloseTo(
      (9000 * 3) / (3 * BUCKET_MS),
      10,
    );
  });

  it("stays honest when the durations differ", () => {
    // One pass of bucket 0 for each: 200 ms for the short video, 12 000 ms for
    // the long one. Both played it once, so the answer is 1.0 — not whatever a
    // single video's length would have said.
    const short = v1({ durationMs: 10_000, watched: [[0, 200]] });
    const long = v1({ durationMs: 600_000, watched: [[0, 12_000]] });
    expect(relativeHeat([short, long])[0]).toBeCloseTo(1, 10);
  });

  it("excludes sessions with no known duration from both sides", () => {
    const heat = flat(0);
    heat[5] = BUCKET_MS;
    const timed = [v2({ heat })];

    const before = relativeHeat(timed);
    // Its own heat is zeros by §16.5 — and even a hand-written one carrying
    // numbers is excluded, because there is no duration to divide by.
    const untimed = v2({ durationMs: 0, heat: flat(99_999) });
    expect(relativeHeat([...timed, untimed])).toEqual(before);
    expect(before[5]).toBeCloseTo(1, 10);
  });

  it("is all zeros when nothing has a duration at all", () => {
    expect(relativeHeat([v2({ durationMs: 0 }), v1({ durationMs: 0 })])).toEqual(flat(0));
    expect(relativeHeat([])).toEqual(flat(0));
  });
});

describe("normalizeHeat — the height channel", () => {
  it("puts the largest bucket at 1 and the rest in proportion", () => {
    expect(normalizeHeat([0, 250, 500, 1000])).toEqual([0, 0.25, 0.5, 1]);
  });

  it("is all zeros for an all-zero input", () => {
    // No division, and 50 bars still get drawn — as hairlines.
    expect(normalizeHeat(flat(0))).toEqual(flat(0));
    expect(normalizeHeat([])).toEqual([]);
  });

  it("is not relativeHeat: it shows shape, not intensity", () => {
    // Two sessions that both played the second half twice. Height says "this
    // half is where the attention was"; the x number says how much.
    const heat = flat(0);
    for (let b = 25; b < HEAT_BUCKETS; b++) heat[b] = BUCKET_MS * 2;

    expect(normalizeHeat(heat)[25]).toBe(1);
    expect(relativeHeat([v2({ heat })])[25]).toBeCloseTo(2, 10);
  });
});

describe("groupByViewer", () => {
  const alice = "8f3k2Jd0QpZ1nV7xLmA9Bw";
  const bob = "Qr4TgYs2Nb6HcE0uWkP1Zx";

  it("collapses one browser's repeat viewings into one viewer", () => {
    const viewers = groupByViewer([
      session(v1({ browserId: alice, sessionId: "a1", watched: [[0, 10_000]] }), "2026-08-27T10:00:00.000Z"),
      session(v1({ browserId: alice, sessionId: "a2", watched: [[0, 20_000]] }), "2026-08-27T12:00:00.000Z"),
    ]);

    expect(viewers).toHaveLength(1);
    expect(viewers[0].browserId).toBe(alice);
    expect(viewers[0].plays).toBe(2);
    expect(viewers[0].lastWatched).toBe("2026-08-27T12:00:00.000Z");
  });

  it("sums a viewer's sessions bucket by bucket", () => {
    const heat = flat(0);
    heat[0] = 1000;
    const viewers = groupByViewer([
      session(v2({ browserId: alice, heat }), "2026-08-27T10:00:00.000Z"),
      session(v2({ browserId: alice, heat }), "2026-08-27T11:00:00.000Z"),
    ]);
    expect(viewers[0].heat[0]).toBe(2000);
  });

  it("takes the best coverage, not the last", () => {
    // Someone who watched it all on Tuesday and opened it for ten seconds on
    // Friday has seen the video.
    const viewers = groupByViewer([
      session(v1({ browserId: alice, watched: [[0, 95_000]] }), "2026-08-25T10:00:00.000Z"),
      session(v1({ browserId: alice, watched: [[0, 10_000]] }), "2026-08-28T10:00:00.000Z"),
    ]);
    expect(viewers[0].coverage).toBeCloseTo(0.95, 10);
  });

  it("reports null coverage when no session of theirs has a duration", () => {
    const viewers = groupByViewer([
      session(v1({ browserId: alice, durationMs: 0, watched: [[0, 10_000]] }), "2026-08-27T10:00:00.000Z"),
    ]);
    expect(viewers[0].coverage).toBeNull();
  });

  it("orders by last activity, most recent first", () => {
    const viewers = groupByViewer([
      session(v1({ browserId: alice }), "2026-08-26T10:00:00.000Z"),
      session(v1({ browserId: bob }), "2026-08-28T10:00:00.000Z"),
    ]);
    expect(viewers.map((viewer) => viewer.browserId)).toEqual([bob, alice]);
  });

  it("breaks a tie on browserId, so the order is deterministic", () => {
    const at = "2026-08-27T10:00:00.000Z";
    const viewers = groupByViewer([
      session(v1({ browserId: bob }), at),
      session(v1({ browserId: alice }), at),
    ]);
    // "8f3k…" sorts before "Qr4T…" — and would either way, every run.
    expect(viewers.map((viewer) => viewer.browserId)).toEqual([alice, bob]);
  });

  it("refuses to collapse a malformed browserId with anything", () => {
    // Junk written through the unauthenticated endpoint must not be able to
    // make a video look less watched than it is (SPEC §16.5).
    const viewers = groupByViewer([
      session(v1({ browserId: "", sessionId: "s1" }), "2026-08-27T10:00:00.000Z"),
      session(v1({ browserId: "", sessionId: "s2" }), "2026-08-27T11:00:00.000Z"),
      session(v1({ browserId: "not-an-id", sessionId: "s3" }), "2026-08-27T12:00:00.000Z"),
    ]);

    expect(viewers).toHaveLength(3);
    expect(viewers.every((viewer) => viewer.plays === 1)).toBe(true);
    // ...and reports what it was actually given, verbatim.
    expect(viewers.map((viewer) => viewer.browserId).sort()).toEqual(["", "", "not-an-id"]);
  });

  it("survives a lastModified it cannot parse", () => {
    const viewers = groupByViewer([
      session(v1({ browserId: alice }), "not a date"),
      session(v1({ browserId: bob }), "2026-08-28T10:00:00.000Z"),
    ]);
    expect(viewers.map((viewer) => viewer.browserId)).toEqual([bob, alice]);
  });

  it("answers nothing for no sessions", () => {
    expect(groupByViewer([])).toEqual([]);
  });
});

// --- Parsing -----------------------------------------------------------------

describe("parsePayload — nothing from the wire is trusted", () => {
  it("accepts what a beacon actually sends, through JSON", () => {
    const sent = v2();
    expect(parsePayload(JSON.parse(JSON.stringify(sent)) as unknown)).toEqual(sent);
  });

  it("still accepts a v1 payload, and always will", () => {
    const sent = v1();
    expect(parsePayload(JSON.parse(JSON.stringify(sent)) as unknown)).toEqual(sent);
  });

  it("keeps only the fields the format defines", () => {
    const parsed = parsePayload({ ...v2(), ip: "203.0.113.7", extra: true });
    expect(parsed).not.toBeNull();
    expect(Object.keys(parsed as WatchPayload).sort()).toEqual([
      "browserId",
      "completed",
      "durationMs",
      "firstPlayedAt",
      "heat",
      "sessionId",
      "v",
      "watched",
    ]);
  });

  it("ignores a stray heat on a v1 payload", () => {
    // A v1 object carrying one is still a v1 payload; the field is ignored,
    // like every other unknown field (SPEC §16.2).
    const parsed = parsePayload({ ...v1(), heat: flat(1234) });
    expect(parsed).toEqual(v1());
    expect(Object.keys(parsed as WatchPayload)).not.toContain("heat");
  });

  it("rejects a version it does not understand", () => {
    for (const v of [0, 3, "2", "1", 1.5, null, undefined]) {
      expect(parsePayload({ ...v2(), v }), JSON.stringify(v)).toBeNull();
    }
  });

  it("requires a v2 heat of exactly HEAT_BUCKETS entries", () => {
    for (const heat of [flat(0).slice(1), [...flat(0), 0], [], undefined]) {
      expect(parsePayload({ ...v2(), heat }), `${String(heat?.length)} entries`).toBeNull();
    }
    expect(parsePayload({ ...v2(), heat: flat(0) })).not.toBeNull();
  });

  it("requires every heat bucket to be a whole, non-negative number", () => {
    for (const bad of [1.5, -1, "1000", null, Number.NaN, Number.POSITIVE_INFINITY]) {
      const heat: unknown[] = flat(0);
      heat[17] = bad;
      expect(parsePayload({ ...v2(), heat }), JSON.stringify(bad)).toBeNull();
    }
  });

  it("rejects a heat that is not an array", () => {
    for (const heat of [{}, "0".repeat(HEAT_BUCKETS), 0]) {
      expect(parsePayload({ ...v2(), heat }), JSON.stringify(heat)).toBeNull();
    }
  });

  it("accepts an all-zero heat, which a session with no duration sends", () => {
    expect(parsePayload({ ...v2(), durationMs: 0, heat: flat(0) })).not.toBeNull();
  });

  it("rejects a missing or mistyped field rather than filling a default", () => {
    for (const key of [
      "browserId",
      "sessionId",
      "durationMs",
      "watched",
      "completed",
      "firstPlayedAt",
    ] as const) {
      const missing: Record<string, unknown> = { ...v2() };
      delete missing[key];
      expect(parsePayload(missing), `missing ${key}`).toBeNull();
    }
    expect(parsePayload({ ...v2(), completed: "yes" })).toBeNull();
    expect(parsePayload({ ...v2(), browserId: 7 })).toBeNull();
    expect(parsePayload({ ...v2(), firstPlayedAt: 1_756_328_640_000 })).toBeNull();
  });

  it("rejects milliseconds that are not whole and non-negative", () => {
    for (const durationMs of [1.5, -1, Number.NaN, Number.POSITIVE_INFINITY, "100000", null]) {
      expect(parsePayload({ ...v2(), durationMs }), JSON.stringify(durationMs)).toBeNull();
    }
    expect(parsePayload({ ...v2(), watched: [[0, 1.5]] })).toBeNull();
    expect(parsePayload({ ...v2(), watched: [[-1, 100]] })).toBeNull();
  });

  it("rejects ranges that are not ranges", () => {
    for (const watched of [
      "0-100",
      {},
      [[0]],
      [[0, 100, 200]],
      [[100, 0]],
      [[100, 100]],
      [["0", "100"]],
      [null],
    ]) {
      expect(parsePayload({ ...v2(), watched }), JSON.stringify(watched)).toBeNull();
    }
  });

  it("rejects unsorted or overlapping ranges", () => {
    // A beacon merges before it sends (§16.2), so anything else is either a bug
    // or someone hand-writing objects into the bucket — and overlap would
    // double-count watch time.
    expect(parsePayload({ ...v2(), watched: [[5000, 6000], [0, 1000]] })).toBeNull();
    expect(parsePayload({ ...v2(), watched: [[0, 5000], [4000, 6000]] })).toBeNull();
    // Touching is tolerated: it covers exactly the same milliseconds.
    expect(parsePayload({ ...v2(), watched: [[0, 5000], [5000, 6000]] })).not.toBeNull();
  });

  it("accepts an empty watch list and a zero duration", () => {
    // Neither is what a beacon sends, but both are internally consistent, and
    // the dashboard handles them (a session with no known duration).
    expect(parsePayload({ ...v2(), watched: [] })).not.toBeNull();
    expect(parsePayload({ ...v2(), durationMs: 0, watched: [[0, 5000]] })).not.toBeNull();
  });

  it("returns null rather than throwing, whatever it is handed", () => {
    for (const value of [null, undefined, 42, "…", true, [], [v2()], new Date()]) {
      expect(parsePayload(value), JSON.stringify(value)).toBeNull();
    }
  });

  it("does not alias the object it was given", () => {
    // The dashboard holds these for the life of the page; a parsed payload must
    // not keep a live reference into JSON.parse's output.
    const raw = v2();
    const parsed = parsePayload(raw) as WatchPayloadV2;
    raw.watched[0][1] = 1;
    raw.heat[0] = 1;

    expect(parsed.watched[0][1]).toBe(50_000);
    expect(parsed.heat[0]).toBe(0);
  });
});

/**
 * The engagement figures the video page puts on its stat cards and under its
 * heatmap (SPEC §17.6). They are arithmetic, so they live in `watch.ts` and are
 * tested here rather than being discovered by looking at a rendered page.
 */
describe("completionRate — the stat card", () => {
  it("is the fraction of sessions the viewer's own browser called complete", () => {
    // The payload's own flag, never recomputed here: the number the page shows
    // is the number the beacon decided, which is what makes the two sides agree.
    const payloads = [
      v2({ completed: true }),
      v2({ completed: true }),
      v2({ completed: false }),
      v2({ completed: false }),
    ];
    expect(completionRate(payloads)).toBe(0.5);
  });

  it("reads 1 when every session finished and 0 when none did", () => {
    expect(completionRate([v2({ completed: true }), v2({ completed: true })])).toBe(1);
    expect(completionRate([v2({ completed: false })])).toBe(0);
  });

  it("is null with no sessions at all, so the card reads — rather than 0%", () => {
    expect(completionRate([])).toBeNull();
  });

  it("counts a session with no known duration on both sides of the ratio", () => {
    // The case where the only two defensible readings disagree, pinned to
    // SPEC §16.5: the denominator is `payloads.length`, not the timed subset.
    // `completed` is the beacon's own resolved flag, and reading it needs no
    // duration — so an untimed session the viewer did not finish is a session
    // that did not complete, not a session to drop from the question.
    const payloads = [
      v2({ completed: true, durationMs: DURATION }),
      v2({ completed: false, durationMs: 0 }),
    ];
    expect(completionRate(payloads)).toBe(0.5);
  });

  it("stays non-null when no session is timed, unlike averageWatchedMs", () => {
    // The two figures deliberately part company here: a count over a count is
    // still answerable with no duration anywhere, while a mean of durations is
    // not (§16.5).
    const untimed = [v2({ completed: true, durationMs: 0 }), v2({ completed: false, durationMs: 0 })];
    expect(completionRate(untimed)).toBe(0.5);
    expect(averageWatchedMs(untimed)).toBeNull();
  });
});

describe("averageWatchedMs — the stat card", () => {
  it("averages the watch union over the sessions with a known duration", () => {
    const payloads = [
      v2({ watched: [[0, 50_000]] }),
      v2({ watched: [[0, 10_000], [20_000, 30_000]] }),
    ];
    // 50 000 and 20 000 milliseconds seen: the mean is 35 s, and that is what
    // formatDuration turns into the card's "0:35".
    expect(averageWatchedMs(payloads)).toBe(35_000);
    expect(formatDuration(averageWatchedMs(payloads) as number)).toBe("0:35");
  });

  it("is a union, so watching the same minute twice contributes one minute", () => {
    // `watched` is merged and disjoint by contract (§16.2). A session that
    // played 0–60 s three times still says it saw 60 s of video, which is
    // exactly what `coverage` means, expressed in time.
    const replayed = v2({
      watched: [[0, 60_000]],
      durationMs: 120_000,
      heat: flat(3 * (120_000 / HEAT_BUCKETS)),
    });
    expect(averageWatchedMs([replayed])).toBe(60_000);
  });

  it("ignores an untimed session on BOTH sides of the division", () => {
    const timed = [v2({ watched: [[0, 50_000]] }), v2({ watched: [[0, 20_000]] })];
    expect(averageWatchedMs(timed)).toBe(35_000);

    // A session that never learned its duration knows how long it watched but
    // not what fraction that was; counting it in the denominator alone would
    // report an average lower than any session in the list.
    const withUntimed = [...timed, v2({ durationMs: 0, watched: [[0, 90_000]] })];
    expect(averageWatchedMs(withUntimed)).toBe(35_000);
  });

  it("is null when no payload has a duration", () => {
    expect(averageWatchedMs([])).toBeNull();
    expect(averageWatchedMs([v2({ durationMs: 0, watched: [[0, 5_000]] })])).toBeNull();
  });
});

describe("peakBucket — the heatmap's caption", () => {
  it("finds the most replayed bucket and its × against a single pass", () => {
    // One 100 s session that played every bucket once, and bucket 18 — 36 s in —
    // 2.2 times.
    const heat = flat(BUCKET_MS);
    heat[18] = 2.2 * BUCKET_MS;

    const peak = peakBucket([v2({ heat })]);
    expect(peak).toEqual({ index: 18, times: 2.2 });

    // What §17.6 writes from it: the bucket's *start*, which is the position a
    // reader would scrub to.
    const { index, times } = peak as { index: number; times: number };
    expect(`peak ${times.toFixed(1)}× at ${formatDuration((index * DURATION) / HEAT_BUCKETS)}`).toBe(
      "peak 2.2× at 0:36",
    );
  });

  it("takes the lowest index on a tie, so the answer is deterministic", () => {
    const heat = flat(0);
    heat[7] = 3 * BUCKET_MS;
    heat[31] = 3 * BUCKET_MS;
    expect(peakBucket([v2({ heat })])).toEqual({ index: 7, times: 3 });
  });

  it("reads a v1 session through its derived heat", () => {
    // No `heat` field at all: the first half of the video, once through, which
    // makes every bucket up to the halfway point exactly one pass.
    const peak = peakBucket([v1({ watched: [[0, 50_000]] })]);
    expect(peak).toEqual({ index: 0, times: 1 });
  });

  it("is null when nothing was watched, so the caption is omitted", () => {
    // Not "peak 0.0× at 0:00": with no heat there is no peak to name.
    expect(peakBucket([])).toBeNull();
    expect(peakBucket([v2({ heat: flat(0) })])).toBeNull();
    // And with no duration there is no denominator either.
    expect(peakBucket([v2({ durationMs: 0, heat: flat(0) })])).toBeNull();
  });
});
