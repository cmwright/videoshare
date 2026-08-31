# Everything in this file is created only when var.site_domain is set. With it
# empty the site is served from the S3 REST endpoint — HTTPS, no domain of your
# own, and nothing here to pay for or tear down.

locals {
  use_custom_domain = var.site_domain != ""
}

# Issued in us-east-1 whatever var.region says: CloudFront accepts certificates
# from that region only.
resource "aws_acm_certificate" "site" {
  count    = local.use_custom_domain ? 1 : 0
  provider = aws.us_east_1

  domain_name       = var.site_domain
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = var.tags
}

# Validation blocks until the CNAME from the `acm_validation_record` output
# exists in your zone. This module does not create it — see the apply order in
# ../README.md: apply the certificate on its own first, read the record off the
# output, add it wherever your DNS lives, then apply the rest.
resource "aws_acm_certificate_validation" "site" {
  count    = local.use_custom_domain ? 1 : 0
  provider = aws.us_east_1

  certificate_arn = aws_acm_certificate.site[0].arn
}

# The site bucket is publicly readable, so the origin needs no access identity —
# CloudFront fetches objects the same way any browser would.
#
# CachingDisabled (the AWS-managed policy, id 4135ea2d-…) is the deliberate
# choice: dist/ carries config.js, which is copied verbatim rather than
# fingerprinted, and a cached one would pin the deployment to whatever
# publicBaseUrl was live when it was first fetched. The hashed assets around it
# are cheap to re-fetch, and video bytes never come through here at all.
resource "aws_cloudfront_distribution" "site" {
  count = local.use_custom_domain ? 1 : 0

  enabled             = true
  is_ipv6_enabled     = true
  comment             = "${local.name} static site"
  default_root_object = "index.html"
  aliases             = [var.site_domain]
  price_class         = "PriceClass_100"

  origin {
    origin_id   = "s3-site"
    domain_name = aws_s3_bucket.site.bucket_regional_domain_name
  }

  default_cache_behavior {
    target_origin_id       = "s3-site"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    cache_policy_id        = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # Managed-CachingDisabled
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.site[0].certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  tags = var.tags
}
