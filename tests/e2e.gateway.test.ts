/**
 * The gateway path, end to end (docs/SPEC.md §15.6).
 *
 * Everything real is here at once: the Node adapter listening on a real socket
 * with MinIO's credentials, a real RS256 key pair behind a real JWKS endpoint,
 * real Google-shaped ID tokens, the recorder's own `GatewaySigner` driving the
 * real `createUploadSession`, and finally view.html's anonymous ranged reads
 * decrypting the result back to the bytes we started with. No stubs, and no test
 * bypass in the gateway — `OIDC_JWKS_URL`/`OIDC_ISSUER` only move the *provider*,
 * so the production verification path runs verbatim.
 *
 * The invariant this exists to police (SPEC §15): **the gateway never carries
 * object bytes.** `fetch` is instrumented below and weighs both directions —
 * request bodies and the actual bytes of every response — so the upload can
 * assert that ~20 MiB crossed the wire to MinIO while the gateway exchanged only
 * kilobytes of JSON. A proxy fallback in either direction, uploading through the
 * gateway or streaming a video back out of it, turns this test red.
 *
 * Needs the local stack from examples/docker-compose.yml and runs only under
 * `E2E=1 npm run test:e2e`.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { AwsClient } from "aws4fetch";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GatewayEnv } from "../gateway/src/core";
import { startGateway } from "../gateway/src/node";
import {
  CHUNK_OVERHEAD,
  CHUNK_SIZE,
  chunkAad,
  decryptBlock,
  decryptChunkRange,
  exportKeyB64,
  generateKey,
  importKeyB64,
  metaAad,
} from "../src/crypto";
import { createGatewaySigner, createUploadSession } from "../src/upload";
import type { Signer } from "../src/upload";
import { randomId } from "../src/util";
import type { VideoMeta } from "../src/types";

const E2E = process.env.E2E === "1";

const ENDPOINT = process.env.E2E_ENDPOINT ?? "http://localhost:9000";
const BUCKET = process.env.E2E_BUCKET ?? "videoshare";
const REGION = process.env.E2E_REGION ?? "us-east-1";

/** What a viewer is given: the bucket, readable without credentials. */
const PUBLIC_BASE_URL = `${ENDPOINT}/${BUCKET}`;

/**
 * The gateway holds the *root* keys on purpose. In gateway mode nothing else
 * ever sees them, which is the whole point of §15 — so the deployment that keeps
 * them furthest from a browser is the one worth testing.
 */
const ROOT_ACCESS_KEY_ID = process.env.E2E_ACCESS_KEY_ID ?? "minioadmin";
const ROOT_SECRET_ACCESS_KEY = process.env.E2E_SECRET_ACCESS_KEY ?? "minioadmin";

const CLIENT_ID = "1234567890-videoshare.apps.googleusercontent.com";
const ISSUER = "https://accounts.test.invalid";
const KID = "videoshare-e2e-key";

const UPLOADER_EMAIL = "recorder@team.example.com";
const OUTSIDER_EMAIL = "stranger@example.org";

/** 20 MiB of plaintext at an 8 MiB chunk size = 3 parts, the last one short. */
const VIDEO_BYTES = 20 * 1024 * 1024;
const FULL_CHUNKS = 2;
const EXPECTED_PARTS = 3;
const CIPHERTEXT_BYTES = VIDEO_BYTES + EXPECTED_PARTS * CHUNK_OVERHEAD;

/**
 * Everything the gateway exchanges is small JSON: a handful of sign calls, each
 * answering with at most 100 URLs of a few hundred bytes. Twenty megabytes of
 * video is three orders of magnitude past this.
 */
const GATEWAY_TRAFFIC_CEILING = 128 * 1024;

// --- Helpers -----------------------------------------------------------------

/** crypto.getRandomValues rejects any single request larger than 65536 bytes. */
function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let off = 0; off < n; off += 65536) {
    crypto.getRandomValues(out.subarray(off, Math.min(off + 65536, n)));
  }
  return out;
}

