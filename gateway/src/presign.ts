/**
 * SigV4 query-string presigning for the seven operations of `POST /api/sign`
 * (SPEC §15.3).
 *
 * The gateway hands the browser a *URL*; the bytes then flow browser↔bucket
 * directly. Nothing here fetches, streams or buffers object data — that is the
 * core invariant of §15 and there is deliberately no code path that could. §3's
 * thumbnail changes nothing about that: `put-thumb` signs a URL for one more
 * key, and the ~15–50 KB of ciphertext travels browser↔bucket like every other
 * object.
 *
 * §18's deletion changes nothing about it either, and is the sharpest case:
 * `delete` is **presign-or-bust**. The gateway signs three DELETEs and the
 * browser sends them, so there is no route on which this service removes a
 * video-bucket object itself and none may be added (§15.3, §18.3). A DELETE
 * carries no payload, which makes it the one method where a proxy would have
 * looked harmless — that is exactly why the rule is written down rather than
 * inferred from the size of the body.
 *
 * Two things make this safe to expose to an authenticated but otherwise
 * untrusted caller:
 *
 *  1. Object keys are built here, from a `{22}` id that matched `ID_PATTERN`,
 *     as exactly `{id}/video.bin`, `{id}/meta.json` or `{id}/thumb.bin`. The
 *     caller supplies the id, never a key, so no request can be steered at
 *     another object. `delete` takes **no** key, suffix or object name from the
 *     body at all: it answers with all three, so there is nothing to choose.
 *  2. `uploadId` and `partNumber` are syntax-checked and then percent-encoded
 *     with the *same* RFC 3986 encoder aws4fetch uses to build its canonical
 *     query string. They land as query *values* and can neither add a parameter
 *     nor escape into the path.
 *
 * Presigned S3 URLs carry `UNSIGNED-PAYLOAD` semantics (aws4fetch uses that for
 * `service: "s3"` + `signQuery`), so the signature covers the method, path,
 * query and `host` only. The client's part bodies, CompleteMultipartUpload XML
 * and encrypted meta need no hash, and the gateway never sees them.
 */

import { AwsV4Signer } from "aws4fetch";

/** Video id as minted by `randomId()` (SPEC §2): 16 random bytes, base64url, unpadded. */
export const ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/**
 * Every S3 implementation mints its own upload ids (base64, base64url, hex,
 * UUIDs, Ceph's `2~...`), so this is deliberately broad — it is a sanity gate,
 * not the security boundary. The boundary is `encodeQueryValue` below: even an
 * id full of `&` and `?` could only ever be one opaque query value.
 */
export const UPLOAD_ID_PATTERN = /^[A-Za-z0-9._~:+/=-]{1,1024}$/;

/** SPEC §15.3: 1–100 part numbers per request, each a valid S3 part number. */
export const MAX_PART_NUMBERS = 100;
export const MIN_PART_NUMBER = 1;
export const MAX_PART_NUMBER = 10000;

export interface BucketConfig {
  /** Absolute origin (plus optional path prefix) of the S3-compatible API, no trailing slash. */
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** `X-Amz-Expires` on every URL handed out (SPEC §15.2). */
  expirySeconds: number;
}

/**
 * §3's three objects, named by the suffix the client's seam and this gateway's
 * answer both use. The order is SPEC §18.1's deletion order and is load-bearing:
 * `meta.json` is the completion marker a player fetches first (§8), so removing
 * it first means a delete that fails halfway leaves a video that reads as
 * *absent* rather than as a torso that still looks complete. `video.bin` — the
 * one object whose absence costs anything to be wrong about — goes last.
 */
export const DELETE_ORDER = ["meta.json", "thumb.bin", "video.bin"] as const;
export type VideoObjectName = (typeof DELETE_ORDER)[number];

export type SignRequest =
  | { op: "create"; id: string }
  | { op: "part"; id: string; uploadId: string; partNumbers: number[] }
  | { op: "complete"; id: string; uploadId: string }
  | { op: "abort"; id: string; uploadId: string }
  | { op: "put-meta"; id: string }
  /** SPEC §3: one encrypted block whose plaintext is a JPEG. Optional per video. */
  | { op: "put-thumb"; id: string }
  /** SPEC §18.3: an id and nothing else; the answer is all three keys. */
  | { op: "delete"; id: string };

export type SignResponse =
  | { url: string; method: "POST" | "PUT" | "DELETE" }
  | { urls: { partNumber: number; url: string }[]; method: "PUT" }
  | { urls: { key: VideoObjectName; url: string }[]; method: "DELETE" };

