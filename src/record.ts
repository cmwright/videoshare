/**
 * Recorder page controller (docs/SPEC.md §6).
 *
 * State machine: idle → picking → recording → preview → finishing → done.
 * The multipart upload is created at record start and fed 8 MiB chunks while
 * the capture is still running, so Finish only has to send the tail. Everything
 * leaves this page encrypted; the key only ever lands in the share link's fragment.
 */

import "./app.css";
import "./record.css";

import { CHUNK_OVERHEAD, CHUNK_SIZE, generateKey } from "./crypto";
import {
  addToLibrary,
  DEFAULT_VIDEO_BITS_PER_SECOND,
  loadLibrary,
  loadSettings,
  publicBaseUrl,
  removeFromLibrary,
  saveSettings,
} from "./settings";
import type { LibraryEntry, Settings, VideoMeta } from "./types";
import { createUploadSession, type UploadSession } from "./upload";
import { formatBytes, formatDuration, randomId } from "./util";

const AUDIO_BITRATE = 128_000;
const TIMESLICE_MS = 1000;

/** Cap on waiting for the preview element during the duration probe. */
const ELEMENT_TIMEOUT_MS = 5000;

/** First supported wins (SPEC §6). */
const MIME_CANDIDATES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

// --- DOM ---------------------------------------------------------------------

function el<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`record.ts: missing element ${selector}`);
  return node;
}

const stages = Array.from(document.querySelectorAll<HTMLElement>("[data-stage]"));

const settingsPanel = el<HTMLDetailsElement>("#settings-panel");
const settingsForm = el<HTMLFormElement>("#settings-form");
const settingsStatus = el<HTMLElement>("#settings-status");

const micToggle = el<HTMLInputElement>("#mic");
const startButton = el<HTMLButtonElement>("#start");
const stopButton = el<HTMLButtonElement>("#stop");
const timerLabel = el<HTMLElement>("#timer");
const uploadedLabel = el<HTMLElement>("#uploaded");

const previewVideo = el<HTMLVideoElement>("#preview");
const previewInfo = el<HTMLElement>("#preview-info");
const titleInput = el<HTMLInputElement>("#title");
const finishButton = el<HTMLButtonElement>("#finish");
const discardButton = el<HTMLButtonElement>("#discard");

const progressBar = el<HTMLElement>("#progress");
const progressFill = el<HTMLElement>("#progress-fill");
const progressText = el<HTMLElement>("#progress-text");
const recoveryBlock = el<HTMLElement>("#recovery");
const downloadLink = el<HTMLAnchorElement>("#download");
const retryButton = el<HTMLButtonElement>("#retry");

const linkInput = el<HTMLInputElement>("#link");
const copyLinkButton = el<HTMLButtonElement>("#copy-link");
const againButton = el<HTMLButtonElement>("#again");

const messageLine = el<HTMLElement>("#message");
const libraryList = el<HTMLUListElement>("#library-list");
const libraryEmpty = el<HTMLElement>("#library-empty");

// --- State -------------------------------------------------------------------

type Stage = "idle" | "picking" | "recording" | "preview" | "finishing" | "done";

/** Every stream and node acquired for one capture, so all of it can be released together. */
interface Capture {
  display: MediaStream;
  mic: MediaStream | null;
  audio: AudioContext | null;
  recorded: MediaStream;
}

/** What the preview and Finish need once the recorder has stopped. */
interface Finished {
  blob: Blob;
  durationMs: number;
  totalBytes: number;
  chunkCount: number;
  /** Whatever the assembler had left over — the final, possibly short, chunk. */
  tail: Uint8Array | null;
}

let stage: Stage = "idle";
let capture: Capture | null = null;
let recorder: MediaRecorder | null = null;

let session: UploadSession | null = null;
let videoId = "";
let mimeType = "";

/** Every dataavailable Blob, retained until the share link exists (SPEC §6). */
let recordedParts: Blob[] = [];
let recordedBytes = 0;

/** Recorded bytes not yet handed to the session, and their running size. */
let assembly: Blob[] = [];
let assemblyBytes = 0;
/** Serializes the chunk assembler so `dataavailable` never waits on the network. */
let pump: Promise<void> = Promise.resolve();
/** Recording has stopped and the backlog is still draining — the clock is frozen. */
let draining = false;

