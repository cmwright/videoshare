/**
 * Recorder page controller (docs/SPEC.md §6, §17.2, §17.3).
 *
 * Two subjects share this module, the way they share the page:
 *
 * - the **shell** — three hash-routed views around one sidebar (§17.2), the
 *   settings view's two modes (§15.5) and the library (§17.3);
 * - the **recorder** — idle → picking → recording → preview → finishing → done,
 *   unchanged by §17 down to its element ids. The multipart upload is created at
 *   record start and fed 8 MiB chunks while the capture is still running, so
 *   Finish only has to send the tail.
 *
 * Routing never touches the recorder: a recording, its timer, its assembler and
 * its upload run on while the reader is in another view. The pull the other way
 * is §6's rule — a transition into `preview`, `finishing` or `done` shows the
 * record view, because those stages are asking the reader for something.
 *
 * Everything leaves this page encrypted; the key only ever lands in the share
 * link's fragment.
 */

import "./app.css";
import "./shell.css";
import "./record.css";

import { type Auth, type AuthState, createAuth } from "./auth";
import {
  CHUNK_OVERHEAD,
  CHUNK_SIZE,
  encryptBlock,
  generateKey,
  importKeyB64,
  thumbAad,
} from "./crypto";
import {
  type AnalyticsDeps,
  LIBRARY_CONCURRENCY,
  LIBRARY_SUMMARY_EAGER,
  loadReport,
  summarize,
  type VideoSummary,
} from "./dashboard";
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
import { type AccountChip, demand, initAccountChip, startRouter, type ViewName } from "./shell";
import {
  captureThumbnail,
  fetchThumbnail,
  LIBRARY_THUMB_CONCURRENCY,
  THUMB_FIRST_TRY_MS,
  THUMB_RETRY_MS,
  type ThumbnailOutcome,
} from "./thumbnail";
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
import {
  codecLabel,
  formatBytes,
  formatDuration,
  parseShareFragment,
  randomId,
  videoPageLink,
} from "./util";

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

/** Thumbnail placeholder variants (SPEC §17.3) — CSS-only, keyed off the id. */
const THUMB_VARIANTS = 5;

// --- DOM ---------------------------------------------------------------------

function el<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`record.ts: missing element ${selector}`);
  return node;
}

const stages = Array.from(document.querySelectorAll<HTMLElement>("[data-stage]"));

const settingsPanel = el<HTMLElement>("#settings-panel");
const settingsForm = el<HTMLFormElement>("#settings-form");
const settingsStatus = el<HTMLElement>("#settings-status");
const settingsLive = el<HTMLElement>("#settings-live");

const recordingPanel = el<HTMLElement>("#recording-panel");
const recordingQuality = el<HTMLSelectElement>("#rec-quality");
const recordingCodec = el<HTMLSelectElement>("#rec-codec");
const recordingBitrate = el<HTMLInputElement>("#rec-videoBitsPerSecond");
const recordingStatus = el<HTMLElement>("#recording-status");

const accountPanel = el<HTMLElement>("#account-panel");
const accountChipBox = el<HTMLElement>("#account-chip");
const accountHint = el<HTMLElement>("#account-hint");
const authLoading = el<HTMLElement>("#auth-loading");
const authSignedOut = el<HTMLElement>("#auth-signed-out");
const authSignedIn = el<HTMLElement>("#auth-signed-in");
const authEmail = el<HTMLElement>("#auth-email");
const authStatus = el<HTMLElement>("#auth-status");
const authWarning = el<HTMLElement>("#auth-warning");
const accountSignOut = el<HTMLButtonElement>("#account-sign-out");

const navLiveDot = el<HTMLElement>("#nav-live-dot");
const navLiveLabel = el<HTMLElement>("#nav-live-label");

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
const libraryCount = el<HTMLElement>("#library-count");
const libraryStatus = el<HTMLElement>("#library-status");
const newRecordingButton = el<HTMLButtonElement>("#new-recording");

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

/** The three views and the hash between them (SPEC §17.2). */
const router = startRouter();

/** Set once config.js names a gateway (SPEC §15.5); stays null in legacy mode. */
let gateway: { auth: Auth; signer: Signer } | null = null;
/**
 * The sidebar's chip, once the mode is known. Until then it is a stub: calling
 * `initAccountChip(null)` here would remove the chip before gateway mode had a
 * chance to claim it (SPEC §17.1).
 */
let accountChip: AccountChip = { render: () => undefined, highlight: () => undefined };
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
 * What a library row needs before it can carry a views summary (SPEC §16.6):
 * the gateway must have said `analytics: true`, and there must be a token to
 * list with. Null deps or `analytics: false` means a plain row — no summary, no
 * request, which is also exactly what legacy mode gets.
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
/**
 * The recording's key, retained for the life of the session (SPEC §11): the
 * thumbnail has to encrypt with it seconds after the recording starts, and
 * `UploadSession` deliberately grows no key accessor — widening that seam would
 * put the key somewhere new for no gain. Cleared by the same reset as the rest.
 */
let videoKey: CryptoKey | null = null;
let mimeType = "";

