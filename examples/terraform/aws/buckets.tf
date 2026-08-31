locals {
  name = "videoshare-${var.name_suffix}"

  site_bucket      = "${local.name}-site"
  videos_bucket    = "${local.name}-videos"
  analytics_bucket = "${local.name}-analytics"

  # The S3 REST endpoint, not the website endpoint: the website endpoint is
  # HTTP-only, and a page served over HTTP cannot use crypto.subtle or hold a
  # Google sign-in. The REST endpoint is HTTPS and serves an object at its key,
  # which is all a static site with relative asset paths needs.
  site_rest_origin = "https://${local.site_bucket}.s3.${var.region}.amazonaws.com"

  # Everywhere the browser reports an Origin: the gateway's ALLOWED_ORIGINS, the
  # video bucket's CORS, and the analytics bucket's. One list so they cannot
  # drift apart. Add these to the Google client id's authorized JavaScript
  # origins too — that part stays manual.
  site_origins = concat(
    [local.site_rest_origin],
    var.site_domain == "" ? [] : ["https://${var.site_domain}"],
    var.extra_allowed_origins,
  )
}

# --- The static site ---------------------------------------------------------

# force_destroy is true here on purpose: dist/ is build output, and a `terraform
# destroy` that refuses because the site still holds its own files would be
# nothing but friction. The two buckets below hold recordings and take the
# opposite stance.
resource "aws_s3_bucket" "site" {
  bucket        = local.site_bucket
  force_destroy = true
  tags          = var.tags
}

# S3 blocks public bucket policies on new buckets. Lift only that one flag and
# leave both ACL blocks on — VideoShare never uses ACLs.
resource "aws_s3_bucket_public_access_block" "site" {
  bucket                  = aws_s3_bucket.site.id
  block_public_acls       = true
  ignore_public_acls      = true
  block_public_policy     = false
  restrict_public_buckets = false
}

resource "aws_s3_bucket_policy" "site" {
  bucket = aws_s3_bucket.site.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "PublicReadObjectsOnly"
      Effect    = "Allow"
      Principal = "*"
      Action    = ["s3:GetObject"]
      Resource  = ["${aws_s3_bucket.site.arn}/*"]
    }]
  })

  # The block must be lifted before the policy is accepted.
  depends_on = [aws_s3_bucket_public_access_block.site]
}

# --- The video bucket --------------------------------------------------------

# force_destroy stays false. This bucket holds every recording anyone has ever
# shared a link to, and share links are permanent — `terraform destroy` should
# stop here and make you empty it deliberately rather than take the videos with
# it. Change this only when you mean it.
resource "aws_s3_bucket" "videos" {
  bucket        = local.videos_bucket
  force_destroy = false
  tags          = var.tags
}

resource "aws_s3_bucket_public_access_block" "videos" {
  bucket                  = aws_s3_bucket.videos.id
  block_public_acls       = true
  ignore_public_acls      = true
  block_public_policy     = false
  restrict_public_buckets = false
}

# Anonymous GetObject on objects only — no ListBucket, so `GET /?list-type=2`
# stays a 403. Video ids are 128 random bits and the sharing model rests on them
# being unguessable; a listable bucket hands over every id at once. Everything
# the bucket serves is AES-GCM ciphertext, so "public" here means public
# ciphertext. Mirrors examples/s3-bucket-policy.json.
resource "aws_s3_bucket_policy" "videos" {
  bucket = aws_s3_bucket.videos.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "PublicReadObjectsOnly"
      Effect    = "Allow"
      Principal = "*"
      Action    = ["s3:GetObject"]
      Resource  = ["${aws_s3_bucket.videos.arn}/*"]
    }]
  })

  depends_on = [aws_s3_bucket_public_access_block.videos]
}

# Mirrors examples/s3-cors.json, narrowed from "*" to the real site origins.
#
# DELETE matters as much as PUT: the recorder streams video.bin as an S3
# multipart upload — POST to create, a PUT per 8 MiB part, POST to complete —
# and a DELETE to abandon it when you press Discard. Leave DELETE out and the
# abort's preflight fails, the recorder swallows it (the abort is best-effort by
# design), and the parts already uploaded sit in the bucket, billed and invisible
# to a plain listing, until the lifecycle rule below sweeps them.
#
# ETag in expose_headers is what lets the completing POST list back the tag every
# part response returned. A response header the browser is not allowed to read
# might as well not have been sent.
resource "aws_s3_bucket_cors_configuration" "videos" {
  bucket = aws_s3_bucket.videos.id

  cors_rule {
    allowed_origins = local.site_origins
    allowed_methods = ["GET", "HEAD", "PUT", "POST", "DELETE"]
    allowed_headers = ["*"]
    expose_headers  = ["ETag", "Content-Length", "Content-Range", "Accept-Ranges"]
    max_age_seconds = 3000
  }
}

# S3 never cleans up abandoned multipart uploads on its own. A tab closed
# mid-recording leaves its parts in the bucket; they are charged as storage and
# `list-objects` does not show them. A day is generous — the recorder aborts its
# own upload on Discard, so this only catches the ones that never got the chance.
resource "aws_s3_bucket_lifecycle_configuration" "videos" {
  bucket = aws_s3_bucket.videos.id

  rule {
    id     = "abort-incomplete-multipart-uploads"
    status = "Enabled"

    # An empty filter is the whole bucket. Provider 5 requires filter or prefix
    # on every rule; an omitted one is an apply-time error, not a plan-time one.
    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

# --- The analytics bucket ----------------------------------------------------

# SPEC §16.4. One small encrypted object per viewing session, and it is PRIVATE:
# no public access block is lifted and no bucket policy is attached, deliberately
# and by omission. The video bucket is world-readable because share links must
# work without credentials; this one must not be, or every session object would
# be downloadable by anyone who guessed a video id. The gateway refuses to start
# if ANALYTICS_BUCKET names the same bucket as BUCKET_NAME for exactly that
# reason.
resource "aws_s3_bucket" "analytics" {
  count = var.enable_analytics ? 1 : 0

  bucket        = local.analytics_bucket
  force_destroy = false
  tags          = var.tags
}

resource "aws_s3_bucket_public_access_block" "analytics" {
  count = var.enable_analytics ? 1 : 0

  bucket                  = aws_s3_bucket.analytics[0].id
  block_public_acls       = true
  ignore_public_acls      = true
  block_public_policy     = true
  restrict_public_buckets = true
}

# GET and HEAD only, and nothing else. Writes need no CORS at all — the gateway
# performs those server-side — but the recorder page fetches session objects
# straight from their presigned URLs, so the browser does a cross-origin GET
# against this bucket.
resource "aws_s3_bucket_cors_configuration" "analytics" {
  count = var.enable_analytics ? 1 : 0

  bucket = aws_s3_bucket.analytics[0].id

  cors_rule {
    allowed_origins = local.site_origins
    allowed_methods = ["GET", "HEAD"]
    allowed_headers = ["*"]
    expose_headers  = ["ETag", "Content-Length", "Content-Range", "Accept-Ranges"]
    max_age_seconds = 3000
  }
}
