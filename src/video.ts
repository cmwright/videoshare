/**
 * Page controller for `video.html` — the owner's page for one video
 * (docs/SPEC.md §17.4, §17.6).
 *
 * The same video a share link plays, and everything the watch data says about
 * it. Nobody is sent this URL, but it holds a key in its address bar exactly as
 * `view.html` does and the rules are the same ones: the fragment is parsed in
 * memory, the key becomes a `CryptoKey` and is dropped, and it appears in no
 * request path, query, header or body, and is never written to `history`, into
 * a form, or into any storage. Only the 22-character id ever reaches a server.
 *
 * Two things this page deliberately does *not* do, both of them §16.5's rules
 * read from the owner's seat:
 *
 * - **no beacon, ever.** The owner's own visit is not a view, and this page
 *   writes no `videoshare.viewer` key.
 * - **no autoplay.** Fetching, decrypting and appending start immediately so
 *   the video is ready the moment it is wanted, but playback waits for the
 *   reader, who came to look at numbers and should not have audio start
 *   underneath them. (`view.html` still autoplays — that is §8, unchanged.)
 */

import "./app.css";
import "./shell.css";
import "./video.css";

import { type Auth, type AuthState, createAuth } from "./auth";
import { importKeyB64 } from "./crypto";
import {
  type AnalyticsDeps,
  loadReport,
  replayHeatmap,
  statCards,
  type VideoReport,
  viewerTable,
} from "./dashboard";
import { fetchMeta, type Playback, PlaybackError, startPlayback } from "./playback";
import { type AccountChip, initAccountChip } from "./shell";
import { fetchGatewayConfig, gatewayUrl, publicBaseUrl } from "./settings";
import type { GatewayConfig, VideoMeta } from "./types";
import { codecLabel, formatBytes, formatDuration, parseShareFragment, shareLink } from "./util";

const GATEWAY_DOCS = "docs/gateway-setup.md";

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`video.html is missing #${id}`);
  return node as T;
}

const video = el<HTMLVideoElement>("video");
const hero = el("hero");
const videoHead = el("video-head");
const videoTitle = el("video-title");
const videoMetaLine = el("video-meta");
const statusRow = el("status");
const statusText = el("status-text");
const playOverlay = el("play-overlay");
const playButton = el<HTMLButtonElement>("play-button");
const heroError = el("hero-error");
const heroErrorTitle = el("hero-error-title");
const heroErrorDetail = el("hero-error-detail");
const pageStatus = el("page-status");
const copyLinkButton = el<HTMLButtonElement>("copy-link");
const copyLinkLabel = el("copy-link-label");
const engagementBody = el("engagement-body");
// Gateway mode's corner of the sidebar. `shell.ts` owns it once there is an
// `Auth` to wire; before that — and if `/config` never answers — this page still
// has to say which of the two "no identity" states it is in (§17.1).
const accountChipBox = el("account-chip");
const accountHint = el("account-hint");

/** The video this page is about, once its fragment has been read. */
let target: { id: string; keyB64: string } | null = null;
let meta: VideoMeta | null = null;
let playback: Playback | null = null;

/** Gateway mode's state, all of it absent in legacy mode (§16.7). */
let gatewayBase: string | null = null;
let gatewayConfig: GatewayConfig | null = null;
let auth: Auth | null = null;
let chip: AccountChip | null = null;
/** Set once the gateway's `/config` has been asked for and answered or failed. */
let gatewayReady = false;
let gatewayProblem: string | null = null;
/** The `/config` attempt in flight, so a double Reload is still one request. */
let connecting: Promise<void> | null = null;

/**
 * Counts renders of the Engagement section so a slow report cannot paint over a
 * newer one. Sign-in, Reload and the meta arriving can all redraw it, and they
 * do not queue.
 */
let renders = 0;

// --- Hero chrome -------------------------------------------------------------

function setStatus(text: string | null): void {
  if (text === null) {
    statusRow.hidden = true;
    return;
  }
  statusText.textContent = text;
  statusRow.hidden = false;
}

/**
 * A playback failure takes the hero's place. Engagement is untouched: the watch
 * data is still readable, and is often exactly what the reader came for.
 */
function showHeroError(title: string, detail: string): void {
  if (!heroError.hidden) return; // keep the first, most specific error
  heroErrorTitle.textContent = title;
  heroErrorDetail.textContent = detail;
  heroError.hidden = false;
  playOverlay.hidden = true;
  setStatus(null);
  if (video.readyState < HTMLMediaElement.HAVE_METADATA) hero.hidden = true;
}

