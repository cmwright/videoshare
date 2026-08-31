/**
 * Playback analytics storage (SPEC §16.3, §16.4, §18.4): the beacon write, the
 * authenticated session listing, and the bounded deletion of one video's
 * sessions.
 *
 * This is the only module in the gateway that speaks to a bucket over the wire,
 * and §16.3 draws the line it may not cross: **one direction, opaque bytes**. A
 * beacon body is at most `MAX_BEACON_BYTES` of ciphertext that gets PUT and is
 * never read back; the listing hands out presigned GETs so the *browser* fetches
 * that ciphertext straight from the bucket. No stored byte is ever read into
 * this process, so §15's no-proxy invariant survives whole. §18.4's deletion is
 * the one place the gateway removes a stored object itself, and it does not
 * cross that line either: a DELETE moves no bytes out, and the objects under a
 * prefix are not enumerable from a presigned URL, so the enumeration has to
 * happen where the credential and the listing already live.
 *
 * Nothing here sees a viewer. The two ids in an object key are random labels the
 * browser minted, the payload they name is encrypted under a key this gateway
 * has never held, and no IP-bearing header is read on any analytics path.
 */

import { AwsClient } from "aws4fetch";
import type { BucketConfig } from "./presign.ts";
import { ID_PATTERN, bucketUrl, createQuerySigner, encodeQueryValue, objectUrl } from "./presign.ts";

/** SPEC §16.3: a whole session's cumulative state, and a hard ceiling on it. */
export const MAX_BEACON_BYTES = 16 * 1024;
/** SPEC §16.3: how many sessions one listing will follow pagination for. */
export const MAX_LISTED_SESSIONS = 1000;

/**
 * SPEC §18.4: how many session objects one `DELETE /sessions/{videoId}` call
 * removes, and how many listing pages it will walk to find them.
 *
 * The numbers are a real constraint rather than a taste. One call costs at most
 * `MAX_DELETE_LIST_PAGES` listings plus `MAX_DELETED_SESSIONS` deletes — 44
 * outbound requests, chosen for the **Cloudflare Workers free plan's 50
 * subrequests per request**. A pass bounded at `MAX_LISTED_SESSIONS` instead
 * would fail on the free plan outright and sit exactly on the paid plan's
 * ceiling. Lambda and the Node adapter have no such limit; the bound applies to
 * all three anyway, so every adapter behaves identically and a deployment does
 * not discover its own ceiling by deleting something.
 *
 * A caller that has more than this to remove repeats the call while `truncated`
 * (§18.4), which is why the cap costs correctness nothing.
 */
export const MAX_DELETED_SESSIONS = 40;
export const MAX_DELETE_LIST_PAGES = 4;

/** Every analytics object is `{videoId}/{sessionId}.bin`. */
const KEY_SUFFIX = ".bin";
/** ListObjectsV2 page size. S3 and R2 both cap at 1000, which is also our total. */
const LIST_PAGE_SIZE = 1000;

export interface SessionSummary {
  sessionId: string;
  /** ISO 8601 UTC, from the storage layer — the last flush the bucket accepted. */
  lastModified: string;
  /** Ciphertext bytes. */
  size: number;
  /** Short-lived presigned GET; the browser dereferences it, never the gateway. */
  url: string;
}

export interface SessionListing {
  sessions: SessionSummary[];
  /** True when there was more than `MAX_LISTED_SESSIONS` to list (SPEC §16.3). */
  truncated: boolean;
}

export interface DeleteResult {
  /** Session objects removed by this pass. */
  deleted: number;
  /**
   * The pass stopped early and there may be more (SPEC §18.4): call again.
   * `false` means the prefix holds no sessions any more.
   */
  truncated: boolean;
}

export interface AnalyticsStore {
  put(videoId: string, sessionId: string, body: Uint8Array): Promise<void>;
  list(videoId: string): Promise<SessionListing>;
  /** One bounded pass of SPEC §18.4; `truncated` means "call me again". */
  deleteAll(videoId: string): Promise<DeleteResult>;
}

/**
 * The bucket refused, or never answered. `status` is the storage layer's HTTP
 * status, or `0` when the request failed before one existed — the caller logs
 * that number and nothing else (SPEC §16.4).
 */
export class AnalyticsStoreError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The one key shape this module will construct, from two validated ids. */
export function analyticsKey(videoId: string, sessionId: string): string {
  return `${videoId}/${sessionId}${KEY_SUFFIX}`;
}

