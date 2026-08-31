# VideoShare

Self-hosted screen recording and sharing.

- **End-to-end encrypted video.** Recordings are captured, encoded, and
  encrypted in the browser, and uploaded to your own S3-compatible bucket while
  you record. The AES key lives in the share link's `#fragment`, which browsers
  never send over the network — the bucket and every server in the path hold
  only ciphertext.
- **End-to-end encrypted analytics** (optional). Views, unique viewers,
  completion, and per-viewer replay heatmaps. Each report is encrypted in the
  viewer's tab with the video's own key before it is sent; no IP address is
  read or stored on any analytics path.
- **Serverless hosting, no database.** The site is static files; storage is one
  or two buckets. The optional gateway — for Google sign-in and analytics — is
  a stateless function (Cloudflare Worker, Lambda, or a Node process) that
  verifies tokens and presigns URLs; it keeps no data of its own.

```
https://videoshare.example.com/view.html#8Kq2vTnR1sYbLm3wXpQdEg.b0Zx…
                                         └── video id ──┘ └─ AES key ─┘
                                                              never sent anywhere
```

## How it works

The site is three static pages:

- **`index.html`** — the app you use: a sidebar and three views behind one hash
  route. **Videos** is the library — one row per recording this browser made,
  with its date, duration, size, a Copy link button, an overflow menu that can
  forget a row or delete the video outright, and, with a gateway and analytics
  on, how many times it was watched. **New recording** is the recorder:
  it captures screen + mic, encodes with WebCodecs — on the machine's hardware
  H.264 encoder where there is one, in software otherwise — encrypts with
  WebCrypto, and sends the ciphertext to your bucket *while you are still
  recording*: every 8 MiB goes up as one part of a SigV4-signed S3 multipart
  upload, so stopping only leaves the tail to flush before the link is ready. One chunk is encrypted at a time, so an hour-long
  recording costs no more memory than a one-minute one. Beside the video and its
  metadata, a recording writes one optional third object: a thumbnail — a single
  frame from its first seconds, ~15–50 KB, encrypted under the same link key, and
  absent from anything recorded before it existed. **Settings** holds the
  bucket credentials and the encoder choices. All of it — settings and the
  library of your links — lives in `localStorage`, and a recording keeps
  uploading whichever view you are looking at.
- **`video.html`** — your page for one video. Same link format as a share link
  (`#{id}.{key}`), so it plays the same bytes the same way, with everything the
  watch data says about it underneath: views, unique viewers, completion rate,
  average watch time, a replay heatmap and a row per viewer. Nobody else is sent
  this URL; it is what a library row opens.
- **`view.html`** — the player, and the only page a recipient sees. Holds no
  credentials at all. Reads the id and key from the URL fragment, fetches
  ciphertext from the bucket's public URL, decrypts it, and plays — streaming
  through Media Source Extensions where the browser supports it, whole-file
  otherwise.

The output is a `dist/` folder of static files. Host it on GitHub Pages,
Cloudflare Pages, S3, or a Raspberry Pi. Anything that speaks the S3 API can be
the bucket: Cloudflare R2, AWS S3, MinIO, Backblaze B2, Wasabi.

TypeScript, no frameworks, three runtime dependencies: `aws4fetch` for request
signing, and `webm-muxer` and `mp4-muxer` for assembling the two containers.

## Quickstart

Five minutes to a working stack on your laptop: MinIO as the bucket, nginx
serving the site. You need Node 20+ and Docker.

```sh
git clone https://github.com/cmwright/videoshare
cd videoshare
npm install
npm run build
docker compose -f examples/docker-compose.yml up -d
```

Open **http://localhost:8080**, go to **Settings**, and fill in the storage form:

| Field | Value |
| --- | --- |
| Endpoint | `http://localhost:9000` |
| Region | `us-east-1` |
| Bucket | `videoshare` |
| Access key ID | `videoshare-uploader` |
| Secret access key | `videoshare-uploader-secret` |
| Public base URL | `http://localhost:9000/videoshare` |

(The compose stack prints these too — `docker compose -f examples/docker-compose.yml logs minio-init`.)

Record something. The upload runs while you record, so stopping and hitting
**Finish** hands you the share link almost at once, already copied to your
clipboard. Open it in a different browser: it plays with no credentials and no
login, and the bucket only ever served ciphertext.

The MinIO console is at **http://localhost:9001** (`minioadmin` / `minioadmin`)
if you want to watch the objects appear.

```sh
docker compose -f examples/docker-compose.yml down -v   # -v also deletes the videos
```

