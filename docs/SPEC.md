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
  "mimeType": "video/webm;codecs=vp09.00.50.08,opus",  // exact engine string; H.264 recordings use video/mp4;codecs=avc1...,
  "durationMs": 93250,         // integer, from recording timer
  "totalBytes": 19381222,      // plaintext (pre-encryption) video byte length
  "chunkSize": 8388608,        // plaintext chunk size used
  "chunkCount": 5,
  "createdAt": "2026-08-27T21:04:00.000Z"  // ISO 8601 UTC
}
```

## 6. Recording

- Capture: `getDisplayMedia({ video: { frameRate: { ideal: 30, max: 30 },
  width: { ideal: 3840, max: 3840 }, height: { ideal: 2160, max: 2160 } },
  audio: true })` — `ideal` is load-bearing: without it Chrome captures screens
  at LOGICAL (CSS-pixel) size, half density on Retina, and no encoder setting
  can recover the lost text detail; with it Chrome delivers native physical
  pixels up to the 4K cap and never upscales past the surface's native size. (system/tab
  audio only arrives if the user opts in via the picker) plus
  `getUserMedia({ audio: true })` for the default microphone (same device the OS
  gives Meet/Zoom). Mic defaults ON with a visible toggle before capture starts.
  Set `videoTrack.contentHint = "text"` (screen-content encoder tuning).
- Audio mixing: if both mic and display audio exist, mix through a single
  `AudioContext` (`MediaStreamAudioSourceNode`s → `MediaStreamAudioDestinationNode`
  configured **mono**, `channelCount: 1`) into one audio track; combine with the
  display video track into the recorded `MediaStream`. If only mic, still route
  through the AudioContext for one code path.
- **Encoding engines** — one interface, two implementations (`src/encoder.ts`):

  ```ts
  export type CodecChoice = "auto" | "h264" | "vp9" | "av1";
  export interface EngineOptions { quality: Quality; codec: CodecChoice;
    fallbackVideoBitsPerSecond: number; }
  export interface RecorderEngine {
    readonly mimeType: string;   // exact container/codec string actually in use,
                                 // MSE-compatible (MediaSource.isTypeSupported)
    ondata: (bytes: Uint8Array) => void;  // muxed container bytes, strictly in order
    onerror: (err: Error) => void;   // engine died mid-recording; fires at most
                                     // once, never from stop()
    start(stream: MediaStream): void;
    stop(): Promise<void>;       // flush; resolves after the final ondata call
  }
  export type Quality = "smaller" | "standard" | "sharper";
  export function createEngine(opts: EngineOptions): RecorderEngine; // picks best available
  ```

  1. **Primary — WebCodecs engine** (when `VideoEncoder`, `AudioEncoder` and
     `MediaStreamTrackProcessor` all exist; Chrome/Edge). **Codec selection**
     from `opts.codec`, feature-detected via `isConfigSupported`:
     - `"h264"` → H.264 with `hardwareAcceleration: "prefer-hardware"`
       (falling back to no-preference if rejected), muxed as **fragmented MP4**
       via the `mp4-muxer` npm package (MIT, streaming/fragmented mode).
       Profile/level string derived from resolution (High profile,
       `avc1.6400XX`). Rate control: per-frame quantizer when the encoder
       accepts `bitrateMode: "quantizer"` with H.264 per-frame QP; otherwise
       `bitrateMode: "variable"` with a quality→bitrate table scaled by pixel
       count (implementer documents both tables in code). Audio in MP4: AAC
       (`mp4a.40.2`) via `AudioEncoder` when supported, else Opus-in-MP4; the
       actual audio codec flows into `meta.mimeType`.
     - `"vp9"` (and `"av1"`) → the existing path: quantizer mode, WebM via
       `webm-muxer` (streaming mode), Opus 48 kbps mono audio.
     - `"auto"` (default) → hardware H.264 when its config is supported with
       hardware acceleration, else VP9. A user-selected codec that turns out
       unsupported falls back down this same chain and the UI shows a note
       naming what was used.
     Common to all codecs: `latencyMode: "realtime"`; captures above QHD
     (2560x1440 pixels) apply a 20fps track constraint after acquisition;
     `quality` maps to per-codec quantizer (or bitrate) tables; backpressure
     (drop incoming **delta** frames when `encodeQueueSize` exceeds a small
     bound); forced keyframe at least every **8 s** of media time; the
     **heartbeat** (re-encode a retained clone of the last frame after ~1 s
     with none, skipped while the queue is over the backpressure bound) — the
     muxing layer sits behind one internal adapter interface so keyframe,
     heartbeat, and audio silence-fill logic exist exactly once. The exact
     container/codec string used flows into `meta.mimeType`
     (e.g. `video/mp4;codecs=avc1.640033,mp4a.40.2` /
     `video/webm;codecs=vp09.00.50.08,opus`). No in-container duration
     (the duration bullet below is unchanged) — for fMP4 this means no
     authoritative `mvhd` duration is required; fragments stream as produced.
  2. **Fallback — MediaRecorder engine** (Firefox etc.): first supported of
     `video/webm;codecs=vp9,opus`, `vp8,opus`, `video/webm`;
     `videoBitsPerSecond` from settings (default **2_500_000**),
     `audioBitsPerSecond` **64_000**, `start(1000)`, blob bytes → `ondata`.

  `meta.mimeType` MUST be the engine's actual string, never the requested one.
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
- The emitted container bytes are retained in memory (as Blob parts, not
  ArrayBuffers) until the share link exists, so a mid-recording upload failure
  can never lose the recording (see §7 failure handling); the same Blob backs
  the preview player and the "Download recording" fallback.

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
- **Buffered-gap jumping (MSE path)**: recordings may still contain small
  video-timeline holes (frames dropped under encoder load). On a playback stall
  (`waiting`, plus a watchdog for stalls Chrome does not event), if
  `currentTime` has nothing playable ahead of it — at the end of a buffered
  range, or inside a hole — and a later range exists, seek forward to that
  range's start plus a small epsilon. A pending seek is not a reason to stand
  down: an MSE seek into a hole never completes, since in-order appends can
  never supply frames that were not encoded, so scrubbing into one would
  otherwise stall forever. Jump any gap size (a stalled player loses everything
  after the hole; the §6 heartbeat keeps real holes sub-second), never seek
  backwards, never move a paused playhead, tear the watchdog down at `error`,
  and stop it in the `ended` state — the next `play` re-arms it, so a replay is
  rescued too.
- Errors: decrypt failure → "wrong key or corrupted video"; 404 → "video not
  found"; network/CORS → actionable message.

## 9. Settings & local library (localStorage, recorder page only)

- `videoshare.settings` (JSON): `endpoint` (e.g. `https://s3.amazonaws.com` or
  `http://localhost:9000`), `region` (default `us-east-1`), `bucket`,
  `accessKeyId`, `secretAccessKey`, `publicBaseUrl` (base URL where the bucket
  is readable, e.g. `http://localhost:9000/videoshare` or a CDN domain),
  `quality` (`"smaller" | "standard" | "sharper"`, default `"standard"`),
  `codec` (`"auto" | "h264" | "vp9" | "av1"`, default `"auto"` — the settings
  UI presents this as a select with honest labels: Auto picks hardware H.264
  when available; H.264 = smooth/hardware/larger files/plays everywhere; VP9 =
  software/smallest files/may drop frames at high resolution; AV1 = smallest
  but some Safari viewers can't play), `videoBitsPerSecond` (fallback
  MediaRecorder engine only, default 2_500_000). Loading settings stored by
  older versions must not error — fill defaults; a stored `preferAv1: true`
  migrates to `codec: "av1"`.
