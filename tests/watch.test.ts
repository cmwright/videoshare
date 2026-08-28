/**
 * Unit tests for the watch-range arithmetic behind playback analytics
 * (docs/SPEC.md §16.5, §16.9).
 *
 * `src/watch.ts` is pure on purpose: the viewer's beacon and the stats page have
 * to agree on what "watched 90% of it" means, and the only way to hold two sides
 * of a wire to one answer is to give them one function. So both import these,
 * and Node can test them without a media element:
 *
 * ```ts
 * export function playedRanges(played: TimeRangesLike, durationMs: number): Range[];
 * export function mergeRanges(ranges: readonly Range[]): Range[];
 * export function capRanges(ranges: readonly Range[], max?: number): Range[];
 * export function watchedMs(ranges: readonly Range[]): number;
 * export function coverage(ranges: readonly Range[], durationMs: number): number;
 * export function isCompleted(ranges: readonly Range[], durationMs: number): boolean;
 * export function attentionCurve(sessions: readonly WatchPayload[], buckets?: number): number[];
 * export function parsePayload(value: unknown): WatchPayload | null;
 * ```
 *
 * The recurring theme below is that none of this input is trustworthy. `played`
 * comes from a media element that reports seconds as floats and will happily
 * hand back a range that ends a hair before it starts; `parsePayload`'s input
 * comes off an **unauthenticated** write endpoint (§16.3), so anything holding a
 * share link can put bytes under a video id, and a stats page that trusted them
 * would report whatever they said.
 */

