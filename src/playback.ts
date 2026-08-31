/**
 * The player core — SPEC §8, implemented once and driven by two pages (§17.5).
 *
 * Everything §8 describes lives here: the meta fetch and its validation, the
 * block reader with its Range requests and whole-object fallback, per-chunk
 * decryption and the plaintext-length check, the MSE path with its quota
 * eviction and fetch-ahead, the whole-file fallback and its duration probe, and
 * the buffered-gap jumper. `gap.ts` stays where it is and keeps its tests.
 *
 * What is deliberately *not* here is chrome: fragment parsing, titles, status
 * presentation, error panels, the play affordance and — on `view.html` only —
 * the watch beacon. A page owns those, which is what lets `view.html` keep its
 * design and `video.html` have its own without either forking §8.
 *
 * No module-level per-playback state. `appendedAny` and `sourceCommitted` were
 * module variables when this was `player.ts`; here they belong to the
 * {@link Playback} a call returns, because a module-level flag is a bug waiting
 * for the first page that plays twice.
 */

import { chunkAad, decryptBlock, decryptChunkRange, metaAad } from "./crypto";
import { bufferedRanges, findGapSeek, isStalling } from "./gap";
import type { VideoMeta } from "./types";

/** Seconds of already-played video to keep buffered when evicting under quota pressure. */
const KEEP_BEHIND_SECONDS = 10;

/** How long to wait for playback to advance when the SourceBuffer is full and nothing can be evicted. */
const QUOTA_RETRY_MS = 400;

/** Cap on waiting for the media element during the duration probe, so playback never hangs on it. */
const ELEMENT_TIMEOUT_MS = 5000;

/** How often the stall watchdog samples `currentTime` (SPEC §8). */
const STALL_POLL_MS = 250;

/** Consecutive samples with no progress before a playing element counts as stalled. */
const STALL_TICKS = 3;

/** Floor on repeating the same rescue seek, so a seek that does not take cannot spin. */
const GAP_SEEK_COOLDOWN_MS = 1500;

const CORRUPT_TITLE = "Wrong key or corrupted video";
const CORRUPT_DETAIL =
  "The data did not decrypt with the key in this link. The link may be truncated, or the video may have been re-uploaded or damaged in the bucket.";

/** An error with a message meant for the viewer. Anything else is a bug and gets logged. */
export class PlaybackError extends Error {
  readonly title: string;

  constructor(title: string, message: string) {
    super(message);
    this.name = "PlaybackError";
    this.title = title;
  }
}

export interface PlaybackOptions {
  video: HTMLVideoElement;
  publicBaseUrl: string;
  id: string;
  key: CryptoKey;
  meta: VideoMeta;
  /** `view.html`: true (§8, unchanged). `video.html`: false (§17.4). */
  autoplay: boolean;
  /** A progress line, or null to clear it. */
  onStatus(text: string | null): void;
  /**
   * There is something to play and nothing is playing it: either `play()` was
   * refused by the autoplay policy, or `autoplay` is false and the reader has
   * to ask. Both feed the same play control.
   */
  onAutoplayBlocked(): void;
}

export interface Playback {
  /** Resolves when the last chunk has been appended; rejects with §8's error. */
  readonly done: Promise<void>;
  /**
   * True once MSE accepted a chunk or the blob src was set. Before that a media
   * element error is recoverable — the whole-file fallback is still to come —
   * and must not be reported (SPEC §8).
   */
  sourceCommitted(): boolean;
}

// --- Fetch + decrypt ---------------------------------------------------------

async function get(url: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new PlaybackError(
      "Can’t reach the video",
      `Could not fetch ${url}. The storage bucket may be offline or unreachable from this network, or it may not send the CORS headers this page needs (Access-Control-Allow-Origin, and Range in Access-Control-Allow-Headers).`,
    );
  }
  if (res.status === 404 || res.status === 403) {
    throw new PlaybackError(
      "Video not found",
      `The storage bucket returned ${res.status} for ${url}. Either the video is not there (deleted, or the link points at the wrong id) or the bucket is not publicly readable.`,
    );
  }
  if (!res.ok) {
    throw new PlaybackError(
      "Couldn’t load the video",
      `The storage server responded ${res.status} ${res.statusText}`.trim() + ".",
    );
  }
  return res;
}

