# Storage setup

VideoShare has no backend. The recorder signs `PUT`s straight from the browser
and the player fetches ciphertext with no credentials at all, so the whole
deployment is one bucket configured four ways.

## What the bucket has to do

1. **Anonymous `GetObject`, including `Range` requests.** The player streams
   `video.bin` chunk-by-chunk with `Range: bytes=…`. Everything it downloads is
   AES-GCM ciphertext, so "public" here means public ciphertext.
2. **No anonymous `ListBucket`.** Video ids are 128 random bits and the whole
   sharing model rests on them being unguessable. A listable bucket hands over
   every id at once. (It still would not hand over the keys — those live only in
   share links — but it leaks who recorded how much and when.)
3. **CORS** allowing `GET`/`HEAD` from wherever the site is hosted, plus `PUT`,
   **`POST` and `DELETE`** so the recorder can upload. The recorder streams
   `video.bin` to the bucket while you are still recording, as an S3 multipart
   upload: a `POST` to create it, a `PUT` per 8 MiB part, a `POST` to complete
   it — and a `DELETE` to abandon it when you press **Discard**.
   `ExposeHeaders` must carry `Content-Range`, `Accept-Ranges`, `Content-Length`
   and `ETag` — `ETag` because the completing `POST` has to list back the tag
   every part response returned, and a response header the browser is not
   allowed to read might as well not have been sent.

   `examples/s3-cors.json` lists all five methods. Leave `DELETE` out and
   Discard's `AbortMultipartUpload` never leaves the browser — its preflight
   fails, the recorder swallows it (the abort is best-effort by design), and the
   parts already uploaded stay in the bucket, billed and invisible to a plain
   listing, until point 5 sweeps them.
4. **Upload credentials scoped as narrowly as the provider allows** — ideally
   `s3:PutObject` and `s3:AbortMultipartUpload` on `{bucket}/*` and nothing
   else. `PutObject` authorizes the whole multipart write path (create, every
   part, complete); abandoning an upload is a separate action, and without it
   Discard comes back 403. They live in the recorder's `localStorage`, so treat
   them as compromised-in-advance and make sure the worst case is "someone wrote
   junk into my bucket".
5. **Something that aborts incomplete multipart uploads**, after a day or so. A
   tab closed mid-recording leaves its uploaded parts in the bucket; they are
   billed like stored objects and a plain listing does not show them, so nothing
   tells you they are there. Every provider below can sweep them, by a different
   mechanism each time — each section says which.

The three example documents in `examples/` implement 1, 3 and 4 for anything
that speaks the S3 API; 5 is per-provider. They hardcode the bucket name
`videoshare` — change the ARNs if yours differs.

| File | Applies with |
| --- | --- |
| `examples/s3-bucket-policy.json` | `aws s3api put-bucket-policy` / `mc anonymous set-json` |
| `examples/s3-cors.json` | `aws s3api put-bucket-cors` |
| `examples/iam-uploader-policy.json` | `aws iam put-user-policy` |

`AllowedOrigins` in `s3-cors.json` is `["*"]`, which is right while you are
finding your feet and too loose afterwards. Once the site has a stable home,
narrow it to that exact origin (scheme + host + port, no trailing slash).

---

## Cloudflare R2 (recommended)

R2 charges nothing for egress, which is the entire cost of a video host, and it
speaks the S3 API well enough that VideoShare needs no special casing.

### 1. Create the bucket

```sh
npx wrangler r2 bucket create videoshare
```

Or Cloudflare dashboard → **R2** → **Create bucket**.

### 2. Make reads public

Dashboard → your bucket → **Settings** → **Public access**. Two ways:

- **`r2.dev` subdomain** — one click, gives you
  `https://pub-<hash>.r2.dev`. Cloudflare rate-limits it and asks you not to use
  it in production, but it is perfect for trying this out.
- **Custom domain** — attach a hostname you own on a Cloudflare-managed zone.
  This is the production answer: full CDN, no rate limit.

