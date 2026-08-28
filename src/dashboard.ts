/**
 * The analytics expander on each library row (docs/SPEC.md §16.6).
 *
 * There is no stats page. Watch data belongs next to the video it is about, and
 * the recorder already lists every video this browser made (§9), so this is what
 * `record.ts` hangs on a library row when the gateway says `analytics: true` and
 * someone is signed in.
 *
 * The shape of the thing, and why it is a module of its own rather than more of
 * `record.ts`: the gateway can list a video's analytics objects and hand back
 * presigned URLs, but it cannot read one — every object is AES-GCM ciphertext
 * under the video's own key. So this fetches the listing (authenticated), then
 * the ciphertext **straight from the bucket** (never through the gateway —
 * §15's no-proxy rule), and decrypts, parses and aggregates all of it here.
 *
 * Which is also the limit of it: **the key never leaves the page.** Only the
 * 22-character video id appears in a request. The entry's share link is parsed
 * in memory and never written to `location`, to `history`, or into a form.
 *
 * Nothing here is the page's business. Every failure renders as one quiet muted
 * sentence inside the expander it was asked from: this is a panel about a video,
 * and it must never interrupt a recording or an upload.
 */

import { analyticsAad, decryptBlock, importKeyB64 } from "./crypto";
import type { LibraryEntry } from "./types";
import { parseShareFragment } from "./util";
import {
  groupByViewer,
  normalizeHeat,
  parsePayload,
  relativeHeat,
  sumHeat,
  type ViewerReport,
  type WatchPayload,
  type WatchSession,
} from "./watch";

/** What the expander needs from the page it lives on. */
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

/** Characters of a browserId shown in a viewer row, then an ellipsis. */
export const VIEWER_PREFIX = 8;

/** What was made of one video's sessions, once every object had its turn. */
interface Report {
  sessions: WatchSession[];
  /** Objects that would not decrypt or would not parse — shown, never hidden. */
  unreadable: number;
  /** The gateway's listing hit its cap; there are more sessions than these. */
  truncated: boolean;
}

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
 * Results per video id, for the page's lifetime (SPEC §16.6). Collapsing and
 * re-expanding re-renders what was fetched, and re-rendering the library — which
 * happens on every sign-in and every Remove — does not refetch. A load that
 * *failed* is never cached: reopening retries it, because the usual cause is a
 * token that has since been refreshed.
 */
const cache = new Map<string, Report>();

// --- The two things `record.ts` asks for -------------------------------------

/**
 * The collapsed `<details>` for one entry — analytics on, signed in.
 *
 * Nothing is fetched until it is opened, so a library of forty videos still
 * costs the one `/config` request the recorder already makes.
 */
export function analyticsExpander(entry: LibraryEntry, deps: AnalyticsDeps): HTMLElement {
  const details = document.createElement("details");
  details.className = "analytics";

  const summary = document.createElement("summary");
  summary.textContent = "Analytics";

  const body = document.createElement("div");
  body.className = "analytics-body";

  details.append(summary, body);

  let loading = false;

  /** The one affordance for "someone watched it since I opened this". */
  const reload = (): HTMLElement => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "link-button";
    button.textContent = "Reload";
    button.addEventListener("click", () => load(true));
    return button;
  };

  const load = (refetch: boolean): void => {
    if (loading) return;

    const video = shareLink(entry);
    if (!video) {
      body.replaceChildren(
        note("This entry's share link has no video key, so its analytics can't be read."),
      );
      return;
    }

    const cached = refetch ? undefined : cache.get(video.id);
    if (cached) {
      body.replaceChildren(...report(cached, reload));
      return;
    }

    loading = true;
    body.replaceChildren(note("Loading…"));
    void readVideo(video, deps)
      .then((fresh) => {
        cache.set(video.id, fresh);
        body.replaceChildren(...report(fresh, reload));
      })
      .catch((err: unknown) => {
        // Not cached: the next open tries again.
        cache.delete(video.id);
        if (!(err instanceof AnalyticsError)) console.error("[videoshare]", err);
        body.replaceChildren(note(describe(err)), reload());
      })
      .finally(() => {
        loading = false;
      });
  };

  details.addEventListener("toggle", () => {
    if (details.open) load(false);
  });
  return details;
}

/** The one-line "Sign in to see analytics." row — analytics on, signed out. */
export function analyticsHint(): HTMLElement {
  const hint = document.createElement("p");
  hint.className = "analytics-hint muted hint";
  // Not a <details>: the operator turned analytics on and the data exists, so a
  // blank row would read as "this video has none" — but there is nothing to open
  // until there is a token to list with (SPEC §16.6).
  hint.textContent = "Sign in to see analytics.";
  return hint;
}

// --- Reading one video's sessions --------------------------------------------

/** `{ id, keyB64 }` from the entry's stored share link, or null. */
function shareLink(entry: LibraryEntry): { id: string; keyB64: string } | null {
  const link = entry.link || "";
  const hash = link.indexOf("#");
  return parseShareFragment(hash === -1 ? link.trim() : link.slice(hash + 1).trim());
}

