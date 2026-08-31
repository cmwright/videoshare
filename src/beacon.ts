/**
 * The viewer's half of playback analytics (docs/SPEC.md §16.3, §16.5).
 *
 * What leaves the tab is one AES-GCM block per flush, encrypted with the same
 * key the video was — the one in the share link's fragment. The gateway and the
 * analytics bucket see ciphertext, a video id and a random session label, and
 * that is the whole design: watch data is readable by exactly the people who
 * can already watch the video.
 *
 * Three rules this file holds to, all of them from §16:
 *
 * - **The key never leaves.** It is used to encrypt and is never copied into a
 *   URL, a header or a body. All routing lives in the path, which carries two
 *   random ids and nothing else.
 * - **Every flush is the whole session.** The gateway overwrites one object per
 *   session, so a lost or reordered beacon costs the delta between two
 *   cumulative states and nothing more. There is no retry logic here because
 *   there is nothing to retry: the next flush says everything the last one did.
 * - **Every failure is silent.** A `sendBeacon` that returns false, a 4xx, an
 *   encrypt that throws — the viewer is watching a video and is never told, and
 *   nothing spins.
 *
 * Nothing here runs unless `player.ts` starts it, which it does only when a
 * gateway is configured *and* answers `analytics: true`. Legacy mode never
 * imports its way into a network call or a localStorage key.
 */

import { analyticsAad, encryptBlock } from "./crypto";
import { randomId } from "./util";
import {
  advance,
  BEACON_INTERVAL_MS,
  beginSeek,
  createHeatState,
  endSeek,
  type HeatState,
  heatMs,
  isCompleted,
  playedRanges,
  reanchor,
  syncSeek,
  type WatchPayloadV2,
} from "./watch";

/** The only key `view.html` ever writes (SPEC §16.1). A bare string, not JSON. */
const VIEWER_KEY = "videoshare.viewer";

/** What `randomId()` produces; anything else under the key is replaced. */
const ID_RE = /^[A-Za-z0-9_-]{22}$/;

/**
 * `sendBeacon` cannot set headers, so this is the Blob's type — a CORS-safelisted
 * content type, chosen so no preflight can strand a beacon fired at `pagehide`.
 * The bytes are unaffected by the label, and the gateway never reads it (§16.3).
 */
const BEACON_CONTENT_TYPE = "text/plain;charset=UTF-8";

const utf8 = new TextEncoder();

export interface BeaconOptions {
  /** Gateway base from config.js, e.g. `"/api"` — no trailing slash. */
  gatewayUrl: string;
  videoId: string;
  /** The video's AES-GCM key, from the share link's fragment. */
  key: CryptoKey;
  /** `meta.durationMs`; 0 when the recording did not record one. */
  durationMs: number;
}

export interface WatchBeacon {
  /** Final flush, then teardown. Idempotent. */
  stop(): void;
}

/** Minted once per page load and cached, so a session gets one id (SPEC §16.1). */
let cachedViewerId: string | null = null;

/**
 * This browser's random viewer id, persisted at `videoshare.viewer`.
 *
 * It exists so the library dashboard can collapse three viewings by one person
 * into one viewer, and it is inside the ciphertext — the server cannot link two
 * sessions to one browser even under the same video id.
 *
 * A browser that refuses storage gets an ephemeral id and is never told: a
 * viewer is a stranger who came to watch a video, not someone to ask about
 * their privacy settings. Their repeat visits simply count as new viewers.
 */
export function viewerId(): string {
  if (cachedViewerId) return cachedViewerId;

  const store = storage();
  let id = "";
  try {
    id = store?.getItem(VIEWER_KEY) ?? "";
  } catch {
    id = "";
  }

  if (!ID_RE.test(id)) {
    id = randomId();
    try {
      store?.setItem(VIEWER_KEY, id);
    } catch {
      // Full, or private mode with a zero quota. The id still serves this page load.
    }
  }

  cachedViewerId = id;
  return id;
}

