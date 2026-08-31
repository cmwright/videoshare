output "site_url" {
  description = "Where to open the recorder. The S3 REST endpoint serves an object at its key, so index.html is named explicitly; a CloudFront distribution has a default root object and does not need it."
  value       = local.use_custom_domain ? "https://${var.site_domain}" : "${local.site_rest_origin}/index.html"
}

output "gateway_url" {
  description = "The value for gatewayUrl in public/config.js. Includes the /api prefix the recorder expects."
  value       = "${aws_apigatewayv2_api.gateway.api_endpoint}/api"
}

output "public_base_url" {
  description = "The value for publicBaseUrl in public/config.js — where the video bucket is publicly readable. Must match the gateway's PUBLIC_BASE_URL, which this module already set."
  value       = "https://${aws_s3_bucket.videos.id}.s3.${var.region}.amazonaws.com"
}

output "videos_bucket" {
  description = "Name of the public video bucket (BUCKET_NAME)."
  value       = aws_s3_bucket.videos.id
}

output "analytics_bucket" {
  description = "Name of the private analytics bucket (ANALYTICS_BUCKET), or null when enable_analytics is false."
  value       = var.enable_analytics ? aws_s3_bucket.analytics[0].id : null
}

output "site_bucket" {
  description = "Name of the bucket to upload dist/ into: `aws s3 sync dist/ s3://{this}/ --delete`."
  value       = aws_s3_bucket.site.id
}

output "allowed_origins" {
  description = "The origins the gateway will accept and the buckets will answer CORS for. Add each of these to the Google OAuth client id's authorized JavaScript origins by hand — that part is not automatable from here."
  value       = local.site_origins
}

output "acm_validation_record" {
  description = "The DNS record that validates the certificate. Add it in whatever manages your zone, then apply again. Null when site_domain is empty."
  value = local.use_custom_domain ? {
    name  = one(aws_acm_certificate.site[0].domain_validation_options).resource_record_name
    type  = one(aws_acm_certificate.site[0].domain_validation_options).resource_record_type
    value = one(aws_acm_certificate.site[0].domain_validation_options).resource_record_value
  } : null
}

output "cloudfront_domain" {
  description = "The distribution's own hostname. Point site_domain at it with a CNAME. Null when site_domain is empty."
  value       = local.use_custom_domain ? aws_cloudfront_distribution.site[0].domain_name : null
}

output "gateway_access_key_id" {
  description = "Access key id the gateway signs with. Already in the Lambda's environment; here for the one case where you need to check what is deployed."
  value       = aws_iam_access_key.gateway.id
}
