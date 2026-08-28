/**
 * Stats page controller for stats.html (docs/SPEC.md §16.6).
 *
 * Gateway mode only, and honest about it: with no gateway there is nowhere for
 * watch data to have gone, so the page says that in a paragraph and stops.
 *
 * The shape of the thing, and the reason it is worth the page: the gateway can
 * list the analytics objects for a video id and hand back presigned URLs for
 * them, but it cannot read one — every object is AES-GCM ciphertext under the
 * video's own key. So this page signs in (to list), fetches the ciphertext
 * straight from the bucket (never through the gateway — SPEC §15's no-proxy
 * rule), and decrypts, parses and aggregates all of it here, in the tab that
 * holds the key from the share link.
 *
 * Which is also the limit of it: **the key is never sent anywhere.** Only the
 * 22-character video id appears in a request. A pasted link is read, parsed and
 * left alone — never written to `location`, to `history`, or into a form.
 */

import "./app.css";
import "./stats.css";

import { type Auth, type AuthState, createAuth } from "./auth";
import { analyticsAad, decryptBlock, importKeyB64 } from "./crypto";
import { fetchGatewayConfig, gatewayUrl, loadLibrary } from "./settings";
import type { GatewayConfig, LibraryEntry } from "./types";
import { formatDuration, parseShareFragment } from "./util";
import {
  ATTENTION_BUCKETS,
  attentionCurve,
  coverage,
  parsePayload,
  type WatchPayload,
  watchedMs,
} from "./watch";

const GATEWAY_DOCS = "docs/gateway-setup.md";

/**
 * Presigned session fetches in flight at once. A busy video can list a thousand
 * objects; one at a time would crawl, and all at once would open a thousand
 * connections to the bucket for a few hundred bytes each.
 */
const SESSION_CONCURRENCY = 6;

/** Characters of a browserId shown in the table — enough to tell rows apart. */
const VIEWER_PREFIX = 6;

/** A well-formed random id (SPEC §16.1); anything else is not collapsed with anything. */
const ID_RE = /^[A-Za-z0-9_-]{22}$/;

/** One row of `GET {gatewayUrl}/beacon/{videoId}` (SPEC §16.3). */
interface SessionSummary {
  sessionId: string;
  lastModified: string;
  size: number;
  /** Short-lived presigned GET, straight to the bucket. */
  url: string;
}

interface SessionListing {
  sessions: SessionSummary[];
  /** The listing hit the gateway's cap; there are more sessions than these. */
  truncated: boolean;
}

/** What was made of one video's sessions, once every object had its turn. */
interface Report {
  sessions: WatchPayload[];
  /** Objects that would not decrypt or would not parse — shown, never hidden. */
  unreadable: number;
  truncated: boolean;
}

/** An error whose message is meant for the reader. Anything else is a bug. */
class StatsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StatsError";
  }
}

// --- DOM ---------------------------------------------------------------------

function el<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`stats.ts: missing element ${selector}`);
  return node;
}

const unavailable = el<HTMLElement>("#unavailable");
const unavailableTitle = el<HTMLElement>("#unavailable-title");
const unavailableDetail = el<HTMLElement>("#unavailable-detail");

const authPanel = el<HTMLElement>("#auth-panel");
const authLoading = el<HTMLElement>("#auth-loading");
const authSignedOut = el<HTMLElement>("#auth-signed-out");
const authSignedIn = el<HTMLElement>("#auth-signed-in");
const authButton = el<HTMLElement>("#auth-button");
const authEmail = el<HTMLElement>("#auth-email");
const authStatus = el<HTMLElement>("#auth-status");
const signOutButton = el<HTMLButtonElement>("#sign-out");

const picker = el<HTMLElement>("#picker");
const librarySelect = el<HTMLSelectElement>("#library");
const linkInput = el<HTMLInputElement>("#link");
const loadButton = el<HTMLButtonElement>("#load");
const pickerStatus = el<HTMLElement>("#picker-status");

const results = el<HTMLElement>("#results");
const statSessions = el<HTMLElement>("#stat-sessions");
const statViewers = el<HTMLElement>("#stat-viewers");
const statCoverage = el<HTMLElement>("#stat-coverage");
const statCompletions = el<HTMLElement>("#stat-completions");
const notes = el<HTMLElement>("#notes");
const curveCard = el<HTMLElement>("#curve-card");
const curve = el<HTMLElement>("#curve");
const sessionsCard = el<HTMLElement>("#sessions-card");
const sessionsBody = el<HTMLTableSectionElement>("#sessions");

// --- State -------------------------------------------------------------------

/** Set once the gateway answers `analytics: true`; null means the page is inert. */
let gateway: string | null = null;
let signIn: Auth | null = null;
/** Whether a listing is in flight, so a second click cannot start another. */
let loading = false;