The compose bucket is deliberately configured the way a real one should be:
anonymous `GetObject` and nothing else — no listing — upload credentials that can
only write objects and abandon their own unfinished uploads, and a sweep that
clears out multipart uploads a closed tab left behind.
`examples/docker-compose.yml` is commented if you want to see exactly what was
applied, and why MinIO needs a different mechanism for that last one than S3
does.

## Deploying

Two things move: the bucket, and where the static site lives.

1. **Set up a bucket.** [`docs/storage-setup.md`](docs/storage-setup.md) has
   copy-pasteable walkthroughs for **Cloudflare R2** (recommended — egress,
   the dominant cost of serving video, is free there), **AWS S3**, and
   **self-hosted MinIO**, including a VPN-only variant. The policy and CORS
   documents it applies are in `examples/`.
2. **Edit one line.** `public/config.js` holds the URL where your bucket is
   publicly readable:

   ```js
   window.VIDEOSHARE = { publicBaseUrl: "https://pub-xxxx.r2.dev" };
   ```

   This is the value the *player* uses, so it has to be correct before you
   deploy. It is copied verbatim into `dist/`, so you can also edit it in a built
   site without rebuilding.
3. **Publish `dist/`** — all of it, anywhere static. It is three pages
   (`index.html`, `video.html`, `view.html`) plus assets; a deploy that drops
   `video.html` still records and still plays shared links, but every row in
   **Videos** then opens a 404. Share links are
   `{wherever you published}/view.html#{id}.{key}`, so the site needs a stable
   home — a moved site breaks every link you have already sent.

[`examples/terraform/`](examples/terraform) has standalone Terraform
configurations that build all of that — buckets, policies, CORS, lifecycle and
the optional gateway — on AWS, Google Cloud or Cloudflare.

### If the site is not at the domain root

`npm run build` emits relative asset paths (`vite.config.ts` sets `base: "./"`),
so the same `dist/` works at the domain root, under a subpath (e.g. a GitHub
Pages **project** site at `https://<user>.github.io/<repo>/`), or served straight
from the bucket — no extra flags needed.

Serve the site over HTTPS in production. If the site is HTTPS the bucket must be
too; browsers block plain-HTTP subresources on a secure page.

## Security model

**The bucket only ever holds ciphertext.** Every object is AES-GCM (256-bit,
random 96-bit IV, 128-bit tag) with additional authenticated data binding each
block to its video id and its position, so a chunk cannot be swapped, reordered,
or moved between videos without the decrypt failing loudly.

**The key never reaches a server.** It is generated in the recorder's browser and
written into the share link after the `#`. Browsers do not send fragments in
HTTP requests, and do not include them in `Referer`. Your bucket, your CDN, and
whoever hosts the static site all see the video id and never the key.

**Upload credentials are scoped to `PutObject` and `AbortMultipartUpload`**, plus
an optional `DeleteObject`. Stolen, they let someone write junk into your bucket
and cancel an upload that is still in flight. They do not let them read, list, or
reach anything else in the account. The bucket has no anonymous `ListBucket`, so
video ids — 128 random bits each — cannot be enumerated.

The third grant is what the library's **Delete video** spends, and it is
`examples/iam-uploader-policy.json`'s second statement so that dropping it is one
edit: without it nothing else changes and Delete video answers with a message
saying the bucket refused it. With it, a stolen key can delete recordings as well
as write junk. Pick whichever of those you would rather live with —
[`docs/storage-setup.md`](docs/storage-setup.md) explains it per provider (on R2
the choice does not exist: its narrowest token already includes deletion).

### Optional: getting the credentials out of the browser

To keep upload credentials out of browsers entirely — or to let several people
record without handing the same keys to each of them — there is an optional
**gateway**: a small stateless service that holds the bucket
credentials, verifies a Google sign-in against an email whitelist you control,
and answers with **presigned URLs**. The browser then uploads to those URLs
directly. The gateway signs; it never carries a byte of video, by design and by
test, so it stays cheap and small no matter how much you record.

Turning it on is one line in `public/config.js`. Settings drops its storage form
and the sidebar grows an account chip that asks you to sign in instead, keeping
the **Recording options** block for the quality, codec and fallback-bitrate
choices — those are yours, not the bucket's. Everything else — browser-side encryption, the key in
the fragment, existing share links — is untouched, and the player stays
anonymous: it holds no credentials and never asks a viewer to sign in. Exactly
one thing does change for viewers, it is off unless you switch it on, and it is
the analytics below. It runs as a Cloudflare Worker, a Lambda function URL, or a Node
process next to your bucket. [`docs/gateway-setup.md`](docs/gateway-setup.md) has
the walkthrough, and `examples/docker-compose.yml` has it wired to the local
stack behind a `--profile gateway` flag.