function expectBytesEqual(actual: Uint8Array, expected: Uint8Array, label: string): void {
  expect(actual.length, `${label}: length`).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) {
      expect.fail(`${label}: first mismatch at byte ${i} (${actual[i]} !== ${expected[i]})`);
    }
  }
}

const objectUrl = (key: string): string => `${PUBLIC_BASE_URL}/${key}`;

/** The player's Range header for one encrypted chunk; `end` is exclusive. */
function rangeHeader(range: { start: number; end: number | null }): string {
  return range.end === null ? `bytes=${range.start}-` : `bytes=${range.start}-${range.end - 1}`;
}

const rootClient = new AwsClient({
  accessKeyId: ROOT_ACCESS_KEY_ID,
  secretAccessKey: ROOT_SECRET_ACCESS_KEY,
  region: REGION,
  service: "s3",
});

/** Upload ids of the multipart uploads still in progress for `objectKey`. */
async function listMultipartUploads(objectKey: string): Promise<string[]> {
  const res = await rootClient.fetch(`${PUBLIC_BASE_URL}/?uploads&prefix=${objectKey}`);
  const xml = await res.text();
  expect(res.status, `ListMultipartUploads ${objectKey}: ${xml}`).toBe(200);
  return [...xml.matchAll(/<Upload>[\s\S]*?<UploadId>([^<]+)<\/UploadId>[\s\S]*?<\/Upload>/g)].map(
    (m) => m[1]!,
  );
}

// --- The wire tap ------------------------------------------------------------

interface WireEntry {
  origin: string;
  method: string;
  requestBytes: number;
  responseBytes: number;
}

const wire: WireEntry[] = [];
let realFetch: typeof fetch;

function bodyBytes(body: unknown): number {
  if (body === undefined || body === null) return 0;
  if (typeof body === "string") return new TextEncoder().encode(body).length;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  return 0;
}

function totals(origin: string): { requests: number; bytes: number } {
  const rows = wire.filter((entry) => entry.origin === origin);
  return {
    requests: rows.length,
    bytes: rows.reduce((sum, entry) => sum + entry.requestBytes + entry.responseBytes, 0),
  };
}

// --- Identity provider -------------------------------------------------------

let signingKey: CryptoKey;
let jwksServer: Server;
let jwksUrl: string;