// --- Page states -------------------------------------------------------------

/**
 * The one paragraph this page owes a reader when there is nothing to show
 * (SPEC §16.6): no gateway, or a gateway without an analytics bucket. Both are
 * supported configurations, not failures, so neither reads like an error.
 */
function showUnavailable(title: string, detail: string): void {
  unavailableTitle.textContent = title;
  unavailableDetail.textContent = detail;
  unavailable.classList.remove("hidden");
  authPanel.classList.add("hidden");
  picker.classList.add("hidden");
  results.classList.add("hidden");
}

function showStatus(text: string, isError: boolean): void {
  pickerStatus.textContent = text;
  pickerStatus.classList.toggle("error", isError);
  pickerStatus.classList.toggle("muted", !isError);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --- Sign-in (SPEC §15.5's module, unchanged) --------------------------------

function renderAuth(state: AuthState): void {
  const signedIn = state.status === "signed-in";
  authLoading.classList.toggle("hidden", state.status !== "loading");
  authSignedOut.classList.toggle("hidden", state.status !== "signed-out");
  authSignedIn.classList.toggle("hidden", !signedIn);
  authEmail.textContent = state.email ?? "your Google account";
  authStatus.textContent = state.message ?? "";
  authStatus.classList.toggle("error", state.status === "error");
  authStatus.classList.toggle("muted", state.status !== "error");

  // Listing sessions is the one thing here that needs the gateway; picking a
  // video and reading this page's explanation do not.
  loadButton.disabled = !signedIn || loading;
}

// --- Picking a video ---------------------------------------------------------

function libraryLabel(entry: LibraryEntry): string {
  const title = entry.title.trim() || "Untitled recording";
  const created = new Date(entry.createdAt);
  return Number.isNaN(created.getTime()) ? title : `${title} — ${created.toLocaleDateString()}`;
}

function initPicker(): void {
  const entries = loadLibrary().filter((entry) => entry.link);
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = entries.length
    ? "Choose a recording…"
    : "No recordings in this browser — paste a link instead";
  librarySelect.append(placeholder);
  librarySelect.disabled = entries.length === 0;

  for (const entry of entries) {
    const option = document.createElement("option");
    // The value carries the fragment, so the key travels no further than this
    // element: it is read on load and never submitted anywhere.
    option.value = entry.link;
    option.textContent = libraryLabel(entry);
    librarySelect.append(option);
  }

  // Either input alone is enough; a pasted link wins so a stale selection
  // cannot quietly override what someone just typed.
  librarySelect.addEventListener("change", () => {
    if (librarySelect.value) linkInput.value = "";
  });

  picker.classList.remove("hidden");
}

/** The part of a share link after `#`, or the whole thing if it is already one. */
function fragmentOf(link: string): string {
  const hash = link.indexOf("#");
  return hash === -1 ? link.trim() : link.slice(hash + 1).trim();
}

function chosenVideo(): { id: string; keyB64: string } {
  const source = linkInput.value.trim() || librarySelect.value;
  if (!source) throw new StatsError("Choose a recording, or paste a share link.");

  const fragment = parseShareFragment(fragmentOf(source));
  if (!fragment) {
    throw new StatsError(
      "That is not a share link. Paste the whole thing, including everything after the #.",
    );
  }
  return fragment;
}

// --- Reading one video's sessions --------------------------------------------

/** The in-memory ID token, refreshing once if it has aged out. */
async function bearer(): Promise<string> {
  const token = signIn?.getToken() ?? (await signIn?.refresh()) ?? null;
  if (!token) throw new StatsError("Sign in with Google above to list this video's sessions.");
  return token;
}

async function listRequest(base: string, id: string, token: string): Promise<Response> {
  try {
    return await fetch(`${base}/beacon/${id}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
  } catch {
    throw new StatsError(
      `Could not reach the gateway at ${base}. Check that it is running and that its ` +
        `ALLOWED_ORIGINS includes this site. See ${GATEWAY_DOCS}.`,
    );
  }
}

/**
 * `GET {gatewayUrl}/beacon/{id}` (SPEC §16.3) — the only request this page makes
 * to the gateway, and it carries the video id and nothing else.
 */
async function listSessions(base: string, id: string): Promise<SessionListing> {
  let res = await listRequest(base, id, await bearer());
  if (res.status === 401) {
    // The token aged out between the click and the request; GIS can usually
    // replace it without a prompt.
    const fresh = await signIn?.refresh();
    if (fresh) res = await listRequest(base, id, fresh);
  }

  if (res.status === 401) {
    throw new StatsError("The gateway did not accept that sign-in. Sign in again and retry.");
  }
  if (res.status === 403) {
    throw new StatsError(
      "Your Google account is signed in but is not on this gateway's ALLOWED_EMAILS list.",
    );
  }
  if (res.status === 404) {
    throw new StatsError(
      `This gateway has no analytics bucket configured, so it stores no watch data. See ${GATEWAY_DOCS}.`,
    );
  }
  if (!res.ok) {
    throw new StatsError(
      `The gateway answered HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""} for this video's sessions.`,
    );
  }

  let body: unknown;
  try {
    body = (await res.json()) as unknown;
  } catch {
    throw new StatsError("The gateway's answer was not JSON — check that gatewayUrl points at a gateway.");
  }
  return parseListing(body);
}

function parseListing(value: unknown): SessionListing {
  if (value === null || typeof value !== "object") return { sessions: [], truncated: false };
  const raw = value as { sessions?: unknown; truncated?: unknown };
  const sessions: SessionSummary[] = [];

  for (const entry of Array.isArray(raw.sessions) ? raw.sessions : []) {
    if (entry === null || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    // A session is addressed by its id (which the AAD binds) and its presigned
    // url; a row missing either is not one this page can read.
    if (typeof row.sessionId !== "string" || typeof row.url !== "string") continue;
    sessions.push({
      sessionId: row.sessionId,
      lastModified: typeof row.lastModified === "string" ? row.lastModified : "",
      size: typeof row.size === "number" ? row.size : 0,
      url: row.url,
    });
  }
  return { sessions, truncated: raw.truncated === true };
}

/**
 * One session's ciphertext, fetched from the bucket and decrypted here.
 *
 * Null for anything that does not come back as this video's own watch data: the
 * write endpoint is unauthenticated, and a video re-uploaded under a new key
 * leaves objects the current key cannot open. Those are counted and reported,
 * never silently dropped (SPEC §16.6).
 */
async function readSession(
  id: string,
  key: CryptoKey,
  session: SessionSummary,
): Promise<WatchPayload | null> {
  try {
    const res = await fetch(session.url);
    if (!res.ok) return null;
    const block = new Uint8Array(await res.arrayBuffer());
    const plain = await decryptBlock(key, analyticsAad(id, session.sessionId), block);
    return parsePayload(JSON.parse(new TextDecoder().decode(plain)) as unknown);
  } catch {
    return null;
  }
}

/** Runs `task` over `items`, at most `limit` at a time, in no particular order. */
async function pool<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await task(items[i]);
  });
  await Promise.all(workers);
  return out;
}

