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

import { type Auth, type AuthState, createAuth } from "./auth";
import { CHUNK_OVERHEAD, CHUNK_SIZE, generateKey } from "./crypto";
import { type AnalyticsDeps, analyticsExpander, analyticsHint } from "./dashboard";
import {
  createEngine,
  type RecorderEngine,
  selectEngineKind,
  selectFallbackMimeType,
} from "./encoder";
import {
  addToLibrary,
  CODECS,
  DEFAULT_CODEC,
  DEFAULT_QUALITY,
  DEFAULT_VIDEO_BITS_PER_SECOND,
  fetchGatewayConfig,
  gatewayUrl,
  loadLibrary,
  loadRecordingPrefs,
  loadSettings,
  publicBaseUrl,
  QUALITIES,
  removeFromLibrary,
  saveRecordingPrefs,
  saveSettings,
} from "./settings";
import type {
  CodecChoice,
  GatewayConfig,
  LibraryEntry,
  Quality,
  RecordingPrefs,
  Settings,
  VideoMeta,
} from "./types";
import {
  createGatewaySigner,
  createLocalSigner,
  createUploadSession,
  type Signer,
  type UploadSession,
} from "./upload";
import { formatBytes, formatDuration, randomId } from "./util";

/** Capture target (SPEC §6): `ideal` pulls Chrome up to native PHYSICAL pixels
 * (its default for screen capture is the logical/CSS size — half density on
 * Retina, which renders text soft no matter the encoder quality); `max` caps a
 * 5K+ display at 4K. Chrome never upscales past the surface's native size. */
const MAX_WIDTH = 3840;
const MAX_HEIGHT = 2160;
const MAX_FRAME_RATE = 30;
/** Captures above QHD drop to this frame rate (SPEC §6): native-resolution text
 * detail beats 30fps for screencasts, and the encoder cannot deliver both. */
const HIGH_RES_FRAME_RATE = 20;
const HIGH_RES_PIXELS = 2560 * 1440;

/** Cap on waiting for the preview element during the duration probe. */
const ELEMENT_TIMEOUT_MS = 5000;

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

const recordingPanel = el<HTMLElement>("#recording-panel");
const recordingQuality = el<HTMLSelectElement>("#rec-quality");
const recordingCodec = el<HTMLSelectElement>("#rec-codec");
const recordingBitrate = el<HTMLInputElement>("#rec-videoBitsPerSecond");
const recordingStatus = el<HTMLElement>("#recording-status");

const authPanel = el<HTMLElement>("#auth-panel");
const authLoading = el<HTMLElement>("#auth-loading");
const authSignedOut = el<HTMLElement>("#auth-signed-out");
const authSignedIn = el<HTMLElement>("#auth-signed-in");
const authButton = el<HTMLElement>("#auth-button");
const authEmail = el<HTMLElement>("#auth-email");
const authStatus = el<HTMLElement>("#auth-status");
const authWarning = el<HTMLElement>("#auth-warning");
const signOutButton = el<HTMLButtonElement>("#sign-out");

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

/** Set once config.js names a gateway (SPEC §15.5); stays null in legacy mode. */
let gateway: { auth: Auth; signer: Signer } | null = null;
/**
 * Gateway mode's encoder choices (SPEC §15.5), and this session's source of
 * truth for them: a browser that refuses to store a choice still has to record
 * with it. Legacy mode ignores this and reads the settings form instead — and
 * must not so much as read `videoshare.recording` (SPEC §9), so these start as
 * the plain defaults and only `initRecordingPanel()` loads the stored ones.
 */
let recordingPrefs: RecordingPrefs = {
  quality: DEFAULT_QUALITY,
  codec: DEFAULT_CODEC,
  videoBitsPerSecond: DEFAULT_VIDEO_BITS_PER_SECOND,
};
/** This browser can capture and encode at all — decided once by checkSupport(). */
let captureSupported = true;
/** Gateway mode with no usable ID token: recording must not start. */
let signInRequired = false;
/**
 * What the library rows need to offer analytics (SPEC §16.6): the gateway must
 * have said `analytics: true`, and there must be a token to list with. Null deps
 * or `analytics: false` means a plain row — no expander, no hint, no request,
 * which is also exactly what legacy mode gets.
 */
