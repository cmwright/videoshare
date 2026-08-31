// Page controller for view.html — SPEC §8, §17.5.
// No credentials here: the video id and AES key come from the URL fragment,
// ciphertext comes from the public bucket, decryption happens in this tab.
//
// §8's machinery lives in `playback.ts`, which `video.html` drives too. What is
// left here is this page's chrome and nothing else: the fragment, the title
// block, the status line, the error card, the play overlay, and the watch
// beacon — which is `view.html`'s alone, because the owner's own visit to a
// video page is not a view (§16.5, §17.4).

import "./app.css";
import "./player.css";

import { startWatchBeacon } from "./beacon";
import { importKeyB64 } from "./crypto";
import { fetchMeta, type Playback, PlaybackError, startPlayback } from "./playback";
import { fetchGatewayConfig, gatewayUrl, publicBaseUrl } from "./settings";
import type { VideoMeta } from "./types";
import { formatDuration, parseShareFragment } from "./util";

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

/**
 * The playback in progress, once there is one. Only the media-element error
 * listener reads it, and only to ask whether a source has been committed yet —
 * before that the whole-file fallback may still rescue the recording (§8).
 */
let playback: Playback | null = null;

// --- UI -------------------------------------------------------------------

function setStatus(text: string | null): void {
  if (text === null) {
    statusRow.classList.add("hidden");
    return;
  }
  statusText.textContent = text;
  statusRow.classList.remove("hidden");
}

function showError(title: string, detail: string): void {
  if (!errorCard.classList.contains("hidden")) return; // keep the first, most specific error
  errorTitle.textContent = title;
  errorDetail.textContent = detail;
  errorCard.classList.remove("hidden");
  playOverlay.classList.add("hidden");
  setStatus(null);
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

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --- Playback analytics (SPEC §16) ----------------------------------------

/**
 * Starts reporting what gets watched, if and only if this deployment asked for
 * it: config.js must name a gateway, and that gateway must answer
 * `analytics: true` (i.e. it has an analytics bucket). Legacy mode returns on
 * the first line, having made no request and written no storage key.
 *
 * The config fetch is lazy — it happens once, after a video's metadata is in
 * hand, so it never delays the first frame — and its failure is silent. A
 * gateway that is down, unreachable, or answers something else simply means no
 * analytics; the viewer came here to watch a video and hears nothing about it.
 *
 * Everything the beacon sends is encrypted with the key from the fragment
 * (§16.2), which is why this is safe to do without asking: the operator learns
 * that an id was watched and nothing about how.
 */
async function startAnalytics(id: string, key: CryptoKey, meta: VideoMeta): Promise<void> {
  const base = gatewayUrl();
  if (!base) return;

  try {
    const config = await fetchGatewayConfig(base);
    if (!config.analytics) return;
    startWatchBeacon(video, { gatewayUrl: base, videoId: id, key, durationMs: meta.durationMs });
  } catch {
    // Unreachable, or not a gateway. Nothing to report to, and nothing to say.
  }
}

// --- Entry point ----------------------------------------------------------

async function main(): Promise<void> {
  const fragment = parseShareFragment(location.hash);
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
  const meta = await fetchMeta(base, fragment.id, key);
  showMeta(meta);

  // Fire and forget, before playback so the first `play` is caught: nothing
  // below waits on it, and it can neither fail nor speak (SPEC §16.5).
  void startAnalytics(fragment.id, key, meta);

  playback = startPlayback({
    video,
    publicBaseUrl: base,
    id: fragment.id,
    key,
    meta,
    // The share page plays on arrival: a recipient followed a link to watch it.
    autoplay: true,
    onStatus: setStatus,
    onAutoplayBlocked: () => playOverlay.classList.remove("hidden"),
  });
  await playback.done;
}

playButton.addEventListener("click", () => {
  video.play().catch((err: unknown) => console.warn("[videoshare] play() rejected", err));
});
video.addEventListener("play", () => playOverlay.classList.add("hidden"));
// Presentation only: lets CSS tell "nothing has painted yet" (a full-stage
// loading state) from "playing and buffering ahead" (a small corner pill).
video.addEventListener("loadeddata", () => stage.classList.add("has-frames"));
video.addEventListener("error", () => {
  const code = video.error?.code;
  // Before a source is committed the whole-file fallback may still rescue this.
  if (code === undefined || !playback?.sourceCommitted()) return;
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