- `videoshare.recording` (JSON): `{ quality, codec, videoBitsPerSecond }` — the
  same three fields, defaults and normalization, stored separately for gateway
  mode, which has no storage settings panel to keep them in (§15.5). Legacy mode
  neither reads nor writes it.
- `videoshare.library` (JSON array of): `{ id, title, createdAt, durationMs,
  link, sizeBytes? }` — newest first; list in UI with copy-link and
  delete-from-list (delete only removes the local entry in v1, it does not
  delete from bucket). When `sizeBytes` is present the UI also shows size and
  effective bitrate (e.g. "14.2 MB · 1.9 Mbps") so compression is observable.
  Entries without `sizeBytes` (older) must render fine.

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
  quality: Quality; codec: CodecChoice; videoBitsPerSecond: number; }
export interface RecordingPrefs { quality: Quality; codec: CodecChoice;
  videoBitsPerSecond: number; }                           // §15.5, gateway mode
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
export function loadRecordingPrefs(): RecordingPrefs;     // never null — defaults fill the gaps
export function saveRecordingPrefs(p: RecordingPrefs): boolean;  // false = storage refused, not fatal
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

- `package.json`: deps `aws4fetch`, `webm-muxer`, `mp4-muxer`; devDeps `typescript`,
  `vite`, `vitest`. Scripts: `dev` (vite), `build` (`tsc --noEmit && vite build`),
  `preview`, `test` (`vitest run`), `test:e2e` (`vitest run --config vitest.e2e.config.ts`,
  only meaningful with MinIO up).