/** SPEC §3's thumbnail, encrypted the moment it exists and held until Finish. */
let thumbBlock: Uint8Array | null = null;
/** The pending first-try or retry timer, or 0. */
let thumbTimer = 0;
/**
 * Bumped whenever the recording this belongs to stops, is discarded or is
 * superseded. An attempt already in flight compares against it and discards its
 * own result: the ciphertext belongs to one recording, and there is no path by
 * which one recording's frame can be uploaded under another's id (SPEC §6).
 */
let thumbAttempt = 0;

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

  // Preview, finishing and done are asking the reader for something — a title, a
  // retry, a link to copy — so they must not happen behind a hidden section
  // (SPEC §6). Anything earlier leaves the reader wherever they are.
  if (next === "preview" || next === "finishing" || next === "done") router.go("record");

  // Leaving the record view must never hide a running capture (SPEC §17.2).
  const live = next === "recording";
  navLiveDot.classList.toggle("hidden", !live);
  navLiveLabel.textContent = live ? "Recording in progress" : "";
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

/**
 * The live region of whichever view the reader is actually in.
 *
 * A demand ("sign in first", "add your storage settings") has to be *heard*, and
 * a message announced in a hidden section reaches nobody. The recorder's own
 * running commentary stays on `#message`, which lives with the stages it is
 * about.
 */
function announce(text: string, isError: boolean): void {
  const region =
    router.view === "videos" ? libraryStatus : router.view === "settings" ? settingsLive : messageLine;
  region.textContent = text;
  region.classList.toggle("error", isError);
}

/**
 * Runs `then` once `view` is actually the view on screen.
 *
 * Navigation is asynchronous: assigning the hash queues a `hashchange`, and
 * until that task runs the target section still carries `hidden` — so focusing
 * into it, scrolling to it or animating a ring on it would all be no-ops. The
 * router registered its own listener when this module first ran, and event
 * listeners fire in registration order, so by the time this one is called the
 * section is visible and `router.view` has caught up.
 */
function whenRouted(view: ViewName, then: () => void): void {
  if (router.view === view) {
    then();
    return;
  }
  const once = (): void => {
    window.removeEventListener("hashchange", once);
    then();
  };
  window.addEventListener("hashchange", once);
  router.go(view);
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
  const label = button.querySelector<HTMLElement>(".button-label") ?? button;
  const original = label.textContent;
  label.textContent = text;
  window.setTimeout(() => {
    label.textContent = original;
  }, 1200);
}

