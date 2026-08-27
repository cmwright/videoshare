# VideoShare — Format & Module Specification (v1)

This document is the **binding contract** for all code in this repo. Implementation
modules are written against these exact formats and signatures. Do not deviate;
if something here is impossible, flag it rather than silently changing the contract.

## 1. Product summary

Serverless, open-source Loom replacement. A static site (TypeScript + Vite, output
is plain `dist/`) with two pages:

- `index.html` — recorder: capture screen + mic in-browser, compress live via
  MediaRecorder, encrypt client-side, upload directly to any S3-compatible bucket
  with SigV4-signed PUTs (via `aws4fetch`). Also hosts the settings panel and a
  local "My videos" library (localStorage).
- `view.html` — player: no credentials; reads video id + AES key from the URL
  fragment, fetches ciphertext from the bucket's public base URL, decrypts in the
  browser, plays. Progressive playback via MSE where supported, whole-file blob
  fallback otherwise.

Threat model: the bucket may be publicly readable. Everything stored is AES-GCM
ciphertext; the key exists only in the share link's URL fragment (never sent over
the network). Upload auth = whoever holds S3 write credentials. Viewers need nothing.

## 2. Identifiers, keys, link format

- **Video id**: 16 random bytes (`crypto.getRandomValues`), base64url encoded, no
  padding → 22-char string.
- **Encryption key**: AES-GCM 256-bit, generated per video via WebCrypto
  (`extractable: true`), exported as raw 32 bytes → base64url, no padding → 43 chars.
- **Share link**: `{publicSiteBase}/view.html#{id}.{keyB64url}`
  - Fragment = id, a literal `.`, then the key. Nothing else in v1.
  - `publicSiteBase` is wherever the static site is hosted (may differ from bucket).

Base64url everywhere: RFC 4648 §5, **no padding**.

## 3. Storage layout (bucket)

Two objects per video, under the id as prefix:

| Object key         | Content                                    | Content-Type               |
|--------------------|--------------------------------------------|----------------------------|
| `{id}/meta.json`   | encrypted metadata (binary, despite name)  | `application/octet-stream` |
| `{id}/video.bin`   | concatenated encrypted chunks              | `application/octet-stream` |

## 4. Encryption format

- Algorithm: AES-GCM, 256-bit key, 12-byte random IV per encryption, 16-byte tag.
- **Encrypted block layout** (used for meta and for each video chunk):
  `IV (12 bytes) ‖ ciphertext ‖ GCM tag (16 bytes)` — i.e. WebCrypto's
  `encrypt()` output appended after the IV. Overhead = **28 bytes** per block.
- **AAD** (UTF-8 encoded string) binds each block to its role and position:
  - meta: `"{id}:meta"`
  - video chunk i (0-based): `"{id}:video:{i}"` (decimal, no padding)
- **Chunking**: plaintext WebM is split into `CHUNK_SIZE = 8 * 1024 * 1024`
  (8 MiB) plaintext chunks; the last chunk may be shorter. Each chunk is
  encrypted independently as a block above; blocks are concatenated in order
  into `video.bin`. (8 MiB because each encrypted chunk is uploaded as one S3
  multipart part, and non-final parts must be ≥ 5 MiB. Players MUST use
  `meta.chunkSize`, never a hardcoded constant — older videos may use 4 MiB.)
- **Offset math** (player Range requests): encrypted chunk i (for i <
  chunkCount−1) occupies bytes `[i * (CHUNK_SIZE + 28), (i+1) * (CHUNK_SIZE + 28))`
  of `video.bin`; the final chunk runs to end of object.
- Decryption MUST verify: GCM tag valid (WebCrypto throws otherwise), and for
  video, `chunkCount`/total size consistent with meta. A failed decrypt surfaces
  as a user-visible "wrong key or corrupted video" error, never a silent hang.

## 5. Metadata (plaintext JSON, before encryption)

```jsonc
{
  "v": 1,                      // format version, integer
  "title": "Sprint demo",      // user-entered, may be ""
  "mimeType": "video/webm;codecs=vp9,opus",  // exact MediaRecorder mimeType used
  "durationMs": 93250,         // integer, from recording timer
  "totalBytes": 19381222,      // plaintext (pre-encryption) video byte length
  "chunkSize": 8388608,        // plaintext chunk size used
  "chunkCount": 5,
  "createdAt": "2026-08-27T21:04:00.000Z"  // ISO 8601 UTC
}
```

## 6. Recording

