/**
 * Watch arithmetic for playback analytics (docs/SPEC.md §16.5).
 *
 * Everything here is pure: no DOM, no network, no clock. That is deliberate and
 * for the same reason `gap.ts` exists — the browser half (`beacon.ts`) and the
 * reader half (`dashboard.ts`) have to agree on what "watched 90% of it" means
 * and on what a heat bucket is, and the only way to hold two sides to one answer
 * is to give them one function. Node tests import this file directly.
 *
 * The unit throughout is milliseconds, and a range is `[start, end)`.
 *
 * Two numbers live here and they answer different questions, which is why a
 * payload ships both (§16.2):
 *
 * - `watched` is a **union**: a stretch watched three times appears once, so it
 *   says "seen at least once", never "time spent". Coverage and completion come
 *   from it, and re-watching cannot push coverage past 100%.
 * - `heat` is **time spent**: 50 buckets of actual playback milliseconds, one per
 *   2% of the video, accumulated from `timeupdate` deltas — each one pro-rated
 *   across the buckets it actually spans. A section watched twice holds about
 *   twice its own length, a section watched once holds about its own length
 *   whatever the browser's sampling cadence happens to be, and scrubbing adds
 *   nothing.
 */

import type { TimeRangesLike } from "./gap";

/** One watched stretch of the video, `[start, end)` in integer milliseconds. */
export type Range = [startMs: number, endMs: number];

