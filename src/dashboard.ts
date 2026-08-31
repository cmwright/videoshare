/**
 * The reader half of playback analytics (docs/SPEC.md §16.6, §17.6).
 *
 * There is no stats page, and as of §17 there is no expander either: watch data
 * belongs next to the video it is about, and the surface that is about one video
 * is the **video page** (§17.4). This module fetches, decrypts and aggregates
 * one video's sessions, and hands its callers DOM — the full Engagement section
 * for `video.ts`, and two numbers for a library row in `record.ts`.
 *
 * The shape of the thing, and why it is a module of its own rather than more of
 * either page: the gateway can list a video's analytics objects and hand back
 * presigned URLs, but it cannot read one — every object is AES-GCM ciphertext
 * under the video's own key. So this fetches the listing (authenticated), then
 * the ciphertext **straight from the bucket** (never through the gateway —
 * §15's no-proxy rule), and decrypts, parses and aggregates all of it here.
 *
 * Which is also the limit of it: **the key never leaves the page.** Only the
 * 22-character video id appears in a request. The fragment holding the key is
 * parsed in memory and never written to `location`, to `history`, or into a form.
 *
 * Nothing here is the page's business. `loadReport` rejects only with a sentence
 * meant for a reader, and its callers render that sentence where the content
 * would have gone: this is a panel about a video, and it must never interrupt a
 * recording or an upload.
 *
 * Since §18 it also owns the deletion half of the analytics bucket
 * (`DELETE /sessions/{id}`, repeated while `truncated`), which lives here
 * because it shares `AnalyticsDeps` and invalidates the cache above. That
 * bucket's deletes are the gateway's own — the browser has never held a
 * credential for it, and the objects under a prefix are not enumerable from a
 * presigned URL — while the *video* bucket's three deletes are presigned and
 * sent from the browser, in `upload.ts` (§18.3). Same split as everywhere else.
 */

import { analyticsAad, decryptBlock, importKeyB64 } from "./crypto";
import { formatDuration } from "./util";
import {
  averageWatchedMs,
  completionRate,
  groupByViewer,
  HEAT_BUCKETS,
  normalizeHeat,
  parsePayload,
  peakBucket,
  relativeHeat,
  sumHeat,
  type ViewerReport,
  type WatchPayload,
  type WatchSession,
} from "./watch";

/** What this module needs from the page it renders into. */
export interface AnalyticsDeps {
  gatewayUrl: string;
  /** The current Google ID token, or null. Read per request, never captured. */
  token: () => string | null;
}

/**
 * Presigned session fetches in flight at once. A busy video can list a thousand
 * objects; one at a time would crawl, and all at once would open a thousand
 * connections to the bucket for a few hundred bytes each.
 */
export const SESSION_CONCURRENCY = 6;

/**
 * Videos summarized at once on the library page (SPEC §17.3). A row's summary
 * is a whole listing plus every session behind it, so three rows filling in is
 * already several dozen requests; more would make scrolling the library cost
 * more than watching a video.
 */
export const LIBRARY_CONCURRENCY = 3;

/**
 * Rows summarized without an `IntersectionObserver` to say which are visible —
 * about one screenful. The rest wait until the reader reaches for them.
 */
export const LIBRARY_SUMMARY_EAGER = 6;

/** Characters of a browserId shown in a viewer row, then an ellipsis. */
export const VIEWER_PREFIX = 8;

/** Viewer rows drawn before "Show all" (SPEC §17.6). */
export const VIEWER_ROWS = 8;

/** One video's sessions, once every object had its turn. */
export interface VideoReport {
  sessions: WatchSession[];
  /** Objects that would not decrypt or would not parse — shown, never hidden. */
  unreadable: number;
  /** The gateway's listing hit MAX_LISTED_SESSIONS; there are more than these. */
  truncated: boolean;
}

/** The two numbers a library row carries (SPEC §17.3). */
export interface VideoSummary {
  views: number;
  viewers: number;
}

/** One row of `GET {gatewayUrl}/sessions/{videoId}` (SPEC §16.3). */
interface SessionSummary {
  sessionId: string;
  lastModified: string;
  size: number;
  /** Short-lived presigned GET, straight to the bucket. */
  url: string;
}

