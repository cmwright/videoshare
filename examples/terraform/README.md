# Terraform

Three root configurations, one per provider. Each is standalone: its own
`terraform init`, its own state, no shared modules and nothing to wire between
them. Pick the one you are deploying to and ignore the other two.

They build what [`docs/storage-setup.md`](../../docs/storage-setup.md) and
[`docs/gateway-setup.md`](../../docs/gateway-setup.md) walk you through by hand.
Those documents are still the explanation of *why* each rule is there; this is
the same set of rules in a form that can be applied twice.

| | Builds | Verified |
| --- | --- | --- |
| [`aws/`](aws) | Three S3 buckets, a scoped IAM user, the gateway as a Lambda behind an HTTP API, and optionally ACM + CloudFront for a custom domain | `plan` against a real account, 26 resources |
| [`gcp/`](gcp) | Three GCS buckets, a service account with an interoperability HMAC key, Artifact Registry, the gateway on Cloud Run | `plan` against project `videoshare-506902`, 17 resources |
| [`cloudflare/`](cloudflare) | Two R2 buckets, the gateway worker's custom domain, the Pages custom domain, and any loose DNS records | `plan` with a placeholder token, 4 resources |

Everything is pinned: `terraform >= 1.5`, `aws ~> 5`, `google ~> 7`,
`cloudflare ~> 4`. The 4.x line of the Cloudflare provider is deliberate — 5.x
is a rewrite with different resource names, and the 1.5.7 CLI these were
authored against resolves 4.x.

None of the three creates a Google OAuth client. That stays manual, in all
three, and it is the first thing to do: `docs/gateway-setup.md` §1.

---

## `aws/`

```sh
cd examples/terraform/aws
./build.sh                       # -> gateway.zip
cp terraform.tfvars.example terraform.tfvars   # and edit
terraform init
terraform apply
```

`build.sh` compiles the gateway and packages it: `dist/`, `package.json` (for
its `"type": "module"` — without it the runtime reads the output as CommonJS and
every import fails), and the production `node_modules`, which is two packages.
It stages the production install in a temp directory, so it never prunes the dev
dependencies out from under whoever is working on `gateway/`.

The stack is:

- **`videoshare-{suffix}-site`** — public `GetObject`, holds `dist/`. Served over
  the S3 REST endpoint, which is HTTPS; the S3 *website* endpoint is HTTP-only
  and a page served over it cannot use `crypto.subtle` or hold a Google sign-in.
- **`videoshare-{suffix}-videos`** — public `GetObject`, CORS for all five
  methods the recorder uses, and a lifecycle rule that aborts incomplete
  multipart uploads after a day.
- **`videoshare-{suffix}-analytics`** — private, `GET`/`HEAD` CORS only, created
  when `enable_analytics` is true.
- An **IAM user** whose whole policy is `PutObject` + `AbortMultipartUpload` on
  the video bucket, `PutObject` + `GetObject` on the analytics bucket, and
  `ListBucket` on the analytics bucket itself. Its access key goes into the
  Lambda's environment and nowhere else.
- The **gateway**, `nodejs22.x`, handler `dist/lambda.handler`, 256 MB, 15 s.

### Why an HTTP API and not a function URL

`docs/gateway-setup.md` §3 describes a Lambda function URL, and that is the
simpler shape. On the account this was validated against, every request to one
came back `403` despite auth type `NONE` and a correct `lambda:InvokeFunctionUrl`
resource policy for principal `*` — most likely an organisation-level control,
and not something the function's own configuration can override. An HTTP API
with a `$default` route works and speaks the same **payload format 2.0** the
adapter reads. (An API Gateway *REST* proxy sends 1.0 and will not work.)

The API carries no `cors_configuration`. The gateway answers preflights itself
and refuses an `Origin` that is not in `ALLOWED_ORIGINS`; an API-level CORS block
would either shadow that with a looser policy or send two
`Access-Control-Allow-Origin` headers, which browsers reject outright.

### The custom domain is two applies

`site_domain = ""` skips ACM and CloudFront entirely — the site is then served
from the S3 REST endpoint, over HTTPS, without a domain of your own. That is a
complete deployment.

With `site_domain` set, the certificate has to be validated by a DNS record this
module cannot create, so:

```sh
terraform apply -target=aws_acm_certificate.site
terraform output acm_validation_record        # add this CNAME to your zone
terraform apply                               # blocks until validation lands
terraform output cloudfront_domain            # point site_domain at it, CNAME
```

If your zone is on Cloudflare, `cloudflare/`'s `dns_records` variable takes both
of those records. Otherwise it is two clicks in whatever holds your DNS.

## `gcp/`

```sh
cd examples/terraform/gcp
cp validation.auto.tfvars.example terraform.tfvars   # and edit
terraform init
terraform apply -target=google_artifact_registry_repository.gateway
./build-and-push.sh <project> us-central1 <suffix>
terraform apply
```

