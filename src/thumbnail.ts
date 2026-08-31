/**
 * The optional encrypted thumbnail, both ends of it (docs/SPEC.md §3, §6, §17.3).
 *
 * `{id}/thumb.bin` is one §4 encrypted block whose plaintext is a JPEG, sealed
 * under `thumbAad(id)`. It is decrypted by the same key as everything else, so a
 * thumbnail is readable by exactly the holders of the share link — and it is
 * *optional*: nothing in `meta.json` records whether it exists, every reader
 * fetches and falls back, and a video without one is a working video.
 *
 * The module is split the way `gap.ts` and `watch.ts` are, on testability:
 *
 * - `thumbSize` and `isBlankFrame` are pure arithmetic over numbers and RGBA
 *   bytes. They are where §6's two give-up conditions — "zero-sized" and "all
 *   black" — actually live, and they are tested in Node.
 * - `captureThumbnail` needs a canvas, a `MediaStream` and a `<video>`;
 *   `fetchThumbnail` needs the network. Neither is tested in Node, because a
 *   stub of all three would test the stub.
 *
 * There is no module-level state and no DOM is touched at import time, so
 * `video.html`'s bundle keeps `fetchThumbnail` and tree-shakes the capture half
 * away. The object-URL cache is a page's business, not this module's (§17.3).
 */

import { decryptBlock, thumbAad } from "./crypto";

/** Cap on the stored width; the height follows from the frame's own aspect (§6). */
export const THUMB_MAX_WIDTH = 640;
/** `canvas.toBlob` quality — 640×360 of screen content lands at 15–50 KB. */
export const THUMB_JPEG_QUALITY = 0.72;
/** First attempt, timed from engine start (§6). */
export const THUMB_FIRST_TRY_MS = 1_000;
/** The one retry, also timed from engine start. Two attempts, never a loop (§6). */
export const THUMB_RETRY_MS = 2_500;
/** A channel at or below this counts as black (§6's all-black give-up). */
export const THUMB_BLANK_LEVEL = 8;
/** A reader never buffers more than this from an object it did not write (§3). */
export const MAX_THUMB_BYTES = 2 * 1024 * 1024;
/** Library rows fetching thumbnails at once (§17.3) — its own budget, not the summaries'. */
export const LIBRARY_THUMB_CONCURRENCY = 4;

/** How long one attempt waits for the hidden element to have a frame to paint. */
const FRAME_WAIT_MS = 600;

/** Structural stand-in for `ImageData`, so the pure half needs no canvas. */
export interface FrameData {
  width: number;
  height: number;
  /** RGBA, row-major. */
  data: Uint8ClampedArray | ArrayLike<number>;
}

/** Optional out-parameter for a caller that caches — see {@link fetchThumbnail}. */
export interface ThumbnailOutcome {
  /**
   * False when the object could not be fetched at all: a network error, a body
   * abandoned part-way, or a status that says "not right now" rather than "not
   * here" — a 429, a 408, any 5xx. A 404, a 403 and a block that will not
   * decrypt all leave this **true** — those are facts about the video, which a
   * caller may remember, while a bucket having a bad moment is a fact about the
   * moment, which it must not (§17.3).
   */
  reachable: boolean;
}

/**
 * The statuses that answer "this video has no thumbnail" rather than "not right
 * now": the object is not there for this reader, and a retry would say the same.
 *
 * §3 names 404 and 403 — a bucket with no anonymous `ListBucket` returns one or
 * the other for an object that was never written, which is every recording made
 * before §3 existed. 401 and 410 are the same answer in different words.
 *
 * Everything else is the moment, not the video, and §17.3 forbids caching it:
 * a 429 is the plausible one, since a forty-row library fans out GETs and a
 * bucket or CDN may well ask it to slow down — cached as a miss, that row would
 * keep its pattern for the rest of the document's lifetime for a condition that
 * passed seconds later. A 408 and every 5xx are the same kind of answer, and so
 * is anything unexpected: the safe default for a status this code has never
 * heard of is to fetch it again next time, which costs one GET.
 */
const MISS_STATUSES: ReadonlySet<number> = new Set([401, 403, 404, 410]);

function usable(n: number): boolean {
  return Number.isFinite(n) && n > 0;
}

/** Rounds down to an even number — encoders and the row's frame both prefer them. */
function even(n: number): number {
  return Math.max(0, Math.floor(n / 2) * 2);
}