let startedAt = 0;
let timerId = 0;
let finished: Finished | null = null;
/** Ciphertext bytes the completed video.bin will total, for the finishing bar. */
let expectedBytes = 0;

let previewUrl: string | null = null;
let downloadUrl: string | null = null;

function setStage(next: Stage): void {
  stage = next;
  for (const node of stages) node.classList.toggle("hidden", node.dataset.stage !== next);
}

// --- Small helpers -----------------------------------------------------------

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function clearMessage(): void {
  messageLine.textContent = "";
  messageLine.classList.remove("error");
}

function showNote(text: string): void {
  messageLine.textContent = text;
  messageLine.classList.remove("error");
}

function showError(text: string): void {
  messageLine.textContent = text;
  messageLine.classList.add("error");
}

/** Zero-padded mm:ss (h:mm:ss past an hour) for the live recording clock. */
function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const mm = String(Math.floor(total / 60) % 60).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function flash(button: HTMLButtonElement, text: string): void {
  const original = button.textContent;
  button.textContent = text;
  window.setTimeout(() => {
    button.textContent = original;
  }, 1200);
}

async function copyLink(text: string, button: HTMLButtonElement): Promise<void> {
  if (await copyToClipboard(text)) flash(button, "Copied");
  else showError("The clipboard was blocked — select the link and copy it manually.");
}

// --- Settings panel ----------------------------------------------------------

function field(name: string): HTMLInputElement {
  const input = settingsForm.elements.namedItem(name);
  if (!(input instanceof HTMLInputElement)) throw new Error(`record.ts: missing settings field ${name}`);
  return input;
}

function fillSettingsForm(saved: Settings): void {
  field("endpoint").value = saved.endpoint;
  field("region").value = saved.region;
  field("bucket").value = saved.bucket;
  field("accessKeyId").value = saved.accessKeyId;
  field("secretAccessKey").value = saved.secretAccessKey;
  field("publicBaseUrl").value = saved.publicBaseUrl;
  field("videoBitsPerSecond").value = String(saved.videoBitsPerSecond);
}

function showSettingsStatus(text: string, isError: boolean): void {
  settingsStatus.textContent = text;
  settingsStatus.classList.toggle("error", isError);
}

/** Opens the panel and points the user at it — recording cannot start without settings. */
function demandSettings(text: string): void {
  settingsPanel.open = true;
  settingsPanel.scrollIntoView({ block: "nearest" });
  showError(text);
}

/**
 * Share links point at this site, and the viewer resolves the bucket through
 * config.js (SPEC §10) — not through the settings below. If the two disagree,
 * uploads succeed but every link generated here points somewhere view.html
 * will not look.
 */
function publicBaseUrlWarning(saved: Settings): string | null {
  let deployed: string;
  try {
    deployed = publicBaseUrl();
  } catch {
    return null;
  }
  if (!saved.publicBaseUrl || saved.publicBaseUrl === deployed) return null;
  return (
    `Viewers load videos from ${deployed} (set in config.js), not ${saved.publicBaseUrl}. ` +
    "Make the two match, or shared links won't play."
  );
}

function initSettings(): void {
  const saved = loadSettings();
  if (saved) {
    fillSettingsForm(saved);
    const warning = publicBaseUrlWarning(saved);
    if (warning) {
      settingsPanel.open = true;
      showSettingsStatus(warning, true);
    }
    return;
  }

  settingsPanel.open = true;
  try {
    field("publicBaseUrl").value = publicBaseUrl();
  } catch {
    // config.js is missing or malformed; the placeholder stands in.
  }
}

settingsForm.addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    // saveSettings normalizes: trailing slashes, blank region, bad bitrate.
    saveSettings({
      endpoint: field("endpoint").value,
      region: field("region").value,
      bucket: field("bucket").value,
      accessKeyId: field("accessKeyId").value,
      secretAccessKey: field("secretAccessKey").value,
      publicBaseUrl: field("publicBaseUrl").value,
      videoBitsPerSecond: Number(field("videoBitsPerSecond").value),
    });
  } catch (err) {
    showSettingsStatus(describe(err), true);
    return;
  }

  const saved = loadSettings();
  if (saved) fillSettingsForm(saved);

  const warning = saved ? publicBaseUrlWarning(saved) : null;
  if (warning) {
    showSettingsStatus(`Saved. ${warning}`, true);
    return;
  }

  showSettingsStatus("Saved.", false);
  settingsPanel.open = false;
  window.setTimeout(() => {
    settingsStatus.textContent = "";
  }, 2000);
});

