/**
 * Streaming upload of one video (docs/SPEC.md §7, §15.5) — and its deletion
 * (§18.3), which lives here because the `Signer` seam does.
 *
 * `{id}/video.bin` is an S3 multipart upload that runs *alongside* the
 * recording: encrypted chunk i (§4) is uploaded as part number i+1, so the
 * completed object is byte-identical to the plain concatenation of blocks the
 * player expects. `{id}/meta.json` stays a single PUT and goes last — a video
 * is complete iff its meta exists. §3's optional `{id}/thumb.bin` slots in
 * between the two: after the video exists, before it is marked complete, and
 * unable to fail the finish either way.
 *
 * Who authorizes those requests is the one thing that varies: a `Signer` turns
 * an operation into a ready-to-send URL + headers. `LocalSigner` signs with
 * aws4fetch from credentials in this browser (legacy mode); `GatewaySigner`
 * asks the gateway for presigned URLs and never sees a credential (§15). Both
 * end in the same `fetch`, so the session logic below does not know which it has.
 *
 * Everything here is plain `fetch`, so the whole path runs unchanged in Node
 * for the e2e tests.
 */

import { AwsClient } from "aws4fetch";
import { chunkAad, encryptBlock, exportKeyB64, metaAad } from "./crypto";
import type { Settings, VideoMeta } from "./types";
// SPEC §11: the link format lives in util.ts, where the video page can reach it
// without pulling this module's signing machinery in behind it.
import { shareLink } from "./util";

export interface UploadResult {
  id: string;
  link: string;
}

/**
 * §3's three objects, by the suffix the seam and the gateway's answer both use.
 * A name, never a key: the signer builds `{id}/{object}` itself (SPEC §18.3).
 */
export type VideoObjectName = "video.bin" | "meta.json" | "thumb.bin";

/**
 * §18.1's deletion order, which is §7's write order exactly reversed.
 *
 * `meta.json` first because it is the completion marker: a player fetches it
 * before anything else (§8), so from the instant it is gone every copy of the
 * share link is already the clean "video not found" of §18.5. A delete that
 * fails halfway therefore leaves a video that reads as *absent*, never as a
 * torso that still looks complete and then fails deeper in.
 */
export const DELETE_ORDER: readonly VideoObjectName[] = ["meta.json", "thumb.bin", "video.bin"];

/** One video's in-flight multipart upload. Created at record start, finished at Finish. */
export interface UploadSession {
  /**
   * Encrypts one full plaintext chunk and sends it as the next part. Parts are
   * uploaded sequentially — this resolves once the part's attempts are done.
   * A part that never lands does not reject: it is remembered and re-sent by
   * `finish()`, so recording is never interrupted by a bad network moment.
   */
  addChunk(plain: Uint8Array): Promise<void>;
  /**
   * Flushes the final (possibly short) chunk, re-sends any parts that failed
   * earlier, completes the multipart upload, PUTs `thumb.bin` when there is one,
   * then PUTs `meta.json`. Safe to call again after a failure: the final chunk
   * is only ever added once.
   *
   * `thumb` is SPEC §3's **already-encrypted** block, or null for no thumbnail.
   */
  finish(
    finalPlain: Uint8Array | null,
    meta: VideoMeta,
    thumb?: Uint8Array | null,
  ): Promise<UploadResult>;
  /** Best-effort `AbortMultipartUpload`; never throws. */
  abort(): Promise<void>;
  /** Ciphertext bytes confirmed uploaded so far. */
  readonly uploadedBytes: number;
}

const CONTENT_TYPE = "application/octet-stream";
const XML_CONTENT_TYPE = "application/xml";
const DOCS = "docs/storage-setup.md";
const GATEWAY_DOCS = "docs/gateway-setup.md";

/** Backoff before retry 1, 2 and 3 of a part (SPEC §7); an attempt with no delay comes first. */
const RETRY_DELAYS_MS = [1000, 2000, 4000];

const EMPTY = new Uint8Array(0);

// --- The signing seam (SPEC §15.5) -------------------------------------------

/**
 * One S3 operation the session needs authorized. Object keys never cross this
 * seam: a signer derives them from `id` as exactly `{id}/video.bin`,
 * `{id}/meta.json` and `{id}/thumb.bin`, so no part of the session can aim a
 * write at another key. The `kind` values are the gateway's wire vocabulary
 * (SPEC §15.3).
 */
export type SignOp =
  | { kind: "create"; id: string }
  | { kind: "part"; id: string; uploadId: string; partNumber: number }
  | { kind: "complete"; id: string; uploadId: string }
  | { kind: "abort"; id: string; uploadId: string }
  | { kind: "put-meta"; id: string }
  | { kind: "put-thumb"; id: string }
  // §18.3. `object` is a closed union of three suffixes, not a key: the signer
  // still builds `{id}/{object}`, so the rule above holds for deletes too.
  | { kind: "delete"; id: string; object: VideoObjectName };

/** What the session is about to send — a signer that signs payloads needs the bytes. */
export interface SignRequest {
  op: SignOp;
  /** Exact bytes that will be sent; absent for a bodyless request. */
  body?: Uint8Array;
  /** `Content-Type` to send, if any. */
  contentType?: string;
}

/** A request ready for `fetch`: absolute URL plus the headers carrying its authorization. */
export interface SignedRequest {
  url: string;
  headers: Headers;
}