- Capture: `getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: true })`
  (system/tab audio only arrives if the user opts in via the picker) plus
  `getUserMedia({ audio: true })` for the default microphone (same device the OS
  gives Meet/Zoom). Mic defaults ON with a visible toggle before capture starts.
- Audio mixing: if both mic and display audio exist, mix through a single
  `AudioContext` (`MediaStreamAudioSourceNode`s → `MediaStreamAudioDestinationNode`)
  into one audio track; combine with the display video track into the recorded
  `MediaStream`. If only mic, its track is used directly (still fine to route
  through the AudioContext for one code path).
- Encoding: `MediaRecorder` with the first supported of
  `video/webm;codecs=vp9,opus`, then `video/webm;codecs=vp8,opus`, then `video/webm`.
  `videoBitsPerSecond` from settings (default **2_000_000**), `audioBitsPerSecond`
  128_000. `start(1000)` (1 s timeslices), accumulate blobs in memory.
- Stop paths (all must work): the app's Stop button, and the browser's native
  "Stop sharing" bar (video track `ended` event). On stop, all tracks of all
  acquired streams are stopped (mic indicator must turn off).
- Duration: MediaRecorder WebM has no duration header (reports Infinity) and
  it is NOT patched — patching shifts bytes, which is impossible once chunk 0
  has been uploaded (see §7 streaming). `meta.durationMs` (from the recording
  timer) is authoritative. The recorder's preview element uses the standard
  probe (seek to a huge `currentTime`, wait for `durationchange`, seek back to
  0 while paused) so its controls show a real duration. The `fix-webm-duration`
  dependency is removed entirely.
- Recorder page state machine: idle → picking → recording (live timer +
  streamed-upload progress, e.g. "12 MB uploaded") → preview (title input,
  replayable `<video>`, **Finish** button, Discard) → finishing (fast: final
  part + complete + meta) → done (share link shown + auto-copied, entry added
  to local library). Recording requires configured settings (the multipart
  upload is created at record start); if unconfigured, open the settings panel
  instead of starting capture.
- Recorded Blob slices are retained in memory (as Blobs, not ArrayBuffers)
  until the share link exists, so a mid-recording upload failure can never
  lose the recording (see §7 failure handling).

## 7. Upload (streaming, S3 multipart)

`video.bin` is uploaded as an **S3 multipart upload that runs concurrently with
recording**: encrypted chunk i (0-based) is uploaded as part number i+1. The
completed multipart object is byte-identical to the §4 concatenation, so the
player and storage format are unaffected. `meta.json` remains a single PUT.

