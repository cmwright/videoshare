# --- R2 buckets --------------------------------------------------------------

# The bucket the recorder writes to and the player reads from. Everything in it
# is AES-GCM ciphertext.
#
# Two things this resource cannot do, both of them provider gaps rather than
# choices — see ../README.md for the wrangler commands that fill them:
#
#   - CORS. cloudflare_r2_bucket in the 4.x provider is exactly three fields
#     (account_id, name, location); there is no CORS sub-resource. The bucket is
#     useless to a browser without one, so this is not optional work, it is just
#     work that happens elsewhere.
#   - The public custom domain. Attaching videos.example.com to a bucket is an
#     R2 API call the 4.x provider does not model either, and it is what creates
#     the proxied DNS record — which is why that hostname is not in dns_records.
#
# Importing an existing bucket:
#   terraform import cloudflare_r2_bucket.videos <account_id>/<bucket_name>
resource "cloudflare_r2_bucket" "videos" {
  account_id = var.account_id
  name       = var.videos_bucket
  location   = var.bucket_location
}

# SPEC §16.4. PRIVATE: no custom domain, no public r2.dev subdomain, ever. The
# gateway refuses to start if ANALYTICS_BUCKET names the same bucket as
# BUCKET_NAME, because that one is world-readable by design and watch data must
# never land in it.
#
#   terraform import cloudflare_r2_bucket.analytics[0] <account_id>/<bucket_name>
resource "cloudflare_r2_bucket" "analytics" {
  count = var.enable_analytics ? 1 : 0

  account_id = var.account_id
  name       = var.analytics_bucket
  location   = var.bucket_location
}

# --- Hostnames ---------------------------------------------------------------

# Routes gateway_hostname at the worker script wrangler deployed. The script must
# already exist under var.worker_name; this resource attaches a hostname to it
# and does not create or update any code.
#
#   terraform import cloudflare_workers_domain.gateway[0] <account_id>/<domain_id>
resource "cloudflare_workers_domain" "gateway" {
  count = var.gateway_hostname != "" && var.zone_id != "" ? 1 : 0

  account_id = var.account_id
  zone_id    = var.zone_id
  hostname   = var.gateway_hostname
  service    = var.worker_name
}

# Attaches site_hostname to an existing Pages project. The project itself — its
# Git connection, its build command, its branch — is not managed here: it is
# configured once in the dashboard and then redeploys on push, and there is
# nothing for Terraform to keep in sync.
#
#   terraform import cloudflare_pages_domain.site[0] <account_id>/<project_name>/<domain>
resource "cloudflare_pages_domain" "site" {
  count = var.site_hostname != "" && var.pages_project != "" ? 1 : 0

  account_id   = var.account_id
  project_name = var.pages_project
  domain       = var.site_hostname
}

# --- Plain DNS records -------------------------------------------------------

# Everything that belongs to nothing else. See the variable's description for
# why the three VideoShare hostnames are not in here.
#
#   terraform import 'cloudflare_record.this["site"]' <zone_id>/<record_id>
resource "cloudflare_record" "this" {
  for_each = var.zone_id == "" ? {} : var.dns_records

  zone_id = var.zone_id
  name    = each.value.name
  type    = each.value.type
  content = each.value.content
  proxied = each.value.proxied
  ttl     = each.value.proxied ? 1 : each.value.ttl
  comment = each.value.comment
}
