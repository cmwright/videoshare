# VideoShare — Format & Module Specification (v1)

This document is the **binding contract** for all code in this repo. Implementation
modules are written against these exact formats and signatures. Do not deviate;
if something here is impossible, flag it rather than silently changing the contract.

## 1. Product summary

Serverless, open-source Loom replacement. A static site (TypeScript + Vite, output
is plain `dist/`) with three pages — two owner-side, one for recipients:

- `index.html` — the **app shell** (§17): a left sidebar and three hash-routed
  views. `#/videos` is the library, `#/record` is the recorder (capture screen +
  mic in-browser, compress live, encrypt client-side, upload directly to any
  S3-compatible bucket with SigV4-signed PUTs via `aws4fetch`), `#/settings` holds
  recording options and — in legacy mode — the storage settings form.
- `video.html` — the **video page** (§17.4): owner-side, one video. Same fragment
  format as the share link, the player as its hero, and the full engagement
  reading (views, unique viewers, completion rate, average watch time, the replay
  heatmap and the per-viewer table) below it.
- `view.html` — the **player** recipients get: no credentials; reads video id +
  AES key from the URL fragment, fetches ciphertext from the bucket's public base
  URL, decrypts in the browser, plays. Progressive playback via MSE where
  supported, whole-file blob fallback otherwise.

`view.html` is the only page a recipient ever loads, and **its behaviour and its
visual design are fixed**: §17 changes owner-side surfaces only. The playback
machinery is shared with `video.html` (§17.5), which is a refactor with no
viewer-visible delta.

Threat model: the bucket may be publicly readable. Everything stored is AES-GCM
ciphertext; the key exists only in the share link's URL fragment (never sent over
the network). Upload auth = whoever holds S3 write credentials. Viewers need nothing.

What an operator of the bucket therefore learns about a video is its id, the size
and timing of its objects, and nothing else. §3's optional `thumb.bin` adds one
~15–50 KB ciphertext per video to that list: its existence and its size are
visible, its contents are not, and it is decrypted by the same key as the video —
so **a thumbnail is readable by exactly the holders of the share link**, and
sharing the link shares the thumbnail. Two facts a user should be able to predict
rather than discover: the image is a frame of whatever was on the shared screen
about a second into the recording (§6), and a video recorded before this existed
simply has no thumbnail, forever and correctly (§3).

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

Two required objects per video and one optional third, under the id as prefix:

| Object key         | Content                                    | Content-Type               |
|--------------------|--------------------------------------------|----------------------------|
| `{id}/meta.json`   | encrypted metadata (binary, despite name)  | `application/octet-stream` |
| `{id}/video.bin`   | concatenated encrypted chunks              | `application/octet-stream` |
| `{id}/thumb.bin`   | **optional** encrypted thumbnail: one §4 block whose plaintext is a JPEG | `application/octet-stream` |

`thumb.bin` is **one** §4 encrypted block — `IV ‖ ciphertext ‖ tag`, the same
primitives `meta.json` uses — with AAD `"{id}:thumb"`. Its plaintext is a JPEG
image, typically 15–50 KB, so the object is typically 15–50 KB + 28 bytes. It is
decrypted by the same key as everything else: **a thumbnail is readable by
exactly the holders of the share link**, like the video and the watch data.

All three keys are removed together when a video is deleted (§18), and the
optionality above survives that too: §18.1's delete names `thumb.bin` alongside
the other two and treats a 404 on any of them as success, so a video that never
had a thumbnail deletes exactly like one that did.

Three rules make it optional rather than a fourth format version:

- **Nothing in `meta.json` records whether it exists.** §5's JSON is unchanged,
  and no reader may be taught to expect a field there.
- **Every reader fetches and falls back.** A reader that wants a thumbnail GETs
  `{publicBaseUrl}/{id}/thumb.bin` and, on *any* failure — 404, 403, a network
  error, a block that will not decrypt, bytes that will not decode as an image —
  silently keeps the placeholder it already had. There is no error surface for a
  missing thumbnail, because a video without one is a working video: every
  recording made before this section, and every recording whose capture or upload
  did not work out, is in that state permanently and correctly.
- **A reader bounds its read.** `thumb.bin` is fetched with a
  `MAX_THUMB_BYTES` (2 MiB) ceiling — a declared `Content-Length` above it is
  refused without reading, and a body that exceeds it while streaming is
  abandoned. Nothing this app writes comes close; the cap is there so a reader
  never buffers an object it did not write, on the same bounded-read principle
  §16.3 applies to the beacon.

`view.html` does not fetch it (§17: the recipient page is untouched). Only the
two owner-side surfaces do — a library row (§17.3) and the video page's poster
(§17.4).

## 4. Encryption format

- Algorithm: AES-GCM, 256-bit key, 12-byte random IV per encryption, 16-byte tag.
- **Encrypted block layout** (used for meta, for the thumbnail, and for each
  video chunk): `IV (12 bytes) ‖ ciphertext ‖ GCM tag (16 bytes)` — i.e.
  WebCrypto's `encrypt()` output appended after the IV. Overhead = **28 bytes**
  per block.
- **AAD** (UTF-8 encoded string) binds each block to its role and position:
  - meta: `"{id}:meta"`
  - video chunk i (0-based): `"{id}:video:{i}"` (decimal, no padding)
  - thumbnail: `"{id}:thumb"` (§3) — one block, no index, so the AAD binds it to
    one video and to the thumbnail role. A `thumb.bin` copied under another id's
    prefix fails to decrypt rather than rendering as that video's picture, and a
    `meta.json` renamed to `thumb.bin` fails for the same reason.
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
  "createdAt": "2026-08-27T21:04:00.000Z",  // ISO 8601 UTC
  "progressive": false         // OPTIONAL. Absent means true. See below.
}
```

`progressive` is the one optional field, and it is written by exactly one
writer: §19's import of an MP4 that is not fragmented. It says the bytes cannot
be appended to an MSE `SourceBuffer` as they are, so §8's progressive path must
not be attempted — `MediaSource.isTypeSupported` would say yes to the type and
MSE would then fail on the bytes, after the point at which the player can still
fall back. A reader treats a missing field as `true`, which is what every
recording is, and must not write it for a recording; §8's whole-file path plays
a `progressive: false` video exactly as it plays a Safari one.

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
- **Thumbnail capture** (§3's `thumb.bin`), both engines, entirely off the
  recording's hot path:
  - **One frame, from the live display stream.** A hidden `<video>` element
    plays a `MediaStream` carrying the display **video track only** (`muted`,
    `playsInline`; never visible and never focusable), and one `drawImage` paints
    it to a canvas. It is read from the *stream*, never from the WebCodecs frame
    pipeline: the MediaRecorder fallback engine has no such pipeline, and one
    code path that works on both is worth more than a frame the primary engine
    could have handed over for free. The helper **never calls `track.stop()`** —
    the track it is reading is the recording's own.
  - **Timing**: a `setTimeout` armed from engine start fires at
    `THUMB_FIRST_TRY_MS` (~1 s). A capture that yields nothing — the element has
    no frame yet, `videoWidth`/`videoHeight` is 0, the painted frame is all black
    (§11's `isBlankFrame`), the canvas or `toBlob` throws — is retried **once**
    at `THUMB_RETRY_MS` (~2.5 s) from engine start, and then given up on. Two
    attempts, never a loop: a screen that is still black at 2.5 s is a screen,
    not a race.
  - **Scaling**: `thumbSize` (§11) — the **width** capped at `THUMB_MAX_WIDTH`
    (640), the height following from the frame's own aspect, both dimensions
    rounded to **even** numbers, and never upscaled. Encoded with
    `canvas.toBlob(cb, "image/jpeg", THUMB_JPEG_QUALITY)` (0.72). A 4K screen
    therefore stores 640×360-ish and typically 15–50 KB; a portrait or 4:3
    capture keeps its own shape and the row's 16:9 frame crops it (§17.3), which
    is why the aspect is preserved here rather than squashed to fit.
  - **Encrypted immediately** — `encryptBlock(key, thumbAad(id), jpeg)` — the
    moment the JPEG exists. The key has existed since the upload session was
    created, and encrypting now rather than at Finish means a still frame of the
    user's screen spends milliseconds in memory as plaintext rather than the
    length of the recording. The ciphertext is held in memory (~15–50 KB) until
    Finish and is dropped with the rest of the recording's state on discard.
  - **Uploaded at Finish and never before** (§7): a recording that is discarded
    writes no `thumb.bin`, so there is no orphan to clean up and no object under
    an id no link ever names.
  - **Every failure is silent.** No stage changes, no `#message`, no status line,
    nothing the user is asked to do about it — at most one `console.warn`. A
    recording without a thumbnail is a working recording, and the reader's own
    fallback (§3) is already the whole story.
  - **Lifecycle**: the retry is armed only if the first attempt returned nothing,
    so a recording that works costs exactly one attempt. Both timers are cleared
    by the same reset that drops the recording's other state, and an attempt that
    is already in flight when the recording stops, is discarded, or is superseded
    by the next one **discards its own result** — the ciphertext belongs to one
    recording, and there is no path by which one recording's frame can be
    uploaded under another's id. A recording that is stopped before the first
    timer fires simply has no thumbnail.
  - Cost, stated so it can be checked: one `drawImage` and one `toBlob` per
    attempt, at most twice per recording, both on a timer callback rather than on
    the `ondata` path. Capture must not be perceptible in the recording.
- Recorder page state machine: idle → picking → recording (live timer +
  streamed-upload progress, e.g. "12 MB uploaded") → preview (title input,
  replayable `<video>`, **Finish** button, Discard) → finishing (fast: final
  part + complete + thumb + meta) → done (share link shown + auto-copied, entry
  added to local library). Recording requires configured settings (the multipart
  upload is created at record start); if unconfigured, open the settings panel
  instead of starting capture.
  The machine, its guards and its element ids are **unchanged** by §17; they
  simply live inside the `#/record` view of the shell. Two rules bind the two
  together and nothing else does: routing never tears the machine down (a
  recording, its timer and its upload run on while the reader is in another
  view), and any transition into `preview`, `finishing` or `done` **forces the
  record view to be shown** — those stages are asking the reader for something,
  so they must not happen behind a hidden section. "Open the settings panel"
  above is §17.2's `demandSettings`.
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
     → PUT `thumb.bin` when the recorder produced one (§6) → PUT `meta.json`
     last (a video is "complete" iff meta exists).
  4. Discard → `AbortMultipartUpload` (DELETE `?uploadId=...`), best-effort. No
     `thumb.bin` was written, because nothing is written before step 3.
- API (`upload.ts`):
  ```ts
  export interface UploadResult { id: string; link: string; }
  export interface UploadSession {
    addChunk(plain: Uint8Array): Promise<void>; // encrypt + UploadPart, sequential
    /** `thumb` is §3's already-encrypted block, or null for no thumbnail. */
    finish(finalPlain: Uint8Array | null, meta: VideoMeta,
      thumb?: Uint8Array | null): Promise<UploadResult>;
    abort(): Promise<void>;
    readonly uploadedBytes: number;             // ciphertext bytes confirmed uploaded
  }
  export function createUploadSession(settings: Settings, id: string,
    key: CryptoKey, onProgress?: (uploadedBytes: number) => void): Promise<UploadSession>;
  ```
- **The thumbnail's place in `finish()`**, pinned because both halves matter:
  - **After `CompleteMultipartUpload`, before `meta.json`.** Meta stays the last
    write and therefore the sole completion marker: a reader that finds meta may
    or may not find a thumbnail (§3 says it must cope either way), but it never
    finds a thumbnail for a video that does not exist.
  - **It cannot fail the finish.** The PUT is attempted once, inside a
    `try`/`catch` that swallows everything and at most `console.warn`s. Whatever
    happens to it, `finish()` goes on to PUT meta and returns the share link: the
    video and the link are the thing the user asked for, and a decorative image
    must never be able to cost them either. It gets none of the part queue's
    retry ladder for the same reason.
  - **`upload.ts` never sees the plaintext.** `thumb` arrives already encrypted
    under `thumbAad(id)` (§6), is not re-encrypted, and is not inspected. A
    `finish()` retried after a failure re-sends it — an idempotent PUT of the
    same bytes to the same key.
  - `uploadedBytes` counts video parts only, as it does today: it is the
    recording's upload progress, and a 30 KB image arriving at the end is not
    progress the user is waiting on.
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
  CORS must allow POST (create/complete) and DELETE (abort — and, since §18,
  object deletion, which is the same method from the same origin and therefore
  needs no new rule) in addition to
  PUT/GET/HEAD and must expose the `ETag` response header; the uploader policy
  needs `s3:AbortMultipartUpload` alongside `s3:PutObject` — plus the
  **optional** `s3:DeleteObject` if that deployment wants §18's Delete video to
  work; docs recommend
  cleaning up incomplete multipart uploads after ~1 day so crashed sessions
  don't strand storage (AWS/R2: an `AbortIncompleteMultipartUpload` lifecycle
  rule; MinIO: the server-wide `api stale_uploads_expiry` setting — `mc ilm`
  cannot express an abort-only rule).
  §3's `thumb.bin` adds **nothing** to this list: it is a PUT by the uploader and
  an anonymous GET by a reader, both of which every existing example config
  already allows. No new CORS rule, no new IAM action, no new lifecycle rule —
  and `examples/` therefore does not change for it.

## 8. Playback

Everything in this section is implemented once, in `playback.ts` (§17.5), and used
by both `view.html` and `video.html`. This section describes what a **viewer** on
`view.html` gets, and that is the fixed one: the extraction is a refactor with no
viewer-visible delta — same requests in the same order, same status and error
strings, same event wiring, same `player.css`. `video.html` differs only in its
chrome and in not autoplaying (§17.4); it makes the same requests otherwise.

- Parse fragment → `{ id, key }`; malformed fragment → friendly error.
- GET `{publicBaseUrl}/{id}/meta.json` (publicBaseUrl configurable per
  deployment — see §10; **no credentials**), decrypt, show title/duration.
- Progressive path (when `meta.progressive !== false` — §5 — and
  `MediaSource.isTypeSupported(meta.mimeType)`):
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

## 9. Settings & local library (localStorage, owner-side pages only)

This section owns the **storage keys and their shapes**. Where those values are
rendered — which view a form lives in, what a library row looks like — is §17's,
and where the two could be read as disagreeing, §17 wins.

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
  link, sizeBytes? }` — newest first. `link` is the **full share link** including
  its `#{id}.{key}` fragment, and it is the only place this browser keeps a video's
  key; §17.3 builds the video page's URL out of it and never stores a second copy.
  `removeFromLibrary(id)` removes the local entry only — it does not delete from
  the bucket, which is why §17.3's menu calls it **Remove from list**. Deleting
  the objects is §18, a separate action under a separate name, and it removes the
  entry through this same function once the bucket has confirmed the objects are
  gone. When `sizeBytes` is present the UI also shows size and effective bitrate
  (e.g. "14.2 MB · 1.9 Mbps") so compression is observable. Entries without
  `sizeBytes` (older) must render fine. The row itself is §17.3.
  **No thumbnail field, and no thumbnail bytes in localStorage.** §3's `thumb.bin`
  is fetched from the bucket and cached only as an object URL for the document's
  lifetime (§17.3); recording whether one exists would be a second source of
  truth that goes stale the moment an object is deleted, and the fetch-and-fall-back
  rule exists precisely so nothing has to know in advance.

## 10. Viewer configuration of publicBaseUrl

`view.html` has no localStorage settings (viewers are strangers). The public
base URL is baked at deploy time via a tiny config: `dist/config.js`
(`window.VIDEOSHARE = { publicBaseUrl: "..." }`), loaded by all three pages
(`video.html` reads it exactly as `view.html` does) with a sensible error if
missing. The repo ships `public/config.js` with a placeholder
and the docs tell deployers to edit one line. The recorder's settings panel
uses its own localStorage value for uploads but generates share links pointing
at the deployed site + this config's publicBaseUrl.

## 11. Module APIs (src/, TypeScript strict)