Without that line you are in the default mode described above: no server, no
sign-in, credentials in your own browser.

**Who may delete, said plainly:** anyone in `ALLOWED_EMAILS` can delete any video
id they know, the same way anyone in it can list any video's sessions. That is
the uploader whitelist doing what it already does — not per-video ownership, and
not built to be one. Ids are 128 random bits and only reachable through a share
link, which is a mitigation and not an access control. In the default mode the
same sentence has one less clause: whoever holds the bucket credentials in that
browser can delete whatever those credentials allow.

### Optional: knowing what got watched

A gateway can also collect **playback analytics**, and this is the one feature
that changes what `view.html` does. Point the gateway's `ANALYTICS_BUCKET` at a
second, **private** bucket and the player starts reporting: every 30 seconds
while a video plays, on pause, and once more when the tab goes away, it sends what
has been watched so far to the gateway, which writes it to that bucket. There is no
stats page: watch data lives with the video it is about. Signed in, each row in
**Videos** carries its two headline numbers ("38 views · 12 viewers"), and
opening a row reads the rest back on that video's own page — completion rate,
average watch time, a **replay heatmap** of which 2% of the video got watched
twice and which got skipped, and the same heatmap per viewer.

The heatmap is time actually spent, not coverage: a section played through twice
reads about 2×, and scrubbing across the video adds nothing at all. Videos
recorded before this existed report what they knew — which parts were watched at
least once — and are never shown as hotter than that.

Every one of those reports is encrypted in the viewer's tab first, with **the
same AES key that is in the share link** — the key no server ever sees. So the
operator of the gateway and the analytics bucket learns that *some* browser
watched video `{id}`, roughly when (the object's timestamp, refreshed by each
report), how many sessions exist for that id, and how many ciphertext bytes each
one is. They do not learn which parts were watched, how much, whether it
finished, or anything about the viewer — no account, no cookie, no fingerprint
and no IP address, because none is read or logged on any analytics path.

Three consequences of the design, before you switch it on:

- **Watch data is readable by exactly the holders of the share link.** Sharing
  the link shares the analytics. There is no second key and no separate audience.
- **The player writes one `localStorage` key on the viewer's machine** —
  `videoshare.viewer`, a single random 128-bit label, so repeat viewings from one
  browser collapse into one "viewer". It is minted only when a report is actually
  going to be sent, it travels inside the ciphertext, and it identifies nothing
  but itself.
- **Listing sessions uses the *uploader* whitelist.** Anyone in `ALLOWED_EMAILS`
  can list the sessions for any video id they know. Ids are 128 random bits and
  only reachable through a share link, but this is not per-video ownership and is
  not built to be.

Leaving `ANALYTICS_BUCKET` unset is a supported configuration, not a broken one,
and it is the default: `view.html` then makes no request to the gateway beyond
reading its config, sends nothing, and writes no key at all.
[`docs/gateway-setup.md`](docs/gateway-setup.md) §6 has the walkthrough.

### What this does *not* protect against

Read this list before recording anything sensitive.

- **Anyone with the link can watch, forever.** The link *is* the credential.
  There is no revocation, no expiry, no per-viewer access, and no way to tell who
  watched — the optional analytics above tell you *that* a link was watched and
  how much of it, never by whom. Forwarded link, forwarded video. Forever ends
  only when the objects do: the library's `⋯` menu has two actions and the names
  are the difference — **Remove from list** forgets the local entry and leaves
  the video in the bucket, while **Delete video** removes the objects, after
  which every copy of the link plays nothing. Neither reaches a copy someone
  already downloaded, a screen they already recorded, or a cache that is already
  warm. Deleting removes the objects; it does not un-share.
- **The link leaks wherever you paste it.** Chat history, browser history,
  screenshots of a chat, someone's clipboard manager. A key in a URL is
  convenient exactly because it travels, which is also the problem.
- **Metadata is public.** Anyone who can reach the bucket and guess or obtain an
  id sees object sizes and upload timestamps; whoever runs the bucket or CDN sees
  every request. Sizes and timing leak roughly how long a recording is and when
  you made it. Only the contents are encrypted.
- **The recorder's `localStorage` is a soft target.** It holds your S3
  credentials in plaintext *and* your library of share links, keys included.
  Anyone with your browser profile, or any XSS on the site's origin, gets both.
  Don't run the recorder on a shared machine, and don't host it on an origin
  where other people can publish JavaScript.