// --- Library -----------------------------------------------------------------

function libraryRow(entry: LibraryEntry): HTMLLIElement {
  const item = document.createElement("li");
  item.className = "library-item";

  const details = document.createElement("div");
  details.className = "library-details";

  const title = document.createElement("a");
  title.className = "library-title";
  title.href = entry.link;
  title.target = "_blank";
  title.rel = "noopener";
  title.textContent = entry.title || "Untitled recording";

  const sub = document.createElement("div");
  sub.className = "library-sub muted";
  sub.textContent = `${new Date(entry.createdAt).toLocaleString()} · ${formatDuration(entry.durationMs)}`;

  details.append(title, sub);

  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "ghost";
  copy.textContent = "Copy link";
  copy.addEventListener("click", () => void copyLink(entry.link, copy));

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "ghost";
  remove.textContent = "Remove";
  remove.title = "Removes this entry from the local list only. The video stays in the bucket.";
  remove.addEventListener("click", () => {
    removeFromLibrary(entry.id);
    renderLibrary();
  });

  item.append(details, copy, remove);
  return item;
}

function renderLibrary(): void {
  const entries = loadLibrary();
  libraryEmpty.classList.toggle("hidden", entries.length > 0);
  libraryList.replaceChildren(...entries.map(libraryRow));
}

// --- Capture -----------------------------------------------------------------

function pickMimeType(): string | null {
  return MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type)) ?? null;
}

function stopStream(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

/** Stops every track we acquired, so the OS recording indicators go away. */
function releaseCapture(): void {
  if (!capture) return;
  stopStream(capture.display);
  stopStream(capture.mic);
  stopStream(capture.recorded);
  capture.audio?.close().catch(() => undefined);
  capture = null;
}

async function startCapture(useMic: boolean): Promise<Capture> {
  // getDisplayMedia must run within the click's transient user activation, so it
  // goes first: awaiting a microphone permission prompt before it can expire it.
  const display = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: 30 } },
    audio: true,
  });

  let mic: MediaStream | null = null;
  if (useMic) {
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      showNote("Microphone unavailable — recording without it.");
    }
  }

  const video = display.getVideoTracks()[0];
  if (!video) {
    stopStream(display);
    stopStream(mic);
    throw new Error("The screen picker returned no video track.");
  }

  const recorded = new MediaStream([video]);
  const sources = [...display.getAudioTracks(), ...(mic?.getAudioTracks() ?? [])];

  let audio: AudioContext | null = null;
  if (sources.length > 0) {
    // Everything is mixed to one track, so mic-only, display-only and both take
    // the same downstream path (SPEC §6).
    audio = new AudioContext();
    // Created outside the click's task, the context can start suspended — which
    // would record silence rather than fail.
    if (audio.state === "suspended") void audio.resume();
    const destination = audio.createMediaStreamDestination();
    for (const track of sources) {
      audio.createMediaStreamSource(new MediaStream([track])).connect(destination);
    }
    const mixed = destination.stream.getAudioTracks()[0];
    if (mixed) recorded.addTrack(mixed);
  }

  return { display, mic, audio, recorded };
}

// --- Streaming assembler -----------------------------------------------------

/**
 * MediaRecorder hands us a Blob per second; the upload wants CHUNK_SIZE-sized
 * plaintext chunks. Slicing Blobs (rather than concatenating ArrayBuffers) keeps
 * the recording on the browser's blob storage, where it can spill to disk.
 */
function queuePump(): void {
  pump = pump.then(sendFullChunks).catch(reportPumpError);
}

