/**
 * AES-GCM encryption in the format fixed by docs/SPEC.md §4.
 *
 * Block layout: IV (12 bytes) ‖ ciphertext ‖ GCM tag (16 bytes) — 28 bytes of
 * overhead per block. AAD binds each block to its role and position, so blocks
 * cannot be swapped, reordered, or moved between videos.
 *
 * Pure WebCrypto: runs unchanged in browsers and in Node >= 20.
 */

import type { VideoMeta } from "./types";
import { b64urlDecode, b64urlEncode } from "./util";

/**
 * Plaintext bytes per video chunk. The final chunk may be shorter.
 *
 * 8 MiB because each encrypted chunk is uploaded as one S3 multipart part
 * (SPEC §7) and non-final parts must be at least 5 MiB. Players read
 * `meta.chunkSize`, never this constant — older videos used 4 MiB.
 */
export const CHUNK_SIZE = 8 * 1024 * 1024;

/** Bytes an encrypted block adds to its plaintext: 12-byte IV + 16-byte tag. */
export const CHUNK_OVERHEAD = 28;

const IV_BYTES = 12;
const TAG_BITS = 128;

const utf8 = new TextEncoder();

function subtle(): SubtleCrypto {
  // crypto.subtle is undefined outside a secure context; without this the
  // failure surfaces much later as "cannot read properties of undefined".
  const c = globalThis.crypto;
  if (!c?.subtle) {
    throw new Error("WebCrypto is unavailable — VideoShare needs a secure context (https:// or localhost).");
  }
  return c.subtle;
}

/**
 * TypeScript >= 5.7 narrows `BufferSource` to ArrayBuffer-backed views, while a
 * plain `Uint8Array` may be backed by a SharedArrayBuffer. WebCrypto accepts
 * both at runtime, so the public signatures below stay plain `Uint8Array`.
 */
function src(view: Uint8Array): BufferSource {
  return view as BufferSource;
}

export function generateKey(): Promise<CryptoKey> {
  return subtle().generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

export async function exportKeyB64(key: CryptoKey): Promise<string> {
  return b64urlEncode(new Uint8Array(await subtle().exportKey("raw", key)));
}

export function importKeyB64(b64url: string): Promise<CryptoKey> {
  const raw = b64urlDecode(b64url);
  if (raw.length !== 32) {
    throw new Error(`invalid key: expected 32 bytes, got ${raw.length}`);
  }
  return subtle().importKey("raw", src(raw), { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
}

export async function encryptBlock(key: CryptoKey, aad: string, plain: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = new Uint8Array(
    await subtle().encrypt(
      { name: "AES-GCM", iv, additionalData: src(utf8.encode(aad)), tagLength: TAG_BITS },
      key,
      src(plain),
    ),
  );
  const block = new Uint8Array(IV_BYTES + sealed.length);
  block.set(iv, 0);
  block.set(sealed, IV_BYTES);
  return block;
}

/** Throws if the key, the AAD, or any byte of the block is wrong. */
export async function decryptBlock(key: CryptoKey, aad: string, block: Uint8Array): Promise<Uint8Array> {
  if (block.length < CHUNK_OVERHEAD) {
    throw new Error(`encrypted block too short: ${block.length} bytes`);
  }
  const plain = await subtle().decrypt(
    {
      name: "AES-GCM",
      iv: src(block.subarray(0, IV_BYTES)),
      additionalData: src(utf8.encode(aad)),
      tagLength: TAG_BITS,
    },
    key,
    src(block.subarray(IV_BYTES)),
  );
  return new Uint8Array(plain);
}

export function metaAad(id: string): string {
  return `${id}:meta`;
}

export function chunkAad(id: string, index: number): string {
  return `${id}:video:${index}`;
}

/**
 * Binds one encrypted watch-data block to one video *and* one viewing session
 * (SPEC §16.2). The analytics write endpoint is unauthenticated, so this is what
 * makes an object copied to another key — another session, or another video —
 * fail to decrypt instead of quietly counting as someone's viewing.
 */
export function analyticsAad(id: string, sessionId: string): string {
  return `${id}:analytics:${sessionId}`;
}

/**
 * Byte range of encrypted chunk `index` within `video.bin`, for a player Range
 * request. `end` is exclusive; `null` means "to end of object" — the final
 * chunk, whose plaintext may be shorter than a full chunk.
 */
export function decryptChunkRange(
  index: number,
  chunkCount: number,
  meta: VideoMeta,
): { start: number; end: number | null } {
  if (!Number.isInteger(meta.chunkSize) || meta.chunkSize <= 0) {
    throw new Error(`invalid meta.chunkSize: ${meta.chunkSize}`);
  }
  if (chunkCount !== meta.chunkCount) {
    throw new Error(`chunkCount ${chunkCount} does not match meta.chunkCount ${meta.chunkCount}`);
  }
  if (!Number.isInteger(index) || index < 0 || index >= chunkCount) {
    throw new RangeError(`chunk index ${index} out of range for ${chunkCount} chunks`);
  }

  const stride = meta.chunkSize + CHUNK_OVERHEAD;
  const start = index * stride;
  return { start, end: index === chunkCount - 1 ? null : start + stride };
}
