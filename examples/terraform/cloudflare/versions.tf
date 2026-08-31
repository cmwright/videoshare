terraform {
  # Verified against the 1.5.7 CLI, which pins the provider to the 4.x line —
  # 5.x is a full rewrite on the plugin framework with different resource names.
  required_version = ">= 1.5"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
  }
}

# The provider needs a token to plan, not only to apply: it authenticates when
# it configures. Set CLOUDFLARE_API_TOKEN in the environment rather than putting
# a token in a tfvars file.
provider "cloudflare" {
  api_token = var.api_token
}
