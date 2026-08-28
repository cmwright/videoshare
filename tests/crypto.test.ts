import { describe, expect, it } from "vitest";
import {
  analyticsAad,
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
} from "../src/crypto";
import { b64urlDecode, b64urlEncode, randomId } from "../src/util";
import type { VideoMeta } from "../src/types";

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

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * The bytes of `{id}/video.bin`: plaintext split into `chunkSize` chunks, each
 * encrypted as its own block, concatenated in order. The streaming uploader
 * produces exactly this one chunk at a time (each block is one multipart part),
 * so the tests build it the same way rather than through a helper in src/.
 */
async function encryptChunks(
  key: CryptoKey,
  id: string,
  plain: Uint8Array,
  chunkSize: number = CHUNK_SIZE,
): Promise<Uint8Array> {
  const chunkCount = Math.max(1, Math.ceil(plain.length / chunkSize));
  const blocks: Uint8Array[] = [];
  for (let i = 0; i < chunkCount; i++) {
    const start = i * chunkSize;
    blocks.push(await encryptBlock(key, chunkAad(id, i), plain.subarray(start, start + chunkSize)));
  }
  return concat(blocks);
}

function makeMeta(totalBytes: number, chunkCount: number, chunkSize: number = CHUNK_SIZE): VideoMeta {
  return {
    v: 1,
    title: "Sprint demo",
    mimeType: "video/webm;codecs=vp9,opus",
    durationMs: 93_250,
    totalBytes,
    chunkSize,
    chunkCount,
    createdAt: "2026-08-27T21:04:00.000Z",
  };
}

const B64URL_ALPHABET = /^[A-Za-z0-9_-]*$/;

/** S3 rejects any non-final multipart part below this at CompleteMultipartUpload. */
const MIN_PART_BYTES = 5 * 1024 * 1024;

describe("format constants", () => {
  it("matches the SPEC values", () => {
    expect(CHUNK_SIZE).toBe(8 * 1024 * 1024);
    expect(CHUNK_OVERHEAD).toBe(28);
  });

  it("keeps every non-final chunk large enough to be a multipart part", () => {
    // Each encrypted chunk is uploaded as one S3 part (SPEC §7); a chunk size
    // under 5 MiB would make CompleteMultipartUpload fail with EntityTooSmall.
    expect(CHUNK_SIZE).toBeGreaterThanOrEqual(MIN_PART_BYTES);
  });
});

describe("base64url", () => {
  it("round-trips every byte value, including bytes >= 0x80", () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;

    const encoded = b64urlEncode(all);
    expect(encoded).toMatch(B64URL_ALPHABET);
    expect(encoded).not.toContain("=");
    expectBytesEqual(b64urlDecode(encoded), all, "all byte values");
  });

  it("uses the URL-safe alphabet with no padding", () => {
    // 0xff 0xef 0xbe is "/+++" in standard base64 — every non-URL-safe character.
    expect(b64urlEncode(new Uint8Array([0xff, 0xef, 0xbe]))).toBe("_---");
    expectBytesEqual(b64urlDecode("_---"), new Uint8Array([0xff, 0xef, 0xbe]), "_---");

    // Lengths that would normally be padded with one or two "=".
    expect(b64urlEncode(new Uint8Array([0x00]))).toBe("AA");
    expect(b64urlEncode(new Uint8Array([0x00, 0x00]))).toBe("AAA");
    expect(b64urlEncode(new Uint8Array([]))).toBe("");
    expect(b64urlDecode("").length).toBe(0);
  });

  it("round-trips random payloads of every length modulo 3", () => {
    for (const n of [1, 2, 3, 4, 5, 31, 32, 33]) {
      const bytes = randomBytes(n);
      expectBytesEqual(b64urlDecode(b64urlEncode(bytes)), bytes, `random ${n} bytes`);
    }
  });
});