import { describe, expect, it } from "vitest";
import type { TimeRangesLike } from "../src/gap";
import {
  ATTENTION_BUCKETS,
  attentionCurve,
  BEACON_INTERVAL_MS,
  capRanges,
  COMPLETION_THRESHOLD,
  coverage,
  isCompleted,
  MAX_WATCH_RANGES,
  mergeRanges,
  parsePayload,
  playedRanges,
  type Range,
  type WatchPayload,
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

/** A valid payload, so each case can vary exactly one thing about it. */
function payload(over: Partial<WatchPayload> = {}): WatchPayload {
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

const MINUTE = 60_000;

describe("analytics constants", () => {
  it("matches the SPEC values", () => {
    expect(BEACON_INTERVAL_MS).toBe(30_000);
    expect(MAX_WATCH_RANGES).toBe(200);
    expect(COMPLETION_THRESHOLD).toBe(0.9);
    expect(ATTENTION_BUCKETS).toBe(50);
  });

  it("buckets the video into whole percents", () => {
    // 50 buckets is one per 2%; a number that did not divide 100 would make the
    // curve's axis labels a lie.
    expect(100 % ATTENTION_BUCKETS).toBe(0);
  });
});

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
    // range in the payload would be noise the stats page has to defend against.
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
    // The union is why: three passes over the same minute is one minute.
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

describe("attentionCurve", () => {
  const duration = 100_000;

  it("lights every bucket for a session that watched the whole video", () => {
    const curve = attentionCurve([payload({ watched: [[0, duration]] })]);
    expect(curve).toHaveLength(ATTENTION_BUCKETS);
    expect(curve.every((count) => count === 1)).toBe(true);
  });

  it("lights only the buckets a range overlaps", () => {
    // The first 2% exactly: bucket 0 and nothing else.
    const curve = attentionCurve([payload({ watched: [[0, 2000]] })]);
    expect(curve[0]).toBe(1);
    expect(curve.slice(1).every((count) => count === 0)).toBe(true);
  });

  it("does not let a range ending on a boundary light the next bucket", () => {
    // SPEC §16.6, and the reason the overlap test is strict: [0, 2000) is
    // bucket 0's territory, and 2000 is where bucket 1 starts.
    expect(attentionCurve([payload({ watched: [[0, 2000]] })])[1]).toBe(0);
    expect(attentionCurve([payload({ watched: [[0, 2001]] })])[1]).toBe(1);
  });

  it("counts a range that runs to the final millisecond", () => {
    // The last bucket ends on the duration itself, so watching to the end
    // cannot fall off the end of the array.
    const curve = attentionCurve([payload({ watched: [[98_000, 100_000]] })]);
    expect(curve[ATTENTION_BUCKETS - 1]).toBe(1);
    expect(curve[ATTENTION_BUCKETS - 2]).toBe(0);
  });

  it("stacks sessions bucket by bucket", () => {
    const first = payload({ watched: [[0, 50_000]] });
    const second = payload({ watched: [[0, 50_000]] });
    const third = payload({ watched: [[50_000, 100_000]] });

    const curve = attentionCurve([first, second, third]);
    expect(curve[0]).toBe(2);
    expect(curve[24]).toBe(2);
    expect(curve[25]).toBe(1);
    expect(curve[49]).toBe(1);
  });

  it("places each session by fraction of its own duration", () => {
    // A ten-second video and a ten-minute one both have a "halfway", and the
    // curve is about shape, not seconds (SPEC §16.6).
    const short = payload({ durationMs: 10_000, watched: [[0, 5000]] });
    const long = payload({ durationMs: 600_000, watched: [[0, 300_000]] });

    const curve = attentionCurve([short, long]);
    expect(curve[0]).toBe(2);
    expect(curve[24]).toBe(2);
    expect(curve[25]).toBe(0);
  });

  it("excludes sessions with no known duration", () => {
    // There is no position to place them at. They still count as sessions
    // everywhere else on the page.
    const curve = attentionCurve([payload({ durationMs: 0, watched: [[0, 5000]] })]);
    expect(curve.every((count) => count === 0)).toBe(true);
  });

  it("skips the gaps a viewer skipped", () => {
    const curve = attentionCurve([payload({ watched: [[0, 20_000], [80_000, 100_000]] })]);
    expect(curve[9]).toBe(1);
    expect(curve[10]).toBe(0);
    expect(curve[39]).toBe(0);
    expect(curve[40]).toBe(1);
  });

  it("honours a bucket count of its own", () => {
    expect(attentionCurve([payload({ watched: [[0, 25_000]] })], 4)).toEqual([1, 0, 0, 0]);
    expect(attentionCurve([], 4)).toEqual([0, 0, 0, 0]);
  });

  it("answers a whole array for no sessions at all", () => {
    expect(attentionCurve([])).toHaveLength(ATTENTION_BUCKETS);
  });
});

describe("parsePayload — nothing from the wire is trusted", () => {
  it("accepts what a beacon actually sends, through JSON", () => {
    const sent = payload();
    expect(parsePayload(JSON.parse(JSON.stringify(sent)) as unknown)).toEqual(sent);
  });

  it("keeps only the fields the format defines", () => {
    const parsed = parsePayload({ ...payload(), ip: "203.0.113.7", extra: true });
    expect(parsed).not.toBeNull();
    expect(Object.keys(parsed as WatchPayload).sort()).toEqual([
      "browserId",
      "completed",
      "durationMs",
      "firstPlayedAt",
      "sessionId",
      "v",
      "watched",
    ]);
  });

  it("rejects a version it does not understand", () => {
    for (const v of [0, 2, "1", null, undefined]) {
      expect(parsePayload({ ...payload(), v }), JSON.stringify(v)).toBeNull();
    }
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
      const missing: Record<string, unknown> = { ...payload() };
      delete missing[key];
      expect(parsePayload(missing), `missing ${key}`).toBeNull();
    }
    expect(parsePayload({ ...payload(), completed: "yes" })).toBeNull();
    expect(parsePayload({ ...payload(), browserId: 7 })).toBeNull();
    expect(parsePayload({ ...payload(), firstPlayedAt: 1_756_328_640_000 })).toBeNull();
  });

  it("rejects milliseconds that are not whole and non-negative", () => {
    for (const durationMs of [1.5, -1, Number.NaN, Number.POSITIVE_INFINITY, "100000", null]) {
      expect(parsePayload({ ...payload(), durationMs }), JSON.stringify(durationMs)).toBeNull();
    }
    expect(parsePayload({ ...payload(), watched: [[0, 1.5]] })).toBeNull();
    expect(parsePayload({ ...payload(), watched: [[-1, 100]] })).toBeNull();
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
      expect(parsePayload({ ...payload(), watched }), JSON.stringify(watched)).toBeNull();
    }
  });

  it("rejects unsorted or overlapping ranges", () => {
    // A beacon merges before it sends (§16.2), so anything else is either a bug
    // or someone hand-writing objects into the bucket — and overlap would
    // double-count watch time.
    expect(parsePayload({ ...payload(), watched: [[5000, 6000], [0, 1000]] })).toBeNull();
    expect(parsePayload({ ...payload(), watched: [[0, 5000], [4000, 6000]] })).toBeNull();
    // Touching is tolerated: it covers exactly the same milliseconds.
    expect(parsePayload({ ...payload(), watched: [[0, 5000], [5000, 6000]] })).not.toBeNull();
  });

  it("accepts an empty watch list and a zero duration", () => {
    // Neither is what a beacon sends, but both are internally consistent, and
    // the stats page handles them (a session with no known duration).
    expect(parsePayload({ ...payload(), watched: [] })).not.toBeNull();
    expect(parsePayload({ ...payload(), durationMs: 0, watched: [[0, 5000]] })).not.toBeNull();
  });

  it("returns null rather than throwing, whatever it is handed", () => {
    for (const value of [null, undefined, 42, "…", true, [], [payload()], new Date()]) {
      expect(parsePayload(value), JSON.stringify(value)).toBeNull();
    }
  });

  it("does not alias the object it was given", () => {
    // The stats page holds these for the life of the page; a parsed payload
    // must not keep a live reference into JSON.parse's output.
    const raw = payload();
    const parsed = parsePayload(raw) as WatchPayload;
    raw.watched[0][1] = 1;
    expect(parsed.watched[0][1]).toBe(50_000);
  });
});