function showPageStatus(text: string): void {
  pageStatus.textContent = text;
}

/**
 * Title, tab title and meta line. Called again once the element reports a frame
 * size, which is the only honest source for a resolution: `VideoMeta` carries
 * none (§5), so it appears when the media element knows it and not before.
 */
function showMeta(current: VideoMeta): void {
  const title = current.title.trim() || "Untitled recording";
  videoTitle.textContent = title;
  document.title = `${title} · VideoShare`;

  const parts: string[] = [];
  const created = new Date(current.createdAt);
  if (!Number.isNaN(created.getTime())) {
    parts.push(created.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }));
  }
  if (current.durationMs > 0) parts.push(formatDuration(current.durationMs));
  if (current.totalBytes > 0) parts.push(formatBytes(current.totalBytes));
  const codec = codecLabel(current.mimeType);
  if (codec) parts.push(codec);
  if (video.videoWidth > 0 && video.videoHeight > 0) {
    parts.push(`${video.videoWidth}×${video.videoHeight}`);
  }

  videoMetaLine.textContent = parts.join(" · ");
  videoHead.hidden = false;
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copies the **share** link — the viewer's link, rebuilt from this page's own
 * URL and therefore byte-identical to the one the recorder stored (§11). Never
 * this page's own address: nobody is sent a `video.html` URL.
 */
function wireCopyLink(id: string, keyB64: string): void {
  copyLinkButton.addEventListener("click", () => {
    void (async () => {
      if (await copyToClipboard(shareLink(id, keyB64))) {
        const original = copyLinkLabel.textContent;
        copyLinkLabel.textContent = "Copied";
        window.setTimeout(() => {
          copyLinkLabel.textContent = original;
        }, 1200);
      } else {
        showPageStatus("The clipboard was blocked — copy the link from the library instead.");
      }
    })();
  });
}

// --- Engagement (SPEC §17.6) -------------------------------------------------

function note(text: string): HTMLElement {
  const line = document.createElement("p");
  line.className = "analytics-note muted hint";
  line.textContent = text;
  return line;
}

/**
 * One of the three states that are not "signed in with analytics on", each a
 * designed block in the same footprint rather than an absence (§17.6).
 */
function stateBlock(title: string, body: string, action?: HTMLElement): HTMLElement {
  const block = document.createElement("div");
  block.className = "engagement-state";

  const heading = document.createElement("p");
  heading.className = "engagement-state-title";
  heading.textContent = title;

  const detail = document.createElement("p");
  detail.className = "engagement-state-body muted hint";
  detail.textContent = body;

  block.append(heading, detail);
  if (action) block.append(action);
  return block;
}

/**
 * Redraws the section and never rejects. Every caller is an event handler or a
 * fire-and-forget: nothing on this page waits on Engagement, and a bug in it
 * must not surface as an unhandled rejection over a video that is playing fine.
 */
function refreshEngagement(opts?: { refetch?: boolean }): void {
  void renderEngagement(opts).catch((err: unknown) => {
    console.error("[videoshare]", err);
    engagementBody.replaceChildren(note("Could not show this video's watch data."));
  });
}

function reloadControl(): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "link-button";
  button.textContent = "Reload";
  button.addEventListener("click", () => refreshEngagement({ refetch: true }));
  return button;
}

/** The whole section for a loaded report, in §17.6's order. */
function renderReport(report: VideoReport, durationMs: number): void {
  const nodes: (HTMLElement | Node)[] = [
    statCards(report),
    replayHeatmap(report, durationMs),
    viewerTable(report),
  ];

  // Each only when true (§16.6): a reader must never be shown "12 viewers" that
  // silently means "the viewers in the first 1000 sessions".
  if (report.unreadable > 0) {
    nodes.push(
      note(
        `${report.unreadable} ${report.unreadable === 1 ? "session" : "sessions"} could not be read: ` +
          "written under a different key, or not watch data at all.",
      ),
    );
  }
  if (report.truncated) {
    nodes.push(
      note("The gateway's listing hit its cap, so these are not all of this video's sessions."),
    );
  }
  nodes.push(reloadControl());

  engagementBody.replaceChildren(...nodes);
}

/**
 * Everything the section can be, decided from the gateway config and the auth
 * state this page already tracks. Nothing below makes a request except the last
 * branch: legacy mode and `analytics: false` are answered without touching the
 * network (§16.7).
 */