let analyticsDeps: AnalyticsDeps | null = null;
let analyticsEnabled = false;
/** A mid-session expiry has been announced, so signing back in can say so once. */
let reauthAnnounced = false;

let capture: Capture | null = null;
let engine: RecorderEngine | null = null;
/** Set by whichever stop path arrives first, so the other one is a no-op. */
let stopping = false;
/** The engine reported a mid-recording failure and its message is already on screen. */
let engineFailure: Error | null = null;
/** Whether this recording has already been checked against the requested codec. */
let codecNoted = false;

let session: UploadSession | null = null;
let videoId = "";
let mimeType = "";

/** Every emitted container slice as a Blob, retained until the share link exists (SPEC §6). */
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

function control<T extends Element>(name: string, type: new () => T): T {
  const node = settingsForm.elements.namedItem(name);
  if (!(node instanceof type)) throw new Error(`record.ts: missing settings field ${name}`);
  return node;
}

function field(name: string): HTMLInputElement {
  return control(name, HTMLInputElement);
}

function select(name: string): HTMLSelectElement {
  return control(name, HTMLSelectElement);
}

/** The <select> can only offer valid values, but a cached page could disagree with this build. */
function readQuality(value: string): Quality {
  return QUALITIES.find((allowed) => allowed === value) ?? DEFAULT_QUALITY;
}

function readCodec(value: string): CodecChoice {
  return CODECS.find((allowed) => allowed === value) ?? DEFAULT_CODEC;
}