Whichever you pick, that URL is your `publicBaseUrl`. Note that an R2 public URL
maps to the **root of the bucket**, so there is no `/videoshare` path segment:

```
publicBaseUrl = https://pub-<hash>.r2.dev
```

### 3. CORS

Dashboard → bucket → **Settings** → **CORS policy** takes the bare rules array —
that is, the contents of `"CORSRules"` in `examples/s3-cors.json`:

```json
[
  {
    "AllowedOrigins": ["https://videoshare.example.com"],
    "AllowedMethods": ["GET", "HEAD", "PUT", "POST", "DELETE"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag", "Content-Length", "Content-Range", "Accept-Ranges"],
    "MaxAgeSeconds": 3000
  }
]
```

Cloudflare's CORS documentation shows `GET`, `PUT`, `HEAD` and `DELETE` in its
examples and does not spell out whether `POST` is accepted, so do not assume this
rule set took: apply it, then run the `POST` preflight from
[Checking your work](#checking-your-work) and read the
`Access-Control-Allow-Methods` header that comes back. Without `POST` the
recorder cannot even create the multipart upload, and the failure shows up as a
bare network error with no status.

Or apply the example file as-is over the S3 API. Note the credentials: bucket
configuration calls like `PutBucketCors` need an **Admin Read & Write** R2 API
token, *not* the upload token from step 4 below — that one is deliberately scoped
to objects and will fail here with `AccessDenied`. Create the admin token the
same way (**R2** → **API** → **Create API token**), use it for this one command,
and delete it afterwards; the recorder never wants it.

```sh
export AWS_ACCESS_KEY_ID=<admin token access key id>
export AWS_SECRET_ACCESS_KEY=<admin token secret>

aws s3api put-bucket-cors \
  --endpoint-url https://<ACCOUNT_ID>.r2.cloudflarestorage.com \
  --region auto \
  --bucket videoshare \
  --cors-configuration file://examples/s3-cors.json
```

The dashboard is the shorter path if you only ever set this once.

The policy governs both the S3 endpoint (the recorder's `PUT`) and the public
domain (the player's ranged `GET`), so one rule set covers both pages.

### 4. Upload credentials

Dashboard → **R2** → **API** → **Manage API Tokens** → **Create API token**:

- Permissions: **Object Read & Write**
- Scope: **Apply to specific buckets only** → `videoshare`

**Tradeoff, stated plainly:** R2 has no write-only token. `Object Read & Write`
is the tightest grant available, so anyone who lifts these credentials out of a
recorder's `localStorage` can also *read* every object in the bucket — which,
since the bucket is publicly readable anyway, costs you nothing extra. What
matters is that the token is bucket-scoped and cannot touch bucket settings,
other buckets, or your account. Rotate it if a recorder machine is lost.

Being a whole-object grant, it covers the multipart calls too — there is no
separate box to tick for `AbortMultipartUpload` the way there is an IAM action to
add on S3.

### 5. Incomplete multipart uploads

R2 applies a default lifecycle rule to new buckets that expires multipart uploads
seven days after initiation, so abandoned parts do get collected without you
doing anything. Seven days is longer than VideoShare needs: open your bucket →
**Settings** → **Object lifecycle rules**, confirm the rule is actually there and
enabled, and shorten it if you would rather not carry a week of stranded parts.

The same thing over the S3 API — with the **admin** token from step 3, not the
upload token:

```sh
aws s3api put-bucket-lifecycle-configuration \
  --endpoint-url https://<ACCOUNT_ID>.r2.cloudflarestorage.com \
  --region auto \
  --bucket videoshare \
  --lifecycle-configuration '{
    "Rules": [{
      "ID": "abort-incomplete-multipart-uploads",
      "Status": "Enabled",
      "Filter": { "Prefix": "" },
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 1 }
    }]
  }'
```

This replaces the bucket's entire lifecycle configuration, default rule included,
so put back anything else you had.

### 6. Recorder settings

| Field | Value |
| --- | --- |
| Endpoint | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` |
| Region | `auto` |
| Bucket | `videoshare` |
| Access key ID | from the API token |
| Secret access key | from the API token |
| Public base URL | `https://pub-<hash>.r2.dev` or your custom domain |

Set the same public URL in `public/config.js` (or `dist/config.js`) before
deploying the site — that is the value the player uses.

---

## AWS S3

S3 bucket names are globally unique, so pick your own and substitute it
everywhere below, **including the ARNs inside the two policy files**.

```sh
BUCKET=my-videoshare-bucket
REGION=us-east-1
```

### 1. Create the bucket

```sh
aws s3api create-bucket --bucket "$BUCKET" --region "$REGION"

# Outside us-east-1, S3 requires the location constraint:
# aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
#   --create-bucket-configuration LocationConstraint="$REGION"
```

### 2. Allow a public bucket policy

New buckets block public policies outright. Lift only that one flag; leave the
ACL blocks on, since VideoShare never uses ACLs.

```sh
aws s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration \
  "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=false,RestrictPublicBuckets=false"
```

### 3. Public read + CORS

```sh
aws s3api put-bucket-policy --bucket "$BUCKET" \
  --policy file://examples/s3-bucket-policy.json

aws s3api put-bucket-cors --bucket "$BUCKET" \
  --cors-configuration file://examples/s3-cors.json
```

`s3-bucket-policy.json` grants `s3:GetObject` on `{bucket}/*` and nothing else —
no `ListBucket`, so `GET /?list-type=2` stays a 403.

### 4. An upload-only IAM user

```sh
aws iam create-user --user-name videoshare-uploader

aws iam put-user-policy --user-name videoshare-uploader \
  --policy-name videoshare-upload-only \
  --policy-document file://examples/iam-uploader-policy.json

aws iam create-access-key --user-name videoshare-uploader
```

The last command prints the only copy of the secret. That user can write objects
into this one bucket — `s3:PutObject` covers creating a multipart upload, every
part, and completing it — and abandon an upload of its own that never finished.
Nothing else at all: no read, no list, no deleting a stored object, no
overwriting the bucket policy.

### 5. Abort incomplete multipart uploads

S3 never cleans these up on its own. Parts from an upload that was created and
never completed stay in the bucket indefinitely, charged as storage, and
`list-objects` does not show them — the only way to see them is to ask
specifically:

```sh
aws s3api list-multipart-uploads --bucket "$BUCKET"
```

One lifecycle rule handles every recording from here on:

```sh
aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" \
  --lifecycle-configuration '{
    "Rules": [{
      "ID": "abort-incomplete-multipart-uploads",
      "Status": "Enabled",
      "Filter": { "Prefix": "" },
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 1 }
    }]
  }'
```

A day is generous. The recorder aborts its own upload when you press Discard, so
this only has to catch the ones that never got the chance — a crashed tab, a
closed laptop, a lost network. Note that the call replaces the bucket's whole
lifecycle configuration rather than adding to it, so if the bucket already has
rules, fetch them with `get-bucket-lifecycle-configuration` and put this rule
alongside them.

### 6. Recorder settings

| Field | Value |
| --- | --- |
| Endpoint | `https://s3.<REGION>.amazonaws.com` |
| Region | `<REGION>` |
| Bucket | `<BUCKET>` |
| Access key ID / secret | from `create-access-key` |
| Public base URL | `https://<BUCKET>.s3.<REGION>.amazonaws.com` |

Uploads go to `{endpoint}/{bucket}/{key}` (path-style), which S3 still accepts.
Reads use the virtual-hosted form above because it is what CloudFront and every
CDN in front of S3 expect. If you do put a CDN in front, set `publicBaseUrl` to
the CDN hostname instead and you get caching for free.

---

## MinIO (self-hosted)

`examples/docker-compose.yml` is a complete working MinIO deployment; this
section is the same thing without the compose file, plus the variant you can run
on a private network.

### 1. Run it

```sh
docker run -d --name minio \
  -p 9000:9000 -p 9001:9001 \
  -e MINIO_ROOT_USER=admin \
  -e MINIO_ROOT_PASSWORD='a-long-random-password' \
  -e MINIO_API_CORS_ALLOW_ORIGIN='https://videoshare.example.com' \
  -v minio-data:/data \
  quay.io/minio/minio:latest server /data --console-address ':9001'
```

### 2. CORS: there is nothing per-bucket to configure

MinIO **does not implement the S3 `PutBucketCors` API**. `mc cors set` against a
stock MinIO server fails with `A header you provided implies functionality that
is not implemented` (verified against `RELEASE.2025-09-07T16-13-09Z`).

It does not need to. MinIO answers preflights permissively by default: it
reflects the request origin and the requested method and headers, so the
recorder's multipart `POST` (create, complete) and `DELETE` (abort) preflights
come back allowed exactly as the player's `GET` does. Its
`Access-Control-Expose-Headers` already lists `ETag`, `Content-Length`,
`Content-Range` and `Accept-Ranges` — everything the player's ranged reads and
the recorder's per-part `ETag` bookkeeping need.

The single knob is server-wide and defaults to `*`. Set it to your site's origin
for any deployment that is not on your laptop — as the environment variable
shown above, or on a running server:

```sh
mc admin config set myminio api cors_allow_origin='https://videoshare.example.com'
mc admin service restart myminio
```

`MINIO_API_CORS_ALLOW_ORIGIN` **overrides** the stored config key, so if you
started MinIO with the environment variable, `mc admin config set` will appear to
succeed and change nothing. Pick one. A blocked origin gets a preflight with no
`Access-Control-Allow-Origin` header at all, which the browser reports as a
generic CORS failure.

### 3. Bucket, public read, upload user

```sh
mc alias set myminio http://localhost:9000 admin 'a-long-random-password'
mc mb --ignore-existing myminio/videoshare

# Public read of objects only.
mc anonymous set-json examples/s3-bucket-policy.json myminio/videoshare

mc admin user add myminio videoshare-uploader 'another-long-random-password'
mc admin policy create myminio videoshare-uploader examples/iam-uploader-policy.json
mc admin policy attach myminio videoshare-uploader --user videoshare-uploader
```

Use `set-json` rather than `mc anonymous set download myminio/videoshare`. The
`download` shorthand also grants anonymous `s3:ListBucket`, which lets anyone
enumerate every video id in the bucket. Verify what you actually applied:

```sh
mc anonymous get-json myminio/videoshare
curl -s -o /dev/null -w '%{http_code}\n' 'http://localhost:9000/videoshare/?list-type=2'   # want 403
```

### 4. Abandoned multipart uploads

MinIO will not take a bucket lifecycle rule for this, and fails in two different
ways depending on how you write it. A rule whose only action is
`AbortIncompleteMultipartUpload` is rejected with `InvalidArgument` ("the XML you
provided … did not validate against our published schema"); a rule that also
carries an `Expiration` is *accepted*, and the abort action is silently dropped —
read the config back and it is simply not there. `mc ilm rule add` has no flag
for it and `mc ilm rule import` hits the same wall. Verified against
`RELEASE.2025-09-07T16-13-09Z`.

It sweeps them server-wide instead, and already does so out of the box:

```sh
mc admin config get myminio api          # stale_uploads_expiry=24h,
                                         # stale_uploads_cleanup_interval=6h
mc admin config set myminio api stale_uploads_expiry=24h
```

The setting applies immediately — no service restart, and it leaves the other
`api` keys alone. As with CORS, the environment variable
(`MINIO_API_STALE_UPLOADS_EXPIRY`) overrides the stored key, so set it one way or
the other, not both. Expiry is checked once per cleanup interval, so with the
defaults a stranded upload lives at most about 30 hours.

To see what is stranded right now — these never appear in an ordinary `mc ls`:

```sh
mc ls --incomplete --recursive myminio/videoshare
```

### 5. TLS

Browsers refuse plain-HTTP subresources on an HTTPS page. If the site is served
over HTTPS, MinIO must be too — terminate TLS at a reverse proxy in front of it,
or drop MinIO's certificates into `~/.minio/certs`. Both endpoints being HTTP
(local development) is fine; a mix is not.

### 6. The VPN variant

If MinIO only listens on a private network — Tailscale, WireGuard, an office
VLAN — the network *is* the access control, and the bucket configuration can
relax accordingly:

```sh
mc anonymous set-json examples/s3-bucket-policy.json myminio/videoshare
mc admin user add myminio videoshare-uploader videoshare-uploader-secret
mc admin policy create myminio videoshare-uploader examples/iam-uploader-policy.json
mc admin policy attach myminio videoshare-uploader --user videoshare-uploader
```

…and then hand that one upload-only key to everyone on the VPN and stop thinking
about it. It is not a secret in any meaningful sense: it can only write objects
into one bucket, only from inside the perimeter, and there is nothing to rotate
per person and nothing to revoke when someone leaves — you cut their VPN access
instead. In practice this is the zero-credential setup: one line in a wiki page.

**Truly anonymous writes do not work with v1.** Adding `s3:PutObject` for
`Principal: "*"` does make MinIO accept an *unsigned* `PUT`, but VideoShare
uploads through `aws4fetch`, which always signs. MinIO checks the access key
before it consults the anonymous policy, so a signed request with an unknown or
empty key is rejected with `InvalidAccessKeyId` (403) rather than falling through
to the anonymous grant. Verified. Use the shared upload-only key above.

**What you give up either way.** A shared key means uploads are not attributable
— the bucket cannot tell you who recorded what, only that someone on the VPN
did. And a bucket reachable only over the VPN means share links are too: nobody
can watch from a phone on cellular. That is usually the point, but it is worth
saying out loud before you send someone a link that will not open.

---

## Checking your work

Against any provider, from a machine that has no credentials:

```sh
BASE=https://pub-xxxx.r2.dev   # your publicBaseUrl

# Reads work, ranged reads work, listing does not.
curl -s -o /dev/null -w 'get    %{http_code}\n' "$BASE/<some-id>/meta.json"
curl -s -o /dev/null -w 'range  %{http_code}\n' -H 'Range: bytes=0-9' "$BASE/<some-id>/video.bin"
curl -s -o /dev/null -w 'list   %{http_code}\n' "$BASE/?list-type=2"

# Anonymous writes do not.
curl -s -o /dev/null -w 'put    %{http_code}\n' -X PUT --data-binary x "$BASE/probe"

# Preflight is answered for a ranged cross-origin read.
curl -s -o /dev/null -w 'option %{http_code}\n' -X OPTIONS "$BASE/<some-id>/video.bin" \
  -H 'Origin: https://videoshare.example.com' \
  -H 'Access-Control-Request-Method: GET' \
  -H 'Access-Control-Request-Headers: range'
```

Want: `200`, `206`, `403`, `403`, `200`/`204`.

The uploads go to the S3 endpoint rather than the public base URL, and start with
a `POST`, so that preflight is worth checking separately — with `-i`, because a
`204` that omits your method from `Access-Control-Allow-Methods` still fails in
the browser:

```sh
ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com   # what the recorder signs against

curl -s -i -X OPTIONS "$ENDPOINT/videoshare/probe/video.bin?uploads=" \
  -H 'Origin: https://videoshare.example.com' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: authorization,x-amz-content-sha256,x-amz-date'
```

Want a `200`/`204` whose `Access-Control-Allow-Methods` names `POST`. Then record
something short and watch the network tab: one `POST ?uploads`, a `PUT
?partNumber=N&uploadId=…` per 8 MiB, and a final `POST ?uploadId=…`. If the part
`PUT`s succeed but completing fails, the browser is being denied the `ETag` —
`ExposeHeaders` is the thing to fix.

If the recorder reports a 403 on upload, the credentials or their policy are
wrong; a 403 specifically on Discard means the policy is missing
`s3:AbortMultipartUpload`. If it reports a network error with no status, it is
CORS — check the browser console, which will name the method or header it
objected to.