function mintToken(email: string, expiresIn = "5m"): Promise<string> {
  return new SignJWT({ email, email_verified: true, sub: "112233445566778899000" })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(ISSUER)
    .setAudience(CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(signingKey);
}

/** A signer holding one fixed token: no silent re-auth, so a rejection stays rejected. */
function signerFor(token: string): Signer {
  return createGatewaySigner({
    gatewayUrl,
    getToken: () => token,
    refreshToken: () => Promise.resolve(token),
  });
}

// --- The gateway under test --------------------------------------------------

let gateway: Server;
let gatewayOrigin: string;
let gatewayUrl: string;

describe.skipIf(!E2E)("gateway end-to-end", () => {
  /** Every id the suite created, so afterAll can take it back out again. */
  const litter: string[] = [];
  const track = (id: string): string => {
    litter.push(id);
    return id;
  };

  beforeAll(async () => {
    const live = await fetch(`${ENDPOINT}/minio/health/live`).catch((cause: unknown) => {
      throw new Error(
        `cannot reach MinIO at ${ENDPOINT} — start it with ` +
          "`docker compose -f examples/docker-compose.yml up -d`",
        { cause },
      );
    });
    expect(live.status, "MinIO health check").toBeLessThan(400);

    // A real RS256 key pair behind a real JWKS endpoint (SPEC §15.6).
    const pair = await generateKeyPair("RS256", { extractable: true });
    signingKey = pair.privateKey;
    const publicJwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: KID, alg: "RS256", use: "sig" };

    jwksServer = createServer((req, res) => {
      if (req.url !== "/jwks") {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "max-age=300" });
      res.end(JSON.stringify({ keys: [publicJwk] }));
    });
    await new Promise<void>((resolve) => jwksServer.listen(0, "127.0.0.1", resolve));
    jwksUrl = `http://127.0.0.1:${(jwksServer.address() as AddressInfo).port}/jwks`;

    const env: GatewayEnv = {
      BUCKET_ENDPOINT: ENDPOINT,
      BUCKET_NAME: BUCKET,
      BUCKET_REGION: REGION,
      BUCKET_ACCESS_KEY_ID: ROOT_ACCESS_KEY_ID,
      BUCKET_SECRET_ACCESS_KEY: ROOT_SECRET_ACCESS_KEY,
      PUBLIC_BASE_URL: PUBLIC_BASE_URL,
      GOOGLE_CLIENT_ID: CLIENT_ID,
      // A @domain suffix entry, so the whitelist is exercised the way one is written.
      ALLOWED_EMAILS: "@team.example.com",
      ALLOWED_ORIGINS: "http://localhost:8080",
      PRESIGN_EXPIRY_SECONDS: "900",
      OIDC_JWKS_URL: jwksUrl,
      OIDC_ISSUER: ISSUER,
    };

    gateway = await startGateway(env, 0);
    gatewayOrigin = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
    gatewayUrl = `${gatewayOrigin}/api`;

    // Instrumented last, so the tap sees only what the tests do.
    realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const href =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      const requestBytes = bodyBytes(init?.body);
      const res = await realFetch(input, init);
      // Weighed, not declared: the Node adapter answers chunked with no
      // Content-Length, so reading the header would score every gateway response
      // as zero — and a gateway that streamed object bytes *back* would sail
      // under the ceiling below unnoticed. The clone leaves `res` unread.
      const responseBytes = (await res.clone().arrayBuffer()).byteLength;
      wire.push({ origin: new URL(href).origin, method, requestBytes, responseBytes });
      return res;
    }) as typeof fetch;
  });

  afterAll(async () => {
    if (realFetch) globalThis.fetch = realFetch;

    for (const id of litter) {
      for (const key of [`${id}/video.bin`, `${id}/meta.json`]) {
        await rootClient.fetch(objectUrl(key), { method: "DELETE" }).catch(() => undefined);
      }
    }
    const close = (server: Server | undefined): Promise<void> =>
      server
        ? new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
        : Promise.resolve();
    await close(gateway);
    await close(jwksServer);
  });

  it("serves its public config over HTTP", async () => {
    const res = await fetch(`${gatewayUrl}/config`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      gateway: true,
      publicBaseUrl: PUBLIC_BASE_URL,
      googleClientId: CLIENT_ID,
    });
  });

  it("hands out no credentials of its own", async () => {
    const res = await fetch(`${gatewayUrl}/config`);
    const text = await res.text();
    expect(text).not.toContain(ROOT_SECRET_ACCESS_KEY);
    expect(text).not.toContain(ROOT_ACCESS_KEY_ID);
  });

  describe("a whole recording, uploaded with presigned URLs only", () => {
    const id = randomId();
    const videoKey = `${id}/video.bin`;
    const metaKey = `${id}/meta.json`;

    let plain: Uint8Array;
    let key: CryptoKey;
    let keyB64: string;
    let meta: VideoMeta;

    beforeAll(async () => {
      track(id);
      plain = randomBytes(VIDEO_BYTES);
      key = await generateKey();
      keyB64 = await exportKeyB64(key);
      meta = {
        v: 1,
        title: "gateway e2e round-trip",
        mimeType: "video/webm;codecs=vp9,opus",
        durationMs: 12_345,
        totalBytes: plain.length,
        chunkSize: CHUNK_SIZE,
        chunkCount: Math.ceil(plain.length / CHUNK_SIZE),
        createdAt: new Date().toISOString(),
      };
      expect(meta.chunkCount, "20 MiB at an 8 MiB chunk size").toBe(EXPECTED_PARTS);
    });

    it("streams every part through a presigned URL, completes, and writes meta", async () => {
      wire.length = 0;

      const signer = signerFor(await mintToken(UPLOADER_EMAIL));
      expect(signer.kind, "this is the gateway path, not the credentials-in-the-browser one").toBe(
        "gateway",
      );

      const progress: number[] = [];
      const session = await createUploadSession(signer, id, key, (n) => progress.push(n));
      expect(session.uploadedBytes, "nothing is uploaded before the first chunk").toBe(0);

      // What record.ts does mid-recording: hand over one CHUNK_SIZE slice at a time.
      for (let i = 0; i < FULL_CHUNKS; i++) {
        await session.addChunk(plain.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE));

        expect(session.uploadedBytes, `ciphertext confirmed after part ${i + 1}`).toBe(
          (i + 1) * (CHUNK_SIZE + CHUNK_OVERHEAD),
        );
        const early = await fetch(objectUrl(videoKey), { method: "HEAD" });
        expect(early.status, "parts must not be visible before CompleteMultipartUpload").toBe(404);
      }

      const result = await session.finish(plain.subarray(FULL_CHUNKS * CHUNK_SIZE), meta);

      expect(result.id).toBe(id);
      // No `location` in Node, so the link degrades to the relative form (SPEC §2 shape).
      expect(result.link).toBe(`view.html#${id}.${keyB64}`);
      expect(session.uploadedBytes, "the final part counts too, exactly once").toBe(CIPHERTEXT_BYTES);
      expect(progress.at(-1)!, "progress ends at what was uploaded").toBe(session.uploadedBytes);

      // meta last: a video counts as complete only once its meta exists.
      for (const objKey of [videoKey, metaKey]) {
        const head = await fetch(objectUrl(objKey), { method: "HEAD" });
        expect(head.status, `HEAD ${objKey}`).toBe(200);
      }

      const head = await fetch(objectUrl(videoKey), { method: "HEAD" });
      expect(Number(head.headers.get("content-length")), "the §4 concatenation").toBe(CIPHERTEXT_BYTES);
      // A multipart object's ETag ends in "-{partCount}": proof the chunks really
      // went up as parts, each through its own presigned PUT.
      expect(
        (head.headers.get("etag") ?? "").replace(/"/g, ""),
        "video.bin must be a 3-part multipart object",
      ).toMatch(new RegExp(`-${EXPECTED_PARTS}$`));
    });

    it("moved every byte browser↔bucket and none of them through the gateway", async () => {
      const bucketOrigin = new URL(ENDPOINT).origin;
      const toGateway = totals(gatewayOrigin);
      const toBucket = totals(bucketOrigin);

      expect(toGateway.requests, "the gateway was used").toBeGreaterThan(0);
      expect(toBucket.requests, "the bucket was written to directly").toBeGreaterThan(0);

      expect(
        toBucket.bytes,
        "the whole ciphertext went straight to the bucket",
      ).toBeGreaterThanOrEqual(CIPHERTEXT_BYTES);

      // The one invariant of SPEC §15 that must never be relaxed: presigned URLs
      // or nothing. A proxy mode would show up here as megabytes.
      expect(
        toGateway.bytes,
        `the gateway exchanged ${toGateway.bytes} bytes; it must only ever pass URLs, never object data`,
      ).toBeLessThan(GATEWAY_TRAFFIC_CEILING);
      expect(toGateway.bytes * 10, "the gateway is nowhere near the data path").toBeLessThan(
        toBucket.bytes,
      );
    });

    it("serves meta.json to an anonymous reader and decrypts it with the link key", async () => {
      const res = await fetch(objectUrl(metaKey));
      expect(res.status).toBe(200);

      const viewerKey = await importKeyB64(keyB64);
      const block = new Uint8Array(await res.arrayBuffer());
      const decoded = new TextDecoder().decode(await decryptBlock(viewerKey, metaAad(id), block));
      expect(JSON.parse(decoded)).toEqual(meta);
    });

    it("Range-fetches every chunk anonymously and rebuilds the original bytes", async () => {
      const viewerKey = await importKeyB64(keyB64);
      const chunks: Uint8Array[] = [];

      for (let i = 0; i < meta.chunkCount; i++) {
        const range = decryptChunkRange(i, meta.chunkCount, meta);
        const res = await fetch(objectUrl(videoKey), { headers: { Range: rangeHeader(range) } });

        expect(res.status, `chunk ${i} must be a partial response`).toBe(206);
        expect(res.headers.get("content-range")).toBe(
          `bytes ${range.start}-${(range.end ?? CIPHERTEXT_BYTES) - 1}/${CIPHERTEXT_BYTES}`,
        );

        const block = new Uint8Array(await res.arrayBuffer());
        chunks.push(await decryptBlock(viewerKey, chunkAad(id, i), block));
      }

      expect(chunks[EXPECTED_PARTS - 1]!.length, "final chunk is short").toBeLessThan(CHUNK_SIZE);

      const rebuilt = new Uint8Array(meta.totalBytes);
      let off = 0;
      for (const chunk of chunks) {
        rebuilt.set(chunk, off);
        off += chunk.length;
      }
      expect(off, "decrypted length matches meta.totalBytes").toBe(meta.totalBytes);
      expectBytesEqual(rebuilt, plain, "video round-trip through the gateway");
    });
  });

  it("abandons a discarded recording through a presigned DELETE", async () => {
    const id = track(randomId());
    const videoKey = `${id}/video.bin`;
    const signer = signerFor(await mintToken(UPLOADER_EMAIL));

    const session = await createUploadSession(signer, id, await generateKey());
    await session.addChunk(randomBytes(CHUNK_SIZE));
    expect(session.uploadedBytes, "one part is in flight").toBe(CHUNK_SIZE + CHUNK_OVERHEAD);
    expect(await listMultipartUploads(videoKey), "the upload is in progress").toHaveLength(1);

    await session.abort();

    expect(
      await listMultipartUploads(videoKey),
      "AbortMultipartUpload must work through a presigned URL",
    ).toEqual([]);
    for (const key of [videoKey, `${id}/meta.json`]) {
      const res = await fetch(objectUrl(key));
      expect(res.status, `GET ${key} after abort()`).toBe(404);
    }
  });

  describe("tokens the gateway must refuse", () => {
    it("will not sign for a verified address that is not whitelisted", async () => {
      const id = randomId();
      const signer = signerFor(await mintToken(OUTSIDER_EMAIL));

      await expect(createUploadSession(signer, id, await generateKey())).rejects.toThrow(
        /ALLOWED_EMAILS/,
      );
      // Nothing was started on that account's behalf.
      expect(await listMultipartUploads(`${id}/video.bin`)).toEqual([]);
      expect((await fetch(objectUrl(`${id}/video.bin`))).status).toBe(404);
    });

    it("answers a non-whitelisted token with 403, not 401", async () => {
      const res = await fetch(`${gatewayUrl}/sign`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await mintToken(OUTSIDER_EMAIL)}`,
        },
        body: JSON.stringify({ op: "create", id: randomId() }),
      });
      expect(res.status, "a valid identity that simply may not upload").toBe(403);
      expect((await res.json()) as { error: string }).toHaveProperty("error");
    });

    it("will not sign for an expired token", async () => {
      const signer = signerFor(await mintToken(UPLOADER_EMAIL, "-1m"));
      await expect(createUploadSession(signer, randomId(), await generateKey())).rejects.toThrow(
        /sign in|signed in/i,
      );
    });

    it("will not sign without a token at all", async () => {
      const res = await fetch(`${gatewayUrl}/sign`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "create", id: randomId() }),
      });
      expect(res.status).toBe(401);
    });

    it("refuses a browser origin it was not configured for", async () => {
      const res = await fetch(`${gatewayUrl}/config`, {
        headers: { origin: "https://evil.example.net" },
      });
      expect(res.headers.get("access-control-allow-origin")).not.toBe("https://evil.example.net");
      expect(res.status).toBe(403);
    });
  });
});
