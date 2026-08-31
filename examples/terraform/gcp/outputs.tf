output "site_url" {
  description = "Where to open the recorder. A public GCS object is served at {bucket}/{key}, so index.html is named explicitly — there is no directory index on this endpoint."
  value       = "https://storage.googleapis.com/${google_storage_bucket.site.name}/index.html"
}

output "gateway_url" {
  description = "The value for gatewayUrl in public/config.js. Includes the /api prefix the recorder expects."
  value       = "${google_cloud_run_v2_service.gateway.uri}/api"
}

output "public_base_url" {
  description = "The value for publicBaseUrl in public/config.js — where the video bucket is publicly readable. Matches the gateway's PUBLIC_BASE_URL, which this module already set."
  value       = "https://storage.googleapis.com/${google_storage_bucket.videos.name}"
}

output "site_bucket" {
  description = "Bucket to upload dist/ into: `gcloud storage rsync -r dist gs://{this}`."
  value       = google_storage_bucket.site.name
}

output "videos_bucket" {
  description = "Name of the public video bucket (BUCKET_NAME)."
  value       = google_storage_bucket.videos.name
}

output "analytics_bucket" {
  description = "Name of the private analytics bucket (ANALYTICS_BUCKET), or null when enable_analytics is false."
  value       = var.enable_analytics ? google_storage_bucket.analytics[0].name : null
}

output "service_account_email" {
  description = "The gateway's service account. The Cloud Run revision runs as it, and the HMAC key belongs to it."
  value       = google_service_account.gateway.email
}

output "artifact_registry_repository" {
  description = "Docker repository the build script pushes to."
  value       = google_artifact_registry_repository.gateway.name
}

output "gateway_image" {
  description = "The image reference the Cloud Run service is pinned to. Pass this to ./build-and-push.sh, or let the script compute the same string."
  value       = local.gateway_image
}

output "allowed_origins" {
  description = "The origins the gateway will accept and the buckets will answer CORS for. Add each to the Google OAuth client id's authorized JavaScript origins by hand."
  value       = local.site_origins
}

output "hmac_access_id" {
  description = "The interoperability access key id the gateway signs with (BUCKET_ACCESS_KEY_ID). The secret is in the Cloud Run environment and is not output."
  value       = google_storage_hmac_key.gateway.access_id
}