async function decryptOrFail(key: CryptoKey, aad: string, block: Uint8Array): Promise<Uint8Array> {
  try {
    return await decryptBlock(key, aad, block);
  } catch {
    throw new PlaybackError(CORRUPT_TITLE, CORRUPT_DETAIL);
  }
}

/** Decrypt video chunk `index` and check its plaintext length against meta (SPEC §4). */
async function decryptChunk(
  key: CryptoKey,
  id: string,
  index: number,
  block: Uint8Array,
  meta: VideoMeta,
): Promise<Uint8Array> {
  const plain = await decryptOrFail(key, chunkAad(id, index), block);
  const expected =
    index === meta.chunkCount - 1 ? meta.totalBytes - index * meta.chunkSize : meta.chunkSize;
  if (plain.length !== expected) {
    throw new PlaybackError(
      CORRUPT_TITLE,
      `Chunk ${index} decrypted to ${plain.length} bytes but the metadata says ${expected}.`,
    );
  }
  return plain;
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function parseMeta(bytes: Uint8Array): VideoMeta {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new PlaybackError(CORRUPT_TITLE, "The video metadata decrypted but is not valid JSON.");
  }
  const m = value as Partial<VideoMeta>;
  const ok =
    typeof value === "object" &&
    value !== null &&
    m.v === 1 &&
    typeof m.title === "string" &&
    typeof m.mimeType === "string" &&
    m.mimeType.length > 0 &&
    typeof m.createdAt === "string" &&
    isNonNegativeInt(m.durationMs) &&
    isNonNegativeInt(m.totalBytes) &&
    isNonNegativeInt(m.chunkSize) &&
    isNonNegativeInt(m.chunkCount) &&
    m.chunkSize > 0 &&
    m.chunkCount > 0 &&
    m.chunkCount === Math.ceil(m.totalBytes / m.chunkSize);
  if (!ok) {
    throw new PlaybackError(
      "Unsupported video",
      "This video's metadata is not a format this player understands. It may have been made by a newer version of VideoShare.",
    );
  }
  return m as VideoMeta;
}

/** `GET {base}/{id}/meta.json`, decrypted and validated (SPEC §5, §8). */
export async function fetchMeta(
  publicBaseUrl: string,
  id: string,
  key: CryptoKey,
): Promise<VideoMeta> {
  const res = await get(`${publicBaseUrl}/${id}/meta.json`);
  const block = new Uint8Array(await res.arrayBuffer());
  return parseMeta(await decryptOrFail(key, metaAad(id), block));
}

/**
 * Reads encrypted block `i` of video.bin. Normally one Range request per block;
 * if the server ignores Range and hands back the whole object, that body is kept
 * and the remaining blocks are sliced out of it instead of re-downloading.
 */
function makeBlockReader(url: string, meta: VideoMeta): (index: number) => Promise<Uint8Array> {
  let whole: Uint8Array | null = null;

  const sliceOf = (buf: Uint8Array, index: number): Uint8Array => {
    const { start, end } = decryptChunkRange(index, meta.chunkCount, meta);
    return buf.subarray(start, end ?? buf.length);
  };

  return async (index) => {
    if (whole) return sliceOf(whole, index);

    const { start, end } = decryptChunkRange(index, meta.chunkCount, meta);
    const range = end === null ? `bytes=${start}-` : `bytes=${start}-${end - 1}`;
    const res = await get(url, { headers: { Range: range } });
    const body = new Uint8Array(await res.arrayBuffer());

    if (res.status === 200 && meta.chunkCount > 1) {
      whole = body;
      return sliceOf(body, index);
    }
    return body;
  };
}

// --- Small helpers -----------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * TypeScript >= 5.7 types a plain `Uint8Array` as possibly SharedArrayBuffer-backed,
 * which the DOM signatures for appendBuffer and Blob parts reject. Nothing here
 * allocates shared memory, so re-typing beats copying megabytes.
 */
function bytes(view: Uint8Array): Uint8Array<ArrayBuffer> {
  return view as Uint8Array<ArrayBuffer>;
}

function canStream(mimeType: string): boolean {
  return typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(mimeType);
}