async function renderEngagement(opts?: { refetch?: boolean }): Promise<void> {
  // Bumped before anything is drawn, so every render — including the ones that
  // answer without a request — invalidates a report still in flight.
  const mine = ++renders;

  if (!target) {
    engagementBody.replaceChildren(
      stateBlock(
        "No watch data to read",
        "This page's link is missing the video id and key, so there is nothing to decrypt.",
      ),
    );
    return;
  }

  if (!gatewayBase) {
    engagementBody.replaceChildren(
      stateBlock(
        "Watch data needs a gateway",
        "This deployment uploads straight to your bucket, so nothing records who watched a video. " +
          `Setting up the optional gateway turns it on — see ${GATEWAY_DOCS}. The video plays either way.`,
      ),
    );
    return;
  }

  if (!gatewayReady) {
    engagementBody.replaceChildren(note("Loading…"));
    return;
  }

  // Reload after a failed `/config` retries the request itself. Without this the
  // control below could only ever redraw its own error, and — since the Google
  // client id comes from that same answer — sign-in would stay impossible until
  // a full page reload. §16.6's rule is that a load that failed is not cached.
  if (!gatewayConfig && opts?.refetch) {
    engagementBody.replaceChildren(note("Loading…"));
    await connectGateway();
    if (mine !== renders) return;
  }

  if (!gatewayConfig) {
    engagementBody.replaceChildren(
      note(gatewayProblem ?? "Could not reach the gateway, so this video's watch data is unavailable."),
      reloadControl(),
    );
    return;
  }

  if (!gatewayConfig.analytics) {
    engagementBody.replaceChildren(
      stateBlock(
        "This deployment stores no watch data",
        "The gateway is running without an analytics bucket, so nothing is recorded about who " +
          `watched this video. Setting ANALYTICS_BUCKET turns it on — see ${GATEWAY_DOCS}.`,
      ),
    );
    return;
  }

  if (!auth || auth.state.status !== "signed-in") {
    const signIn = document.createElement("button");
    signIn.type = "button";
    signIn.className = "link-button";
    signIn.textContent = "Sign in";
    // The control itself is in the sidebar and is visible from here; this only
    // points at it, and moves focus to it (SPEC §17.2).
    signIn.addEventListener("click", () => chip?.highlight());

    engagementBody.replaceChildren(
      stateBlock(
        "Sign in to read this video's watch data",
        "Every session is encrypted with this video's own key, so the gateway stores it and " +
          "cannot read it — only this page can, and only for someone the gateway will list it to. " +
          "The sign-in control is in the sidebar.",
        signIn,
      ),
    );
    return;
  }

  const deps: AnalyticsDeps = {
    gatewayUrl: gatewayBase,
    token: () => auth?.getToken() ?? null,
  };

  // A cached report resolves in a microtask, so this never flashes for one.
  engagementBody.replaceChildren(note("Loading…"));

  try {
    const report = await loadReport(target, deps, opts);
    // A sign-out, a second Reload or the meta arriving redrew the section while
    // this was in flight; a stale answer must not paint over the newer one.
    if (mine !== renders) return;
    renderReport(report, meta?.durationMs ?? 0);
  } catch (err) {
    if (mine !== renders) return;
    // `loadReport` rejects only with a sentence meant for a reader (§16.6).
    const text = err instanceof Error ? err.message : "Could not load analytics for this video.";
    engagementBody.replaceChildren(note(text), reloadControl());
  }
}

// --- Gateway mode ------------------------------------------------------------

/**
 * Gateway mode's setup request, and the Google script that follows it. Legacy
 * mode returns on the first line, having made no request, loaded no third-party
 * script and written no storage key (§16.7).
 */
async function startGateway(): Promise<void> {
  gatewayBase = gatewayUrl();
  if (!gatewayBase) {
    // No account, nothing to sign out of: the chip is removed and the lock line
    // ends the sidebar (§17.1).
    initAccountChip(null);
    return;
  }
  await connectGateway();
}

/**
 * `/config` and everything that hangs off it, at most one attempt in flight.
 *
 * A config that *did* load is kept for the document's lifetime: it is the shape
 * of the deployment rather than data about a video, and asking again would
 * remount Google's button. A config that failed is not — Engagement's Reload
 * calls this again, which is the only way this page can recover an unreachable
 * gateway short of a full page load.
 */
function connectGateway(): Promise<void> {
  if (gatewayConfig) return Promise.resolve();
  connecting ??= loadGatewayConfig().finally(() => {
    connecting = null;
  });
  return connecting;
}