/** Authorizes the session's storage requests. See `createLocalSigner` / `createGatewaySigner`. */
export interface Signer {
  /** Which of the two modes this is — the UI and the tests care, the session does not. */
  readonly kind: "local" | "gateway";
  /** Where the bytes are going, for error messages. */
  readonly storageLabel: string;
  /** URL + headers for one operation. Called per attempt, so a retry is re-signed. */
  sign(req: SignRequest): Promise<SignedRequest>;
  /** An authorization that just failed must not be reused: drop anything cached for `op`. */
  forget(op: SignOp): void;
  /**
   * Advice appended to an HTTP failure message. `kind` is the op that failed,
   * which the method alone cannot stand in for: the seam sends `DELETE` for two
   * different intents — the one that abandons a multipart upload and the three
   * that remove stored objects (§18.3) — and they are refused for two different
   * missing grants. Omitting it means "an object delete", the case §18.3's
   * optional-IAM contract is written about.
   */
  statusHint(status: number, method: HttpMethod, kind?: SignOp["kind"]): string;
  /** The whole message for a request that never reached an HTTP status. */
  networkMessage(what: string, method: HttpMethod): string;
}

/** Every method the session ever sends; GETs are the player's job, not this file's. */
export type HttpMethod = "PUT" | "POST" | "DELETE";

const METHODS: Record<SignOp["kind"], HttpMethod> = {
  create: "POST",
  part: "PUT",
  complete: "POST",
  abort: "DELETE",
  "put-meta": "PUT",
  "put-thumb": "PUT",
  delete: "DELETE",
};

// --- LocalSigner: credentials in this browser (SPEC §7) ----------------------

/**
 * Signs every request with aws4fetch from the settings panel's credentials —
 * the original, credential-in-the-browser mode. Throws if settings are
 * incomplete, so a bad configuration surfaces before any recording starts.
 */
export function createLocalSigner(settings: Settings): Signer {
  requireConfigured(settings);
  return new LocalSigner(settings);
}

class LocalSigner implements Signer {
  readonly kind = "local" as const;
  private readonly client: AwsClient;

  constructor(private readonly settings: Settings) {
    this.client = new AwsClient({
      accessKeyId: settings.accessKeyId,
      secretAccessKey: settings.secretAccessKey,
      region: settings.region || "us-east-1",
      service: "s3",
    });
  }

  get storageLabel(): string {
    return this.settings.endpoint;
  }

  async sign(req: SignRequest): Promise<SignedRequest> {
    // lib.dom's BodyInit accepts only ArrayBuffer-backed views; nothing here is
    // ever backed by a SharedArrayBuffer.
    const body = (req.body ?? EMPTY) as Uint8Array<ArrayBuffer>;

    const headers: Record<string, string> = {
      // Signing the real payload hash (rather than aws4fetch's default
      // UNSIGNED-PAYLOAD) keeps the body out of the signed Request, so the body is
      // never copied into a second buffer just to be signed.
      "x-amz-content-sha256": await sha256Hex(body),
    };
    if (req.contentType) headers["content-type"] = req.contentType;

    const signed = await this.client.sign(localUrl(this.settings, req.op), {
      method: METHODS[req.op.kind],
      headers,
    });
    return { url: signed.url, headers: signed.headers };
  }

  forget(): void {
    // Nothing is cached: each attempt is signed as it is sent.
  }

  statusHint(status: number, method: HttpMethod, kind?: SignOp["kind"]): string {
    const settings = this.settings;
    // §18.3's optional-IAM contract: a deployment whose upload credentials lack
    // s3:DeleteObject is *supported*, and its one failure has to read like a
    // configuration choice rather than a bug.
    //
    // Discard's AbortMultipartUpload is a DELETE too, and it is refused for the
    // *other* missing grant — which is why the op, not just the method, decides.
    // `docs/storage-setup.md` tells an operator that a 403 on Discard means
    // s3:AbortMultipartUpload; an abort therefore falls through to the general
    // 403 below, which names that grant, rather than sending them to add an
    // s3:DeleteObject that would change nothing.
    if (status === 403 && method === "DELETE" && kind !== "abort") {
      return (
        `The bucket refused the delete. These upload credentials may not be allowed to delete a ` +
        `stored object: s3:DeleteObject is optional (it is the second statement of ` +
        `examples/iam-uploader-policy.json), and without it everything else still works and ` +
        `Delete video fails exactly here. See ${DOCS}.`
      );
    }
    if (status === 403) {
      return (
        `The credentials were rejected or may not write here. Check accessKeyId/secretAccessKey, ` +
        `that the key is allowed to PutObject and AbortMultipartUpload in "${settings.bucket}", and ` +
        `that the clock on this machine is correct. See ${DOCS}.`
      );
    }
    if (status === 404) {
      return (
        `Bucket "${settings.bucket}" was not found at ${settings.endpoint}, or the multipart upload ` +
        `expired. VideoShare uses path-style URLs ({endpoint}/{bucket}/{key}) — check both values. See ${DOCS}.`
      );
    }
    if (status === 301 || status === 307) {
      return `The bucket is not in region "${settings.region}". Fix the region in Settings. See ${DOCS}.`;
    }
    if (status === 400) {
      return (
        `The request was rejected — usually a wrong region ("${settings.region}") or an endpoint that ` +
        `expects virtual-host style URLs. See ${DOCS}.`
      );
    }
    if (status === 405 || status === 501) {
      return (
        `${settings.endpoint} did not accept a ${method}; it may not be an S3-compatible endpoint, or ` +
        `it may not support multipart uploads. See ${DOCS}.`
      );
    }
    if (status >= 500) {
      return "The storage server failed. Wait a moment and try again.";
    }
    return `See ${DOCS} for storage setup.`;
  }

  networkMessage(what: string, method: HttpMethod): string {
    return (
      `Could not reach ${this.settings.endpoint} to ${verbFor(method)} ${what}: the request failed ` +
      `before any HTTP status. That is almost always CORS (the bucket must allow ${method} from ` +
      `${originLabel()}, allow the authorization/x-amz-* headers, and expose the ETag header) or an ` +
      `unreachable endpoint. See examples/s3-cors.json and ${DOCS}.`
    );
  }
}

