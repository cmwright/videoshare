// Page controller for view.html — SPEC §8.
// No credentials here: the video id and AES key come from the URL fragment,
// ciphertext comes from the public bucket, decryption happens in this tab.

import "./app.css";
import "./player.css";

import { chunkAad, decryptBlock, decryptChunkRange, importKeyB64, metaAad } from "./crypto";
import { publicBaseUrl } from "./settings";
import type { VideoMeta } from "./types";
import { formatDuration } from "./util";

/** `#{id}.{key}` — 22-char base64url id, 43-char base64url AES-256 key (SPEC §2). */
const FRAGMENT_RE = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;

/** Seconds of already-played video to keep buffered when evicting under quota pressure. */
const KEEP_BEHIND_SECONDS = 10;

/** How long to wait for playback to advance when the SourceBuffer is full and nothing can be evicted. */
const QUOTA_RETRY_MS = 400;

/** Cap on waiting for the media element during the duration probe, so playback never hangs on it. */
const ELEMENT_TIMEOUT_MS = 5000;

const CORRUPT_TITLE = "Wrong key or corrupted video";
const CORRUPT_DETAIL =
  "The data did not decrypt with the key in this link. The link may be truncated, or the video may have been re-uploaded or damaged in the bucket.";

/** An error with a message meant for the viewer. Anything else is a bug and gets logged. */
class PlaybackError extends Error {
  readonly title: string;

  constructor(title: string, message: string) {
    super(message);
    this.name = "PlaybackError";
    this.title = title;
  }
}

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`view.html is missing #${id}`);
  return node as T;
}

const video = el<HTMLVideoElement>("video");
const stage = el("stage");
const videoHeader = el("video-header");
const videoTitle = el("video-title");
const videoMeta = el("video-meta");
const statusRow = el("status");
const statusText = el("status-text");
const playOverlay = el("play-overlay");
const playButton = el<HTMLButtonElement>("play-button");
const errorCard = el("error-card");
const errorTitle = el("error-title");
const errorDetail = el("error-detail");

/** True once at least one chunk reached the SourceBuffer, i.e. MSE is working. */
let appendedAny = false;

/**
 * True once a source is final: MSE has accepted a chunk, or the blob src is set.
 * Before that a media-element error is recoverable (the whole-file fallback is
 * still to come), so reporting it would leave an error card over a working video.
 */
let sourceCommitted = false;

// --- UI -------------------------------------------------------------------

function setStatus(text: string): void {
  statusText.textContent = text;
  statusRow.classList.remove("hidden");
}

function clearStatus(): void {
  statusRow.classList.add("hidden");
}

function showError(title: string, detail: string): void {
  if (!errorCard.classList.contains("hidden")) return; // keep the first, most specific error
  errorTitle.textContent = title;
  errorDetail.textContent = detail;
  errorCard.classList.remove("hidden");
  playOverlay.classList.add("hidden");
  clearStatus();
  if (video.readyState < HTMLMediaElement.HAVE_METADATA) stage.classList.add("hidden");
}

function showMeta(meta: VideoMeta): void {
  const title = meta.title.trim() || "Untitled recording";
  videoTitle.textContent = title;
  document.title = `${title} · VideoShare`;

  const parts: string[] = [];
  const created = new Date(meta.createdAt);
  if (!Number.isNaN(created.getTime())) {
    parts.push(created.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }));
  }
  if (meta.durationMs > 0) parts.push(formatDuration(meta.durationMs));
  videoMeta.textContent = parts.join(" · ");
  videoHeader.classList.remove("hidden");
}

function startPlayback(): void {
  video.play().catch(() => playOverlay.classList.remove("hidden"));
}

// --- Small async helpers --------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * TypeScript >= 5.7 types a plain `Uint8Array` as possibly SharedArrayBuffer-backed,
 * which the DOM signatures for appendBuffer and Blob parts reject. Nothing here
 * allocates shared memory, so re-typing beats copying megabytes.
 */
function bytes(view: Uint8Array): Uint8Array<ArrayBuffer> {
  return view as Uint8Array<ArrayBuffer>;
}

// --- Fetch + decrypt ------------------------------------------------------

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

async function loadMeta(base: string, id: string, key: CryptoKey): Promise<VideoMeta> {
  const res = await get(`${base}/${id}/meta.json`);
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

// --- Progressive (MSE) playback ------------------------------------------

function canStream(mimeType: string): boolean {
  return typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(mimeType);
}

/**
 * Resolves on `sourceopen`. Rejects if the element rejects the MediaSource
 * instead — otherwise `sourceopen` never fires and the page waits forever
 * rather than falling back to the whole-file path.
 */
function sourceOpen(mediaSource: MediaSource): Promise<void> {
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

function isQuotaError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "QuotaExceededError";
}

/** Drop already-played data so the next append fits, or wait for playback to advance. */
async function freeSpace(sb: SourceBuffer): Promise<void> {
  const keepFrom = Math.max(0, video.currentTime - KEEP_BEHIND_SECONDS);
  const start = sb.buffered.length > 0 ? sb.buffered.start(0) : 0;
  if (sb.buffered.length > 0 && start < keepFrom) {
    sb.remove(start, keepFrom);
    await updateEnd(sb);
    return;
  }
  await delay(QUOTA_RETRY_MS);
}

async function append(sb: SourceBuffer, data: Uint8Array): Promise<void> {
  for (;;) {
    try {
      sb.appendBuffer(bytes(data));
    } catch (err) {
      if (!isQuotaError(err)) throw err;
      await freeSpace(sb);
      continue;
    }
    await updateEnd(sb);
    return;
  }
}

async function streamToMediaSource(
  meta: VideoMeta,
  id: string,
  key: CryptoKey,
  readBlock: (index: number) => Promise<Uint8Array>,
): Promise<void> {
  const mediaSource = new MediaSource();
  const objectUrl = URL.createObjectURL(mediaSource);
  video.src = objectUrl;
  await sourceOpen(mediaSource);
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
      await append(sb, plain);
      appendedAny = true;
      sourceCommitted = true;

      if (i === 0) startPlayback();
      if (i + 1 < meta.chunkCount) setStatus(`Buffering ${i + 1} of ${meta.chunkCount}`);
    }
  } catch (err) {
    void pending.catch(() => {}); // the fetched-ahead block is no longer awaited
    throw err;
  }

  if (mediaSource.readyState === "open") mediaSource.endOfStream();
  clearStatus();
}

