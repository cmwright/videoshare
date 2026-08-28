/**
 * Watch-range arithmetic for playback analytics (docs/SPEC.md §16.5).
 *
 * Everything here is pure: no DOM, no network, no clock. That is deliberate and
 * for the same reason `gap.ts` exists — the browser half (`beacon.ts`) and the
 * reader half (`stats.ts`) have to agree on what "watched 90% of it" means, and
 * the only way to hold two sides to one answer is to give them one function.
 * Node tests import this file directly.
 *
 * The unit throughout is integer milliseconds, and a range is `[start, end)`.
 * `watched` is a *union*: a stretch watched three times appears once, so these
 * numbers say "seen at least once", never "time spent" (SPEC §16.2). A viewer
 * who loops the first minute ten times has watched one minute, and coverage
 * cannot be pushed past 100%.
 */

import type { TimeRangesLike } from "./gap";

/** One watched stretch of the video, `[start, end)` in integer milliseconds. */
export type Range = [startMs: number, endMs: number];

/** The plaintext a beacon carries, before encryption (SPEC §16.2). */
export interface WatchPayload {
  /** Format version. */
  v: 1;
  /** Random per-browser id, persisted by the viewer's browser (SPEC §16.1). */
  browserId: string;
  /** Random per-page-load id; also the analytics object's key. */
  sessionId: string;
  /** `meta.durationMs` where known, else the element's duration, else 0. */
  durationMs: number;
  /** Merged, sorted, disjoint; at most {@link MAX_WATCH_RANGES} entries. */
  watched: Range[];
  /** `coverage >= COMPLETION_THRESHOLD`, recomputed at every flush. */
  completed: boolean;
  /** ISO 8601 UTC of this session's first `play`; stable across flushes. */
  firstPlayedAt: string;
}

/** How often a playing viewer flushes cumulative state (SPEC §16.5). */
export const BEACON_INTERVAL_MS = 30_000;

/**
 * Cap on the entries in `watched`. Every flush carries the whole session, so
 * this is what keeps a beacon under the gateway's 16 KiB body limit no matter
 * how much scrubbing a viewer does (SPEC §16.2).
 */
export const MAX_WATCH_RANGES = 200;

/** Coverage at or above which a session counts as completed (SPEC §16.2). */
export const COMPLETION_THRESHOLD = 0.9;

/** Buckets in the attention curve: 50 → one per 2% of the video (SPEC §16.6). */
export const ATTENTION_BUCKETS = 50;

/**
 * The media element's `played` ranges as a normalized watch list: seconds to
 * milliseconds, clamped to the video's duration, merged, and capped.
 *
 * `durationMs <= 0` means the duration is not known (a recording whose meta
 * says 0 and whose element still reports Infinity), and the ranges are left
 * unclamped rather than thrown away — coverage will read 0, but *what* was
 * watched is still worth recording.
 */
export function playedRanges(played: TimeRangesLike, durationMs: number): Range[] {
  const limit = Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs) : 0;
  const ranges: Range[] = [];
  for (let i = 0; i < played.length; i++) {
    const start = Math.round(played.start(i) * 1000);
    const end = Math.round(played.end(i) * 1000);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const from = clamp(start, limit);
    const to = clamp(end, limit);
    // A range shorter than half a millisecond rounds to nothing; the element
    // reports one for a play/pause with no frame in between.
    if (to > from) ranges.push([from, to]);
  }
  return capRanges(mergeRanges(ranges));
}

/**
 * Sorted, disjoint ranges covering the same milliseconds as the input.
 * Touching ranges merge: `[0,10]` and `[10,20]` is one stretch that was seen
 * once, not two. Anything empty, backwards or non-finite is dropped.
 */
export function mergeRanges(ranges: readonly Range[]): Range[] {
  const sorted = ranges
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start)
    .map(([start, end]): Range => [start, end])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const merged: Range[] = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/**
 * At most `max` ranges, closing the **smallest gaps first**.
 *
 * A viewer who scrubs a hundred times produces a long list, and the whole list
 * ships on every flush — so something has to give above `max`. Coalescing the
 * narrowest gap costs the least: the overstatement is bounded by that gap, and
 * the shape of the curve (which parts were watched at all) survives, where
 * truncating the tail would silently delete the end of the video.
 *
 * Expects merged, sorted input — `mergeRanges` output.
 */
