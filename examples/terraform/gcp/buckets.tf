locals {
  name = "videoshare-${var.name_suffix}"

  site_bucket      = "${local.name}-site"
  videos_bucket    = "${local.name}-videos"
  analytics_bucket = "${local.name}-analytics"

  # A public GCS object is served from https://storage.googleapis.com/{bucket}/{key},
  # so a site hosted this way has the ORIGIN https://storage.googleapis.com — the
  # bucket is a path segment, and a path is not part of an origin.
  #
  # Say the consequence out loud: that origin is shared with every other publicly
  # readable bucket in Google Cloud, so ALLOWED_ORIGINS on this deployment is a
  # much weaker statement than a domain of your own would be. Anyone who can put
  # a page in any public GCS bucket can call this gateway from it. That is
  # acceptable for a validation stack; for production put the site behind a
  # hostname you control and list that instead.
  site_origin = "https://storage.googleapis.com"

  site_origins = concat([local.site_origin], var.extra_allowed_origins)

  # GCS has ONE header list — `responseHeader` — and it does both of S3's jobs:
  # it is the `Access-Control-Allow-Headers` of a preflight response AND the
  # `Access-Control-Expose-Headers` of a real one. So `examples/s3-cors.json`'s
  # split of AllowedHeaders/ExposeHeaders collapses into this single union, and
  # its `"AllowedHeaders": ["*"]` has no equivalent: Google documents `*` for
  # `origin` and nowhere else. An undocumented wildcard in the one field the
  # multipart complete depends on is not something to discover in production —
  # if GCS matched it literally every part preflight would fail, and if it
  # echoed a literal `Access-Control-Expose-Headers: *` the completing POST
  # could not read part ETags on Safari < 16.4. Both halves are spelled out.
  #
  # What the browser must be allowed to READ. ETag is the load-bearing one: the
  # completing POST lists back the tag every part response returned, and a
  # response header the browser may not read might as well not have been sent.
  # The other three are the player's ranged reads.
  #
  # What the browser is allowed to SEND. `Range` is the player streaming
  # video.bin chunk by chunk. `Content-Type` rides every part PUT. The last
  # three are SPEC §7's credentials-in-the-browser mode, where aws4fetch signs
  # into headers rather than into the query string — the gateway mode signs into
  # the URL and sends none of them, but both modes read and write this same
  # bucket. docs/storage-setup.md's preflight checks send exactly these:
  #
  #   -H 'Access-Control-Request-Headers: range'
  #   -H 'Access-Control-Request-Headers: authorization,x-amz-content-sha256,x-amz-date'
  cors_response_headers = [
    "ETag",
    "Content-Length",
    "Content-Range",
    "Accept-Ranges",
    "Content-Type",
    "Range",
    "Authorization",
    "x-amz-content-sha256",
    "x-amz-date",
  ]
}

# --- The static site ---------------------------------------------------------

# force_destroy is true here: dist/ is build output. The two buckets below hold
# recordings and take the opposite stance.
resource "google_storage_bucket" "site" {
  name     = local.site_bucket
  location = upper(var.region)
  project  = var.project

  # Uniform access everywhere: object ACLs are a second, per-object permission
  # system that would quietly outrank the bucket policy below.
  uniform_bucket_level_access = true

  # "inherited" rather than "enforced" — the allUsers binding below is the point
  # of this bucket, and "enforced" would refuse it.
  public_access_prevention = "inherited"

  force_destroy = true
  labels        = var.labels

  depends_on = [google_project_service.services]
}

# legacyObjectReader, not objectViewer — see the note on the video bucket below.
# The same role is used for both so there is only one thing to remember.
resource "google_storage_bucket_iam_member" "site_public" {
  bucket = google_storage_bucket.site.name
  role   = "roles/storage.legacyObjectReader"
  member = "allUsers"
}

# --- The video bucket --------------------------------------------------------

# force_destroy stays false. This bucket holds every recording anyone has ever
# shared a link to, and share links are permanent — `terraform destroy` should
# stop here rather than take the videos with it.
resource "google_storage_bucket" "videos" {
  name     = local.videos_bucket
  location = upper(var.region)
  project  = var.project

  uniform_bucket_level_access = true
  public_access_prevention    = "inherited"

  # Same rules as examples/s3-cors.json, narrowed from "*" to the real origins
  # and with the header list spelled out — see cors_response_headers above for
  # why there is no wildcard here.
  #
  # DELETE matters as much as PUT, and carries two things rather than one:
  # without it the recorder's Discard (AbortMultipartUpload) never leaves the
  # browser and its already-uploaded parts sit in the bucket until the lifecycle
  # rule below sweeps them, and the library's Delete video — three DELETEs to
  # presigned URLs from this same origin (SPEC §18.3) — fails on its preflight
  # with no HTTP status at all. One rule covers both, so deletion needed no CORS
  # change here.
  cors {
    origin          = local.site_origins
    method          = ["GET", "HEAD", "PUT", "POST", "DELETE"]
    response_header = local.cors_response_headers
    max_age_seconds = 3000
  }

  # GCS implements the S3-compatible AbortIncompleteMultipartUpload lifecycle
  # action directly, so this is the same rule the AWS module writes rather than
  # a per-provider workaround. Only `age`, `matches_prefix` and `matches_suffix`
  # may be combined with it; anything else is rejected.
  lifecycle_rule {
    action {
      type = "AbortIncompleteMultipartUpload"
    }
    condition {
      age = 1
    }
  }

  force_destroy = false
  labels        = var.labels

  depends_on = [google_project_service.services]
}

# Anonymous reads of objects, and nothing else.
#
# NOT roles/storage.objectViewer, which is what most "make a GCS bucket public"
# instructions say. That role carries storage.objects.LIST as well as .get, and
# granting it to allUsers makes the bucket anonymously listable — which
# docs/storage-setup.md rules out in as many words: video ids are 128 random bits
# and the whole sharing model rests on them being unguessable, so a listable
# bucket hands over every id at once.
#
# roles/storage.legacyObjectReader is exactly one permission, storage.objects.get
# — `gcloud iam roles describe` either role to see the difference — which is
# examples/s3-bucket-policy.json translated faithfully. Verify after apply:
#
#   curl -s -o /dev/null -w '%{http_code}\n' \
#     'https://storage.googleapis.com/{videos_bucket}?list-type=2'   # want 403
resource "google_storage_bucket_iam_member" "videos_public" {
  bucket = google_storage_bucket.videos.name
  role   = "roles/storage.legacyObjectReader"
  member = "allUsers"
}

# --- The analytics bucket ----------------------------------------------------

# SPEC §16.4. PRIVATE: no allUsers binding, deliberately and by omission, and
# public access prevention is enforced so one cannot be added by accident. The
# video bucket is world-readable because share links must work without
# credentials; this one must not be, or every session object would be
# downloadable by anyone who guessed a video id.
resource "google_storage_bucket" "analytics" {
  count = var.enable_analytics ? 1 : 0

  name     = local.analytics_bucket
  location = upper(var.region)
  project  = var.project

  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  # GET and HEAD only. Writes need no CORS — the gateway performs those
  # server-side — but the recorder page fetches session objects straight from
  # their presigned URLs, so the browser does a cross-origin GET against this
  # bucket. The same header list as the video bucket, so there is one thing to
  # remember rather than two lists to drift apart.
  cors {
    origin          = local.site_origins
    method          = ["GET", "HEAD"]
    response_header = local.cors_response_headers
    max_age_seconds = 3000
  }

  force_destroy = false
  labels        = var.labels

  depends_on = [google_project_service.services]
}