async function copyLink(text: string, button: HTMLButtonElement): Promise<void> {
  if (await copyToClipboard(text)) flash(button, "Copied");
  else announce("The clipboard was blocked — open the video and copy the link from there.", true);
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** An inline glyph. No sprite sheet, no icon font, no external asset (SPEC §17). */
function icon(className: string, viewBox: string, paths: readonly string[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("viewBox", viewBox);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

function span(className: string, text?: string): HTMLSpanElement {
  const node = document.createElement("span");
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// --- Settings view -----------------------------------------------------------

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

/**
 * Routes to the settings view, points at the form and says why (SPEC §17.2).
 *
 * Three signals, not one: the message goes in the view's live region, focus
 * moves into the first field that still needs filling in, and the block takes
 * the shared attention ring — because neither a colour nor a pulse reaches a
 * screen reader.
 */
function demandSettings(text: string): void {
  whenRouted("settings", () => {
    // Written here rather than before the navigation, and straight to this
    // view's own region rather than through `announce`: until the route is
    // applied the settings section still carries `hidden`, and a live region
    // that changes while it is out of the accessibility tree announces nothing
    // — unhiding it afterwards is not a change. §17.2's rule is that the
    // highlight is never the only signal, so this one has to be heard.
    settingsLive.textContent = text;
    settingsLive.classList.add("error");
    demand(settingsPanel);
    const first = Array.from(
      settingsForm.querySelectorAll<HTMLInputElement>("input[required]"),
    ).find((input) => !input.value.trim());
    (first ?? settingsForm.querySelector<HTMLInputElement>("input"))?.focus({ preventScroll: true });
    settingsPanel.scrollIntoView({ block: "nearest" });
  });
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
  // Legacy mode: no account, nothing to sign out of, no Google script — so the
  // Account block and the sidebar's chip both go (SPEC §16.7, §17.1).
  accountPanel.remove();
  accountChip = initAccountChip(null);
  const saved = loadSettings();
  if (saved) {
    fillSettingsForm(saved);
    const warning = publicBaseUrlWarning(saved);
    if (warning) showSettingsStatus(warning, true);
    return;
  }

  try {
    field("publicBaseUrl").value = publicBaseUrl();
  } catch {
    // config.js is missing or malformed; the placeholder stands in.
  }
  showSettingsStatus("Not configured yet — recording needs a bucket to upload to.", false);
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
  // The demand that sent the reader here, if there was one, has been answered.
  settingsLive.textContent = "";
  window.setTimeout(() => {
    settingsStatus.textContent = "";
  }, 2000);
});

// --- Recording options (gateway mode, SPEC §15.5) ----------------------------

/**
 * The floor the field itself declares, read from the input so the two can never
 * drift. The legacy form carries the identical `min`, and the browser enforces
 * it there by refusing the submit; this block has no form and saves on change,
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
 * There is no Save button: the block writes on change and says so. Storage that
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

/** What the 232px chip can say for itself while it is not an identity. */
const CHIP_HINTS: Record<AuthState["status"], string> = {
  loading: "Loading sign-in…",
  "signed-out": "Sign in to record",
  "signed-in": "",
  error: "Sign-in unavailable — see Settings",
};

/**
 * The chip shows state; the Account block in Settings carries the words
 * (SPEC §17.1) — the loading line, the status line and the mismatch warning are
 * sentences, and sentences do not fit in a sidebar.
 */
function renderAuth(state: AuthState): void {
  const signedIn = state.status === "signed-in";

  accountChip.render(state);
  accountHint.textContent = CHIP_HINTS[state.status];
  accountHint.hidden = signedIn;

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
  // Signing in gives every library row its views summary, and signing out takes
  // them away again (SPEC §16.6) — the whole coupling between sign-in and the
  // library. Only on an actual change: a silent token refresh emits "signed-in"
  // again, and rebuilding the rows for it would throw away summaries already
  // fetched and start the queue over.
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
    demandSignIn(
      "Your Google sign-in expired. Sign in again to keep uploading — the recording is still " +
        "going and nothing has been lost.",
    );
  }
}

/**
 * Points at the sidebar's chip — sign-in lives in the shell chrome, visible from
 * every view, so there is no view to navigate to (SPEC §17.2).
 */
function demandSignIn(text: string): void {
  announce(text, true);
  accountChip.highlight();
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
 * Gateway mode: the storage settings block is removed outright (there are no
 * credentials for it to hold), the recording options it used to carry get a
 * block of their own, the Account block appears, Google's script is loaded, and
 * recording waits for a token.
 */
async function initGateway(base: string): Promise<void> {
  settingsPanel.remove();
  accountPanel.classList.remove("hidden");
  signInRequired = true;
  updateStartButton();

  let config: GatewayConfig;
  try {
    config = await fetchGatewayConfig(base);
  } catch (err) {
    authLoading.classList.add("hidden");
    showAuthStatus(describe(err), true);
    // There is no client id, so there will be no Google button — but an empty
    // corner of the sidebar would read as "no account here", which is legacy
    // mode's answer and not this one. The chip says what it can and points at
    // the block that carries the sentence.
    accountChipBox.hidden = false;
    accountHint.textContent = CHIP_HINTS.error;
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
  accountChip = initAccountChip(auth);
  auth.onChange(onAuthChange);
  gateway = {
    auth,
    signer: createGatewaySigner({
      gatewayUrl: base,
      getToken: () => auth.getToken(),
      refreshToken: () => auth.refresh(),
    }),
  };
  // Read per request, never captured: a row asks for a token when it is about to
  // list, not when it was drawn (SPEC §16.6).
  analyticsDeps = { gatewayUrl: base, token: () => auth.getToken() };
  renderAuth(auth.state);
  renderLibrary();
}

// --- Library (SPEC §17.3) ----------------------------------------------------

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

/**
 * The header's sub-line, and it counts only what this browser knows.
 *
 * Not "in your bucket": removing an entry leaves the object exactly where it was
 * (SPEC §9), so the local library cannot describe a bucket and does not pretend
 * to.
 */
function librarySummaryLine(entries: readonly LibraryEntry[]): string {
  const recordings = `${entries.length} ${entries.length === 1 ? "recording" : "recordings"}`;
  let bytes = 0;
  let sized = 0;
  for (const entry of entries) {
    if (entry.sizeBytes === undefined) continue;
    bytes += entry.sizeBytes;
    sized++;
  }
  if (sized === 0) return recordings;
  return `${recordings} · ${formatBytes(bytes)} uploaded from this browser`;
}

/** `{ id, keyB64 }` from an entry's stored share link, or null (SPEC §17.3). */
function entryVideo(entry: LibraryEntry): { id: string; keyB64: string } | null {
  const link = entry.link || "";
  const hash = link.indexOf("#");
  return parseShareFragment(hash === -1 ? link.trim() : link.slice(hash + 1).trim());
}

/**
 * Which of the placeholder patterns a row draws (SPEC §17.3). Pure and keyed off
 * the id, so a row looks the same on every reload. It is decoration: no image is
 * fetched, decoded or stored, and real thumbnails are a separate item.
 */
function thumbVariant(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return hash % THUMB_VARIANTS;
}

function thumbnail(entry: LibraryEntry, href: string | null): HTMLElement {
  const frame = document.createElement(href ? "a" : "span");
  frame.className = "thumb";
  frame.dataset.variant = String(thumbVariant(entry.id));
  // Decoration: a pattern, a glyph and a duration the meta line already carries
  // (SPEC §17.3). The title beside it is the row's real link; this is the same
  // target for a pointer and nothing at all for the keyboard or a screen reader.
  frame.setAttribute("aria-hidden", "true");
  if (frame instanceof HTMLAnchorElement && href) {
    frame.href = href;
    frame.tabIndex = -1;
  }

  const play = span("thumb-play");
  play.append(icon("thumb-play-glyph", "0 0 24 24", ["M8 5v14l11-7z"]));

  frame.append(span("thumb-pattern"), play, span("thumb-duration", formatDuration(entry.durationMs)));
  return frame;
}

/**
 * Where a row reads §3's `thumb.bin` from: `publicBaseUrl()` from config.js, in
 * **both** modes — a thumbnail is a public read, not a gateway one. Null when
 * config.js is missing or malformed, in which case no row fetches anything and
 * every pattern stands, exactly as it does today (SPEC §17.3).
 */
const thumbBase: string | null = (() => {
  try {
    return publicBaseUrl();
  } catch {
    return null;
  }
})();

/**
 * Decrypted thumbnails as object URLs, by video id, for the document's lifetime;
 * `null` records "this video has no thumbnail" so a re-render does not retry a
 * fact. A network or transport failure is deliberately *not* recorded here — the
 * usual cause has since gone away (SPEC §17.3, on §16.6's reasoning).
 *
 * A URL is revoked exactly when its id leaves `loadLibrary()`, i.e. on Remove,
 * and never when a re-render replaces a row's DOM node — which is what "cache
 * for the page, revoke on row removal" has to mean if both halves are to hold.
 */
const thumbUrls = new Map<string, string | null>();

/**
 * The image goes over the pattern rather than replacing it, so the pattern is
 * still there for the `<img>`'s own `error` event to fall back to without a
 * re-render. The play glyph and the duration chip follow it in the DOM and so
 * stay above it (SPEC §17.3).
 */
function applyThumbnailImage(frame: HTMLElement, url: string): void {
  if (frame.querySelector(".thumb-image")) return;

  const img = document.createElement("img");
  img.className = "thumb-image";
  // Decoration inside an aria-hidden block: the title beside it is the row's
  // real link, and this image says nothing a screen reader needs.
  img.alt = "";
  img.decoding = "async";
  img.addEventListener("error", () => img.remove());
  img.src = url;

  const pattern = frame.querySelector(".thumb-pattern");
  if (pattern) pattern.after(img);
  else frame.prepend(img);
}

/**
 * The ids the last render had rows for. It is what "still in the library" means
 * to a load that finishes *after* a Remove: the render that would have revoked
 * its URL has already run, so a URL minted for a departed id has to revoke
 * itself rather than wait for a re-render that may never come (SPEC §17.3).
 */
let liveThumbIds: ReadonlySet<string> = new Set();

/** Revokes the URLs of ids that have left the library — the Remove path (SPEC §17.3). */
function revokeRemovedThumbnails(entries: readonly LibraryEntry[]): void {
  // Keyed the way the cache is: by the id the row actually fetched with, which
  // is the stored link's own — `entry.id` for anything this app wrote, and the
  // fallback for an entry whose link no longer parses.
  const live = new Set(entries.map((entry) => entryVideo(entry)?.id ?? entry.id));
  liveThumbIds = live;
  for (const [id, url] of thumbUrls) {
    if (live.has(id)) continue;
    if (url) URL.revokeObjectURL(url);
    thumbUrls.delete(id);
  }
}

interface ThumbJob {
  generation: number;
  video: { id: string; keyB64: string };
  frame: HTMLElement;
}

/**
 * A second queue beside the summaries', deliberately not a share of theirs: a
 * summary is an authenticated gateway listing plus every session behind it, a
 * thumbnail is one public GET of ~30 KB, and one blocking the other either way
 * would be an accident. They share only the observer that decides a row is
 * visible — not a counter, not a generation, not a concurrency budget (§17.3).
 */
let thumbGeneration = 0;
const thumbPending: ThumbJob[] = [];
let thumbInFlight = 0;

function queueThumb(job: ThumbJob): void {
  if (job.generation !== thumbGeneration) return;
  thumbPending.push(job);
  pumpThumbs();
}

function pumpThumbs(): void {
  const base = thumbBase;
  if (!base) return;

  while (thumbInFlight < LIBRARY_THUMB_CONCURRENCY) {
    const job = thumbPending.shift();
    if (!job) return;
    if (job.generation !== thumbGeneration) continue;

    thumbInFlight++;
    void loadThumb(base, job).finally(() => {
      thumbInFlight--;
      pumpThumbs();
    });
  }
}

/**
 * The reads running right now, by video id. The cache above only starts
 * answering once a read has *finished*, so without this a re-render that
 * arrives mid-flight — a sign-in change, a finished recording, a Remove of some
 * other row — sees `undefined` for a row already being fetched and starts a
 * second fetch of the same object. Both would decrypt, both would mint a URL,
 * and whichever lost the race to `thumbUrls` would be unreachable and never
 * revoked. §17.3's rule is that a re-render must never refetch, redecrypt or
 * re-mint a URL, so the second job waits on the first instead.
 */
const thumbReads = new Map<string, Promise<void>>();

/**
 * One row's thumbnail. Never rejects and never says anything: on any failure the
 * pattern already in the row stands, which is a finished state rather than a gap
 * (SPEC §3, §17.3).
 */
async function loadThumb(base: string, job: ThumbJob): Promise<void> {
  const cached = thumbUrls.get(job.video.id);
  if (cached !== undefined) {
    if (cached && job.generation === thumbGeneration) applyThumbnailImage(job.frame, cached);
    return;
  }

  // One read per id at a time, shared by every job that wants it — including a
  // job of a later generation, since what it produces is cached by id and not
  // by row.
  let read = thumbReads.get(job.video.id);
  if (!read) {
    read = readThumb(base, job.video)
      .catch(() => undefined)
      .finally(() => thumbReads.delete(job.video.id));
    thumbReads.set(job.video.id, read);
  }
  await read;

  const url = thumbUrls.get(job.video.id);
  if (url && job.generation === thumbGeneration) applyThumbnailImage(job.frame, url);
}

/**
 * The fetch, the decrypt and the one object URL behind them — the half of a
 * thumbnail that belongs to the video rather than to a row, which is why it
 * writes only the by-id cache and touches no DOM.
 */
async function readThumb(base: string, video: { id: string; keyB64: string }): Promise<void> {
  let key: CryptoKey;
  try {
    key = await importKeyB64(video.keyB64);
  } catch {
    // A stored link whose key is not a key is a fact about the entry.
    thumbUrls.set(video.id, null);
    return;
  }

  const outcome: ThumbnailOutcome = { reachable: true };
  const blob = await fetchThumbnail(base, video.id, key, outcome);

  // Removed while this was in flight: the render that revokes departed ids has
  // already been and gone, so a URL minted now would sit unreachable until some
  // later re-render — which may never come. Mint nothing and remember nothing;
  // the id has no row to fill (SPEC §17.3).
  if (!liveThumbIds.has(video.id)) return;

  if (!blob) {
    // A 404, a 403 or a block that will not decrypt is a fact about the video
    // and is remembered; an unreachable bucket is a fact about the moment.
    if (outcome.reachable) thumbUrls.set(video.id, null);
    return;
  }

  // Minted once and cached by id even if every job that asked for it is stale: a
  // later render of the same row must never refetch, redecrypt or re-mint a URL.
  thumbUrls.set(video.id, URL.createObjectURL(blob));
}

function copyButton(entry: LibraryEntry): HTMLButtonElement {
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "row-copy";
  copy.append(
    icon("icon-link", "0 0 20 20", [
      "M8.5 11.5 L11.5 8.5",
      "M9 6.8 L11 4.8 a2.55 2.55 0 0 1 3.6 3.6 L12.6 10.4",
      "M11 13.2 L9 15.2 a2.55 2.55 0 0 1 -3.6 -3.6 L7.4 9.6",
    ]),
    span("button-label", "Copy link"),
  );
  // Always the share link — this is the button whose output goes to other
  // people, and it must never hand out a video.html URL (SPEC §17.3).
  copy.addEventListener("click", () => void copyLink(entry.link, copy));
  return copy;
}

/** The one menu open right now, if any: a second one opening closes it. */
let closeOpenMenu: (() => void) | null = null;

/**
 * The row's `⋯` menu. One item, Remove, with §9's warning kept visible rather
 * than hidden in a tooltip — the entry goes, the video stays in the bucket.
 */
function overflowMenu(entry: LibraryEntry): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "row-menu";

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "row-menu-trigger";
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-label", "More actions");
  trigger.textContent = "⋯";

  const menu = document.createElement("div");
  menu.className = "row-menu-popup";
  menu.setAttribute("role", "menu");
  menu.hidden = true;

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "row-menu-item";
  remove.setAttribute("role", "menuitem");
  remove.textContent = "Remove";

  const note = document.createElement("p");
  note.className = "row-menu-note";
  note.textContent = "Removes this entry from this browser only. The video stays in the bucket.";

  menu.append(remove, note);
  wrap.append(trigger, menu);

  function close(returnFocus: boolean): void {
    if (menu.hidden) return;
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("keydown", onKey, true);
    if (closeOpenMenu === closeThis) closeOpenMenu = null;
    if (returnFocus) trigger.focus();
  }

  function closeThis(): void {
    close(false);
  }

  function onOutside(event: Event): void {
    if (!(event.target instanceof Node) || !wrap.contains(event.target)) close(false);
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    close(true);
  }

  function open(): void {
    closeOpenMenu?.();
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("keydown", onKey, true);
    closeOpenMenu = closeThis;
    remove.focus();
  }

  trigger.addEventListener("click", () => {
    if (menu.hidden) open();
    else close(true);
  });

  remove.addEventListener("click", () => {
    close(false);
    removeFromLibrary(entry.id);
    renderLibrary();
  });

  return wrap;
}

/** The two numbers, once they arrive (SPEC §17.3). */
function renderSummary(slot: HTMLElement, summary: VideoSummary): void {
  if (summary.views === 0) {
    slot.replaceChildren(span("summary-empty", "No views yet."));
    return;
  }
  slot.replaceChildren(
    span("summary-value", String(summary.views)),
    span(
      "summary-label",
      `${summary.views === 1 ? "view" : "views"} · ${summary.viewers} ` +
        `${summary.viewers === 1 ? "viewer" : "viewers"}`,
    ),
  );
}

interface SummaryJob {
  generation: number;
  video: { id: string; keyB64: string };
  slot: HTMLElement;
}

/**
 * Summaries are queued, not fired (SPEC §17.3): a library of forty videos would
 * otherwise cost forty listings and every session fetch behind them the moment
 * the page opened. A row loads when it is visible, at most
 * `LIBRARY_CONCURRENCY` at a time, and the queue is abandoned the moment the
 * library re-renders.
 */
let summaryGeneration = 0;
const summaryPending: SummaryJob[] = [];
let summaryInFlight = 0;

/**
 * The one observer that decides a row is visible. It carries **both** queues'
 * work — one observer, one `rootMargin`, one per-row record — so a row is never
 * observed twice and one queue's arrival never drops the other's (SPEC §17.3).
 */
let rowObserver: IntersectionObserver | null = null;

function queueSummary(job: SummaryJob): void {
  if (job.generation !== summaryGeneration) return;
  summaryPending.push(job);
  pumpSummaries();
}

function pumpSummaries(): void {
  const deps = analyticsDeps;
  if (!deps) return;

  while (summaryInFlight < LIBRARY_CONCURRENCY) {
    const job = summaryPending.shift();
    if (!job) return;
    if (job.generation !== summaryGeneration) continue;

    summaryInFlight++;
    void loadReport(job.video, deps)
      .then((report) => {
        if (job.generation === summaryGeneration) renderSummary(job.slot, summarize(report));
      })
      .catch(() => {
        // A failed summary renders as nothing at all: a row is a list item, and
        // an error sentence per row is noise for something nobody asked for
        // (SPEC §16.6).
      })
      .finally(() => {
        summaryInFlight--;
        pumpSummaries();
      });
  }
}

/** What one row still has to fetch, if anything. Both halves, one observation. */
interface RowJobs {
  summary?: SummaryJob;
  thumb?: ThumbJob;
}

function startRow(jobs: RowJobs): void {
  if (jobs.summary) queueSummary(jobs.summary);
  if (jobs.thumb) queueThumb(jobs.thumb);
}

/**
 * Defers a row's work until the row is visible, on the discipline §17.3 sets for
 * the summaries and applies to the thumbnails for the same reason: a library of
 * forty videos must not fire forty of anything the moment the page opens. With
 * no `IntersectionObserver` at all, the first screenful loads and the rest wait
 * for the reader to reach for them.
 */
function deferRow(item: HTMLLIElement, jobs: RowJobs, index: number): void {
  if (!jobs.summary && !jobs.thumb) return;

  if (rowObserver) {
    pendingJobs.set(item, jobs);
    rowObserver.observe(item);
    return;
  }
  if (index < LIBRARY_SUMMARY_EAGER) {
    startRow(jobs);
    return;
  }
  const once = (): void => {
    item.removeEventListener("pointerenter", once);
    item.removeEventListener("focusin", once);
    startRow(jobs);
  };
  item.addEventListener("pointerenter", once);
  item.addEventListener("focusin", once);
}

function libraryRow(
  entry: LibraryEntry,
  index: number,
  summaries: boolean,
  thumbs: boolean,
): HTMLLIElement {
  const item = document.createElement("li");
  item.className = "library-item";

  // Built from the stored share link's own fragment, and written nowhere but
  // this href — never appended to the stored link, never stored a second time
  // (SPEC §17.3). An entry whose link has no fragment still renders; it just has
  // nothing to link to.
  const video = entryVideo(entry);
  const href = video ? videoPageLink(video.id, video.keyB64) : null;

  const details = document.createElement("div");
  details.className = "library-details";

  const title = document.createElement(href ? "a" : "span");
  title.className = "library-title";
  if (title instanceof HTMLAnchorElement && href) title.href = href;
  title.textContent = entry.title || "Untitled recording";

  details.append(title, span("library-sub muted", librarySubtitle(entry)));

  const actions = document.createElement("div");
  actions.className = "library-actions";
  actions.append(copyButton(entry), overflowMenu(entry));

  const frame = thumbnail(entry, href);
  item.append(frame, details);

  const jobs: RowJobs = {};

  // §3's thumbnail. A URL this document has already minted is applied now and
  // costs nothing: a re-render must never refetch, redecrypt or re-mint one, and
  // a remembered miss (null) is not retried either (SPEC §17.3).
  if (video && thumbBase) {
    const known = thumbUrls.get(video.id);
    if (typeof known === "string") applyThumbnailImage(frame, known);
    else if (known === undefined && thumbs) {
      jobs.thumb = { generation: thumbGeneration, video, frame };
    }
  }

  // The space a summary will occupy, and nothing else until it arrives: a list
  // of spinners reads worse than a list that fills in (SPEC §17.3).
  if (summaries && video) {
    const slot = document.createElement("div");
    slot.className = "library-summary";
    item.append(slot);
    jobs.summary = { generation: summaryGeneration, video, slot };
  }

  deferRow(item, jobs, index);

  item.append(actions);
  return item;
}

/** Rows waiting for the observer to say they are visible. */
const pendingJobs = new WeakMap<Element, RowJobs>();

/** Analytics are on, the gateway said so, and there is a token to list with. */
function summariesAvailable(): boolean {
  return analyticsEnabled && analyticsDeps !== null && !signInRequired;
}

/**
 * True once the videos view has actually been shown. A load that lands on
 * `#/record` summarizes nothing until the reader goes looking for the library
 * (SPEC §17.3).
 */
let videosSeen = router.view === "videos";

/** Anything a row would defer — summaries, thumbnails, or both (SPEC §17.3). */
function librarySources(): { summaries: boolean; thumbs: boolean } {
  return {
    summaries: summariesAvailable() && videosSeen,
    // No sign-in, no gateway, no `analytics: true`: a thumbnail is a §3 public
    // read, so it loads in legacy mode too.
    thumbs: thumbBase !== null && videosSeen,
  };
}

function renderLibrary(): void {
  closeOpenMenu?.();
  // Abandons every queued and in-flight job of either kind: their results belong
  // to rows that are about to stop existing. Two counters, because the two
  // queues have different lifetimes and only one of them depends on being
  // signed in (SPEC §17.3).
  summaryGeneration++;
  summaryPending.length = 0;
  thumbGeneration++;
  thumbPending.length = 0;
  rowObserver?.disconnect();
  rowObserver = null;

  const entries = loadLibrary();
  // The only place a thumbnail URL is revoked: an id that has left the library
  // (SPEC §17.3). A re-render on its own revokes nothing.
  revokeRemovedThumbnails(entries);
  libraryEmpty.classList.toggle("hidden", entries.length > 0);
  libraryCount.textContent = entries.length > 0 ? librarySummaryLine(entries) : "";

  const { summaries, thumbs } = librarySources();
  // Created whenever *either* queue has work — testing only for summaries would
  // silently cost legacy mode its lazy loading (SPEC §17.3).
  if ((summaries || thumbs) && typeof IntersectionObserver === "function") {
    rowObserver = new IntersectionObserver(
      (records, observer) => {
        for (const record of records) {
          if (!record.isIntersecting) continue;
          observer.unobserve(record.target);
          const jobs = pendingJobs.get(record.target);
          if (jobs) startRow(jobs);
        }
      },
      // A little ahead of the fold, so a row is usually filled in by the time it
      // is read rather than after.
      { rootMargin: "200px" },
    );
  }

  libraryList.replaceChildren(
    ...entries.map((entry, index) => libraryRow(entry, index, summaries, thumbs)),
  );
}

router.onChange((view) => {
  if (view !== "videos" || videosSeen) return;
  videosSeen = true;
  // The first time the library is actually looked at is when its deferred work
  // starts — on the broader test, so a legacy-mode library still gets its
  // thumbnails (SPEC §17.3).
  const { summaries, thumbs } = librarySources();
  if (summaries || thumbs) renderLibrary();
});

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

// --- Thumbnail capture (SPEC §6) ---------------------------------------------

/**
 * Arms §6's schedule: one attempt at `THUMB_FIRST_TRY_MS` from engine start
 * and, only if that one yields nothing, one more at `THUMB_RETRY_MS`. Two
 * attempts, never a loop — a screen still black at 2.5 s is a screen, not a
 * race — and both timers off the recording's hot path.
 *
 * Every failure is silent (SPEC §6): no stage change, no `#message`, no status
 * line, nothing the user is asked to do about it. A recording without a
 * thumbnail is a working recording, and the reader's own fallback (SPEC §3) is
 * already the whole story.
 */
function scheduleThumbnail(stream: MediaStream): void {
  const attempt = ++thumbAttempt;
  const armedAt = performance.now();
  thumbTimer = window.setTimeout(() => {
    thumbTimer = 0;
    void tryThumbnail(stream, attempt, armedAt, true);
  }, THUMB_FIRST_TRY_MS);
}

async function tryThumbnail(
  stream: MediaStream,
  attempt: number,
  armedAt: number,
  mayRetry: boolean,
): Promise<void> {
  const jpeg = await captureThumbnail(stream);
  // Stopped, discarded, or superseded by the next recording while this was in
  // flight: the frame belongs to a recording that is no longer the one here.
  if (attempt !== thumbAttempt) return;

  if (!jpeg) {
    if (!mayRetry) return;
    // Timed from engine start rather than from here: waiting for a frame has
    // already spent some of the interval §6 measures.
    thumbTimer = window.setTimeout(
      () => {
        thumbTimer = 0;
        void tryThumbnail(stream, attempt, armedAt, false);
      },
      Math.max(0, armedAt + THUMB_RETRY_MS - performance.now()),
    );
    return;
  }

  // The id and the key of the recording this attempt belongs to, read together
  // and only after the guard above: this is the reason `videoKey` is retained
  // at all (SPEC §11).
  const key = videoKey;
  const id = videoId;
  if (!key || !id) return;

  try {
    // Encrypted the moment the JPEG exists: a still frame of the user's screen
    // spends milliseconds in memory as plaintext rather than the length of the
    // recording. The ciphertext (~15–50 KB) waits here for Finish.
    const block = await encryptBlock(key, thumbAad(id), jpeg);
    if (attempt !== thumbAttempt) return;
    thumbBlock = block;
  } catch (err) {
    console.warn("[videoshare] could not encrypt the thumbnail; the recording is unaffected", err);
  }
}

/**
 * Ends the schedule without dropping a thumbnail already captured — that block
 * is what Finish uploads. Any attempt still in flight discards its own result.
 */
function cancelThumbnail(): void {
  thumbAttempt++;
  if (thumbTimer) window.clearTimeout(thumbTimer);
  thumbTimer = 0;
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

/** What a requested codec is called on screen. `codecLabel` names what was
 * actually written; this names what was asked for, which is a `CodecChoice`
 * rather than a mime type. */
const CHOICE_LABELS: Record<Exclude<CodecChoice, "auto">, string> = {
  h264: "H.264",
  vp9: "VP9",
  av1: "AV1",
};

/**
 * A codec the user picked outright is still only a request: one this browser
 * cannot encode falls down the same chain `"auto"` uses (SPEC §6). That is a
 * working recording, not an error — but it is not what was asked for, so it is
 * said out loud rather than discovered later in the file's mime type.
 */
function noteCodecFallback(actualMimeType: string, requested: CodecChoice): void {
  if (requested === "auto") return;
  const wanted = CHOICE_LABELS[requested];
  // The engine's own mime type is the one field guaranteed to describe what was
  // really written, whichever engine and container produced it.
  const actual = codecLabel(actualMimeType);
  if (actual === wanted) return;
  showNote(
    `This browser can't encode ${wanted} — the recording uses ` +
      // A bare `video/webm` names no codec at all: the last MediaRecorder
      // candidate, where the browser picked for itself and did not say what.
      // Saying so is still the note SPEC §6 asks for; pretending the request
      // was honoured is not.
      (actual === null ? "the browser's own WebM codec instead." : `${actual} instead.`),
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
      demandSignIn("The upload gateway is not ready yet — see Settings → Account.");
      return null;
    }
    if (!gateway.auth.getToken()) {
      demandSignIn("Sign in with Google before recording — the upload starts as you record.");
      return null;
    }
    // The recording options block, not the (removed) settings form, holds the
    // encoder choices here — from memory, so an unstorable change still counts
    // (SPEC §15.5).
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
  // Kept rather than generated inline: §6's thumbnail encrypts with it a second
  // from now, and it exists from the session's first moment (SPEC §11).
  let key: CryptoKey;
  try {
    key = await generateKey();
    opened = await createUploadSession(plan.signer, id, key, showUploaded);
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
  videoKey = key;
  thumbBlock = null;
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
  // Armed from engine start (SPEC §6), and from the recording's own stream: one
  // code path that works on the MediaRecorder fallback too.
  scheduleThumbnail(acquired.recorded);
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
  // A recording stopped before the first timer fires simply has no thumbnail,
  // and an attempt still in flight discards its own result (SPEC §6). Whatever
  // was already captured and encrypted stays — that is what Finish uploads.
  cancelThumbnail();
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
  // The record view may still be arriving (§17.2's rule pulled the reader back
  // here); focus lands once it has.
  whenRouted("record", () => titleInput.focus());
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
  // The same reset drops §6's thumbnail state: both timers, the ciphertext and
  // the key it was sealed with.
  cancelThumbnail();
  thumbBlock = null;
  videoKey = null;
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
    // The thumbnail goes with it — already encrypted, uploaded after the video
    // exists and before meta, and unable to fail this call (SPEC §7).
    ({ link } = await active.finish(current.tail, meta, thumbBlock));
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
  whenRouted("record", () => linkInput.select());

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
accountSignOut.addEventListener("click", () => gateway?.auth.signOut());
finishButton.addEventListener("click", () => void finishUpload());
retryButton.addEventListener("click", () => void finishUpload());
discardButton.addEventListener("click", discard);
copyLinkButton.addEventListener("click", () => void copyLink(linkInput.value, copyLinkButton));
againButton.addEventListener("click", () => {
  clearMessage();
  setStage("idle");
});
// Starting a recording from anywhere is a navigation, and nothing more: capture
// begins at the record view's own button, which is where `getDisplayMedia` gets
// the direct user activation it needs (SPEC §17.2).
newRecordingButton.addEventListener("click", () => router.go("record"));

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
// the storage settings block is not just hidden but removed (SPEC §15.5), and
// legacy mode has no account chip at all (SPEC §17.1).
if (gatewayBase) void initGateway(gatewayBase);
else initSettings();
renderLibrary();
checkSupport();