`types.ts`
```ts
export interface VideoMeta { v: 1; title: string; mimeType: string; durationMs: number;
  totalBytes: number; chunkSize: number; chunkCount: number; createdAt: string;
  progressive?: boolean; }                                // §5: absent means true; §19 writes false
export interface Settings { endpoint: string; region: string; bucket: string;
  accessKeyId: string; secretAccessKey: string; publicBaseUrl: string;
  quality: Quality; codec: CodecChoice; videoBitsPerSecond: number; }
export interface RecordingPrefs { quality: Quality; codec: CodecChoice;
  videoBitsPerSecond: number; }                           // §15.5, gateway mode
export interface LibraryEntry { id: string; title: string; createdAt: string;
  durationMs: number; link: string; sizeBytes?: number; }   // §9; absent on older entries
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
export function shareLink(id: string, keyB64: string): string;   // §2 link at "view.html"
export function videoPageLink(id: string, keyB64: string): string;  // "video.html#{id}.{key}" (§17.3)
export function codecLabel(mimeType: string): string | null;     // "H.264" / "VP9" / "AV1" / "VP8"; null names none
```

The last three are §2's format and its labels, in the one module that already owns
them. `shareLink` moves out of `upload.ts` unchanged (same `new URL("view.html",
location.href)` resolution, so a link built on `video.html` is byte-identical to the
one the recorder stored); `videoPageLink` is its sibling and resolves the same way,
which is what keeps both correct under a subpath deploy. `codecLabel` moves out of
`record.ts` (its `recordedCodec` + `CODEC_NAMES` pair, one function now): §17.4's
meta line needs it, and it must not reach for `encoder.ts` to get it — that would
pull `mp4-muxer` and `webm-muxer` into the video page's bundle for a string.

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
export function thumbAad(id: string): string;             // `${id}:thumb` (§3)
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
`UploadSession`, `UploadResult`) and §18.3 for the deletion half
(`VideoObjectName`, `DELETE_ORDER`, `deleteVideo`), which lives here because the
`Signer` seam and its `send()` do.

`thumbnail.ts` — §3's thumbnail, both ends of it, split on testability the way
`gap.ts` and `watch.ts` are: the arithmetic and the frame test are pure and are
tested in Node; the two functions that need a canvas or a network are not.

```ts
export const THUMB_MAX_WIDTH: number;       // 640 — cap on the stored width
export const THUMB_JPEG_QUALITY: number;    // 0.72
export const THUMB_FIRST_TRY_MS: number;    // 1_000 — from engine start (§6)
export const THUMB_RETRY_MS: number;        // 2_500 — from engine start; the only retry
export const THUMB_BLANK_LEVEL: number;     // 8 — a channel at or below this counts as black
export const MAX_THUMB_BYTES: number;       // 2 * 1024 * 1024 — reader's ceiling (§3)
export const LIBRARY_THUMB_CONCURRENCY: number;  // 4 — library rows fetching at once (§17.3)

/** Structural stand-in for ImageData, so the pure half needs no canvas. */
export interface FrameData { width: number; height: number;
  data: Uint8ClampedArray | ArrayLike<number>; }   // RGBA, row-major

/** The even-sided box a frame is drawn into, or null when it has no usable size. */
export function thumbSize(width: number, height: number, maxWidth?: number):
  { width: number; height: number } | null;
/** True when every pixel is at or below THUMB_BLANK_LEVEL in R, G and B. */
export function isBlankFrame(frame: FrameData): boolean;

/** One attempt: paint a frame of `stream`, scale, JPEG-encode. Null on any failure. */
export function captureThumbnail(stream: MediaStream): Promise<Uint8Array | null>;
/** GET + decrypt `{id}/thumb.bin`. Null when there is none, or none that reads (§3). */
export function fetchThumbnail(publicBaseUrl: string, id: string, key: CryptoKey):
  Promise<Blob | null>;   // type "image/jpeg"
```

- `thumbSize` never upscales (a frame narrower than `THUMB_MAX_WIDTH` keeps its
  own width), preserves aspect, rounds **both** sides down to even numbers, and
  returns `null` rather than a `0`- or `NaN`-sided box — which is exactly the
  "zero-sized" give-up condition §6 names.
- `isBlankFrame` reads R, G and B and ignores alpha: a canvas that was never
  painted reads as transparent black, and so does a screen that has not started
  delivering, and §6 treats the two the same because it cannot tell them apart
  and does not need to.
- `captureThumbnail` owns the hidden element and the canvas, and tears both down
  before it resolves — including on the failure paths — without ever stopping a
  track (§6). It swallows every error and returns `null`; the schedule (first
  try, one retry, give up) is `record.ts`'s, because the recording's lifecycle
  and its cancellation live there.
- `fetchThumbnail` is the whole of §3's fetch-and-fallback rule in one place, so
  no page re-implements it: bounded read at `MAX_THUMB_BYTES`, `decryptBlock`
  under `thumbAad(id)`, and `null` — never a throw — for a 404, a 403, a network
  failure, an oversized body or a block that will not decrypt. It does not
  sniff the plaintext: anything that decrypts was written by a holder of the
  key, and an image that will not decode is caught by the element's own `error`
  event (§17.3, §17.4).
- The module holds **no module-level state** and touches no DOM at import time,
  so `video.html`'s bundle tree-shakes the capture half away and keeps only
  `fetchThumbnail`. The object-URL cache is a page's business, not this
  module's (§17.3).

`record.ts` — page controller for `index.html`: wires the shell (§17.2), owns the
state machine in §6 (including the internal Blob→8 MiB-chunk assembler that feeds
`UploadSession.addChunk`) and renders the library (§17.3). It additionally
**retains the recording's `CryptoKey` for the life of the session** — today the
key is generated inline into `createUploadSession` and kept nowhere, and §6's
thumbnail has to encrypt with it seconds after the recording starts. It is a
module variable beside `videoId`, cleared by the same reset (§6's discard path),
and `UploadSession` grows no key accessor: widening that seam would put the key
somewhere new for no gain. `player.ts` — page
controller for `view.html`. `video.ts` — page controller for `video.html` (§17.4).
Neither `player.ts` nor `video.ts` owns §8's machinery: that is `playback.ts`, the
shared player core both of them drive (§17.5).

`shell.ts` — the sidebar and the hash router (§17.1/§17.2), shared by `index.html`
and `video.html`. Its route arithmetic is pure and is the one new thing here Node can
test.

`watch.ts` / `beacon.ts` / `dashboard.ts` — playback analytics (§16), split the way
§8's arithmetic is: `watch.ts` is pure watch-range, heat and aggregation math (no DOM,
so Node tests and both halves of §16 import it — including the engagement figures of
§17.6, which are arithmetic and therefore live here), `beacon.ts` is the browser-side
tracker and flush on `view.html`, and `dashboard.ts` is the owner-side client of the
analytics endpoints: fetch, decrypt, aggregate and render one video's engagement,
used by `video.ts` for the full section and by `record.ts` for a library row's
two-number summary (§16.6, §17.6) — and, since §18, the one authenticated
`DELETE /sessions/{id}` loop, which belongs here because this module already
holds `AnalyticsDeps` and owns the per-id report cache a deletion invalidates.
Full signatures in §16.5/§16.6 and §18.4.

Styles: shared design tokens and base styles in `src/app.css`; the owner-side shell
and the primitives both owner pages draw with — sidebar, account chip, responsive top
bar, stat cards, heat bars, viewer table — in `src/shell.css`; the recorder's stages,
forms and library rows in `src/record.css`; the video page's own layout in
`src/video.css`; the share page's in `src/player.css`. `player.css` is **unchanged**
by §17, and nothing `view.html` loads may change with it. The heat-bar styles move
from `record.css` to `shell.css` because two pages now draw them; their tokens
(`--heat-cool` / `--heat-hot`) move with them.

## 12. Build & tooling

- `package.json`: deps `aws4fetch`, `webm-muxer`, `mp4-muxer`; devDeps `typescript`,
  `vite`, `vitest`. Scripts: `dev` (vite), `build` (`tsc --noEmit && vite build`),
  `preview`, `test` (`vitest run`), `test:e2e` (`vitest run --config vitest.e2e.config.ts`,
  only meaningful with MinIO up).
- Vite multi-page: rollup inputs `index.html` + `view.html` + `video.html` — §1's
  three pages, and the only three. A clean `npm run build` **must** emit all three
  HTML files into `dist/`; a deploy missing `video.html` breaks every library row's
  link. There is still no `stats.html`: `dist/` is not committed, so a `stats.html`
  or a `stats` chunk in it is a stale local build and `npm run build` on a clean tree
  must produce neither. `public/config.js` copied verbatim to `dist/`.
- TypeScript `strict: true`. No frameworks, no other runtime deps.
- §3's thumbnail adds **no** dependency, no external asset and no rollup input:
  `src/thumbnail.ts` (§11) is one more module in the same graph, JPEG encoding is
  `canvas.toBlob`, and the fallback that stands in for a missing thumbnail is the
  CSS pattern that is already there (§17.3).
- §18's deletion adds no dependency and no module in either package: a `DELETE` is
  a method the signer seam and `aws4fetch` already have, and the analytics store's
  bounded delete is the listing it already does with a second verb.

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
  versions; and §17.6's engagement figures — `completionRate`, `averageWatchedMs`
  and `peakBucket`. §16.9 has the detail, plus what §16 adds to
  `tests/beacon.test.ts`, `tests/crypto.test.ts`, `tests/gateway.test.ts` and
  `tests/e2e.gateway.test.ts`.
- `tests/import.test.ts` (vitest, Node) — §19's sniffer over hand-built
  containers: a WebM with each track kind, one whose Segment declares no size,
  AV1 spelled from `av1C` (and without one), a Matroska DocType, an unknown codec
  id, a track table that straddles the head window (read exactly once more, at
  its own size) and one too large to buffer; an MP4 that is faststart (not
  progressive), one with `mvex` (progressive), one whose `moov` sits after an
  `mdat` larger than the head window (reached by seeking, with the reads pinned),
  H.264/HEVC/AV1/VP9 sample entries, `esds` audio object types across all three
  sample-entry versions, a bare `mp4a`, a hint track, an audio-only file, and a
  file with no `moov`; `planImport`'s chunk arithmetic and its `progressive`
  rule; `runImport` against a fake session — full chunks then the tail, an exact
  multiple, a file smaller than one chunk, and a retry that resumes at
  `nextChunk` without re-sending a part; the thumbnail offsets; and the view's
  pure bits (`titleFromFilename`, `progressiveNote`). The browser half — the
  hidden element, the canvas, the drop zone — is not run in Node.
- `tests/shell.test.ts` (vitest, Node) — `parseRoute` and `routeHash` (§17.2), the
  only new pure logic §17 introduces: each of the four hashes; a trailing slash;
  `""`, `"#"`, `"#/"`, an unknown route and a nonsense one all resolving to
  `"videos"`; round-tripping `routeHash` through `parseRoute`; and that no input
  throws. The router's DOM half — `hashchange`, `hidden`, `aria-current`, focus —
  is not tested in Node, for the reason `record.ts` and `player.ts` are not:
  §17.2 exists to make sure the part worth testing is separable from the part
  that needs a browser.
- `tests/util.test.ts` (vitest, Node) — `codecLabel` over the strings the engines
  actually emit (`avc1`/`avc3`, `vp09`, `av01`, `vp08`, MediaRecorder's shorter
  `vp9`/`vp8`, a bare `video/webm` → `null`), and `shareLink` / `videoPageLink`
  producing §2's fragment with no `location` to resolve against. These moved out of
  `record.ts` and `upload.ts` in §11; the point of the move is that they are now
  testable, so they are tested.
- §17 retires the analytics expander (§16.6). **No existing test pins it**: the
  suites are Node-only and none of them imports `dashboard.ts` or asserts on its
  DOM, so the whole existing suite must keep passing unchanged — the work adds
  cases, it deletes none. (What §17 does delete is `analyticsExpander` and
  `analyticsHint`, which nothing tested.)
- `tests/crypto.test.ts` (vitest, Node WebCrypto): key export/import round-trip;
  block round-trip; tampered byte → throws; wrong AAD (reordered chunk index) →
  throws; chunked encrypt/decrypt round-trip across ≥3 chunks incl. short
  final chunk; offset math matches actual encrypted sizes; base64url round-trip
  incl. bytes ≥ 0x80. Plus §3's thumbnail binding, which is the whole reason its
  AAD names a role and an id: `thumbAad` round-trip; a block sealed under
  `{idA}:thumb` failing to decrypt under `{idB}:thumb` (**a thumb.bin copied to
  another video's prefix is not that video's picture**) and under `{idA}:meta`;
  and a `meta.json` block failing under `{idA}:thumb`.
- `tests/thumbnail.test.ts` (vitest, Node) — the pure half of `thumbnail.ts`
  (§11), which is where §6's give-up conditions actually live:
  - `thumbSize`: a 4K 16:9 frame scaled to 640 wide with the height rounded to an
    even number; a frame narrower than `THUMB_MAX_WIDTH` left at its own size
    (never upscaled); a non-16:9 aspect (portrait, 4:3, an extreme panorama)
    preserved; both sides even in every case; and `null` for `0`, negative,
    `NaN` and `Infinity` in either dimension — the "zero-sized" give-up.
  - `isBlankFrame`: an all-zero RGBA buffer → true; an all-zero buffer with full
    alpha → true (a never-painted canvas and a black screen are the same answer);
    every channel exactly at `THUMB_BLANK_LEVEL` → true and one pixel one step
    above it → false, so the threshold is pinned rather than implied; a single
    bright pixel in an otherwise black frame → false; and a frame that is bright
    in green alone → false, so the test is not accidentally reading luminance.
  `captureThumbnail` is **not** tested in Node, for the reason §13 already gives
  for the encoder: there is no canvas, no `MediaStream` and no `<video>`, and a
  stub of all three would test the stub. What it does that is worth testing —
  the size arithmetic and the blank test — is pure and is above; what is left is
  which DOM call happens in which order, and §6's rule that no failure of it
  reaches the user.
- `tests/gateway.test.ts` gains a **`put-thumb` suite**, written in the existing
  style and mirroring the `put-meta` one case for case: no token → 401; a valid
  token that is not whitelisted → 403; an `id` that is not 22 base64url
  characters → 400 (and each of the ways it can fail: absent, wrong length, a
  `/`, a `.`); the happy path returning `{ url, method: "PUT" }` whose presigned
  URL has the `X-Amz-*` shape and `X-Amz-Expires` every other op has and whose
  path is exactly `/{bucket}/{id}/thumb.bin` — **not** `video.bin` and **not**
  `meta.json`; and the key-construction check the suite already makes for
  `put-meta`, that an `objectKey` (or any other stray field) in the body changes
  nothing about the key that comes back.
- `tests/e2e.gateway.test.ts` gains a **thumbnail round trip** in the full-loop
  test, which the harness supports honestly because none of it needs a browser:
  encrypt a small JPEG-shaped payload under the video's key with
  `thumbAad(id)`, ask the running Node adapter for a `put-thumb` URL, PUT the
  block straight to MinIO through it, then GET `{id}/thumb.bin` **anonymously**
  and decrypt it byte-for-byte — the same browser↔bucket path a reader takes
  (§3), and one more object the gateway signed for and never carried. The
  *capture* half is out of scope for e2e for the same reason it is out of scope
  for the unit tests: Node has no canvas, and a test that fabricates the JPEG
  proves nothing about the frame.
- `tests/util.test.ts` and the rest of the suite are unchanged by §3's
  thumbnail: it adds cases and deletes none, and the whole existing suite must
  keep passing untouched.
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
- §18's deletion adds cases to `tests/gateway.test.ts`, `tests/util.test.ts`,
  `tests/e2e.gateway.test.ts` and `tests/e2e.minio.test.ts`, and deletes none:
  the whole existing suite must keep passing unchanged. §18.6 has the list. The
  one existing expectation §18 *moves* is the uploader-policy claim — the MinIO
  init job now grants `s3:DeleteObject` too (§14), so a test that asserted the
  uploader cannot delete would be asserting the old policy and must be updated
  to assert the new one rather than deleted.

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
  `Accept-Ranges`) — unchanged by §18, whose deletes are DELETEs from the same
  origin the aborts already are; `examples/s3-bucket-policy.json` (public
  GetObject, no ListBucket); `examples/iam-uploader-policy.json`, which since §18
  holds **two** statements: `VideoShareUploadOnly` (`s3:PutObject` +
  `s3:AbortMultipartUpload`) and `VideoShareOptionalDelete` (`s3:DeleteObject`).
  The second is optional and the `Sid` is where that is said, because an IAM
  policy document is strict JSON that neither `aws iam put-user-policy` nor
  `mc admin policy create` will parse a comment out of — a deployment that does
  not want deletion drops that one statement, and §18.3's per-row error names
  exactly this. The prose lives in `docs/storage-setup.md`, where prose is
  possible.
