/**
 * Buffered-gap arithmetic for the MSE player (SPEC §8).
 *
 * A recording can contain a hole in its video timeline — frames the encoder
 * dropped under load (§6 backpressure), or a stretch a VFR screen capture
 * simply never produced. Demuxed as a file, a hole is nothing: the decoder
 * shows the previous picture for longer. Fed to a `SourceBuffer`, it is a
 * cliff. MSE coalesces appended media into buffered *ranges*, and a jump
 * larger than the element's fudge factor splits the range in two; playback
 * runs to the end of the first range and stops there forever, because the
 * element will not cross a hole on its own. Everything after the hole is lost
 * even though it is sitting in the buffer.
 *
 * So the player watches for that stall and steps over it. Both decisions — is
 * this a stall, and is there a hole worth crossing — are pure arithmetic over
 * playhead samples and a list of ranges, which is why they live here rather
 * than in `player.ts`: that module is a page controller that reaches for
 * `document` as it loads, so Node tests cannot import it (see
 * `tests/player.test.ts`).
 */

/** One buffered range. Same shape as an entry of `HTMLMediaElement.buffered`. */
export interface TimeRangeLike {
  readonly start: number;
  readonly end: number;
}

/** The `TimeRanges` surface this module needs — structurally satisfied by the real one. */
export interface TimeRangesLike {
  readonly length: number;
  start(index: number): number;
  end(index: number): number;
}

/**
 * How far past the start of the next range to land. Seeking to exactly
 * `start` can round to the sample just before it and stall again on the same
 * edge; 50 ms is comfortably inside the first frame of the range and far below
 * anything a viewer perceives as a skip.
 */
export const GAP_SEEK_EPSILON = 0.05;

/**
 * How far short of a range's end `currentTime` may sit and still count as
 * being *at* the edge. A stalled element stops on the last frame it can
 * present, which is a frame-time or so before the range end, and Chrome's
 * reported `currentTime` lags the range boundary by a similar margin. Anything
 * with less than this much media left ahead of it is not going to play on.
 */
export const GAP_EDGE_TOLERANCE = 0.1;

/** Smallest `currentTime` advance between two polls that counts as progress, in seconds. */
export const PROGRESS_EPSILON = 0.01;

/** The media-element state one watchdog poll reads — satisfied by `HTMLVideoElement`. */
export interface PlaybackSample {
  readonly paused: boolean;
  readonly ended: boolean;
  readonly currentTime: number;
}

/**
 * Whether this poll counts against the stall budget, given where the playhead
 * was at the previous poll.
 *
 * The element's `seeking` flag is deliberately not part of this. A seek that is
 * going to land has already moved `currentTime` to its target, which reads as
 * progress here and forgives itself. A seek into a hole never lands at all —
 * MSE waits for an append covering the seek point, and an in-order append
 * stream cannot produce frames that were never encoded — so excusing a pending
 * seek is exactly how a viewer who scrubs into the hole ends up stuck there
 * for good (SPEC §8).
 */
export function isStalling(
  previousTime: number,
  sample: PlaybackSample,
  epsilon: number = PROGRESS_EPSILON,
): boolean {
  if (sample.paused || sample.ended) return false;
  return !(sample.currentTime > previousTime + epsilon);
}

/** Snapshot of a live `TimeRanges` as a plain array, oldest range first. */
export function bufferedRanges(ranges: TimeRangesLike): TimeRangeLike[] {
  const out: TimeRangeLike[] = [];
  for (let i = 0; i < ranges.length; i++) {
    const start = ranges.start(i);
    const end = ranges.end(i);
    if (Number.isFinite(start) && Number.isFinite(end)) out.push({ start, end });
  }
  return out;
}

/**
 * Where to seek to rescue a stall at `currentTime`, or `null` to leave the
 * element alone.
 *
 * Returns a time only when the playhead has nothing playable in front of it
 * *and* a later range exists — a genuine hole with buffered media on the far
 * side. Every other stall (waiting on the network at the head of the buffer,
 * a seek into a region that has not been fetched yet, a paused element) has no
 * later range to jump to and gets `null`, so a recording without holes never
 * sees a seek it did not ask for.
 *
 * The result is always strictly ahead of `currentTime`: jumping backwards
 * would loop the same stretch forever. Gap size is not capped — a hole the
 * player refuses to cross costs the viewer the entire rest of the recording,
 * which is never the better trade (SPEC §8).
 */
export function findGapSeek(
  ranges: readonly TimeRangeLike[],
  currentTime: number,
  epsilon: number = GAP_SEEK_EPSILON,
  tolerance: number = GAP_EDGE_TOLERANCE,
): number | null {
  if (!Number.isFinite(currentTime)) return null;

  let next: TimeRangeLike | null = null;
  for (const range of ranges) {
    // Media the element could still be playing: it covers the playhead and
    // runs more than `tolerance` past it. Then this is not a hole, and a seek
    // would be a skip. The tolerance is only ever spent at the trailing edge —
    // a playhead sitting *before* a range's start is in the hole, however
    // narrowly, since the element already merged anything it could cross.
    if (range.start <= currentTime && range.end > currentTime + tolerance) return null;
    // The earliest range that begins ahead of the playhead — the far side of
    // the hole. Ranges arrive in order, but do not lean on that.
    if (range.start > currentTime && (next === null || range.start < next.start)) next = range;
  }
  if (next === null) return null;

  // Land inside the range even when it is shorter than epsilon (a lone frame
  // stranded between two holes), so the seek cannot overshoot into the next one.
  const target = Math.min(next.start + epsilon, (next.start + next.end) / 2);
  return target > currentTime ? target : null;
}
