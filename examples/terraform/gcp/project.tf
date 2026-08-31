# disable_on_destroy = false throughout. A `terraform destroy` of this stack must
# not turn off Cloud Run or Cloud Storage for the whole project — other things
# may be using them, and an API that was already on before this module ran is not
# this module's to switch off.
resource "google_project_service" "services" {
  for_each = toset([
    "run.googleapis.com",
    "artifactregistry.googleapis.com",
    "storage.googleapis.com",
    "iam.googleapis.com",
    // build-and-push.sh builds through Cloud Build; without this it fails
    // with SERVICE_DISABLED before the first image exists.
    "cloudbuild.googleapis.com",
  ])

  project = var.project
  service = each.value

  disable_on_destroy         = false
  disable_dependent_services = false
}

# --- The gateway's identity --------------------------------------------------

# One service account with two jobs: it is the Cloud Run revision's identity, and
# it is what the HMAC key below belongs to. Nothing else in the project uses it.
resource "google_service_account" "gateway" {
  account_id   = "${local.name}-gw"
  display_name = "VideoShare gateway (${var.name_suffix})"
  project      = var.project

  depends_on = [google_project_service.services]
}

# THE point of this module.
#
# An HMAC key is a Cloud Storage *interoperability* credential: an access key id
# and a secret that sign requests to the XML API exactly the way an AWS access
# key signs requests to S3. The gateway's presigner is framework-free SigV4 over
# aws4fetch (gateway/src/presign.ts) and it is not modified in any way for Google
# — the whole question this deployment answers is whether that unmodified S3
# client works against Cloud Storage. Google's own documentation says HMAC keys
# exist so you can "reuse your existing code", and that an x-amz-signed request
# from an HMAC key carries the algorithm AWS4-HMAC-SHA256, which is precisely
# what aws4fetch emits.
#
# Bucket authority does NOT come from this key's own grants — an HMAC key
# inherits whatever its service account can do — so the two bucket-scoped IAM
# bindings below are what actually bound it.
resource "google_storage_hmac_key" "gateway" {
  project               = var.project
  service_account_email = google_service_account.gateway.email

  depends_on = [google_project_service.services]
}

# --- Bucket authority, scoped per bucket -------------------------------------

# Bucket-scoped, NOT project-level: a project-level binding would also cover the
# site bucket and every bucket added later.
#
# roles/storage.objectCreator, not objectAdmin — this is the exact translation of
# examples/iam-uploader-policy.json's {s3:PutObject, s3:AbortMultipartUpload},
# and it is worth spelling out because "GCP has no write-only object role" is a
# thing people say and it is only true of objectViewer/objectAdmin. Check it:
#
#   gcloud iam roles describe roles/storage.objectCreator
#
#     storage.objects.create              <- PutObject, incl. the simple PUTs
#     storage.multipartUploads.create     <- CreateMultipartUpload + every part
#     storage.multipartUploads.abort      <- AbortMultipartUpload (Discard)
#     storage.multipartUploads.listParts
#     (plus folders.create and resourcemanager.projects.get/list)
#
# No storage.objects.get and no .list, and that is the property worth keeping: a
# leaked HMAC key cannot download or enumerate a single recording.
#
# What it also lacks is storage.objects.delete, and since docs/SPEC.md §18 that
# is not a saving but a missing feature — the library's Delete video is three
# presigned DELETEs signed with this credential, so without it every delete comes
# back 403 on GCS. The custom role below adds exactly that one permission and
# nothing else.
resource "google_storage_bucket_iam_member" "gateway_videos" {
  bucket = google_storage_bucket.videos.name
  role   = "roles/storage.objectCreator"
  member = google_service_account.gateway.member
}

# storage.objects.delete, on its own.
#
# Every predefined role that carries it (objectUser, objectAdmin) also carries
# storage.objects.get and .list, which the grant above deliberately withholds —
# and trading "cannot read or enumerate anything" for "can delete" would be a
# bad bargain made silently. So this is a custom role of one permission, bound
# per bucket below, and the argument above survives intact.
#
# What the credential can actually do afterwards, in full: create objects, run
# and abandon multipart uploads, and delete objects — in the two buckets it is
# bound to and nowhere else. It still cannot read one, list one, or touch bucket
# configuration. The worst case for a leaked key moves from "write junk" to
# "write junk and destroy recordings"; that is the same trade every provider
# makes for deletion, and docs/storage-setup.md says so for the S3 side.
#
# The role id may hold only letters, digits, underscores and dots — no dashes —
# so the suffix is normalized rather than interpolated raw. Note that a deleted
# custom role is soft-deleted for 7 days: a destroy-then-apply inside that window
# will fail on the id until it is undeleted or the window passes.
resource "google_project_iam_custom_role" "object_deleter" {
  project     = var.project
  role_id     = "videoshare_${replace(var.name_suffix, "-", "_")}_object_deleter"
  title       = "VideoShare object deleter (${var.name_suffix})"
  description = "storage.objects.delete only — SPEC §18's Delete video, and nothing else."
  permissions = ["storage.objects.delete"]
}

resource "google_storage_bucket_iam_member" "gateway_videos_delete" {
  bucket = google_storage_bucket.videos.name
  role   = google_project_iam_custom_role.object_deleter.name
  member = google_service_account.gateway.member
}

# The analytics half needs three things the video half does not: write beacons,
# list them, and sign reads of them — PutObject + GetObject + ListBucket in
# docs/gateway-setup.md §6. objectCreator is the write; objectViewer is
# storage.objects.get + .list and nothing else, so the pair is that policy
# exactly, still without .update.
#
# The read permission is the one people leave out. A presigned URL carries the
# authority of the key that signed it, so without it the gateway signs URLs
# happily and every one comes back 403.
resource "google_storage_bucket_iam_member" "gateway_analytics_write" {
  count = var.enable_analytics ? 1 : 0

  bucket = google_storage_bucket.analytics[0].name
  role   = "roles/storage.objectCreator"
  member = google_service_account.gateway.member
}

resource "google_storage_bucket_iam_member" "gateway_analytics_read" {
  count = var.enable_analytics ? 1 : 0

  bucket = google_storage_bucket.analytics[0].name
  role   = "roles/storage.objectViewer"
  member = google_service_account.gateway.member
}

# The fourth: DELETE /sessions/{videoId} (SPEC §18.4), which is the one delete
# the gateway performs itself rather than signing a URL for — this bucket is
# already its to list, and the objects under a prefix are not enumerable from a
# presigned URL. Without it that route answers 502 and a video's watch data
# outlives the video.
resource "google_storage_bucket_iam_member" "gateway_analytics_delete" {
  count = var.enable_analytics ? 1 : 0

  bucket = google_storage_bucket.analytics[0].name
  role   = google_project_iam_custom_role.object_deleter.name
  member = google_service_account.gateway.member
}

# --- Where the container image lives -----------------------------------------

# ./build-and-push.sh pushes into this repository, and run.tf's Cloud Run service
# will not create until the image it pushed exists — so on a greenfield project
# this one resource has to be applied on its own first:
#
#   terraform apply -target=google_artifact_registry_repository.gateway
#
# See the script's header, or ../README.md.
resource "google_artifact_registry_repository" "gateway" {
  location      = var.region
  repository_id = local.name
  format        = "DOCKER"
  description   = "VideoShare gateway container images"
  project       = var.project
  labels        = var.labels

  depends_on = [google_project_service.services]
}