- Vite multi-page: rollup inputs `index.html` + `view.html`. `public/config.js`
  copied verbatim to `dist/`.
- TypeScript `strict: true`. No frameworks, no other runtime deps.

## 13. Tests

- Node cannot run WebCodecs, so the encoder's browser paths are exercised only
  manually; unit tests cover the pure parts of `encoder.ts` (codec-string
  construction for VP9/AV1/H.264 at representative resolutions, quantizer and
  bitrate tables, and the codec/engine selection matrix — every CodecChoice x
  capability combination incl. hardware-rejected H.264 — given injected
  capability flags) in `tests/encoder.test.ts`.
- `tests/settings.test.ts` (vitest, against a stand-in `localStorage`): the
  `videoshare.recording` key (§15.5) — defaults from an empty, unparseable or
  non-object value, per-field fallback for an invalid quality/codec/bitrate,
  save/load round-trip, no `preferAv1` migration, and a blocked or refusing
  store reported rather than thrown.
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

## 15. Gateway (optional): server-side credentials, presigned uploads

An optional, **stateless** service that removes all bucket credentials from
browsers. Core invariant: **the gateway MUST NOT proxy object data — every
storage byte flows browser↔bucket via presigned URLs. There is no proxy mode
and none may be added.** The gateway holds the bucket credentials (env vars),
authenticates uploaders, and signs URLs. It never streams, never stores state,
and depends on nothing but its env — so one core handler runs identically as a
Cloudflare Worker, an AWS Lambda (function URL), or a plain Node process.

### 15.1 Package layout

`gateway/` — its own npm package (root repo stays a plain static site):
```
gateway/
├── package.json          # deps: aws4fetch, jose; no framework
├── tsconfig.json
├── src/
│   ├── core.ts           # handleRequest(req: Request, env: GatewayEnv): Promise<Response>
│   ├── auth.ts           # Google ID-token verification (jose) + whitelist
│   ├── presign.ts        # SigV4 query-string presigning via aws4fetch
│   ├── worker.ts         # Cloudflare Worker adapter (export default { fetch })
│   ├── lambda.ts         # Lambda function-URL adapter (event ↔ Request/Response)
│   └── node.ts           # plain Node http server adapter
└── wrangler.jsonc        # Worker deploy config (name videoshare-gateway)
```
Adapters are thin translations only; ALL logic lives in core/auth/presign
(WHATWG Request/Response — native in Workers, Lambda via adapter, Node ≥20).

### 15.2 Environment (identical across adapters)