interface SessionListing {
  sessions: SessionSummary[];
  truncated: boolean;
}

/** An error whose message is meant for the reader. Anything else is a bug. */
class AnalyticsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnalyticsError";
  }
}

/**
 * Results per video id, for the **document's** lifetime (SPEC §16.6).
 * Re-rendering the library — which happens on every sign-in and every Remove —
 * does not refetch, and the video page's Reload replaces the entry. A load that
 * *failed* is never cached: the next attempt retries it, because the usual cause
 * is a token that has since been refreshed. The cache does not survive
 * navigation, so opening a row's video page fetches that video once for itself.
 *
 * The entry is the **promise**, not the report, so a second ask for a video
 * already being read joins the first instead of starting a second listing and a
 * second thousand session fetches. Both owner pages can ask twice before either
 * answer arrives — the video page on sign-in restore and again when meta lands,
 * a library row when the queue reaches it while a render is still in flight —
 * and only one of those renders is kept, but both would have cost the network.
 */
const cache = new Map<string, Promise<VideoReport>>();

/**
 * One video's report, from the cache or from the network.
 *
 * Rejects only with a sentence a reader should see — anything unexpected is
 * logged and reported as the one generic line, so every caller can render
 * `err.message` without deciding what is safe to show.
 */
export function loadReport(
  video: { id: string; keyB64: string },
  deps: AnalyticsDeps,
  opts?: { refetch?: boolean },
): Promise<VideoReport> {
  if (!opts?.refetch) {
    const cached = cache.get(video.id);
    if (cached) return cached;
  }

  const pending = read(video, deps);
  cache.set(video.id, pending);
  // Evicted the moment it is known to have failed, so the next ask retries.
  // Only if it is still the entry: a Reload during this one already replaced it,
  // and dropping that would make the retry the thing that gets refetched.
  void pending.catch(() => {
    if (cache.get(video.id) === pending) cache.delete(video.id);
  });
  return pending;
}

/** `readVideo`, with every rejection turned into a sentence for a reader. */
async function read(
  video: { id: string; keyB64: string },
  deps: AnalyticsDeps,
): Promise<VideoReport> {
  try {
    return await readVideo(video, deps);
  } catch (err) {
    if (err instanceof AnalyticsError) throw err;
    console.error("[videoshare]", err);
    throw new AnalyticsError("Could not load analytics for this video.");
  }
}

/** Views and unique viewers — all a list row can carry honestly (SPEC §17.3). */
export function summarize(report: VideoReport): VideoSummary {
  return {
    views: report.sessions.length,
    viewers: groupByViewer(report.sessions).length,
  };
}

/**
 * Drops one video's cached report — §18.1's third step, beside
 * `removeFromLibrary(id)` and the row's thumbnail object URL.
 *
 * A cache entry is an answer about a video, and once the video is deleted there
 * is no honest answer left for it to give. The cache lives for the document, so
 * without this a library that re-rendered after a delete would still hold a
 * report for an id that no longer exists.
 */
export function forgetReport(id: string): void {
  cache.delete(id);
}

// --- Deleting one video's sessions (SPEC §18.4) ------------------------------

/**
 * Rounds of `DELETE /sessions/{id}` one delete may take. 25 × the gateway's
 * `MAX_DELETED_SESSIONS` (40) is `MAX_LISTED_SESSIONS` (1000) — the most §16.3
 * was ever willing to *read*, so a prefix past this is one no reader could have
 * seen either.
 */
export const MAX_DELETE_ROUNDS = 25;

/** What to do after one round: another, stop, or give up loudly. */
export type DeleteRound = "done" | "again" | "stalled";

/**
 * The loop's stopping rule, pure so it is testable without a gateway.
 *
 * `round` is the 1-based number of the round that produced `result`, so
 * `"again"` means "another round is permitted after this one" — which caps the
 * whole delete at {@link MAX_DELETE_ROUNDS} requests.
 *
 * `"stalled"` covers **both** ways this loop could fail to terminate, and
 * neither of them spins: a round reporting `truncated: true` with `deleted: 0`
 * is a gateway that cannot make progress (a prefix holding objects its skip
 * rule refuses to touch is the way to get there), and running out of rounds is
 * a prefix larger than §16.3 would ever list. Both surface as a failure on the
 * row.
 */
