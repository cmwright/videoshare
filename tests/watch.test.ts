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
import {
  advance,
  BEACON_INTERVAL_MS,
  capRanges,
  COMPLETION_THRESHOLD,
  coverage,
  createHeatState,
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
  playedRanges,
  type Range,
  reanchor,
  relativeHeat,
  sessionHeat,
  sumHeat,
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

  it("adds each delta to the bucket of the arriving position", () => {
    // 100 s / 50 = one bucket per 2 000 ms.
    const state = play(createHeatState(), DURATION, 0, 500, 1500, 2500);
    const heat = heatMs(state);

    expect(heat[0]).toBe(1500); // 0→500 and 500→1500
    expect(heat[1]).toBe(1000); // 1500→2500 lands in bucket 1, whole
    expect(heat.reduce((sum, ms) => sum + ms, 0)).toBe(2500);
  });

  it("does not split a delta that straddles a boundary", () => {
    // The error is under 1.5 s per crossing, and splitting would buy precision
    // nothing downstream can use (SPEC §16.5).
    const heat = heatMs(play(createHeatState(), DURATION, 1500, 2400));
    expect(heat[0]).toBe(0);
    expect(heat[1]).toBe(900);
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
    let state = play(createHeatState(), DURATION, 0, 1000, 2000);
    state = reanchor(state, 0); // the viewer scrubs back to the start
    state = play(state, DURATION, 1000, 2000);

    const heat = heatMs(state);
    expect(heat[0]).toBe(2000);
    expect(heat[1]).toBe(2000);
  });

  it("puts a position exactly on a bucket edge in the higher bucket", () => {
    const heat = heatMs(play(createHeatState(), DURATION, 1500, BUCKET_MS));
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