- **You are trusting whoever serves the site.** They could ship JavaScript that
  reads the fragment and phones the key home. This is true of every
  browser-encryption product; the mitigation is that the site is a few hundred
  lines of static files you can read, build, and host yourself.
- **No authorship guarantee.** Anyone holding the upload credentials can write a
  well-formed video under any id. Nothing signs "who recorded this".
- **Recording captures what you show it.** The most common leak here is a
  notification popping up mid-take, not cryptography.

## Recording quality and file size

Screen recordings compress extraordinarily well — a slide, an IDE, a terminal is
a still image with a cursor moving over it — but only if you encode for a
quality target instead of a bitrate. A fixed bitrate spends the same bits on a
motionless slide as on a scrolling diff, so you pick between a bloated file and
mush the moment anything moves. VideoShare aims at the quality and lets the size
fall where it may.

Where the browser has WebCodecs (Chrome and Edge today) the recorder drives
`VideoEncoder` directly, in **constant-quality mode**: it is handed a quantizer,
not a bitrate, and spends whatever that quality costs. A minute of a static
slide costs almost nothing. A minute of scrolling code costs real bytes. (Some
hardware H.264 encoders refuse per-frame quantizers; those get a bitrate scaled
to the frame size instead, which is the one path where the size is fixed and the
quality moves.)

Typical VP9 screencasts land in the low **single-digit megabytes per minute**,
and stretches where nothing moves cost close to nothing; H.264 runs two to three
times that. Treat it as the usual shape rather than a promise — full-screen
video, an animated wallpaper, or a lot of fast scrolling all cost considerably
more.

### Which codec

Capture runs at your display's **native physical resolution**, up to 4K, because
a Retina screen captured at half density renders text soft in a way no encoder
setting can recover. That is four times the pixels of a 1080p capture, and it is
more than a software encoder can keep up with: VP9 drops frames on an ordinary
laptop at that size even at 20 fps, and a dropped frame is a hole in the
timeline rather than a stutter. Meanwhile almost every machine built in the last
decade has a dedicated H.264 encoder sitting idle next to the GPU, which does 4K
for free.

So the codec is a setting, and the trade is real in both directions:

| Codec | What you get |
| --- | --- |
| **Auto** (default) | Hardware H.264 if this machine has one, VP9 if it does not. |
| **H.264** | Encoded on the GPU, so it holds frame rate at 4K no matter what else the machine is doing, and the result plays in **everything** — Safari, iPhones, QuickTime, a video tag someone pasted into a wiki. Files run roughly **2–3× larger** than VP9 at a comparable quality. Fragmented MP4. |
| **VP9** | The smallest files that still play widely; encoded in software, with no hardware assistance. Comfortable at 1080p, drops frames on a big display. WebM. |
| **AV1** | Smaller again, slower again. Safari decodes it only on hardware that can — M3-class Apple silicon and newer — with no software fallback, so pick it when you know who is watching. WebM. |

Pick a codec this browser cannot encode and the recorder walks down the same
chain and tells you which one it used instead. Nothing fails, and nothing is
recorded in a format you were not told about.

**Changing the setting only affects new recordings.** Each video carries its own
container and codec in its encrypted metadata and the player reads that rather
than assuming, so a WebM you recorded last month and an MP4 you record today
both play from the links you already sent. Switching back and forth costs
nothing.

### The settings

| Setting | Effect |
| --- | --- |
| **Recording quality** — smaller / standard / sharper | The quantizer the encoder aims at. `Standard` is picked to keep small text crisp; `Sharper` for dense code or fine diagrams; `Smaller` when the link matters more than the pixels. |
| **Video codec** — auto / H.264 / VP9 / AV1 | The table above. Chrome and Edge only. |
| **Fallback bitrate** | The fallback engine only, default 2.5 Mbps. Ignored on the WebCodecs path. |

Capture asks for native resolution up to **4K at 30 fps**, dropping to 20 fps
above 1440p — on a screencast, detail is worth more than smoothness, and above
that size you do not get both. The video track is marked as screen content
(`contentHint = "text"`, which tells the encoder to hold sharp edges rather than
smooth them). Mic and system audio are mixed down to one mono track: Opus at
48 kbps in WebM, AAC in MP4 where the browser can encode AAC and Opus-in-MP4
where it cannot. Either way it is a rounding error next to the video.