export function nextDeleteRound(
  result: { deleted: number; truncated: boolean },
  round: number,
): DeleteRound {
  if (!result.truncated) return "done";
  if (result.deleted > 0 && round < MAX_DELETE_ROUNDS) return "again";
  return "stalled";
}

/**
 * Repeats §18.4's bounded delete until the prefix is empty; resolves with the
 * total deleted.
 *
 * Called only when the gateway answered `analytics: true` — otherwise §18.1's
 * first step does not exist and nothing is requested. It runs **before** the
 * video's own objects go (§18.1): it is the step most likely to fail for a
 * reason that costs nothing (an ID token that expired since the page loaded),
 * and failing here leaves the video, the entry and the watch data all intact.
 */
export async function deleteSessions(
  video: { id: string },
  deps: AnalyticsDeps,
): Promise<number> {
  let total = 0;
  for (let round = 1; ; round++) {
    const result = await deleteSessionsOnce(deps, video.id);
    total += result.deleted;

    const next = nextDeleteRound(result, round);
    if (next === "done") return total;
    if (next === "stalled") {
      throw new AnalyticsError(
        `The gateway stopped part-way through deleting this video's watch data ` +
          `(${total} object${total === 1 ? "" : "s"} removed). Try again, or clear the rest from ` +
          `the analytics bucket directly.`,
      );
    }
  }
}

/** One bounded pass: `DELETE {gatewayUrl}/sessions/{id}` (SPEC §18.4). */
async function deleteSessionsOnce(
  deps: AnalyticsDeps,
  id: string,
): Promise<{ deleted: number; truncated: boolean }> {
  const token = deps.token();
  if (!token) throw new AnalyticsError("Sign in again to delete this video.");

  let res: Response;
  try {
    res = await fetch(`${deps.gatewayUrl}/sessions/${id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
  } catch {
    throw new AnalyticsError("Could not reach the gateway to delete this video's watch data.");
  }

  if (res.status === 401) throw new AnalyticsError("Sign in again to delete this video.");
  if (res.status === 403) {
    throw new AnalyticsError("This Google account is not on the gateway's allowed list.");
  }
  if (res.status === 404) {
    throw new AnalyticsError("This gateway has no analytics bucket, so it stores no watch data.");
  }
  if (!res.ok) {
    throw new AnalyticsError(
      `The gateway answered HTTP ${res.status} deleting this video's watch data.`,
    );
  }

  let body: unknown;
  try {
    body = (await res.json()) as unknown;
  } catch {
    throw new AnalyticsError("The gateway's answer was not JSON.");
  }
  return parseDeleteResult(body);
}

/**
 * A missing or malformed count reads as `0`, and a missing `truncated` as
 * `false` — so a gateway that answers something unexpected ends the loop
 * rather than driving it. `truncated: true` with no progress is `"stalled"`
 * above, which is the honest reading of an answer this client cannot use.
 */
function parseDeleteResult(value: unknown): { deleted: number; truncated: boolean } {
  const raw = value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const deleted = typeof raw.deleted === "number" && Number.isFinite(raw.deleted) ? raw.deleted : 0;
  return { deleted: Math.max(0, Math.trunc(deleted)), truncated: raw.truncated === true };
}

// --- Reading one video's sessions --------------------------------------------

async function readVideo(
  video: { id: string; keyB64: string },
  deps: AnalyticsDeps,
): Promise<VideoReport> {
  let key: CryptoKey;
  try {
    key = await importKeyB64(video.keyB64);
  } catch {
    throw new AnalyticsError("The key in this link is not a valid AES-256 key.");
  }

  const listing = await listSessions(deps, video.id);
  const read = await pool(listing.sessions, SESSION_CONCURRENCY, (session) =>
    readSession(video.id, key, session),
  );

  const sessions = read.filter((session): session is WatchSession => session !== null);
  return {
    sessions,
    unreadable: read.length - sessions.length,
    truncated: listing.truncated,
  };
}

