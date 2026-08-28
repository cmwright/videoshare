/**
 * Playback analytics storage (SPEC §16.3, §16.4): the beacon write and the
 * authenticated session listing.
 *
 * This is the only module in the gateway that speaks to a bucket over the wire,
 * and §16.3 draws the line it may not cross: **one direction, opaque bytes**. A
 * beacon body is at most `MAX_BEACON_BYTES` of ciphertext that gets PUT and is
 * never read back; the listing hands out presigned GETs so the *browser* fetches
 * that ciphertext straight from the bucket. No stored byte is ever read into
 * this process, so §15's no-proxy invariant survives whole.
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

export interface AnalyticsStore {
  put(videoId: string, sessionId: string, body: Uint8Array): Promise<void>;
  list(videoId: string): Promise<SessionListing>;
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
  };
}

// --- Requests ----------------------------------------------------------------

async function send(
  client: AwsClient,
  method: "GET" | "PUT",
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
