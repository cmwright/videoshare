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
export function parseShareFragment(fragment: string):     // "#{id}.{key}" per §2, or null
  { id: string; keyB64: string } | null;
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
export function analyticsAad(id: string, sessionId: string): string;  // `${id}:analytics:${sessionId}` (§16)
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

`watch.ts` / `beacon.ts` / `dashboard.ts` — playback analytics (§16), split the way
§8's arithmetic is: `watch.ts` is pure watch-range, heat and aggregation math (no DOM,
so Node tests and both halves of §16 import it), `beacon.ts` is the browser-side
tracker and flush on `view.html`, and `dashboard.ts` is the analytics expander
`record.ts` hangs on each library row (§16.6). Full signatures in §16.5/§16.6.

Page-specific styles live in `src/record.css` / `src/player.css`; shared design tokens
and base styles in `src/app.css`. The dashboard's heatmap styles are `record.css`'s —
it renders into the recorder's library.

## 12. Build & tooling

- `package.json`: deps `aws4fetch`, `webm-muxer`, `mp4-muxer`; devDeps `typescript`,
  `vite`, `vitest`. Scripts: `dev` (vite), `build` (`tsc --noEmit && vite build`),
  `preview`, `test` (`vitest run`), `test:e2e` (`vitest run --config vitest.e2e.config.ts`,
  only meaningful with MinIO up).
- Vite multi-page: rollup inputs `index.html` + `view.html` — §1's two pages, and
  after §16.6 the only two. `dist/` is not committed, so a `stats.html` or a `stats`
  chunk in it is a stale local build and `npm run build` on a clean tree must produce
  neither. `public/config.js` copied verbatim to `dist/`.
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
- `tests/watch.test.ts` (vitest, Node): the pure helpers of `watch.ts` (§16.5) —
  seconds→ms normalization, clamping, merging and the 200-range cap; `coverage`
  and `isCompleted` around the 0.9 threshold and at `durationMs = 0`; heat
  accumulation (normal steps, discarded seeks in both directions, re-anchoring,
  bucket boundaries, unknown duration); the v1→heat derivation; per-viewer
  grouping, summing and the two normalizations; strict payload parsing of both
  versions. §16.9 has the detail, plus what §16 adds to `tests/beacon.test.ts`,
  `tests/crypto.test.ts`, `tests/gateway.test.ts` and `tests/e2e.gateway.test.ts`.
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
and none may be added.** (§16.3's ≤ 16 KiB analytics beacon is the single,
deliberately bounded exception: write-only, opaque ciphertext, no read path. No
stored byte ever flows back out through the gateway.) The gateway holds the bucket credentials (env vars),
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
`PRESIGN_EXPIRY_SECONDS` (default 900, max 3600), and the optional
`ANALYTICS_BUCKET` (§16.4; unset = analytics off). Test-only overrides
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
- The player and viewing flow are untouched (public reads, no gateway) — with the
  single exception of §16. In gateway mode `view.html` reads `{gatewayUrl}/config`
  once per page load, to learn whether analytics is on (§16.4), and sends §16.3's
  beacon only when it is; those two are the only requests it ever makes to the
  gateway. In legacy mode it makes neither (§16.7).

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

## 16. Playback analytics (optional): end-to-end encrypted watch data

Who watched how much of a video, without the server learning any of it. The viewer
already holds the video's AES key — it is in the share link's fragment — so the
player encrypts everything it has to say about the watch **with that same key**
before it leaves the tab. The gateway and the analytics bucket only ever hold
ciphertext, a video id, a random session label, and the storage layer's own
timestamp and byte count. Watch data is therefore readable by exactly the people
who can already watch the video: holders of the share link.

Three invariants hold everywhere in this section:

1. **No IP address is read, stored or logged for analytics** — not into an object,
   not into a log line, not into a header the gateway inspects.
2. **The fragment key never leaves the browser.** It appears in no beacon body, no
   URL, no header, no query. (Browsers strip fragments from `Referer`; nothing here
   ever copies one into a path or a query, which is the only way it could reappear.)
3. Analytics is **off** unless a gateway is configured *and* `ANALYTICS_BUCKET` is
   set. Legacy mode (§9/§10) makes no new network call and writes no new key.

### 16.1 Identifiers

Two ids, both 16 random bytes → base64url, unpadded, 22 characters (§2's
`randomId()`), both **inside the encrypted payload**, neither derived from anything
about the viewer:

