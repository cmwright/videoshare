terraform {
  # Verified against the 1.5.7 CLI. google 7.x installs and runs under it.
  required_version = ">= 1.5"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.0"
    }
  }
}

# No credentials block: this uses Application Default Credentials
# (`gcloud auth application-default login`). The project is a variable and is
# never hardcoded — nothing in this module is specific to one of them.
provider "google" {
  project = var.project
  region  = var.region
}