### The first deploy is two applies

Cloud Run pulls the image while the service is being created, so a revision that
cannot pull is a failed apply rather than a pending one — the image must exist
first. But the image lives in an Artifact Registry repository this module also
creates, so on a greenfield project neither half can go first. Applying that one
resource on its own breaks the cycle; it is the same shape as `aws/`'s ACM
dance, and `build-and-push.sh` checks for the repository before it builds
anything so a forgotten `-target` costs a second rather than an `npm ci`.

Every later deploy is two commands: `./build-and-push.sh …` then
`terraform apply`.

### Why `gcloud builds submit` and not `docker buildx`

Two reasons. Cloud Run runs `linux/amd64` and this repository is developed on
Apple Silicon, where a plain `docker build` produces an arm64 image Cloud Run
rejects; and Cloud Build needs no local daemon and no
`gcloud auth configure-docker`, so the only prerequisite is the login Terraform
already needs. The cost is that the Cloud Build API has to be enabled and
billable on the project — `gcloud` offers to enable it the first time. The
`docker buildx` equivalent is in the script's header comment if you would rather
build locally. `Dockerfile` lives beside the module rather than in `gateway/`,
because it is one deployment target's packaging and not part of the package.

The point of this module is the **HMAC key**. A Cloud Storage HMAC key is an
access key id and a secret that sign XML API requests exactly the way an AWS
access key signs S3 requests, and the gateway's presigner
(`gateway/src/presign.ts`) is not modified in any way for Google — the S3 client
runs unchanged against `https://storage.googleapis.com`.

Two values needed pinning, and both are commented in the source:

- **`BUCKET_ENDPOINT = https://storage.googleapis.com`.** Google's
  interoperability documentation says to "change the request endpoint that the
  tool or library uses to the Cloud Storage URI `https://storage.googleapis.com`".
  Path-style URLs — `{endpoint}/{bucket}/{key}` — are what `presign.ts` builds
  and what this endpoint serves.
- **`BUCKET_REGION = {bucket location}`.** The region goes into the SigV4
  credential scope. Cloud Storage documents the field as free: *"For Cloud
  Storage resources, you can use any value for LOCATION. The recommended value
  to use is the location associated with the resource that the signature applies
  to. For example, `us-central1`. This parameter exists to maintain
  compatibility with Amazon S3."* So `auto` — the gateway's default, and the
  right answer for R2 — would be accepted today. The bucket's own location is
  set anyway, because it is what Google recommends and the only value that stays
  correct if Cloud Storage ever starts checking the scope.

Two more things worth knowing before you use this shape for anything but a
validation run:

- **The site's origin is `https://storage.googleapis.com`.** A public GCS object
  is served at `{host}/{bucket}/{key}`, and a path is not part of an origin — so
  a site hosted this way shares its origin with every other publicly readable
  bucket in Google Cloud. `ALLOWED_ORIGINS` is a much weaker statement here than
  it is anywhere else. For production, put the site behind a hostname you
  control and list that.
- **The public bucket binding is `roles/storage.legacyObjectReader`, not
  `roles/storage.objectViewer`.** Nearly every "make a GCS bucket public"
  instruction says `objectViewer`; that role carries `storage.objects.list` as
  well as `.get`, and granting it to `allUsers` makes the bucket anonymously
  listable — which `docs/storage-setup.md` rules out in as many words, because
  video ids are 128 random bits and the sharing model rests on them being
  unguessable. `legacyObjectReader` is exactly one permission,
  `storage.objects.get`.
- **The gateway's own binding is `roles/storage.objectCreator`, not
  `objectAdmin`.** "GCP has no write-only object role" is a common thing to say
  and it is only true of `objectViewer`/`objectAdmin`. `objectCreator` is
  `storage.objects.create` plus `storage.multipartUploads.create/abort/listParts`
  — `gcloud iam roles describe roles/storage.objectCreator` — which is the AWS
  module's `PutObject` + `AbortMultipartUpload` exactly, with no `get`, no `list`
  and no `delete`. A leaked HMAC key can write recordings and abandon uploads and
  nothing else. The analytics bucket adds `objectViewer` on top, which is the
  `GetObject` + `ListBucket` the beacon reads need and still no `delete`.

The four APIs the module enables (`run`, `artifactregistry`, `storage`, `iam`)
are all `disable_on_destroy = false`. A destroy of this stack must not switch
Cloud Run off for the whole project.

## `cloudflare/`

This one is written to be **imported into**, not applied greenfield: the
production deployment already exists. Every resource carries its
`terraform import` line as a comment.

```sh
export CLOUDFLARE_API_TOKEN=...
cd examples/terraform/cloudflare
cp terraform.tfvars.example terraform.tfvars   # and edit
terraform init

terraform import cloudflare_r2_bucket.videos         <account_id>/videoshare
terraform import 'cloudflare_r2_bucket.analytics[0]' <account_id>/videoshare-analytics
terraform plan                                       # want: no changes
```