function isQuotaError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "QuotaExceededError";
}

/**
 * Resolves on `sourceopen`. Rejects if the element rejects the MediaSource
 * instead — otherwise `sourceopen` never fires and the page waits forever
 * rather than falling back to the whole-file path.
 */
function sourceOpen(mediaSource: MediaSource, video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      mediaSource.removeEventListener("sourceopen", onOpen);
      video.removeEventListener("error", onError);
    };
    const onOpen = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(new Error(`the media element rejected the MediaSource (media error ${video.error?.code ?? "?"})`));
    };
    mediaSource.addEventListener("sourceopen", onOpen);
    video.addEventListener("error", onError);
  });
}

function updateEnd(sb: SourceBuffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      sb.removeEventListener("updateend", onEnd);
      sb.removeEventListener("error", onError);
    };
    const onEnd = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(new Error("SourceBuffer reported an error while appending"));
    };
    sb.addEventListener("updateend", onEnd);
    sb.addEventListener("error", onError);
  });
}

/**
 * Watches for a stall the element cannot get itself out of, and steps over the
 * hole in the video timeline that caused it (SPEC §8).
 *
 * Two triggers, because one is not enough. `waiting` is the event for "I ran
 * out of media", but Chrome frequently does not fire it when the playhead
 * reaches the end of a buffered range with another range beyond — the element
 * simply stops advancing, still `readyState >= HAVE_CURRENT_DATA`, no event at
 * all. So `currentTime` is also polled a few times a second and a playing
 * element that has not moved for ~{@link STALL_TICKS} samples is treated as
 * stalled.
 *
 * Whether either trigger actually seeks is left entirely to `findGapSeek`,
 * which only answers with a time when there is a later buffered range to reach:
 * a stall waiting on the network at the head of the buffer looks identical from
 * here and must not turn into a skip.
 *
 * A seek in flight is not a reason to stand down — it is the worst case. An
 * MSE seek into a hole never completes: the element drops to HAVE_METADATA and
 * waits for an append covering the seek point, which an in-order append stream
 * of a recording whose frames were never encoded can never deliver. So a
 * viewer who scrubs into the hole sits at `seeking = true` forever, with no
 * event to follow. The watchdog therefore keeps counting while a seek is
 * pending and leaves the verdict to `findGapSeek`, which is safe precisely
 * because it answers `null` for the two waits that are legitimate: the
 * still-downloading head of the buffer, and a forward seek past it.
 *
 * MSE path only. The whole-file fallback hands the element a complete WebM,
 * where a hole is just a long-held frame and the element plays straight
 * through — nothing to rescue, and a stray seek would only make it worse.
 *
 * Returns the teardown. It also tears itself down on a media error, and pauses
 * at `ended` — the element's next `play` re-arms it, so a viewer who replays
 * the recording meets the same hole and gets the same rescue.
 */
function armGapJumper(video: HTMLVideoElement): () => void {
  let lastTime = -1;
  let stuck = 0;
  let lastTarget = Number.NEGATIVE_INFINITY;
  let lastJumpAt = 0;
  let timer: number | null = null;

  const jump = (): void => {
    // A paused playhead is parked, not stalled. The watchdog already treats it
    // that way; this is for the `waiting` listener, which Chrome fires on a
    // paused element around a readyState drop.
    if (video.paused) return;
    const from = video.currentTime;
    const target = findGapSeek(bufferedRanges(video.buffered), from);
    if (target === null) return;

    // A seek that does not take (the element lands back where it was) would
    // otherwise re-fire every poll for the rest of the recording.
    const now = Date.now();
    if (target <= lastTarget && now - lastJumpAt < GAP_SEEK_COOLDOWN_MS) return;
    lastTarget = target;
    lastJumpAt = now;

    console.info(
      `[videoshare] stepping over a ${(target - from).toFixed(3)}s hole in the video timeline (${from.toFixed(3)} → ${target.toFixed(3)})`,
    );
    // Count the jump as progress so the watchdog gives the seek time to land.
    lastTime = target;
    stuck = 0;
    video.currentTime = target;
  };

  const tick = (): void => {
    // A pending seek is not an excuse — see `isStalling`.
    if (!isStalling(lastTime, video)) {
      lastTime = video.currentTime;
      stuck = 0;
      return;
    }
    if (++stuck >= STALL_TICKS) jump();
  };

  const watch = (): void => {
    lastTime = video.currentTime;
    stuck = 0;
    timer ??= window.setInterval(tick, STALL_POLL_MS);
  };

  /** Stops polling but stays subscribed, so `play` can bring the watchdog back. */
  const rest = (): void => {
    if (timer === null) return;
    window.clearInterval(timer);
    timer = null;
  };

  const disarm = (): void => {
    rest();
    video.removeEventListener("waiting", jump);
    video.removeEventListener("play", watch);
    video.removeEventListener("ended", rest);
    video.removeEventListener("error", disarm);
  };

  video.addEventListener("waiting", jump);
  video.addEventListener("play", watch);
  // Nothing to rescue in the ended state, and the poll would run for as long as
  // the page stays open; a replay fires `play` and arms it again.
  video.addEventListener("ended", rest);
  video.addEventListener("error", disarm);
  watch();
  return disarm;
}