- `docs/storage-setup.md`: walkthroughs for Cloudflare R2 (recommended default:
  scoped API tokens, free egress), AWS S3 (IAM user), MinIO self-hosted incl.
  the VPN + anonymous-write zero-credential variant.
- `README.md`: what/why, 5-minute quickstart (local compose, then real bucket),
  security model (fragment key, write-only creds, what it does NOT protect
  against), browser support matrix, future work (camera bubble, streaming
  upload-while-recording, multipart). Its description of the product is §1's
  **three** pages — the app shell and its three views, the video page, and the
  player recipients get (§17.9). Where it describes what a recording puts in the
  bucket, **one factual sentence** covers §3's thumbnail: a third, optional
  object per video, one encrypted frame of the recording (~15–50 KB), decrypted
  by the same link key, and absent on anything recorded before it existed. Plain
  facts in the register the file was just rewritten to — not a feature
  announcement, no marketing voice, and no promise of a thumbnail on
  `view.html`, which does not have one (§3).

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
  - `{ op: "put-thumb", id }` → presigned PUT for `{id}/thumb.bin` (§3) →
    `{ url, method: "PUT" }`
  - `{ op: "delete", id }` (§18.3) → presigned DELETEs for **all three** keys →
    `{ urls: [{ key, url }], method: "DELETE" }`, where `key` is one of
    `"meta.json"`, `"thumb.bin"`, `"video.bin"` — the suffix, not the full object
    key, because the full key is the gateway's to build and the client's only use
    for the name is to tell the three URLs apart. All three are returned in one
    answer, in §18.1's deletion order; a client that only wanted one still gets
    three, which costs three signatures and no request.
  Validation (400 on failure): `id` must match `^[A-Za-z0-9_-]{22}$`; object
  keys are constructed server-side as exactly `{id}/video.bin` /
  `{id}/meta.json` / `{id}/thumb.bin` — the client can never influence any other
  key, and `delete` in particular takes **no** key, suffix or object name from the
  body; `uploadId` and `partNumbers` are syntax-checked and passed through as
  query params (URL-encoded). Auth failures: 401 (bad/expired token), 403 (valid
  token, email not allowed).

  **`delete` is presign-or-bust**, and that is the whole of its relationship to
  §15's invariant: the gateway signs three URLs and the browser sends the three
  DELETEs. There is no route on which this service deletes a video-bucket object
  itself, and none may be added — the analytics bucket's deletes (§18.4) are
  server-side because that bucket is already the gateway's to list, and the video
  bucket never is. R2, S3 and GCS all accept a SigV4 query-signed DELETE, so this
  is the same signing path every other op takes with a different method.

  **Anyone on `ALLOWED_EMAILS` can delete any video id they know.** This is the
  uploader whitelist doing what it already does for the session listing (§16.3):
  it is not per-video ownership and is not built to be. §18.2 says it once more,
  and the README says it in the same plain register.

  **`put-thumb` mirrors `put-meta` exactly** and adds nothing else: same auth,
  same id validation, same 400s, same `{ url, method: "PUT" }` shape, same
  `X-Amz-Expires`, one more `thumbKey(id)` beside `metaKey(id)` in `presign.ts`
  and one more arm in `parseSignRequest` and in the presigner's switch. In
  particular it is **not** a new route and **not** a new body shape: it is a
  sixth `op` on `POST /api/sign`. §15's no-proxy invariant is untouched — the
  gateway signs a URL and the ~15–50 KB of ciphertext goes browser↔bucket, like
  every other object. This is the **only** change §3's thumbnail makes to the
  `gateway/` package: `core.ts` routes on paths, not ops, and `worker.ts`,
  `lambda.ts` and `node.ts` are thin transport translations that enumerate no op,
  so all four files are untouched.

### 15.4 Authentication (stateless)

Verify the bearer as a Google ID token using `jose` against the JWKS at
`OIDC_JWKS_URL` (cached per its HTTP cache headers): RS256 only (reject any
other `alg`), `iss` must equal `OIDC_ISSUER` (default: accepts both
`accounts.google.com` and `https://accounts.google.com`), `aud` must equal
`GOOGLE_CLIENT_ID`, `exp`/`nbf` enforced, `email_verified` must be `true`,
then `email` checked against `ALLOWED_EMAILS`. No sessions, no cookies, no
refresh logic server-side. The verified email MAY be logged for audit; the
token itself must never be logged.

### 15.5 Client behavior (owner-side pages)

- `public/config.js` gains optional `gatewayUrl` (absolute, or relative like
  `"/api"` for same-origin deployments). Present → **gateway mode**: the
  **storage** settings form is not rendered (credentials never live in this
  browser); client fetches `{gatewayUrl}/config`; recording requires Google
  sign-in (Google Identity Services script). The ID token is cached in
  `sessionStorage` under `videoshare.auth` for at most its own lifetime — never
  localStorage, never a cookie — so it survives same-tab navigation between the
  owner pages and a reload, and dies with the tab. On page load the cache is
  adopted when the token is still fresh (per the §15.4 expiry margin); when the
  tab has signed in before but the cached token is stale, one silent
  auto-select refresh runs so a live Google session re-signs in without a
  click. A visitor who never signed in is never prompted. Sign-out clears the
  cache and disables auto-select. Absent → **legacy mode**, §9 unchanged.
- What gateway mode does keep is the encoder half of §9, as a **Recording
  options** block of its own: `quality`, `codec` and `videoBitsPerSecond` with
  the same values, defaults and normalization, persisted at
  `videoshare.recording` (a key newer than `preferAv1`, so nothing to migrate).
  It appears once `/config` answers, before and independently of sign-in — which
  codec this machine can encode is the operator's business, not the gateway's —
  and saves on change, with no Save button. A browser that refuses localStorage
  keeps the choice in memory for the session and says so; it never blocks a
  recording. Legacy mode leaves these three fields where they are, **inside the
  storage settings form**, read from and written to `videoshare.settings`, and
  still never so much as reads `videoshare.recording` (§9).
