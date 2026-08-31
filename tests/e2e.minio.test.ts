/**
 * Round-trip against a real S3-compatible bucket: stream ~20 MB through the real
 * `createUploadSession()` the way the recorder does — one encrypted chunk per S3
 * multipart part, uploaded while "recording" — then read the completed object
 * back the way view.html does: anonymous GETs, Range requests derived from
 * decryptChunkRange, per-chunk AES-GCM decrypt.
 *
 * The whole loop runs twice: once with the MinIO root credentials and once with
 * the write-only uploader key from examples/docker-compose.yml, because
 * multipart create/part/complete/abort must all work under the SPEC §14
 * uploader policy, not just under an admin key. §3's optional `thumb.bin` rides
 * along for the same reason: SPEC §7 claims it "adds nothing to this list" —
 * no new CORS rule, no new IAM action — and the write-only run is what makes
 * that a checked claim rather than a stated one.
 *
 * Needs the local stack from examples/docker-compose.yml and runs only under
 * `E2E=1 npm run test:e2e`.
 */

import { AwsClient } from "aws4fetch";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CHUNK_OVERHEAD,
  CHUNK_SIZE,
  chunkAad,
  decryptBlock,
  decryptChunkRange,
  encryptBlock,
  exportKeyB64,
  generateKey,
  importKeyB64,
  metaAad,
  thumbAad,
} from "../src/crypto";
import { createLocalSigner, createUploadSession, DELETE_ORDER, deleteVideo } from "../src/upload";
import { randomId } from "../src/util";
import type { Settings, VideoMeta } from "../src/types";

const E2E = process.env.E2E === "1";

const ENDPOINT = process.env.E2E_ENDPOINT ?? "http://localhost:9000";
const BUCKET = process.env.E2E_BUCKET ?? "videoshare";
const REGION = process.env.E2E_REGION ?? "us-east-1";

/** What a viewer is given: the bucket, readable without credentials. */
const PUBLIC_BASE_URL = `${ENDPOINT}/${BUCKET}`;

interface Credentials {
  label: string;
  accessKeyId: string;
  secretAccessKey: string;
}

const ROOT: Credentials = {
  label: "root",
  accessKeyId: process.env.E2E_ACCESS_KEY_ID ?? "minioadmin",
  secretAccessKey: process.env.E2E_SECRET_ACCESS_KEY ?? "minioadmin",
};

const UPLOADER: Credentials = {
  label: "write-only uploader",
  accessKeyId: process.env.E2E_UPLOADER_ACCESS_KEY_ID ?? "videoshare-uploader",
  secretAccessKey: process.env.E2E_UPLOADER_SECRET_ACCESS_KEY ?? "videoshare-uploader-secret",
};

/**
 * The optional-IAM contract of SPEC §18.3, as a fixture: the uploader policy
 * with its second statement (`s3:DeleteObject`) dropped. A deployment can
 * legitimately look like this, and Delete video has to fail on it with a
 * sentence that says so rather than quietly becoming a Remove from list.
 * Minted by examples/docker-compose.yml's init job alongside the real one.
 */
const NO_DELETE: Credentials = {
  label: "uploader without s3:DeleteObject",
  accessKeyId: process.env.E2E_NODELETE_ACCESS_KEY_ID ?? "videoshare-nodelete",
  secretAccessKey: process.env.E2E_NODELETE_SECRET_ACCESS_KEY ?? "videoshare-nodelete-secret",
};

/** 20 MiB of plaintext at an 8 MiB chunk size = 3 parts, the last one short. */
const VIDEO_BYTES = 20 * 1024 * 1024;
const FULL_CHUNKS = 2;
const EXPECTED_PARTS = 3;
const CIPHERTEXT_BYTES = VIDEO_BYTES + EXPECTED_PARTS * CHUNK_OVERHEAD;

/** S3 rejects a non-final multipart part smaller than this at CompleteMultipartUpload. */
const MIN_PART_BYTES = 5 * 1024 * 1024;

/**
 * SOI ‖ JFIF APP0 ‖ filler ‖ EOI — shaped like what `canvas.toBlob` hands the
 * recorder, and opaque to everything on this path.
 *
 * A fabricated JPEG is the honest boundary here: Node has no canvas, no
 * `MediaStream` and no `<video>`, so §6's *capture* half cannot run and a real
 * encoded frame would prove nothing extra. What this suite is responsible for
 * starts at `encryptBlock` and ends at the reader's `decryptBlock`.
 */
