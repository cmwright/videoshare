variable "name_suffix" {
  description = <<-EOT
    Short suffix that makes every name in this stack unique. S3 bucket names are
    globally unique across all AWS accounts, so this is not optional in practice
    — six hex characters is enough. Everything is named
    `videoshare-{name_suffix}-{role}`.
  EOT
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,20}$", var.name_suffix))
    error_message = "name_suffix must be 2-21 characters of lowercase letters, digits or dashes, starting with a letter or digit."
  }
}

variable "region" {
  description = "Region for the buckets, the Lambda and the HTTP API. The ACM certificate is always issued in us-east-1 regardless, because CloudFront requires it."
  type        = string
  default     = "us-east-1"
}

variable "site_domain" {
  description = <<-EOT
    Custom domain for the static site, e.g. `share.example.com`. Leave empty to
    skip ACM and CloudFront entirely and serve the site straight off the S3 REST
    endpoint — which is HTTPS and works, just without a domain of your own.

    Setting it does NOT create the DNS records: this module has no authority over
    your zone. It outputs `acm_validation_record` (add that to validate the
    certificate) and `cloudfront_domain` (point the domain at it with a CNAME).
  EOT
  type        = string
  default     = ""
}

variable "allowed_emails" {
  description = <<-EOT
    Who may upload. Each entry is a full address or an `@domain` suffix, matched
    case-insensitively against the verified email in the Google ID token. Joined
    with commas into the gateway's ALLOWED_EMAILS.

    Not a secret — it is the upload whitelist, and it is readable by anyone with
    the Lambda's console. An empty list is rejected by the gateway at first
    request: a gateway nobody may use is a mistake, not an open door.
  EOT
  type        = list(string)

  validation {
    condition     = length(var.allowed_emails) > 0
    error_message = "allowed_emails must list at least one address or @domain suffix."
  }
}

variable "google_client_id" {
  description = "OAuth 2.0 Web application client id from console.cloud.google.com/auth/clients. Public information — every visitor's browser sees it. See docs/gateway-setup.md §1."
  type        = string
}

variable "presign_expiry" {
  description = "Lifetime in seconds of each presigned URL the gateway hands out (PRESIGN_EXPIRY_SECONDS). 1-3600; the gateway refuses anything outside that."
  type        = number
  default     = 900

  validation {
    condition     = var.presign_expiry >= 1 && var.presign_expiry <= 3600
    error_message = "presign_expiry must be between 1 and 3600 seconds."
  }
}

variable "enable_analytics" {
  description = "Create the private analytics bucket and set ANALYTICS_BUCKET (docs/SPEC.md §16). False is a supported configuration, not a broken one: /api/config answers analytics:false and the player sends nothing."
  type        = bool
  default     = true
}

variable "lambda_zip" {
  description = "Path to the deployment package built by ./build.sh — dist/, package.json and the production node_modules. Relative paths resolve against the directory terraform runs in."
  type        = string
  default     = "gateway.zip"
}

variable "extra_allowed_origins" {
  description = <<-EOT
    Additional origins allowed to call the gateway from a browser, on top of the
    site origins this module already knows about (the S3 REST endpoint, and
    https://{site_domain} when set). Add `http://localhost:8080` here while you
    are testing a local build against the deployed gateway.

    Never `*` — the gateway refuses it at boot. A wildcard would let any page on
    the internet spend these bucket credentials on behalf of a signed-in user.
  EOT
  type        = list(string)
  default     = []
}

variable "tags" {
  description = "Tags applied to every resource that takes them."
  type        = map(string)
  default     = {}
}