describe("randomId", () => {
  it("is 22 base64url characters decoding to 16 bytes", () => {
    const id = randomId();
    expect(id).toHaveLength(22);
    expect(id).toMatch(B64URL_ALPHABET);
    expect(b64urlDecode(id).length).toBe(16);
  });

  it("does not repeat", () => {
    const ids = new Set(Array.from({ length: 100 }, () => randomId()));
    expect(ids.size).toBe(100);
  });
});

describe("AAD strings", () => {
  it("binds a block to its role and position", () => {
    expect(metaAad("abc")).toBe("abc:meta");
    expect(chunkAad("abc", 0)).toBe("abc:video:0");
    expect(chunkAad("abc", 12)).toBe("abc:video:12");
    expect(chunkAad("abc", 1234)).toBe("abc:video:1234");
    expect(analyticsAad("abc", "xyz")).toBe("abc:analytics:xyz");
  });
});

describe("analytics blocks (SPEC §16.2)", () => {
  it("round-trips a watch payload under its own session's AAD", async () => {
    const key = await generateKey();
    const id = randomId();
    const sessionId = randomId();
    const plain = randomBytes(291);

    const block = await encryptBlock(key, analyticsAad(id, sessionId), plain);
    expect(block.length).toBe(plain.length + CHUNK_OVERHEAD);
    expectBytesEqual(
      await decryptBlock(key, analyticsAad(id, sessionId), block),
      plain,
      "analytics round-trip",
    );
  });

  it("binds a session's watch data to that session and that video", async () => {
    // The beacon endpoint is unauthenticated (SPEC §16.3), so the AAD is what
    // stops an object copied to another key — another session id, another
    // video's prefix — from being read as someone's viewing. It is also what
    // stops watch data from ever being mistaken for the video's own metadata.
    const key = await generateKey();
    const id = randomId();
    const sessionA = randomId();
    const sessionB = randomId();

    const block = await encryptBlock(key, analyticsAad(id, sessionA), randomBytes(200));

    await expect(decryptBlock(key, analyticsAad(id, sessionB), block)).rejects.toThrow();
    await expect(decryptBlock(key, analyticsAad(randomId(), sessionA), block)).rejects.toThrow();
    await expect(decryptBlock(key, metaAad(id), block)).rejects.toThrow();
    await expect(decryptBlock(key, chunkAad(id, 0), block)).rejects.toThrow();
  });

  it("is unreadable to anyone without the video's key", async () => {
    // Which is the whole privacy claim: watch data is readable by exactly the
    // holders of the share link (SPEC §16.8), and by no one else — including
    // whoever operates the bucket the object sits in.
    const [key, other] = [await generateKey(), await generateKey()];
    const id = randomId();
    const sessionId = randomId();

    const block = await encryptBlock(key, analyticsAad(id, sessionId), randomBytes(200));
    await expect(decryptBlock(other, analyticsAad(id, sessionId), block)).rejects.toThrow();
  });
});

describe("keys", () => {
  it("exports to 43 base64url characters and imports back to a usable key", async () => {
    const key = await generateKey();
    const b64 = await exportKeyB64(key);

    expect(b64).toHaveLength(43);
    expect(b64).toMatch(B64URL_ALPHABET);
    expect(b64urlDecode(b64).length).toBe(32);

    const imported = await importKeyB64(b64);
    expect(await exportKeyB64(imported)).toBe(b64);

    const plain = randomBytes(1024);
    const block = await encryptBlock(key, "id:meta", plain);
    expectBytesEqual(await decryptBlock(imported, "id:meta", block), plain, "cross-key round-trip");
  });

  it("cannot decrypt a block written under a different key", async () => {
    const [a, b] = [await generateKey(), await generateKey()];
    const block = await encryptBlock(a, "id:meta", randomBytes(64));
    await expect(decryptBlock(b, "id:meta", block)).rejects.toThrow();
  });
});