function jpegShapedBytes(): Uint8Array {
  return Uint8Array.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00,
    ...randomBytes(4096),
    0xff, 0xd9,
  ]);
}

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

/** lib.dom's BodyInit accepts only ArrayBuffer-backed views; nothing here is shared. */
function body(view: Uint8Array): Uint8Array<ArrayBuffer> {
  return view as Uint8Array<ArrayBuffer>;
}

const objectUrl = (key: string): string => `${PUBLIC_BASE_URL}/${key}`;

/** The player's Range header for one encrypted chunk; `end` is exclusive. */
function rangeHeader(range: { start: number; end: number | null }): string {
  return range.end === null ? `bytes=${range.start}-` : `bytes=${range.start}-${range.end - 1}`;
}

function clientFor(creds: Credentials): AwsClient {
  return new AwsClient({
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    region: REGION,
    service: "s3",
  });
}

/** Used for the preflight, for cleanup, and wherever a test has to look at bucket state. */
const rootClient = clientFor(ROOT);

/** Exactly what the recorder's settings panel would hold for this bucket. */
function settingsFor(creds: Credentials): Settings {
  return {
    endpoint: ENDPOINT,
    region: REGION,
    bucket: BUCKET,
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    publicBaseUrl: PUBLIC_BASE_URL,
    quality: "standard",
    codec: "auto",
    videoBitsPerSecond: 2_500_000,
  };
}

// --- Raw multipart calls, for the paths the session API does not expose -------

async function createMultipartUpload(client: AwsClient, objectKey: string): Promise<string> {
  const res = await client.fetch(`${objectUrl(objectKey)}?uploads`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
  });
  const xml = await res.text();
  expect(res.status, `CreateMultipartUpload ${objectKey}: ${xml}`).toBe(200);

  const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(xml)?.[1];
  if (!uploadId) throw new Error(`CreateMultipartUpload returned no UploadId: ${xml}`);
  return uploadId;
}

/** Returns the part's ETag, which CompleteMultipartUpload has to echo back. */
async function uploadPart(
  client: AwsClient,
  objectKey: string,
  uploadId: string,
  partNumber: number,
  data: Uint8Array,
): Promise<string> {
  const url = `${objectUrl(objectKey)}?partNumber=${partNumber}&uploadId=${encodeURIComponent(uploadId)}`;
  const res = await client.fetch(url, { method: "PUT", body: body(data) });
  if (!res.ok) {
    throw new Error(`UploadPart ${partNumber} failed: HTTP ${res.status} ${await res.text()}`);
  }
  const etag = res.headers.get("etag");
  if (!etag) throw new Error(`UploadPart ${partNumber} returned no ETag header`);
  return etag;
}

/**
 * Upload ids of the multipart uploads in progress for `objectKey`. Needs credentials
 * that may list. The prefix is the whole key on purpose: MinIO returns nothing for a
 * directory-shaped prefix like `{id}/`.
 */
async function listMultipartUploads(client: AwsClient, objectKey: string): Promise<string[]> {
  const res = await client.fetch(`${PUBLIC_BASE_URL}/?uploads&prefix=${objectKey}`);
  const xml = await res.text();
  expect(res.status, `ListMultipartUploads ${objectKey}: ${xml}`).toBe(200);
  return [...xml.matchAll(/<Upload>[\s\S]*?<UploadId>([^<]+)<\/UploadId>[\s\S]*?<\/Upload>/g)].map(
    (m) => m[1]!,
  );
}