`BUCKET_ENDPOINT`, `BUCKET_NAME`, `BUCKET_REGION` (default `auto`),
`BUCKET_ACCESS_KEY_ID`, `BUCKET_SECRET_ACCESS_KEY`, `PUBLIC_BASE_URL`,
`GOOGLE_CLIENT_ID`, `ALLOWED_EMAILS` (comma-separated; each entry is a full
email or a `@domain.com` suffix; case-insensitive), `ALLOWED_ORIGINS`
(comma-separated origins for the gateway's own CORS; `*` forbidden),
`PRESIGN_EXPIRY_SECONDS` (default 900, max 3600). Test-only overrides
`OIDC_JWKS_URL` / `OIDC_ISSUER` (§15.6) default to Google's.

### 15.3 Endpoints

All responses JSON; errors are `{ error: string }` with status. The gateway
answers CORS preflights itself and echoes only origins in `ALLOWED_ORIGINS`.

- `GET /api/config` — public, no auth:
  `{ gateway: true, publicBaseUrl, googleClientId }`.
- `POST /api/sign` — requires `Authorization: Bearer <Google ID token>`
  (verified per §15.4). Body is one of:
  - `{ op: "create", id }` → presigned CreateMultipartUpload →
    `{ url, method: "POST" }`
  - `{ op: "part", id, uploadId, partNumbers: number[] }` (1–100 entries,
    each 1–10000) → `{ urls: [{ partNumber, url }] }`, method PUT
  - `{ op: "complete", id, uploadId }` → `{ url, method: "POST" }` (client
    sends the XML body; SigV4 query auth does not bind the payload —
    UNSIGNED-PAYLOAD — so no body hash is needed)
  - `{ op: "abort", id, uploadId }` → `{ url, method: "DELETE" }`
  - `{ op: "put-meta", id }` → presigned PUT for `{id}/meta.json` →
    `{ url, method: "PUT" }`
  Validation (400 on failure): `id` must match `^[A-Za-z0-9_-]{22}$`; object
  keys are constructed server-side as exactly `{id}/video.bin` /
  `{id}/meta.json` — the client can never influence any other key; `uploadId`
  and `partNumbers` are syntax-checked and passed through as query params
  (URL-encoded). Auth failures: 401 (bad/expired token), 403 (valid token,
  email not allowed).

### 15.4 Authentication (stateless)

Verify the bearer as a Google ID token using `jose` against the JWKS at
`OIDC_JWKS_URL` (cached per its HTTP cache headers): RS256 only (reject any
other `alg`), `iss` must equal `OIDC_ISSUER` (default: accepts both
`accounts.google.com` and `https://accounts.google.com`), `aud` must equal
`GOOGLE_CLIENT_ID`, `exp`/`nbf` enforced, `email_verified` must be `true`,
then `email` checked against `ALLOWED_EMAILS`. No sessions, no cookies, no
refresh logic server-side. The verified email MAY be logged for audit; the
token itself must never be logged.

### 15.5 Client behavior (recorder page)

- `public/config.js` gains optional `gatewayUrl` (absolute, or relative like
  `"/api"` for same-origin deployments). Present → **gateway mode**: the
  **storage** settings panel is not rendered (credentials never live in this
  browser); client fetches `{gatewayUrl}/config`; recording requires Google
  sign-in (Google Identity Services script, ID token kept in memory only —
  never localStorage). Absent → **legacy mode**, §9 unchanged.
- What gateway mode does keep is the encoder half of §9, in a **Recording
  options** panel of its own: `quality`, `codec` and `videoBitsPerSecond` with
  the same values, defaults and normalization, persisted at
  `videoshare.recording` (a key newer than `preferAv1`, so nothing to migrate).
  It appears once `/config` answers, before and independently of sign-in — which
  codec this machine can encode is the operator's business, not the gateway's —
  and saves on change, with no Save button. A browser that refuses localStorage
  keeps the choice in memory for the session and says so; it never blocks a
  recording. Legacy mode leaves these three fields where they are, inside the
  storage settings form.
- `upload.ts` grows a `Signer` seam: `LocalSigner` (aws4fetch with settings
  creds — legacy mode, current behavior) and `GatewaySigner` (calls
  `/api/sign`; batches part URLs ahead of need, e.g. 8 at a time, so signing
  never stalls the upload queue). `UploadSession` logic is otherwise
  unchanged; presigned URLs are used exactly like signed requests today.
- On a 401 mid-session, the client re-acquires an ID token silently (GIS
  `prompt()` with auto-select) and retries once; if that fails, the part
  queue's existing retry/degraded path applies and the UI shows a re-sign-in
  prompt without stopping the recording.
- The player and viewing flow are untouched (public reads, no gateway).

### 15.6 Tests

No insecure test bypasses in the gateway (no magic bearer tokens): e2e and
unit tests generate an RS256 keypair, serve a local JWKS, set
`OIDC_JWKS_URL`/`OIDC_ISSUER`, and mint real JWTs — the production verification
path runs verbatim. Unit tests (Node): token verification (wrong alg/iss/aud/
exp/unverified email → 401; non-whitelisted → 403; suffix matching), key-shape
enforcement (op/id/partNumbers validation), presigned URL shape (X-Amz-*
params, expiry), CORS allowlist. E2E (vitest, `E2E=1`): start the Node adapter
in-process against local MinIO and drive the full client path — GatewaySigner
multipart upload (≥3 parts), complete, meta PUT, then anonymous ranged
download/decrypt byte-compare; plus abort; plus a rejected non-whitelisted
token. R2's presigned UploadPart support is community-confirmed only, so the
first real-R2 deployment MUST run a smoke upload before rollout (documented).

### 15.7 Docs & examples

- `docs/gateway-setup.md`: creating the Google OAuth client id (authorized JS
  origins = site origin), deploying each adapter (wrangler for Workers +
  secrets; Lambda function URL; Docker/Node next to MinIO), env reference,
  whitelist management, and the R2 smoke-test step.
- `examples/docker-compose.yml`: optional `gateway` service (Node adapter)
  wired to MinIO, off by default (profile), since local Google sign-in needs a
  real client id with localhost origins.
- README: gateway mode vs legacy mode, one paragraph + pointer.