export function createAnalyticsStore(config: BucketConfig): AnalyticsStore {
  // `retries: 0` on purpose. aws4fetch's default is ten attempts with
  // exponential backoff, which on a 5xx would hold a Worker request open for
  // the better part of a minute — for a beacon whose next flush carries the
  // same cumulative state 30 seconds later anyway (SPEC §16.4), and for a
  // listing an operator can simply reload. One attempt, then an honest 502.
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: config.region,
    service: "s3",
    retries: 0,
  });
  const presign = createQuerySigner(config);

  return {
    async put(videoId: string, sessionId: string, body: Uint8Array): Promise<void> {
      // Defence in depth: core validated both ids out of the path, but this
      // module has to be safe on its own terms too — it is the thing that turns
      // them into an object key.
      assertId(videoId, "video id");
      assertId(sessionId, "session id");

      const url = objectUrl(config, analyticsKey(videoId, sessionId));
      const response = await send(client, "PUT", url, body);
      // The answer holds nothing this gateway wants. Drain and drop it, so a
      // kept-alive connection is reusable and nothing is buffered.
      await discard(response);
      if (!response.ok) {
        throw new AnalyticsStoreError(response.status, "the analytics bucket refused the write");
      }
    },

    async list(videoId: string): Promise<SessionListing> {
      assertId(videoId, "video id");

      const prefix = `${videoId}/`;
      const found: { sessionId: string; key: string; lastModified: string; size: number }[] = [];
      let token: string | null = null;
      let truncated = false;

      for (;;) {
        const page = parseListing(await fetchPage(client, config, prefix, token));
        for (const entry of page.entries) {
          const sessionId = sessionIdOf(entry.key, prefix);
          // SPEC §16.3: nothing else belongs under this prefix, and if something
          // is there it is not a session.
          if (sessionId === null) continue;
          if (found.length >= MAX_LISTED_SESSIONS) {
            truncated = true;
            break;
          }
          found.push({ sessionId, key: entry.key, lastModified: entry.lastModified, size: entry.size });
        }
        if (truncated) break;
        if (!page.isTruncated || page.nextToken === null) {
          // A store that says "truncated" without handing back a token has
          // nothing more we can ask it for. Say so rather than imply the list
          // is complete.
          truncated = page.isTruncated;
          break;
        }
        token = page.nextToken;
      }

      const sessions = await Promise.all(
        found.map(async (entry) => ({
          sessionId: entry.sessionId,
          lastModified: entry.lastModified,
          size: entry.size,
          url: await presign("GET", objectUrl(config, entry.key)),
        })),
      );
      return { sessions, truncated };
    },

    /**
     * SPEC §18.4. One bounded pass: walk at most `MAX_DELETE_LIST_PAGES` listing
     * pages collecting at most `MAX_DELETED_SESSIONS` keys that look like
     * sessions, then issue one DELETE per key.
     *
     * The skip rule is §16.3's, unchanged: nothing but `{videoId}/{22
     * base64url}.bin` belongs under this prefix, and anything else there is not
     * a session and is not this gateway's to remove. That is also the one way a
     * caller's retry loop could fail to make progress — a prefix full of objects
     * the skip rule refuses to touch answers `truncated: true` with `deleted:
     * 0` forever — which is why §18.4's client loop treats exactly that shape as
     * stalled rather than as a reason to call again.
     */
    async deleteAll(videoId: string): Promise<DeleteResult> {
      assertId(videoId, "video id");

      const prefix = `${videoId}/`;
      const keys: string[] = [];
      let token: string | null = null;
      let capped = false;
      let more = true;

      for (let page = 0; page < MAX_DELETE_LIST_PAGES; page++) {
        const listing = parseListing(await fetchPage(client, config, prefix, token));
        for (const entry of listing.entries) {
          if (sessionIdOf(entry.key, prefix) === null) continue;
          if (keys.length >= MAX_DELETED_SESSIONS) {
            capped = true;
            break;
          }
          keys.push(entry.key);
        }
        if (capped) break;
        if (!listing.isTruncated) {
          // The listing ran out: everything under the prefix has been seen, so
          // once these keys are gone the prefix is empty of sessions. Note that
          // filling the cap *exactly* on a complete listing lands here and
          // answers `truncated: false` — which is the honest answer, and saves
          // the caller a round trip that would find nothing.
          more = false;
          break;
        }
        if (listing.nextToken === null) {
          // A store that claims more without handing back a token has nothing
          // this call can ask it for — the shape `list` above also refuses to
          // paper over. Stopping with `truncated: true` says "call me again",
          // which is both true and progress: the next call re-lists from the
          // start, over a prefix this one has already shortened.
          break;
        }
        token = listing.nextToken;
      }

      // Deleted one at a time, and a failure stops the rest. The caller's next
      // call re-lists and picks up whatever survived, so there is no state to
      // reconcile — and stopping keeps a bucket that has started refusing from
      // being hit another 39 times to learn the same thing.
      for (const key of keys) {
        const response = await send(client, "DELETE", objectUrl(config, key));
        await discard(response);
        // 404 is success: DeleteObject is idempotent, and a key that was listed
        // and is already gone is exactly the outcome asked for (SPEC §18.1).
        if (!response.ok && response.status !== 404) {
          throw new AnalyticsStoreError(response.status, "the analytics bucket refused the delete");
        }
      }

      return { deleted: keys.length, truncated: capped || more };
    },
  };
}