/**
 * The even-sided box a frame is drawn into, or null when it has no usable size.
 *
 * The width is capped at `maxWidth`, the height follows from the frame's own
 * aspect, and nothing is ever upscaled: a capture narrower than the cap keeps
 * its own size, and a portrait or 4:3 capture keeps its own shape for the row's
 * 16:9 frame to crop (§17.3). `null` covers `0`, negatives, `NaN` and
 * `Infinity` in either dimension, and any aspect so extreme that a side rounds
 * away to nothing — which is exactly §6's "zero-sized" give-up.
 */
export function thumbSize(
  width: number,
  height: number,
  maxWidth: number = THUMB_MAX_WIDTH,
): { width: number; height: number } | null {
  if (!usable(width) || !usable(height)) return null;
  const cap = usable(maxWidth) ? maxWidth : THUMB_MAX_WIDTH;

  const scale = Math.min(1, cap / width);
  const box = { width: even(width * scale), height: even(height * scale) };
  return box.width > 0 && box.height > 0 ? box : null;
}

/**
 * True when every pixel is at or below `THUMB_BLANK_LEVEL` in R, G and B.
 *
 * Alpha is ignored on purpose: a canvas that was never painted reads as
 * transparent black, and so does a screen that has not started delivering.
 * §6 treats the two the same because it cannot tell them apart and does not
 * need to — both mean "try again in a moment, then give up".
 */
export function isBlankFrame(frame: FrameData): boolean {
  const pixels = usable(frame.width) && usable(frame.height) ? frame.width * frame.height : 0;
  const end = Math.min(frame.data.length, Math.floor(pixels) * 4);
  for (let i = 0; i + 2 < end; i += 4) {
    if (
      frame.data[i] > THUMB_BLANK_LEVEL ||
      frame.data[i + 1] > THUMB_BLANK_LEVEL ||
      frame.data[i + 2] > THUMB_BLANK_LEVEL
    ) {
      return false;
    }
  }
  return true;
}

// --- Capture (browser only, SPEC §6) -----------------------------------------

/**
 * One attempt at a thumbnail: paint a frame of `stream`, scale it, JPEG-encode
 * it. Null on *any* failure — no frame yet, a zero size, an all-black paint, a
 * canvas or a `toBlob` that throws — because §6's whole rule for this is that a
 * recording without a thumbnail is a working recording.
 *
 * The frame is read from the **stream**, never from the WebCodecs frame
 * pipeline: the MediaRecorder fallback engine has no such pipeline, and one code
 * path that works on both engines is worth more than a frame the primary engine
 * could have handed over for free.
 *
 * The track it reads is the recording's own, so this **never** calls
 * `track.stop()`. The hidden element and the canvas it does own are torn down
 * before it resolves, on every path. The schedule — first try, one retry, give
 * up — belongs to `record.ts`, where the recording's lifecycle lives.
 */
export async function captureThumbnail(stream: MediaStream): Promise<Uint8Array | null> {
  const track = stream.getVideoTracks()[0];
  if (!track || track.readyState !== "live" || typeof document === "undefined") return null;

  let element: HTMLVideoElement | null = null;
  try {
    // Video only, and a stream of our own: the element must not pull the mixed
    // audio track through a second sink, and the track itself is borrowed.
    element = hiddenVideo(new MediaStream([track]));
    await waitForFrame(element);

    const size = thumbSize(element.videoWidth, element.videoHeight);
    if (!size) return null;

    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (!context) return null;

    // The whole cost of an attempt: one drawImage, one readback of a 640×360
    // buffer for the blank test, and one toBlob — on a timer callback, never on
    // the `ondata` path (§6).
    context.drawImage(element, 0, 0, size.width, size.height);
    if (isBlankFrame(context.getImageData(0, 0, size.width, size.height))) return null;

    const jpeg = await toJpeg(canvas);
    if (!jpeg || jpeg.size === 0) return null;
    return new Uint8Array(await jpeg.arrayBuffer());
  } catch (err) {
    console.warn("[videoshare] thumbnail capture failed; the recording is unaffected", err);
    return null;
  } finally {
    if (element) {
      element.pause();
      element.srcObject = null;
      element.remove();
    }
  }
}

/** Never visible, never focusable, never in the tab order — and never stopped. */
function hiddenVideo(feed: MediaStream): HTMLVideoElement {
  const element = document.createElement("video");
  element.muted = true;
  element.defaultMuted = true;
  element.playsInline = true;
  element.setAttribute("playsinline", "");
  element.setAttribute("aria-hidden", "true");
  element.tabIndex = -1;
  // Off-screen rather than `display: none`: a display-none element is not
  // guaranteed to decode frames, and a frame is the entire point.
  element.style.cssText =
    "position:fixed;left:-10000px;top:0;width:2px;height:2px;opacity:0;pointer-events:none;";
  element.srcObject = feed;
  (document.body ?? document.documentElement).append(element);
  return element;
}