export function capRanges(ranges: readonly Range[], max: number = MAX_WATCH_RANGES): Range[] {
  const limit = Math.max(1, Math.floor(max));
  const out = ranges.map(([start, end]): Range => [start, end]);

  while (out.length > limit) {
    let at = 0;
    let smallest = Infinity;
    for (let i = 0; i + 1 < out.length; i++) {
      const gap = out[i + 1][0] - out[i][1];
      if (gap < smallest) {
        smallest = gap;
        at = i;
      }
    }
    out[at] = [out[at][0], Math.max(out[at][1], out[at + 1][1])];
    out.splice(at + 1, 1);
  }
  return out;
}

/** Milliseconds of video seen at least once. Assumes disjoint ranges. */
export function watchedMs(ranges: readonly Range[]): number {
  let total = 0;
  for (const [start, end] of ranges) total += end - start;
  return total;
}

/**
 * Fraction of the video seen at least once, 0..1. Capped at 1, and 0 when the
 * duration is unknown — re-watching can never push this past 100%.
 */
export function coverage(ranges: readonly Range[], durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 0;
  return Math.min(1, watchedMs(ranges) / durationMs);
}

export function isCompleted(ranges: readonly Range[], durationMs: number): boolean {
  return coverage(ranges, durationMs) >= COMPLETION_THRESHOLD;
}

/**
 * How many of `sessions` watched each slice of the video (SPEC §16.6).
 *
 * Bucket *b* covers `[b/n, (b+1)/n)` of **that session's own** duration, so
 * sessions of a re-uploaded, differently-timed video still stack sensibly. A
 * session adds 1 to a bucket if any watched range overlaps it at all; a range
 * that ends exactly on a boundary does not light the bucket after it. Sessions
 * with no known duration are excluded — there is no position to place them at.
 */
export function attentionCurve(
  sessions: readonly WatchPayload[],
  buckets: number = ATTENTION_BUCKETS,
): number[] {
  const count = Math.max(1, Math.floor(buckets));
  const curve = new Array<number>(count).fill(0);

  for (const session of sessions) {
    const duration = session.durationMs;
    if (!Number.isFinite(duration) || duration <= 0) continue;
    const width = duration / count;
    for (let b = 0; b < count; b++) {
      const start = b * width;
      // The last bucket ends on the duration itself, so a range running to the
      // final millisecond counts rather than falling off the end.
      const end = b === count - 1 ? duration : (b + 1) * width;
      if (session.watched.some(([from, to]) => from < end && to > start)) curve[b]++;
    }
  }
  return curve;
}

/**
 * A decrypted beacon as a `WatchPayload`, or null.
 *
 * Strict on purpose and never throws: the write endpoint is unauthenticated
 * (SPEC §16.3), so anything holding the share link can put bytes under a video
 * id — and a stats page that trusted them would report whatever they said.
 * Every field is checked, and `watched` must already be what a beacon promises:
 * integer milliseconds, sorted, non-overlapping.
 */
export function parsePayload(value: unknown): WatchPayload | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;

  if (raw.v !== 1) return null;
  if (typeof raw.browserId !== "string" || typeof raw.sessionId !== "string") return null;
  if (typeof raw.completed !== "boolean" || typeof raw.firstPlayedAt !== "string") return null;
  if (!isMilliseconds(raw.durationMs)) return null;

  const watched = parseRanges(raw.watched);
  if (!watched) return null;

  return {
    v: 1,
    browserId: raw.browserId,
    sessionId: raw.sessionId,
    durationMs: raw.durationMs,
    watched,
    completed: raw.completed,
    firstPlayedAt: raw.firstPlayedAt,
  };
}

/** Ranges as a beacon must send them, or null if any of that is untrue. */
function parseRanges(value: unknown): Range[] | null {
  if (!Array.isArray(value)) return null;
  const ranges: Range[] = [];
  let previousEnd = 0;
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2) return null;
    const [start, end] = entry as unknown[];
    if (!isMilliseconds(start) || !isMilliseconds(end)) return null;
    if (end <= start) return null;
    // Sorted and disjoint. Touching ranges are tolerated — they cover the same
    // milliseconds either way — but an overlap would double-count watch time.
    if (ranges.length > 0 && start < previousEnd) return null;
    previousEnd = end;
    ranges.push([start, end]);
  }
  return ranges;
}

function isMilliseconds(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Into `[0, limit]`, or just non-negative when the duration is unknown. */
function clamp(ms: number, limit: number): number {
  const floored = Math.max(0, ms);
  return limit > 0 ? Math.min(floored, limit) : floored;
}