export interface Presigner {
  sign(request: SignRequest): Promise<SignResponse>;
}

/** `parseSignRequest` result: either a validated request or the 400 to send back. */
export type ParseResult = { ok: true; request: SignRequest } | { ok: false; error: string };

/**
 * Validates a decoded `POST /api/sign` body (SPEC §15.3). Everything that is not
 * exactly one of the seven shapes is a 400 — unknown ops, unknown/misspelled
 * fields' absence, out-of-range part numbers, ids that are not 22 base64url
 * characters. Extra properties are ignored rather than rejected so the client
 * can add a field later without a lockstep gateway deploy.
 */
export function parseSignRequest(body: unknown): ParseResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "Body must be a JSON object." };
  }
  const raw = body as Record<string, unknown>;

  const op = raw["op"];
  if (typeof op !== "string") return { ok: false, error: '"op" is required.' };

  const id = raw["id"];
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    return { ok: false, error: '"id" must be 22 base64url characters.' };
  }

  if (op === "create") return { ok: true, request: { op, id } };
  if (op === "put-meta") return { ok: true, request: { op, id } };
  // §3's thumbnail is an id and nothing else, exactly like `put-meta`: same
  // validation, same shape, a different key built below.
  if (op === "put-thumb") return { ok: true, request: { op, id } };
  // §18.3's delete is an id and nothing else too — deliberately, and this is
  // the point at which that is enforced. There is no field here through which a
  // caller could name *which* object to remove: the answer is all three keys,
  // each built below from this id.
  if (op === "delete") return { ok: true, request: { op, id } };

  if (op === "part" || op === "complete" || op === "abort") {
    const uploadId = raw["uploadId"];
    if (typeof uploadId !== "string" || !UPLOAD_ID_PATTERN.test(uploadId)) {
      return { ok: false, error: '"uploadId" is missing or has unexpected characters.' };
    }
    if (op !== "part") return { ok: true, request: { op, id, uploadId } };

    const partNumbers = raw["partNumbers"];
    if (!Array.isArray(partNumbers)) {
      return { ok: false, error: '"partNumbers" must be an array.' };
    }
    if (partNumbers.length < 1 || partNumbers.length > MAX_PART_NUMBERS) {
      return {
        ok: false,
        error: `"partNumbers" must hold 1 to ${MAX_PART_NUMBERS} entries.`,
      };
    }
    for (const partNumber of partNumbers) {
      if (
        typeof partNumber !== "number" ||
        !Number.isInteger(partNumber) ||
        partNumber < MIN_PART_NUMBER ||
        partNumber > MAX_PART_NUMBER
      ) {
        return {
          ok: false,
          error: `Every part number must be an integer from ${MIN_PART_NUMBER} to ${MAX_PART_NUMBER}.`,
        };
      }
    }
    return { ok: true, request: { op, id, uploadId, partNumbers: partNumbers as number[] } };
  }

  return { ok: false, error: `Unknown op "${op}".` };
}

/** Signs one URL for one method, query-style. See `createQuerySigner`. */
export type QuerySigner = (
  method: "GET" | "PUT" | "POST" | "DELETE",
  url: string,
) => Promise<string>;

/**
 * A query-string presigner bound to one configuration. The cache it closes over
 * is the derived SigV4 signing key (per secret/date/region/service), so signing
 * a 100-part batch — or a thousand analytics sessions (SPEC §16.3) — costs one
 * key derivation, not a thousand.
 */
export function createQuerySigner(config: BucketConfig): QuerySigner {
  const cache = new Map<string, ArrayBuffer>();
  return (method, url) => signQuery(config, cache, method, url);
}