function fillSettingsForm(saved: Settings): void {
  field("endpoint").value = saved.endpoint;
  field("region").value = saved.region;
  field("bucket").value = saved.bucket;
  field("accessKeyId").value = saved.accessKeyId;
  field("secretAccessKey").value = saved.secretAccessKey;
  field("publicBaseUrl").value = saved.publicBaseUrl;
  select("quality").value = saved.quality;
  select("codec").value = saved.codec;
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
      quality: readQuality(select("quality").value),
      codec: readCodec(select("codec").value),
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

// --- Recording options (gateway mode, SPEC §15.5) ----------------------------

/**
 * The floor the field itself declares, read from the input so the two can never
 * drift. The legacy form carries the identical `min`, and the browser enforces
 * it there by refusing the submit; this panel has no form and saves on change,
 * so no constraint validation ever runs and the same rule has to be applied
 * here — otherwise a typed `500` reaches MediaRecorder as 500 bits/s and
 * uploads an unwatchable file.
 */
const MIN_FALLBACK_BITRATE = Number(recordingBitrate.min) || 1;

/** Raises a below-minimum bitrate rather than refusing it: there is no Save
 * button to refuse at, and the caller writes the taken value back into the
 * field, so the correction is visible where the browser's own message would be. */
function clampBitrate(bits: number): number {
  return Math.max(MIN_FALLBACK_BITRATE, Math.round(bits));
}

/** Blank, or anything else the number input will hand back, still has to encode. */
function readBitrate(value: string): number {
  const bits = Number(value);
  return Number.isFinite(bits) && bits >= 1 ? clampBitrate(bits) : DEFAULT_VIDEO_BITS_PER_SECOND;
}

function fillRecordingPanel(prefs: RecordingPrefs): void {
  recordingQuality.value = prefs.quality;
  recordingCodec.value = prefs.codec;
  recordingBitrate.value = String(prefs.videoBitsPerSecond);
}

/** Cleared on each change so a fast second choice cannot wipe its own confirmation. */
let recordingStatusTimer = 0;

function showRecordingStatus(text: string, isError: boolean): void {
  recordingStatus.textContent = text;
  recordingStatus.classList.toggle("error", isError);
  recordingStatus.classList.toggle("muted", !isError);
}

/**
 * There is no Save button: the panel writes on change and says so. Storage that
 * refuses the write is a note, never a failure — `recordingPrefs` is what the
 * next recording encodes with either way (SPEC §15.5).
 */
function onRecordingChange(): void {
  recordingPrefs = {
    quality: readQuality(recordingQuality.value),
    codec: readCodec(recordingCodec.value),
    videoBitsPerSecond: readBitrate(recordingBitrate.value),
  };
  // Shows what was actually taken, e.g. the default reappearing in a bitrate
  // field left empty.
  fillRecordingPanel(recordingPrefs);

  window.clearTimeout(recordingStatusTimer);
  if (!saveRecordingPrefs(recordingPrefs)) {
    showRecordingStatus(
      "This browser is blocking localStorage, so this choice only lasts until you reload. " +
        "Recording is unaffected.",
      true,
    );
    return;
  }
  showRecordingStatus("Saved.", false);
  recordingStatusTimer = window.setTimeout(() => {
    showRecordingStatus("", false);
  }, 2000);
}

function initRecordingPanel(): void {
  // The one and only read of `videoshare.recording`, so legacy mode leaves the
  // key untouched (SPEC §9). The stored bitrate goes through the field's own
  // minimum on the way in as well: a value written under it (hand-edited, or by
  // a build without the clamp above) would otherwise be shown and recorded with.
  const stored = loadRecordingPrefs();
  recordingPrefs = { ...stored, videoBitsPerSecond: clampBitrate(stored.videoBitsPerSecond) };
  fillRecordingPanel(recordingPrefs);
  for (const node of [recordingQuality, recordingCodec, recordingBitrate]) {
    node.addEventListener("change", onRecordingChange);
  }
  recordingPanel.classList.remove("hidden");
}

// --- Sign-in (gateway mode, SPEC §15.5) --------------------------------------

/** Where the gateway lives, or null for legacy mode. Read once: config.js cannot change. */
const gatewayBase = gatewayUrl();

function updateStartButton(): void {
  startButton.disabled = !captureSupported || signInRequired;
}

function showAuthStatus(text: string, isError: boolean): void {
  authStatus.textContent = text;
  authStatus.classList.toggle("error", isError);
  authStatus.classList.toggle("muted", !isError);
}

function renderAuth(state: AuthState): void {
  const signedIn = state.status === "signed-in";
  authLoading.classList.toggle("hidden", state.status !== "loading");
  // "error" means Google's script never became usable, so offering its button
  // would be a lie: only the message is left.
  authSignedOut.classList.toggle("hidden", state.status !== "signed-out");
  authSignedIn.classList.toggle("hidden", !signedIn);
  authEmail.textContent = state.email ?? "your Google account";
  showAuthStatus(state.message ?? "", state.status === "error");

  signInRequired = !signedIn;
  updateStartButton();
}

function onAuthChange(state: AuthState): void {
  const wasSignedOut = signInRequired;
  renderAuth(state);
  // Signing in turns each library row's "Sign in to see analytics." hint into an
  // expander, and signing out turns it back (SPEC §16.6) — the whole coupling
  // between sign-in and the library. Only on an actual change: a silent token
  // refresh emits "signed-in" again, and rebuilding the rows for it would shut
  // an expander somebody was reading.
  if (wasSignedOut !== signInRequired) renderLibrary();

  if (state.status === "signed-in") {
    if (reauthAnnounced) {
      reauthAnnounced = false;
      showNote("Signed back in — the upload picks up where it left off.");
    }
    return;
  }
  // A token that expired mid-session must never end the recording: every byte is
  // still in this tab, and the parts held up are re-sent by finish() (SPEC §15.5).
  if (stage === "recording" || stage === "preview" || stage === "finishing") {
    reauthAnnounced = true;
    showError(
      "Your Google sign-in expired. Sign in again above to keep uploading — the recording is " +
        "still going and nothing has been lost.",
    );
    authPanel.scrollIntoView({ block: "nearest" });
  }
}

/** Points at the sign-in panel — recording cannot start without a token. */
function demandSignIn(text: string): void {
  authPanel.scrollIntoView({ block: "nearest" });
  showError(text);
}

/**
 * The gateway writes to its own bucket; viewers read whichever one config.js
 * names. If those disagree, uploads succeed and every link points at nothing.
 */
function gatewayBaseUrlWarning(config: GatewayConfig): string | null {
  let deployed: string;
  try {
    deployed = publicBaseUrl();
  } catch (err) {
    return describe(err);
  }
  if (!config.publicBaseUrl || config.publicBaseUrl === deployed) return null;
  return (
    `Viewers load videos from ${deployed} (set in config.js), but the gateway uploads to ` +
    `${config.publicBaseUrl}. Make the two match, or shared links won't play.`
  );
}

/**
 * Gateway mode: the storage settings panel is removed outright (there are no
 * credentials for it to hold), the recording options it used to carry get a
 * panel of their own, Google's script is loaded, and recording waits for a token.
 */
async function initGateway(base: string): Promise<void> {
  settingsPanel.remove();
  authPanel.classList.remove("hidden");
  signInRequired = true;
  updateStartButton();

  let config: GatewayConfig;
  try {
    config = await fetchGatewayConfig(base);
  } catch (err) {
    authLoading.classList.add("hidden");
    showAuthStatus(describe(err), true);
    return;
  }

  // Before sign-in, and independent of it: which codec this machine records with
  // is the operator's choice, not something the gateway authorizes (SPEC §15.5).
  initRecordingPanel();

  analyticsEnabled = config.analytics;

  const warning = gatewayBaseUrlWarning(config);
  if (warning) {
    authWarning.textContent = warning;
    authWarning.classList.remove("hidden");
  }

  const auth = createAuth(config.googleClientId);
  auth.mount(authButton);
  auth.onChange(onAuthChange);
  gateway = {
    auth,
    signer: createGatewaySigner({
      gatewayUrl: base,
      getToken: () => auth.getToken(),
      refreshToken: () => auth.refresh(),
    }),
  };
  // Read per request, never captured: the expander asks for a token when it is
  // about to list, not when the row was drawn (SPEC §16.6).
  analyticsDeps = { gatewayUrl: base, token: () => auth.getToken() };
  renderAuth(auth.state);
  renderLibrary();
}

// --- Library -----------------------------------------------------------------

/**
 * Delivered bytes over wall-clock duration — what a viewer actually has to
 * download per second, so the effect of the quality setting is visible.
 */
function formatBitrate(bytes: number, durationMs: number): string | null {
  if (bytes <= 0 || durationMs <= 0) return null;
  const mbps = (bytes * 8) / (durationMs * 1000);
  return mbps >= 0.1 ? `${mbps.toFixed(1)} Mbps` : `${Math.round(mbps * 1000)} kbps`;
}

/** "27/08/2026, 21:04 · 1:33 · 14.2 MB · 1.9 Mbps" — the last two only when known (SPEC §9). */
function librarySubtitle(entry: LibraryEntry): string {
  const parts = [new Date(entry.createdAt).toLocaleString(), formatDuration(entry.durationMs)];
  if (entry.sizeBytes !== undefined) {
    parts.push(formatBytes(entry.sizeBytes));
    const rate = formatBitrate(entry.sizeBytes, entry.durationMs);
    if (rate) parts.push(rate);
  }
  return parts.join(" · ");
}

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
  sub.textContent = librarySubtitle(entry);

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
  const analytics = analyticsPanel(entry);
  // Its own line under the row's controls, because a heatmap is not a button.
  if (analytics) item.append(analytics);
  return item;
}