/**
 * `GET {gatewayUrl}/sessions/{id}` (SPEC §16.3) — the only request this module
 * makes to the gateway, and it carries the video id and nothing else.
 */
async function listSessions(deps: AnalyticsDeps, id: string): Promise<SessionListing> {
  const token = deps.token();
  // The sign-in control is in the sidebar of the same page, so this says so
  // plainly rather than silently re-prompting (SPEC §16.6).
  if (!token) throw new AnalyticsError("Sign in again to load analytics.");

  let res: Response;
  try {
    res = await fetch(`${deps.gatewayUrl}/sessions/${id}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
  } catch {
    throw new AnalyticsError("Could not reach the gateway to list this video's sessions.");
  }

  if (res.status === 401) throw new AnalyticsError("Sign in again to load analytics.");
  if (res.status === 403) {
    throw new AnalyticsError("This Google account is not on the gateway's allowed list.");
  }
  if (res.status === 404) {
    throw new AnalyticsError("This gateway has no analytics bucket, so it stores no watch data.");
  }
  if (!res.ok) {
    throw new AnalyticsError(`The gateway answered HTTP ${res.status} for this video's sessions.`);
  }

  let body: unknown;
  try {
    body = (await res.json()) as unknown;
  } catch {
    throw new AnalyticsError("The gateway's answer was not JSON.");
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
    // url; a row missing either is not one this module can read.
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
): Promise<WatchSession | null> {
  try {
    const res = await fetch(session.url);
    if (!res.ok) return null;
    const block = new Uint8Array(await res.arrayBuffer());
    const plain = await decryptBlock(key, analyticsAad(id, session.sessionId), block);
    const payload = parsePayload(JSON.parse(new TextDecoder().decode(plain)) as unknown);
    return payload ? { payload, lastModified: session.lastModified } : null;
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

// --- Engagement, block by block (SPEC §17.6) ---------------------------------

/**
 * The four stat cards, in §17.6's order. Zeros for an empty report rather than
 * dashes: "0 views" is a fact, while a completion rate with no timed session
 * behind it is not, and reads "—".
 */
export function statCards(report: VideoReport): HTMLElement {
  const payloads = report.sessions.map((session) => session.payload);
  const completion = completionRate(payloads);
  const average = averageWatchedMs(payloads);

  const grid = document.createElement("div");
  grid.className = "stat-cards";
  grid.append(
    statCard("Views", String(report.sessions.length)),
    statCard("Unique viewers", String(groupByViewer(report.sessions).length)),
    statCard("Completion rate", completion === null ? "—" : `${Math.round(completion * 100)}%`),
    statCard("Avg watch time", average === null ? "—" : formatDuration(average)),
  );
  return grid;
}

function statCard(label: string, value: string): HTMLElement {
  const card = document.createElement("div");
  card.className = "stat-card";

  const name = document.createElement("span");
  name.className = "stat-label";
  name.textContent = label;

  const figure = document.createElement("span");
  figure.className = "stat-value";
  figure.textContent = value;

  card.append(name, figure);
  return card;
}

/**
 * The replay heatmap: `HEAT_BUCKETS` bars, a peak caption and a time axis.
 *
 * With no sessions at all this is §17.6's one line — "No views yet." — rather
 * than fifty hairlines implying data, so a caller can append the three blocks in
 * order and get the zero state for free.
 */
export function replayHeatmap(report: VideoReport, durationMs: number): HTMLElement {
  if (report.sessions.length === 0) return note("No views yet.");

  const payloads = report.sessions.map((session) => session.payload);
  const card = document.createElement("section");
  card.className = "heat-card";

  const head = document.createElement("div");
  head.className = "heat-head";

  const title = document.createElement("span");
  title.className = "heat-title";
  title.textContent = "Replays across the video";
  head.append(title);

  const peak = peakBucket(payloads);
  // Omitted entirely rather than printed as zeros: with no duration there is no
  // position to name, and with no heat there is no peak to name it about.
  if (peak && durationMs > 0) {
    const caption = document.createElement("span");
    caption.className = "heat-peak";
    caption.textContent =
      `peak ${peak.times.toFixed(1)}× at ` +
      formatDuration((peak.index * durationMs) / HEAT_BUCKETS);
    head.append(caption);
  }

  card.append(head, heatmap(sumHeat(payloads), relativeHeat(payloads), "Replays across the video"));
  card.append(timeAxis(durationMs));
  return card;
}

/**
 * 50 CSS bars, one per 2% of the video (SPEC §16.6) — no chart library, no
 * canvas, no external asset.
 *
 * Two channels, and they are different numbers on purpose: **height** is the
 * shape of attention within this video (`normalizeHeat`), and **colour** is
 * intensity against a single pass (`relativeHeat`), so a bucket played through
 * more than once reads visibly hotter than one played through half way.
 */
function heatmap(heat: readonly number[], relative: readonly number[], label: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "heatmap";
  wrap.setAttribute("role", "img");
  wrap.setAttribute("aria-label", label);

  const height = normalizeHeat(heat);
  for (let b = 0; b < heat.length; b++) {
    const times = relative[b] ?? 0;
    const bar = document.createElement("div");
    bar.className = times >= 1 ? "heat-bar hot" : "heat-bar";
    // An empty bucket keeps its CSS hairline, so 50 bars stay 50 bars.
    bar.style.height = `${(height[b] * 100).toFixed(1)}%`;
    // Below one pass, the colour warms with the ratio; at or above it the bar
    // goes fully hot, which is the threshold §16.6 insists must be legible.
    bar.style.setProperty("--heat-mix", `${Math.round(Math.min(1, Math.max(0, times)) * 55)}%`);
    // Exactly `~N.Nx`, and nothing else in the attribute (SPEC §16.6).
    bar.title = `~${times.toFixed(1)}x`;
    wrap.append(bar);
  }
  return wrap;
}

/**
 * Five labels under the bars — 0, ¼, ½, ¾ and the full duration — so a peak has
 * a position a reader can scrub to. A video with no duration keeps the
 * Start/End pair, which is all it can honestly say.
 */
function timeAxis(durationMs: number): HTMLElement {
  const axis = document.createElement("div");
  axis.className = "heat-axis muted";
  const labels =
    durationMs > 0
      ? [0, 0.25, 0.5, 0.75, 1].map((at) => formatDuration(durationMs * at))
      : ["Start", "End"];
  for (const text of labels) {
    const span = document.createElement("span");
    span.textContent = text;
    axis.append(span);
  }
  return axis;
}

/**
 * One row per unique viewer, most recent first, truncated at {@link VIEWER_ROWS}
 * with an honest "Showing N of M viewers" line and a **Show all** that reveals
 * the rest in place. It fetches nothing: every viewer is already in memory, and
 * the truncation is about a readable page, not about a request.
 *
 * An empty report renders an empty container: with no sessions §17.6 shows no
 * table at all, and `replayHeatmap` has already said "No views yet."
 */
export function viewerTable(report: VideoReport): HTMLElement {
  if (report.sessions.length === 0) {
    // Nothing at all rather than an empty frame: with no sessions §17.6 shows no
    // table, and `replayHeatmap` has already said "No views yet." The element is
    // plain — no `.viewer-table`, whose own `display` would fight `hidden`.
    const empty = document.createElement("div");
    empty.hidden = true;
    return empty;
  }

  const table = document.createElement("section");
  table.className = "viewer-table";

  const head = document.createElement("div");
  head.className = "viewer-row viewer-head";
  for (const [label, className] of [
    ["Viewer", "viewer-id"],
    ["Plays", "viewer-plays"],
    ["Attention", "viewer-attention"],
    ["Watched", "viewer-coverage"],
    ["Last seen", "viewer-when"],
  ] as const) {
    const cell = document.createElement("span");
    cell.className = className;
    cell.textContent = label;
    head.append(cell);
  }
  table.append(head);

  const viewers = groupByViewer(report.sessions);
  const shown = viewers.slice(0, VIEWER_ROWS);
  const rest = viewers.slice(VIEWER_ROWS);
  for (const viewer of shown) {
    table.append(viewerRow(viewer, payloadsOf(report.sessions, viewer.browserId)));
  }

  if (rest.length === 0) return table;

  const more = document.createElement("div");
  more.className = "viewer-more";

  const line = document.createElement("span");
  line.className = "muted hint";
  line.textContent = `Showing ${shown.length} of ${viewers.length} viewers`;

  const showAll = document.createElement("button");
  showAll.type = "button";
  showAll.className = "link-button";
  showAll.textContent = "Show all";
  showAll.addEventListener("click", () => {
    for (const viewer of rest) {
      more.before(viewerRow(viewer, payloadsOf(report.sessions, viewer.browserId)));
    }
    more.remove();
  });

  more.append(line, showAll);
  table.append(more);
  return table;
}

function viewerRow(viewer: ViewerReport, payloads: readonly WatchPayload[]): HTMLElement {
  const row = document.createElement("div");
  row.className = "viewer-row";

  const who = document.createElement("span");
  who.className = "viewer-id";
  // A viewer is a browser, not a person, and this is all there is to say about
  // one: no name, no account, no IP, because none was ever read (§16.8).
  who.textContent = shortId(viewer.browserId);

  const plays = document.createElement("span");
  plays.className = "viewer-plays";
  plays.textContent = count(viewer.plays, "play");

  const attention = document.createElement("div");
  attention.className = "viewer-attention";
  attention.append(
    heatmap(viewer.heat, relativeHeat(payloads), `Replays by viewer ${shortId(viewer.browserId)}`),
  );

  const seen = document.createElement("span");
  seen.className = "viewer-coverage";
  seen.textContent = viewer.coverage === null ? "—" : `${Math.round(viewer.coverage * 100)}%`;
  seen.title = "Best single viewing";

  const when = document.createElement("span");
  when.className = "viewer-when muted";
  when.textContent = localTime(viewer.lastWatched);

  row.append(who, plays, attention, seen, when);
  return row;
}

// --- Small helpers -----------------------------------------------------------

/**
 * The payloads behind one viewer row, for its own `relativeHeat` denominator.
 *
 * `ViewerReport` carries the summed heat but not the sessions it came from, and
 * the "× against one pass" number needs their durations. For a well-formed
 * `browserId` this filter is exactly the group `groupByViewer` built. For a
 * malformed one — which only junk written through the unauthenticated endpoint
 * can produce — `groupByViewer` splits each session into its own row while this
 * returns all of them, so such rows share one intensity. The height channel
 * still comes from `ViewerReport.heat`, so the row's own shape is never wrong.
 */
function payloadsOf(sessions: readonly WatchSession[], browserId: string): WatchPayload[] {
  return sessions
    .filter((session) => session.payload.browserId === browserId)
    .map((session) => session.payload);
}

/**
 * How a `browserId` is written anywhere on the page: `VIEWER_PREFIX` characters
 * and an ellipsis (SPEC §16.6).
 *
 * The one form, deliberately — the visible text and the heatmap's `aria-label`
 * alike, and no `title` holding the untruncated id behind either. Truncating
 * what the eye sees while a tooltip or a screen reader hands back all 22
 * characters is truncation in name only: the full id still lands in a screenshot
 * of a hovered row, and the reader who needs it has none to do with it — a
 * viewer is a browser, not a person, and there is nothing on the other end of
 * the id to look up (§16.8). 8 base64url characters are 48 bits, which tells
 * these rows apart at any scale a video page is readable at.
 */
function shortId(browserId: string): string {
  return `${browserId.slice(0, VIEWER_PREFIX)}…`;
}

function count(n: number, noun: string): string {
  return `${n} ${n === 1 ? noun : `${noun}s`}`;
}

function note(text: string): HTMLElement {
  const line = document.createElement("p");
  line.className = "analytics-note muted hint";
  line.textContent = text;
  return line;
}

function localTime(iso: string): string {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? "unknown" : new Date(at).toLocaleString();
}
