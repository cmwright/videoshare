/**
 * Streaming upload of one video (docs/SPEC.md §7).
 *
 * `{id}/video.bin` is an S3 multipart upload that runs *alongside* the
 * recording: encrypted chunk i (§4) is uploaded as part number i+1, so the
 * completed object is byte-identical to the plain concatenation of blocks the
 * player expects. `{id}/meta.json` stays a single PUT and goes last — a video
 * is complete iff its meta exists.
 *
 * Everything here is plain `fetch` of an aws4fetch-signed request, so the whole
 * path runs unchanged in Node for the e2e tests.
 */

import { AwsClient } from "aws4fetch";
import { chunkAad, encryptBlock, exportKeyB64, metaAad } from "./crypto";
import type { Settings, VideoMeta } from "./types";

export interface UploadResult {
  id: string;
  link: string;
}

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
   * earlier, completes the multipart upload, then PUTs `meta.json`. Safe to
   * call again after a failure: the final chunk is only ever added once.
   */
  finish(finalPlain: Uint8Array | null, meta: VideoMeta): Promise<UploadResult>;
  /** Best-effort `AbortMultipartUpload`; never throws. */
  abort(): Promise<void>;
  /** Ciphertext bytes confirmed uploaded so far. */
  readonly uploadedBytes: number;
}

const CONTENT_TYPE = "application/octet-stream";
const XML_CONTENT_TYPE = "application/xml";
const DOCS = "docs/storage-setup.md";

/** Backoff before retry 1, 2 and 3 of a part (SPEC §7); an attempt with no delay comes first. */
const RETRY_DELAYS_MS = [1000, 2000, 4000];

const EMPTY = new Uint8Array(0);

/**
 * Starts the multipart upload for `{id}/video.bin`. Called at record start, so a
 * failure here (bad credentials, unreachable endpoint) surfaces before the user
 * has recorded anything.
 */
export async function createUploadSession(
  settings: Settings,
  id: string,
  key: CryptoKey,
  onProgress?: (uploadedBytes: number) => void,
): Promise<UploadSession> {
  requireConfigured(settings);

  const client = new AwsClient({
    accessKeyId: settings.accessKeyId,
    secretAccessKey: settings.secretAccessKey,
    region: settings.region || "us-east-1",
    service: "s3",
  });

  const objectKey = `${id}/video.bin`;
  const res = await s3Fetch({
    client,
    settings,
    method: "POST",
    url: `${objectUrl(settings, objectKey)}?uploads`,
    what: `${objectKey} (starting the multipart upload)`,
    contentType: CONTENT_TYPE,
  });

  const body = await res.text().catch(() => "");
  const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(body)?.[1];
  if (!uploadId) {
    throw new Error(
      `${settings.endpoint} accepted the multipart upload but returned no UploadId. It may not ` +
        `support S3 multipart uploads. See ${DOCS}.`,
    );
  }

  return new MultipartSession(client, settings, id, key, uploadId, onProgress);
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
    private readonly client: AwsClient,
    private readonly settings: Settings,
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

  async finish(finalPlain: Uint8Array | null, meta: VideoMeta): Promise<UploadResult> {
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
      await s3Fetch({
        client: this.client,
        settings: this.settings,
        method: "DELETE",
        url: this.partUrl(null),
        what: `${this.videoKey()} (abandoning the multipart upload)`,
      });
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
        const res = await s3Fetch({
          client: this.client,
          settings: this.settings,
          method: "PUT",
          url: this.partUrl(partNumber),
          what: `${this.videoKey()} part ${partNumber}`,
          body: block,
          contentType: CONTENT_TYPE,
        });
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
    const res = await s3Fetch({
      client: this.client,
      settings: this.settings,
      method: "POST",
      url: this.partUrl(null),
      what: `${this.videoKey()} (completing the multipart upload)`,
      body: new TextEncoder().encode(completeXml(this.etags, this.partCount)),
      contentType: XML_CONTENT_TYPE,
    });

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

  private async putMeta(meta: VideoMeta): Promise<void> {
    const objectKey = `${this.id}/meta.json`;
    const plain = new TextEncoder().encode(JSON.stringify(meta));
    await s3Fetch({
      client: this.client,
      settings: this.settings,
      method: "PUT",
      url: objectUrl(this.settings, objectKey),
      what: objectKey,
      body: await encryptBlock(this.key, metaAad(this.id), plain),
      contentType: CONTENT_TYPE,
    });
  }

  private videoKey(): string {
    return `${this.id}/video.bin`;
  }

  /** `partNumber` null → the upload itself (complete / abort). */
  private partUrl(partNumber: number | null): string {
    const base = objectUrl(this.settings, this.videoKey());
    const upload = `uploadId=${encodeQueryValue(this.uploadId)}`;
    return partNumber === null ? `${base}?${upload}` : `${base}?partNumber=${partNumber}&${upload}`;
  }

  private closedMessage(): string {
    return this.state === "aborted"
      ? "This recording was discarded, so its upload can no longer be used."
      : "This upload was already finished.";
  }
}

// --- Signed requests ---------------------------------------------------------

interface S3Request {
  client: AwsClient;
  settings: Settings;
  method: "PUT" | "POST" | "DELETE";
  url: string;
  /** What is being uploaded, for error messages. */
  what: string;
  body?: Uint8Array;
  contentType?: string;
}

async function s3Fetch(req: S3Request): Promise<Response> {
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

  const signed = await req.client.sign(req.url, { method: req.method, headers });

  let res: Response;
  try {
    res = await fetch(signed.url, {
      method: req.method,
      headers: signed.headers,
      body: req.body ? body : undefined,
    });
  } catch (cause) {
    throw new Error(networkMessage(req.what, req.method, req.settings), { cause });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(httpMessage(req.what, req.method, req.settings, res.status, res.statusText, text));
  }
  return res;
}

/** Path-style URL: works for MinIO, R2 and S3 alike. */
function objectUrl(settings: Settings, objectKey: string): string {
  return `${settings.endpoint.replace(/\/+$/, "")}/${settings.bucket}/${objectKey}`;
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
  method: string,
  settings: Settings,
  status: number,
  statusText: string,
  body: string,
): string {
  const detail = s3ErrorDetail(body);
  const head = `Upload of ${what} failed: HTTP ${status}${statusText ? ` ${statusText}` : ""}`;
  return `${head}${detail ? ` (${detail})` : ""}. ${statusHint(status, method, settings)}`;
}

function statusHint(status: number, method: string, settings: Settings): string {
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

function networkMessage(what: string, method: string, settings: Settings): string {
  return (
    `Could not reach ${settings.endpoint} to upload ${what}: the request failed before any HTTP ` +
    `status. That is almost always CORS (the bucket must allow ${method} from ${originLabel()}, ` +
    `allow the authorization/x-amz-* headers, and expose the ETag header) or an unreachable ` +
    `endpoint. See examples/s3-cors.json and ${DOCS}.`
  );
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

function shareLink(id: string, keyB64: string): string {
  const fragment = `#${id}.${keyB64}`;
  const here = typeof location === "undefined" ? "" : location.href;
  return here ? new URL("view.html", here).href + fragment : `view.html${fragment}`;
}

function originLabel(): string {
  return typeof location === "undefined" ? "this page's origin" : location.origin;
}