async function sendFullChunks(): Promise<void> {
  const active = session;
  if (!active) return;

  while (assemblyBytes >= CHUNK_SIZE) {
    // Synchronous down to the await: `dataavailable` cannot interleave and lose
    // a slice between reading `assembly` and replacing it.
    const buffered = new Blob(assembly);
    const chunk = buffered.slice(0, CHUNK_SIZE);
    const rest = buffered.slice(CHUNK_SIZE);
    assembly = rest.size > 0 ? [rest] : [];
    assemblyBytes = rest.size;

    await active.addChunk(new Uint8Array(await chunk.arrayBuffer()));
    if (session !== active) return; // discarded while this chunk was in flight
  }
}

function reportPumpError(err: unknown): void {
  // addChunk resolves through upload failures (finish() re-sends those), so
  // anything landing here is structural and worth showing right away.
  showError(`Could not queue part of the recording for upload. ${describe(err)}`);
}

/** Shown live during recording (SPEC §6) and as the bar while finishing. */
function showUploaded(uploadedBytes: number): void {
  if (stage === "finishing") {
    setProgress("Uploading", expectedBytes > 0 ? uploadedBytes / expectedBytes : 1);
    return;
  }
  if (draining) {
    // The clock has stopped; without this the screen would look identical to
    // still-recording while a slow backlog works through its retries.
    uploadedLabel.textContent = `Saving your recording — ${formatBytes(uploadedBytes)} uploaded…`;
    return;
  }
  uploadedLabel.textContent =
    uploadedBytes > 0 ? `${formatBytes(uploadedBytes)} uploaded` : "Uploading as you record…";
}

// --- Recording ---------------------------------------------------------------

async function startRecording(): Promise<void> {
  if (stage !== "idle") return;
  clearMessage();

  // The multipart upload starts with the recording, so settings must exist first.
  const settings = loadSettings();
  if (!settings) {
    demandSettings("Add your storage settings before recording — the upload starts as you record.");
    return;
  }

  setStage("picking");

  try {
    capture = await startCapture(micToggle.checked);
  } catch (err) {
    setStage("idle");
    const name = err instanceof DOMException ? err.name : "";
    // Dismissing the picker is an AbortError in some browsers and a
    // NotAllowedError in others — but so is an OS-level or Permissions-Policy
    // block, which is indistinguishable here and would otherwise be silent.
    if (name === "NotAllowedError") {
      showNote(
        "Screen capture was cancelled or blocked. On macOS, allow your browser under " +
          "System Settings → Privacy & Security → Screen Recording, then try again.",
      );
    } else if (name !== "AbortError") {
      showError(`Could not start capture. ${describe(err)}`);
    }
    return;
  }

  // The browser's own "Stop sharing" bar ends the video track instead of calling
  // us, and it can be pressed during the awaits below — before there is a
  // recorder to stop. The listener goes on now so the event is never missed; the
  // guard around start() below catches the case where it already fired.
  capture.display.getVideoTracks()[0]?.addEventListener("ended", () => stopRecording());

  const type = pickMimeType();
  if (!type) {
    releaseCapture();
    setStage("idle");
    showError("This browser cannot record WebM. Try Chrome, Edge, or Firefox.");
    return;
  }

  let started: MediaRecorder;
  try {
    started = new MediaRecorder(capture.recorded, {
      mimeType: type,
      videoBitsPerSecond: settings.videoBitsPerSecond || DEFAULT_VIDEO_BITS_PER_SECOND,
      audioBitsPerSecond: AUDIO_BITRATE,
    });
  } catch (err) {
    releaseCapture();
    setStage("idle");
    showError(`Could not start the recorder. ${describe(err)}`);
    return;
  }

  // CreateMultipartUpload before the first frame: bad credentials, a missing
  // bucket or a CORS gap surface now rather than after a ten-minute take.
  const id = randomId();
  let opened: UploadSession;
  try {
    opened = await createUploadSession(settings, id, await generateKey(), showUploaded);
  } catch (err) {
    releaseCapture();
    setStage("idle");
    showError(`Could not start the upload, so recording did not start. ${describe(err)}`);
    return;
  }

  session = opened;
  videoId = id;
  mimeType = type;
  recorder = started;
  recordedParts = [];
  recordedBytes = 0;
  assembly = [];
  assemblyBytes = 0;
  pump = Promise.resolve();
  finished = null;

  started.addEventListener("dataavailable", (event) => {
    if (event.data.size === 0) return;
    recordedParts.push(event.data);
    recordedBytes += event.data.size;
    assembly.push(event.data);
    assemblyBytes += event.data.size;
    queuePump(); // returns immediately; the upload happens off this handler
  });
  started.addEventListener("error", () => showError("The recorder failed mid-capture."));
  started.addEventListener("stop", () => void stopped());

  startedAt = performance.now();
  timerLabel.textContent = formatClock(0);
  stopButton.disabled = false;
  draining = false;
  showUploaded(0);
  timerId = window.setInterval(() => {
    timerLabel.textContent = formatClock(performance.now() - startedAt);
  }, 250);

  try {
    // Throws if sharing was stopped while the upload was being created: the
    // stream is inactive and there is nothing left to record.
    started.start(TIMESLICE_MS);
  } catch (err) {
    window.clearInterval(timerId);
    timerId = 0;
    releaseCapture();
    resetRecording();
    setStage("idle");
    void opened.abort();
    showError(`Could not start the recorder. ${describe(err)}`);
    return;
  }
  setStage("recording");
}