/** Path-style URL: works for MinIO, R2 and S3 alike. */
function localUrl(settings: Settings, op: SignOp): string {
  const base = `${settings.endpoint.replace(/\/+$/, "")}/${settings.bucket}`;
  if (op.kind === "put-meta") return `${base}/${op.id}/meta.json`;
  // The same direct SigV4 PUT meta.json gets, against a different key (SPEC §15.5).
  if (op.kind === "put-thumb") return `${base}/${op.id}/thumb.bin`;
  // The same path again, a different method (SPEC §18.3).
  if (op.kind === "delete") return `${base}/${op.id}/${op.object}`;

  const video = `${base}/${op.id}/video.bin`;
  if (op.kind === "create") return `${video}?uploads`;

  const upload = `uploadId=${encodeQueryValue(op.uploadId)}`;
  return op.kind === "part" ? `${video}?partNumber=${op.partNumber}&${upload}` : `${video}?${upload}`;
}

/**
 * RFC 3986 percent-encoding, matching aws4fetch's canonical query exactly.
 * `encodeURIComponent` leaves `!'()*` alone but aws4fetch escapes them, so an
 * uploadId containing one would be signed differently from how it is sent — a
 * 403 that only some S3 implementations would ever produce.
 */
function encodeQueryValue(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

// --- GatewaySigner: presigned URLs, no credentials here (SPEC §15) -----------

/** How `GatewaySigner` reaches the gateway and the signed-in user's token. */
export interface GatewaySignerOptions {
  /** Gateway base URL from config.js: absolute, or same-origin relative like "/api". */
  gatewayUrl: string;
  /** The in-memory Google ID token, or null when there is none (or it is about to expire). */
  getToken(): string | null;
  /** Silent re-auth; resolves to a fresh token, or null when the user has to act. */
  refreshToken(): Promise<string | null>;
}

/** Part URLs are signed this many ahead, so the sequential part queue never waits on the gateway. */
const PART_BATCH = 8;
/** S3's ceiling on part numbers — never ask the gateway to sign past it. */
const MAX_PART_NUMBER = 10000;
/** A presigned URL this close to expiry is re-signed rather than risked. */
const EXPIRY_MARGIN_MS = 60_000;
/** Assumed lifetime when a URL carries no readable `X-Amz-Date`/`X-Amz-Expires`. */
const FALLBACK_LIFETIME_MS = 60_000;

interface SignedUrl {
  url: string;
  /**
   * Epoch ms after which this URL is re-signed instead of used. Normally
   * `expiry − EXPIRY_MARGIN_MS`, but never earlier than half its own lifetime:
   * a gateway configured with a short PRESIGN_EXPIRY_SECONDS must still be able
   * to hand out a usable URL rather than one that is stale on arrival.
   */
  usableUntil: number;
}

/**
 * Trades a Google ID token for presigned URLs (SPEC §15.3). The gateway never
 * sees or moves object bytes: every URL returned here is fetched browser↔bucket.
 */
export function createGatewaySigner(options: GatewaySignerOptions): Signer {
  return new GatewaySigner(options);
}

class GatewaySigner implements Signer {
  readonly kind = "gateway" as const;
  readonly storageLabel = "The bucket behind the upload gateway";

  /** Presigned part URLs, keyed by `{uploadId}\n{partNumber}`. */
  private readonly parts = new Map<string, SignedUrl>();
  /**
   * Presigned DELETE URLs, keyed by `{id}\n{object}` (SPEC §18.3). One
   * `{ op: "delete", id }` answers with all three, so the first of the three
   * DELETEs pays for the round trip and the other two are free.
   */
  private readonly deletes = new Map<string, SignedUrl>();
  /** One request per in-flight batch, so a top-up and a demand never double-sign. */
  private readonly batches = new Map<string, Promise<void>>();
  private readonly gateway: string;

  constructor(private readonly options: GatewaySignerOptions) {
    this.gateway = options.gatewayUrl.replace(/\/+$/, "");
  }

  async sign(req: SignRequest): Promise<SignedRequest> {
    const url =
      req.op.kind === "part"
        ? await this.partUrl(req.op)
        : req.op.kind === "delete"
          ? await this.deleteUrl(req.op)
          : (await this.askForUrl(req.op)).url;

    // No `x-amz-content-sha256`: a query-signed URL is UNSIGNED-PAYLOAD (§15.3),
    // and a payload hash the signature does not cover only invites a 403.
    // `content-type` is not a signed header either, but S3 stores what we send,
    // so the object still gets the type SPEC §3 asks for.
    const headers = new Headers();
    if (req.contentType) headers.set("content-type", req.contentType);
    return { url, headers };
  }

  forget(op: SignOp): void {
    if (op.kind === "part") this.parts.delete(partKey(op.uploadId, op.partNumber));
    // Only the one object's URL: a retry re-signs it rather than re-sending a
    // signature the bucket has already refused, and the other two are still
    // good (SPEC §18.3).
    if (op.kind === "delete") this.deletes.delete(deleteKey(op.id, op.object));
  }

  statusHint(status: number, method: HttpMethod, kind?: SignOp["kind"]): string {
    // §18.3's optional-IAM contract, gateway side: the credentials that sign
    // are the gateway's, so this points at the gateway's own setup rather than
    // at a policy file the reader's browser never held. Discard's abort is a
    // DELETE too and wants a different grant, so it takes the general 403 —
    // same reason as LocalSigner.
    if (status === 403 && method === "DELETE" && kind !== "abort") {
      return (
        `The bucket refused the delete. The presigned URL may have expired (a retry signs a fresh ` +
        `one), or the gateway's bucket credentials may not be allowed to delete a stored object — ` +
        `s3:DeleteObject on the video bucket is what Delete video spends. See ${GATEWAY_DOCS}.`
      );
    }
    if (status === 403) {
      return (
        `The bucket rejected the presigned URL. It may have expired (a retry signs a fresh one), or ` +
        `the gateway's bucket credentials may not be allowed to ${method} here. See ${GATEWAY_DOCS}.`
      );
    }
    if (status === 404) {
      return (
        `The bucket or the multipart upload was not found — check the gateway's BUCKET_ENDPOINT and ` +
        `BUCKET_NAME, and note that an upload left open for a long time can expire. See ${GATEWAY_DOCS}.`
      );
    }
    if (status === 400) {
      return (
        `The bucket rejected the presigned request — usually the gateway's BUCKET_REGION or ` +
        `BUCKET_ENDPOINT. See ${GATEWAY_DOCS}.`
      );
    }
    if (status === 405 || status === 501) {
      return (
        `The bucket did not accept a ${method}; it may not support multipart uploads. See ${GATEWAY_DOCS}.`
      );
    }
    if (status >= 500) {
      return "The storage server failed. Wait a moment and try again.";
    }
    return `See ${GATEWAY_DOCS} for gateway setup.`;
  }

  networkMessage(what: string, method: HttpMethod): string {
    return (
      `Could not ${verbFor(method)} ${what}: the ${method} to the presigned URL failed before any ` +
      `HTTP status. That is almost always the bucket's CORS configuration (it must allow ${method} ` +
      `from ${originLabel()} and expose the ETag header) or an unreachable bucket — the gateway ` +
      `itself answered, so its own CORS is fine. See examples/s3-cors.json and ${GATEWAY_DOCS}.`
    );
  }

  // --- internals -------------------------------------------------------------

  /** One presigned URL for an op the session needs exactly once. */
  private async askForUrl(
    op: Exclude<SignOp, { kind: "part" } | { kind: "delete" }>,
  ): Promise<SignedUrl> {
    const body = await this.ask({
      op: op.kind,
      id: op.id,
      ...("uploadId" in op ? { uploadId: op.uploadId } : {}),
    });
    return checkedUrl(record(body).url, `the ${op.kind} request`);
  }

  /**
   * The part queue is sequential, so a round trip per part would idle the
   * network between parts. Parts are signed `PART_BATCH` at a time and the
   * window is topped up while the current part uploads.
   */
  private async partUrl(op: { id: string; uploadId: string; partNumber: number }): Promise<string> {
    const cached = this.freshPart(op.uploadId, op.partNumber);
    if (cached) {
      // Top up only once the window is half spent, and never awaited: this part
      // already has its URL, and topping up per part would trade one stall for a
      // round trip before every single part.
      if (!this.freshPart(op.uploadId, op.partNumber + PART_BATCH / 2)) {
        void this.loadParts(op.id, op.uploadId, op.partNumber + 1).catch(() => undefined);
      }
      return cached;
    }

    await this.loadParts(op.id, op.uploadId, op.partNumber);
    const url = this.freshPart(op.uploadId, op.partNumber);
    if (!url) {
      throw new Error(
        `The upload gateway did not return a URL for part ${op.partNumber}. See ${GATEWAY_DOCS}.`,
      );
    }
    return url;
  }

  /** Signs the window of `PART_BATCH` parts from `from`, skipping any already held. */
  private loadParts(id: string, uploadId: string, from: number): Promise<void> {
    const wanted: number[] = [];
    for (let n = from; n < from + PART_BATCH && n <= MAX_PART_NUMBER; n++) {
      if (!this.freshPart(uploadId, n)) wanted.push(n);
    }
    if (wanted.length === 0) return Promise.resolve();

    const key = partKey(uploadId, wanted[0]);
    const running = this.batches.get(key);
    if (running) return running;

    const task = this.requestParts(id, uploadId, wanted).finally(() => this.batches.delete(key));
    this.batches.set(key, task);
    return task;
  }

  private async requestParts(id: string, uploadId: string, partNumbers: number[]): Promise<void> {
    const body = record(await this.ask({ op: "part", id, uploadId, partNumbers }));
    if (!Array.isArray(body.urls)) {
      throw new Error(`The upload gateway returned no part URLs. See ${GATEWAY_DOCS}.`);
    }
    // Expired entries are never read, but a long session would otherwise keep
    // every URL it has ever been given.
    this.pruneParts();
    for (const entry of body.urls) {
      const part = record(entry);
      if (typeof part.partNumber !== "number") continue;
      this.parts.set(
        partKey(uploadId, part.partNumber),
        checkedUrl(part.url, `part ${part.partNumber}`),
      );
    }
  }

  /**
   * One of §18.1's three DELETEs. The gateway answers a `delete` with all three
   * URLs in one body (SPEC §15.3), so this asks once and the two DELETEs behind
   * it are already held — the same shape `part` has, cached the same way.
   */
  private async deleteUrl(op: { id: string; object: VideoObjectName }): Promise<string> {
    const held = this.freshDelete(op.id, op.object);
    if (held) return held;

    await this.requestDeletes(op.id);
    const url = this.freshDelete(op.id, op.object);
    if (!url) {
      throw new Error(
        `The upload gateway did not return a URL for ${op.id}/${op.object}. See ${GATEWAY_DOCS}.`,
      );
    }
    return url;
  }

  private async requestDeletes(id: string): Promise<void> {
    const body = record(await this.ask({ op: "delete", id }));
    if (!Array.isArray(body.urls)) {
      throw new Error(`The upload gateway returned no delete URLs. See ${GATEWAY_DOCS}.`);
    }
    for (const entry of body.urls) {
      const object = record(entry);
      // The key is a suffix the gateway chose from a closed set; anything else
      // is not one of §3's three objects and has no row to belong to.
      if (!isVideoObjectName(object.key)) continue;
      this.deletes.set(deleteKey(id, object.key), checkedUrl(object.url, `${id}/${object.key}`));
    }
  }

  private freshDelete(id: string, object: VideoObjectName): string | null {
    const key = deleteKey(id, object);
    const entry = this.deletes.get(key);
    if (!entry) return null;
    if (entry.usableUntil <= Date.now()) {
      this.deletes.delete(key);
      return null;
    }
    return entry.url;
  }

  private freshPart(uploadId: string, partNumber: number): string | null {
    const key = partKey(uploadId, partNumber);
    const entry = this.parts.get(key);
    if (!entry) return null;
    if (entry.usableUntil <= Date.now()) {
      this.parts.delete(key);
      return null;
    }
    return entry.url;
  }

  private pruneParts(): void {
    const now = Date.now();
    for (const [key, entry] of this.parts) {
      if (entry.usableUntil <= now) this.parts.delete(key);
    }
  }

  /**
   * One `POST {gateway}/sign`. A 401 means the ID token expired or was rotated —
   * the gateway is stateless, so a fresh token is the only possible fix; try
   * silently once, then let the caller's retry/degraded path take over (§15.5).
   */
  private async ask(payload: Record<string, unknown>): Promise<unknown> {
    let token = this.options.getToken();
    if (!token) {
      token = await this.options.refreshToken();
      if (!token) throw signInError();
    }

    let res = await this.post(token, payload);
    if (res.status === 401) {
      const fresh = await this.options.refreshToken();
      if (!fresh) throw signInError();
      res = await this.post(fresh, payload);
    }

    if (!res.ok) {
      const detail = await gatewayDetail(res);
      if (res.status === 401) throw signInError(detail);
      if (res.status === 403) {
        throw new Error(
          `The upload gateway will not sign uploads for this account${detail}. Ask whoever runs it ` +
            `to add your email to ALLOWED_EMAILS. See ${GATEWAY_DOCS}.`,
        );
      }
      throw new Error(
        `The upload gateway refused to sign the request: HTTP ${res.status}` +
          `${res.statusText ? ` ${res.statusText}` : ""}${detail}. See ${GATEWAY_DOCS}.`,
      );
    }

    try {
      return (await res.json()) as unknown;
    } catch (cause) {
      throw new Error(
        `The upload gateway's answer was not JSON. Check that ${this.gateway} is the gateway and ` +
          `not the static site. See ${GATEWAY_DOCS}.`,
        { cause },
      );
    }
  }

  private async post(token: string, payload: Record<string, unknown>): Promise<Response> {
    try {
      return await fetch(`${this.gateway}/sign`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
    } catch (cause) {
      throw new Error(
        `Could not reach the upload gateway at ${this.gateway}: the request failed before any HTTP ` +
          `status. Check that it is running and that its ALLOWED_ORIGINS includes ${originLabel()}. ` +
          `See ${GATEWAY_DOCS}.`,
        { cause },
      );
    }
  }
}

function partKey(uploadId: string, partNumber: number): string {
  return `${uploadId}\n${partNumber}`;
}

function deleteKey(id: string, object: VideoObjectName): string {
  return `${id}\n${object}`;
}

function isVideoObjectName(value: unknown): value is VideoObjectName {
  return value === "video.bin" || value === "meta.json" || value === "thumb.bin";
}

function signInError(detail = ""): Error {
  return new Error(
    `The upload gateway did not accept this sign-in${detail}. Sign in with Google again to keep ` +
      `uploading — nothing recorded is lost.`,
  );
}

/** `{ error }` from a gateway failure, as a parenthetical for the message. */
async function gatewayDetail(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  if (!text) return "";
  let message = "";
  try {
    const parsed = record(JSON.parse(text) as unknown);
    if (typeof parsed.error === "string") message = parsed.error;
  } catch {
    message = text;
  }
  message = message.replace(/\s+/g, " ").trim().slice(0, 200);
  return message ? ` (${message})` : "";
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** The gateway is trusted with credentials, but a mistyped URL should still fail loudly. */
function checkedUrl(value: unknown, what: string): SignedUrl {
  if (typeof value !== "string" || !value) {
    throw new Error(`The upload gateway returned no URL for ${what}. See ${GATEWAY_DOCS}.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`The upload gateway returned an unusable URL for ${what}. See ${GATEWAY_DOCS}.`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(
      `The upload gateway returned a "${parsed.protocol}" URL for ${what}; uploads only go over ` +
        `http or https. See ${GATEWAY_DOCS}.`,
    );
  }
  return { url: value, usableUntil: presignedUsableUntil(parsed) };
}

/**
 * When a presigned URL stops working, read off its own `X-Amz-Date` +
 * `X-Amz-Expires` (SigV4 query auth). The gateway's clock signs it and this
 * clock reads it, so skew either re-signs early (harmless) or produces a 403
 * that the retry path re-signs anyway.
 */
function presignedUsableUntil(url: URL): number {
  const stamp = url.searchParams.get("X-Amz-Date") ?? "";
  const seconds = Number(url.searchParams.get("X-Amz-Expires"));
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(stamp);
  if (!match || !Number.isFinite(seconds) || seconds <= 0) {
    return Date.now() + FALLBACK_LIFETIME_MS / 2;
  }
  const signedAt = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  );
  const lifetimeMs = seconds * 1000;
  return signedAt + lifetimeMs - Math.min(EXPIRY_MARGIN_MS, lifetimeMs / 2);
}

// --- Session -----------------------------------------------------------------

/**
 * Starts the multipart upload for `{id}/video.bin`. Called at record start, so a
 * failure here (bad credentials, unreachable endpoint, not signed in) surfaces
 * before the user has recorded anything.
 */
export function createUploadSession(
  settings: Settings,
  id: string,
  key: CryptoKey,
  onProgress?: (uploadedBytes: number) => void,
): Promise<UploadSession>;
export function createUploadSession(
  signer: Signer,
  id: string,
  key: CryptoKey,
  onProgress?: (uploadedBytes: number) => void,
): Promise<UploadSession>;
export async function createUploadSession(
  target: Settings | Signer,
  id: string,
  key: CryptoKey,
  onProgress?: (uploadedBytes: number) => void,
): Promise<UploadSession> {
  const signer = "sign" in target ? target : createLocalSigner(target);

  const objectKey = `${id}/video.bin`;
  const res = await send(
    signer,
    { op: { kind: "create", id }, contentType: CONTENT_TYPE },
    `${objectKey} (starting the multipart upload)`,
  );

  const body = await res.text().catch(() => "");
  const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(body)?.[1];
  if (!uploadId) {
    throw new Error(
      `${signer.storageLabel} accepted the multipart upload but returned no UploadId. It may not ` +
        `support S3 multipart uploads. See ${DOCS}.`,
    );
  }

  return new MultipartSession(signer, id, key, uploadId, onProgress);
}

/** The bucket did not expose the ETag response header — retrying cannot fix that. */
class MissingEtagError extends Error {}

class MultipartSession implements UploadSession {
  uploadedBytes = 0;

  /** ETag per part number, for the CompleteMultipartUpload body. */
  private readonly etags = new Map<number, string>();
  /** Encrypted parts whose attempts all failed; `finish()` re-sends these first (SPEC §7). */
  private readonly unsent = new Map<number, Uint8Array>();
  /** One part in flight at a time, in part order — never parallel PUTs. */
  private queue: Promise<void> = Promise.resolve();
  private partCount = 0;
  private plaintextBytes = 0;
  /** Plaintext size of the non-final chunks; every one must match, and match `meta.chunkSize`. */
  private chunkSize: number | null = null;
  private lastError: unknown = null;
  private finalAdded = false;
  private completed = false;
  private state: "open" | "done" | "aborted" = "open";

  constructor(
    private readonly signer: Signer,
    private readonly id: string,
    private readonly key: CryptoKey,
    private readonly uploadId: string,
    private readonly onProgress?: (uploadedBytes: number) => void,
  ) {}

  addChunk(plain: Uint8Array): Promise<void> {
    if (this.state !== "open") return Promise.reject(new Error(this.closedMessage()));
    if (this.finalAdded) {
      return Promise.reject(new Error("addChunk() was called after the final chunk was flushed."));
    }
    if (plain.length === 0) return Promise.resolve();

    if (this.chunkSize === null) {
      this.chunkSize = plain.length;
    } else if (plain.length !== this.chunkSize) {
      return Promise.reject(
        new Error(
          `addChunk() got a ${plain.length}-byte chunk after ${this.chunkSize}-byte ones. Only the ` +
            `final chunk may be short, and it goes to finish() — the player derives chunk offsets ` +
            `from a single chunk size.`,
        ),
      );
    }
    return this.enqueue(plain);
  }

  async finish(
    finalPlain: Uint8Array | null,
    meta: VideoMeta,
    thumb?: Uint8Array | null,
  ): Promise<UploadResult> {
    if (this.state !== "open") throw new Error(this.closedMessage());

    let finalTask: Promise<void> | null = null;
    if (!this.finalAdded) {
      if (finalPlain && finalPlain.length > 0) {
        if (this.chunkSize !== null && finalPlain.length > this.chunkSize) {
          throw new Error(
            `The final chunk is ${finalPlain.length} bytes, larger than the ${this.chunkSize}-byte ` +
              `chunks before it.`,
          );
        }
        this.finalAdded = true;
        finalTask = this.enqueue(finalPlain);
      } else {
        this.finalAdded = true;
      }
    }

    await this.queue; // every part has had its attempts; the ones that failed are in `unsent`
    if (finalTask) await finalTask; // surfaces an encryption failure (upload failures never reject)

    if (this.partCount === 0) {
      throw new Error("Nothing was recorded, so there is nothing to upload.");
    }
    requireConsistent(meta, this.partCount, this.plaintextBytes, this.chunkSize);

    await this.resendFailed();
    if (!this.completed) {
      await this.completeUpload();
      this.completed = true;
    }
    // After the video exists, before meta: a reader that finds meta may or may
    // not find a thumbnail (SPEC §3 says it must cope either way), but it never
    // finds a thumbnail for a video that does not exist.
    if (thumb) await this.putThumb(thumb);
    await this.putMeta(meta);

    this.state = "done";
    return { id: this.id, link: shareLink(this.id, await exportKeyB64(this.key)) };
  }

  async abort(): Promise<void> {
    if (this.state !== "open") return;
    // Set first: queued parts check this and drop out rather than uploading into
    // an upload that is about to disappear.
    this.state = "aborted";
    this.unsent.clear();
    // A PUT already in flight would otherwise land *after* the abort and strand a
    // billed part that nothing lists. The queue never rejects, and nothing can be
    // enqueued behind it now that the state is "aborted".
    await this.queue;
    try {
      await send(
        this.signer,
        { op: { kind: "abort", id: this.id, uploadId: this.uploadId } },
        `${this.videoKey()} (abandoning the multipart upload)`,
      );
    } catch (err) {
      // Best-effort by design: the bucket's "abort incomplete multipart uploads"
      // lifecycle rule (SPEC §14) is the backstop.
      console.warn("[videoshare] could not abort the multipart upload", err);
    }
  }

  // --- internals -------------------------------------------------------------

  private enqueue(plain: Uint8Array): Promise<void> {
    const index = this.partCount++;
    this.plaintextBytes += plain.length;
    const task = this.queue.then(() => this.sendChunk(index, plain));
    // A failed part must not poison the queue for the parts behind it.
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async sendChunk(index: number, plain: Uint8Array): Promise<void> {
    if (this.state !== "open") return;
    const block = await encryptBlock(this.key, chunkAad(this.id, index), plain);
    await this.sendPart(index + 1, block);
  }

  /** Never rejects for an upload failure: the part is kept for `finish()` to re-send. */
  private async sendPart(partNumber: number, block: Uint8Array): Promise<void> {
    let etag: string;
    try {
      etag = await this.uploadPart(partNumber, block);
    } catch (err) {
      // Discarded while this part was in flight: there is nothing left to re-send
      // it into, and `abort()` has already emptied `unsent`.
      if (this.state !== "open") return;
      this.lastError = err;
      this.unsent.set(partNumber, block);
      return;
    }
    // Same race the other way: a part that lands after abort() belongs to an
    // upload that no longer exists, so it must not count towards progress.
    if (this.state !== "open") return;
    this.etags.set(partNumber, etag);
    this.unsent.delete(partNumber);
    this.uploadedBytes += block.length;
    this.onProgress?.(this.uploadedBytes);
  }

  private async uploadPart(partNumber: number, block: Uint8Array): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await send(
          this.signer,
          {
            op: { kind: "part", id: this.id, uploadId: this.uploadId, partNumber },
            body: block,
            contentType: CONTENT_TYPE,
          },
          `${this.videoKey()} part ${partNumber}`,
        );
        const etag = res.headers.get("etag");
        if (!etag) {
          throw new MissingEtagError(
            `The storage server did not return an ETag for part ${partNumber} of ${this.videoKey()}, ` +
              `so the upload cannot be completed. A bucket CORS rule must list "ETag" under ` +
              `ExposeHeaders — see examples/s3-cors.json and ${DOCS}.`,
          );
        }
        return etag;
      } catch (err) {
        if (err instanceof MissingEtagError || attempt >= RETRY_DELAYS_MS.length) throw err;
        await delay(RETRY_DELAYS_MS[attempt]);
      }
    }
  }

  private async resendFailed(): Promise<void> {
    for (const partNumber of sortedKeys(this.unsent)) {
      const block = this.unsent.get(partNumber);
      if (block) await this.sendPart(partNumber, block);
    }
    if (this.unsent.size === 0) return;

    const numbers = sortedKeys(this.unsent);
    throw new Error(
      `${numbers.length} of ${this.partCount} parts of ${this.videoKey()} could not be uploaded ` +
        `(part ${numbers.join(", ")}). ${describe(this.lastError)}`,
    );
  }

  private async completeUpload(): Promise<void> {
    const res = await send(
      this.signer,
      {
        op: { kind: "complete", id: this.id, uploadId: this.uploadId },
        body: new TextEncoder().encode(completeXml(this.etags, this.partCount)),
        contentType: XML_CONTENT_TYPE,
      },
      `${this.videoKey()} (completing the multipart upload)`,
    );

    // S3 answers CompleteMultipartUpload with 200 and *then* streams an <Error>
    // body if the assembly fails, so a 2xx alone is not success here.
    const body = await res.text().catch(() => "");
    if (/<Error[\s>]/.test(body)) {
      throw new Error(
        `The storage server refused to assemble ${this.videoKey()}` +
          `${s3ErrorDetail(body) ? ` (${s3ErrorDetail(body)})` : ""}. ` +
          `Every part except the last must be at least 5 MiB. See ${DOCS}.`,
      );
    }
  }

  /**
   * SPEC §3's optional `thumb.bin`, and the one write here that cannot fail the
   * finish: attempted once, inside a `try`/`catch` that swallows everything.
   * Whatever happens to it, `finish()` goes on to PUT meta and returns the share
   * link — the video and the link are what the user asked for, and a decorative
   * image must never be able to cost them either. It gets none of the part
   * queue's retry ladder for the same reason.
   *
   * The block arrives already encrypted under `thumbAad(id)` (SPEC §6): this
   * file never sees the plaintext, does not re-encrypt it and does not inspect
   * it. A `finish()` retried after a failure re-sends it — an idempotent PUT of
   * the same bytes to the same key. It is not counted in `uploadedBytes`, which
   * is the recording's progress and not a 30 KB image arriving at the end.
   */
  private async putThumb(block: Uint8Array): Promise<void> {
    try {
      await send(
        this.signer,
        { op: { kind: "put-thumb", id: this.id }, body: block, contentType: CONTENT_TYPE },
        `${this.id}/thumb.bin`,
      );
    } catch (err) {
      console.warn("[videoshare] could not upload the thumbnail; the video is unaffected", err);
    }
  }

  private async putMeta(meta: VideoMeta): Promise<void> {
    const objectKey = `${this.id}/meta.json`;
    const plain = new TextEncoder().encode(JSON.stringify(meta));
    await send(
      this.signer,
      {
        op: { kind: "put-meta", id: this.id },
        body: await encryptBlock(this.key, metaAad(this.id), plain),
        contentType: CONTENT_TYPE,
      },
      objectKey,
    );
  }

  private videoKey(): string {
    return `${this.id}/video.bin`;
  }

  private closedMessage(): string {
    return this.state === "aborted"
      ? "This recording was discarded, so its upload can no longer be used."
      : "This upload was already finished.";
  }
}

// --- Deletion (SPEC §18.3) ---------------------------------------------------

/**
 * Deletes `{id}`'s three objects in {@link DELETE_ORDER}, sequentially.
 *
 * Resolves when all three are gone — **a 404 counts as gone**: `DeleteObject`
 * is idempotent, most implementations answer 204 whether or not the object was
 * there and the ones that answer 404 mean the same thing, `thumb.bin` is
 * optional (§3) so its absence is the ordinary case, and a delete retried after
 * a partial failure must not fail on the objects that already went. Any other
 * non-2xx is a failure.
 *
 * Rejects with the first failure's message and leaves whatever came after it
 * untouched. There is deliberately **no retry ladder**: the part queue's exists
 * because a recording is unrepeatable, while a failed delete loses nothing, the
 * library entry stays, and the reader can press the button again with a better
 * error in front of them. One attempt per object.
 *
 * Sequential rather than parallel, because §18.1's order is the guarantee: once
 * `meta.json` is gone the share link is already the clean "video not found" of
 * §18.5, and three parallel DELETEs would trade that for a few hundred
 * milliseconds.
 */
export async function deleteVideo(signer: Signer, id: string): Promise<void> {
  for (const object of DELETE_ORDER) {
    await send(signer, { op: { kind: "delete", id, object } }, `${id}/${object}`, {
      goneIsSuccess: true,
    });
  }
}

// --- Signed requests ---------------------------------------------------------

interface SendOptions {
  /** A 404 means the object is not there, which is what the caller wanted (§18.1). */
  goneIsSuccess?: boolean;
}

async function send(
  signer: Signer,
  req: SignRequest,
  what: string,
  options?: SendOptions,
): Promise<Response> {
  const method = METHODS[req.op.kind];
  // lib.dom's BodyInit accepts only ArrayBuffer-backed views; nothing here is
  // ever backed by a SharedArrayBuffer.
  const body = (req.body ?? EMPTY) as Uint8Array<ArrayBuffer>;

  const signed = await signer.sign(req);

  let res: Response;
  try {
    res = await fetch(signed.url, {
      method,
      headers: signed.headers,
      body: req.body ? body : undefined,
    });
  } catch (cause) {
    signer.forget(req.op);
    throw new Error(signer.networkMessage(what, method), { cause });
  }
  if (res.status === 404 && options?.goneIsSuccess) return res;
  if (!res.ok) {
    // A signature that produced a failure is not reused: the retry signs a new one.
    signer.forget(req.op);
    const text = await res.text().catch(() => "");
    throw new Error(httpMessage(what, req.op.kind, signer, res.status, res.statusText, text));
  }
  return res;
}

// --- Validation --------------------------------------------------------------

function requireConfigured(settings: Settings): void {
  const missing = (["endpoint", "bucket", "accessKeyId", "secretAccessKey"] as const).filter(
    (field) => !settings[field] || !settings[field].trim(),
  );
  if (missing.length > 0) {
    throw new Error(
      `Storage is not configured: ${missing.join(", ")} missing. Open Settings and fill in your ` +
        `S3 endpoint, bucket and access keys (see ${DOCS}).`,
    );
  }
}

/**
 * The player reads chunk offsets straight out of meta (SPEC §4), so meta that
 * disagrees with the parts actually sent produces an unplayable video. Catch it
 * before CompleteMultipartUpload makes the object real.
 */
function requireConsistent(
  meta: VideoMeta,
  partCount: number,
  plaintextBytes: number,
  chunkSize: number | null,
): void {
  const problems: string[] = [];
  if (meta.chunkCount !== partCount) {
    problems.push(`meta.chunkCount is ${meta.chunkCount} but ${partCount} chunk(s) were uploaded`);
  }
  if (meta.totalBytes !== plaintextBytes) {
    problems.push(`meta.totalBytes is ${meta.totalBytes} but ${plaintextBytes} plaintext byte(s) were uploaded`);
  }
  if (chunkSize !== null && meta.chunkSize !== chunkSize) {
    problems.push(`meta.chunkSize is ${meta.chunkSize} but the chunks fed in were ${chunkSize} bytes`);
  }
  if (meta.chunkSize > 0 && meta.chunkCount !== Math.ceil(meta.totalBytes / meta.chunkSize)) {
    problems.push(`meta.chunkCount ${meta.chunkCount} is not ceil(${meta.totalBytes} / ${meta.chunkSize})`);
  }
  if (problems.length === 0) return;

  throw new Error(
    `Refusing to finish the upload: ${problems.join("; ")}. The player derives chunk offsets from ` +
      `meta, so this video would be unplayable.`,
  );
}

// --- XML ---------------------------------------------------------------------

/**
 * The CompleteMultipartUpload body. ETags go back exactly as the server returned
 * them (S3 wraps them in literal quotes, which belong in the value).
 */
function completeXml(etags: Map<number, string>, partCount: number): string {
  let parts = "";
  for (let partNumber = 1; partNumber <= partCount; partNumber++) {
    const etag = etags.get(partNumber);
    if (etag === undefined) throw new Error(`No ETag was recorded for part ${partNumber}.`);
    parts += `<Part><PartNumber>${partNumber}</PartNumber><ETag>${xmlText(etag)}</ETag></Part>`;
  }
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
    `${parts}</CompleteMultipartUpload>`
  );
}

/** Escapes only what XML character data forbids, so ETag quotes survive verbatim. */
function xmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function s3ErrorDetail(body: string): string {
  if (!body) return "";
  const code = /<Code>([^<]*)<\/Code>/.exec(body)?.[1] ?? "";
  const message = /<Message>([^<]*)<\/Message>/.exec(body)?.[1] ?? "";
  if (code && message) return `${code}: ${message}`;
  if (code || message) return code || message;
  return body.replace(/\s+/g, " ").trim().slice(0, 200);
}

// --- Error messages ----------------------------------------------------------

function httpMessage(
  what: string,
  kind: SignOp["kind"],
  signer: Signer,
  status: number,
  statusText: string,
  body: string,
): string {
  const method = METHODS[kind];
  const detail = s3ErrorDetail(body);
  const head =
    method === "DELETE"
      ? `Deleting ${what} failed: HTTP ${status}${statusText ? ` ${statusText}` : ""}`
      : `Upload of ${what} failed: HTTP ${status}${statusText ? ` ${statusText}` : ""}`;
  return `${head}${detail ? ` (${detail})` : ""}. ${signer.statusHint(status, method, kind)}`;
}

/**
 * What a failed request was *for*, in a sentence. The seam carries one DELETE
 * that abandons an upload and three that remove objects (§18.3); both read as
 * "delete" and neither reads as "upload".
 */
function verbFor(method: HttpMethod): string {
  return method === "DELETE" ? "delete" : "upload";
}

// --- Small helpers -----------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sortedKeys(map: Map<number, unknown>): number[] {
  return [...map.keys()].sort((a, b) => a - b);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function originLabel(): string {
  return typeof location === "undefined" ? "this page's origin" : location.origin;
}