It plans without a real token — the provider authenticates lazily and a
create-only plan reads nothing — so you can check the shape before you have
credentials. Import obviously does not.

### The worker stays on `wrangler deploy`

This is the honest answer rather than the tidy one.

`cloudflare_worker_script` in the 4.x provider takes the script as a **single
`content` string**. The gateway is multi-file ESM — `worker.ts` imports
`core.ts`, which imports `auth.ts`, `presign.ts` and `analytics.ts` — plus two
npm dependencies, `jose` and `aws4fetch`. Putting it through Terraform means
adding a bundler to `gateway/` whose output has to match what wrangler's own
esbuild produces, and the provider has open issues on both halves of exactly
this (multi-file scripts, and ESM upload). Meanwhile `wrangler deploy` already
owns the compatibility date, the bindings, the secrets, and `wrangler tail` for
reading the logs.

So Terraform manages the buckets and the hostnames, and the script is deployed
the way `docs/gateway-setup.md` §3 says. If that ever changes it will be because
the provider grew a resource that models a module worker, not because this
config got cleverer.

### What the provider cannot do

Both of these are 4.x gaps, and both are load-bearing — the deployment does not
work without them:

- **R2 CORS.** `cloudflare_r2_bucket` is three fields and there is no CORS
  sub-resource. The `cors_rules` output prints the document in the R2 API's shape
  — `{"rules":[{"allowed":{…}}]}`, *not* the `{"CORSRules":[…]}` of
  `examples/s3-cors.json`; applying the S3 shape silently does nothing useful:

  ```sh
  terraform output -raw cors_rules > cors.json
  npx wrangler r2 bucket cors set videoshare --file cors.json
  ```

- **The R2 lifecycle rule.** R2 applies a default that expires multipart uploads
  after seven days, which is longer than VideoShare needs:

  ```sh
  npx wrangler r2 bucket lifecycle add videoshare abort-incomplete-multipart
  ```

- **The video bucket's public custom domain.** Attaching `videos.example.com` to
  a bucket is an R2 API call the provider does not model, and it is what creates
  the proxied DNS record — which is why that hostname is not in `dns_records`.
  Dashboard → R2 → bucket → Settings → Public access.

### `dns_records` is not for the three hostnames

Pages custom domains, Worker custom domains and R2 custom domains each create
and own their own proxied `CNAME`. A `cloudflare_record` for the same name
fights them on every apply. `dns_records` is for records that belong to nothing
else — most usefully the ACM validation `CNAME` and the CloudFront alias the
`aws/` module hands you.

---

## What stays manual

Four things, in every module:

1. **The Google OAuth client.** Create it, and add every origin from the
   `allowed_origins` output to its authorized JavaScript origins, byte for byte.
   A sign-in that fails with `origin_mismatch` is always this.
2. **`public/config.js`.** The `gateway_url` and `public_base_url` outputs are
   the two values it holds. The file is copied verbatim into `dist/`, so a built
   site can be repointed without rebuilding.
3. **Uploading `dist/`.** `aws s3 sync dist/ s3://{site_bucket}/ --delete`, or
   `gcloud storage rsync -r dist gs://{site_bucket}`. On Cloudflare the Pages
   project deploys itself from Git.
4. **The two build scripts.** `aws/build.sh` and `gcp/build-and-push.sh` produce
   artefacts Terraform consumes; neither runs from an apply, on purpose — a
   `terraform plan` that shells out to `npm ci` is not a plan.

And two smoke tests that no amount of infrastructure code can stand in for:
`docs/gateway-setup.md` §5 (record something with **more than one part** before
anyone depends on the bucket) and §6's one real beacon on a Lambda deployment.

## Destroying

**The video and analytics buckets are `force_destroy = false`, deliberately.**
They hold every recording anyone has ever shared a link to, and share links are
permanent. `terraform destroy` will stop with a bucket-not-empty error, which is
the intended behaviour: empty them yourself when you mean it.

```sh
aws s3 rm s3://videoshare-{suffix}-videos --recursive
gcloud storage rm -r gs://videoshare-{suffix}-videos/**
```

The site buckets are `force_destroy = true` — `dist/` is build output and a
destroy that refuses because the site still holds its own files is friction and
nothing else.

**CloudFront takes about fifteen minutes to destroy.** The provider disables the
distribution, waits for that change to finish deploying to every edge, and only
then deletes it. It is not stuck.

**On Cloudflare, run `terraform destroy` BEFORE deleting the worker with
wrangler.** Deleting the worker also deletes its custom domain, and the
provider then errors reading the orphaned `cloudflare_workers_domain` instead
of treating it as gone — the recovery is `terraform state rm` on that address.
Destroy first and the ordering never comes up.

**The GCP module leaves its four APIs enabled.** `disable_on_destroy = false`
throughout: an API that was already on before this module ran is not this
module's to switch off.