/** The original beacon format: no `heat`. Read-only now — nothing writes it. */
export interface WatchPayloadV1 {
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

/** What every beacon writes today (SPEC §16.2): v1 plus the heat array. */
export interface WatchPayloadV2 extends Omit<WatchPayloadV1, "v"> {
  v: 2;
  /**
   * Exactly {@link HEAT_BUCKETS} non-negative integers — milliseconds of actual
   * playback spent in each 2% of this session's own duration. All zeros is a
   * legitimate value: a session that never learned its duration has no bucket to
   * put anything in.
   */
  heat: number[];
}

export type WatchPayload = WatchPayloadV1 | WatchPayloadV2;

/** How often a playing viewer flushes cumulative state (SPEC §16.5). */
export const BEACON_INTERVAL_MS = 30_000;

/**
 * Cap on the entries in `watched`. Every flush carries the whole session, so
 * this is what keeps a beacon under the gateway's 16 KiB body limit no matter
 * how much scrubbing a viewer does (SPEC §16.2). `heat` cannot grow the body the
 * same way: it is always 50 numbers.
 */
export const MAX_WATCH_RANGES = 200;

/** Coverage at or above which a session counts as completed (SPEC §16.2). */
export const COMPLETION_THRESHOLD = 0.9;

/** Buckets in the heatmap: 50 → one per 2% of the video (SPEC §16.2). */
export const HEAT_BUCKETS = 50;

/**
 * The largest `timeupdate` step still counted as playback (SPEC §16.5).
 *
 * A foreground tab fires `timeupdate` about every 250 ms, so a real step at 1× is
 * a fraction of this. Anything bigger is a seek forward or a stall the viewer did
 * not watch through, and counting it would let a scrub paint heat across a video
 * nobody played.
 *
 * What that costs, stated precisely because §16.5 is what a reader checks it
 * against: a step is roughly `cadence × playback rate`, so the rate at which heat
 * starts being dropped depends on a cadence this module does not control — above
 * ~6× at a foreground 250 ms, but only ~1.5× in a tab throttled to about 1 Hz
 * (backgrounded, or on an energy saver), where a 2× listen accumulates near
 * nothing. Accepted, not fixed: coverage and `completed` come from `video.played`
 * and are exact regardless, and the alternative here is the sampling timer §16.5
 * exists to avoid. Raising this cap is not the fix — a throttled tab's slow
 * cadence and a stall are the same number at this decision.
 */
export const MAX_PLAYBACK_DELTA_MS = 1_500;

/** A well-formed random id (SPEC §16.1) — 16 bytes as unpadded base64url. */
const ID_RE = /^[A-Za-z0-9_-]{22}$/;

// --- Coverage (unchanged by v2) ----------------------------------------------

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

// --- Heat accumulation (the viewer's side) -----------------------------------

/**
 * One session's heat, mid-accumulation.
 *
 * Immutable: every function here returns a new state and mutates nothing, so
 * `beacon.ts` can hold one of these across an event stream and a test can hold
 * both sides of a step. `lastMs` is the observation point — where the video was
 * the last time we looked — and `null` means there is nothing to measure from
 * yet.
 */
export interface HeatState {
  readonly heat: readonly number[];
  readonly lastMs: number | null;
  /**
   * A seek is in flight: `seeking` has fired and its `seeked` has not.
   *
   * While this is set no delta is credited, however small and however plausible
   * it looks. A drag across the scrubber is not one seek — the element starts a
   * new one on every pointer move and only fires `seeked` once the drag settles
   * — so between those two events the positions it reports are places the
   * viewer is scanning past, not playback (SPEC §16.5).
   *
   * `endSeek` clears it, and `syncSeek` clears it when the element says it is
   * no longer seeking at all — because suppression that could stick would cost
   * a whole session's heat invisibly.
   */
  readonly seeking: boolean;
}

/** All-zero heat, no observation point, no seek in flight (SPEC §16.5). */
export function createHeatState(buckets: number = HEAT_BUCKETS): HeatState {
  return {
    heat: new Array<number>(bucketCount(buckets)).fill(0),
    lastMs: null,
    seeking: false,
  };
}

/**
 * One `timeupdate`: the video is now at `currentMs`.
 *
 * With `deltaMs = currentMs - state.lastMs`, a delta in `(0,
 * MAX_PLAYBACK_DELTA_MS]` with no seek in flight is playback, and is
 * **pro-rated** across the buckets its own media-time span `[state.lastMs,
 * currentMs]` covers, each bucket taking the milliseconds actually spent inside
 * it. Anything else — no observation point yet, a seek in flight, a backwards
 * step (a seek back), a step over the cap (a seek forward, or a stall nobody
 * watched through) — is discarded, but the observation point still moves, so the
 * next step is measured from where the video actually is.
 *
 * Pro-rating is what keeps the heatmap flat where attention was flat. Crediting
 * a delta whole to the arriving bucket is only harmless while a bucket is much
 * wider than a step, and it is not: a 27 s recording has 540 ms buckets against
 * a ~250 ms foreground cadence, so buckets took 2 or 3 whole steps at random and
 * a picture of an even watch came out as a ±39% sawtooth. A single accepted step
 * can also be nearly three times a bucket wide (1.5 s against 540 ms), and
 * landing it whole spiked that bucket to 2.8× a full pass out of nothing.
 *
 * The invariant that buys: one pass at any cadence puts at most one bucket-span
 * in a bucket, so 2× on the dashboard means the stretch really was played twice.
 *
 * With no usable `durationMs` there is no bucket to name, so every delta is
 * discarded and the heat stays all zeros while the observation point advances —
 * a session that learns its duration mid-playback accumulates from that moment.
 */
export function advance(state: HeatState, currentMs: number, durationMs: number): HeatState {
  // An element with no media loaded reports NaN; anchoring to it would poison
  // every delta after it.
  if (!Number.isFinite(currentMs)) return state;
  if (state.lastMs === null) return { ...state, lastMs: currentMs };

  const deltaMs = currentMs - state.lastMs;
  const playback = !state.seeking && deltaMs > 0 && deltaMs <= MAX_PLAYBACK_DELTA_MS;
  if (!playback) return { ...state, lastMs: currentMs };

  const heat = creditSpan(state.heat, state.lastMs, currentMs, durationMs);
  if (heat === null) return { ...state, lastMs: currentMs };
  return { ...state, heat, lastMs: currentMs };
}

/**
 * Moves the observation point without touching a bucket — what a discontinuity
 * costs. The `play` after a pause lands here, so a pause of any length adds
 * nothing (SPEC §16.5).
 *
 * A seek in flight **survives** this: a viewer can hit play with the scrubber
 * still held, and only `seeked` ends a seek.
 */
export function reanchor(state: HeatState, currentMs: number): HeatState {
  if (!Number.isFinite(currentMs)) return state;
  return { ...state, lastMs: currentMs };
}

/**
 * `seeking`: suppress accumulation until the seek lands (SPEC §16.5).
 *
 * Idempotent, because one drag fires this many times — the element aborts the
 * seek in progress and starts another on every pointer move, and only the last
 * one gets a `seeked`. Re-anchoring on each `seeking` is what used to leak: a
 * `timeupdate` landing between two of them reports a position a few hundred
 * milliseconds along the drag, which is indistinguishable from playback at the
 * only place that decision was made.
 */
export function beginSeek(state: HeatState): HeatState {
  return state.seeking ? state : { ...state, seeking: true };
}

/**
 * `seeked`: the seek landed at `currentMs`. Re-anchors there and resumes.
 *
 * Clears the flag even when the landing is unusable, keeping the old anchor
 * instead. Suppression that could stick would cost a session all of its heat,
 * which is a worse failure than the leak it exists to close.
 */
export function endSeek(state: HeatState, currentMs: number): HeatState {
  const landed = Number.isFinite(currentMs) ? currentMs : state.lastMs;
  return { heat: state.heat, lastMs: landed, seeking: false };
}

/**
 * Reconciles the flag with the element's own `seeking` attribute, which the
 * caller passes as `elementSeeking` (SPEC §16.5). Ends a seek the element is no
 * longer in.
 *
 * This is the other half of the rule `endSeek` already holds: suppression must
 * never stick. `seeked` is the only *event* that ends a seek, so one that is
 * never delivered would suppress the rest of the session — every later delta
 * discarded, while `watched`, coverage and `completed` (all read from
 * `video.played`) look perfectly normal, which makes the undercount invisible
 * rather than merely wrong.
 *
 * In a conforming browser this changes nothing, because it is not a second
 * opinion — it reads the very state whose clearing is what queues `seeked`. A
 * completed seek clears `seeking` and queues `timeupdate` before `seeked`, so
 * this ends the seek one task early, at the position `seeked` is about to
 * report anyway. It differs only where a `seeked` never comes: a `load()` or an
 * `src` swap mid-session (the load algorithm clears `seeking` and fires no
 * `seeked`), or a browser abandoning a seek across a fullscreen or backgrounding
 * transition.
 *
 * It is not a way back into the leak §16.5 closed. A drag holds the element's
 * `seeking` true for as long as it is aborting one seek and starting the next,
 * so the first moment this reads false is a moment a seek has landed — which is
 * exactly when `seeked` fires.
 */
export function syncSeek(state: HeatState, elementSeeking: boolean, currentMs: number): HeatState {
  if (!state.seeking || elementSeeking) return state;
  return endSeek(state, currentMs);
}

/**
 * The accumulated buckets as whole milliseconds, ready for a payload.
 *
 * Accumulation itself is in floating milliseconds on purpose: rounding four
 * times a second would drift by minutes over a long video.
 */
export function heatMs(state: HeatState): number[] {
  return state.heat.map((ms) => Math.round(ms));
}

// --- Heat reading (the dashboard's side) -------------------------------------

/** One stored session: what it said, plus when the bucket last saw it (§16.3). */
export interface WatchSession {
  payload: WatchPayload;
  /** ISO 8601 UTC from the listing — a payload carries no last-activity time. */
  lastModified: string;
}

/** One browser's viewings of a video, collapsed (SPEC §16.6). */
export interface ViewerReport {
  browserId: string;
  /** Sessions by this browser. */
  plays: number;
  /** Their sessions summed bucket by bucket. */
  heat: number[];
  /** The **best** coverage among their sessions, or null when none is timed. */
  coverage: number | null;
  /** The greatest `lastModified` of their sessions. */
  lastWatched: string;
}

/**
 * A v1 payload's heat, derived from its watch union alone (SPEC §16.2).
 *
 * Bucket *b* spans `[b·durationMs/n, (b+1)·durationMs/n)`, the last one ending
 * on `durationMs` inclusive; its value is the summed overlap with the union.
 * Because the union is disjoint, no bucket can exceed its own span — so a v1
 * session reads as binary intensity capped at 1×, which is exactly as much as a
 * v1 payload knows.
 */
export function heatFromRanges(
  watched: readonly Range[],
  durationMs: number,
  buckets: number = HEAT_BUCKETS,
): number[] {
  const count = bucketCount(buckets);
  const heat = new Array<number>(count).fill(0);
  if (!Number.isFinite(durationMs) || durationMs <= 0) return heat;

  const width = durationMs / count;
  for (let b = 0; b < count; b++) {
    const start = b * width;
    // The last bucket ends on the duration itself, so a range running to the
    // final millisecond counts rather than falling off the end.
    const end = b === count - 1 ? durationMs : (b + 1) * width;
    let ms = 0;
    for (const [from, to] of watched) {
      const overlap = Math.min(to, end) - Math.max(from, start);
      if (overlap > 0) ms += overlap;
    }
    heat[b] = Math.round(ms);
  }
  return heat;
}

/**
 * One session's heat, whichever version it is — the **only** place the version
 * difference is allowed to matter. Every consumer above this reads one shape.
 */
export function sessionHeat(payload: WatchPayload, buckets: number = HEAT_BUCKETS): number[] {
  const count = bucketCount(buckets);
  if (payload.v === 2) return fit(payload.heat, count);
  return heatFromRanges(payload.watched, payload.durationMs, count);
}

/**
 * Per bucket, the sum of `sessionHeat` over the payloads. Sessions of
 * differently-timed videos still stack, because a bucket is 2% of *each
 * session's own* duration.
 */
export function sumHeat(payloads: readonly WatchPayload[], buckets: number = HEAT_BUCKETS): number[] {
  const count = bucketCount(buckets);
  const total = new Array<number>(count).fill(0);
  for (const payload of payloads) {
    const heat = sessionHeat(payload, count);
    for (let b = 0; b < count; b++) total[b] += heat[b];
  }
  return total;
}

/**
 * The "×" number the dashboard puts in every bar's tooltip (SPEC §16.6):
 *
 * ```
 * relative[b] = sumHeat(timed)[b] / Σ (s.durationMs / buckets)   for s ∈ timed
 * ```
 *
 * The denominator is the playback time one pass through that bucket would take,
 * summed over the sessions that have a duration — so for equal-duration sessions
 * it is exactly `bucketMs / (sessions × bucketDurationMs)`, and it stays honest
 * when the durations differ instead of quietly picking one video's length for
 * everyone. `1.0` means "on average these sessions played this slice once
 * through"; `2.4` means about two and a half times.
 *
 * Sessions with no known duration are excluded from **both** sides: their heat is
 * all zeros by §16.5, so counting them in the denominator would only dilute the
 * answer. They still count as sessions in the header.
 */
export function relativeHeat(
  payloads: readonly WatchPayload[],
  buckets: number = HEAT_BUCKETS,
): number[] {
  const count = bucketCount(buckets);
  const timed = payloads.filter((p) => Number.isFinite(p.durationMs) && p.durationMs > 0);

  let onePass = 0;
  for (const payload of timed) onePass += payload.durationMs / count;
  if (onePass <= 0) return new Array<number>(count).fill(0);

  return sumHeat(timed, count).map((ms) => ms / onePass);
}

/**
 * Each bucket over the largest bucket, 0..1; an all-zero input gives all zeros.
 *
 * This is the **height** channel of the dashboard's bars, and it is deliberately
 * not `relativeHeat`: height shows the shape of attention within one video,
 * whatever the absolute numbers are, while the tooltip and the hot threshold
 * show intensity against a single pass.
 */
export function normalizeHeat(heat: readonly number[]): number[] {
  let peak = 0;
  for (const ms of heat) if (Number.isFinite(ms) && ms > peak) peak = ms;
  if (peak <= 0) return heat.map(() => 0);
  return heat.map((ms) => (Number.isFinite(ms) && ms > 0 ? Math.min(1, ms / peak) : 0));
}

/**
 * One report per distinct `browserId`, most recent activity first (SPEC §16.6).
 *
 * `coverage` is the **best** of a viewer's sessions, not the last: someone who
 * watched it all on Tuesday and opened it for ten seconds on Friday has seen the
 * video. A `browserId` that is not a well-formed random id is **never collapsed
 * with anything** — each such session becomes its own single-play viewer, so
 * junk written through the unauthenticated endpoint cannot make a video look
 * less watched than it is.
 */
export function groupByViewer(sessions: readonly WatchSession[]): ViewerReport[] {
  interface Group {
    browserId: string;
    payloads: WatchPayload[];
    lastWatched: string;
    lastAt: number;
  }

  const groups = new Map<string, Group>();
  for (const { payload, lastModified } of sessions) {
    const known = ID_RE.test(payload.browserId);
    // The prefix keeps a malformed id from colliding with a real one.
    const key = known ? payload.browserId : `session:${payload.sessionId}`;
    const at = timeOf(lastModified);

    const group = groups.get(key);
    if (!group) {
      groups.set(key, {
        browserId: payload.browserId,
        payloads: [payload],
        lastWatched: lastModified,
        lastAt: at,
      });
      continue;
    }
    group.payloads.push(payload);
    if (at >= group.lastAt) {
      group.lastAt = at;
      group.lastWatched = lastModified;
    }
  }

  return [...groups.values()]
    .map((group): ViewerReport => ({
      browserId: group.browserId,
      plays: group.payloads.length,
      heat: sumHeat(group.payloads),
      coverage: bestCoverage(group.payloads),
      lastWatched: group.lastWatched,
    }))
    .sort((a, b) => timeOf(b.lastWatched) - timeOf(a.lastWatched) || compare(a.browserId, b.browserId));
}

// --- Engagement figures (the video page's stat cards, SPEC §17.6) ------------

/**
 * Fraction of sessions that reached {@link COMPLETION_THRESHOLD}, 0..1, or null
 * for an empty list (SPEC §16.5).
 *
 * `completed` is the payload's **own flag** (§16.2: coverage ≥ the threshold),
 * never recomputed here — so the number the video page shows is the number the
 * viewer's browser decided, which is what makes the two sides agree by
 * construction. Every session counts on both sides of the ratio: a session is a
 * view whether or not its duration was known, and one the beacon did not call
 * complete did not complete.
 *
 * Deliberately *not* the denominator rule {@link averageWatchedMs} uses. That
 * one divides a duration by a count and needs a known duration to mean
 * anything; this one divides a count by a count, and a flag the beacon already
 * resolved needs no duration to be read.
 */
export function completionRate(payloads: readonly WatchPayload[]): number | null {
  if (payloads.length === 0) return null;
  return payloads.filter((p) => p.completed).length / payloads.length;
}

/**
 * Mean milliseconds of video seen per session — the union per session (so a
 * stretch watched three times counts once), averaged over the sessions with a
 * known duration. Null when none has one.
 *
 * Both sides of the division are that subset, and unlike {@link completionRate}
 * they have to be: an untimed session knows how long it watched but not what
 * fraction that was, its `watched` is unclamped (§16.5), and counting it in the
 * denominator alone would report an average lower than any session in it.
 */
export function averageWatchedMs(payloads: readonly WatchPayload[]): number | null {
  const timed = payloads.filter((p) => Number.isFinite(p.durationMs) && p.durationMs > 0);
  if (timed.length === 0) return null;
  let total = 0;
  for (const payload of timed) total += watchedMs(payload.watched);
  return total / timed.length;
}

/**
 * The most replayed bucket: its index and its {@link relativeHeat} value — the
 * "× against one pass" number, which is what "peak 2.2×" means (SPEC §17.6).
 *
 * Null when nothing was watched at all, so the caption is omitted rather than
 * printed as "peak 0.0× at 0:00". Ties go to the earliest bucket, which is the
 * one a reader scrubbing to the peak would find first.
 */
export function peakBucket(
  payloads: readonly WatchPayload[],
  buckets: number = HEAT_BUCKETS,
): { index: number; times: number } | null {
  const relative = relativeHeat(payloads, buckets);
  let index = -1;
  let times = 0;
  for (let b = 0; b < relative.length; b++) {
    if (relative[b] > times) {
      times = relative[b];
      index = b;
    }
  }
  return index === -1 ? null : { index, times };
}

// --- Parsing -----------------------------------------------------------------

/**
 * A decrypted beacon as a `WatchPayload`, or null.
 *
 * Strict on purpose and never throws: the write endpoint is unauthenticated
 * (SPEC §16.3), so anything holding the share link can put bytes under a video
 * id — and a dashboard that trusted them would report whatever they said.
 * Every field is checked, `watched` must already be what a beacon promises
 * (integer milliseconds, sorted, non-overlapping), and a v2 `heat` must be
 * exactly {@link HEAT_BUCKETS} non-negative integers.
 *
 * `v` of 1 or 2 only. A v1 object carrying a stray `heat` is still v1; the field
 * is ignored, like every other unknown one.
 */
export function parsePayload(value: unknown): WatchPayload | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;