describe("encryptBlock / decryptBlock", () => {
  it("round-trips and costs exactly CHUNK_OVERHEAD bytes", async () => {
    const key = await generateKey();
    for (const n of [0, 1, 15, 16, 17, 4096]) {
      const plain = randomBytes(n);
      const block = await encryptBlock(key, "id:video:0", plain);
      expect(block.length, `block for ${n} plaintext bytes`).toBe(n + CHUNK_OVERHEAD);
      expectBytesEqual(await decryptBlock(key, "id:video:0", block), plain, `round-trip ${n}`);
    }
  });

  it("uses a fresh IV per encryption", async () => {
    const key = await generateKey();
    const plain = randomBytes(256);
    const first = await encryptBlock(key, "id:meta", plain);
    const second = await encryptBlock(key, "id:meta", plain);

    expect(b64urlEncode(first.subarray(0, 12))).not.toBe(b64urlEncode(second.subarray(0, 12)));
    expect(b64urlEncode(first)).not.toBe(b64urlEncode(second));
  });

  it("rejects a tampered byte anywhere in the block", async () => {
    const key = await generateKey();
    const plain = randomBytes(1024);
    const block = await encryptBlock(key, "id:video:0", plain);

    // IV, ciphertext body, and GCM tag in turn.
    for (const at of [0, 11, 12, block.length - 17, block.length - 1]) {
      const tampered = block.slice();
      tampered[at] ^= 0x01;
      await expect(decryptBlock(key, "id:video:0", tampered)).rejects.toThrow();
    }
  });

  it("rejects a truncated block", async () => {
    const key = await generateKey();
    const block = await encryptBlock(key, "id:video:0", randomBytes(1024));

    await expect(decryptBlock(key, "id:video:0", block.slice(0, block.length - 1))).rejects.toThrow();
    await expect(decryptBlock(key, "id:video:0", block.slice(0, 10))).rejects.toThrow();
  });

  it("rejects a block whose AAD does not match", async () => {
    const key = await generateKey();
    const id = randomId();
    const plain = randomBytes(1024);
    const block = await encryptBlock(key, chunkAad(id, 1), plain);

    // Reordered chunk index, wrong role, wrong video id.
    await expect(decryptBlock(key, chunkAad(id, 2), block)).rejects.toThrow();
    await expect(decryptBlock(key, chunkAad(id, 0), block)).rejects.toThrow();
    await expect(decryptBlock(key, metaAad(id), block)).rejects.toThrow();
    await expect(decryptBlock(key, chunkAad(randomId(), 1), block)).rejects.toThrow();
    await expect(decryptBlock(key, "", block)).rejects.toThrow();
  });
});

describe("chunked video encryption", () => {
  // 2 full chunks plus a short final one — parts 1, 2 and a short part 3.
  const TAIL = 1234;
  const TOTAL = 2 * CHUNK_SIZE + TAIL;
  const CHUNK_COUNT = 3;

  it("round-trips across 3 chunks including a short final chunk", async () => {
    const key = await generateKey();
    const id = randomId();
    const plain = randomBytes(TOTAL);

    const encrypted = await encryptChunks(key, id, plain);
    expect(encrypted.length).toBe(TOTAL + CHUNK_COUNT * CHUNK_OVERHEAD);

    // Decrypt the way the player does: slice by decryptChunkRange, decrypt per-chunk AAD.
    const meta = makeMeta(TOTAL, CHUNK_COUNT);
    const decrypted: Uint8Array[] = [];
    for (let i = 0; i < CHUNK_COUNT; i++) {
      const { start, end } = decryptChunkRange(i, CHUNK_COUNT, meta);
      const block = encrypted.subarray(start, end ?? encrypted.length);
      expect(block.length, `chunk ${i} block size`).toBe(
        (i === CHUNK_COUNT - 1 ? TAIL : CHUNK_SIZE) + CHUNK_OVERHEAD,
      );
      decrypted.push(await decryptBlock(key, chunkAad(id, i), block));
    }

    expect(decrypted[CHUNK_COUNT - 1]!.length, "final chunk is short").toBe(TAIL);
    expectBytesEqual(concat(decrypted), plain, "video round-trip");
  }, 60_000);

  it("binds each chunk to its index, so a reordered chunk fails to decrypt", async () => {
    const key = await generateKey();
    const id = randomId();
    const plain = randomBytes(3 * 4096);

    // Small stand-in for full-size chunks, so the case stays fast.
    const blocks = await Promise.all(
      [0, 1, 2].map((i) => encryptBlock(key, chunkAad(id, i), plain.subarray(i * 4096, (i + 1) * 4096))),
    );

    await expect(decryptBlock(key, chunkAad(id, 0), blocks[1]!)).rejects.toThrow();
    await expect(decryptBlock(key, chunkAad(id, 2), blocks[0]!)).rejects.toThrow();
  });
});