- Signing: `aws4fetch`'s `AwsClient` with `{ accessKeyId, secretAccessKey,
  region, service: "s3" }`; path-style URLs `{endpoint}/{bucket}/{objectKey}`
  (works for MinIO/R2/S3).
- Lifecycle:
  1. Record start → `CreateMultipartUpload` (POST `?uploads`) for
     `{id}/video.bin` → keep `uploadId`.
  2. As the recorder accumulates ≥ CHUNK_SIZE plaintext, encrypt that chunk
     (§4) and `UploadPart` (PUT `?partNumber={i+1}&uploadId=...`). Parts upload
     **sequentially** (a queue; never parallel PUTs) and each part's `ETag`
     response header is recorded.
  3. Finish → flush the remaining plaintext as the final chunk/part (any size)
     → `CompleteMultipartUpload` (POST XML listing partNumber+ETag in order)
     → PUT `meta.json` last (a video is "complete" iff meta exists).
  4. Discard → `AbortMultipartUpload` (DELETE `?uploadId=...`), best-effort.
- API (`upload.ts`):
  ```ts
  export interface UploadResult { id: string; link: string; }
  export interface UploadSession {
    addChunk(plain: Uint8Array): Promise<void>; // encrypt + UploadPart, sequential
    finish(finalPlain: Uint8Array | null, meta: VideoMeta): Promise<UploadResult>;
    abort(): Promise<void>;
    readonly uploadedBytes: number;             // ciphertext bytes confirmed uploaded
  }
  export function createUploadSession(settings: Settings, id: string,
    key: CryptoKey, onProgress?: (uploadedBytes: number) => void): Promise<UploadSession>;
  ```
  Node-compatibility: no `window`/`XMLHttpRequest` requirement — plain `fetch`
  of signed requests is fine for parts (per-part granularity is progress enough).
- Failure handling: each part attempt retries up to 3 times with exponential
  backoff (1s/2s/4s). A part that still fails marks the session "degraded" but
  recording continues and Blobs are retained; `finish()` first re-uploads any
  failed parts (multipart allows re-sending a part number). If `finish()`
  ultimately fails, the UI shows the error plus a **"Download recording"**
  link (`<a download>` of the local Blob) so the recording is never lost, and
  offers retry.
- Failures surface with the HTTP status and a hint (403 → check credentials,
  CORS/network error → check bucket CORS config; link to docs).
- Bucket requirements this adds (must be reflected in §14 examples/docs):
  CORS must allow POST (create/complete) and DELETE (abort) in addition to
  PUT/GET/HEAD and must expose the `ETag` response header; the uploader policy
  needs `s3:AbortMultipartUpload` alongside `s3:PutObject`; docs recommend
  cleaning up incomplete multipart uploads after ~1 day so crashed sessions
  don't strand storage (AWS/R2: an `AbortIncompleteMultipartUpload` lifecycle
  rule; MinIO: the server-wide `api stale_uploads_expiry` setting — `mc ilm`
  cannot express an abort-only rule).

## 8. Playback

- Parse fragment → `{ id, key }`; malformed fragment → friendly error.
- GET `{publicBaseUrl}/{id}/meta.json` (publicBaseUrl configurable per
  deployment — see §10; **no credentials**), decrypt, show title/duration.
- Progressive path (when `MediaSource.isTypeSupported(meta.mimeType)`):
  MSE `SourceBuffer` of `meta.mimeType`; fetch `video.bin` with Range requests
  chunk-by-chunk in order, decrypt, `appendBuffer` sequentially; start playback
  once the first chunk is appended; keep fetching ahead until done, then
  `endOfStream()`. Seeking within buffered ranges works; unbuffered seeks just
  wait for the buffer to reach that point (v1 accepts this).
- Fallback path (e.g. Safari): fetch entire `video.bin`, decrypt all chunks,
  `URL.createObjectURL(new Blob(chunks, { type: meta.mimeType }))` → `<video src>`.
- Errors: decrypt failure → "wrong key or corrupted video"; 404 → "video not
  found"; network/CORS → actionable message.

## 9. Settings & local library (localStorage, recorder page only)

- `videoshare.settings` (JSON): `endpoint` (e.g. `https://s3.amazonaws.com` or
  `http://localhost:9000`), `region` (default `us-east-1`), `bucket`,
  `accessKeyId`, `secretAccessKey`, `publicBaseUrl` (base URL where the bucket
  is readable, e.g. `http://localhost:9000/videoshare` or a CDN domain),
  `videoBitsPerSecond` (default 2_000_000).
- `videoshare.library` (JSON array of): `{ id, title, createdAt, durationMs,
  link }` — newest first; list in UI with copy-link and delete-from-list
  (delete only removes the local entry in v1, it does not delete from bucket).

## 10. Viewer configuration of publicBaseUrl

`view.html` has no localStorage settings (viewers are strangers). The public
base URL is baked at deploy time via a tiny config: `dist/config.js`
(`window.VIDEOSHARE = { publicBaseUrl: "..." }`), loaded by both pages with a
sensible error if missing. The repo ships `public/config.js` with a placeholder
and the docs tell deployers to edit one line. The recorder's settings panel
uses its own localStorage value for uploads but generates share links pointing
at the deployed site + this config's publicBaseUrl.

## 11. Module APIs (src/, TypeScript strict)

`types.ts`
```ts
export interface VideoMeta { v: 1; title: string; mimeType: string; durationMs: number;
  totalBytes: number; chunkSize: number; chunkCount: number; createdAt: string; }
export interface Settings { endpoint: string; region: string; bucket: string;
  accessKeyId: string; secretAccessKey: string; publicBaseUrl: string;
  videoBitsPerSecond: number; }
export interface LibraryEntry { id: string; title: string; createdAt: string;
  durationMs: number; link: string; }
```

`util.ts`
```ts
export function randomId(): string;                       // 16 bytes → base64url
export function b64urlEncode(bytes: Uint8Array): string;  // no padding
export function b64urlDecode(s: string): Uint8Array;
export function formatDuration(ms: number): string;       // "m:ss" / "h:mm:ss"
export function formatBytes(n: number): string;           // "12.3 MB"
```

`crypto.ts`  (pure WebCrypto — must run in both browser and Node ≥20 for tests)
```ts
export const CHUNK_SIZE: number;         // 8 MiB (§4)
export const CHUNK_OVERHEAD: number;     // 28
export function generateKey(): Promise<CryptoKey>;
export function exportKeyB64(key: CryptoKey): Promise<string>;
export function importKeyB64(b64url: string): Promise<CryptoKey>;
export function encryptBlock(key: CryptoKey, aad: string, plain: Uint8Array): Promise<Uint8Array>;
export function decryptBlock(key: CryptoKey, aad: string, block: Uint8Array): Promise<Uint8Array>; // throws on tamper
export function metaAad(id: string): string;              // `${id}:meta`
export function chunkAad(id: string, index: number): string;
export function decryptChunkRange(index: number, chunkCount: number, meta: VideoMeta):
  { start: number; end: number | null };                  // byte range in video.bin (end exclusive, null = EOF)
```