/** One presigner per configuration, over one `createQuerySigner`. */
export function createPresigner(config: BucketConfig): Presigner {
  const presign = createQuerySigner(config);

  return {
    async sign(request: SignRequest): Promise<SignResponse> {
      // Defence in depth: `parseSignRequest` has already run in core, but this
      // module must be safe on its own terms too.
      if (!ID_PATTERN.test(request.id)) throw new Error("Refusing to sign: malformed video id.");

      switch (request.op) {
        case "create":
          return { url: await presign("POST", `${videoUrl(config, request.id)}?uploads=`), method: "POST" };

        case "put-meta":
          return { url: await presign("PUT", metaUrl(config, request.id)), method: "PUT" };

        case "put-thumb":
          return { url: await presign("PUT", thumbUrl(config, request.id)), method: "PUT" };

        case "complete":
          return {
            url: await presign("POST", `${videoUrl(config, request.id)}?${uploadIdParam(request.uploadId)}`),
            method: "POST",
          };

        case "abort":
          return {
            url: await presign("DELETE", `${videoUrl(config, request.id)}?${uploadIdParam(request.uploadId)}`),
            method: "DELETE",
          };

        // SPEC §18.3. Three signatures, one request, in §18.1's order — a
        // client that only wanted one still gets three, which costs three
        // HMACs against the cached signing key and no round trip. The `key` is
        // the *suffix*, not the full object key: the full key is this module's
        // to build, and the client's only use for the name is telling the three
        // URLs apart.
        case "delete": {
          const urls = await Promise.all(
            DELETE_ORDER.map(async (key) => ({
              key,
              url: await presign("DELETE", videoObjectUrl(config, request.id, key)),
            })),
          );
          return { urls, method: "DELETE" };
        }

        case "part": {
          const base = videoUrl(config, request.id);
          const upload = uploadIdParam(request.uploadId);
          const urls = await Promise.all(
            request.partNumbers.map(async (partNumber) => ({
              partNumber,
              url: await presign("PUT", `${base}?partNumber=${partNumber}&${upload}`),
            })),
          );
          return { urls, method: "PUT" };
        }
      }
    },
  };
}

// --- URL construction --------------------------------------------------------

/** Path-style `{endpoint}/{bucket}/{key}` — works for MinIO, R2 and S3 alike. */
export function objectUrl(config: BucketConfig, objectKey: string): string {
  return `${config.endpoint}/${config.bucket}/${objectKey}`;
}

/** The bucket itself, which is what a `?list-type=2` listing addresses. */
export function bucketUrl(config: BucketConfig): string {
  return `${config.endpoint}/${config.bucket}`;
}

/** The only three keys this gateway will ever sign for (SPEC §3). */
export function videoKey(id: string): string {
  return `${id}/video.bin`;
}
export function metaKey(id: string): string {
  return `${id}/meta.json`;
}
export function thumbKey(id: string): string {
  return `${id}/thumb.bin`;
}

function videoUrl(config: BucketConfig, id: string): string {
  return objectUrl(config, videoKey(id));
}
function metaUrl(config: BucketConfig, id: string): string {
  return objectUrl(config, metaKey(id));
}
function thumbUrl(config: BucketConfig, id: string): string {
  return objectUrl(config, thumbKey(id));
}

/**
 * One of the three, by name. Routed through the same three key builders rather
 * than interpolating the suffix, so `videoKey`/`metaKey`/`thumbKey` stay the
 * only places in this gateway where an object key is spelled out.
 */
function videoObjectUrl(config: BucketConfig, id: string, name: VideoObjectName): string {
  switch (name) {
    case "video.bin":
      return videoUrl(config, id);
    case "meta.json":
      return metaUrl(config, id);
    case "thumb.bin":
      return thumbUrl(config, id);
  }
}

function uploadIdParam(uploadId: string): string {
  if (!UPLOAD_ID_PATTERN.test(uploadId)) throw new Error("Refusing to sign: malformed uploadId.");
  return `uploadId=${encodeQueryValue(uploadId)}`;
}

/**
 * RFC 3986 percent-encoding that matches aws4fetch's canonical query exactly.
 *
 * Two encoders have to agree here: this one (which produces the bytes on the
 * wire) and aws4fetch's `encodeRfc3986(encodeURIComponent(v))` (which produces
 * the string that gets signed, after `URL` has decoded our output again).
 * `encodeURIComponent` leaves `!'()*` alone where aws4fetch escapes them, so an
 * uploadId containing one would be signed differently from how it is sent — a
 * 403 that only some S3 implementations would ever produce. `URLSearchParams`
 * is not usable for the same reason (it emits `+` for space and leaves `*`).
 */
export function encodeQueryValue(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

// --- Signing -----------------------------------------------------------------

/**
 * `X-Amz-Expires` is set before signing because aws4fetch only fills in its own
 * default (86400 — far longer than SPEC §15.2 allows) when the parameter is
 * absent. Only `host` ends up in `X-Amz-SignedHeaders`, so the client is free to
 * send `Content-Type` and friends on the presigned request.
 */
async function signQuery(
  config: BucketConfig,
  cache: Map<string, ArrayBuffer>,
  method: "GET" | "PUT" | "POST" | "DELETE",
  url: string,
): Promise<string> {
  const separator = url.includes("?") ? "&" : "?";
  const signer = new AwsV4Signer({
    method,
    url: `${url}${separator}X-Amz-Expires=${config.expirySeconds}`,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: config.region,
    service: "s3",
    signQuery: true,
    cache,
  });
  const signed = await signer.sign();
  return signed.url.toString();
}
