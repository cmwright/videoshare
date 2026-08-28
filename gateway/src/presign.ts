/**
 * SigV4 query-string presigning for the five multipart operations (SPEC §15.3).
 *
 * The gateway hands the browser a *URL*; the bytes then flow browser↔bucket
 * directly. Nothing here fetches, streams or buffers object data — that is the
 * core invariant of §15 and there is deliberately no code path that could.
 *
 * Two things make this safe to expose to an authenticated but otherwise
 * untrusted caller:
 *
 *  1. Object keys are built here, from a `{22}` id that matched `ID_PATTERN`,
 *     as exactly `{id}/video.bin` or `{id}/meta.json`. The caller supplies the
 *     id, never a key, so no request can be steered at another object.
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

export type SignRequest =
  | { op: "create"; id: string }
  | { op: "part"; id: string; uploadId: string; partNumbers: number[] }
  | { op: "complete"; id: string; uploadId: string }
  | { op: "abort"; id: string; uploadId: string }
  | { op: "put-meta"; id: string };

export type SignResponse =
  | { url: string; method: "POST" | "PUT" | "DELETE" }
  | { urls: { partNumber: number; url: string }[]; method: "PUT" };

export interface Presigner {
  sign(request: SignRequest): Promise<SignResponse>;
}

/** `parseSignRequest` result: either a validated request or the 400 to send back. */
export type ParseResult = { ok: true; request: SignRequest } | { ok: false; error: string };

/**
 * Validates a decoded `POST /api/sign` body (SPEC §15.3). Everything that is not
 * exactly one of the five shapes is a 400 — unknown ops, unknown/misspelled
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

/**
 * One presigner per configuration. The `AwsV4Signer` cache it holds is the
 * derived SigV4 signing key (per secret/date/region/service), so signing a
 * 100-part batch costs one key derivation, not a hundred.
 */
export function createPresigner(config: BucketConfig): Presigner {
  const cache = new Map<string, ArrayBuffer>();

  const presign = (method: "GET" | "PUT" | "POST" | "DELETE", url: string): Promise<string> =>
    signQuery(config, cache, method, url);

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
function objectUrl(config: BucketConfig, objectKey: string): string {
  return `${config.endpoint}/${config.bucket}/${objectKey}`;
}

/** The only two keys this gateway will ever sign for (SPEC §3). */
export function videoKey(id: string): string {
  return `${id}/video.bin`;
}
export function metaKey(id: string): string {
  return `${id}/meta.json`;
}

function videoUrl(config: BucketConfig, id: string): string {
  return objectUrl(config, videoKey(id));
}
function metaUrl(config: BucketConfig, id: string): string {
  return objectUrl(config, metaKey(id));
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
function encodeQueryValue(value: string): string {
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