async function loadGatewayConfig(): Promise<void> {
  const base = gatewayBase;
  if (!base) return;

  gatewayProblem = null;
  try {
    gatewayConfig = await fetchGatewayConfig(base);
  } catch (err) {
    gatewayProblem = err instanceof Error ? err.message : String(err);
  } finally {
    gatewayReady = true;
  }

  if (!gatewayConfig) {
    // There is no client id, so there will be no Google button — but removing
    // the chip is legacy mode's answer, "no account here", and this is not
    // legacy mode (§17.1). The chip stays and says what it can; the sentence
    // that explains it is in Engagement, on this same page, where index.html
    // puts it in Settings → Account. `initAccountChip` is deliberately not
    // called with a null auth here: it would remove the mount point a later
    // Reload needs, and GIS gets exactly one in the document.
    accountChipBox.hidden = false;
    accountHint.textContent = "Sign-in unavailable";
    return;
  }

  auth = createAuth(gatewayConfig.googleClientId);
  // Overwrites the hint above from the auth state, so a recovered Reload does
  // not leave "Sign-in unavailable" under a working Google button.
  chip = initAccountChip(auth);
  // Signing in and out re-renders the section, on the same event that re-renders
  // the library on index.html. That is the whole coupling between the two.
  auth.onChange((state: AuthState) => {
    chip?.render(state);
    refreshEngagement();
  });
}

// --- Entry point -------------------------------------------------------------

async function main(): Promise<void> {
  const fragment = parseShareFragment(location.hash);
  if (!fragment) {
    showHeroError(
      "Incomplete link",
      "This page needs the video id and key in its address, like …/video.html#<id>.<key>. Open " +
        "the recording from Videos rather than typing the address by hand.",
    );
    refreshEngagement();
    return;
  }
  target = fragment;

  // Started before anything is awaited: the sidebar's chip should not wait on a
  // bucket, and the section below the player fills in on its own schedule.
  const gateway = startGateway().then(() => refreshEngagement());

  let base: string;
  try {
    base = publicBaseUrl();
  } catch (err) {
    showHeroError("Not configured", err instanceof Error ? err.message : String(err));
    await gateway;
    return;
  }

  let key: CryptoKey;
  try {
    key = await importKeyB64(fragment.keyB64);
  } catch {
    showHeroError(
      "Invalid key",
      "The key in this page's address is not a valid AES-256 key. Open the recording from Videos again.",
    );
    await gateway;
    return;
  }

  wireCopyLink(fragment.id, fragment.keyB64);

  setStatus("Loading…");
  meta = await fetchMeta(base, fragment.id, key);
  showMeta(meta);
  // The duration the heatmap's axis and peak caption are measured against only
  // exists now, so a report that arrived first is redrawn against it.
  refreshEngagement();

  playback = startPlayback({
    video,
    publicBaseUrl: base,
    id: fragment.id,
    key,
    meta,
    // §17.4: the reader asks. `onAutoplayBlocked` is what reveals the control,
    // and it fires as soon as there is something to play.
    autoplay: false,
    onStatus: setStatus,
    onAutoplayBlocked: () => {
      playOverlay.hidden = false;
    },
  });
  await playback.done;
}

playButton.addEventListener("click", () => {
  video.play().catch((err: unknown) => console.warn("[videoshare] play() rejected", err));
});
video.addEventListener("play", () => {
  playOverlay.hidden = true;
});
// Presentation only: lets CSS tell "nothing has painted yet" (a full-hero
// loading state) from "playing and buffering ahead" (a small corner pill).
video.addEventListener("loadeddata", () => hero.classList.add("has-frames"));
// The only honest source for a frame size, so the meta line gains one here.
video.addEventListener("loadedmetadata", () => {
  if (meta) showMeta(meta);
});
video.addEventListener("error", () => {
  const code = video.error?.code;
  // Before a source is committed the whole-file fallback may still rescue this.
  if (code === undefined || !playback?.sourceCommitted()) return;
  showHeroError(
    "Playback failed",
    `Your browser could not play this recording (media error ${code}). It is most likely missing a codec — try the latest Chrome, Edge or Firefox.`,
  );
});

main().catch((err: unknown) => {
  if (err instanceof PlaybackError) {
    showHeroError(err.title, err.message);
  } else {
    console.error("[videoshare]", err);
    showHeroError("Something went wrong", err instanceof Error ? err.message : String(err));
  }
});