Firefox, and anything else without WebCodecs, falls back to `MediaRecorder` at a
flat **2.5 Mbps** of video (and 64 kbps of audio) — VP9 if the browser offers
it, VP8 otherwise. That is a bitrate cap rather than a quality target, so the
files are more uniform in size and less responsive to what is actually on
screen. **Recording quality** and **Video codec** do nothing here — the format
is the browser's to choose — and **Fallback bitrate** is the only knob.

Every row of the local library shows what the recording cost — `14.2 MB ·
1.9 Mbps` — so the effect of a setting is something you can read rather than
guess at.

## Browser support

| Browser | Record | Watch |
| --- | --- | --- |
| Chrome / Edge (desktop) | Yes — WebCodecs: hardware H.264, or software VP9 / AV1 | Yes — every format, streaming via MSE |
| Firefox (desktop) | Yes — `MediaRecorder` at 2.5 Mbps | Yes — every format, streaming via MSE |
| Safari 18.4+ (macOS) | Yes — `MediaRecorder` (WebM) at 2.5 Mbps | H.264 MP4 streams via MSE; WebM downloads in full first |
| Mobile browsers | No | Best-effort, on the whole-file path |

**Recording is desktop-only.** It needs `getDisplayMedia`, which mobile browsers
do not offer. Safari can capture a screen, and since 16.4 it can encode video
through WebCodecs — but the WebCodecs engine needs `VideoEncoder`,
`AudioEncoder` and `MediaStreamTrackProcessor` together, and Safari has no
`MediaStreamTrackProcessor` to pull raw frames off a capture track. That leaves
the `MediaRecorder` fallback: since Safari 18.4 its recorder produces WebM
(VP8/VP9 + Opus), so Safari records there like Firefox does; the MP4 path
belongs to the WebCodecs engine, which Safari cannot reach.

**Watching depends on what you recorded.** Chrome, Edge and Firefox play all
three codecs and stream them progressively: the player fetches, decrypts and
appends chunk by chunk, and starts playing after the first 8 MiB. Safari is the
one that cares which you picked:

- **H.264 in MP4** plays there natively, and macOS Safari's `MediaSource`
  accepts it, so it streams the same way it does everywhere else.
- **VP9 or AV1 in WebM** does not: Safari's `MediaSource` is MP4-only, so the
  player takes the whole-file path — download and decrypt everything, then play.
  Correct, just less snappy on a long video, and seeking is instant afterwards.
- **AV1** narrows it again. Chrome, Edge and Firefox decode it in software;
  Safari plays it only on hardware that decodes it — M3-class Apple silicon and
  newer, iPhone 15 Pro and newer — so every Intel Mac, every M1 and M2, and
  every older iPhone gets nothing at all.

Phones are best-effort throughout: iPhone Safari exposes `ManagedMediaSource`
rather than the `MediaSource` the player looks for, so it takes the whole-file
path even for an MP4.

One caveat on the MP4 path: its audio is AAC where the browser can encode
AAC, and Opus otherwise — which today means Chrome on desktop Linux, the one
platform with no AAC encoder in WebCodecs. Safari cannot play Opus in MP4, so if
you record on Linux, H.264 buys you the smooth 4K but not the Safari viewers.

## Development

```sh
npm run dev        # vite dev server
npm run build      # tsc --noEmit && vite build  ->  dist/
npm run preview    # serve the built dist/
npm test           # unit tests (crypto format, offset math, base64url, codec strings and
                   #             the codec-selection matrix, stored-settings normalization,
                   #             and the gateway's token verification and validation)
```

The end-to-end tests drive the real streaming multipart upload against the
compose stack — create, parts, complete, abort — read the result back the way
the player does, and check that the bucket policy is what it claims to be:
public reads work, anonymous writes 403, listing 403. They run the whole loop
twice: once signing in the browser, and once through the gateway, which boots
in-process with its own RS256 key set and proves that the video went to the
bucket and not through it.

```sh
docker compose -f examples/docker-compose.yml up -d
E2E=1 npm run test:e2e
```

The wire formats — id and key encoding, the encrypted block layout, chunk
offsets, the metadata JSON — are specified in [`docs/SPEC.md`](docs/SPEC.md).
That document is the contract; a change there is a change that breaks every
existing share link, so treat it accordingly.

## Future work

- **Camera bubble** — a picture-in-picture webcam overlay composited into the
  recording.
- **Expiring links** — bucket lifecycle rules plus an expiry stamped into the
  metadata, so a link can stop working.
- **Trim and pause** — cut the dead air at either end. Harder than it sounds now
  that the upload runs during the recording: the bytes are in the bucket before
  you would trim them, so it means either re-uploading or stamping trim points
  into the metadata for the player to honour.

## License

MIT. See [`LICENSE`](LICENSE).
