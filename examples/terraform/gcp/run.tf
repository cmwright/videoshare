locals {
  gateway_image = var.gateway_image != "" ? var.gateway_image : join("", [
    "${var.region}-docker.pkg.dev/${var.project}/",
    "${google_artifact_registry_repository.gateway.repository_id}/videoshare-gateway:",
    var.gateway_image_tag,
  ])

  # SPEC §15.2 / docs/gateway-setup.md §2, minus the two credential variables,
  # which are set as their own env blocks below because a `for_each` may not
  # carry a sensitive value.
  gateway_env = merge(
    {
      # Cloud Storage's S3-compatible XML API. Path-style URLs
      # ({endpoint}/{bucket}/{key}) are what presign.ts builds and what this
      # endpoint serves.
      BUCKET_ENDPOINT = "https://storage.googleapis.com"
      BUCKET_NAME     = google_storage_bucket.videos.name

      # The region that goes into the SigV4 credential scope
      # (`{date}/{region}/s3/aws4_request`).
      #
      # Cloud Storage documents this field as free: "For Cloud Storage resources,
      # you can use any value for LOCATION. The recommended value to use is the
      # location associated with the resource that the signature applies to. For
      # example, us-central1. This parameter exists to maintain compatibility
      # with Amazon S3." So `auto` — the gateway's default when BUCKET_REGION is
      # unset, and the right answer for R2 — would also be accepted today.
      #
      # The bucket's own location is set here anyway, because it is the value
      # Google recommends and the only one that stays correct if Cloud Storage
      # ever starts checking the scope. It costs nothing to be exact.
      BUCKET_REGION = lower(var.region)

      # Public reads are served from the same host with the bucket as a path
      # segment. Ranged GETs work here, which is what the player needs.
      PUBLIC_BASE_URL = "https://storage.googleapis.com/${google_storage_bucket.videos.name}"

      GOOGLE_CLIENT_ID       = var.google_client_id
      ALLOWED_EMAILS         = join(",", var.allowed_emails)
      ALLOWED_ORIGINS        = join(",", local.site_origins)
      PRESIGN_EXPIRY_SECONDS = tostring(var.presign_expiry)
    },
    var.enable_analytics ? { ANALYTICS_BUCKET = google_storage_bucket.analytics[0].name } : {},
  )
}

resource "google_cloud_run_v2_service" "gateway" {
  name     = "${local.name}-gateway"
  location = var.region
  project  = var.project

  # Public: the gateway authenticates every request with a Google ID token
  # itself, so Cloud Run's own IAM must not stand in front of it.
  ingress = "INGRESS_TRAFFIC_ALL"

  # The service is stateless and holds nothing; the buckets are what deserve a
  # guard rail, and they have force_destroy = false.
  deletion_protection = false

  template {
    service_account = google_service_account.gateway.email

    scaling {
      # Scale to zero. The gateway signs URLs and never carries object bytes
      # (SPEC §15), so a cold start costs one recording's first request a second
      # and nothing else. Two instances is plenty of ceiling for a team and is
      # the cheap way to bound a runaway.
      min_instance_count = 0
      max_instance_count = 2
    }

    containers {
      image = local.gateway_image

      # No PORT variable. Cloud Run injects PORT (8080 by default) and
      # gateway/src/node.ts reads process.env.PORT, falling back to 8787 — so
      # the two already agree and setting it here would only be a second place
      # to get it wrong.
      dynamic "env" {
        for_each = local.gateway_env
        content {
          name  = env.key
          value = env.value
        }
      }

      # Kept out of the loop above: `for_each` cannot take a sensitive value, and
      # the HMAC secret is marked sensitive by the provider.
      env {
        name  = "BUCKET_ACCESS_KEY_ID"
        value = google_storage_hmac_key.gateway.access_id
      }

      env {
        name  = "BUCKET_SECRET_ACCESS_KEY"
        value = google_storage_hmac_key.gateway.secret
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        # Billing follows requests rather than instance lifetime, which is what
        # makes a scale-to-zero gateway effectively free.
        cpu_idle = true
      }
    }
  }

  labels = var.labels

  depends_on = [google_project_service.services]
}

# Anonymous invocation. The Node adapter validates its whole environment before
# it listens, so a misconfigured deployment fails at boot rather than on
# someone's first recording — but check anyway once it is up:
# `curl {gateway_url}/api/config` is public and needs no token.
resource "google_cloud_run_v2_service_iam_member" "public" {
  name     = google_cloud_run_v2_service.gateway.name
  location = google_cloud_run_v2_service.gateway.location
  project  = var.project
  role     = "roles/run.invoker"
  member   = "allUsers"
}
