variable "project" {
  description = "GCP project id everything is created in. No default: a project id is an account-specific fact and does not belong in a checked-in module."
  type        = string
}

variable "region" {
  description = "Region for the buckets, the Artifact Registry repository and the Cloud Run service. Also the value the gateway signs with as BUCKET_REGION — see the note in buckets.tf."
  type        = string
  default     = "us-central1"
}

variable "name_suffix" {
  description = <<-EOT
    Short suffix that makes bucket names unique. GCS bucket names are globally
    unique across all of Google Cloud, so this is not optional in practice.
    Everything is named `videoshare-{name_suffix}-{role}`.

    Capped at 16 characters by the tightest name this module builds: the
    gateway's service account is `videoshare-{name_suffix}-gw`, and a
    service-account account_id may be at most 30 characters. 11 + 16 + 3 = 30.
    A longer suffix passes every other name and then fails the apply, so the
    validation stops it here instead.
  EOT
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,15}$", var.name_suffix))
    error_message = "name_suffix must be 2-16 characters of lowercase letters, digits or dashes, starting with a letter or digit. The 16 is the service account account_id limit: \"videoshare-\" + suffix + \"-gw\" must fit in 30 characters."
  }
}

variable "allowed_emails" {
  description = "Who may upload. Each entry is a full address or an `@domain` suffix, matched case-insensitively against the verified email in the Google ID token. Joined with commas into ALLOWED_EMAILS. Not a secret."
  type        = list(string)

  validation {
    condition     = length(var.allowed_emails) > 0
    error_message = "allowed_emails must list at least one address or @domain suffix."
  }
}

variable "google_client_id" {
  description = "OAuth 2.0 Web application client id. Public information. Its authorized JavaScript origins must include every entry in the `allowed_origins` output — that part stays manual."
  type        = string
}

variable "presign_expiry" {
  description = "Lifetime in seconds of each presigned URL (PRESIGN_EXPIRY_SECONDS). 1-3600."
  type        = number
  default     = 900

  validation {
    condition     = var.presign_expiry >= 1 && var.presign_expiry <= 3600
    error_message = "presign_expiry must be between 1 and 3600 seconds."
  }
}

variable "enable_analytics" {
  description = "Create the private analytics bucket and set ANALYTICS_BUCKET (docs/SPEC.md §16). False is a supported configuration."
  type        = bool
  default     = true
}

variable "gateway_image" {
  description = <<-EOT
    Full image reference for the Cloud Run service. Leave empty to use
    `{region}-docker.pkg.dev/{project}/{repo}/videoshare-gateway:{gateway_image_tag}`
    — the same string ./build-and-push.sh pushes to.

    The image must exist before `terraform apply` reaches the Cloud Run service:
    a revision that cannot pull is a failed apply, not a pending one. But the
    build script pushes into an Artifact Registry repository this module also
    owns, so the first deploy is two applies:

      terraform apply -target=google_artifact_registry_repository.gateway
      ./build-and-push.sh <project> <region> <suffix>
      terraform apply

    After that the script alone is enough.
  EOT
  type        = string
  default     = ""
}

variable "gateway_image_tag" {
  description = "Tag pushed by ./build-and-push.sh. Change it to force a new revision; Cloud Run will not redeploy for a moved `latest`."
  type        = string
  default     = "latest"
}

variable "extra_allowed_origins" {
  description = "Additional origins allowed to call the gateway from a browser, on top of https://storage.googleapis.com. Never `*` — the gateway refuses it at boot."
  type        = list(string)
  default     = []
}

variable "labels" {
  description = "Labels applied to every resource that takes them."
  type        = map(string)
  default     = {}
}
