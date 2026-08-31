output "videos_bucket" {
  description = "Name of the public video bucket (BUCKET_NAME in the worker's vars)."
  value       = cloudflare_r2_bucket.videos.name
}

output "analytics_bucket" {
  description = "Name of the private analytics bucket (ANALYTICS_BUCKET), or null when enable_analytics is false."
  value       = var.enable_analytics ? cloudflare_r2_bucket.analytics[0].name : null
}

output "bucket_endpoint" {
  description = "The S3-compatible endpoint the worker signs against (BUCKET_ENDPOINT). Region is `auto` on R2."
  value       = "https://${var.account_id}.r2.cloudflarestorage.com"
}

output "gateway_url" {
  description = "The value for gatewayUrl in public/config.js, when gateway_hostname is set. Null otherwise — a worker with no custom domain answers on its workers.dev subdomain, which this module does not know."
  value       = var.gateway_hostname == "" ? null : "https://${var.gateway_hostname}/api"
}

output "site_url" {
  description = "Where the static site is served, when site_hostname is set."
  value       = var.site_hostname == "" ? null : "https://${var.site_hostname}"
}

output "cors_rules" {
  description = <<-EOT
    The CORS document to apply to the video bucket, in the R2 API's shape rather
    than S3's. The 4.x provider has no resource for this — write it to a file and
    run `wrangler r2 bucket cors set {videos_bucket} --file cors.json`. Note the
    R2 shape is {"rules":[{"allowed":{...}}]}, not the {"CORSRules":[...]} of
    examples/s3-cors.json; applying the S3 shape here silently does nothing
    useful.

    The origins are site_hostname plus extra_allowed_origins and nothing else.
    localhost is NOT in here by default — this document goes onto the production
    bucket, and a bucket that answers CORS for http://localhost:8080 forever lets
    any page on any developer's laptop read cross-origin responses from it. Set
    extra_allowed_origins while you need it, as in aws/ and gcp/.

    With neither variable set the rule comes out with an empty origins list and
    is useless to a browser. That is this module being told nothing rather than a
    default worth having — if the site lives somewhere Cloudflare does not know
    about (S3 + CloudFront, say), name that origin in extra_allowed_origins.
  EOT
  value = jsonencode({
    rules = [{
      allowed = {
        origins = concat(
          var.site_hostname == "" ? [] : ["https://${var.site_hostname}"],
          var.extra_allowed_origins,
        )
        methods = ["GET", "HEAD", "PUT", "POST", "DELETE"]
        headers = ["*"]
      }
      exposeHeaders = ["ETag", "Content-Length", "Content-Range", "Accept-Ranges"]
      maxAgeSeconds = 3000
    }]
  })
}