// --- One playback ------------------------------------------------------------

/**
 * One video, from ciphertext to a playing element. Every flag §8 tracks is a
 * field here rather than a module variable, so a second playback in the same
 * document starts clean.
 */
class PlaybackRun implements Playback {
  /** True once at least one chunk reached the SourceBuffer, i.e. MSE is working. */
  private appendedAny = false;

  /**
   * True once a source is final: MSE has accepted a chunk, or the blob src is
   * set. Before that a media-element error is recoverable (the whole-file
   * fallback is still to come), so reporting it would leave an error card over
   * a working video.
   */
  private committed = false;

  readonly done: Promise<void>;

  constructor(private readonly opts: PlaybackOptions) {
    this.done = this.run();
  }

  sourceCommitted(): boolean {
    return this.committed;
  }

  private get video(): HTMLVideoElement {
    return this.opts.video;
  }

  private status(text: string | null): void {
    this.opts.onStatus(text);
  }

  /**
   * There is something to play. `view.html` plays it (§8); `video.html` asks
   * first (§17.4), and a browser that refuses autoplay lands in the same place.
   */
  private begin(): void {
    if (!this.opts.autoplay) {
      this.opts.onAutoplayBlocked();
      return;
    }
    this.video.play().catch(() => this.opts.onAutoplayBlocked());
  }

  private async run(): Promise<void> {
    const { meta, id, publicBaseUrl } = this.opts;
    const url = `${publicBaseUrl}/${id}/video.bin`;

    if (canStream(meta.mimeType)) {
      // Armed for the whole MSE lifetime, and deliberately left running when the
      // append loop returns: the last chunk landing and endOfStream() is exactly
      // when a hole near the end of the recording strands the playhead (§8).
      const disarm = armGapJumper(this.video);
      try {
        await this.streamToMediaSource(makeBlockReader(url, meta));
        return;
      } catch (err) {
        disarm();
        if (err instanceof PlaybackError || this.appendedAny) throw err;
        console.warn("[videoshare] progressive playback failed, downloading the whole file", err);
      }
    }
    await this.playWholeFile(url);
  }

  // --- Progressive (MSE) playback -------------------------------------------

  /** Drop already-played data so the next append fits, or wait for playback to advance. */
  private async freeSpace(sb: SourceBuffer): Promise<void> {
    const keepFrom = Math.max(0, this.video.currentTime - KEEP_BEHIND_SECONDS);
    const start = sb.buffered.length > 0 ? sb.buffered.start(0) : 0;
    if (sb.buffered.length > 0 && start < keepFrom) {
      sb.remove(start, keepFrom);
      await updateEnd(sb);
      return;
    }
    await delay(QUOTA_RETRY_MS);
  }

  private async append(sb: SourceBuffer, data: Uint8Array): Promise<void> {
    for (;;) {
      try {
        sb.appendBuffer(bytes(data));
      } catch (err) {
        if (!isQuotaError(err)) throw err;
        await this.freeSpace(sb);
        continue;
      }
      await updateEnd(sb);
      return;
    }
  }