// --- Whole-file fallback --------------------------------------------------

/** Resolves on the first of `types` the element fires, or after `ELEMENT_TIMEOUT_MS`. */
function videoEvent(types: readonly string[]): Promise<void> {
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
async function ensureDuration(): Promise<void> {
  await videoEvent(["loadedmetadata", "error"]);
  if (video.duration !== Infinity) return;

  const probed = videoEvent(["durationchange", "error"]);
  try {
    video.currentTime = 1e101;
    await probed;
    video.currentTime = 0;
  } catch {
    // The element refused the seek; play from the start with the duration it has.
  }
}

/**
 * Own scope on purpose: the ciphertext and the decrypted parts both fall out of
 * reach the moment this returns, leaving only the Blob (which the browser is
 * free to spill to disk) alive during playback.
 */
async function decryptWholeFile(
  meta: VideoMeta,
  id: string,
  key: CryptoKey,
  whole: Uint8Array,
): Promise<Blob> {
  const parts: BlobPart[] = [];
  for (let i = 0; i < meta.chunkCount; i++) {
    const { start, end } = decryptChunkRange(i, meta.chunkCount, meta);
    const block = whole.subarray(start, end ?? whole.length);
    parts.push(bytes(await decryptChunk(key, id, i, block, meta)));
    setStatus(`Decrypting ${i + 1} of ${meta.chunkCount}`);
  }
  return new Blob(parts, { type: meta.mimeType });
}

async function playWholeFile(meta: VideoMeta, id: string, key: CryptoKey, url: string): Promise<void> {
  setStatus("Downloading video…");
  const res = await get(url);
  const blob = await decryptWholeFile(meta, id, key, new Uint8Array(await res.arrayBuffer()));

  video.src = URL.createObjectURL(blob);
  sourceCommitted = true;
  clearStatus();
  await ensureDuration();
  startPlayback();
}

// --- Entry point ----------------------------------------------------------

function parseFragment(hash: string): { id: string; keyB64: string } | null {
  let raw = hash.startsWith("#") ? hash.slice(1) : hash;
  try {
    raw = decodeURIComponent(raw);
  } catch {
    // not percent-encoded; use it as-is
  }
  const m = FRAGMENT_RE.exec(raw.trim());
  return m ? { id: m[1], keyB64: m[2] } : null;
}

async function main(): Promise<void> {
  const fragment = parseFragment(location.hash);
  if (!fragment) {
    showError(
      "Incomplete link",
      "This link is missing the video id and key. A share link looks like …/view.html#<id>.<key> — copy the whole thing, including everything after the #.",
    );
    return;
  }

  let base: string;
  try {
    base = publicBaseUrl();
  } catch (err) {
    showError("Not configured", messageOf(err));
    return;
  }

  let key: CryptoKey;
  try {
    key = await importKeyB64(fragment.keyB64);
  } catch {
    showError("Invalid key", "The key in this link is not a valid AES-256 key. Copy the share link again in full.");
    return;
  }

  setStatus("Loading…");
  const meta = await loadMeta(base, fragment.id, key);
  showMeta(meta);

  const url = `${base}/${fragment.id}/video.bin`;
  if (canStream(meta.mimeType)) {
    try {
      await streamToMediaSource(meta, fragment.id, key, makeBlockReader(url, meta));
      return;
    } catch (err) {
      if (err instanceof PlaybackError || appendedAny) throw err;
      console.warn("[videoshare] progressive playback failed, downloading the whole file", err);
    }
  }
  await playWholeFile(meta, fragment.id, key, url);
}

playButton.addEventListener("click", () => {
  video.play().catch((err: unknown) => console.warn("[videoshare] play() rejected", err));
});
video.addEventListener("play", () => playOverlay.classList.add("hidden"));
video.addEventListener("error", () => {
  const code = video.error?.code;
  // Before a source is committed the whole-file fallback may still rescue this.
  if (code === undefined || !sourceCommitted) return;
  showError(
    "Playback failed",
    `Your browser could not play this recording (media error ${code}). It is most likely missing a codec — try the latest Chrome, Edge or Firefox.`,
  );
});

main().catch((err: unknown) => {
  if (err instanceof PlaybackError) {
    showError(err.title, err.message);
  } else {
    console.error("[videoshare]", err);
    showError("Something went wrong", messageOf(err));
  }
});
