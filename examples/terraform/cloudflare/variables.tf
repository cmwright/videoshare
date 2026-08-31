variable "api_token" {
  description = <<-EOT
    Cloudflare API token. Defaults to the CLOUDFLARE_API_TOKEN environment
    variable, which is where it should live — a token in a tfvars file is a
    token in someone's shell history.

    It needs, at minimum: Account / Workers R2 Storage / Edit (the buckets),
    Zone / DNS / Edit (records), and Account / Workers Scripts / Edit if you
    manage the worker's custom domain here. An R2 *object* token — the one the
    gateway signs with — cannot do any of this.
  EOT
  type        = string
  default     = null
  sensitive   = true
}

variable "account_id" {
  description = "Cloudflare account id that owns the R2 buckets and the worker."
  type        = string
}

variable "zone_id" {
  description = "Zone id for the domain the site, videos and gateway hostnames live under. Empty disables everything DNS-shaped in this module."
  type        = string
  default     = ""
}

variable "videos_bucket" {
  description = "R2 bucket holding the encrypted recordings (BUCKET_NAME). World-readable through its custom domain."
  type        = string
  default     = "videoshare"
}

variable "analytics_bucket" {
  description = "R2 bucket holding encrypted playback analytics (ANALYTICS_BUCKET). Must stay PRIVATE — never attach a public domain to it."
  type        = string
  default     = "videoshare-analytics"
}

variable "enable_analytics" {
  description = "Create the analytics bucket (docs/SPEC.md §16). False is a supported configuration."
  type        = bool
  default     = true
}

variable "bucket_location" {
  description = "R2 location hint: WNAM, ENAM, WEUR, EEUR, APAC or OC. Null lets Cloudflare choose, which is what the dashboard does. Changing it on an existing bucket forces a replacement — leave it null when importing."
  type        = string
  default     = null
}

variable "worker_name" {
  description = "Name of the deployed gateway worker. This module does NOT deploy the script (see ../README.md); it only routes a hostname at a script wrangler already deployed under this name."
  type        = string
  default     = "videoshare-gateway"
}

variable "gateway_hostname" {
  description = "Hostname to route at the gateway worker, e.g. `gateway.example.com`. Empty skips it. Cloudflare creates and owns the proxied DNS record for a Worker custom domain, so do not also list it in dns_records."
  type        = string
  default     = ""
}

variable "pages_project" {
  description = "Cloudflare Pages project serving the static site. Empty skips the custom-domain attachment below."
  type        = string
  default     = ""
}

variable "site_hostname" {
  description = "Hostname for the static site, e.g. `share.example.com`. Attached to pages_project. Empty skips it. As with the gateway, Cloudflare owns the record."
  type        = string
  default     = ""
}

variable "extra_allowed_origins" {
  description = <<-EOT
    Additional origins the video bucket answers CORS for, on top of
    `https://{site_hostname}`. Feeds the `cors_rules` output and nothing else —
    this module does not deploy the worker, so the gateway's own ALLOWED_ORIGINS
    stays a `wrangler secret`/`vars` matter.

    Opt-in, and empty by default, which is the same shape as the aws/ and gcp/
    modules. `http://localhost:8080` belongs here while you are testing a local
    build against the deployed bucket, and nowhere else — docs/storage-setup.md
    is explicit that the production origins should be the site's exact origin
    once it has a stable home.
  EOT
  type        = list(string)
  default     = []
}

variable "dns_records" {
  description = <<-EOT
    Plain DNS records, keyed by an arbitrary name for the resource address.
    Empty by default.

    This is deliberately NOT where the site, videos and gateway hostnames go:
    Pages custom domains, Worker custom domains and R2 custom domains each
    create and own their own proxied CNAME, and a cloudflare_record for the same
    name fights them on every apply.

    It is for records that belong to nothing else — most usefully the two the
    AWS module hands you when the site lives on S3 and CloudFront: the ACM
    validation CNAME from `acm_validation_record`, and the CNAME pointing your
    domain at `cloudfront_domain`.

    Example:
      dns_records = {
        acm-validation = { name = "_abc123.share", type = "CNAME", content = "_xyz.acm-validations.aws.", proxied = false }
        site           = { name = "share",         type = "CNAME", content = "d111.cloudfront.net",       proxied = false }
      }

    An ACM validation record must have proxied = false: proxying rewrites the
    answer and validation never completes.
  EOT
  type = map(object({
    name    = string
    type    = string
    content = string
    proxied = optional(bool, false)
    ttl     = optional(number, 1) # 1 is "automatic"; Cloudflare requires it when proxied
    comment = optional(string, "Managed by Terraform (videoshare)")
  }))
  default = {}
}