function stopRecording(): void {
  if (recorder && recorder.state !== "inactive") recorder.stop();
}

async function stopped(): Promise<void> {
  window.clearInterval(timerId);
  timerId = 0;
  const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
  releaseCapture();
  recorder = null;

  if (recordedBytes === 0) {
    const abandoned = session;
    resetRecording();
    setStage("idle");
    showError("Nothing was captured.");
    if (abandoned) void abandoned.abort();
    return;
  }

  // Draining a backlog can take a while on a bad network (every queued part
  // burns the retry ladder), so say that the stop registered before waiting.
  draining = true;
  stopButton.disabled = true;
  showUploaded(session?.uploadedBytes ?? 0);

  // Drain the assembler; whatever will not fill a chunk becomes the final part.
  queuePump();
  await pump;
  draining = false;
  const tail = assemblyBytes > 0 ? new Uint8Array(await new Blob(assembly).arrayBuffer()) : null;

  const blob = new Blob(recordedParts, { type: mimeType });
  finished = {
    blob,
    durationMs,
    totalBytes: recordedBytes,
    chunkCount: Math.ceil(recordedBytes / CHUNK_SIZE),
    tail,
  };

  setPreviewSource(blob);
  previewInfo.textContent = `${formatDuration(durationMs)} · ${formatBytes(blob.size)} · ${mimeType}`;
  titleInput.value = "";
  setStage("preview");
  titleInput.focus();
  void ensureDuration();
}

// --- Preview -----------------------------------------------------------------

function setPreviewSource(blob: Blob | null): void {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = blob ? URL.createObjectURL(blob) : null;
  if (previewUrl) {
    previewVideo.src = previewUrl;
  } else {
    previewVideo.removeAttribute("src");
    previewVideo.load();
  }
}

/** Resolves on the first of `types` the preview fires, or after ELEMENT_TIMEOUT_MS. */
function previewEvent(types: readonly string[]): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      window.clearTimeout(timer);
      for (const type of types) previewVideo.removeEventListener(type, finish);
      resolve();
    };
    const timer = window.setTimeout(finish, ELEMENT_TIMEOUT_MS);
    for (const type of types) previewVideo.addEventListener(type, finish);
  });
}

/**
 * MediaRecorder writes no duration into the WebM header and it is not patched
 * in (SPEC §6: chunk 0 may already be uploaded), so the element reports Infinity
 * and shows no seek bar. Seeking far past the end makes the browser scan for the
 * real duration; the element is paused throughout, so nothing starts playing.
 */
async function ensureDuration(): Promise<void> {
  await previewEvent(["loadedmetadata", "error"]);
  if (previewVideo.duration !== Infinity) return;

  const probed = previewEvent(["durationchange", "error"]);
  try {
    previewVideo.currentTime = 1e101;
    await probed;
    previewVideo.currentTime = 0;
  } catch {
    // The element refused the seek; the preview just keeps the duration it has.
  }
}

// --- Finish ------------------------------------------------------------------

function setProgress(phase: string, fraction: number): void {
  const percent = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  progressFill.style.width = `${percent}%`;
  progressText.textContent = `${phase} — ${percent}%`;
  progressBar.setAttribute("aria-valuenow", String(percent));
}