  private async streamToMediaSource(
    readBlock: (index: number) => Promise<Uint8Array>,
  ): Promise<void> {
    const { meta, id, key } = this.opts;
    const mediaSource = new MediaSource();
    const objectUrl = URL.createObjectURL(mediaSource);
    this.video.src = objectUrl;
    await sourceOpen(mediaSource, this.video);
    URL.revokeObjectURL(objectUrl);

    const sb = mediaSource.addSourceBuffer(meta.mimeType);
    // Gives a real seek bar before the last chunk lands; appends extend it if the
    // recording turns out longer, and endOfStream() trims it to the truth.
    if (meta.durationMs > 0) mediaSource.duration = meta.durationMs / 1000;

    let pending = readBlock(0);
    try {
      for (let i = 0; i < meta.chunkCount; i++) {
        const block = await pending;
        if (i + 1 < meta.chunkCount) pending = readBlock(i + 1); // fetch ahead while this one decrypts

        const plain = await decryptChunk(key, id, i, block, meta);
        await this.append(sb, plain);
        this.appendedAny = true;
        this.committed = true;

        if (i === 0) this.begin();
        if (i + 1 < meta.chunkCount) this.status(`Buffering ${i + 1} of ${meta.chunkCount}`);
      }
    } catch (err) {
      void pending.catch(() => {}); // the fetched-ahead block is no longer awaited
      throw err;
    }

    if (mediaSource.readyState === "open") mediaSource.endOfStream();
    this.status(null);
  }

  // --- Whole-file fallback ---------------------------------------------------

  /** Resolves on the first of `types` the element fires, or after `ELEMENT_TIMEOUT_MS`. */
  private videoEvent(types: readonly string[]): Promise<void> {
    const video = this.video;
    return new Promise((resolve) => {
      const finish = (): void => {
        window.clearTimeout(timer);
        for (const type of types) video.removeEventListener(type, finish);
        resolve();
      };
      const timer = window.setTimeout(finish, ELEMENT_TIMEOUT_MS);
      for (const type of types) video.addEventListener(type, finish);
    });
  }

  /**
   * MediaRecorder WebM without a duration in its header makes the element report
   * Infinity; seeking far past the end forces the browser to scan for the real one.
   *
   * This has to finish before playback starts: seeking a *playing* element to the
   * end fires "ended", which pauses it, and nothing would resume it afterwards.
   */
  private async ensureDuration(): Promise<void> {
    await this.videoEvent(["loadedmetadata", "error"]);
    if (this.video.duration !== Infinity) return;

    const probed = this.videoEvent(["durationchange", "error"]);
    try {
      this.video.currentTime = 1e101;
      await probed;
      this.video.currentTime = 0;
    } catch {
      // The element refused the seek; play from the start with the duration it has.
    }
  }

  /**
   * Own scope on purpose: the ciphertext and the decrypted parts both fall out of
   * reach the moment this returns, leaving only the Blob (which the browser is
   * free to spill to disk) alive during playback.
   */
  private async decryptWholeFile(whole: Uint8Array): Promise<Blob> {
    const { meta, id, key } = this.opts;
    const parts: BlobPart[] = [];
    for (let i = 0; i < meta.chunkCount; i++) {
      const { start, end } = decryptChunkRange(i, meta.chunkCount, meta);
      const block = whole.subarray(start, end ?? whole.length);
      parts.push(bytes(await decryptChunk(key, id, i, block, meta)));
      this.status(`Decrypting ${i + 1} of ${meta.chunkCount}`);
    }
    return new Blob(parts, { type: meta.mimeType });
  }

  private async playWholeFile(url: string): Promise<void> {
    this.status("Downloading video…");
    const res = await get(url);
    const blob = await this.decryptWholeFile(new Uint8Array(await res.arrayBuffer()));

    this.video.src = URL.createObjectURL(blob);
    this.committed = true;
    this.status(null);
    await this.ensureDuration();
    this.begin();
  }
}

/**
 * Starts fetching, decrypting and appending immediately. Nothing is deferred:
 * the returned handle is only how a page watches the outcome and asks whether a
 * media error is worth reporting yet.
 */
export function startPlayback(opts: PlaybackOptions): Playback {
  return new PlaybackRun(opts);
}