async function completeMultipartUpload(
  client: AwsClient,
  objectKey: string,
  uploadId: string,
  etags: readonly string[],
): Promise<void> {
  const parts = etags
    .map((etag, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${etag}</ETag></Part>`)
    .join("");
  const res = await client.fetch(`${objectUrl(objectKey)}?uploadId=${encodeURIComponent(uploadId)}`, {
    method: "POST",
    headers: { "content-type": "application/xml" },
    body: `<CompleteMultipartUpload>${parts}</CompleteMultipartUpload>`,
  });
  // S3 can answer 200 with an <Error> body on this call, so the body is checked too.
  const xml = await res.text();
  if (!res.ok || xml.includes("<Error")) {
    throw new Error(`CompleteMultipartUpload failed: HTTP ${res.status} ${xml}`);
  }
}

describe.skipIf(!E2E)("MinIO end-to-end", () => {
  /** Every id the suite created, so afterAll can try to take it back out again. */
  const litter: Array<{ client: AwsClient; id: string }> = [];
  const track = (client: AwsClient, id: string): string => {
    litter.push({ client, id });
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

    const bucket = await rootClient.fetch(`${PUBLIC_BASE_URL}/`, { method: "HEAD" });
    if (bucket.status === 404) {
      throw new Error(`bucket "${BUCKET}" does not exist at ${ENDPOINT} — the compose init job creates it`);
    }
    // 403 just means these credentials are upload-only, which is the point.
    expect([200, 403], `HEAD ${PUBLIC_BASE_URL}/`).toContain(bucket.status);
  });

  afterAll(async () => {
    // Best-effort. The uploader key can delete since §18 — that is the second,
    // optional statement of examples/iam-uploader-policy.json — but the
    // no-delete fixture below deliberately cannot, so fall back to the root key
    // and, if that fails too, say what was left behind rather than silently
    // littering the bucket.
    const tryDelete = async (client: AwsClient, objectKey: string): Promise<boolean> => {
      const res = await client.fetch(objectUrl(objectKey), { method: "DELETE" }).catch(() => undefined);
      return res !== undefined && res.ok;
    };

    const stranded = new Set<string>();
    for (const { client, id } of litter) {
      for (const objectKey of [`${id}/video.bin`, `${id}/meta.json`, `${id}/thumb.bin`]) {
        const gone = (await tryDelete(client, objectKey)) || (await tryDelete(rootClient, objectKey));
        if (!gone) stranded.add(id);
      }
    }
    if (stranded.size > 0) {
      const paths = [...stranded].map((id) => `${id}/`).join(", ");
      const commands = [...stranded]
        .map((id) => `      mc rm --recursive --force local/${BUCKET}/${id}/`)
        .join("\n");
      console.warn(`[e2e] could not delete ${paths} with these credentials. Remove them with:\n${commands}`);
    }
  });

  describe.each([ROOT, UPLOADER])("streaming upload with $label credentials", (creds: Credentials) => {
    const client = clientFor(creds);
    const settings = settingsFor(creds);

    const id = randomId();
    const videoKey = `${id}/video.bin`;
    const metaKey = `${id}/meta.json`;
    const thumbKey = `${id}/thumb.bin`;

    let plain: Uint8Array;
    let key: CryptoKey;
    let keyB64: string;
    let meta: VideoMeta;
    /** §3's optional block, already encrypted the way §6 hands it to `finish()`. */
    let jpeg: Uint8Array;
    let thumbBlock: Uint8Array;

    beforeAll(async () => {
      track(client, id);

      plain = randomBytes(VIDEO_BYTES);
      key = await generateKey();
      keyB64 = await exportKeyB64(key);
      jpeg = jpegShapedBytes();
      // `upload.ts` never sees the plaintext (§7): the recorder encrypts on
      // capture, and `finish()` re-sends exactly these bytes.
      thumbBlock = await encryptBlock(key, thumbAad(id), jpeg);
      meta = {
        v: 1,
        title: "e2e streaming round-trip",
        mimeType: "video/webm;codecs=vp9,opus",
        durationMs: 12_345,
        totalBytes: plain.length,
        chunkSize: CHUNK_SIZE,
        chunkCount: Math.ceil(plain.length / CHUNK_SIZE),
        createdAt: new Date().toISOString(),
      };

      expect(meta.chunkCount, "20 MiB at an 8 MiB chunk size").toBe(EXPECTED_PARTS);
    });

    it("uploads each chunk as a part while recording, then completes and writes meta", async () => {
      const progress: number[] = [];
      const session = await createUploadSession(settings, id, key, (n) => progress.push(n));

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

      // Finish flushes the short remainder as the final part, completes, puts
      // thumb.bin, then puts meta (§7's order).
      const result = await session.finish(plain.subarray(FULL_CHUNKS * CHUNK_SIZE), meta, thumbBlock);

      expect(result.id).toBe(id);
      // No `location` in Node, so the link degrades to the relative form (SPEC §2 shape).
      expect(result.link).toBe(`view.html#${id}.${keyB64}`);
      // Every part landed, so this is exact: a part counted twice (a re-sent one,
      // say) would still satisfy a "at least this much" assertion. It also pins
      // §7's rule that the thumbnail is *not* counted — `uploadedBytes` is the
      // recording's progress, and a 4 KB image arriving at the end is not
      // progress the user is waiting on.
      expect(session.uploadedBytes, "the final part counts too, exactly once").toBe(CIPHERTEXT_BYTES);

      expect(progress.length, "progress is reported as parts land").toBeGreaterThanOrEqual(FULL_CHUNKS);
      for (let i = 1; i < progress.length; i++) {
        expect(progress[i]!, "progress never goes backwards").toBeGreaterThanOrEqual(progress[i - 1]!);
      }
      expect(progress.at(-1)!, "progress ends at what was uploaded").toBe(session.uploadedBytes);

      // meta last: a video counts as complete only once its meta exists.
      for (const objKey of [videoKey, metaKey]) {
        const head = await fetch(objectUrl(objKey), { method: "HEAD" });
        expect(head.status, `HEAD ${objKey}`).toBe(200);
      }

      // §7 gives the thumbnail PUT no way to fail the finish: it happens inside a
      // try/catch that swallows everything and at most console.warn's. So a
      // policy that refused it would still leave `finish()` returning a share
      // link, and this HEAD is the only thing standing between that and a
      // silently thumbnail-less deployment. Which is exactly the claim worth
      // checking under the write-only key: §7 says the thumbnail adds no IAM
      // action, so PutObject alone must already authorize thumb.bin.
      const thumbHead = await fetch(objectUrl(thumbKey), { method: "HEAD" });
      expect(
        thumbHead.status,
        `HEAD ${thumbKey} — ${creds.label} credentials must be allowed to PUT it (SPEC §7)`,
      ).toBe(200);
      expect(Number(thumbHead.headers.get("content-length")), "one §4 block, not re-encrypted").toBe(
        jpeg.length + CHUNK_OVERHEAD,
      );

      const head = await fetch(objectUrl(videoKey), { method: "HEAD" });
      expect(Number(head.headers.get("content-length")), "completed object is the §4 concatenation").toBe(
        CIPHERTEXT_BYTES,
      );
      // A multipart object's ETag ends in "-{partCount}": proof the three chunks
      // really arrived as three parts, not as one whole-file PUT after recording.
      expect(
        (head.headers.get("etag") ?? "").replace(/"/g, ""),
        "video.bin must be a 3-part multipart object",
      ).toMatch(new RegExp(`-${EXPECTED_PARTS}$`));
    });

    it("serves meta.json to an anonymous reader and decrypts it with the link key", async () => {
      const res = await fetch(objectUrl(metaKey));
      expect(res.status).toBe(200);

      const viewerKey = await importKeyB64(keyB64);
      const block = new Uint8Array(await res.arrayBuffer());
      expect(block.length).toBe(new TextEncoder().encode(JSON.stringify(meta)).length + CHUNK_OVERHEAD);

      const decoded = new TextDecoder().decode(await decryptBlock(viewerKey, metaAad(id), block));
      expect(JSON.parse(decoded)).toEqual(meta);
    });

    /**
     * §3's thumbnail over the legacy, credentials-in-the-browser path: written
     * by the real `UploadSession.finish()` with a direct SigV4 PUT, read back
     * the way a library row (§17.3) and the video page's poster (§17.4) read it
     * — one anonymous GET of `{id}/thumb.bin`, decrypted with the key out of the
     * link fragment and nothing else.
     */
    it("serves thumb.bin to an anonymous reader and decrypts it with the link key", async () => {
      const res = await fetch(objectUrl(thumbKey));
      expect(res.status, `anonymous GET ${thumbKey}`).toBe(200);

      const stored = new Uint8Array(await res.arrayBuffer());
      expectBytesEqual(stored, thumbBlock, "thumbnail ciphertext survived the round trip");

      const viewerKey = await importKeyB64(keyB64);
      expectBytesEqual(await decryptBlock(viewerKey, thumbAad(id), stored), jpeg, "thumbnail plaintext");

      // And it is bound to this video and to the thumbnail role (§4): the same
      // block under another id's AAD, or under this id's meta AAD, is
      // unreadable — which is what stops a thumb.bin copied between videos from
      // silently becoming that video's picture.
      await expect(decryptBlock(viewerKey, thumbAad(randomId()), stored)).rejects.toThrow();
      await expect(decryptBlock(viewerKey, metaAad(id), stored)).rejects.toThrow();
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
        const plainStart = i * meta.chunkSize;
        const expectedPlain = plain.subarray(plainStart, Math.min(plainStart + meta.chunkSize, plain.length));
        expect(block.length, `chunk ${i} block size`).toBe(expectedPlain.length + CHUNK_OVERHEAD);

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
      expectBytesEqual(rebuilt, plain, "video round-trip");
    });

    it("abort() throws the pending upload away, leaving nothing to find", async () => {
      const abortedId = track(client, randomId());
      const abortedKey = `${abortedId}/video.bin`;
      const session = await createUploadSession(settings, abortedId, await generateKey());

      await session.addChunk(plain.subarray(0, CHUNK_SIZE));
      expect(session.uploadedBytes, "one part is in flight").toBe(CHUNK_SIZE + CHUNK_OVERHEAD);
      // Listed with the root key on purpose: the uploader key may not list, and
      // abort() is best-effort (it warns instead of throwing), so this is the only
      // way to tell a real abort from a silently rejected one.
      expect(await listMultipartUploads(rootClient, abortedKey), "the upload is in progress").toHaveLength(1);

      await session.abort();

      expect(
        await listMultipartUploads(rootClient, abortedKey),
        `${creds.label} credentials must be allowed to AbortMultipartUpload (SPEC §14)`,
      ).toEqual([]);

      for (const objectKey of [abortedKey, `${abortedId}/meta.json`]) {
        const res = await fetch(objectUrl(objectKey));
        expect(res.status, `GET ${objectKey} after abort()`).toBe(404);
      }
    });

    it("lets a re-sent part number overwrite the earlier attempt", async () => {
      // The degraded-retry path of SPEC §7: a part that failed mid-recording is
      // re-sent under the same part number by finish(), and the last one wins.
      const retryId = track(client, randomId());
      const objectKey = `${retryId}/video.bin`;

      const uploadId = await createMultipartUpload(client, objectKey);
      const failed = randomBytes(MIN_PART_BYTES);
      const resent = randomBytes(MIN_PART_BYTES);
      const final = randomBytes(4096);

      await uploadPart(client, objectKey, uploadId, 1, failed);
      const etag1 = await uploadPart(client, objectKey, uploadId, 1, resent);
      const etag2 = await uploadPart(client, objectKey, uploadId, 2, final);
      await completeMultipartUpload(client, objectKey, uploadId, [etag1, etag2]);

      const res = await fetch(objectUrl(objectKey));
      expect(res.status).toBe(200);

      const bytes = new Uint8Array(await res.arrayBuffer());
      expect(bytes.length, "only one copy of part 1 is kept").toBe(resent.length + final.length);
      expectBytesEqual(bytes.subarray(0, resent.length), resent, "re-sent part 1 replaced the failed one");
      expectBytesEqual(bytes.subarray(resent.length), final, "final part");
    });
  });

  /**
   * SPEC §18, the legacy half: the browser signs three DELETEs with the same
   * credentials it uploaded with, and the objects are gone from the bucket for
   * everyone — which is the only thing that makes "delete" mean more than
   * "forget locally".
   */
  describe("deleteVideo — SPEC §18 over the credentials-in-the-browser path", () => {
    /**
     * One small video through the real upload path: a single short part, meta
     * and §3's thumbnail. Small because what is under test is the removal, and
     * the 20 MB streaming round trip above already covers the arrival.
     */
    async function uploadSmallVideo(creds: Credentials, id: string): Promise<void> {
      const key = await generateKey();
      const plain = randomBytes(64 * 1024);
      const meta: VideoMeta = {
        v: 1,
        title: "e2e delete round-trip",
        mimeType: "video/webm;codecs=vp9,opus",
        durationMs: 2_000,
        totalBytes: plain.length,
        chunkSize: CHUNK_SIZE,
        chunkCount: 1,
        createdAt: new Date().toISOString(),
      };

      const session = await createUploadSession(settingsFor(creds), id, key);
      await session.finish(plain, meta, await encryptBlock(key, thumbAad(id), jpegShapedBytes()));
    }

    /** What an anonymous reader — a share link, in other words — sees right now. */
    async function anonymousStatuses(id: string): Promise<number[]> {
      return Promise.all(
        DELETE_ORDER.map(async (object) => (await fetch(objectUrl(`${id}/${object}`))).status),
      );
    }

    it("removes all three objects with the recorder's own credentials", async () => {
      const id = track(rootClient, randomId());
      await uploadSmallVideo(UPLOADER, id);
      expect(await anonymousStatuses(id), "all three objects are there first").toEqual([
        200, 200, 200,
      ]);

      await deleteVideo(createLocalSigner(settingsFor(UPLOADER)), id);

      // Every copy of the share link is now the player's "video not found"
      // (§18.5): meta.json is what it fetches first, and it is gone.
      expect(await anonymousStatuses(id), "nothing is left for a share link to find").toEqual([
        404, 404, 404,
      ]);
    });

    it("succeeds again on a video that is already gone", async () => {
      // §18.1's "404 is success" rule, which is what makes a retry after a
      // partial failure safe — and what lets thumb.bin be optional (§3), since
      // a video recorded before thumbnails existed deletes exactly like one
      // that has one.
      const id = track(rootClient, randomId());
      await uploadSmallVideo(UPLOADER, id);

      const signer = createLocalSigner(settingsFor(UPLOADER));
      await deleteVideo(signer, id);
      await expect(deleteVideo(signer, id)).resolves.toBeUndefined();
      // And on an id that never existed at all.
      await expect(deleteVideo(signer, randomId())).resolves.toBeUndefined();
    });

    it("fails honestly on credentials that lack s3:DeleteObject", async () => {
      const id = track(rootClient, randomId());
      // The positive control: these credentials are real and may write. If this
      // is what fails, the fixture user is missing — re-run the compose init
      // job (`docker compose -f examples/docker-compose.yml up minio-init`).
      await uploadSmallVideo(NO_DELETE, id);
      expect(await anonymousStatuses(id), `${NO_DELETE.label} could not upload`).toEqual([
        200, 200, 200,
      ]);

      const signer = createLocalSigner(settingsFor(NO_DELETE));
      // The supported configuration of §18.3: the delete is refused, the reason
      // is named, and the objects are all still there — nothing is silently
      // downgraded to a Remove from list.
      await expect(deleteVideo(signer, id)).rejects.toThrow(/HTTP 403/);
      await expect(deleteVideo(signer, id)).rejects.toThrow(/s3:DeleteObject is optional/);
      await expect(deleteVideo(signer, id)).rejects.toThrow(/docs\/storage-setup\.md/);

      expect(
        await anonymousStatuses(id),
        "a refused delete leaves the video exactly where it was",
      ).toEqual([200, 200, 200]);
    });
  });

  describe("anonymous access", () => {
    const id = randomId();
    const objectKey = `${id}/meta.json`;
    const payload = randomBytes(64);

    beforeAll(async () => {
      track(rootClient, id);
      const res = await rootClient.fetch(objectUrl(objectKey), {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: body(payload),
      });
      expect(res.status, `PUT ${objectKey}`).toBe(200);
    });

    it("serves an object to a reader with no credentials", async () => {
      const res = await fetch(objectUrl(objectKey));
      expect(res.status).toBe(200);
      expectBytesEqual(new Uint8Array(await res.arrayBuffer()), payload, "anonymous GET body");
    });

    it("rejects a PUT without credentials", async () => {
      const res = await fetch(objectUrl(`${randomId()}/video.bin`), {
        method: "PUT",
        body: new Uint8Array([1, 2, 3]),
        headers: { "content-type": "application/octet-stream" },
      });
      expect(res.status).toBe(403);
    });

    it("rejects starting a multipart upload without credentials", async () => {
      const res = await fetch(`${objectUrl(`${randomId()}/video.bin`)}?uploads`, { method: "POST" });
      expect(res.status, "public read must not imply multipart write").toBe(403);
    });

    it("returns 404 for an object that does not exist", async () => {
      const res = await fetch(objectUrl(`${randomId()}/meta.json`));
      expect(res.status).toBe(404);
    });

    it("denies anonymous bucket listing", async () => {
      const res = await fetch(`${PUBLIC_BASE_URL}/?list-type=2`);
      expect(res.status, "public read must not imply ListBucket").toBe(403);
    });
  });
});