/**
 * Resolves once the element has data to paint, or after `FRAME_WAIT_MS`.
 *
 * The timeout is not a failure path of its own: an attempt that paints nothing
 * is caught by `videoWidth === 0` or by `isBlankFrame` a few lines later, and
 * §6's retry is what answers it.
 */
async function waitForFrame(element: HTMLVideoElement): Promise<void> {
  // A muted MediaStream element autoplays, but a rejected play() is not fatal:
  // the element still reaches HAVE_CURRENT_DATA for a live track.
  await element.play().catch(() => undefined);
  if (element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && element.videoWidth > 0) return;

  await new Promise<void>((resolve) => {
    const done = (): void => {
      window.clearTimeout(timer);
      element.removeEventListener("loadeddata", done);
      resolve();
    };
    const timer = window.setTimeout(done, FRAME_WAIT_MS);
    element.addEventListener("loadeddata", done);
  });
}

function toJpeg(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob(resolve, "image/jpeg", THUMB_JPEG_QUALITY);
    } catch {
      resolve(null);
    }
  });
}

// --- Reading (SPEC §3) --------------------------------------------------------

/**
 * `GET {publicBaseUrl}/{id}/thumb.bin`, decrypted under `thumbAad(id)`.
 *
 * This is the whole of §3's fetch-and-fallback rule in one place, so that no
 * page re-implements it: the read is bounded at `MAX_THUMB_BYTES`, and the
 * answer is `null` — never a throw — for a 404, a 403, a network failure, an
 * oversized body or a block that will not decrypt. Every caller's response to
 * `null` is the same: keep the placeholder it already had and say nothing.
 *
 * The plaintext is not sniffed. Anything that decrypts was written by a holder
 * of the key, and an image that will not decode is caught by the rendering
 * element's own `error` event (§17.3, §17.4).
 *
 * `outcome` is optional and exists for callers that cache: see
 * {@link ThumbnailOutcome}. A caller that does not cache ignores it.
 */
export async function fetchThumbnail(
  publicBaseUrl: string,
  id: string,
  key: CryptoKey,
  outcome?: ThumbnailOutcome,
): Promise<Blob | null> {
  let res: Response;
  try {
    res = await fetch(`${publicBaseUrl}/${id}/thumb.bin`);
  } catch {
    if (outcome) outcome.reachable = false;
    return null;
  }

  // 404 and 403 are the ordinary answers for "this video has no thumbnail" —
  // every recording made before §3 existed is one of them. A 429, a 408 or a 5xx
  // is the bucket having a bad moment, which is not a fact about the video.
  if (!res.ok) {
    if (outcome && !MISS_STATUSES.has(res.status)) outcome.reachable = false;
    void res.body?.cancel().catch(() => undefined);
    return null;
  }

  const block = await readBounded(res, outcome);
  if (!block) return null;

  try {
    const jpeg = await decryptBlock(key, thumbAad(id), block);
    // lib.dom's BlobPart excludes SharedArrayBuffer-backed views; nothing here
    // is one.
    return new Blob([jpeg as BlobPart], { type: "image/jpeg" });
  } catch {
    return null;
  }
}

/**
 * The response body, or null if it is — or claims to be — larger than
 * `MAX_THUMB_BYTES`. A declared `Content-Length` above the ceiling is refused
 * without reading a byte; a body that exceeds it while streaming is abandoned.
 * Nothing this app writes comes close: the cap is there so a reader never
 * buffers an object it did not write (§3, on §16.3's principle).
 *
 * An object over the ceiling is a fact about the object and leaves
 * `outcome.reachable` alone; a body that breaks mid-stream is transport and
 * clears it (§17.3).
 */
async function readBounded(res: Response, outcome?: ThumbnailOutcome): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_THUMB_BYTES) {
    void res.body?.cancel().catch(() => undefined);
    return null;
  }

  const body = res.body;
  if (!body) {
    try {
      const whole = new Uint8Array(await res.arrayBuffer());
      return whole.length > MAX_THUMB_BYTES ? null : whole;
    } catch {
      if (outcome) outcome.reachable = false;
      return null;
    }
  }

  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.length;
      if (total > MAX_THUMB_BYTES) {
        void reader.cancel().catch(() => undefined);
        return null;
      }
      parts.push(value);
    }
  } catch {
    if (outcome) outcome.reachable = false;
    return null;
  }

  const block = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    block.set(part, offset);
    offset += part.length;
  }
  return block;
}