/**
 * Tracks what `video` gets watched and flushes it to the gateway (SPEC §16.5).
 *
 * There is no polling loop: watched ranges are read from the element's own
 * `played` at flush time, which is the browser's record of exactly this, kept
 * whether or not anyone asks, and heat rides the element's own `timeupdate`.
 * The flush timer starts at the first `play` and stops at `ended` and
 * `pagehide`, so a page left open on a finished video costs nothing.
 *
 * Flushes happen every `BEACON_INTERVAL_MS` while that timer runs, on `pause`,
 * on `ended`, on `visibilitychange` → hidden, and on `pagehide` (SPEC §16.5).
 */
export function startWatchBeacon(video: HTMLMediaElement, opts: BeaconOptions): WatchBeacon {
  /** One session = one page load = one storage object (SPEC §16.1). */
  const sessionId = randomId();
  // "/sessions", not "/beacon": ad-block filter lists match "/beacon/" on
  // cross-site requests, killing the send before any HTTP (SPEC §16.3).
  const url = `${opts.gatewayUrl}/sessions/${opts.videoId}/${sessionId}`;
  const aad = analyticsAad(opts.videoId, sessionId);

  let firstPlayedAt: string | null = null;
  /**
   * Time spent per 2% bucket, accumulated from the element's own `timeupdate`
   * (SPEC §16.5). There is no clock of ours behind this: the deltas are media
   * time, so a viewer at 2× accumulates the same heat over a stretch as one at
   * 1×, and a paused tab contributes nothing because nothing fires.
   */
  let heat: HeatState = createHeatState();
  let timer: number | null = null;
  /** One flush in flight at a time, so two cumulative states cannot race to the same key. */
  let sending = false;
  /** The last body the browser accepted; identical state is not worth a write. */
  let delivered = "";
  let stopped = false;

  /**
   * `meta.durationMs` is authoritative (SPEC §5), but a recording made before
   * the timer existed has none — and the element may only learn its own
   * duration part-way through the whole-file path, so this is read per flush.
   */
  const duration = (): number => {
    if (Number.isFinite(opts.durationMs) && opts.durationMs > 0) return Math.round(opts.durationMs);
    const seconds = video.duration;
    return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0;
  };

  /** The cumulative payload as JSON, or null when there is nothing to report yet. */
  const payload = (): string | null => {
    if (!firstPlayedAt) return null;
    const durationMs = duration();
    const watched = playedRanges(video.played, durationMs);
    // Nothing played: no beacon at all, so a viewer who opens a link and leaves
    // is not a session (SPEC §16.5).
    if (watched.length === 0) return null;

    const body: WatchPayloadV2 = {
      v: 2,
      // Minted here rather than at start-up: the localStorage key is written
      // only when a beacon is actually about to be sent (SPEC §16.1).
      browserId: viewerId(),
      sessionId,
      durationMs,
      watched,
      // Time spent, where `watched` is seen-at-least-once. The two ship together
      // because they answer different questions (SPEC §16.2).
      heat: heatMs(heat),
      completed: isCompleted(watched, durationMs),
      firstPlayedAt,
    };
    return JSON.stringify(body);
  };

  const send = async (json: string): Promise<boolean> => {
    const block = await encryptBlock(opts.key, aad, utf8.encode(json));
    const blob = new Blob([block as Uint8Array<ArrayBuffer>], { type: BEACON_CONTENT_TYPE });
    return navigator.sendBeacon(url, blob);
  };

  const flush = (): void => {
    if (stopped || sending) return;
    const json = payload();
    if (json === null || json === delivered) return;

    sending = true;
    void send(json)
      .then((accepted) => {
        if (accepted) delivered = json;
      })
      .catch(() => {
        // Silent by contract: the next flush carries the same state anyway.
      })
      .finally(() => {
        sending = false;
      });
  };

  const startTimer = (): void => {
    timer ??= window.setInterval(flush, BEACON_INTERVAL_MS);
  };

  const stopTimer = (): void => {
    if (timer === null) return;
    window.clearInterval(timer);
    timer = null;
  };

  /** Where the video is now, in milliseconds — the unit `watch.ts` works in. */
  const positionMs = (): number => video.currentTime * 1000;

  const onPlay = (): void => {
    firstPlayedAt ??= new Date().toISOString();
    // The delta across a pause is not playback, however long the pause was, so
    // the resume re-anchors rather than counting it (SPEC §16.5).
    heat = reanchor(heat, positionMs());
    startTimer();
  };

  /**
   * The browser fires this only while playback is progressing, a few times a
   * second — which is exactly the sampling `advance` is built for, and the
   * reason there is no timer here.
   *
   * `syncSeek` runs first because `seeked` is the only event that ends a seek,
   * and one that never arrives — a `load()` or an `src` swap, a browser
   * abandoning a seek across a fullscreen transition — would suppress every
   * remaining delta of the session while `watched` and coverage still looked
   * normal. The element's own `seeking` is the state `seeked` is queued from, so
   * this costs nothing when the event does arrive (SPEC §16.5).
   */
  const onTimeUpdate = (): void => {
    const at = positionMs();
    heat = syncSeek(heat, video.seeking, at);
    heat = advance(heat, at, duration());
  };

  /**
   * A seek is in flight until it lands, and nothing in between is playback
   * (SPEC §16.5).
   *
   * These two are not symmetric, and that is the point. A drag across the
   * scrubber fires `seeking` on every pointer move — the element aborts the
   * seek in progress and starts another, so only the last one is ever
   * `seeked` — and it keeps firing `timeupdate` at the positions being scanned
   * past. Re-anchoring on each `seeking` left every one of those steps looking
   * exactly like playback, which painted a scanned span with heat nobody
   * watched. Suppressing the whole interval is the only rule that does not
   * depend on how a browser happens to interleave the two events.
   *
   * No other *event* clears the flag. `play` re-anchors and leaves it set (a
   * viewer can hit play with the scrubber still held); `ratechange` changes the
   * size of the next delta and not its meaning; a stall's `waiting`/`playing`
   * pair does not move `currentTime`, and a seek that rebuffers fires them
   * mid-flight where treating them as a resume would reopen exactly this leak.
   * The one thing that does clear it besides `seeked` is the element's own
   * `seeking` reading false — see `onTimeUpdate`.
   */
  const onSeeking = (): void => {
    heat = beginSeek(heat);
  };

  const onSeeked = (): void => {
    heat = endSeek(heat, positionMs());
  };

  const onPause = (): void => {
    // Immediate, and no debounce: browsers fire `pause` just before `ended`, and
    // the flush refuses to re-send a body identical to the last one accepted, so
    // the pair costs one write rather than two (SPEC §16.5).
    flush();
  };

  const onEnded = (): void => {
    flush();
    stopTimer();
  };

  const onVisibility = (): void => {
    // The reliable one: browsers fire this before backgrounding a tab, and it
    // is the last moment an async encrypt is certain to finish.
    if (document.visibilityState === "hidden") flush();
  };

  const stop = (): void => {
    if (stopped) return;
    flush();
    stopped = true;
    stopTimer();
    video.removeEventListener("play", onPlay);
    video.removeEventListener("pause", onPause);
    video.removeEventListener("ended", onEnded);
    video.removeEventListener("timeupdate", onTimeUpdate);
    video.removeEventListener("seeking", onSeeking);
    video.removeEventListener("seeked", onSeeked);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pagehide", stop);
  };

  video.addEventListener("play", onPlay);
  video.addEventListener("pause", onPause);
  video.addEventListener("ended", onEnded);
  video.addEventListener("timeupdate", onTimeUpdate);
  video.addEventListener("seeking", onSeeking);
  video.addEventListener("seeked", onSeeked);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", stop);

  // Playback may already have started: `player.ts` arms this after a round trip
  // to the gateway's /config, and the MSE path plays as soon as chunk 0 appends.
  // That `play` event is gone, and it does not fire again — so the element's own
  // state stands in for it.
  if (!video.paused || video.played.length > 0) onPlay();

  return { stop };
}

/** localStorage, or null. Chrome throws on the property access when site data is blocked. */
function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