- **`browserId`** — persisted in the *viewer's* localStorage under
  `videoshare.viewer` (a bare string, not JSON). Minted on first use and reused
  afterwards, so the library dashboard (§16.6) can collapse repeat viewings by one
  browser into one "viewer". When storage is unavailable or refuses (§9's rules), an ephemeral
  in-memory id is used **silently** — a viewer is never asked to fix their browser.
  It is written only when a beacon will actually be sent, so a legacy deployment
  leaves nothing behind on `view.html`. This is the only key `view.html` writes; it
  holds no settings and no identity, and it is the one narrowing of §10.
- **`sessionId`** — minted per player page load, memory only, never persisted. One
  session = one viewing instance = one storage object.

### 16.2 Beacon payload (plaintext, before encryption)

```jsonc
{
  "v": 2,                             // format version, integer
  "browserId": "8f3k2Jd0QpZ1nV7xLmA9Bw",
  "sessionId": "Qr4TgYs2Nb6HcE0uWkP1Zx",
  "durationMs": 93250,
  "watched": [[0, 41200], [58000, 93250]],   // [startMs, endMs), merged, sorted, disjoint
  "heat": [1865, 1902, 0, /* … 50 in all … */ 4310],  // ms of playback per 2% bucket
  "completed": false,
  "firstPlayedAt": "2026-08-27T21:04:00.000Z"  // ISO 8601 UTC
}
```

- `durationMs` — `meta.durationMs` (§5, authoritative) when > 0; otherwise the media
  element's `duration × 1000`, rounded; `0` when neither is finite and positive.
- `watched` — integer milliseconds, derived from the media element's `played`
  TimeRanges at flush time (§16.5). Union semantics: a stretch watched three times
  appears once, so this is "seen at least once", never "time spent". At most
  `MAX_WATCH_RANGES` (200) entries. Unchanged by v2: coverage and completion are
  still computed from it and mean exactly what they meant before.
- `heat` — exactly `HEAT_BUCKETS` (50) non-negative integers, one per 2% of *this
  session's own* `durationMs`. Entry *b* is the **milliseconds of actual playback**
  spent inside bucket *b*, accumulated during playback by §16.5's rule and **not** a
  union: a section watched twice holds roughly twice its own length, and scrubbing
  across the video adds ~nothing. This is the "time spent" number `watched` refuses to
  be, and the two ship together because they answer different questions. All zeros is
  a legitimate value (a session whose duration was never known — see §16.5).
- `completed` — `coverage ≥ COMPLETION_THRESHOLD` (0.9), recomputed at every flush by
  the same helper the reader uses, so the two sides agree by construction.
- `firstPlayedAt` — the first `play` of this session; stable across every flush.

**Versions.** Every beacon writes `v: 2`. Version 1 — the same object without `heat` —
is **read-only** and stays readable forever: the reader accepts it and derives a heat
array from `watched` alone (`heatFromRanges`, §16.5), which is the milliseconds of each
bucket the union covers. A v1 session therefore reads as binary intensity capped at 1×
and can never look hotter than watched-once, which is exactly as much as a v1 payload
knows. Any other `v` — `0`, `3`, `"2"`, absent — is not a payload at all: `parsePayload`
returns null and the session is **skipped and counted** with the ones that fail to
decrypt (§16.6). A v1 object carrying a stray `heat` field is still a v1 payload; the
field is ignored, like every other unknown field.

Encryption is exactly §4's single block — `IV (12) ‖ ciphertext ‖ tag (16)`, same
AES-GCM key as the video — with AAD `"{videoId}:analytics:{sessionId}"`
(`analyticsAad()`, §11). The AAD binds the block to one video *and* one session, so
an object copied to another key or another session id fails to decrypt. Plaintext is
the JSON above, UTF-8, `JSON.stringify` with no padding or pretty-printing.

Every flush carries the **whole cumulative state**, never a delta. The 16 KiB body
cap (§16.3) is therefore a cap on an entire session, which is what
`MAX_WATCH_RANGES` exists to guarantee: a merged list longer than 200 is coalesced
across its **smallest gaps first** (`capRanges`) until it fits, so the error is
bounded by the narrowest gaps in the list and the shape of the curve survives.
`heat` cannot grow the body the way `watched` could: it is always 50 numbers, and even
at absurd values (a bucket holding a full day of replayed playback, ~8 digits each) it
adds well under 1 KiB of JSON. The cap stays `MAX_WATCH_RANGES`'s job, and §16.9 pins
that with an assertion on a pathological v2 payload rather than an argument.

### 16.3 Beacon endpoint (viewer → gateway → bucket)

`POST {gatewayUrl}/beacon/{videoId}/{sessionId}` — **unauthenticated**. Viewers have
no identity and must never be asked for one.

- Sent with `navigator.sendBeacon(url, blob)`, body = the raw ciphertext bytes.
  `sendBeacon` cannot set headers, so **all routing lives in the path**. The Blob's
  type is `text/plain;charset=UTF-8`: a CORS-safelisted content type, chosen so that
  no preflight can strand a beacon fired at `pagehide`. The bytes are unaffected by
  that label and the gateway never reads the Content-Type. (The client never reads
  the response, so whether the browser's CORS check on the 204 passes is irrelevant
  to it; the gateway answers with the usual echoed origin and, as everywhere else,
  no `Access-Control-Allow-Credentials`.)
- Both mount points, exactly as §15.3's routes: `/api/beacon/…` and `/beacon/…`.
- Validation: `videoId` and `sessionId` must each match §15.3's `^[A-Za-z0-9_-]{22}$`
  → else **400**; body 1…`MAX_BEACON_BYTES` (16384) bytes, counted *while reading*
  (§15's bounded-read rule, not a declared `Content-Length`) → else **413**;
  `ANALYTICS_BUCKET` unset → **404**; any method but POST/OPTIONS → **405**; an
  `Origin` outside `ALLOWED_ORIGINS` → **403**, from the same check every other route
  already passes through. Preflight for this route answers
  `Access-Control-Allow-Methods: GET, POST, OPTIONS`.
- On success the gateway performs **one server-side S3 `PutObject`** of the raw body
  to `{ANALYTICS_BUCKET}/{videoId}/{sessionId}.bin` with
  `Content-Type: application/octet-stream`, and answers **204** with no body. A
  bucket that rejects the write → **502**. The gateway never inspects, parses,
  decompresses or rewrites the body; it is opaque ciphertext to it.

**This is the one bounded exception to §15's no-proxy invariant**, and it is bounded
on purpose: one direction (write only), ≤ 16 KiB, opaque bytes, a key the gateway
constructs itself from two validated ids, and no read path whatsoever. Nothing may
be added to it, and no response on any route may ever carry stored bytes.

`GET {gatewayUrl}/beacon/{videoId}` — **authenticated exactly like `POST /api/sign`**
(§15.4: Google bearer token, `ALLOWED_EMAILS`; 401 bad/expired token, 403 valid token
not whitelisted, 503 identity provider unreachable). It lists the analytics bucket
under prefix `{videoId}/` with `ListObjectsV2`, server-side, and answers:

```jsonc
{
  "sessions": [
    { "sessionId": "Qr4TgYs2Nb6HcE0uWkP1Zx",
      "lastModified": "2026-08-27T21:41:02.000Z",  // ISO 8601 UTC, from S3
      "size": 291,                                  // ciphertext bytes
      "url": "https://…X-Amz-Signature=…" }         // short-lived presigned GET
  ],
  "truncated": false
}
```

- `url` is a presigned GET for that object, expiring per `PRESIGN_EXPIRY_SECONDS`
  (§15.2). The browser fetches the ciphertext **straight from the bucket** — the
  gateway never streams a stored byte back (§15).
- Pagination is followed to `MAX_LISTED_SESSIONS` (1000). Stopping early sets
  `truncated: true` rather than silently trimming, and the dashboard says so in the
  expander it was asked from.
- Keys that do not match `{videoId}/{22 base64url}.bin` are skipped: nothing else
  belongs in that prefix, and if something is there it is not a session.
- Malformed `videoId` → **400**; analytics disabled → **404**; any method but
  GET/OPTIONS → **405**; a bucket that rejects the listing → **502**.
- The whitelist here is the *uploader* whitelist: anyone who may upload through this
  gateway may list sessions for any video id they know. Ids are 128-bit random and
  only reachable through a share link, but this is a real property and the README
  says so rather than implying per-video ownership that does not exist.

### 16.4 Gateway configuration and storage layout

- One new optional variable, `ANALYTICS_BUCKET` — a bucket **name**. Credentials,
  endpoint and region are §15.2's: the analytics bucket lives in the same account and
  provider. It is validated by §15.2's bucket-name rule and **must not equal
  `BUCKET_NAME`** — §3's bucket is world-readable by design and watch data must never
  land in it. That is a boot-time `GatewayConfigError`, not a runtime surprise.
- Unset → analytics is off: `/config` answers `analytics: false` and both beacon
  routes 404. This is a supported configuration, not a broken one.
- `GET /api/config` gains `"analytics": true | false` beside `gateway`,
  `publicBaseUrl` and `googleClientId`. `types.ts`'s `GatewayConfig` and
  `settings.ts`'s `fetchGatewayConfig` gain the same boolean; a `/config` that omits
  it reads as `false`, so a newer site against an older gateway simply sends no
  beacons.
- Object key, constructed server-side only and never from client input beyond the two
  validated ids: **`{videoId}/{sessionId}.bin`**.
- **Overwrite-collapse storage model**: every flush of a session PUTs the same key, so
  the last successful write *is* the session. No compaction, no merging, no append, no
  read-modify-write — the gateway never reads an analytics object. Beacons are not
  ordered by the browser; a lost or reordered flush costs at most the delta between
  two cumulative states, and the object that stands is the newest one the bucket
  accepted.
- The analytics bucket MUST be **private**: no public domain attached, no anonymous
  read policy. It needs no CORS for writes (the gateway writes it) but DOES need
  `GET` CORS from the site origin, because the library dashboard fetches presigned
  URLs from it directly (§16.10).
- Logging: the beacon handler writes **no per-request log line** — not the session id,
  not a size, not an origin. A failed write logs the video id and the storage status
  and nothing else. No IP-bearing header (`CF-Connecting-IP`, `X-Forwarded-For`,
  `request.cf`, Lambda's `sourceIp`) is read on any analytics path.

New module `gateway/src/analytics.ts` — adapters stay thin translations; all logic
lives in core/auth/presign/analytics:

```ts
export const MAX_BEACON_BYTES: number;      // 16384
export const MAX_LISTED_SESSIONS: number;   // 1000
export interface SessionSummary { sessionId: string; lastModified: string; size: number; url: string; }
export interface SessionListing { sessions: SessionSummary[]; truncated: boolean; }
export interface AnalyticsStore {
  put(videoId: string, sessionId: string, body: Uint8Array): Promise<void>;
  list(videoId: string): Promise<SessionListing>;
}
export function analyticsKey(videoId: string, sessionId: string): string;  // `${videoId}/${sessionId}.bin`
export function createAnalyticsStore(config: BucketConfig): AnalyticsStore;
```

Its two server-side calls are signed with `aws4fetch`'s `AwsClient` and its presigned
GETs reuse `presign.ts`'s query-signing path — **no new runtime dependency**, in
either package. `core.ts` gains `ANALYTICS_BUCKET` in `GatewayEnv`,
`analytics: BucketConfig | null` in `GatewayConfig`, and a `"beacon"` route in
`routeOf`. `MAX_BEACON_BYTES` is the same 16384 as §15's `MAX_SIGN_BODY_BYTES` but is
declared separately: the gateway is its own package and imports nothing from `src/`.

### 16.5 Client watch tracking

Two modules, split on testability the same way §8's arithmetic lives in `gap.ts`.

`watch.ts` — pure, no DOM, no clock, imported by Node tests, by `beacon.ts` and by the
library dashboard:

```ts
export type Range = [startMs: number, endMs: number];

export interface WatchPayloadV1 { v: 1; browserId: string; sessionId: string;
  durationMs: number; watched: Range[]; completed: boolean; firstPlayedAt: string; }
export interface WatchPayloadV2 extends Omit<WatchPayloadV1, "v"> { v: 2; heat: number[]; }
export type WatchPayload = WatchPayloadV1 | WatchPayloadV2;

export const BEACON_INTERVAL_MS: number;      // 30_000
export const MAX_WATCH_RANGES: number;        // 200
export const COMPLETION_THRESHOLD: number;    // 0.9
export const HEAT_BUCKETS: number;            // 50 → one bucket per 2% of duration
export const MAX_PLAYBACK_DELTA_MS: number;   // 1_500 — a bigger step is a seek, not playback

// Coverage, unchanged.
export function playedRanges(played: TimeRangesLike, durationMs: number): Range[];
export function mergeRanges(ranges: readonly Range[]): Range[];
export function capRanges(ranges: readonly Range[], max?: number): Range[];
export function watchedMs(ranges: readonly Range[]): number;
export function coverage(ranges: readonly Range[], durationMs: number): number;   // 0..1
export function isCompleted(ranges: readonly Range[], durationMs: number): boolean;

// Heat accumulation: a pure reducer; `beacon.ts` holds one state and feeds it events.
export interface HeatState { readonly heat: readonly number[]; readonly lastMs: number | null; }
export function createHeatState(buckets?: number): HeatState;
export function advance(state: HeatState, currentMs: number, durationMs: number): HeatState;
export function reanchor(state: HeatState, currentMs: number): HeatState;
export function heatMs(state: HeatState): number[];    // rounded integers, length = buckets

// Heat reading: what the dashboard aggregates from decrypted payloads.
export interface WatchSession { payload: WatchPayload; lastModified: string; }
export interface ViewerReport { browserId: string; plays: number; heat: number[];
  coverage: number | null; lastWatched: string; }
export function heatFromRanges(watched: readonly Range[], durationMs: number, buckets?: number): number[];
export function sessionHeat(payload: WatchPayload, buckets?: number): number[];
export function sumHeat(payloads: readonly WatchPayload[], buckets?: number): number[];
export function relativeHeat(payloads: readonly WatchPayload[], buckets?: number): number[];
export function normalizeHeat(heat: readonly number[]): number[];   // 0..1 against the largest bucket
export function groupByViewer(sessions: readonly WatchSession[]): ViewerReport[];

export function parsePayload(value: unknown): WatchPayload | null;   // strict; null, never throws
```

What the coverage helpers pin, unchanged by v2: seconds → ms by `Math.round`; every
range clamped to `[0, durationMs]` (or left as-is when `durationMs` is 0); ranges with
`end ≤ start` after rounding dropped; output sorted by start, non-overlapping, with
touching ranges merged; then `capRanges`. `coverage` = `watchedMs / durationMs`, capped
at 1, and `0` when `durationMs ≤ 0`. `TimeRangesLike` is `gap.ts`'s — the same
structural type the real `TimeRanges` satisfies.

**Heat accumulation**, pinned exactly, because two sides have to agree on it and a
seek must never look like watching:

- `HeatState` is immutable — `advance` and `reanchor` return a new state and mutate
  nothing, so a test can hold both sides of a step. `createHeatState()` is all-zero
  heat and `lastMs: null` (no observation point yet).
- `advance(state, currentMs, durationMs)` is one `timeupdate`. With
  `deltaMs = currentMs - state.lastMs`:
  - `state.lastMs === null` → no delta exists; the call only sets the observation
    point to `currentMs`.
  - `deltaMs ≤ 0` or `deltaMs > MAX_PLAYBACK_DELTA_MS` → **discarded**. A backwards
    step is a seek back, a step over 1.5 s is a seek forward or a stall the viewer did
    not watch through, and neither is playback. The observation point still moves to
    `currentMs`, so the next step is measured from where the video actually is.
  - otherwise `deltaMs` is added to bucket
    `min(HEAT_BUCKETS - 1, max(0, floor(currentMs / durationMs * HEAT_BUCKETS)))` —
    the bucket of the **arriving** position, whole. A delta straddling a boundary is
    not split: the error is under 1.5 s per boundary crossing, and splitting would buy
    precision nothing downstream can use.
  - `durationMs` not finite or `≤ 0` → there is no bucket to name, so every delta is
    discarded and heat stays all zeros while the observation point still advances. A
    session that only ever learns its duration mid-playback therefore accumulates from
    that moment on, and one that never learns it ships 50 zeros (§16.2).
- `reanchor(state, currentMs)` sets the observation point to `currentMs` and touches
  no bucket. It is what a discontinuity costs: the delta across it is dropped.
- `heatMs(state)` rounds each bucket to an integer. Accumulation itself is in floating
  milliseconds — rounding 4 times a second would drift by minutes over a long video.
- Heat is **media time, not wall-clock time**: the deltas come from `currentTime`, so a
  viewer at 2× accumulates the same heat over a stretch as a viewer at 1×. But a delta
  is roughly `timeupdate cadence × playback rate`, so the rate at which heat starts
  falling past `MAX_PLAYBACK_DELTA_MS` and quietly under-counting is **set by a cadence
  this module does not control**, not by a fixed multiple:
  - at the ~250 ms cadence a foreground tab fires, deltas pass 1.5 s above roughly 6×;
  - in a tab the browser has throttled — backgrounded, or on an energy saver — the
    cadence can fall to about 1 Hz, and the cutoff falls with it to roughly 1.5×. A
    viewer listening at 2× in a background tab therefore ships **near-zero heat** for a
    full real listen, not a slightly low number.

  Coverage, `completed` and the header counts of §16.6 are unaffected in every one of
  these cases: they are read from `video.played` at flush time, which no cadence
  touches. Only the heatmap under-counts. That is accepted, not fixed: the alternative
  is a sampling timer, and this section's whole shape is that there isn't one. Raising
  `MAX_PLAYBACK_DELTA_MS` is not the fix either — the cap is what stops a seek from
  painting heat across a video nobody played, and a throttled tab's 1 Hz cadence is
  indistinguishable from a stall at the only place the decision is made.

**Heat reading**, equally pinned, because §16.6 renders these numbers as a picture and
a picture that lies is worse than no picture:

- `heatFromRanges(watched, durationMs)` — bucket *b* spans
  `[b·durationMs/50, (b+1)·durationMs/50)`, the last one ending on `durationMs`
  inclusive; the bucket's value is the summed overlap in milliseconds between the union
  and that span, rounded. Because `watched` is disjoint, no bucket can exceed its own
  span: v1 reads as 1× at most, by construction. `durationMs ≤ 0` → all zeros.
- `sessionHeat(payload)` — `payload.heat` for v2, `heatFromRanges(payload.watched,
  payload.durationMs)` for v1. This is the **only** place a version
  difference is allowed to matter; every consumer above it reads one shape.
- `sumHeat(payloads)` — per bucket, the sum of `sessionHeat` over the payloads.
  Sessions of differently-timed videos still stack, because a bucket is 2% of *each
  session's own* duration.
- `relativeHeat(payloads)` — the "×" number §16.6 puts in every bar's tooltip:

  ```
  relative[b] = sumHeat(payloads)[b] / Σ  (s.durationMs / HEAT_BUCKETS)
                                     s ∈ payloads, s.durationMs > 0
  ```

  The denominator is the playback time one pass through that bucket would take, summed
  over the sessions that have a duration — so for equal-duration sessions it is exactly
  `bucketMs / (sessions × bucketDurationMs)`, and it stays honest when the durations
  differ instead of quietly picking one video's length for everyone. `1.0` means "on
  average these sessions played this slice once through"; `2.4` means they played it
  about two and a half times. Sessions with `durationMs ≤ 0` are excluded from **both**
  sides (their heat is all zeros by §16.5, so counting them in the denominator would
  only dilute the answer) while still counting as sessions in §16.6's header. An empty
  denominator → all zeros.
- `normalizeHeat(heat)` — each bucket over the largest bucket, `0..1`; an all-zero
  input gives all zeros. This is the **height** channel of §16.6's bars, and it is
  deliberately not `relativeHeat`: height shows shape within one video, the tooltip
  and the hot threshold show intensity against 1×.
- `groupByViewer(sessions)` — one `ViewerReport` per distinct `browserId`, with
  `plays` = that viewer's session count, `heat` = `sumHeat` over their payloads,
  `coverage` = the **best** (highest) `coverage(watched, durationMs)` among their
  sessions with a known duration, or `null` when none has one, and `lastWatched` = the
  greatest `lastModified` of their sessions (the listing's timestamp — §16.3 — because
  a payload carries no last-activity time). Sorted by `lastWatched` descending, ties
  broken by `browserId` ascending so the order is deterministic in a test. A
  `browserId` that is not 22 base64url characters is **never collapsed with anything**:
  each such session becomes its own single-play viewer (keyed internally by its
  `sessionId`) and reports that `browserId` verbatim.
- `ATTENTION_BUCKETS` and `attentionCurve` are **removed**, replaced by `HEAT_BUCKETS`
  (the same 50) and the aggregates above. The curve counted *how many sessions touched
  a bucket* — the binary question heat answers with more resolution, and the one
  `heatFromRanges` recovers exactly for a v1 payload. After §16.6's rewrite nothing
  imports it, and an export nothing imports is not a contract.
- `parsePayload` stays strict and still never throws: `v` must be `1` or `2`; for `v: 2`
  `heat` must be an array of exactly `HEAT_BUCKETS` non-negative integers, and anything
  else — 49 entries, a float, a negative, a string — makes the whole payload null. The
  write endpoint is unauthenticated (§16.3), so a heat array is as untrusted as a range
  list.

`beacon.ts` — the browser half (needs `navigator`, `document`, WebCrypto):

```ts
export interface BeaconOptions { gatewayUrl: string; videoId: string; key: CryptoKey; durationMs: number; }
export interface WatchBeacon { stop(): void; }   // final flush, then teardown
export function startWatchBeacon(video: HTMLMediaElement, opts: BeaconOptions): WatchBeacon;
export function viewerId(): string;              // `videoshare.viewer`; in-memory when storage refuses
```

- The flush timer starts on the first `play` and is cleared at `ended` and at
  `pagehide`. There is **no polling loop beyond it**: ranges are read from
  `video.played` at flush time, not sampled, and heat rides the element's own
  `timeupdate` (below) rather than a clock of ours.
- Flush triggers: every `BEACON_INTERVAL_MS` while the timer runs, on `pause`, on
  `ended`, on `visibilitychange` → `hidden`, and on `pagehide`. `pause` is immediate
  and needs no debounce: browsers fire `pause` just before `ended`, and the flush
  already refuses to re-send a body identical to the last one the browser accepted, so
  the pair costs one write, not two.
- Heat (§16.2) is accumulated with `watch.ts`'s reducer over one `HeatState` held for
  the session: every `timeupdate` calls `advance(state, video.currentTime * 1000,
  durationMs)` — the browser fires it only while playback is progressing, a few times
  a second — and `seeking`, `seeked` and `play` call `reanchor(state,
  video.currentTime * 1000)` instead. That is the whole reset rule: a scrub loses the
  delta across itself and adds ~nothing, a pause of any length adds nothing because
  the `play` on the other side re-anchors, and a section watched twice accumulates
  about twice its own length. `heatMs(state)` is read at flush time, beside
  `playedRanges`.
- **No beacon at all** when: `config.js` sets no `gatewayUrl`; `/config` did not
  answer `analytics: true`; nothing has been played yet (`watched` is empty); or the
  page is the recorder. Beacons come from `view.html` only — `record.ts` never calls
  this and the recorder's preview element is not tracked.
- **Every failure is silent**: a `sendBeacon` that returns false, a 4xx, an encrypt
  that throws. Nothing reaches the viewer, nothing retries in a loop; the next
  scheduled flush carries the same cumulative state anyway.
- `player.ts` starts it after `meta` is loaded and the gateway config has resolved,
  and does nothing else differently. Both `player.ts` and the library dashboard
  (§16.6) parse `#{id}.{key}` through one exported `parseShareFragment()` in `util.ts`
  (§11) so the §2 format lives in one place — a pure refactor, playback behaviour
  unchanged.

### 16.6 Library dashboard (`index.html`, `src/dashboard.ts`)

**There is no stats page.** Watch data belongs next to the video it is about, and the
recorder already lists every video this browser made (§9's library). So each library
entry grows an **Analytics expander**, and `stats.html`, `src/stats.ts` and
`src/stats.css` are **deleted** — along with the rollup input that built them (§12).

When the expander exists at all:

| `config.js` | `/config` | signed in | library entry shows |
| --- | --- | --- | --- |
| no `gatewayUrl` (legacy) | — | — | nothing — no expander, no hint, no request |
| `gatewayUrl` | `analytics: false` | — | nothing, same as legacy |
| `gatewayUrl` | `analytics: true` | no | one muted line: **"Sign in to see analytics."** |
| `gatewayUrl` | `analytics: true` | yes | the expander, collapsed |

The signed-out case is a **hint, not an absence**: the operator turned analytics on,
the data exists, and a blank row would read as "this video has none". It is one line
of muted text in the row, it makes no network call, and it is not a `<details>` —
there is nothing to open. Signing in re-renders the library and the hints become
expanders; signing out turns them back — which means `record.ts`'s auth-change handler
gains a `renderLibrary()` call it does not have today, and that is the whole coupling
between the two.

The expander itself, matching what `index.html` already does with `<details>` /
`<summary>` for its two panels:

- `<details>` with a `<summary>` reading **"Analytics"**, collapsed by default. Nothing
  is fetched until one is opened, so a library of forty videos still costs the one
  `/config` request the recorder already makes.
- On **first open**: read the entry's stored `link` (§9's `LibraryEntry.link`) through
  `parseShareFragment` for `{ id, keyB64 }` → `importKeyB64` →
  `GET {gatewayUrl}/beacon/{id}` with the Google bearer (§15.4, the same token the
  uploader holds, from `src/auth.ts` in memory) → fetch each session's ciphertext
  **directly from its presigned url**, at most `SESSION_CONCURRENCY` (6) at a time →
  `decryptBlock(key, analyticsAad(id, sessionId), block)` → `parsePayload` (v1 and v2,
  §16.2) → render. Each kept session is a `WatchSession`: the payload plus the
  listing's `lastModified`.
- A session that fails to decrypt or to parse is **skipped and counted**, never hidden:
  the write endpoint is unauthenticated, so junk is possible, and so is a video
  re-uploaded under a new key.
- **Result caching** is per video id and lasts the page's lifetime: collapsing and
  re-expanding re-renders what was fetched, and re-rendering the library does not
  refetch. A small **"reload"** link inside the expander refetches and replaces the
  cached result — the one affordance for "someone watched it since I opened this". A
  load that *failed* is not cached: reopening retries it, because the usual cause is a
  token that has since been refreshed.
- **The key never leaves the page.** Only the 22-character id appears in a request
  path; the fragment is parsed in memory and never written to `location`, to `history`,
  or into a form. This is the same rule §16 opens with, and it is the reason the
  dashboard lives on the page that already holds the share links.

What it renders, all computed in the browser from decrypted payloads (`watch.ts`,
§16.5):

- **Header line** — total views (kept sessions, one per viewing instance) · unique
  viewers (`groupByViewer(...).length`) · completions (`completed === true`, i.e.
  coverage ≥ 90%, §16.2); then, **only when they are not zero/false**, "N sessions
  could not be read" and a note that the listing was `truncated` at
  `MAX_LISTED_SESSIONS`. Zero sessions is its own line — "No views yet." — not an
  empty heatmap.
- **Overall heatmap** — `HEAT_BUCKETS` (50) bars, one per 2% of the video, rendered as
  plain CSS bars: **no chart library, no canvas, no external asset, no inline SVG
  sprite**. Two channels, and they are different numbers on purpose:
  - **height** = `normalizeHeat(sumHeat(payloads))[b]`, so the tallest bucket is full
    height and the shape of attention within *this* video is legible whatever the
    absolute numbers are. An empty bucket keeps a hairline so 50 bars stay 50 bars.
  - **intensity** = `relativeHeat(payloads)[b]`, the ×-against-one-pass number. A
    bucket at or above `1.0` must read **visibly hotter** than one below it — that is
    the whole point of the heat data, and a rendering where 0.4 and 2.4 look the same
    fails this section. The threshold is a class or a custom property on the bar; the
    exact palette is `record.css`'s business.
  - **tooltip** = each bar's `title`, exactly `~N.Nx` — `relativeHeat[b].toFixed(1)`,
    e.g. `~2.4x`. Nothing else in the attribute.
- **One row per unique viewer**, in `groupByViewer` order (most recent activity first):
  the `browserId` truncated to its **first 8 characters** followed by an ellipsis; the
  play count as "N plays" ("1 play" in the singular); that viewer's own heatmap, summed
  over their sessions and rendered exactly like the overall one (its own
  `normalizeHeat`, its own `relativeHeat` over that viewer's payloads); their best
  session's coverage as a percentage, or "—" when no session of theirs has a known
  duration; and the last-watched date from `lastModified`, formatted with
  `toLocaleString()` like the rest of the library. No IP column, because no IP exists
  to put in one.

**Errors stay inside the expander.** A 401 (token expired), a 403, a 404, a 502, a
network failure, a listing that returns nothing readable, an entry whose `link` has no
parseable fragment — each renders as one quiet muted sentence where the content would
have gone, and the expander stays open so the reader can hit "reload". None of them
touches the page-level status area, none blocks a recording or an upload, and none is
thrown: this is a panel about a video, not the page's business. A 401 says so plainly
("Sign in again to load analytics.") rather than silently re-prompting, because the
sign-in control is a few centimetres up the same page.

`src/dashboard.ts` is the reader half, and it is its own module rather than more of
`record.ts` (1,300 lines before this) for the reason `gap.ts`, `watch.ts` and
`beacon.ts` are their own: fetch-decrypt-aggregate-render is a subject, and `record.ts`
is the recorder's state machine. It owns no page state beyond its cache and hands
`record.ts` DOM:

```ts
export interface AnalyticsDeps {
  gatewayUrl: string;
  /** The current Google ID token, or null. Read per request, never captured. */
  token: () => string | null;
}
export const SESSION_CONCURRENCY: number;      // 6
export const VIEWER_PREFIX: number;            // 8 characters, then an ellipsis
/** The collapsed <details> for one entry — analytics on, signed in. */
export function analyticsExpander(entry: LibraryEntry, deps: AnalyticsDeps): HTMLElement;
/** The one-line "Sign in to see analytics." row — analytics on, signed out. */
export function analyticsHint(): HTMLElement;
```

`record.ts` decides which of the two (or neither) a row gets, from the gateway config
and the auth state it already tracks. Styles go in `record.css` beside the library's;
`stats.css` is deleted, not moved.

### 16.7 Legacy mode

Zero behaviour change, and stated so it can be tested rather than hoped for: with no
`gatewayUrl`, `view.html` makes exactly the requests §8 already makes, writes no
localStorage key, mints no ids, loads no Google script, and contains no timer; and
`index.html`'s library renders plain rows — no expander, no hint, no bearer, no
listing call (§16.6). §9's settings and §10's "viewers are strangers" are otherwise
untouched.

### 16.8 Privacy guarantees

What an operator of the gateway and the analytics bucket **can** learn:

- that *some* browser watched video `{id}`, and roughly when — the object's
  `LastModified`, refreshed by each flush;
- how many sessions exist for an id, and the ciphertext size of each, from which a
  coarse guess at the *number* of watched ranges is possible and nothing more —
  `heat` is 50 numbers in every payload, so it moves that size by a few dozen bytes of
  digits and says nothing about which buckets hold them;
- the `sessionId`, since it is the object key — a random per-page-load label that
  links to no person, no browser, and no other video;
- whatever their transport layer logs on its own. A CDN's or load balancer's access
  log is outside this spec's reach; the gateway itself neither reads nor writes an IP
  for analytics, and this section forbids adding one.

What they **cannot** learn without the share link:

- which parts of the video were watched, how much of it, or whether it finished;
- `browserId` — it is inside the ciphertext, so two sessions from the same browser are
  not linkable server-side, even under the same video id;
- any viewer identity at all: no account, no cookie, no fingerprint, no IP;
- the key. It stays in the fragment, in the tab, and is used only to encrypt.

Said the other way round, which is the sentence the README owes a reader: **watch data
is readable by exactly the holders of the share link. Sharing the link shares the
analytics.**

### 16.9 Tests

- `tests/watch.test.ts` (vitest, Node) — §13's entry, and the only suite that has to
  hold the two sides of §16 to one answer:
  - Coverage, unchanged: range normalization (seconds→ms rounding, clamping to
    duration, overlapping/touching/out-of-order input, zero-length after rounding); a
    400-range `played` list capped to 200 with the smallest gaps closed first;
    `coverage`/`isCompleted` either side of 0.9 and at `durationMs = 0`;
    `parsePayload` rejecting missing fields, non-integer milliseconds, and unsorted or
    overlapping ranges.
  - Heat accumulation: a run of normal `advance` steps landing in the expected
    buckets; a forwards seek (delta > `MAX_PLAYBACK_DELTA_MS`) and a backwards seek
    (delta ≤ 0) both discarded **while the observation point still moves**, proven by
    the next in-range step counting from the new position; `reanchor` dropping the
    delta across a pause and across a scrub; the boundary cases — a position exactly on
    a bucket edge landing in the higher bucket, `currentMs === durationMs` landing in
    bucket 49 rather than 50, a position past the duration clamped to 49, a negative
    position clamped to 0; `durationMs` of `0`, `NaN` and `Infinity` accumulating
    nothing while leaving the state advanced; and immutability (the input state
    unchanged after both calls).
  - v1 compatibility: `heatFromRanges` overlap arithmetic including a range that
    covers a bucket exactly, one that straddles a boundary, one ending on `durationMs`,
    and `durationMs ≤ 0` → zeros; `sessionHeat` returning the array as sent for v2 and
    the derived one for v1; the derived array never exceeding one bucket-span (1×).
  - Aggregation: `sumHeat` across sessions of **differing** durations;
    `relativeHeat`'s formula asserted numerically, including that a bucket played once
    per session reads `1.0`, that a bucket played twice by half the sessions reads
    `1.0`, and that sessions with `durationMs ≤ 0` change neither side; `normalizeHeat`
    against the largest bucket and on an all-zero input; `groupByViewer` collapsing
    repeat sessions, ordering by `lastModified` descending with the `browserId`
    tiebreak, taking the **best** coverage rather than the last, reporting `null`
    coverage when no session has a duration, and refusing to collapse a malformed
    `browserId` with anything.
  - `parsePayload` version handling: `v: 1` accepted without `heat` and with a stray
    one; `v: 2` accepted with exactly 50 non-negative integers and rejected with 49, 51,
    a float, a negative, a string entry, or no `heat` at all; `v` of `0`, `3`, `"2"` or
    absent → null.
- `tests/beacon.test.ts` keeps its `viewerId` suite unchanged and moves its payload
  suite to v2: the encrypt → decrypt → `parsePayload` round trip on a `v: 2` body with
  a 50-entry `heat`; the same body unreadable under another session's AAD; and the
  body-cap assertion extended to the **pathological** case — `MAX_WATCH_RANGES` (200)
  ranges *and* 50 eight-digit heat buckets — still encrypting to under
  `MAX_BEACON_BYTES` (16384) with room to spare, so §16.2's size claim is a test and
  not a paragraph.
- `startWatchBeacon`'s event wiring stays outside the Node suites, as it is today:
  there is no media element in Node, and inventing one would test the stub. That is
  precisely why the heat reducer is pure — the arithmetic that a `pause`, a seek or a
  resume changes is `watch.ts`'s and is tested there, and what `beacon.ts` adds on top
  is which event name calls which function.
- `tests/crypto.test.ts` gains: `analyticsAad` round-trip, and a block that decrypts
  under `{id}:analytics:{sessionA}` failing under `{id}:analytics:{sessionB}` and
  under `{id}:meta`.
- The `attentionCurve` suite goes with the function (§16.5): its subject — how many
  sessions touched each slice — is answered better by the heat aggregates above, and a
  test for an export nothing imports is a test of nothing. There was never a
  `stats.ts` suite to delete; what the page did is now `watch.ts` arithmetic, testable
  without a DOM at all.
- `tests/gateway.test.ts` gains a `POST /beacon` suite (id validation → 400, oversized
  body → 413, analytics disabled → 404, wrong method → 405, unlisted origin → 403;
  happy path → 204 with exactly one PutObject at `{id}/{session}.bin` against a stub
  bucket, no `Authorization` required, and no per-request log line) and a
  `GET /beacon/{id}` suite (no token → 401, non-whitelisted → 403, presigned url shape
  and expiry, pagination cap → `truncated: true`, non-matching keys skipped); plus
  config tests that `analytics` follows `ANALYTICS_BUCKET` and that
  `ANALYTICS_BUCKET === BUCKET_NAME` fails at boot.
- `tests/e2e.gateway.test.ts` gains the full loop against MinIO: encrypt a payload with
  the video's key, POST it to the running Node adapter, read the object back with
  credentials and decrypt it byte-for-byte; a second flush overwriting the same key
  (last write wins, one object left in the prefix); `GET /beacon/{id}` with a real
  minted JWT, fetching each presigned url anonymously and decrypting; and a check that
  the analytics bucket is **not** anonymously readable.
- §15.6's rule stands: no test bypasses. The write endpoint is genuinely
  unauthenticated, so there is nothing to bypass; the read endpoint runs the same
  minted-JWT path as `/api/sign`.
- The beacon is the first **binary** body the gateway carries, and the Worker and Node
  adapters hand it through as bytes (covered above). The Lambda function-URL adapter
  cannot be: a function URL decides text-vs-base64 delivery from the request's
  `Content-Type`, and §16.3 fixes the beacon's at `text/plain;charset=UTF-8` because
  `sendBeacon` cannot set a header — a text label on ciphertext. A text-delivered body
  reaches the adapter as an already-decoded UTF-8 string, and no decode recovers bytes
  the runtime replaced. That behaviour is AWS's and cannot be exercised locally, so the
  same rule §15.6 applies to R2 applies here: the first Lambda deployment with
  `ANALYTICS_BUCKET` set MUST send **one real beacon and read it back decrypted**
  before rollout (documented, §16.10).

### 16.10 Docs & examples

- `docs/gateway-setup.md`: an `ANALYTICS_BUCKET` section — creating a **private**
  second bucket on R2/S3/MinIO (no public domain attached, no anonymous read policy),
  the fact that it needs no CORS for writes because the gateway writes it but does
  need `GET` CORS from the site origin for the dashboard's presigned session fetches,
  that leaving the variable unset is a supported configuration, and §16.9's
  one-real-beacon smoke test for Lambda deployments — written the same way §15.7's R2
  step is, with the failure it catches and what to do about it. That smoke test reads
  its result off the **library dashboard** (§16.6): record a video, watch a minute of
  it from its share link, then open the recorder, sign in, and expand Analytics on that
  entry. One view with a plausible heatmap means the beacon survived; "1 session could
  not be read" on a video whose key has not changed is the failure it exists to catch.
- `examples/docker-compose.yml`: the `mc` init job creates the analytics bucket
  (private, no anonymous policy) and sets its GET CORS; the `gateway` profile passes
  `ANALYTICS_BUCKET`.
- `README.md`: one honest paragraph in the security model — the server learns that and
  roughly when a video id was watched and how big each session object is; it never
  learns watch ranges, viewer identity, or an IP address, because none is read. Watch
  data is readable only by holders of the share link. Its description of *where you
  read the data* is the library expander, not a third page: no sentence in the README
  may promise a `stats.html` that the build no longer emits (§12), and what the
  dashboard shows is views, unique viewers, completions and the replay heatmap (§16.6).
