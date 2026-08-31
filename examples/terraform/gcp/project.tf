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
# No storage.objects.get, no .list, no .delete. So a leaked HMAC key writes and
# abandons uploads and can do nothing else — the same worst case as the AWS
# user's leaked access key, rather than "download and delete every recording".
#
# The one thing objects.delete would buy is overwriting an existing object on
# complete; video ids are 128 random bits and every key is written once, which is
# the same reason the AWS policy has no s3:DeleteObject either.
resource "google_storage_bucket_iam_member" "gateway_videos" {
  bucket = google_storage_bucket.videos.name
  role   = "roles/storage.objectCreator"
  member = google_service_account.gateway.member
}

# The analytics half needs three things the video half does not: write beacons,
# list them, and sign reads of them — PutObject + GetObject + ListBucket in
# docs/gateway-setup.md §6. objectCreator is the write; objectViewer is
# storage.objects.get + .list and nothing else, so the pair is that policy
# exactly, still without .delete or .update.
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