  if (raw.v !== 1 && raw.v !== 2) return null;
  if (typeof raw.browserId !== "string" || typeof raw.sessionId !== "string") return null;
  if (typeof raw.completed !== "boolean" || typeof raw.firstPlayedAt !== "string") return null;
  if (!isMilliseconds(raw.durationMs)) return null;

  const watched = parseRanges(raw.watched);
  if (!watched) return null;

  const common = {
    browserId: raw.browserId,
    sessionId: raw.sessionId,
    durationMs: raw.durationMs,
    watched,
    completed: raw.completed,
    firstPlayedAt: raw.firstPlayedAt,
  };

  if (raw.v === 1) return { v: 1, ...common };

  const heat = parseHeat(raw.heat);
  if (!heat) return null;
  return { v: 2, ...common, heat };
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

/** Exactly HEAT_BUCKETS whole, non-negative milliseconds, or null. */
function parseHeat(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length !== HEAT_BUCKETS) return null;
  const heat: number[] = [];
  for (const entry of value) {
    if (!isMilliseconds(entry)) return null;
    heat.push(entry);
  }
  return heat;
}

function isMilliseconds(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

// --- Small helpers -----------------------------------------------------------

/** Into `[0, limit]`, or just non-negative when the duration is unknown. */
function clamp(ms: number, limit: number): number {
  const floored = Math.max(0, ms);
  return limit > 0 ? Math.min(floored, limit) : floored;
}

function bucketCount(buckets: number): number {
  return Math.max(1, Math.floor(buckets));
}

/**
 * Which bucket `currentMs` falls in, or null when there is no duration to
 * divide. A position on a boundary belongs to the higher bucket; one at or past
 * the duration lands in the last, and a negative one in the first.
 */
function bucketOf(currentMs: number, durationMs: number, buckets: number): number | null {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return null;
  const raw = Math.floor((currentMs / durationMs) * buckets);
  return Math.min(buckets - 1, Math.max(0, raw));
}

/**
 * `heat` with the media-time span `[fromMs, toMs)` added to it, each bucket
 * taking the milliseconds of the span that fall inside that bucket. Null when
 * there is no duration to divide the video by.
 *
 * A copy, never written in place: callers hold the old state.
 *
 * The span is walked as a contiguous chain — `fromMs` → the first boundary above
 * it → … → the last boundary below `toMs` → `toMs` — so the pieces add back up
 * to `toMs - fromMs` exactly, and no rounding happens here at all (`heatMs` does
 * that once, at the end).
 *
 * Clamping is inherited from `bucketOf` and is the same rule the whole module
 * uses: an element that reports a position a frame past its own duration, or a
 * negative one, contributes to the last or first bucket rather than off the end.
 * The clamped end bucket simply swallows whatever part of the span lies outside
 * `[0, durationMs]`.
 *
 * Expects `toMs > fromMs`.
 */
function creditSpan(
  heat: readonly number[],
  fromMs: number,
  toMs: number,
  durationMs: number,
): number[] | null {
  const buckets = heat.length;
  const first = bucketOf(fromMs, durationMs, buckets);
  const last = bucketOf(toMs, durationMs, buckets);
  if (first === null || last === null) return null;

  const out = heat.slice();
  if (first === last) {
    out[first] += toMs - fromMs;
    return out;
  }

  const width = durationMs / buckets;
  for (let b = first; b <= last; b++) {
    const start = b === first ? fromMs : b * width;
    const end = b === last ? toMs : (b + 1) * width;
    if (end > start) out[b] += end - start;
  }
  return out;
}

/**
 * `values` as exactly `count` buckets. `parsePayload` guarantees a v2 heat is
 * already HEAT_BUCKETS long, so this only ever does anything when a caller asks
 * for a different bucket count (which the tests do).
 */
function fit(values: readonly number[], count: number): number[] {
  const out = new Array<number>(count).fill(0);
  for (let i = 0; i < Math.min(values.length, count); i++) out[i] = values[i];
  return out;
}

/** The best coverage among timed sessions, or null when none has a duration. */
function bestCoverage(payloads: readonly WatchPayload[]): number | null {
  let best: number | null = null;
  for (const payload of payloads) {
    if (!Number.isFinite(payload.durationMs) || payload.durationMs <= 0) continue;
    const seen = coverage(payload.watched, payload.durationMs);
    if (best === null || seen > best) best = seen;
  }
  return best;
}

/** An ISO timestamp as a number, or -Infinity for anything unparseable. */
function timeOf(iso: string): number {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