`settings.ts`
```ts
export function loadSettings(): Settings | null;          // null if unconfigured/invalid
export function saveSettings(s: Settings): void;
export function loadLibrary(): LibraryEntry[];
export function addToLibrary(e: LibraryEntry): void;
export function removeFromLibrary(id: string): void;
export function publicBaseUrl(): string;                  // from window.VIDEOSHARE, throws helpful Error if absent
```

`upload.ts` — see §7 for the full streaming API (`createUploadSession`,
`UploadSession`, `UploadResult`).

`record.ts` — page controller for `index.html` (wires everything; owns the state
machine in §6, including the internal Blob→8 MiB-chunk assembler that feeds
`UploadSession.addChunk`). `player.ts` — page controller for `view.html` (owns §8).

Page-specific styles live in `src/record.css` / `src/player.css`; shared design
tokens and base styles in `src/app.css`.

## 12. Build & tooling

- `package.json`: deps `aws4fetch` (only runtime dep); devDeps `typescript`,
  `vite`, `vitest`. Scripts: `dev` (vite), `build` (`tsc --noEmit && vite build`),
  `preview`, `test` (`vitest run`), `test:e2e` (`vitest run --config vitest.e2e.config.ts`,
  only meaningful with MinIO up).
- Vite multi-page: rollup inputs `index.html` + `view.html`. `public/config.js`
  copied verbatim to `dist/`.
- TypeScript `strict: true`. No frameworks, no other runtime deps.

## 13. Tests

- `tests/crypto.test.ts` (vitest, Node WebCrypto): key export/import round-trip;
  block round-trip; tampered byte → throws; wrong AAD (reordered chunk index) →
  throws; chunked encrypt/decrypt round-trip across ≥3 chunks incl. short
  final chunk; offset math matches actual encrypted sizes; base64url round-trip
  incl. bytes ≥ 0x80.
- `tests/e2e.minio.test.ts` (vitest, runs only when `E2E=1`): against local
  MinIO (`http://localhost:9000`, bucket `videoshare`, creds from compose file):
  generate synthetic "video" bytes (~20 MB random → 3 parts incl. short final),
  upload via the real `createUploadSession` streaming path (Node fetch),
  then fetch meta + Range-fetch each chunk exactly as the player does, decrypt,
  byte-compare against the original. Also: abort() removes the pending upload
  (a subsequent GET of video.bin is 404); a re-sent part number overwrites
  (degraded-retry path); GET without creds succeeds (public read policy), PUT
  without creds fails 403, listing denied. Both the root creds and the
  write-only uploader creds must pass the full loop (multipart create/part/
  complete/abort must all work under the §14 uploader policy).

## 14. Examples & docs (deliverables, not code)

- `examples/docker-compose.yml`: MinIO (ports 9000/9001) + an `mc` init job that
  creates bucket `videoshare`, applies anonymous **download-only** policy and
  CORS (must allow POST and expose `ETag` — §7), creates a **write-only**
  access key for uploads (PutObject + AbortMultipartUpload) + prints it, and
  configures cleanup of incomplete multipart uploads after 1 day (via MinIO's
  `api stale_uploads_expiry` server setting — see §7);
  plus an `nginx` (or `caddy`) service serving `../dist` on
  `http://localhost:8080`. One command → full local stack.
- `examples/s3-cors.json` (GET/HEAD/PUT/POST/DELETE, expose `ETag`, `Content-Range`,
  `Accept-Ranges`), `examples/s3-bucket-policy.json` (public GetObject, no
  ListBucket), `examples/iam-uploader-policy.json` (`s3:PutObject` +
  `s3:AbortMultipartUpload` only).
- `docs/storage-setup.md`: walkthroughs for Cloudflare R2 (recommended default:
  scoped API tokens, free egress), AWS S3 (IAM user), MinIO self-hosted incl.
  the VPN + anonymous-write zero-credential variant.
- `README.md`: what/why, 5-minute quickstart (local compose, then real bucket),
  security model (fragment key, write-only creds, what it does NOT protect
  against), browser support matrix, future work (camera bubble, streaming
  upload-while-recording, multipart).
