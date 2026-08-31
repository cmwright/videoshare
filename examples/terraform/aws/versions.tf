terraform {
  # 1.5 is the floor because nothing here uses a newer language feature. The
  # configuration was authored and verified against the 1.5.7 CLI.
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.region
}

# CloudFront only accepts certificates issued in us-east-1, whatever region the
# rest of the stack lives in. This alias exists for that one resource; every
# other resource uses the default provider above.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
}