function setDownloadSource(blob: Blob | null): void {
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = blob ? URL.createObjectURL(blob) : null;
  if (downloadUrl) {
    downloadLink.href = downloadUrl;
    downloadLink.download = `videoshare-${videoId}.webm`;
  } else {
    downloadLink.removeAttribute("href");
  }
}

/** Drops the recording and its session. The Blobs live until here (SPEC §6). */
function resetRecording(): void {
  session = null;
  recorder = null;
  recordedParts = [];
  recordedBytes = 0;
  assembly = [];
  assemblyBytes = 0;
  pump = Promise.resolve();
  finished = null;
  videoId = "";
}

/** Guards `finishUpload` — see the comment there. */
let finishing = false;

async function finishUpload(): Promise<void> {
  const current = finished;
  const active = session;
  // finish() is not reentrant: a second click while the first is in flight would
  // race a second CompleteMultipartUpload against it (the loser answers
  // NoSuchUpload) and report failure over an already-shared link. `finished` and
  // `session` are only cleared once the first call has succeeded, so they cannot
  // stand in for this flag.
  if (!current || !active || finishing) return;

  finishing = true;
  finishButton.disabled = true;
  retryButton.disabled = true;
  try {
    await runFinish(current, active);
  } finally {
    finishing = false;
    finishButton.disabled = false;
    retryButton.disabled = false;
  }
}

async function runFinish(current: Finished, active: UploadSession): Promise<void> {
  clearMessage();
  recoveryBlock.classList.add("hidden");
  expectedBytes = current.totalBytes + current.chunkCount * CHUNK_OVERHEAD;
  setStage("finishing");
  showUploaded(active.uploadedBytes);

  const meta: VideoMeta = {
    v: 1,
    title: titleInput.value.trim(),
    mimeType,
    durationMs: current.durationMs,
    totalBytes: current.totalBytes,
    chunkSize: CHUNK_SIZE,
    chunkCount: current.chunkCount,
    createdAt: new Date().toISOString(),
  };

  let link: string;
  try {
    ({ link } = await active.finish(current.tail, meta));
  } catch (err) {
    // Nothing is lost: the Blobs are still here, and finish() can be retried
    // because it never re-adds the final chunk (SPEC §7).
    setDownloadSource(current.blob);
    recoveryBlock.classList.remove("hidden");
    showError(`Could not finish the upload. ${describe(err)}`);
    return;
  }

  addToLibrary({
    id: videoId,
    title: meta.title,
    createdAt: meta.createdAt,
    durationMs: meta.durationMs,
    link,
  });
  renderLibrary();

  linkInput.value = link;
  setPreviewSource(null);
  setDownloadSource(null);
  resetRecording();
  setStage("done");
  linkInput.select();

  if (await copyToClipboard(link)) showNote("Link copied to your clipboard.");
  else showNote("Copy the link below — the browser blocked the automatic copy.");
}

function discard(): void {
  const abandoned = session;
  setPreviewSource(null);
  setDownloadSource(null);
  recoveryBlock.classList.add("hidden");
  resetRecording();
  clearMessage();
  setStage("idle");
  if (abandoned) void abandoned.abort();
}

// --- Wiring ------------------------------------------------------------------

startButton.addEventListener("click", () => void startRecording());
stopButton.addEventListener("click", () => stopRecording());
finishButton.addEventListener("click", () => void finishUpload());
retryButton.addEventListener("click", () => void finishUpload());
discardButton.addEventListener("click", discard);
copyLinkButton.addEventListener("click", () => void copyLink(linkInput.value, copyLinkButton));
againButton.addEventListener("click", () => {
  clearMessage();
  setStage("idle");
});

window.addEventListener("beforeunload", (event) => {
  if (stage === "recording" || stage === "preview" || stage === "finishing") event.preventDefault();
});

function checkSupport(): void {
  const supported =
    typeof MediaRecorder !== "undefined" &&
    typeof navigator.mediaDevices?.getDisplayMedia === "function";
  if (supported) return;
  startButton.disabled = true;
  micToggle.disabled = true;
  showError("This browser cannot capture the screen. Try Chrome, Edge, or Firefox on a desktop.");
}

setStage("idle");
initSettings();
renderLibrary();
checkSupport();