async function readVideo(
  video: { id: string; keyB64: string },
  deps: AnalyticsDeps,
): Promise<Report> {
  let key: CryptoKey;
  try {
    key = await importKeyB64(video.keyB64);
  } catch {
    throw new AnalyticsError("The key in this entry's share link is not a valid AES-256 key.");
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
 * `GET {gatewayUrl}/beacon/{id}` (SPEC §16.3) — the only request this module
 * makes to the gateway, and it carries the video id and nothing else.
 */
async function listSessions(deps: AnalyticsDeps, id: string): Promise<SessionListing> {
  const token = deps.token();
  // The sign-in control is a few centimetres up the same page, so this says so
  // plainly rather than silently re-prompting (SPEC §16.6).
  if (!token) throw new AnalyticsError("Sign in again to load analytics.");

  let res: Response;
  try {
    res = await fetch(`${deps.gatewayUrl}/beacon/${id}`, {
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

// --- Rendering ---------------------------------------------------------------

/** The whole expander body for a loaded report. */
function report(loaded: Report, reload: () => HTMLElement): HTMLElement[] {
  const payloads = loaded.sessions.map((session) => session.payload);
  const nodes: HTMLElement[] = [];

  if (loaded.sessions.length === 0) {
    nodes.push(
      note(
        loaded.unreadable > 0
          ? `${count(loaded.unreadable, "session")} could not be read: written under a different key, or not watch data at all.`
          : "No views yet.",
      ),
      reload(),
    );
    return nodes;
  }

  const header = document.createElement("p");
  header.className = "analytics-summary";
  header.append(
    stat(loaded.sessions.length, "view"),
    document.createTextNode(" · "),
    stat(groupByViewer(loaded.sessions).length, "viewer"),
    document.createTextNode(" · "),
    stat(payloads.filter((payload) => payload.completed).length, "completion"),
  );
  nodes.push(header);

  const asides: string[] = [];
  if (loaded.unreadable > 0) asides.push(`${count(loaded.unreadable, "session")} could not be read.`);
  if (loaded.truncated) asides.push("The gateway's listing hit its cap, so these are not all of them.");
  if (asides.length > 0) nodes.push(note(asides.join(" ")));

  nodes.push(heatmap(sumHeat(payloads), relativeHeat(payloads), "Replays across the video"));

  const axis = document.createElement("div");
  axis.className = "heat-axis muted";
  const start = document.createElement("span");
  start.textContent = "Start";
  const end = document.createElement("span");
  end.textContent = "End";
  axis.append(start, end);
  nodes.push(axis);

  const viewers = document.createElement("div");
  viewers.className = "viewers";
  for (const viewer of groupByViewer(loaded.sessions)) {
    viewers.append(viewerRow(viewer, payloadsOf(loaded.sessions, viewer.browserId)));
  }
  nodes.push(viewers, reload());

  return nodes;
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

function viewerRow(viewer: ViewerReport, payloads: readonly WatchPayload[]): HTMLElement {
  const row = document.createElement("div");
  row.className = "viewer-row";

  const who = document.createElement("span");
  who.className = "viewer-id";
  // A viewer is a browser, not a person, and this is all there is to say about
  // one: no name, no account, no IP, because none was ever read (§16.8).
  who.textContent = shortId(viewer.browserId);

  const plays = document.createElement("span");
  plays.className = "viewer-plays muted";
  plays.textContent = count(viewer.plays, "play");

  const seen = document.createElement("span");
  seen.className = "viewer-coverage";
  seen.textContent = viewer.coverage === null ? "—" : `${Math.round(viewer.coverage * 100)}%`;
  seen.title = "Best single viewing";

  const when = document.createElement("span");
  when.className = "viewer-when muted";
  when.textContent = localTime(viewer.lastWatched);

  row.append(
    who,
    plays,
    heatmap(viewer.heat, relativeHeat(payloads), `Replays by viewer ${shortId(viewer.browserId)}`),
    seen,
    when,
  );
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
 * these rows apart at any scale a library page is readable at.
 */
function shortId(browserId: string): string {
  return `${browserId.slice(0, VIEWER_PREFIX)}…`;
}

/** "3 views", "1 view" — a `<strong>` count and its noun. */
function stat(n: number, noun: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const value = document.createElement("strong");
  value.textContent = String(n);
  fragment.append(value, document.createTextNode(` ${plural(n, noun)}`));
  return fragment;
}

function count(n: number, noun: string): string {
  return `${n} ${plural(n, noun)}`;
}

function plural(n: number, noun: string): string {
  return n === 1 ? noun : `${noun}s`;
}

function note(text: string): HTMLElement {
  const line = document.createElement("p");
  line.className = "muted hint";
  line.textContent = text;
  return line;
}

function localTime(iso: string): string {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? "unknown" : new Date(at).toLocaleString();
}

function describe(err: unknown): string {
  if (err instanceof AnalyticsError) return err.message;
  return "Could not load analytics for this video.";
}