// --- Aggregates (SPEC §16.6) -------------------------------------------------

/**
 * Distinct browsers. A payload whose `browserId` is not a well-formed random id
 * counts as its own viewer rather than collapsing with every other malformed
 * one — junk must not be able to make a video look less watched than it is.
 */
function uniqueViewers(sessions: readonly WatchPayload[]): number {
  const known = new Set<string>();
  let strangers = 0;
  for (const session of sessions) {
    if (ID_RE.test(session.browserId)) known.add(session.browserId);
    else strangers++;
  }
  return known.size + strangers;
}

/** Mean coverage as a percentage, over the sessions that know their duration. */
function averageCoverage(sessions: readonly WatchPayload[]): number | null {
  const timed = sessions.filter((session) => session.durationMs > 0);
  if (timed.length === 0) return null;
  const total = timed.reduce((sum, s) => sum + coverage(s.watched, s.durationMs), 0);
  return (total / timed.length) * 100;
}

function startedAt(session: WatchPayload): number {
  const at = Date.parse(session.firstPlayedAt);
  return Number.isNaN(at) ? 0 : at;
}

// --- Rendering ---------------------------------------------------------------

function renderCurve(sessions: readonly WatchPayload[]): void {
  const counts = attentionCurve(sessions);
  const peak = Math.max(...counts, 0);
  const percent = 100 / ATTENTION_BUCKETS;

  const bars = counts.map((count, index) => {
    const bar = document.createElement("div");
    bar.className = count > 0 ? "curve-bar" : "curve-bar empty";
    // Height is relative to the busiest bucket: this is a shape, and the tiles
    // above carry the absolute numbers.
    bar.style.height = peak > 0 ? `${Math.max(2, (count / peak) * 100)}%` : "2px";
    bar.title =
      `${Math.round(index * percent)}–${Math.round((index + 1) * percent)}%: ` +
      `${count} ${count === 1 ? "session" : "sessions"}`;
    return bar;
  });

  curve.replaceChildren(...bars);
}

function sessionRow(session: WatchPayload): HTMLTableRowElement {
  const row = document.createElement("tr");

  const started = document.createElement("td");
  const at = Date.parse(session.firstPlayedAt);
  started.textContent = Number.isNaN(at) ? "unknown" : new Date(at).toLocaleString();

  const watched = document.createElement("td");
  watched.className = "numeric";
  if (session.durationMs > 0) {
    watched.textContent = `${Math.round(coverage(session.watched, session.durationMs) * 100)}%`;
    if (session.completed) watched.classList.add("done");
  } else {
    watched.textContent = "—";
  }

  const time = document.createElement("td");
  time.className = "numeric";
  time.textContent = formatDuration(watchedMs(session.watched));

  const viewer = document.createElement("td");
  viewer.className = "viewer";
  viewer.textContent = session.browserId.slice(0, VIEWER_PREFIX) || "unknown";

  row.append(started, watched, time, viewer);
  return row;
}

