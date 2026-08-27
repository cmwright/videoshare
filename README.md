# VideoShare

Record your screen, get a link. The video is encrypted in your browser before it
leaves it, and the key lives in the link's `#fragment` — which browsers never
send over the network.

No server. No account. No SaaS in the middle. A static site and a bucket you own.

```
https://videoshare.example.com/view.html#8Kq2vTnR1sYbLm3wXpQdEg.b0Zx…
                                         └── video id ──┘ └─ AES key ─┘
                                                              never sent anywhere
```

## Why

Loom is good and Loom is a subscription that holds your screen recordings —
often of internal tools, customer data, half-finished work — on someone else's
computer. The recordings themselves are not complicated: capture, encode, upload,
serve. Browsers have done all four natively for years.

So VideoShare is the smallest thing that works:

- **`index.html`** — the recorder. Captures screen + mic, encodes with
  `MediaRecorder`, encrypts with WebCrypto, and sends the ciphertext to your
  bucket *while you are still recording*: every 8 MiB goes up as one part of a
  SigV4-signed S3 multipart upload, so stopping only leaves the tail to flush and
  the link lands about as fast as you can read it. One chunk is encrypted at a
  time, so an hour-long recording costs no more memory than a one-minute one.
  Settings and a local library of your links live in `localStorage`.
- **`view.html`** — the player. Holds no credentials at all. Reads the id and key
  from the URL fragment, fetches ciphertext from the bucket's public URL,
  decrypts it, and plays — streaming through Media Source Extensions where the
  browser supports it, whole-file otherwise.

The output is a `dist/` folder of static files. Host it on GitHub Pages,
Cloudflare Pages, S3, or a Raspberry Pi. Anything that speaks the S3 API can be
the bucket: Cloudflare R2, AWS S3, MinIO, Backblaze B2, Wasabi.

TypeScript, no frameworks, one runtime dependency (`aws4fetch`, for request
signing).

## Quickstart

Five minutes to a working stack on your laptop: MinIO as the bucket, nginx
serving the site. You need Node 20+ and Docker. Clone this repository, then from
its root:

```sh
npm install
npm run build
docker compose -f examples/docker-compose.yml up -d
```

Open **http://localhost:8080** and fill in the settings panel:

| Field | Value |
| --- | --- |
| Endpoint | `http://localhost:9000` |
| Region | `us-east-1` |
| Bucket | `videoshare` |
| Access key ID | `videoshare-uploader` |
| Secret access key | `videoshare-uploader-secret` |
| Public base URL | `http://localhost:9000/videoshare` |

(The compose stack prints these too — `docker compose -f examples/docker-compose.yml logs minio-init`.)

Now record something. The upload has been running the whole time you were
recording, so stopping and hitting **Finish** hands you the share link almost at
once, already copied to your clipboard. Open it in a different browser to prove
the point: no credentials, no login, and the bucket only ever handed over
ciphertext.

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

## Deploying for real

Two things move: the bucket, and where the static site lives.

1. **Set up a bucket.** [`docs/storage-setup.md`](docs/storage-setup.md) has
   copy-pasteable walkthroughs for **Cloudflare R2** (recommended — egress is
   free, which is the entire cost of hosting video), **AWS S3**, and
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
3. **Publish `dist/`** anywhere static. Share links are
   `{wherever you published}/view.html#{id}.{key}`, so the site needs a stable
   home — a moved site breaks every link you have already sent.

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

**Upload credentials are scoped to `PutObject` and `AbortMultipartUpload`.**
Stolen, they let someone write junk into your bucket and cancel an upload that is
still in flight. They do not let them read, list, delete a stored object, or
reach anything else in the account. The bucket has no anonymous `ListBucket`, so
video ids — 128 random bits each — cannot be enumerated.

### What this does *not* protect against

Be clear-eyed about this list before you record anything sensitive.

- **Anyone with the link can watch, forever.** The link *is* the credential.
  There is no revocation, no expiry, no per-viewer access, and no way to tell who
  watched. Deleting a video from the recorder's library removes the local entry
  only — the objects stay in the bucket. Forwarded link, forwarded video.
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

## Browser support

| Browser | Record | Watch |
| --- | --- | --- |
| Chrome / Edge (desktop) | Yes | Yes — streams progressively via MSE |
| Firefox (desktop) | Yes | Yes — streams progressively via MSE |
| Safari 16+ (macOS) | No | Yes — downloads and decrypts in full, then plays |
| Mobile browsers | No | Best-effort, on the fallback path |

**Recording is desktop-only.** It needs `getDisplayMedia`, which mobile browsers
do not offer. Safari can capture a screen but its `MediaRecorder` will not
produce WebM, and v1 records WebM (VP9 or VP8, Opus audio) only.

**Watching works anywhere the browser can decode VP9-in-WebM.** Chrome, Edge and
Firefox report `video/webm` support to `MediaSource`, so the player fetches,
decrypts and appends chunk by chunk and starts playing after the first 8 MiB.
Safari does not, so it takes the fallback path: the whole file downloads and
decrypts before playback starts. Correct, just less snappy on long videos, and
seeking is instant afterwards. macOS Safari gained WebM in 16; mobile Safari's
support arrived later and is patchier, so treat phones as best-effort.

## Development

```sh
npm run dev        # vite dev server
npm run build      # tsc --noEmit && vite build  ->  dist/
npm run preview    # serve the built dist/
npm test           # unit tests (crypto format, offset math, base64url)
```

The end-to-end test drives the real streaming multipart upload against the
compose stack — create, parts, complete, abort — reads the result back the way
the player does, and checks that the bucket policy is what it claims to be:
public reads work, anonymous writes 403, listing 403.

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
  recording, the one Loom feature people actually miss.
- **Real deletion** — `DeleteObject` from the recorder, behind a credential scope
  that allows it, so "delete" means more than "forget locally".
- **Expiring links** — bucket lifecycle rules plus an expiry stamped into the
  metadata, so a link can stop working.
- **Trim and pause** — cut the dead air at either end. Harder than it sounds now
  that the upload runs during the recording: the bytes are in the bucket before
  you would trim them, so it means either re-uploading or stamping trim points
  into the metadata for the player to honour.

## License

MIT. See [`LICENSE`](LICENSE).
