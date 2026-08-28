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
 *   2% of the video, accumulated from `timeupdate` deltas. A section watched
 *   twice holds about twice its own length, and scrubbing adds ~nothing.
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
 * Immutable: `advance` and `reanchor` return a new state and mutate nothing, so
 * `beacon.ts` can hold one of these across an event stream and a test can hold
 * both sides of a step. `lastMs` is the observation point — where the video was
 * the last time we looked — and `null` means there is nothing to measure from
 * yet.
 */
export interface HeatState {
  readonly heat: readonly number[];
  readonly lastMs: number | null;
}

/** All-zero heat with no observation point yet (SPEC §16.5). */
export function createHeatState(buckets: number = HEAT_BUCKETS): HeatState {
  return { heat: new Array<number>(bucketCount(buckets)).fill(0), lastMs: null };
}

/**
 * One `timeupdate`: the video is now at `currentMs`.
 *
 * With `deltaMs = currentMs - state.lastMs`, a delta in `(0,
 * MAX_PLAYBACK_DELTA_MS]` is playback and lands whole in the bucket of the
 * **arriving** position. Anything else — no observation point yet, a backwards
 * step (a seek back), a step over the cap (a seek forward, or a stall nobody
 * watched through) — is discarded, but the observation point still moves, so the
 * next step is measured from where the video actually is.
 *
 * A delta straddling a bucket boundary is not split. The error is under 1.5 s
 * per crossing, and splitting would buy precision nothing downstream can use.
 *
 * With no usable `durationMs` there is no bucket to name, so every delta is
 * discarded and the heat stays all zeros while the observation point advances —
 * a session that learns its duration mid-playback accumulates from that moment.
 */
export function advance(state: HeatState, currentMs: number, durationMs: number): HeatState {
  // An element with no media loaded reports NaN; anchoring to it would poison
  // every delta after it.
  if (!Number.isFinite(currentMs)) return state;
  if (state.lastMs === null) return { heat: state.heat, lastMs: currentMs };

  const deltaMs = currentMs - state.lastMs;
  const playback = deltaMs > 0 && deltaMs <= MAX_PLAYBACK_DELTA_MS;
  const bucket = playback ? bucketOf(currentMs, durationMs, state.heat.length) : null;
  if (bucket === null) return { heat: state.heat, lastMs: currentMs };

  // Sliced, never written in place: callers hold the old state.
  const heat = state.heat.slice();
  heat[bucket] += deltaMs;
  return { heat, lastMs: currentMs };
}

/**
 * Moves the observation point without touching a bucket — what a discontinuity
 * costs. A `seeking`/`seeked` pair and the `play` after a pause all land here,
 * so a scrub loses the delta across itself and a pause of any length adds
 * nothing (SPEC §16.5).
 */
export function reanchor(state: HeatState, currentMs: number): HeatState {
  if (!Number.isFinite(currentMs)) return state;
  return { heat: state.heat, lastMs: currentMs };
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