// --- Requests ----------------------------------------------------------------

async function send(
  client: AwsClient,
  method: "GET" | "PUT" | "DELETE",
  url: string,
  body?: Uint8Array,
): Promise<Response> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    // `BodyInit` wants an ArrayBuffer-backed view; the caller's bounded read
    // already produced one.
    init.body = body as BodyInit;
    // The bytes are opaque to everyone in this path, and labelled as such.
    init.headers = { "content-type": "application/octet-stream" };
  }
  try {
    return await client.fetch(url, init);
  } catch (err) {
    throw new AnalyticsStoreError(0, `the analytics bucket could not be reached: ${describe(err)}`);
  }
}

async function fetchPage(
  client: AwsClient,
  config: BucketConfig,
  prefix: string,
  token: string | null,
): Promise<string> {
  // Query values go through the same RFC 3986 encoder aws4fetch canonicalizes
  // with, so what is signed is what is sent — the continuation token is opaque
  // base64 and must survive verbatim.
  const query = [
    "list-type=2",
    `prefix=${encodeQueryValue(prefix)}`,
    `max-keys=${LIST_PAGE_SIZE}`,
    ...(token === null ? [] : [`continuation-token=${encodeQueryValue(token)}`]),
  ];
  const response = await send(client, "GET", `${bucketUrl(config)}?${query.join("&")}`);
  const xml = await response.text().catch(() => "");
  if (!response.ok) {
    throw new AnalyticsStoreError(response.status, "the analytics bucket refused the listing");
  }
  return xml;
}

/** Reads a response body to completion and throws it away, errors included. */
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A body that cannot be cancelled is already gone; nothing to do.
  }
}

// --- ListObjectsV2 -----------------------------------------------------------

interface ListingEntry {
  key: string;
  lastModified: string;
  size: number;
}

interface ListingPage {
  entries: ListingEntry[];
  isTruncated: boolean;
  nextToken: string | null;
}

/**
 * ListObjectsV2 answers XML and the gateway has no XML parser — nor may it grow
 * a dependency for one (SPEC §16.4). It does not need one: the three fields read
 * here are flat text nodes, and every value that survives is re-validated
 * afterwards (`sessionIdOf` on the key, `Date.parse` on the timestamp, an
 * integer check on the size), so a malformed document yields fewer sessions and
 * never a malformed one.
 */
function parseListing(xml: string): ListingPage {
  const entries: ListingEntry[] = [];
  for (const [, contents] of xml.matchAll(/<Contents\b[^>]*>([\s\S]*?)<\/Contents>/g)) {
    const key = tagValue(contents ?? "", "Key");
    if (key === null) continue;
    entries.push({
      key,
      lastModified: normalizeTimestamp(tagValue(contents ?? "", "LastModified")),
      size: normalizeSize(tagValue(contents ?? "", "Size")),
    });
  }
  return {
    entries,
    isTruncated: tagValue(xml, "IsTruncated")?.trim().toLowerCase() === "true",
    nextToken: tagValue(xml, "NextContinuationToken"),
  };
}

function tagValue(source: string, tag: string): string | null {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`).exec(source);
  return match?.[1] === undefined ? null : decodeXml(match[1]);
}

/** The five predefined XML entities. Nothing here ever emits a numeric reference. */
function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** `{videoId}/{22 base64url}.bin`, or null for anything else under the prefix. */
function sessionIdOf(key: string, prefix: string): string | null {
  if (!key.startsWith(prefix) || !key.endsWith(KEY_SUFFIX)) return null;
  const sessionId = key.slice(prefix.length, key.length - KEY_SUFFIX.length);
  return ID_PATTERN.test(sessionId) ? sessionId : null;
}

/** S3 already answers ISO 8601 UTC; re-stating it pins the shape the client parses. */
function normalizeTimestamp(raw: string | null): string {
  if (raw === null) return "";
  const ms = Date.parse(raw.trim());
  return Number.isFinite(ms) ? new Date(ms).toISOString() : raw.trim();
}

function normalizeSize(raw: string | null): number {
  const size = Number((raw ?? "").trim());
  return Number.isInteger(size) && size >= 0 ? size : 0;
}

// --- Guards ------------------------------------------------------------------

function assertId(value: string, what: string): void {
  if (!ID_PATTERN.test(value)) {
    throw new Error(`Refusing to touch analytics storage: malformed ${what}.`);
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