function renderNotes(report: Report): void {
  const lines: string[] = [];
  if (report.sessions.length === 0 && report.unreadable === 0) {
    lines.push("No sessions yet — nobody has played this video since analytics was turned on.");
  }
  if (report.unreadable > 0) {
    lines.push(
      `${report.unreadable} ${report.unreadable === 1 ? "session" : "sessions"} could not be read: ` +
        "written under a different key, or not watch data at all.",
    );
  }
  if (report.truncated) {
    lines.push("The gateway's listing hit its cap, so these are not all of this video's sessions.");
  }
  notes.textContent = lines.join(" ");
}

function renderReport(report: Report): void {
  const { sessions } = report;
  const average = averageCoverage(sessions);

  statSessions.textContent = String(sessions.length);
  statViewers.textContent = String(uniqueViewers(sessions));
  statCoverage.textContent = average === null ? "—" : `${Math.round(average)}%`;
  statCompletions.textContent = String(sessions.filter((s) => s.completed).length);

  renderNotes(report);
  renderCurve(sessions);
  sessionsBody.replaceChildren(
    ...[...sessions].sort((a, b) => startedAt(b) - startedAt(a)).map(sessionRow),
  );

  const empty = sessions.length === 0;
  curveCard.classList.toggle("hidden", empty);
  sessionsCard.classList.toggle("hidden", empty);
  results.classList.remove("hidden");
}

// --- The one action this page has --------------------------------------------

async function showStats(): Promise<void> {
  const base = gateway;
  if (!base || loading) return;

  loading = true;
  loadButton.disabled = true;
  try {
    const { id, keyB64 } = chosenVideo();
    let key: CryptoKey;
    try {
      key = await importKeyB64(keyB64);
    } catch {
      throw new StatsError("The key in that link is not a valid AES-256 key.");
    }

    showStatus("Listing sessions…", false);
    const listing = await listSessions(base, id);

    showStatus(
      listing.sessions.length === 1
        ? "Reading 1 session…"
        : `Reading ${listing.sessions.length} sessions…`,
      false,
    );
    const read = await pool(listing.sessions, SESSION_CONCURRENCY, (session) =>
      readSession(id, key, session),
    );

    const sessions = read.filter((payload): payload is WatchPayload => payload !== null);
    renderReport({
      sessions,
      unreadable: read.length - sessions.length,
      truncated: listing.truncated,
    });
    showStatus("", false);
  } catch (err) {
    results.classList.add("hidden");
    if (err instanceof StatsError) {
      showStatus(err.message, true);
    } else {
      console.error("[videoshare]", err);
      showStatus(describe(err), true);
    }
  } finally {
    loading = false;
    loadButton.disabled = signIn?.state.status !== "signed-in";
  }
}

// --- Entry point -------------------------------------------------------------

async function main(): Promise<void> {
  const base = gatewayUrl();
  if (!base) {
    // Legacy mode: no gateway, so no watch data exists anywhere to show. No
    // Google script is loaded and no request is made (SPEC §16.7).
    showUnavailable(
      "Watch stats need a gateway",
      "This deployment has no gatewayUrl in config.js, so nothing collects watch data — the player " +
        `talks only to the storage bucket. Setting up a gateway with an analytics bucket is in ${GATEWAY_DOCS}.`,
    );
    return;
  }

  let config: GatewayConfig;
  try {
    config = await fetchGatewayConfig(base);
  } catch (err) {
    showUnavailable("Can’t reach the gateway", describe(err));
    return;
  }

  if (!config.analytics) {
    showUnavailable(
      "Analytics is turned off",
      "This gateway has no ANALYTICS_BUCKET set, so the player sends nothing and there is nothing " +
        `to show. That is a supported configuration — turning it on is in ${GATEWAY_DOCS}.`,
    );
    return;
  }

  gateway = base;
  initPicker();

  authPanel.classList.remove("hidden");
  const auth = createAuth(config.googleClientId);
  auth.mount(authButton);
  auth.onChange(renderAuth);
  signIn = auth;
  renderAuth(auth.state);
}

loadButton.addEventListener("click", () => void showStats());
linkInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") void showStats();
});
signOutButton.addEventListener("click", () => signIn?.signOut());

main().catch((err: unknown) => {
  console.error("[videoshare]", err);
  showUnavailable("Something went wrong", describe(err));
});