/**
 * The row's analytics affordance, or null when there is none (SPEC §16.6).
 *
 * Legacy mode and a gateway with `analytics: false` get nothing at all — no
 * expander, no hint, no request. With analytics on, a signed-out recorder gets
 * one muted line rather than a blank space: the operator turned this on and the
 * data exists, so an absence would read as "this video has none".
 */
function analyticsPanel(entry: LibraryEntry): HTMLElement | null {
  if (!analyticsEnabled || !analyticsDeps) return null;
  // `signInRequired` is exactly "there is no usable ID token right now", which
  // is what listing a video's sessions needs (SPEC §15.4).
  return signInRequired ? analyticsHint() : analyticsExpander(entry, analyticsDeps);
}

function renderLibrary(): void {
  const entries = loadLibrary();
  libraryEmpty.classList.toggle("hidden", entries.length > 0);
  libraryList.replaceChildren(...entries.map(libraryRow));
}

// --- Capture -----------------------------------------------------------------

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
    video: {
      frameRate: { ideal: MAX_FRAME_RATE, max: MAX_FRAME_RATE },
      width: { ideal: MAX_WIDTH, max: MAX_WIDTH },
      height: { ideal: MAX_HEIGHT, max: MAX_HEIGHT },
    },
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

  // Tells the encoder this is screen content: it should hold sharp edges and
  // small text rather than smooth motion (SPEC §6).
  video.contentHint = "text";

  // Above QHD the software encoder cannot hold 30fps; trading frame rate for
  // the full native text detail is the right deal for screencasts (SPEC §6).
  const { width = 0, height = 0 } = video.getSettings();
  if (width * height > HIGH_RES_PIXELS) {
    try {
      await video.applyConstraints({ frameRate: { ideal: HIGH_RES_FRAME_RATE, max: HIGH_RES_FRAME_RATE } });
    } catch {
      // A capture that rejects the tighter cap keeps the original one.
    }
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
    // Mono: speech over a screen share gains nothing from a second channel, and
    // "explicit" + "speakers" downmixes a stereo source instead of dropping the
    // right channel outright.
    const destination = new MediaStreamAudioDestinationNode(audio, {
      channelCount: 1,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
    });
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
 * The engine emits container bytes in whatever sizes the muxer produces; the
 * upload wants CHUNK_SIZE-sized plaintext chunks. Slicing Blobs (rather than
 * concatenating ArrayBuffers) keeps the recording on the browser's blob
 * storage, where it can spill to disk.
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

// --- Codec fallback note (SPEC §6) -------------------------------------------

/** The codecs a recording can come back as, including the fallback engine's VP8. */
type RecordedCodec = "h264" | "vp9" | "av1" | "vp8";

const CODEC_NAMES: Record<RecordedCodec, string> = {
  h264: "H.264",
  vp9: "VP9",
  av1: "AV1",
  vp8: "VP8",
};

/**
 * Which codec the engine's own mime type says it settled on — the one field
 * that is guaranteed to describe what was really written (SPEC §6), whichever
 * engine and container produced it. Both registrations appear: `avc1`/`avc3`
 * for H.264 in MP4, `vp09`/`av01`/`vp08` in WebM, and MediaRecorder's shorter
 * `vp9`/`vp8` spelling. `null` for a bare `video/webm`, which names nothing.
 */
function recordedCodec(mimeType: string): RecordedCodec | null {
  const type = mimeType.toLowerCase();
  if (/\b(?:avc1|avc3|h264)\b/.test(type)) return "h264";
  if (/\b(?:vp09|vp9)\b/.test(type)) return "vp9";
  if (/\b(?:av01|av1)\b/.test(type)) return "av1";
  if (/\b(?:vp08|vp8)\b/.test(type)) return "vp8";
  return null;
}

/**
 * A codec the user picked outright is still only a request: one this browser
 * cannot encode falls down the same chain `"auto"` uses (SPEC §6). That is a
 * working recording, not an error — but it is not what was asked for, so it is
 * said out loud rather than discovered later in the file's mime type.
 */
function noteCodecFallback(actualMimeType: string, requested: CodecChoice): void {
  if (requested === "auto") return;
  const actual = recordedCodec(actualMimeType);
  if (actual === requested) return;
  showNote(
    `This browser can't encode ${CODEC_NAMES[requested]} — the recording uses ` +
      // A bare `video/webm` names no codec at all: the last MediaRecorder
      // candidate, where the browser picked for itself and did not say what.
      // Saying so is still the note SPEC §6 asks for; pretending the request
      // was honoured is not.
      (actual === null ? "the browser's own WebM codec instead." : `${CODEC_NAMES[actual]} instead.`),
  );
}

/** What a recording needs from whichever mode this deployment is in. */
interface UploadPlan {
  signer: Signer;
  quality: Quality;
  codec: CodecChoice;
  videoBitsPerSecond: number;
}

/**
 * Resolves who will authorize the upload, or explains what is missing and
 * returns null. The multipart upload starts with the recording, so this has to
 * hold before a screen is even picked.
 */
function uploadPlan(): UploadPlan | null {
  if (gatewayBase) {
    if (!gateway) {
      demandSignIn("The upload gateway is not ready yet — see the sign-in panel above.");
      return null;
    }
    if (!gateway.auth.getToken()) {
      demandSignIn("Sign in with Google before recording — the upload starts as you record.");
      return null;
    }
    // The recording panel, not the (removed) settings form, holds the encoder
    // choices here — from memory, so an unstorable change still counts (SPEC §15.5).
    return {
      signer: gateway.signer,
      quality: recordingPrefs.quality,
      codec: recordingPrefs.codec,
      videoBitsPerSecond: recordingPrefs.videoBitsPerSecond,
    };
  }

  const settings = loadSettings();
  if (!settings) {
    demandSettings("Add your storage settings before recording — the upload starts as you record.");
    return null;
  }
  try {
    return {
      signer: createLocalSigner(settings),
      quality: settings.quality,
      codec: settings.codec,
      videoBitsPerSecond: settings.videoBitsPerSecond,
    };
  } catch (err) {
    demandSettings(describe(err));
    return null;
  }
}

async function startRecording(): Promise<void> {
  if (stage !== "idle") return;
  clearMessage();

  const plan = uploadPlan();
  if (!plan) return;

  setStage("picking");

  let acquired: Capture;
  try {
    acquired = await startCapture(micToggle.checked);
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

  capture = acquired;
  const videoTrack = acquired.display.getVideoTracks()[0];

  // The browser's own "Stop sharing" bar ends the video track instead of calling
  // us, and it can be pressed during the awaits below — before there is an
  // engine to stop. The listener goes on now so the event is never missed; the
  // readyState guard below catches the case where it already fired.
  videoTrack.addEventListener("ended", () => stopRecording());

  // The engine picks its own codec and container; `stopped()` reads the string
  // it actually settled on once it has stopped (SPEC §6).
  let started: RecorderEngine;
  try {
    started = createEngine({
      quality: plan.quality,
      codec: plan.codec,
      fallbackVideoBitsPerSecond: plan.videoBitsPerSecond,
    });
  } catch (err) {
    releaseCapture();
    setStage("idle");
    showError(`Could not start the recorder. ${describe(err)}`);
    return;
  }

  // CreateMultipartUpload before the first frame: bad credentials, a missing
  // bucket, a rejected sign-in or a CORS gap surface now rather than after a
  // ten-minute take.
  const id = randomId();
  let opened: UploadSession;
  try {
    opened = await createUploadSession(plan.signer, id, await generateKey(), showUploaded);
  } catch (err) {
    releaseCapture();
    setStage("idle");
    showError(`Could not start the upload, so recording did not start. ${describe(err)}`);
    return;
  }

  // Sharing was stopped while the engine and upload were being set up. A dead
  // track produces no frames rather than an error, so recording would otherwise
  // sit at 00:00 forever.
  if (videoTrack.readyState === "ended") {
    releaseCapture();
    setStage("idle");
    void opened.abort();
    showNote("Screen sharing stopped before the recording began.");
    return;
  }

  session = opened;
  videoId = id;
  // A placeholder so no string from an earlier recording can survive here; the
  // engine's real one replaces it in stopped().
  mimeType = started.mimeType;
  engine = started;
  stopping = false;
  engineFailure = null;
  codecNoted = false;
  recordedParts = [];
  recordedBytes = 0;
  assembly = [];
  assemblyBytes = 0;
  pump = Promise.resolve();
  finished = null;

  started.ondata = (bytes: Uint8Array) => {
    if (bytes.byteLength === 0) return;
    // The engine's mime type is final by the time it emits bytes (SPEC §6), so
    // this is the first moment a codec fallback can be named — early enough
    // that the user can still stop, change the setting and record again. Not
    // after a failure: that message says what happens next and must stand.
    if (!codecNoted && !engineFailure) {
      codecNoted = true;
      noteCodecFallback(started.mimeType, plan.codec);
    }
    // The Blob constructor copies the bytes synchronously, so the engine is free
    // to reuse the buffer once this returns, and Blob parts let the browser spill
    // the retained recording to disk (SPEC §6). The cast only drops the
    // SharedArrayBuffer arm of `Uint8Array`, which BlobPart excludes and no
    // encoder produces.
    const part = new Blob([bytes as BlobPart]);
    recordedParts.push(part);
    recordedBytes += part.size;
    assembly.push(part);
    assemblyBytes += part.size;
    queuePump(); // returns immediately; the upload happens off this callback
  };

  started.onerror = (err: Error) => {
    // A dead engine emits nothing and never says so again (SPEC §6), so the
    // capture has to end here rather than whenever the user next looks up: the
    // timer would otherwise keep counting over a recording nothing is being
    // added to, and the multipart upload would sit open behind it. Stopping
    // takes the normal path, so the bytes already captured reach the preview
    // and can still be finished or discarded.
    if (engine !== started || engineFailure) return;
    engineFailure = err;
    showError(
      `Recording stopped — the encoder failed. ${describe(err)} ` +
        "What was captured up to that point is intact: finish to upload it, or discard it.",
    );
    stopRecording();
  };

  startedAt = performance.now();
  timerLabel.textContent = formatClock(0);
  stopButton.disabled = false;
  draining = false;
  showUploaded(0);
  timerId = window.setInterval(() => {
    timerLabel.textContent = formatClock(performance.now() - startedAt);
  }, 250);

  try {
    started.start(acquired.recorded);
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

/** Both stop paths land here — the Stop button and the track's `ended` event. */
function stopRecording(): void {
  if (!engine || stopping) return;
  stopping = true;
  void stopped(engine);
}

async function stopped(active: RecorderEngine): Promise<void> {
  window.clearInterval(timerId);
  timerId = 0;
  const durationMs = Math.max(0, Math.round(performance.now() - startedAt));

  // Draining a backlog can take a while on a bad network (every queued part
  // burns the retry ladder), so say that the stop registered before waiting.
  draining = true;
  stopButton.disabled = true;
  showUploaded(session?.uploadedBytes ?? 0);

  // Flush before anything else: stop() resolves only after its final ondata
  // call, and those bytes still have to reach the assembler (SPEC §6). The
  // tracks stay live until it resolves so the encoder can drain them.
  //
  // A failure `onerror` already reported is on screen with what happens next;
  // stop() only hands the same one back, so it is not written over.
  let engineError: unknown = engineFailure;
  try {
    await active.stop();
  } catch (err) {
    engineError = err;
    if (!engineFailure) {
      showError(`The recording engine failed while finishing up. ${describe(err)}`);
    }
  }

  // Now, not at createEngine(): the string read before start() is only a guess.
  // The WebCodecs engine confirms its codec asynchronously, learns the real
  // frame size (and so the level digits) from the first frame, and drops
  // ",opus" if no audio ever arrived. `meta.mimeType` must be what was actually
  // written (SPEC §6), and the player feeds it straight to MSE (SPEC §8).
  mimeType = active.mimeType;
  engine = null;
  releaseCapture();

  if (recordedBytes === 0) {
    const abandoned = session;
    draining = false;
    resetRecording();
    setStage("idle");
    // Without the engine's own error this reads as "you recorded nothing",
    // which hides the actual reason the recording never started.
    showError(
      engineError ? `Nothing was captured. ${describe(engineError)}` : "Nothing was captured.",
    );
    if (abandoned) void abandoned.abort();
    return;
  }

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
 * No engine writes a duration into the container header, and none is patched in
 * afterwards (SPEC §6: chunk 0 may already be uploaded), so the element has no
 * duration to report and shows no seek bar. Seeking far past the end makes the
 * browser scan for the real one; the element is paused throughout, so nothing
 * starts playing.
 *
 * "No duration" looks different in each container, which is why the test below
 * is a positive one rather than a comparison against `Infinity`: streamed WebM
 * has no duration element at all and reports `Infinity`, while a fragmented MP4
 * does carry an `mvhd` — with its duration field left at **0**, along with every
 * `tkhd` and `mdhd`, and no `mehd` to override them. An `!== Infinity` test
 * passes on that 0 and skips the probe, leaving H.264 previews unseekable.
 */
async function ensureDuration(): Promise<void> {
  await previewEvent(["loadedmetadata", "error"]);
  if (Number.isFinite(previewVideo.duration) && previewVideo.duration > 0) return;

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
    // The container is whatever the engine settled on — fragmented MP4 for
    // H.264, WebM otherwise (SPEC §6) — and a .webm name on an MP4 is what
    // stops the OS from opening the file this link exists to hand back.
    downloadLink.download = `videoshare-${videoId}.${mimeType.startsWith("video/mp4") ? "mp4" : "webm"}`;
  } else {
    downloadLink.removeAttribute("href");
  }
}

/** Drops the recording and its session. The Blobs live until here (SPEC §6). */
function resetRecording(): void {
  session = null;
  engine = null;
  stopping = false;
  engineFailure = null;
  codecNoted = false;
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
    // Plaintext bytes, i.e. what a viewer downloads — the library turns this
    // plus the duration into an effective bitrate (SPEC §9).
    sizeBytes: meta.totalBytes,
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
signOutButton.addEventListener("click", () => gateway?.auth.signOut());
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
  // Ask the encoder module which engine this browser gets, rather than
  // re-deriving its rules here and drifting from them. The fallback engine
  // additionally needs a WebM type it can record: Safari has MediaRecorder but
  // only in containers this app cannot chunk, encrypt and play back, and the
  // user should learn that now rather than after picking a screen.
  const kind = selectEngineKind();
  // The WebCodecs engine brings its own container (MP4 for H.264, WebM
  // otherwise, SPEC §6); the fallback engine only ever records WebM, so it
  // additionally needs a WebM type MediaRecorder will accept.
  const canEncode =
    kind === "webcodecs" || (kind === "mediarecorder" && selectFallbackMimeType() !== null);
  captureSupported = canEncode && typeof navigator.mediaDevices?.getDisplayMedia === "function";
  micToggle.disabled = !captureSupported;
  updateStartButton();
  if (captureSupported) return;
  showError(
    canEncode
      ? "This browser cannot capture the screen. Try Chrome, Edge, or Firefox on a desktop."
      : "This browser cannot record video in a format this app can share. Try Chrome, Edge, " +
          "or Firefox on a desktop — you can still watch shared links here.",
  );
}

setStage("idle");
// One or the other, never both: a gateway means credentials live server-side, so
// the storage settings panel is not just hidden but removed (SPEC §15.5).
if (gatewayBase) void initGateway(gatewayBase);
else initSettings();
renderLibrary();
checkSupport();