describe("decryptChunkRange", () => {
  it("matches the SPEC offset math", () => {
    const stride = CHUNK_SIZE + CHUNK_OVERHEAD;
    const meta = makeMeta(2 * CHUNK_SIZE + 1234, 3);

    expect(decryptChunkRange(0, 3, meta)).toEqual({ start: 0, end: stride });
    expect(decryptChunkRange(1, 3, meta)).toEqual({ start: stride, end: 2 * stride });
    expect(decryptChunkRange(2, 3, meta)).toEqual({ start: 2 * stride, end: null });
  });

  it("returns an open-ended range for a single-chunk video", () => {
    const meta = makeMeta(1024, 1);
    expect(decryptChunkRange(0, 1, meta)).toEqual({ start: 0, end: null });
  });

  it("strides by meta.chunkSize, not by the current CHUNK_SIZE", async () => {
    // Videos uploaded before the 8 MiB switch carry chunkSize 4 MiB and must
    // still play, so the offsets come from meta and nowhere else (SPEC §4).
    const legacyChunkSize = 4 * 1024 * 1024;
    expect(legacyChunkSize).not.toBe(CHUNK_SIZE);

    const stride = legacyChunkSize + CHUNK_OVERHEAD;
    const meta = makeMeta(2 * legacyChunkSize + 99, 3, legacyChunkSize);

    expect(decryptChunkRange(0, 3, meta)).toEqual({ start: 0, end: stride });
    expect(decryptChunkRange(1, 3, meta)).toEqual({ start: stride, end: 2 * stride });
    expect(decryptChunkRange(2, 3, meta)).toEqual({ start: 2 * stride, end: null });

    // ...and the ranges really do carve up a 4 MiB-chunked object.
    const key = await generateKey();
    const id = randomId();
    const plain = randomBytes(legacyChunkSize + 99);
    const encrypted = await encryptChunks(key, id, plain, legacyChunkSize);
    const legacyMeta = makeMeta(plain.length, 2, legacyChunkSize);

    const first = decryptChunkRange(0, 2, legacyMeta);
    const second = decryptChunkRange(1, 2, legacyMeta);
    const head = await decryptBlock(
      key,
      chunkAad(id, 0),
      encrypted.subarray(first.start, first.end ?? encrypted.length),
    );
    const tail = await decryptBlock(key, chunkAad(id, 1), encrypted.subarray(second.start));
    expectBytesEqual(concat([head, tail]), plain, "4 MiB-chunked round-trip");
  }, 60_000);

  it("tiles the real encrypted object with no gaps or overlaps", async () => {
    const key = await generateKey();
    const id = randomId();
    const chunkSize = 4096;
    const chunkCount = 3;
    const tail = 7;
    const totalBytes = 2 * chunkSize + tail;
    const encrypted = await encryptChunks(key, id, randomBytes(totalBytes), chunkSize);
    const meta = makeMeta(totalBytes, chunkCount, chunkSize);

    let expectedStart = 0;
    for (let i = 0; i < chunkCount; i++) {
      const { start, end } = decryptChunkRange(i, chunkCount, meta);
      expect(start, `chunk ${i} starts where chunk ${i - 1} ended`).toBe(expectedStart);
      expect(start).toBeLessThan(encrypted.length);

      const resolvedEnd = end ?? encrypted.length;
      expect(end === null, `only the last chunk runs to EOF`).toBe(i === chunkCount - 1);
      expect(resolvedEnd).toBeLessThanOrEqual(encrypted.length);
      expectedStart = resolvedEnd;
    }
    expect(expectedStart, "ranges cover the whole object").toBe(encrypted.length);
  });
});
