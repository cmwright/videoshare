# Gateway setup

By default VideoShare has no server: the recorder holds bucket credentials in
`localStorage` and signs its own uploads. That is the whole appeal, and it has
one honest weakness — **the credentials are in the browser**, so anyone with your
browser profile (or any XSS on the site's origin) has them, and there is no way
to hand recording to a colleague without handing over the keys too.

The **gateway** fixes exactly that and nothing else. It is a small stateless
service that holds the bucket credentials server-side, verifies a Google sign-in,
checks the email against a whitelist, and answers with **presigned URLs**. The
browser then uploads to those URLs directly.

```
  browser ──── POST /api/sign  (Google ID token) ───▶  gateway
          ◀─── { url: "https://bucket/…?X-Amz-Signature=…" } ──┘

  browser ══════════ PUT the encrypted part ═══════════▶  bucket
                        (20 MB, never through the gateway)
```

**The gateway never carries object bytes.** Not as a fallback, not for small
files, not behind a flag. It signs URLs or it returns an error — that is the one
invariant of the design (`docs/SPEC.md` §15), and the end-to-end test in
`tests/e2e.gateway.test.ts` measures the traffic on both legs to keep it true.
Which means the gateway stays tiny and cheap no matter how much video you record:
a Worker on a free plan can serve a team.

Everything else is unchanged. The video is still encrypted in the browser, the
key still lives only in the share link's fragment, and **the player never asks
the gateway for anything** — viewing is anonymous reads from the bucket, exactly
as before. Turn on playback analytics (§6) and the player gains exactly one
outbound call: a small encrypted beacon it never reads a reply to.

### What it does *not* give you

- **Not viewer authentication.** The link is still the credential, and anyone who
  has it can watch. The gateway controls who can *upload*.
- **Not a defence against a compromised site origin.** Malicious JavaScript
  served from your own site can still read fragments. The gateway removes the
  standing bucket credentials from the browser; it does not make the browser
  trustworthy.
- **Not an audit trail of who recorded what.** The verified email is written to
  the gateway's log at sign time, and nothing signs the objects themselves.

---

## 1. A Google OAuth client id

The gateway verifies Google ID tokens; the recorder obtains them with Google
Identity Services. Both need one client id, and it is free.

1. Go to [console.cloud.google.com/auth/clients](https://console.cloud.google.com/auth/clients)
   and create or pick a project.
2. Configure the consent screen if you are prompted to (User type **Internal** if
   you have a Workspace and only your own org will record; **External** otherwise
   — you can leave it in *Testing* and add your uploaders as test users).
3. **Create client** → application type **Web application**.
4. Under **Authorized JavaScript origins**, add the origin of the *static site*,
   scheme and host only, no path and no trailing slash:

   | Where the site runs | Origin to add |
   | --- | --- |
   | Local compose stack | `http://localhost:8080` **and** `http://localhost` |
   | Production | `https://videoshare.example.com` |

   This is the site's origin, not the gateway's. The gateway is never loaded in a
   browser as a page.
5. **Authorized redirect URIs**: leave empty. The recorder uses the JavaScript
   callback, so there is no redirect.

Copy the client id — it looks like
`1234567890-abcdef.apps.googleusercontent.com`. It is public information (every
visitor's browser sees it); the whitelist, not the client id, is what keeps
strangers out.

Changes to authorized origins can take a few minutes to propagate. A sign-in that
fails with `origin_mismatch` almost always means the origin string does not match
byte for byte — `https://` vs `http://`, or a missing port.

## 2. Environment

Every adapter reads the same names. There is no config file and no state
anywhere: this list *is* the deployment.

| Variable | Required | What it is |
| --- | --- | --- |
| `BUCKET_ENDPOINT` | yes | S3 API endpoint, e.g. `https://<account>.r2.cloudflarestorage.com`. Path-style URLs are built from it. |
| `BUCKET_NAME` | yes | Bucket the two objects per video live in. |
| `BUCKET_REGION` | no (`auto`) | `auto` for R2; the real region for AWS; anything for MinIO. |
| `BUCKET_ACCESS_KEY_ID` | yes | **Secret.** Needs `s3:PutObject` + `s3:AbortMultipartUpload` and nothing more. |
| `BUCKET_SECRET_ACCESS_KEY` | yes | **Secret.** |
| `PUBLIC_BASE_URL` | yes | Where the bucket is publicly readable. Handed to the recorder by `GET /api/config`; the player uses it. |
| `GOOGLE_CLIENT_ID` | yes | From step 1. The token's `aud` must equal this exactly. |
| `ALLOWED_EMAILS` | yes | Who may upload. Comma-separated; see below. |
| `ALLOWED_ORIGINS` | yes | Comma-separated origins allowed to call the gateway from a browser. `*` is refused as a configuration error. |
| `PRESIGN_EXPIRY_SECONDS` | no (`900`) | Lifetime of each signed URL, 1–3600. |
| `ANALYTICS_BUCKET` | no | A **second, private** bucket for encrypted playback analytics. Unset means analytics is off. See §6. |

`OIDC_JWKS_URL` and `OIDC_ISSUER` also exist. They point token verification at a
different provider and are there **only** so the tests can run against a local
key set (`docs/SPEC.md` §15.6). Leave them unset in production and Google's are
used; setting them wrong is how you accept tokens minted by someone else.

The whole environment is validated in one place, and a failure always names the
variable — but *when* you find out depends on the adapter. The Node adapter (and
so the compose service) checks before it listens, so a missing variable is a
one-line startup failure. Workers and Lambda have no boot phase: there the same
check runs on the first request that arrives and answers

```
500 {"error":"Gateway is misconfigured: ALLOWED_EMAILS is not set."}
```

which is a 500 on someone's first recording if nobody looked first. So after
deploying either, look first: `curl https://<gateway>/api/config` is public,
needs no token, and fails exactly the same way. A healthy gateway answers
`{"gateway":true,...}`.

The body names the variable and never its value — a broken deployment is not a
way to read the whitelist back out of the gateway. If you need to know *which*
entry was rejected, that is in the service's own log.

### Bucket credentials

Scope them exactly as the credential-in-the-browser mode does —
`examples/iam-uploader-policy.json`, `s3:PutObject` and
`s3:AbortMultipartUpload` on `{bucket}/*`. The gateway needs no more authority
than the recorder had (turning on `ANALYTICS_BUCKET` adds three permissions on
that *other* bucket, and nothing on this one — §6); what changes is who holds
it. Everything in
`docs/storage-setup.md` still applies, including the CORS rules: the *browser*
still talks to the bucket directly, so the bucket must still allow
`PUT`/`POST`/`DELETE` from the site's origin and still expose `ETag`.

Because the gateway is the only holder now, these can and should be narrower than
before — and rotating them is a redeploy of one service rather than an
announcement to everyone with the recorder open.

### The whitelist

`ALLOWED_EMAILS` is comma-separated. Each entry is either a full address or an
`@domain` suffix, matched case-insensitively against the token's verified
`email`:

```
ALLOWED_EMAILS=alice@example.com,bob@example.com,@team.example.com
```

`@team.example.com` matches `anyone@team.example.com` and nothing else — not
`someone@sub.team.example.com`, not `x@notteam.example.com`. An entry with no
`@` is rejected as a configuration error rather than silently matching nothing,
and an empty list
is a configuration error: a gateway nobody may use is a mistake, and "empty means
everyone" must never be a reading of it.

Adding or removing someone is an environment change and a restart. There are no
sessions to invalidate — every request re-verifies its own token — but a token
already issued stays valid for its lifetime (Google's is an hour), so removal
takes effect within the hour.

### Origins

`ALLOWED_ORIGINS` is the origin of the deployed site, exactly as a browser
reports it: scheme, host, and port if it is not the default. No path, no trailing
slash. List several with commas if the site has more than one home.

`*` is refused as a configuration error, on purpose. A wildcard would let any page on the
internet call your gateway with a signed-in user's token and spend your bucket
credentials.

**A same-origin deployment needs its origin listed too.** This is the one
counter-intuitive part. Browsers send an `Origin` header on every request whose
method is not `GET` or `HEAD` — *including same-origin ones* — so a gateway
mounted at `/api` on the site's own host still sees `Origin: https://your-site`
on each `POST /api/sign`. The gateway refuses an origin it was not told about,
rather than merely declining to echo it back, so leaving `ALLOWED_ORIGINS` empty
of your own site turns every sign call into a `403` even though nothing is
cross-origin. Whatever the arrangement, `ALLOWED_ORIGINS` lists the site.

## 3. Deploy it

Pick one. They run the same `handleRequest`; the adapters only translate
transport shapes.

### Cloudflare Worker

The natural pairing with R2, and free for this workload.

```sh
cd gateway
npm install

# Edit wrangler.jsonc: BUCKET_ENDPOINT, BUCKET_NAME, PUBLIC_BASE_URL,
# ALLOWED_ORIGINS. These are not secret and belong in version control.

npx wrangler secret put BUCKET_ACCESS_KEY_ID
npx wrangler secret put BUCKET_SECRET_ACCESS_KEY
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put ALLOWED_EMAILS

npx wrangler deploy
```

You get `https://videoshare-gateway.<subdomain>.workers.dev`. That plus `/api` is
your `gatewayUrl`.

Keeping `ALLOWED_EMAILS` as a secret rather than a var is a small thing: it is not
sensitive, but it changes more often than the rest and `wrangler secret put` is a
faster edit than a redeploy.

### AWS Lambda function URL

```sh
cd gateway
npm install
npm run build              # tsc -> dist/*.js, plain ESM
npm prune --omit=dev       # leaves the two runtime deps: jose, aws4fetch

# package.json goes in for its "type": "module" — without it the runtime
# reads the .js files as CommonJS and every import fails.
zip -r gateway.zip dist node_modules package.json

aws lambda create-function \
  --function-name videoshare-gateway \
  --runtime nodejs22.x --handler dist/lambda.handler \
  --role arn:aws:iam::<account>:role/<lambda-basic-execution-role> \
  --zip-file fileb://gateway.zip \
  --environment "Variables={BUCKET_ENDPOINT=...,BUCKET_NAME=videoshare,...}"

aws lambda create-function-url-config \
  --function-name videoshare-gateway --auth-type NONE

aws lambda add-permission --function-name videoshare-gateway \
  --statement-id public --action lambda:InvokeFunctionUrl \
  --principal '*' --function-url-auth-type NONE
```

Three things matter here:

- **Auth type `NONE` is correct.** The gateway authenticates every request with a
  Google ID token itself; IAM auth on the function URL would make it uncallable
  from a browser.
- **Leave the invoke mode at `BUFFERED`.** Response streaming is exactly what a
  proxy would need, and this gateway must never become one.
- **Function URLs speak payload format 2.0 only**, which is what the adapter
  reads. Putting an API Gateway REST proxy in front instead sends 1.0 and will
  not work.

The function URL plus `/api` is your `gatewayUrl`. Reinstall the dev
dependencies (`npm install`) when you go back to working on it.

### Node, next to MinIO

The compose stack in `examples/docker-compose.yml` has a `gateway` service behind
a profile, so it stays out of the way until you ask for it:

```sh
npm install && npm --prefix gateway install && npm run build

VIDEOSHARE_GOOGLE_CLIENT_ID=1234567890-abcdef.apps.googleusercontent.com \
VIDEOSHARE_ALLOWED_EMAILS=you@example.com \
  docker compose -f examples/docker-compose.yml --profile gateway up -d
```

It listens on `http://localhost:8787`, already pointed at the compose MinIO with
a key that stack mints for it. Note that its `BUCKET_ENDPOINT` is
`http://localhost:9000`, not `http://minio:9000`: that endpoint is what gets
*signed into URLs the browser dereferences*, so it has to be the name a browser
on your machine can resolve.

That is also why the compose service sets `network_mode: "service:minio"` and
publishes its port from the `minio` service. With analytics on, the gateway
sends beacons to `BUCKET_ENDPOINT` *itself*, and `localhost` has to mean the same
thing in the container as it does in the browser. Outside Docker — or with a real
bucket, where the endpoint is a public hostname — the question does not arise.

Outside Docker it is just a process — no framework, no build step, Node 22.18+
strips the types itself:

```sh
cd gateway && npm install
BUCKET_ENDPOINT=http://localhost:9000 BUCKET_NAME=videoshare \
BUCKET_REGION=us-east-1 \
BUCKET_ACCESS_KEY_ID=... BUCKET_SECRET_ACCESS_KEY=... \
PUBLIC_BASE_URL=http://localhost:9000/videoshare \
GOOGLE_CLIENT_ID=...apps.googleusercontent.com \
ALLOWED_EMAILS=you@example.com \
ALLOWED_ORIGINS=http://localhost:8080 \
  npm start
```

Put it behind TLS in production. If the site is HTTPS the gateway must be too;
browsers block plain-HTTP requests from a secure page. Serving it at `/api` on
the site's own origin is the tidiest arrangement — no preflights, and
`gatewayUrl` becomes `"/api"`. It still needs its own origin in
`ALLOWED_ORIGINS`; see below.

## 4. Point the recorder at it

One line in `public/config.js` — the same file that already carries
`publicBaseUrl`:

```js
window.VIDEOSHARE = {
  publicBaseUrl: "https://pub-xxxx.r2.dev",
  gatewayUrl: "https://videoshare-gateway.example.workers.dev/api",
};
```

Absolute, or relative like `"/api"` when the gateway is on the site's own origin.
No trailing slash. The file is copied verbatim into `dist/`, so you can flip a
built site between modes without rebuilding.

With `gatewayUrl` set, the recorder is in **gateway mode**: the storage settings
panel is gone, there is a Google sign-in button, and the ID token is held in
memory only — never `localStorage`. Remove the line and it is back to legacy
mode, credentials and all. Nothing about existing videos or share links changes
either way.

## 5. Check it

```sh
curl https://<your-gateway>/api/config
# {"gateway":true,"publicBaseUrl":"https://…","googleClientId":"…"}

curl -i -X POST https://<your-gateway>/api/sign \
  -H 'content-type: application/json' \
  -d '{"op":"create","id":"aaaaaaaaaaaaaaaaaaaaaa"}'
# HTTP/1.1 401  — no token, as it should be
```

Then open the site, sign in, and record something short. The share link it gives
you must open in a browser that has never seen the gateway: viewing is anonymous
and does not involve it.

### Run the tests against your own stack

```sh
docker compose -f examples/docker-compose.yml up -d
E2E=1 npm run test:e2e
```

`tests/e2e.gateway.test.ts` boots the Node adapter in-process against MinIO with
a locally minted RS256 key set, uploads 20 MB through presigned URLs, reads it
back the way the player does, and asserts that the gateway exchanged kilobytes
while the bucket took megabytes. `npm test` covers token verification and request
validation without needing a bucket. Neither needs `gateway/`'s own
`npm install` — the root project already carries `jose` and `aws4fetch`, and the
tests import the gateway's TypeScript sources directly.

Both suites mint their own RS256 keys and serve their own JWKS, so the
production verification path runs verbatim. There is deliberately no test bypass
in the gateway itself: no magic bearer token, no "skip auth" flag. If you add a
feature here, add it without one.

### R2: smoke-test before you roll out

**Do this once, on the real bucket, before anyone depends on it.** R2's support
for *presigned* `UploadPart` is confirmed by users rather than by Cloudflare's
documentation, and it is the one operation this design cannot work around: the
part `PUT`s are the upload.

Record a video long enough to produce **at least two parts** — more than 8 MiB of
plaintext, so somewhere over about ten seconds of a busy screen, or a minute of a
static one — and confirm the share link plays from a clean browser. A single-part
recording proves nothing: it exercises `create`, one `part`, `complete` and
`put-meta`, but a multi-part upload is where a rejected part number would show up.

If a part `PUT` comes back 403 against R2 while the same code works against
MinIO, that is the failure this step exists to catch. Report it, and stay on
credential-in-the-browser mode against that bucket in the meantime.

## 6. Optional: playback analytics

Who watched how much of a video, without the server learning any of it
(`docs/SPEC.md` §16). The viewer's browser already holds the video's AES key — it
is in the share link's fragment — so the player encrypts everything it has to say
about the watch **with that same key** before sending it. The gateway and the
bucket only ever hold ciphertext, a video id, and a random per-page-load session
label.

**Leaving `ANALYTICS_BUCKET` unset is a supported configuration, not a broken
one.** `/api/config` then answers `analytics: false`, the player sends nothing,
the beacon routes are `404`, and the recorder's library shows no analytics at
all — no expander, no empty panel to wonder about. Everything below is opt-in.

```
  viewer ─── POST /beacon/{videoId}/{sessionId} ───▶ gateway ──▶ analytics bucket
                (≤ 16 KiB of ciphertext, no token, no reply read)

  you ────── GET  /beacon/{videoId}  (Google ID token) ──▶ gateway
         ◀── { sessions: [ { url: "https://bucket/…?X-Amz-Signature=…" } ] }
  you ══════ fetch each url ═══════════════════════════════▶ analytics bucket
```

The beacon write is the **one** place object bytes pass through the gateway, and
it is bounded on purpose: one direction, at most 16 KiB, opaque bytes, an object
key the gateway builds itself from two validated ids, and **no read path at
all**. Reading is presigned URLs like everything else.

### Make the bucket

A second bucket in the same account, on the same endpoint, with the same
credentials. Two rules:

- **It must be private.** No public domain attached on R2, no anonymous-read
  policy on S3 or MinIO. `docs/storage-setup.md` walks you through making the
  *video* bucket world-readable; do none of that here. The gateway refuses to
  start if `ANALYTICS_BUCKET` and `BUCKET_NAME` are the same bucket, because the
  video bucket is world-readable by design and watch data must never land in it.
- **It needs `GET` CORS from the site's origin**, and nothing else. Writes need
  no CORS at all — the gateway performs them server-side — but the recorder page
  fetches session objects straight from their presigned URLs, so the browser does
  a cross-origin `GET` against the bucket. `examples/s3-cors.json` is more
  permissive than this bucket needs; `GET` and `HEAD` from your site's origin is
  enough. (MinIO has no per-bucket CORS and answers permissively out of the box,
  so the compose stack needs nothing extra.)

### Widen the credentials

Three permissions, all of them on the analytics bucket only:

```jsonc
{
  "Sid": "VideoShareAnalytics",
  "Effect": "Allow",
  "Action": ["s3:PutObject", "s3:GetObject"],   // write beacons; sign reads of them
  "Resource": ["arn:aws:s3:::videoshare-analytics/*"]
},
{
  "Sid": "VideoShareAnalyticsList",
  "Effect": "Allow",
  "Action": ["s3:ListBucket"],                  // the bucket itself, not /*
  "Resource": ["arn:aws:s3:::videoshare-analytics"]
}
```

`s3:GetObject` looks wrong for a service that never reads an object, and it is
the one people leave out. A presigned URL carries the authority of the key that
signed it: without `GetObject` the gateway signs URLs happily and every one of
them comes back `403`. On R2, the equivalent is an API token scoped to both
buckets with **Object Read & Write**.

Because these are wider than the uploader's, keep them on a key of their own
rather than reusing the one a legacy-mode browser might hold. The compose stack
does exactly that: `videoshare-uploader` stays upload-only, and
`videoshare-gateway` is the key with analytics on it.

### Turn it on

```sh
ANALYTICS_BUCKET=videoshare-analytics
```

or `npx wrangler secret put ANALYTICS_BUCKET` (it is not secret; a var in
`wrangler.jsonc` is just as good). Then:

```sh
curl https://<your-gateway>/api/config
# {"gateway":true,…,"analytics":true}

curl -i -X POST https://<your-gateway>/api/beacon/aaaaaaaaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbb \
  --data-binary 'not really ciphertext'
# HTTP/1.1 204  — unauthenticated on purpose: viewers have no identity
```

Rebuild the site (`npm run build`) and open the recorder. Every entry in **My
videos** grows an **Analytics** expander once you are signed in: open one and it
lists that video's sessions, fetches them straight from the bucket, and decrypts
them in the tab — views, unique viewers, completions, and a heatmap of which 2%
of the video got replayed and which got skipped. There is no separate stats page
and no link to paste: the analytics live on the video's own row, because that is
where its share link already is.

### Lambda: smoke-test one real beacon before you roll out

**Only if your gateway runs as a Lambda function URL, and only once.** A function
URL decides whether to hand the handler the request body as text or as base64
from the request's `Content-Type` — and the beacon's is
`text/plain;charset=UTF-8`, because `sendBeacon` cannot set a header and a
safelisted type is what keeps a preflight from stranding a beacon fired at
`pagehide`. That is a text label on bytes that are pure AES-GCM ciphertext. If
the runtime takes the label at its word and decodes the body as UTF-8, every
sequence that is not valid UTF-8 comes back a replacement character, the adapter
faithfully re-encodes the damage, the `PutObject` succeeds, and the `204` tells
you nothing: the object simply never decrypts. The Worker and Node adapters carry
the body as bytes and cannot hit this, and no test that runs on your laptop can
prove which way the function URL goes.

So prove it on the real thing. Record a fresh video, play a minute of it from its
share link against the deployed gateway, then open the recorder, sign in, and
expand **Analytics** on that video's library row:

- **One view, decrypted, with a heatmap over the part you actually watched** —
  the beacon survived the round trip. Nothing further to do, ever.
- **"1 session could not be read"**, on a video whose key has not changed and
  with nothing else in that prefix — that is this failure, and it is the reason
  this step exists.

The `curl` above is not a substitute: `'not really ciphertext'` is valid UTF-8
and survives either path. Only real ciphertext tests the encoding decision.

If it fails, move that gateway to the Worker or Node adapter, or leave
`ANALYTICS_BUCKET` unset on it — and please report it. Recording and playback are
unaffected either way: uploads go to presigned URLs and never put a body through
Lambda at all.

### What this does and does not hide

The operator of the gateway and the bucket can see **that** a video id was
watched, roughly **when** (the object's `LastModified`, refreshed by each flush),
how many sessions exist for it, and how big each encrypted object is. They cannot
see which parts were watched, how much, whether it finished, or anything about
the viewer — no account, no cookie, and no IP address, because none is read or
logged on any analytics path.

Two consequences worth saying out loud:

- **Watch data is readable by exactly the holders of the share link.** Sharing
  the link shares the analytics. There is no separate key.
- **The listing endpoint uses the uploader whitelist.** Anyone in
  `ALLOWED_EMAILS` can list sessions for any video id they know. Ids are 128-bit
  random and only reachable through a share link, but this is not per-video
  ownership, and it is not built to be.

## Troubleshooting

| What you see | Usually |
| --- | --- |
| Gateway exits at boot naming a variable | Exactly that: the Node adapter validates the whole environment before listening. |
| `500 {"error":"Gateway is misconfigured: …"}` from a Worker or Lambda | The same check, one request later — those adapters have no boot phase. The body names the variable; the log names the value. `curl {gateway}/api/config` reproduces it without a token. |
| Sign-in button never appears | `gatewayUrl` unreachable, or `/api/config` did not answer `gateway: true`. Check the browser console and that `gatewayUrl` points at the gateway, not the site. |
| `origin_mismatch` from Google | The site's origin is not in the client id's authorized JavaScript origins, byte for byte. |
| `403` from the gateway on every sign call | Either the email is not in `ALLOWED_EMAILS`, or the site's origin is not in `ALLOWED_ORIGINS` — the body says which. |
| `401` that a fresh sign-in does not fix | `GOOGLE_CLIENT_ID` differs between the gateway and the client id the page signed in with. |
| `403` from the **bucket** on a part upload | The presigned URL expired (raise `PRESIGN_EXPIRY_SECONDS`, or check the gateway's clock), or the bucket credentials cannot `PutObject`. |
| Upload fails with no HTTP status at all | The **bucket's** CORS, not the gateway's — the gateway answered, so its own CORS is fine. See `examples/s3-cors.json`. |
| `503` with "could not reach the identity provider" | The gateway cannot fetch Google's JWKS. Check egress from wherever it runs. |
| `/api/config` says `"analytics":false` | `ANALYTICS_BUCKET` is unset, or set to whitespace. Nothing else turns analytics on. |
| Gateway exits naming `ANALYTICS_BUCKET` | Either it is not a legal bucket name, or it is the *same* bucket as `BUCKET_NAME` — which is refused, because that bucket is world-readable. |
| `404` from `/beacon/…` on a gateway you configured | The reverse proxy is not passing the path through, or `ANALYTICS_BUCKET` is unset on the instance that answered. `/api/beacon/…` and `/beacon/…` both work. |
| `502` from `/beacon/…` | The bucket rejected the write or the listing; the gateway's log has the video id and the storage status. Usually the credentials lack `PutObject`/`ListBucket` on the analytics bucket, or the bucket does not exist. |
| Analytics expander finds sessions, then fails to load them | The signing key has no `s3:GetObject` on the analytics bucket (a presigned URL is only as authorized as the key behind it), or the bucket has no `GET` CORS for the site's origin. |
| Analytics expander says N sessions could not be read | Expected in small numbers: the write endpoint is unauthenticated, and a video re-uploaded under a new key leaves old sessions undecryptable. |
| No **Analytics** expander on a library row | Legacy mode (no `gatewayUrl`), `/api/config` answering `analytics: false`, or you are signed out — signed out, the row says "Sign in to see analytics." instead. |
| *Every* session unreadable, on a **Lambda** gateway | The function URL is likely handing the adapter the `text/plain`-labelled beacon as a UTF-8 string and mangling the ciphertext. That is what §6's one-real-beacon smoke test catches; move to the Worker or Node adapter. |