- §17 moves all of this into the `#/settings` view and takes the `<details>` off
  it: gateway mode's settings view is **Recording options** plus the **Account**
  block (§17.1's auth text), legacy mode's is the **Storage settings** form whose
  second fieldset is its own Recording options. Which storage key each mode reads
  is unchanged by that move — the two modes still never touch each other's key —
  and `demandSettings` (§17.2) routes to this view instead of opening a panel.
- `upload.ts` grows a `Signer` seam: `LocalSigner` (aws4fetch with settings
  creds — legacy mode, current behavior) and `GatewaySigner` (calls
  `/api/sign`; batches part URLs ahead of need, e.g. 8 at a time, so signing
  never stalls the upload queue). `UploadSession` logic is otherwise
  unchanged; presigned URLs are used exactly like signed requests today.
  The seam carries **seven** ops, not five: `SignOp` gains
  `{ kind: "put-thumb"; id }`, the method table maps it to `PUT`, and
  `LocalSigner`'s path-style URL builder maps it to `{endpoint}/{bucket}/{id}/thumb.bin`
  — the direct SigV4 PUT `meta.json` already gets, against a different key.
  `GatewaySigner` needs no new code at all beyond the union member: a `put-thumb`
  is a one-URL op and takes the same unbatched `askForUrl` path `put-meta`,
  `create`, `complete` and `abort` take. As with every other op, the key is the
  signer's to derive from `id` and never crosses the seam. The seventh is §18.3's
  `{ kind: "delete"; id; object }`, which is the one op whose gateway answer
  carries several URLs for one request — the same shape `part` has, and it is
  cached the same way.
- On a 401 mid-session, the client re-acquires an ID token silently (GIS
  `prompt()` with auto-select) and retries once; if that fails, the part
  queue's existing retry/degraded path applies and the UI shows a re-sign-in
  prompt without stopping the recording.
- The player and viewing flow are untouched (public reads, no gateway) — with the
  single exception of §16. In gateway mode `view.html` reads `{gatewayUrl}/config`
  once per page load, to learn whether analytics is on (§16.4), and sends §16.3's
  beacon only when it is; those two are the only requests it ever makes to the
  gateway. In legacy mode it makes neither (§16.7). `video.html` (§17.4) reads the
  same `/config` in gateway mode and lists sessions when signed in, but **never
  sends a beacon**: it is an owner-side page (§16.5).

### 15.6 Tests

No insecure test bypasses in the gateway (no magic bearer tokens): e2e and
unit tests generate an RS256 keypair, serve a local JWKS, set
`OIDC_JWKS_URL`/`OIDC_ISSUER`, and mint real JWTs — the production verification
path runs verbatim. Unit tests (Node): token verification (wrong alg/iss/aud/
exp/unverified email → 401; non-whitelisted → 403; suffix matching), key-shape
enforcement (op/id/partNumbers validation), presigned URL shape (X-Amz-*
params, expiry), CORS allowlist. E2E (vitest, `E2E=1`): start the Node adapter
in-process against local MinIO and drive the full client path — GatewaySigner
multipart upload (≥3 parts), complete, thumb PUT, meta PUT, then anonymous
ranged download/decrypt byte-compare; plus abort; plus a rejected
non-whitelisted token. R2's presigned UploadPart support is community-confirmed only, so the
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
  afterwards, so the reader (§16.6) can collapse repeat viewings by one
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
  union: a section watched twice holds roughly twice its own length, a section watched
  once holds roughly its own length whatever the browser's sampling cadence, and
  scrubbing across the video adds nothing. This is the "time spent" number `watched` refuses to
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

`POST {gatewayUrl}/sessions/{videoId}/{sessionId}` — **unauthenticated**. Viewers have
no identity and must never be asked for one. (`/beacon/…` is the same route
under its original name, accepted for already-deployed clients but never used
by new ones: "beacon" appears in ad-block filter lists as a tracker pattern,
and on a gateway that is cross-site from the pages — a Lambda URL, workers.dev
— those lists kill the request before any HTTP happens. Clients say
`/sessions`; the gateway answers both.)

- Sent with `navigator.sendBeacon(url, blob)`, body = the ciphertext as
  **unpadded base64url text**, and the URL carries `?enc=b64` to say so. The
  body must be `text/plain` (the one content type `sendBeacon` sends without a
  preflight that would strand the `pagehide` flush), and a text-typed body may
  be decoded to a UTF-8 *string* by the transport — AWS API Gateway and Lambda
  function URLs do exactly that — which corrupts raw ciphertext irreparably.
  Base64url is valid UTF-8, so the string round-trip is lossless on every
  transport. The gateway rejects an `enc=b64` body that is not strict
  base64url with 400; without `enc` it stores the body as raw bytes, the
  original wire form, kept only for pages deployed before this paragraph. All
  size bounds below apply to the **decoded** bytes; the encoded read itself is
  bounded at ⌈`MAX_BEACON_BYTES`/3⌉·4+4.
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

`GET {gatewayUrl}/sessions/{videoId}` (alias `/beacon/{videoId}`, as above) —
**authenticated exactly like `POST /api/sign`**
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
  `truncated: true` rather than silently trimming, and the video page says so beside
  the numbers it affects (§17.6).
- Keys that do not match `{videoId}/{22 base64url}.bin` are skipped: nothing else
  belongs in that prefix, and if something is there it is not a session.
- Malformed `videoId` → **400**; analytics disabled → **404**; any method but
  GET/OPTIONS → **405**; a bucket that rejects the listing → **502**.
- The whitelist here is the *uploader* whitelist: anyone who may upload through this
  gateway may list sessions for any video id they know. Ids are 128-bit random and
  only reachable through a share link, but this is a real property and the README
  says so rather than implying per-video ownership that does not exist.

`DELETE {gatewayUrl}/sessions/{videoId}` (alias `/beacon/{videoId}`, as above) —
**authenticated exactly like the GET above**, and the one place this service
deletes a stored object itself. It is the deletion half of §18, specified in
§18.4; in this section's terms it is the same route, the same auth, the same
`ID_PATTERN` validation and the same 404-when-analytics-is-off as the listing,
answering `{ deleted: number, truncated: boolean }` after a bounded pass. It
reads nothing back: §15's no-proxy invariant is about bytes flowing *out*, and
a delete moves none. `DELETE /sessions/{videoId}/{sessionId}` is **405** — there
is no single-session delete, because there is no surface that would ask for one.

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
  `GET` CORS from the site origin, because the owner-side pages fetch presigned
  URLs from it directly (§16.6, §16.10). Its CORS stays **GET/HEAD only** after
  §18: no browser ever deletes from this bucket, so adding DELETE there would
  widen it for nothing.
- The gateway's bucket credentials need `s3:DeleteObject` on the **analytics**
  bucket once §18 exists, alongside the `PutObject`/`GetObject`/`ListBucket` this
  section already needs. Without it every `DELETE /sessions/{id}` is a 502 —
  which §18.7 makes the terraform modules and `docs/gateway-setup.md` say out
  loud, because a missing grant on a delete path is invisible until someone
  deletes something.
- Logging: the beacon handler writes **no per-request log line** — not the session id,
  not a size, not an origin. A failed write logs the video id and the storage status
  and nothing else. No IP-bearing header (`CF-Connecting-IP`, `X-Forwarded-For`,
  `request.cf`, Lambda's `sourceIp`) is read on any analytics path.

New module `gateway/src/analytics.ts` — adapters stay thin translations; all logic
lives in core/auth/presign/analytics:

```ts
export const MAX_BEACON_BYTES: number;      // 16384
export const MAX_LISTED_SESSIONS: number;   // 1000
export const MAX_DELETED_SESSIONS: number;  // 40 — deleted per call (§18.4)
export const MAX_DELETE_LIST_PAGES: number; // 4 — listing pages walked per call (§18.4)
export interface SessionSummary { sessionId: string; lastModified: string; size: number; url: string; }
export interface SessionListing { sessions: SessionSummary[]; truncated: boolean; }
export interface DeleteResult { deleted: number; truncated: boolean; }
export interface AnalyticsStore {
  put(videoId: string, sessionId: string, body: Uint8Array): Promise<void>;
  list(videoId: string): Promise<SessionListing>;
  /** One bounded pass of §18.4; `truncated` means "call me again". */
  deleteAll(videoId: string): Promise<DeleteResult>;
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

`watch.ts` — pure, no DOM, no clock, imported by Node tests, by `beacon.ts` and by
`dashboard.ts` (§16.6), which is what both owner-side surfaces read through:

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
export interface HeatState { readonly heat: readonly number[]; readonly lastMs: number | null;
  readonly seeking: boolean; }
export function createHeatState(buckets?: number): HeatState;
export function advance(state: HeatState, currentMs: number, durationMs: number): HeatState;
export function reanchor(state: HeatState, currentMs: number): HeatState;
export function beginSeek(state: HeatState): HeatState;                  // `seeking`
export function endSeek(state: HeatState, currentMs: number): HeatState; // `seeked`
export function syncSeek(state: HeatState, elementSeeking: boolean, currentMs: number): HeatState;
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

// The video page's engagement figures (§17.6) — arithmetic, so they live here.
export function completionRate(payloads: readonly WatchPayload[]): number | null;   // 0..1
export function averageWatchedMs(payloads: readonly WatchPayload[]): number | null;
export function peakBucket(payloads: readonly WatchPayload[], buckets?: number):
  { index: number; times: number } | null;

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

- `HeatState` is immutable — every function here returns a new state and mutates
  nothing, so a test can hold both sides of a step. `createHeatState()` is all-zero
  heat, `lastMs: null` (no observation point yet) and `seeking: false`.
- `advance(state, currentMs, durationMs)` is one `timeupdate`. With
  `deltaMs = currentMs - state.lastMs`:
  - `state.lastMs === null` → no delta exists; the call only sets the observation
    point to `currentMs`.
  - `state.seeking` → **discarded**, whatever the delta is (below). The observation
    point still moves.
  - `deltaMs ≤ 0` or `deltaMs > MAX_PLAYBACK_DELTA_MS` → **discarded**. A backwards
    step is a seek back, a step over 1.5 s is a seek forward or a stall the viewer did
    not watch through, and neither is playback. The observation point still moves to
    `currentMs`, so the next step is measured from where the video actually is.
  - otherwise `deltaMs` is **pro-rated across the buckets its own media-time span
    `[state.lastMs, currentMs]` covers**, each bucket taking the milliseconds actually
    spent inside it. Writing `w = durationMs / HEAT_BUCKETS`,
    `first = bucket(state.lastMs)` and `last = bucket(currentMs)` for the clamped
    `bucket(t) = min(HEAT_BUCKETS - 1, max(0, floor(t / durationMs · HEAT_BUCKETS)))`:

    ```
    first = last  →  heat[first] += currentMs - state.lastMs

    otherwise, for b in first..last:
        from = (b = first) ? state.lastMs : b·w
        to   = (b = last)  ? currentMs    : (b+1)·w
        heat[b] += max(0, to - from)
    ```

    The span is walked as a contiguous chain — `state.lastMs` → the first boundary
    above it → … → `last·w` → `currentMs` — so the pieces sum to `deltaMs` **exactly**,
    and the end buckets swallow whatever part of the span lies outside `[0, durationMs]`
    (an element reporting a frame past its own duration, or a negative position). No
    rounding happens here; `heatMs` rounds once, at the end, so a bucket can be off by
    at most half a millisecond.
  - Pro-rating is not a refinement, it is the rule the picture depends on. Crediting a
    delta whole to the arriving bucket is only harmless while a bucket is much wider
    than a step, and **it is not**: a 27 s recording has 540 ms buckets against a
    ~250 ms foreground cadence, so buckets took 2 or 3 whole steps at random and an
    even watch rendered as a ±39% sawtooth; and a single accepted step can be nearly
    three times a bucket wide (1.5 s against 540 ms), landing whole and spiking one
    bucket to 2.8× a full pass out of nothing. The invariant this restores is the one
    §16.6 reads as a number: **one pass through a stretch, at any cadence, puts at most
    one bucket-span in a bucket**, so a bar at 2× means the stretch really was played
    twice.
  - `durationMs` not finite or `≤ 0` → there is no bucket to name, so every delta is
    discarded and heat stays all zeros while the observation point still advances. A
    session that only ever learns its duration mid-playback therefore accumulates from
    that moment on, and one that never learns it ships 50 zeros (§16.2).
- `reanchor(state, currentMs)` sets the observation point to `currentMs` and touches
  no bucket. It is what a discontinuity costs: the delta across it is dropped. It
  **preserves `seeking`** — a viewer can hit `play` with the scrubber still held, and
  only `seeked` ends a seek.
- `beginSeek(state)` sets `seeking` and is **idempotent**; `endSeek(state, currentMs)`
  clears it and re-anchors to `currentMs`. A drag is not one seek: the element aborts
  the seek in progress and starts another on every pointer move, so `seeking` fires
  many times and only the last one is ever `seeked`. Between the two, every position
  the element reports is a place the viewer is scanning past, and a hop small enough
  to pass for playback — a few hundred milliseconds of a slow drag — is
  indistinguishable from it at the only place that decision is made. Suppressing the
  whole interval is therefore the rule, not re-anchoring at each end of it: that left
  a scanned span painted with heat nobody watched, which on the reported session
  showed as the last buckets reading ~2× and one bucket at ~3.9× though nothing was
  rewatched. `endSeek` clears the flag **even when `currentMs` is not finite** (keeping
  the old anchor): suppression that could stick would cost a session all of its heat,
  a worse failure than the leak it closes.
- `syncSeek(state, elementSeeking, currentMs)` is the other half of that same rule, and
  the only thing besides `endSeek` that ends a seek: with `state.seeking` set and
  `elementSeeking` false it is `endSeek(state, currentMs)`, and otherwise it returns
  `state` untouched. `elementSeeking` is the media element's own `seeking` attribute,
  passed in because this module takes no DOM. It exists because `seeked` is the only
  *event* that ends a seek, so a `seeked` that never arrives would suppress the rest of
  the session — every later delta discarded, while `watched`, coverage and `completed`
  come off `video.played` and look untouched, making the undercount **invisible** rather
  than merely wrong. Two ways to get there: a `load()` or an `src` swap mid-session (the
  media load algorithm clears `seeking` and fires no `seeked`), and a browser abandoning
  a seek across a fullscreen or backgrounding transition. Neither is reachable through
  today's app code — `player.ts` sets `src` once, before playback — which is what makes
  this a guard rather than a bug fix.

  It is not a second opinion about whether a seek is in flight, and not a way back into
  the leak above: it reads the very state whose clearing is what queues `seeked`. A
  completed seek clears `seeking`, queues `timeupdate`, *then* queues `seeked`, so in a
  conforming browser this ends the seek one task early at the position `seeked` is about
  to report — no bucket changes hands. And a drag holds `elementSeeking` true for as
  long as it is aborting one seek and starting the next, so the first moment it reads
  false is a moment a seek has landed.
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
- `completionRate(payloads)` — `payloads.filter(p => p.completed).length /
  payloads.length`, `0..1`, and `null` for an empty list. `completed` is the payload's
  own flag (§16.2: coverage ≥ `COMPLETION_THRESHOLD`), not something recomputed here,
  so the number the video page shows is the number the viewer's browser decided —
  which is what makes the two sides agree by construction.
- `averageWatchedMs(payloads)` — the **mean of `watchedMs(p.watched)` over the payloads
  with `p.durationMs > 0`**, and `null` when none has one. Both sides of the division
  are that subset: a session with an unknown duration knows how long it watched but not
  what fraction that was, and counting it in the denominator alone would report an
  average lower than any session in it. It is a union ("seen at least once", §16.2), so
  a viewer who watches a minute twice contributes one minute — the same thing
  `coverage` means, expressed in time.
- `peakBucket(payloads)` — the bucket with the largest `relativeHeat`, as
  `{ index, times }`, the **lowest index** winning a tie so the answer is deterministic
  in a test; `null` when every bucket is zero (no heat, or no sessions). §17.6 turns it
  into "peak 2.2× at 1:33"; a `null` means there is no caption to write.
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
  the session: every `timeupdate` calls `syncSeek(state, video.seeking, currentMs)` and
  then `advance(state, currentMs, durationMs)` for `currentMs = video.currentTime *
  1000` — the browser fires it only while playback is progressing, a few times
  a second — `play` calls `reanchor(state, video.currentTime * 1000)`, `seeking` calls
  `beginSeek(state)` and `seeked` calls `endSeek(state, video.currentTime * 1000)`.
  That is the whole reset rule: a scrub adds **nothing**, because the entire interval
  between `seeking` and `seeked` is suppressed rather than merely re-anchored at each
  end; a pause of any length adds nothing because the `play` on the other side
  re-anchors; and a section watched twice accumulates about twice its own length.
  `heatMs(state)` is read at flush time, beside `playedRanges`.
- **No other event ends a seek**, and the three that look like they should are each a
  reason not to. `play` re-anchors and leaves the flag set — a viewer can hit play with
  the scrubber still held. `ratechange` changes the size of the next delta, not its
  meaning (and past ~6× at a foreground cadence the deltas simply exceed
  `MAX_PLAYBACK_DELTA_MS`, as above). A stall's `waiting`/`playing` pair does not move
  `currentTime` at all, so it needs no handling — and a seek that rebuffers fires that
  same pair mid-flight, where treating `playing` as a resume would reopen exactly this
  leak. None of the three is wired.
- The failsafe is **not** an event and not a timer: it is the `syncSeek` call above,
  reading the element's own `seeking` on the `timeupdate` that already fires. `seeked`
  being the sole event that ends a seek is what makes a dropped one so expensive — the
  session keeps flushing, `watched` and `completed` stay right, and only the heatmap
  quietly goes to zero — so the flag is reconciled against the element rather than
  trusted to an event. Nothing else is added for it: no `loadstart`/`emptied` listener
  (a `load()` clears `seeking`, so the next `timeupdate` already recovers) and no
  timeout (there is no honest duration for one; a slow drag is unbounded).
- **No beacon at all** when: `config.js` sets no `gatewayUrl`; `/config` did not
  answer `analytics: true`; nothing has been played yet (`watched` is empty); or the
  page is an owner-side one. Beacons come from `view.html` only — neither `record.ts`
  nor `video.ts` calls this, the recorder's preview element is not tracked, and
  **`video.html` does not report on itself**. An owner watching their own video is
  not a view: the page exists to read the numbers, and a page that moved them by
  being opened would be lying about the thing it is for. It follows that `video.html`
  writes no `videoshare.viewer` key either (§16.1) — `view.html` remains the only
  page that ever does.
- **Every failure is silent**: a `sendBeacon` that returns false, a 4xx, an encrypt
  that throws. Nothing reaches the viewer, nothing retries in a loop; the next
  scheduled flush carries the same cumulative state anyway.
- `player.ts` starts it after `meta` is loaded and the gateway config has resolved,
  and does nothing else differently. Every page that handles a fragment — `player.ts`,
  `video.ts`, and `record.ts`'s library rows — parses `#{id}.{key}` through the one
  exported `parseShareFragment()` in `util.ts` (§11) so the §2 format lives in one
  place, and builds links back through `shareLink` / `videoPageLink` for the same
  reason.

### 16.6 Reading watch data (`src/dashboard.ts`)

**There is no stats page**, and as of §17 there is no expander either. Watch data
belongs next to the video it is about — and the surface that is about one video is now
the **video page** (§17.4), which is where all of it is read. `stats.html`,
`src/stats.ts` and `src/stats.css` stay deleted, along with the rollup input that
built them (§12).

The expander was the right shape for a page that was a stack of cards and is the wrong
shape for a page that has a video page to link to: a heatmap and a viewer table do not
fit in a list row, and hiding them behind a disclosure meant the data existed but was
never looked at. So:

- **Retired**: `analyticsExpander()`, `analyticsHint()`, the `<details>`/`<summary>`
  "Analytics" widget on each library row, its per-row reload affordance, and the
  `record.css` rules that styled it. Nothing in the test suite pins any of it (§13), so
  it is deleted rather than deprecated, and the deletion is complete: no dead export,
  no orphan CSS block, no "Sign in to see analytics." string left in the bundle.
- **Kept, unchanged in meaning**: the pipeline — list, fetch presigned, decrypt, parse,
  aggregate — with its concurrency bound, its caching rule, its skip-and-count rule for
  unreadable sessions, its truncation honesty and the quiet muted sentence every
  failure renders as. All of it now sits behind `loadReport()`.
- **Relocated**: the rendering. The header counts, the overall heatmap and the
  per-viewer rows become the video page's **Engagement** section (§17.6), which adds
  what a row had no width for — the stat cards, the peak caption, the time axis and the
  viewer table's columns. A library row keeps only the two numbers a list can carry
  honestly: views and unique viewers (§17.3).

Where analytics appears at all, in both places:

| `config.js` | `/config` | signed in | library row (§17.3) | video page (§17.6) |
| --- | --- | --- | --- | --- |
| no `gatewayUrl` (legacy) | — | — | no summary, no request | Engagement explains that watch data needs a gateway |
| `gatewayUrl` | `analytics: false` | — | no summary, no request | Engagement says this deployment stores none |
| `gatewayUrl` | `analytics: true` | no | no summary, no request | the designed sign-in hint (§17.6) |
| `gatewayUrl` | `analytics: true` | yes | `38 views · 12 viewers` | the full section |

Signing in and out re-renders both — `record.ts`'s auth-change handler keeps the
`renderLibrary()` call §16.6 gave it, and `video.ts` re-renders its Engagement section
on the same event. That is still the whole coupling between sign-in and analytics.

The pipeline, once per video id:

- Take `{ id, keyB64 }` (from `parseShareFragment` — the library entry's stored `link`
  on `index.html`, the page's own fragment on `video.html`) → `importKeyB64` →
  `GET {gatewayUrl}/beacon/{id}` with the Google bearer (§15.4, the same token the
  uploader holds, from `src/auth.ts` in memory) → fetch each session's ciphertext
  **directly from its presigned url**, at most `SESSION_CONCURRENCY` (6) at a time →
  `decryptBlock(key, analyticsAad(id, sessionId), block)` → `parsePayload` (v1 and v2,
  §16.2). Each kept session is a `WatchSession`: the payload plus the listing's
  `lastModified`.
- A session that fails to decrypt or to parse is **skipped and counted**, never hidden:
  the write endpoint is unauthenticated, so junk is possible, and so is a video
  re-uploaded under a new key.
- **Result caching** is per video id and lasts the **document's** lifetime. Re-rendering
  the library does not refetch, and the video page's "Reload" refetches and replaces the
  cached entry — the one affordance for "someone watched it since I opened this". A load
  that *failed* is not cached: the next attempt retries it, because the usual cause is a
  token that has since been refreshed. The cache does **not** survive navigation:
  `video.html` is a separate document, so opening a row's video page fetches that video
  once for itself. That is one listing, and the honest cost of a page that is worth
  loading.
- **The key never leaves the page.** Only the 22-character id appears in a request path;
  the fragment is parsed in memory and never written to `location`, to `history`, or
  into a form. This is the rule §16 opens with, and §17.4 restates it because the video
  page carries a key in its own address bar.

**Errors stay where they were asked for.** A 401 (token expired), a 403, a 404, a 502,
a network failure, a listing that returns nothing readable, an entry whose `link` has no
parseable fragment — on the video page each renders as one quiet muted sentence where
the content would have gone, with a "Reload" beside it; on a library row a failed
summary renders as **nothing at all**, because a row is a list item and an error
sentence per row is noise for something the reader did not ask for. Neither touches a
page-level status area, neither blocks a recording or an upload, and neither is thrown.
A 401 says so plainly ("Sign in again to load analytics.") rather than silently
re-prompting, because the sign-in control is in the sidebar of the same page.

`src/dashboard.ts` is the reader half, and it is its own module rather than more of
`record.ts` or `video.ts` for the reason `gap.ts`, `watch.ts` and `beacon.ts` are their
own: fetch-decrypt-aggregate-render is a subject. It owns no page state beyond its
cache, does no arithmetic of its own (that is `watch.ts`, §16.5/§17.6) and hands its
callers DOM:

```ts
export interface AnalyticsDeps {
  gatewayUrl: string;
  /** The current Google ID token, or null. Read per request, never captured. */
  token: () => string | null;
}
export const SESSION_CONCURRENCY: number;      // 6 — presigned session fetches at once
export const LIBRARY_CONCURRENCY: number;      // 3 — videos summarized at once (§17.3)
export const LIBRARY_SUMMARY_EAGER: number;    // rows summarized without IntersectionObserver (§17.3)
export const VIEWER_PREFIX: number;            // 8 characters, then an ellipsis
export const VIEWER_ROWS: number;              // rows before "Show all" (§17.6)

/** One video's sessions, once every object had its turn. */
export interface VideoReport {
  sessions: WatchSession[];
  /** Objects that would not decrypt or would not parse — shown, never hidden. */
  unreadable: number;
  /** The gateway's listing hit MAX_LISTED_SESSIONS; there are more than these. */
  truncated: boolean;
}
/** The two numbers a library row carries (§17.3). */
export interface VideoSummary { views: number; viewers: number; }

/** Cached per id for this document's lifetime; `refetch` replaces the entry. */
export function loadReport(video: { id: string; keyB64: string }, deps: AnalyticsDeps,
  opts?: { refetch?: boolean }): Promise<VideoReport>;
export function summarize(report: VideoReport): VideoSummary;

/** The three blocks of §17.6, in render order. `durationMs` is meta's (§5). */
export function statCards(report: VideoReport): HTMLElement;
export function replayHeatmap(report: VideoReport, durationMs: number): HTMLElement;
export function viewerTable(report: VideoReport): HTMLElement;

// The deletion half of this module — MAX_DELETE_ROUNDS, DeleteRound,
// nextDeleteRound, deleteSessions — is §18.4. It shares `AnalyticsDeps` and
// invalidates the cache above, which is why it lives here.
```

`record.ts` and `video.ts` decide, from the gateway config and the auth state they
already track, whether to call any of this at all. Styles go in `shell.css` (§11), which
both owner pages load; `stats.css` is deleted, not moved.

### 16.7 Legacy mode

Zero behaviour change, and stated so it can be tested rather than hoped for: with no
`gatewayUrl`, `view.html` makes exactly the requests §8 already makes, writes no
localStorage key, mints no ids, loads no Google script, and contains no timer;
`index.html`'s library renders plain rows — no summary, no bearer, no listing call
(§16.6) — and its shell shows no account chip (§17.1); and `video.html` plays the
video and nothing else, with an Engagement section that explains itself in one
sentence and makes no request. §9's settings and §10's "viewers are strangers" are
otherwise untouched.

What this section is about is **analytics**, and §3's thumbnail is not analytics: a
`thumb.bin` GET is an anonymous public read of the video bucket, the same kind of
request §8 already makes for `meta.json`, and it happens in **both** modes on both
owner-side pages. "Plain rows" above means no summary, no bearer and no gateway
call — not no picture. The guarantee that does not move: `view.html` gains no
request of any kind (§3), legacy mode still sends nothing to a gateway, still
mints no id and still writes no new storage key, and the only new bytes anywhere
are one public GET per visible library row and one per video page.

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

This section is about the analytics bucket and nothing in it changes for §3's
thumbnail, which lives in the *video* bucket, is written by the uploader rather
than the gateway, and never passes through this service in either direction — the
gateway signs a `put-thumb` URL (§15.3) and carries no byte of it. The video
bucket's own disclosure is §1's, extended there.

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
    delta across a pause and across a scrub; the boundary cases — a step *ending* on a
    bucket edge credited to the bucket below and one *starting* there to the bucket
    above, `currentMs === durationMs` landing in bucket 49 rather than 50, a position
    past the duration clamped to 49, a negative position clamped to 0; `durationMs` of
    `0`, `NaN` and `Infinity` accumulating nothing while leaving the state advanced;
    and immutability (the input state unchanged after both calls).
  - Pro-rating, against the jitter it was added to fix: a delta straddling one boundary
    split in proportion to either side; a delta spanning several whole buckets giving
    each of them its own span; conservation (what a step spreads sums back to the step,
    across geometries including a span shorter than a boundary gap and one clamped at
    either end); and the property that matters to the picture — a straight-through 1×
    watch of a **27 s** video (540 ms buckets, the length the jitter was reported
    against) leaving every bucket within a millisecond of its own span, at cadences
    from 100 ms to 1 400 ms, and on a duration whose buckets divide the cadence
    unevenly. The pre-fix rule failed all of these by ±39%.
  - The seek in flight: a slow drag's small forward hops accumulating **nothing** over
    the span they scanned; suppression holding across the repeated `seeking` a single
    drag fires; `endSeek` resuming from where the seek landed; the observation point
    still moving while suppressed; `endSeek` clearing the flag even on a non-finite
    landing (suppression must never stick); `reanchor` preserving the flag, so a `play`
    mid-drag is not an opening; and the reported session end to end — watch 5 s, drag
    to the end and back, watch the last 5 s out — leaving every bucket at ≤ 1.02× with
    the scanned middle at exactly zero, where it used to show ~2× at the end and a
    3.9× spike.
  - `syncSeek`, the guard against suppression sticking: a dropped `seeked` costing the
    session nothing beyond the seek itself, where without it every later delta is
    discarded; the same for a mid-session `load()`, whose reset to 0 arrives as a
    backwards step; a no-op while the element is still seeking, so a drag is not
    reopened; a no-op when no seek is in flight, in particular **not** re-anchoring and
    swallowing the delta of an ordinary step; and the ordering a real browser produces
    (`seeking` cleared → `timeupdate` → `seeked`) leaving exactly the state the `seeked`
    alone would have.
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
  - The engagement figures §17.6 puts on the video page, which are arithmetic and so
    live and are tested here: `completionRate` over a mix of completed and not
    (including all-completed, none-completed, and `null` for no sessions at all);
    `averageWatchedMs` averaging `watchedMs` over **only** the payloads with
    `durationMs > 0` — proven by a session with `durationMs: 0` and a non-empty
    `watched` list changing neither the numerator nor the denominator — and `null`
    when no payload has a duration; `peakBucket` returning the highest
    `relativeHeat` bucket with its `×` value, taking the **lowest index** on a tie,
    and `null` when every bucket is zero (so §17.6's caption is omitted rather than
    reading "peak 0.0× at 0:00").
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
  is which event name calls which function. The seek pair is the one place that is
  worth stating plainly rather than leaving implied: `seeking` and `seeked` no longer
  call the same function, so the four listeners are `timeupdate`→`syncSeek` then
  `advance`, `play`→`reanchor`, `seeking`→`beginSeek`, `seeked`→`endSeek`, and a mapping
  that swapped the last two would suppress everything **except** the drag. The
  `video.seeking` argument to `syncSeek` is the other untested joint — passing a
  constant `false` there would defeat the drag suppression entirely, and passing
  `state.seeking` would defeat the guard. §16.10's first-deploy check is where both get
  eyes on them.
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
  unauthenticated, so there is nothing to bypass; the read endpoint and §18.4's
  delete endpoint both run the same minted-JWT path as `/api/sign`. What §18 adds
  to these same two suites is listed in §18.6, with the subrequest bound asserted
  rather than described.
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
  need `GET` CORS from the site origin for the video page's presigned session fetches,
  that leaving the variable unset is a supported configuration, and §16.9's
  one-real-beacon smoke test for Lambda deployments — written the same way §15.7's R2
  step is, with the failure it catches and what to do about it. That smoke test reads
  its result off the **video page** (§17.4): record a video, watch a minute of it from
  its share link, then open the app, sign in, and click that recording in **Videos**.
  One view with a plausible heatmap means the beacon survived; "1 session could not be
  read" on a video whose key has not changed is the failure it exists to catch. Every
  pointer that used to say "expand Analytics on that row" says this instead — there is
  no expander (§16.6).
- `examples/docker-compose.yml`: the `mc` init job creates the analytics bucket
  (private, no anonymous policy) and sets its GET CORS; the `gateway` profile passes
  `ANALYTICS_BUCKET`.
- `README.md`: one honest paragraph in the security model — the server learns that and
  roughly when a video id was watched and how big each session object is; it never
  learns watch ranges, viewer identity, or an IP address, because none is read. Watch
  data is readable only by holders of the share link. Its description of *where you
  read the data* is the **video page** (`video.html`, §17.4), reached by clicking a
  recording in Videos: no sentence in the README may promise a `stats.html` that the
  build no longer emits (§12), or an Analytics expander that no longer exists (§16.6).
  What the video page shows is views, unique viewers, completion rate, average watch
  time, the replay heatmap and the per-viewer table (§17.6); what a library row shows
  is views and unique viewers (§17.3).

## 17. Owner-side shell, library and video page

Everything in this section is **owner-side**. The share experience is `view.html`, and it
is not touched: same markup, same `player.css`, same requests, same behaviour (§1, §8).
Recipients must not be able to tell that any of §17 happened.

The visual reference is the two approved mockups, `Main.dc.html` (the library) and
`Video.dc.html` (the video page), which are checked in beside this document at
`docs/design/` so the reference does not dangle. They are dark-mode renderings whose literal
hexes are `app.css`'s **dark** token values; translate them back to the tokens
(`--surface`, `--border`, `--border-strong`, `--accent`, `--accent-soft`, `--text`,
`--text-muted`, `--text-faint`, the `--space-*` and `--radius-*` scales) rather than
writing hexes, extending `app.css` only where a token is genuinely missing. The light
theme then has to be as considered as the dark one: the mockups do not show it, and "it
inverts" is not a design.

No new runtime dependency, no external asset, no webfont, no chart library, no canvas:
everything below is DOM, CSS and inline SVG, the way §16.6's heatmap already was — plus,
since §3, one `<img>` per library row and one `poster` attribute on the video page, whose
bytes come out of the bucket rather than out of the repo. The "no canvas" here is about
*drawing the interface*: §6 paints one frame to a canvas to make a thumbnail, and nothing
in §17 draws anything into one.
Pixel values in the mockups are guidance. This section pins **structure, states and
behaviour**, and where a mockup and this section disagree, this section is the contract.

### 17.1 The shell

A `<nav>` sidebar, 232px, full height, its own surface against `--bg`, divided from the
main column by a 1px `--border`. Three parts, top to bottom:

- **Wordmark** — the brand mark `view.html`'s topbar already uses, plus "VideoShare",
  linking to the library (`#/videos` on `index.html`, `index.html#/videos` on
  `video.html`). Same mark on every page on purpose: a viewer who follows a link and the
  owner who made it are looking at one product.
- **Nav** — four items, each an `<a>` with an inline SVG glyph and a label: **Videos** →
  `#/videos`, **New recording** → `#/record`, **Upload video** → `#/upload` (§19),
  **Settings** → `#/settings`. The active one carries `aria-current="page"` and the accent
  treatment. On `video.html` the four point at `index.html#/…` and **Videos** is the active
  one — a video page is a video in the library.
- **Footer**, in order:
  - the **"Encrypted in this browser"** lock line, glyph and text as the topbar carries
    them today. Both modes, both owner pages: it is the one sentence of the threat model
    a user should never have to go looking for.
  - the **account chip**, gateway mode only. Signed in: a round monogram (first character
    of the email, uppercased), the email — ellipsized, with the full address as its
    `title` — and a **Sign out** control. Signed out, loading or errored: the chip is the
    mount point for Google's button (`#auth-button`). GIS renders its own button, so that
    mount must exist exactly once in the document, and the sidebar is where it lives.
  - **Legacy mode has no chip at all** — no account, no sign-in, nothing to sign out of —
    and the lock line ends the column.

Auth *messages* do not belong in a 232px column. The status line, the "loading Google
sign-in" text and the `publicBaseUrl` mismatch warning render in the Settings view's
**Account** block (§17.2), which also repeats the identity and the Sign out control. The
chip shows state; the Settings view carries text; there is still exactly one Google
button, in the chip.

Below 900px the sidebar becomes a **top bar**: the same DOM restyled by a media query —
wordmark left, the three nav items in a row, the chip right. No drawer, no hamburger, no
JS; below ~520px the nav labels may reduce to glyphs with the label kept as the
accessible name. A route change stays the only thing that changes what is shown.

The sidebar's markup is **duplicated literally** in `index.html` and `video.html`, the way
the topbar is duplicated in `index.html` and `view.html` today; `shell.ts` owns behaviour
only. Deliberate: the page has a sidebar before any module parses, and nothing about the
shell depends on script.

### 17.2 Routing and the three views

`index.html`'s main column holds four sibling `<section>`s and nothing else:

| hash | section | contains |
| --- | --- | --- |
| `#/videos` | `#view-videos` | §17.3's library — **the default** |
| `#/record` | `#view-record` | §6's stage machine, its guards and its element ids, verbatim |
| `#/upload` | `#view-upload` | §19's uploader — a file already on disk becomes a share link |
| `#/settings` | `#view-settings` | Recording options; the Account block (gateway mode); the Storage settings form (legacy mode) |

- The router is hand-rolled: a `hashchange` listener plus one application at load.
  `parseRoute(hash)` is pure — `#/videos`, `#/record`, `#/upload`, `#/settings`, a single
  trailing `/` tolerated, and **everything else — `""`, `"#"`, `"#/"`, an unknown route, a
  nonsense string — is `"videos"`**. `routeHash(view)` is its inverse and the only place
  a hash string is written.
- Applying a route: the matching section loses `hidden`, the others get it — the
  attribute, not merely a class, so a hidden view leaves the accessibility tree and its
  controls leave the tab order; the matching nav link gains `aria-current="page"` and the
  others lose it; `document.title` follows the view. Nothing is created or destroyed: all
  three views are in the document from the start and stay there.
- An unrecognized or empty hash is corrected with **`history.replaceState`**, never by
  assigning `location.hash`: a history entry for a route the reader did not ask for turns
  Back into a trap.
- **Routing never touches the recorder** (§6). A recording, its timer, its assembler and
  its multipart upload run on while the reader is in another view, and `beforeunload`
  still guards `recording`/`preview`/`finishing`. The pull in the other direction is §6's
  rule: a transition into `preview`, `finishing` or `done` **shows the record view**,
  because those stages are asking the reader for something. While the stage is
  `recording`, the **New recording** nav item carries a live indicator, so leaving the
  view never hides a running capture.
- **Starting a recording from anywhere is a navigation.** The library's "New recording"
  button and the nav item both go to `#/record` and leave the stage at `idle`. Neither
  starts capture: the record view's own **Record screen** button does, with the mic
  toggle beside it, and `getDisplayMedia` keeps the direct user activation it needs.
- `demandSettings(text)` — route to `#/settings`, make the demanded form visible, move
  focus into it (its first empty required field) and announce `text` in that view's live
  region. It no longer opens a `<details>`: the settings view has no disclosure widget,
  its blocks are simply there.
- `demandSignIn(text)` — **no navigation**. Sign-in lives in the shell chrome, visible
  from every view and both owner pages, so there is no view to navigate to: it highlights
  the account chip, moves focus to the sign-in control, and announces `text` in the
  current view's live region.
- The highlight is one shared treatment (`.demanded`): a brief attention ring settling
  into a static outline, skipping straight to the static state under
  `prefers-reduced-motion`, cleared on the next interaction with the thing highlighted. A
  highlight is never the only signal — the message is always in a live region and focus
  always moves, because neither a colour nor a pulse reaches a screen reader.

`shell.ts`:

```ts
export type ViewName = "videos" | "record" | "upload" | "settings";
export const DEFAULT_VIEW: ViewName;                     // "videos"
export function parseRoute(hash: string): ViewName;      // pure; never throws
export function routeHash(view: ViewName): string;       // "#/videos" | "#/record" | "#/upload" | "#/settings"
export interface Router {
  readonly view: ViewName;
  go(view: ViewName): void;                              // pushes a history entry
  onChange(listener: (view: ViewName) => void): void;
}
/** index.html only: wires hashchange and applies the current route once. */
export function startRouter(): Router;
/** The sidebar's account chip. A null `auth` is legacy mode: the chip is removed. */
export interface AccountChip { render(state: AuthState): void; highlight(): void; }
export function initAccountChip(auth: Auth | null): AccountChip;
```

`video.html` calls `initAccountChip` and marks **Videos** current. It has no router: its
nav links are ordinary cross-document links.

### 17.3 The library (`#/videos`)

Header: an `<h1>` "Videos", a sub-line, a ghost **Upload video** button (§19) and a
primary **New recording** button (§17.2) — both navigations and nothing more.
The sub-line counts only what this browser knows — `N recordings · X uploaded from this
browser`, summing `sizeBytes` over the entries that carry one. It does **not** claim to
describe the bucket: the mockup's "in your bucket" is a number the local library cannot
back, because removing an entry leaves the object exactly where it was (§9).

An empty library keeps today's empty state, unchanged in substance.

One card per entry, newest first (§9's order):

1. **Thumbnail** — a 16:9 block: the CSS-only pattern, a play glyph and a duration chip
   reading `formatDuration(entry.durationMs)`. The pattern's variant is **derived from
   `entry.id`** by a pure function, so a row looks the same on every reload; the whole
   block is decoration and it is `aria-hidden`.
   The pattern is now the **fallback**, not the only state: a row also tries §3's
   `thumb.bin` and, when it reads, shows it as an `<img>` filling the frame
   (`object-fit: cover`, `alt=""`, inside the same `aria-hidden` block) with the play
   glyph and the duration chip still over it. On any failure — including the `<img>`'s own
   `error` event — the pattern stands and nothing is said (§3). The pattern therefore
   stays in the DOM of every row and is what the image covers, so the fallback needs no
   re-render to appear.
   **What it costs, and how that is bounded** (the discipline is §17.3's own, below, for
   the summaries — the same rules, a second queue):
   - the base is `publicBaseUrl()` from `config.js` (§10), in **both** modes. A
     deployment whose `config.js` is missing or malformed fetches nothing and every row
     keeps its pattern, exactly as it does today;
   - `{ id, keyB64 }` comes from `entryVideo(entry)` — the stored link's own fragment,
     through `parseShareFragment`, never written anywhere but the decrypt (§17.3's rule
     for the row's `href`). An entry with no parseable fragment fetches nothing;
   - a row's thumbnail loads **when the row is visible**, on the same
     `IntersectionObserver` — one observer, one `rootMargin`, one per-row record now
     carrying *both* a summary job and a thumbnail job, so a row is never observed twice
     and one queue's arrival never drops the other's — with the same
     `LIBRARY_SUMMARY_EAGER` "first screenful" fallback for a browser that has no
     observer. At most `LIBRARY_THUMB_CONCURRENCY` (4) fetches in flight, and the queue is
     abandoned when the library re-renders: a second generation counter beside the
     summaries', not a share of theirs, because the two have different lifetimes and only
     one of them depends on being signed in;
   - **thumbnails do not depend on sign-in, on a gateway, or on `analytics: true`.** They
     are a §3 public read, so unlike a summary they load in legacy mode too, and they
     start when the videos view is first shown for the same reason summaries do. Two
     conditions today are written as "summaries are available" and must become "anything
     is deferred", or legacy mode silently loses its lazy loading: the observer is created
     whenever **either** queue has work, not only when summaries do, and the first
     transition into the videos view re-renders the library on the same broader test.
     Nothing else about the render is conditional — a row is built the same way in both
     modes, and it is what fills it in that differs;
   - **Object-URL lifecycle**: a decrypted thumbnail is turned into one object URL,
     cached **by video id for the document's lifetime**, and reused by every later render
     of that row — a re-render must never refetch, redecrypt or re-mint a URL. A *miss*
     (404, 403, a block that will not decrypt) is cached too, as "this video has no
     thumbnail", so a re-render does not retry a fact; a **network or transport failure is
     not cached**, on §16.6's reasoning that the usual cause has since gone away. A URL is
     revoked exactly when its id leaves `loadLibrary()` — i.e. on Remove — and **not**
     when a row's DOM node is replaced by a re-render, which is what "cache for the page,
     revoke on row removal" has to mean if both halves are to be true at once.
2. **Title** — `entry.title || "Untitled recording"`, and the row's link.
3. **Meta line** — today's `librarySubtitle(entry)`, unchanged: created date
   (`toLocaleString()`) · duration · size · effective bitrate, the last two only when
   `sizeBytes` is known (§9). **No codec**: `LibraryEntry` carries none, and recording one
   for new entries only would make older rows read as a different kind of thing. (The
   mockup shows a codec; the video page, which has `meta.mimeType`, is where it appears.)
4. **Views summary** — when and only when the gateway answered `analytics: true` and
   there is a token (§16.6's table): `summarize(...)` rendered as the count above
   `views · N viewers`. Zero kept sessions reads "No views yet."; a report that failed
   renders nothing at all. The unreadable-session and truncation notes belong to the video
   page, which has room to be honest about them.
5. **Copy link** — copies `entry.link`, the **share link**, always. This is the button
   whose output goes to other people; it must never hand out a `video.html` URL.
6. **Overflow menu** — a `⋯` button (`aria-haspopup="menu"`, `aria-expanded`) opening a
   small menu with **two** items, whose names are the contract because the difference
   between them is the whole point (§18):
   - **Remove from list** — today's item under an honest name, with today's meaning
     and today's warning kept visible (§9: the local entry only; the video stays in
     the bucket). `removeFromLibrary(entry.id)` then a re-render, exactly as now.
   - **Delete video** — §18. The objects go, then the entry goes. It is the
     destructive item and is styled as one, last in the menu.

   Escape or an outside click closes the menu, focus returns to the trigger, and the
   whole thing works from the keyboard.

   **The confirm step is inline, in the page's own design language.** No
   `window.confirm`: choosing **Delete video** replaces the menu's contents in
   place with one sentence naming what is about to happen — the objects are
   deleted from the bucket and every copy of the share link stops working — plus a
   **Delete** button and a **Cancel** button. Focus moves to **Cancel**, which is
   the safe half; Escape and an outside click are both Cancel and both close the
   menu; Cancel returns the menu to its two items rather than closing it, so a
   mis-click costs one keystroke. The sentence is a live-region announcement as
   well as text, per §17.7. Nothing is deleted until **Delete** is pressed, and
   there is no second confirmation after it.
   Legacy mode's sentence says the same thing; gateway mode's adds the analytics
   clause only when the gateway answered `analytics: true`, because a deployment
   that stores no watch data must not be told its watch data is going.

   **While a delete runs**, the menu closes and the row goes busy: `aria-busy` on
   the row, a muted "Deleting…" line where the row's error line goes, and the row's
   own controls — the title link, Copy link and the `⋯` trigger — disabled. The
   thumbnail block goes with the title link: it is `aria-hidden` decoration and out
   of the tab order, but it is an `<a>` aimed at the same video page, so a busy row
   drops its `href` too and gets it back with the title's. Disabling three of the
   four would leave the mouse a door the keyboard no longer has. Rows delete
   independently; one row's delete never disables another's.

   **On success** the library re-renders (§18.1 removes the entry, the thumbnail
   object URL and the cached report). **On failure the entry stays** — never
   silently downgraded to a Remove from list — the busy state lifts, the controls
   come back, and the row shows **one muted error sentence** beneath its meta line,
   in the register §16.6's failures use. This is the one place §16.6's "a failed
   thing on a row renders as nothing at all" does not apply, and deliberately: a
   summary is something the row went and got unasked, a delete is something the
   reader pressed a button for.

   **The delete state survives a re-render.** It is held per video id in a module
   map beside `thumbUrls`, and `libraryRow` reads it while building — the same
   pattern and for the same reason, since a sign-in change or a finished recording
   can re-render the library while a delete is in flight and must not take the row's
   busy state or its error with it. The error clears on the next attempt for that
   id, and when the id leaves `loadLibrary()`.

   **Gateway mode requires a signed-in session.** With no token, **Delete video**
   does not fail and does not fetch: it closes the menu and calls
   `demandSignIn(…)` (§17.2), the same way recording does. Legacy mode needs no
   sign-in and never had one.

**The row's link target** is `video.html#{id}.{key}`, built by running `entry.link`
through `parseShareFragment` and re-serialising with `videoPageLink(id, keyB64)` (§11) —
never by appending to the stored link, and never by writing the key anywhere but that
`href`. An entry whose link has **no parseable fragment** still renders: its title is
plain text instead of a link, Copy link still copies what was stored, and no summary is
attempted.

**What the summaries cost.** §16.6's expander guaranteed that a library of forty videos
cost the one `/config` request the recorder already makes; summarizing every row eagerly
would fire forty listings and every session fetch behind them. So a row's summary loads
**when the row is visible** (`IntersectionObserver`; with no observer available, the first
`LIBRARY_SUMMARY_EAGER` rows load and the rest on demand), at most `LIBRARY_CONCURRENCY`
videos in flight, and the queue is abandoned when the library re-renders. Summaries start
when the videos view is first shown — not on a load that lands on `#/record` — and they
clear on sign-out. A row whose summary has not arrived shows the space it will occupy and
nothing else: no per-row spinner, because a list of spinners reads worse than a list that
fills in.

The thumbnail queue above follows the same discipline for the same reason, and is
deliberately a **separate** queue: a summary is an authenticated gateway listing plus every
session behind it, a thumbnail is one public GET of ~30 KB, and one blocking the other
either way would be an accident. They share the observer that decides a row is visible,
and nothing else — not a counter, not a generation, not a concurrency budget. A thumbnail
that has not arrived is the pattern, which is a finished state rather than a gap, so it
needs no placeholder of its own.

### 17.4 The video page (`video.html`, `src/video.ts`)

The owner's page for one video: the same video a share link plays, and everything the
watch data says about it. Nobody is sent this URL, but it holds a key in its address bar
exactly as `view.html` does, and the rules are the same ones.

- **Fragment contract, identical to §2/§8**: `video.html#{id}.{key}`, parsed by
  `parseShareFragment`. A missing or malformed fragment gets the same friendly error
  `view.html` gives, worded for the owner. The key decrypts and does nothing else: it
  appears in no request path, query, header or body, and is never written to `history`,
  into a form, or into any storage (§16's second invariant, restated here because this
  page's own URL carries one).
- **Config**: `publicBaseUrl()` from `config.js` (§10), resolved exactly as `view.html`
  resolves it. Gateway mode additionally fetches `{gatewayUrl}/config` once, for
  `analytics` and the Google client id; legacy mode fetches neither and loads no Google
  script.
- **Layout**, per `Video.dc.html`: the shell sidebar with **Videos** active; a back link
  **"All videos"** to `index.html#/videos`; the title row; the player as the hero; then
  Engagement (§17.6).
- **Title row** — the decrypted `meta.title` (or "Untitled recording") as `<h1>`; a meta
  line; and **Copy link**, which copies `shareLink(id, keyB64)` (§11) — the *viewer's*
  link, resolved from this page's own URL and therefore byte-identical to the one the
  recorder stored. The meta line is `meta.createdAt` (`toLocaleDateString`) ·
  `formatDuration(meta.durationMs)` · `formatBytes(meta.totalBytes)` ·
  `codecLabel(meta.mimeType)` when it names one, with the frame size appended as `W×H`
  once the media element reports a `videoWidth` — which is the only honest source for a
  resolution, since `VideoMeta` carries none. The mockup's `⋯` button beside Copy link is
  **not built**: there is no second action this page can perform honestly (a video page
  opened from a link in another browser has no library entry to remove), and an empty menu
  is worse than no menu.
- **Poster** — §3's `thumb.bin`, when it reads, becomes the `<video>`'s `poster` (an
  object URL) so the hero shows the recording instead of a black rectangle while the first
  chunk is fetched and decrypted. Same silent fallback as everywhere else: no thumbnail,
  no poster, no message, and the hero's existing loading treatment stands.
  - The fetch is started as soon as the key is imported and is **never awaited**: it runs
    beside `fetchMeta` and `startPlayback`, and nothing about playback waits on a
    decorative image. It is one `fetchThumbnail` call, not a queue — one video, one
    document.
  - The poster is applied whenever it lands. Once a frame has painted the element ignores
    it, which is the correct outcome and needs no guard; the same object URL lives for the
    document and is not revoked, because there is exactly one of it and the page owns it
    until it goes.
  - This is `video.ts`'s own chrome, not the player core's: `playback.ts` gains nothing
    for it (§17.5), and `view.html` is untouched — a recipient's page makes no thumbnail
    request and gets no poster.
- **Player** — the shared core (§17.5) in a framed 16:9 hero, with the browser's own
  `controls`, as `view.html` uses. `video.css` styles the frame; the mockup's drawn
  control bar is illustrative and is not a request for a custom one. The page **does not
  autoplay**: fetching, decrypting and appending start immediately so the video is ready
  the moment it is wanted, but playback waits for the reader, who came to look at numbers
  and should not have audio start underneath them. A play affordance sits over the hero
  and the core's `onAutoplayBlocked` hook feeds the same control. (`view.html` still
  autoplays — that is §8, unchanged.)
- **No beacon, ever** (§16.5). The owner's own visit is not a view, and this page writes no
  `videoshare.viewer` key.
- A playback failure renders the core's `PlaybackError` (title + sentence) in a designed
  panel in the hero's place, and **does not hide Engagement**: the watch data is still
  readable, and is often exactly what the reader came for.

### 17.5 The player core (`src/playback.ts`)

§8 is implemented once and driven by two pages. The split is by subject:

**`playback.ts` owns** all of §8 — meta fetch, parse and validation; the block reader with
its Range requests and its whole-object fallback; per-chunk decryption and the
plaintext-length check; the MSE path (`SourceBuffer`, quota eviction, fetch-ahead,
`endOfStream`); the whole-file fallback and its duration probe; and the buffered-gap
jumper. `gap.ts` stays exactly where it is and keeps its tests. `PlaybackError` (title +
message) is `playback.ts`'s export, and §8's strings move with it unchanged.

**A page owns** its own chrome: fragment parsing, title and meta rendering, status and
error presentation, the play affordance, and — on `view.html` only — starting the watch
beacon (§16.5).

```ts
export class PlaybackError extends Error { readonly title: string; }
export interface PlaybackOptions {
  video: HTMLVideoElement;
  publicBaseUrl: string;
  id: string;
  key: CryptoKey;
  meta: VideoMeta;
  /** view.html: true (§8, unchanged). video.html: false (§17.4). */
  autoplay: boolean;
  /** A progress line, or null to clear it. */
  onStatus(text: string | null): void;
  /** play() was refused by the autoplay policy — offer a play control. */
  onAutoplayBlocked(): void;
}
export interface Playback {
  /** Resolves when the last chunk has been appended; rejects with §8's error. */
  readonly done: Promise<void>;
  /** True once MSE accepted a chunk or the blob src was set. Before that a media
      element error is recoverable — the whole-file fallback is still to come — and
      must not be reported (§8). */
  sourceCommitted(): boolean;
}
export function fetchMeta(publicBaseUrl: string, id: string, key: CryptoKey): Promise<VideoMeta>;
export function startPlayback(opts: PlaybackOptions): Playback;
```

Two constraints on the extraction, both load-bearing:

- **No module-level per-playback state.** `player.ts`'s `appendedAny` and
  `sourceCommitted` are module variables today; in a shared module they become state of
  the returned `Playback`. Two pages never share one, but a module-level flag is a bug
  waiting for the first page that plays twice.
- **`view.html` is unchanged from a viewer's seat**: the same requests in the same order,
  the same status strings, the same error titles and bodies, the same event wiring (the
  `play`, `loadeddata` and `error` listeners and the play-overlay button), the same
  `player.css`. The refactor is only correct if a viewer cannot tell it happened.

### 17.6 Engagement (on the video page)

One section, heading **Engagement**, under the player, with the standing note that watch
data is encrypted and readable only by holders of the share link (§16.8). Everything in it
is computed in this browser from decrypted payloads (`watch.ts`, §16.5) after
`loadReport` (§16.6). `payloads` below is `report.sessions.map(s => s.payload)`.

**Four stat cards**, in this order:

| card | value |
| --- | --- |
| **Views** | kept sessions — `report.sessions.length`, one per viewing instance |
| **Unique viewers** | `groupByViewer(report.sessions).length` |
| **Completion rate** | `completionRate(payloads)` as a rounded percentage; "—" when null |
| **Avg watch time** | `averageWatchedMs(payloads)` through `formatDuration`; "—" when null |

**The replay heatmap** — `HEAT_BUCKETS` (50) plain CSS bars, one per 2% of the video, with
§16.6's two channels unchanged: height = `normalizeHeat(sumHeat(payloads))`, intensity =
`relativeHeat(payloads)` with a bucket at or above `1.0` reading visibly hotter than one
below it, tooltip exactly `~N.Nx`. It gains the two things a library row had no width for:

- a **peak caption** from `peakBucket(payloads)`: `peak {times.toFixed(1)}× at {t}`, where
  `t = formatDuration(index · meta.durationMs / HEAT_BUCKETS)` — the bucket's start, which
  is the position a reader would scrub to. Omitted entirely when `peakBucket` is null or
  `meta.durationMs` is 0, rather than printed as zeros;
- a **time axis** of five labels under the bars — `0`, ¼, ½, ¾ and the full duration,
  through `formatDuration` — when `meta.durationMs > 0`, and the existing Start/End pair
  when it is not.

**The viewer table** — one row per unique viewer in `groupByViewer` order (most recent
activity first):

| column | value |
| --- | --- |
| Viewer | `browserId` truncated to `VIEWER_PREFIX` (8) characters and an ellipsis — and the full id nowhere: not in a `title`, not in an `aria-label` (§16.6's reasoning stands) |
| Plays | that viewer's session count, "N plays" / "1 play" |
| Attention | their own heatmap, both channels computed over their own payloads |
| Watched | their best session's coverage as a percentage, or "—" when no session of theirs has a known duration |
| Last seen | their `lastWatched` (`lastModified`) through `toLocaleString()` |

No IP column, because no IP exists to put in one (§16.8).

At most `VIEWER_ROWS` rows render, followed by an honest line — **"Showing N of M
viewers"** — and a **Show all** control that reveals the rest in place. It fetches
nothing: every viewer is already in memory, and this truncation is about a readable page,
not about a request. The line goes away when N = M.

Two further lines, each **only when true** (§16.6): "N sessions could not be read", and a
note that the gateway's listing was truncated at `MAX_LISTED_SESSIONS` — so "12 viewers"
is never quietly "the viewers in the first 1000 sessions". A **Reload** control refetches
under §16.6's cache rule.

**Zero sessions** is its own line — "No views yet." — with the cards showing zeros, no
heatmap and no table, rather than 50 hairlines that imply data.

**The three states that are not "signed in with analytics on"** are each a designed block
in the same footprint, never an absence:

- gateway + `analytics: true` + **signed out** → a sign-in hint: the watch data exists,
  it is encrypted, signing in is what reads it, and the control is in the sidebar. It
  makes no request. Signing in renders the section for real, on the same auth-change event
  that re-renders the library (§16.6).
- gateway + `analytics: false` → this deployment stores no watch data, pointing at
  `ANALYTICS_BUCKET` (§16.4). Not an error: it is a supported configuration.
- legacy (no `gatewayUrl`) → watch data needs a gateway; the video plays either way. No
  request, no Google script, no storage key (§16.7).

In all of them, and while a report is loading or after one has failed, **the player is
unaffected**. Engagement is a section of a page, not the page.

### 17.7 Accessibility, motion and theme

What §17 must not lose, stated so it can be checked:

- every control reachable and operable from the keyboard, with `app.css`'s
  `:focus-visible` ring and not a bespoke one: nav links, the chip's controls, each row's
  link, Copy link, the overflow trigger and its items, Show all, Reload;
- `aria-current="page"` on the active nav item; `hidden` on inactive views;
- the overflow menu: `aria-haspopup`/`aria-expanded`, Escape closes it, focus returns to
  the trigger — and its confirm step (§17.3, §18) is part of that: both its buttons are
  in the tab order, focus lands on **Cancel**, Escape cancels, and the confirming
  sentence is announced in a live region rather than only seen. A row mid-delete
  carries `aria-busy` and disabled controls; a row whose delete failed carries the
  error sentence as text in the row, not as a colour;
- decoration marked `aria-hidden` (the thumbnail pattern, the glyphs), and each heatmap
  keeping the `role="img"` and real label it has today. A row's real thumbnail (§17.3) is
  decoration on the same terms: it lives inside the `aria-hidden` frame, carries `alt=""`,
  and adds nothing to the accessibility tree — the row's name is its title, and "a frame
  of the video" is not information a screen reader can use. Likewise the video page's
  poster, which is an attribute of the player and never an announced image;
- messages in live regions, as `#message`, `#settings-status` and `#recording-status`
  already are;
- `prefers-reduced-motion`: no pulse, no slide, no animated bar growth — every transition
  §17 adds degrades to an instant state change;
- **light-theme parity**: the mockups are dark, so every surface, border, chip, bar and
  hover state must be expressed in tokens and then looked at in light mode with the same
  care the dark one got.

### 17.8 What §17 deletes

`analyticsExpander`, `analyticsHint` and the `record.css` rules that styled them (§16.6);
`index.html`'s topbar and single-column card stack (`.topbar`, `.page-head`, and the
`<details>` framing of the settings and recording-options panels); `record.ts`'s
`recordedCodec` + `CODEC_NAMES` and `upload.ts`'s `shareLink`, **moved** to `util.ts`
(§11) rather than copied. `view.html` and `player.css` are untouched, and were untouched
by §17 as written; the claim that `gateway/` and §§2–8, §15 and §16.1–16.5 are untouched
was §17's own scope statement and is **superseded** by §3's thumbnail, which amends §3,
§4, §6, §7, §15.3 and §15.5 and adds one op to `gateway/src/presign.ts` — and again by
§18's deletion, which amends §3, §7, §9, §11, §12, §13, §14, §15.3, §15.5, §16.3, §16.4,
§16.9, §17.3 and §17.7 and adds a seventh op and one endpoint. What survives all of it
unchanged, and is the part worth stating: **`view.html` and `player.css`, still**. A
recipient cannot tell that §17, §3's thumbnail or §18 happened — §18.5 is a claim about
the player's existing behaviour, checked rather than changed.

### 17.9 Docs

- `README.md`: its product description becomes §1's three pages — the shell and its three
  views, the video page, and the player recipients get — and its analytics paragraph
  points at the video page rather than an expander (§16.10).
- `docs/gateway-setup.md`: every "expand **Analytics** on that row" pointer becomes "open
  the recording from **Videos**", and the troubleshooting rows that name the expander name
  the video page's Engagement section instead, with their diagnoses unchanged.
- The one new thing a deployer has to know: `dist/` now contains `video.html`, and a
  deploy that drops it breaks every library row's link (§12).

## 18. Deletion

Everything about making a video actually go away. v1 shipped a library **Remove**
that forgot the local entry and left the objects in the bucket forever, and the
README said so under "What this does not protect against". This section is the
other half, and once it exists that README bullet and the "Real deletion" entry
in Future work are both **wrong as written** and must be rewritten (§18.7) —
deletion is not future work any more.

Two actions, two names, and the names are the contract (§17.3):

- **Remove from list** — unchanged: `removeFromLibrary(id)` and a re-render. The
  objects stay in the bucket. This is still the right action for a video someone
  else owns, a link kept elsewhere, or a library that has grown noisy.
- **Delete video** — the objects go, then the entry goes.

The video page (§17.4) gets **no** delete control in this pass. The library is
the management surface; §17.4's reasoning for not building the mockup's `⋯` there
stands, and a video page opened from a link in another browser still has no
library entry to remove.

`view.html` and `player.css` are untouched by this section, as they were by §17
and by §3's thumbnail. §18.5 is a claim about the player's *existing* behaviour,
not a change to it.

### 18.1 What gets deleted, and in what order

For video `{id}`:

1. every analytics session object under `{id}/` in the **analytics bucket** —
   only in gateway mode with `ANALYTICS_BUCKET` set and `analytics: true`
   (§18.4). Legacy mode has no analytics and skips this entirely;
2. `{id}/meta.json`, then `{id}/thumb.bin`, then `{id}/video.bin`, in the
   **video bucket** (§18.3);
3. the `videoshare.library` entry, via `removeFromLibrary(id)` — which also
   revokes the row's cached thumbnail object URL, since §17.3 already revokes the
   URL of any id that has left `loadLibrary()` — and the video's cached
   `VideoReport` (§16.6), which must be dropped rather than left to answer for an
   id that no longer exists.

Both orderings are load-bearing.

**Analytics first**, because it is the step most likely to fail for a reason that
costs nothing. Its authorization is a Google ID token that may have expired since
the page loaded; failing there leaves the video, the entry and the watch data all
intact — a state the reader can retry from with one click and nothing lost. The
other order was considered and rejected: a video deleted first with its sessions
left behind strands ciphertext in a private bucket that no surface can reach
again, because the row that could have retried is the one thing that names the
id. The cost of this choice, stated rather than hidden: a delete that fails on
the video objects has already destroyed that video's watch data. That is the
correct trade — the reader asked for the video to be gone, and watch data is an
artifact of a video, not the other way round — but it is a real loss and §18.3's
error sentence must not pretend nothing happened.

**`meta.json` first** inside the video bucket, which is §7's write order exactly
reversed. Meta is the completion marker: a player fetches it before anything else
(§8), so from the instant it is gone every copy of the share link is already the
clean "video not found" of §18.5. A delete that fails halfway therefore leaves a
video that reads as **absent**, never as a torso that still looks complete and
then fails deeper in.

**404 is success on every one of the three.** S3's `DeleteObject` is idempotent
and most implementations answer `204` whether or not the object was there; the
ones that answer `404` mean the same thing. `thumb.bin` is optional (§3), so its
absence is the ordinary case rather than an error, and a delete retried after a
partial failure must not fail on the objects that already went. Any other
non-2xx status is a failure and surfaces (§18.3).

Nothing here touches an in-flight recording. A library entry exists only once
`finish()` has returned (§6), and an abandoned multipart upload has its own path
(§7's `abort()`), so there is no interaction between the two and no case where
deleting a video races its own upload.

### 18.2 Authorization, said plainly

**Gateway mode.** `POST /api/sign { op: "delete" }` and
`DELETE /sessions/{videoId}` are authenticated exactly like every other
authenticated route: a Google ID token verified per §15.4, then `ALLOWED_EMAILS`.
So: **anyone on `ALLOWED_EMAILS` can delete any video id they know.** That is the
uploader whitelist, not per-video ownership, and it is not built to be one — the
same property the session listing has had since §16.3, restated here rather than
left to be discovered. Ids are 128 random bits and reachable only through a share
link, which is a mitigation and not an access control.

**Legacy mode.** Whoever holds the bucket credentials in that browser can delete
whatever those credentials allow — the same sentence §1's threat model already
writes about writing, with one more verb in it.

**Neither mode authenticates a viewer**, and none could: a share link is a key,
not an identity. A recipient can never delete; a recipient can also never be
stopped from having already downloaded (§18.5).

### 18.3 The video bucket: three presigned DELETEs

The bytes never move through the gateway and neither does the authority to remove
them in one place: the gateway signs three URLs, the browser sends three DELETEs.
This is §15's invariant applied to a method that carries no payload, and it is
why there is no server-side video-bucket delete anywhere in `gateway/`.

`upload.ts` owns it, because `upload.ts` owns the `Signer` seam and the `send()`
that turns a signed request into a `fetch` with the right method, retries and
error messages:

```ts
/** §3's three objects, by the suffix the seam and the gateway's answer both use. */
export type VideoObjectName = "video.bin" | "meta.json" | "thumb.bin";
/** §18.1's order: meta first, video last. */
export const DELETE_ORDER: readonly VideoObjectName[];
/**
 * Deletes the three objects in `DELETE_ORDER`, sequentially. Resolves when all
 * three are gone (a 404 counting as gone); rejects with the first failure's
 * message, leaving whatever came after it untouched.
 */
export function deleteVideo(signer: Signer, id: string): Promise<void>;
```

- `SignOp` gains a **seventh** member: `{ kind: "delete"; id: string; object:
  VideoObjectName }`. `METHODS` maps `delete` to `"DELETE"`. The `object` field is
  a closed union of three suffixes, not a key: the signer still builds
  `{id}/{object}` itself, so §15.5's rule that a key never crosses the seam holds
  exactly as it does for `put-meta` and `put-thumb`.
- **`LocalSigner`** signs `{endpoint}/{bucket}/{id}/{object}` with `DELETE` —
  the same aws4fetch path `put-meta` takes, a different method. Nothing else about
  it changes.
- **`GatewaySigner`** asks once and caches three. A `delete` op whose URL is not
  held triggers one `POST /api/sign { op: "delete", id }`; the three entries of
  the answer are stored by `{id}\n{object}` with the same `usableUntil` arithmetic
  the part cache uses, and the two remaining DELETEs are then free. `forget(op)`
  drops the cached URL for that one object, so a retry re-signs rather than
  re-sending a signature the bucket has already refused — the rule parts already
  follow.
- **Sequential, in `DELETE_ORDER`.** The order is the point (§18.1); three
  parallel DELETEs would save a few hundred milliseconds and give up the
  guarantee.
- `deleteVideo` gets **no retry ladder**. The part queue's ladder exists because a
  recording is unrepeatable and a lost part loses it; a failed delete loses
  nothing, the entry stays, and the reader can press the button again with a
  better error in front of them. One attempt per object.

**The optional-IAM contract.** A deployment whose credentials lack
`s3:DeleteObject` (§14's second policy statement, or its equivalent) gets a `403`
on the first DELETE. That is a supported configuration and it must read like one:

- `LocalSigner.statusHint(403, "DELETE")` returns a **delete-specific** message,
  not the existing PutObject/AbortMultipartUpload one — it says the bucket refused
  the delete, that the upload credentials may not be allowed to delete, that
  `s3:DeleteObject` is optional, and it points at `docs/storage-setup.md`;
- `GatewaySigner.statusHint(403, "DELETE")` says the same about the gateway's
  bucket credentials and points at `docs/gateway-setup.md`;
- the row shows that sentence and **the entry stays** (§17.3). It is never
  silently downgraded to a Remove from list, and the menu does not quietly hide
  **Delete video** on such a deployment either: there is no way to know in advance
  which grants a bucket carries, and a disabled button that cannot explain itself
  is worse than a button with an honest failure behind it.
- R2 needs nothing: its `Object Read & Write` token is a whole-object grant that
  already includes deletion, which `docs/storage-setup.md` should say where it
  says the same about `AbortMultipartUpload`.

### 18.4 The analytics bucket: `DELETE {gatewayUrl}/sessions/{videoId}`

Server-side, and consistently so: the analytics bucket is already the gateway's
to list (§16.3), the browser has never held a credential for it, and the objects
under a prefix are not enumerable from a presigned URL. So the same split as
everywhere else — object bytes move only on presigned URLs, and the analytics
bucket's own bookkeeping is the gateway's.

**Request.** `DELETE {gatewayUrl}/sessions/{videoId}`, alias
`/beacon/{videoId}`, both mount points (`/api/…` and bare) as §16.3 defines them.
Authenticated exactly like the GET listing.

**Response, 200:** `{ "deleted": 12, "truncated": false }`.

**Statuses**, mirroring the listing case for case:

| condition | status |
| --- | --- |
| no/expired/invalid token | 401 |
| valid token, email not in `ALLOWED_EMAILS` | 403 |
| identity provider unreachable | 503 |
| `Origin` outside `ALLOWED_ORIGINS` | 403 |
| `videoId` not `^[A-Za-z0-9_-]{22}$` | 400 |
| `ANALYTICS_BUCKET` unset | 404 |
| `DELETE /sessions/{videoId}/{sessionId}` | 405 |
| the bucket refused the listing or a delete | 502 |
| success | 200 |

Preflight for the route now answers
`Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS`.

**Bounded per call, and the bound is a real constraint rather than a taste.** One
call walks at most `MAX_DELETE_LIST_PAGES` (4) `ListObjectsV2` pages collecting
at most `MAX_DELETED_SESSIONS` (40) keys that match `{videoId}/{22 base64url}.bin`
— §16.3's skip rule unchanged, since nothing else belongs under that prefix — and
issues one `DELETE` per key. That is at most 45 outbound requests, and the number
is chosen for the **Cloudflare Workers free plan's 50 subrequests per request**;
a call bounded at `MAX_LISTED_SESSIONS` (1000) instead would fail on the free plan
immediately and sit exactly at the paid plan's ceiling. Lambda and the Node
adapter have no such limit, and the bound applies to all three anyway so every
adapter behaves identically.

`truncated` is `true` when the pass stopped early — the 40-key cap was reached, or
the page cap was, with more listing left. Otherwise `false`, meaning the prefix is
empty of sessions.

**The client repeats while `truncated`**, and the loop is `dashboard.ts`'s
(§11):

```ts
export const MAX_DELETE_ROUNDS: number;      // 25 — 25 × 40 = MAX_LISTED_SESSIONS
export type DeleteRound = "done" | "again" | "stalled";
/** Pure, so the loop's stopping rule is testable without a gateway. */
export function nextDeleteRound(result: { deleted: number; truncated: boolean },
  round: number): DeleteRound;
/** Repeats §18.4 until done; resolves with the total deleted, rejects on failure. */
export function deleteSessions(video: { id: string }, deps: AnalyticsDeps): Promise<number>;
```

`nextDeleteRound` is `"done"` when `truncated` is false; `"again"` when
`truncated` is true, `deleted > 0` and `round < MAX_DELETE_ROUNDS`; and
`"stalled"` otherwise — which covers both ways a loop could fail to terminate. A
round that reports `truncated: true` with `deleted: 0` is a gateway that cannot
make progress (a prefix holding objects the skip rule refuses to touch is the way
to get there), and running out of rounds is a prefix larger than anything §16.3
was ever willing to *read*. Both surface as a failure on the row, and neither
spins.

`deleteSessions` is called only when the gateway answered `analytics: true`;
otherwise §18.1's step 1 does not exist and nothing is requested.

**Logging.** One line per call, in the shape §16.3's listing already logs:
video id, the verified email, and the count deleted. No session id — the count is
what an operator needs and a session id is a viewer-minted label — and, as
everywhere on this path, no IP-bearing header is read (§16.4's rule is unchanged
and applies here).

**The overwrite-collapse model is untouched.** Deletion removes objects; it never
reads one, never merges and never rewrites. A beacon that arrives after a delete
simply writes a new session object under an id whose video is gone, which is junk
the reader would count and skip (§16.6) if any reader ever asked again — and none
will, because the entry is gone. That is a leak of storage, not of data, and it is
bounded by the video's own life: a share link whose objects are deleted plays
nothing, so nothing accumulates watch time to report.

### 18.5 What a deleted video looks like from a share link

**Every copy of the link dies, cleanly**, and this is the honest answer to the
README's "Anyone with the link can watch, forever": forever ends when the objects
do. `player.ts` fetches `{id}/meta.json` first (§8), and `playback.ts`'s reader
already answers a 404 or 403 with `PlaybackError("Video not found", …)`, whose
detail sentence already names deletion as one of the two causes. **That path is
correct as it stands and is not changed by this section** — it was checked
against this case rather than assumed to fit, which is the only reason §18 can
say `view.html` is untouched.

What deletion does not do, and the README must keep saying so in the same
paragraph: it does not reach a copy already downloaded, a screen already
recorded, or a cache already warm. It removes the objects; it does not un-share.

### 18.6 Tests

Every existing test keeps passing; §18 adds cases and deletes none (§13).

- `tests/gateway.test.ts` gains a **`delete` sign-op suite**, written in the style
  of the `put-thumb` one: no token → 401; a valid token that is not whitelisted →
  403; an `id` that is not 22 base64url characters → 400, in each of the ways it
  can fail (absent, wrong length, a `/`, a `.`); the happy path returning three
  entries whose `key`s are exactly `meta.json`, `thumb.bin` and `video.bin` in
  §18.1's order, each a presigned URL with the `X-Amz-*` shape and the same
  `X-Amz-Expires` every other op carries, each path exactly
  `/{bucket}/{id}/{key}`, and `method: "DELETE"` at the top level; and the
  key-construction check the suite already makes elsewhere — an `objectKey`, a
  `key`, or any other stray field in the body changes nothing about what comes
  back.
- `tests/gateway.test.ts` gains a **`DELETE /sessions/{videoId}` suite**: no token
  → 401; non-whitelisted → 403; malformed id → 400; `ANALYTICS_BUCKET` unset →
  404; a `sessionId` in the path → 405; the happy path against a stub bucket
  issuing exactly one DELETE per matching key and answering
  `{ deleted, truncated: false }`; a prefix of more than `MAX_DELETED_SESSIONS`
  keys answering `truncated: true` with exactly `MAX_DELETED_SESSIONS` deleted and
  **no more than `MAX_DELETE_LIST_PAGES` listings issued** — the subrequest bound
  is the reason the constant exists, so it is asserted rather than described;
  non-matching keys under the prefix skipped and not deleted; a bucket that
  refuses the listing → 502 and a bucket that refuses a delete → 502; the preflight
  advertising `GET, POST, DELETE, OPTIONS`; and the log line carrying the id, the
  email and the count and **no session id**.
- Client pure logic, in the suites that already own the module:
  `nextDeleteRound` over its whole matrix — `truncated: false` → `"done"`;
  `truncated: true` with `deleted > 0` under the round cap → `"again"`;
  `truncated: true` with `deleted: 0` → `"stalled"`; the last permitted round →
  `"again"`, the one after → `"stalled"` — so the two ways a loop could fail to
  terminate are pinned by a test and not by a comment. `DELETE_ORDER` asserted to
  be `meta.json`, `thumb.bin`, `video.bin`, because §18.1's guarantee is that
  order and nothing else enforces it.
- `tests/e2e.gateway.test.ts` gains a **full delete round trip** against MinIO:
  upload a small video through the existing harness, confirm all three objects
  read anonymously, ask the running Node adapter for the `delete` URLs with a real
  minted JWT, send the three DELETEs straight to MinIO, then assert an anonymous
  GET of each of the three is 404 — the same browser↔bucket path a real delete
  takes, with the gateway having carried no byte of it. Then, with
  `ANALYTICS_BUCKET` set: POST two beacons, `DELETE /sessions/{id}`, assert
  `{ deleted: 2, truncated: false }` and that a following `GET /sessions/{id}`
  lists nothing.
- `tests/e2e.minio.test.ts` gains the **legacy** half of the same round trip:
  upload via `createUploadSession`, delete via `deleteVideo` with a `LocalSigner`
  built from the write-only uploader credentials, assert all three objects are
  404 and that a second `deleteVideo` of the same id **succeeds** (idempotence —
  §18.1's 404-is-success rule is what makes a retry safe, so it is a test).
  A delete attempted with credentials that lack `s3:DeleteObject` must produce a
  403 that carries the delete-specific hint, which is the optional-IAM contract
  §18.3 states; the fixture for it is a policy without the second statement.
- Not tested in Node, for the reasons §13 already gives: the menu, its confirm
  step, the busy row and the error sentence. What is worth testing there is the
  stopping rule and the order, both of which are pure and both of which are above.

### 18.7 Docs, examples and terraform

- **`README.md`**, two edits, both in the plain register the file was rewritten
  to and neither a feature announcement:
  - the **"Anyone with the link can watch, forever"** bullet keeps its first
    sentences and loses the claim that "deleting a video from the recorder's
    library removes the local entry only". It says instead that the library has
    two actions — Remove from list, which forgets the entry, and Delete video,
    which removes the objects so every copy of the link stops working — and that
    neither reaches a copy someone already downloaded;
  - the **Future work "Real deletion"** entry is removed, because it exists now.
    In its place, in the security model, the sentence §18.2 owes a reader:
    anyone in `ALLOWED_EMAILS` can delete any video id they know, the same way
    anyone in it can list any video's sessions — not per-video ownership, and not
    built to be.
- **`docs/storage-setup.md`**: where the uploader policy is explained (the R2
  token, the AWS IAM user, the MinIO policy), `s3:DeleteObject` and what it buys.
  Optional, stated as optional, with the consequence named: without it the app
  works exactly as it does today and **Delete video** answers with the 403 message
  §18.3 pins. The AWS walkthrough's sentence that the uploader can do "no deleting
  a stored object" is now wrong for the shipped policy and must be corrected
  rather than left standing. R2's note that its whole-object grant already covers
  the multipart calls gains deletion to the same list.
- **`docs/gateway-setup.md`**: the env table's `BUCKET_ACCESS_KEY_ID` row no
  longer says "and nothing more" — it needs `s3:DeleteObject` on the video bucket
  for §18.3's presigned DELETEs and on the analytics bucket for §18.4's
  server-side ones. A `DELETE /sessions/{videoId}` row in the endpoint reference,
  with its statuses. A troubleshooting row for a 403 on a delete (the grant) and
  one for a 502 from `DELETE /sessions/…` (the analytics grant, which is the one
  people leave out — a presigned-URL grant and a delete grant are both invisible
  until exercised).
- **`examples/iam-uploader-policy.json`**: the second statement (§14), Sid
  `VideoShareOptionalDelete`.
- **`examples/docker-compose.yml`**: the `mc` init job applies the same file, so
  the local uploader can delete and the e2e suite has something to run against.
  The comment there says which statement to drop to get the old behaviour back.
- **Terraform.** `examples/s3-cors.json` and all three modules already allow
  `DELETE` on the video bucket for the multipart abort, so **no CORS change is
  needed anywhere** — verified rather than assumed, and the comments that explain
  the rule as "DELETE to abort" should now say what else it carries. What does
  change:
  - **aws/**: the gateway IAM user's policy gains `s3:DeleteObject` on
    `${videos.arn}/*` **and**, when analytics is enabled, on
    `${analytics.arn}/*`. Both are needed and only the first is obvious: the
    video-bucket grant is what the presigned DELETEs are signed under, the
    analytics-bucket grant is what §18.4 spends itself. The comment above the
    policy document is a list of exactly what is granted and why, and it gains two
    lines rather than losing its shape;
  - **gcp/**: the module as it stands grants `roles/storage.objectCreator` on the
    videos bucket and `objectCreator` + `objectViewer` on the analytics bucket —
    **neither carries `storage.objects.delete`**, so gateway-mode deletion would
    403 on GCS as written. It needs `storage.objects.delete` on both buckets and
    nothing else. Every predefined role that carries it (`objectUser`,
    `objectAdmin`) also carries `storage.objects.get` and `.list`, which the
    videos-bucket grant deliberately withholds — the comment there argues at
    length that a leaked key can write and abandon uploads "and do nothing else",
    and that argument is worth keeping. So the honest minimum on the videos bucket
    is a **custom role** of `storage.objects.create`, `storage.objects.delete` and
    the three `storage.multipartUploads.*` permissions; whatever the module does
    instead, the comment must describe what the credential can actually do
    afterwards;
  - **cloudflare/**: nothing. R2's `Object Read & Write` is a whole-object grant
    that already includes deletion, and the module's CORS already lists `DELETE`.
- The one thing a deployer of an **existing** installation has to know: nothing
  breaks if they change none of it. Delete video appears, and on a deployment
  whose credentials cannot delete it fails with a sentence that says so.

## 19. Uploading an existing video (`#/upload`)

A video that already exists as a file — a recording repaired offline, an export
from another tool, a screen capture made somewhere this app was not — gets the
same link, the same library row and the same objects a recording gets. Nothing
downstream can tell the difference: the bytes go through §7's session, §3's
three objects are written in §7's order, and `view.html` is untouched.

What the recorder makes, it knows everything about. An imported file is the
other way round: the bytes arrive first, and two things have to be learned from
them — §5's `mimeType`, which is the one string the player hands to MSE (§8),
and whether MSE can be fed the file at all. Both come from the container's own
head, never from the whole file, and never from the file's name or the
browser's `File.type`, neither of which says what is inside.

### 19.1 The view

`#/upload` (§17.2), a fourth nav item and a ghost **Upload video** button in the
library header beside **New recording**, both plain navigations. Five stages in
the recorder's footprint and classes:

- **pick** — a drop zone wrapping a visually hidden `<input type="file">`, so a
  click anywhere in it opens the picker and the input's own focus ring is what
  keyboard users see. Drag-and-drop lands in the same place. Nothing is uploaded
  here: choosing a file commits nothing, and the reader is told so.
- **checking** — the sniffer reads the head (§19.2) and a hidden element
  confirms **this** browser can play the file and reports its duration and
  frame size. A file that fails either goes back to **pick** with one sentence
  saying why: "not a WebM or MP4 this app can describe to a player", "no video
  track", or "this browser cannot play this file, so viewers will not be able
  to either". A browser that cannot play a file is the wrong place to upload it
  from, and the reader hears that before a byte moves.
- **ready** — a preview `<video>` of the file, a meta line (duration · size ·
  frame size · the mime type that will be written), a title prefilled from the
  file name without its extension, **Upload** and **Choose another**. When the
  file will play but not stream (§19.3) one further sentence says so, and what
  to do about it, in words that name the ffmpeg flag.
- **uploading** — §7's progress bar. Authorization is asked for at **Upload**,
  not at pick: `demandSettings` / `demandSignIn` (§17.2) with sentences of their
  own ("Sign in with Google before uploading." — the recorder's "the upload
  starts as you record" would be false here). A failure shows the recovery
  block: **Retry**, which resumes (§19.4), and **Cancel upload**, which aborts
  the multipart upload best-effort and returns to **pick**. There is no
  "Download recording" link because the file never left the disk.
- **done** — the share link, auto-copied, with **Upload another**.

§6's two rules bind this view to the router as they bind the recorder: a
transition into **ready**, **uploading** or **done** shows the view, and routing
away never stops an upload — the **Upload video** nav item carries the same
live indicator the recording item does while one is in flight, and
`beforeunload` asks while a stage is **uploading**.

### 19.2 Sniffing (`src/import.ts`, pure)

`sniffContainer(source: ByteSource): Promise<ContainerInfo | null>` reads the
first `SNIFF_HEAD_BYTES` (1 MiB) and decides by the first bytes: the EBML
magic is a WebM or Matroska file, an `ftyp` box is ISO BMFF, anything else is
`null` — "cannot describe", which is not the same as "cannot play", and the
view refuses it because a `meta.mimeType` that names nothing would leave every
player guessing.

- **WebM.** The `EBML` header's `DocType` picks `video/webm` or, for
  `matroska`, `video/x-matroska` (honest, and one `isTypeSupported` says no
  to, so §8's whole-file path plays it — which Chrome does). Then the
  `Segment`'s children, in order, until `Tracks` or the first `Cluster`; a
  `Segment` of unknown size — every MediaRecorder and webm-muxer recording — is
  walked to the end of the window. `Tracks` that straddles the window is
  fetched once more at exactly its declared size, bounded by
  `MAX_TRACKS_BYTES` (1 MiB). Each `TrackEntry` contributes one codec by
  `TrackType` and `CodecID`: `vp8`, `vp9`, `opus`, `vorbis` in the short
  spelling MediaRecorder itself writes, `av01.P.LLT.DD` spelled out from
  `CodecPrivate`'s `av1C` (a short `av1` is not universally recognised; without
  an `av1C`, a plausible level rather than nothing, since the level only
  changes `isTypeSupported`'s answer and never the decode), `avc1.PPCCLL` /
  `hvc1.…` from an `avcC`/`hvcC` for an H.264/HEVC Matroska. An id outside the
  table becomes its own last segment, lowercased, for the browser to refuse; a
  miss only costs the streaming path. `progressive` is always `true`.
- **MP4.** Top-level boxes are walked by size from offset 0 — `ftyp`, `free`,
  a monolithic `mdat` of any size, 64-bit `largesize` headers included — until
  `moov`, which is read at exactly its size (`MAX_MOOV_BYTES`, 32 MiB) from the
  window when it is there and by one seek when it is not. A `moov` is walked
  `trak` → `mdia` → `hdlr` (only `vide` and `soun` count) → `minf` → `stbl` →
  `stsd` → the first sample entry, whose type and configuration box give the
  codec: `avc1`/`avc3` + `avcC` → `avc1.PPCCLL`; `hvc1`/`hev1` + `hvcC` →
  ISO/IEC 14496-15 Annex E; `av01` + `av1C`; `vp09`/`vp08` + `vpcC`; `mp4a` +
  `esds` → `mp4a.{OTI}.{AOT}` (AAC-LC assumed without one), across all three
  sample-entry versions; `Opus`, `fLaC`, `ac-3`, `ec-3`, `.mp3` by name.
  `progressive` is `true` iff `moov` carries `mvex` — a fragmented file, whose
  samples are in `moof`/`mdat` pairs — because MSE's ISO BMFF byte stream
  format has no place for a monolithic `mdat` indexed by a `moov` at the far
  end of the file, and Chrome accepts such a `moov` and then errors on the
  `mdat`, after the point where §8's fallback can still run. Two sample entries
  in one `stsd` are read as the first.

`mimeType` is `{type};codecs={video…,audio…}`, unquoted, exactly as the engines
write theirs (§6).

### 19.3 What is written

§5's metadata with `chunkSize = CHUNK_SIZE`, `chunkCount = ceil(size /
CHUNK_SIZE)`, `totalBytes = size`, `durationMs` from the element probe (the
`Infinity` seek of §6 applied, so an app-made WebM with no duration header
reports the truth), and `progressive: false` written **only** when the sniffer
said so — the metadata of a WebM or a fragmented MP4 is byte-for-byte what a
recording writes. §3's thumbnail is one frame of the file — a second in, or
halfway through a shorter file, with §6's blank-frame retry at a later offset
— scaled and encoded by §6's rules, encrypted under `thumbAad(id)` before the
first part goes up, and handed to `finish()` as always. A frame that cannot be
had is silently no thumbnail.

The player's change is one line: `progressive === false` skips the MSE path
without asking `isTypeSupported` (§8). Such a file still plays; it downloads
whole first, which the **ready** stage told the uploader.

### 19.4 Uploading (`src/import.ts`)

```ts
export function planImport(size: number, details: ImportDetails): VideoMeta;  // throws on an empty file
export function createImportJob(file: Blob, meta: VideoMeta, thumb: Uint8Array | null): ImportJob;
export function runImport(session: UploadSession, job: ImportJob): Promise<UploadResult>;
```

`runImport` slices the file one `CHUNK_SIZE` at a time — `file.slice(…).arrayBuffer()`,
so one chunk of plaintext is in memory at once, however large the file — and
hands each full chunk to `addChunk` and the final one to `finish`, in §7's
order. `job.nextChunk` advances as chunks are handed over, and `finish()` is
already safe to call twice (§7), so **Retry** is simply `runImport` again with
the same job: nothing already sent is sent again, and the parts §7 remembered
as failed are re-sent by `finish()` as they are for a recording. The session
is §7's, unchanged, created with the same signer the recorder would use in
this mode; the gateway needs no new op, no new limit and no new config.

### 19.5 What this does not do

- **No transcoding, no remuxing.** A file is uploaded as it is. Converting a
  non-fragmented MP4 into one that streams, or an AVI into anything, is a job
  for ffmpeg, and the **ready** stage says the words to type.
- **No file the browser cannot play.** The probe is the gate, on purpose: the
  viewers' browsers are, statistically, this one.
- **No new dependency, no new endpoint, no new bucket permission.** §7's CORS,
  IAM and lifecycle notes are the complete list for this feature too.
