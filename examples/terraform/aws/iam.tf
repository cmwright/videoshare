# The bucket credentials the gateway holds. They live in the Lambda's
# environment rather than in a browser's localStorage, which is the entire point
# of the gateway — so they can carry what analytics needs without widening what
# anyone's recorder holds.
resource "aws_iam_user" "gateway" {
  name = "${local.name}-gateway"
  tags = var.tags
}

resource "aws_iam_access_key" "gateway" {
  user = aws_iam_user.gateway.name
}

# Exactly the grants docs/gateway-setup.md describes, and no others.
#
# PutObject authorizes the whole multipart write path — create, every part,
# complete. Abandoning an upload is a separate action, and without
# AbortMultipartUpload the recorder's Discard comes back 403.
#
# GetObject on the analytics bucket looks wrong for a service that never reads an
# object, and it is the one people leave out. A presigned URL carries the
# authority of the key that signed it: without it the gateway signs URLs happily
# and every one of them comes back 403 in the browser.
#
# ListBucket is granted on the analytics bucket itself, not on `/*` — that is
# what ListObjectsV2 authorizes against — and on that bucket alone. There is no
# ListBucket anywhere on the video bucket: video ids stay unguessable.
data "aws_iam_policy_document" "gateway" {
  statement {
    sid       = "VideoShareUploadOnly"
    effect    = "Allow"
    actions   = ["s3:PutObject", "s3:AbortMultipartUpload"]
    resources = ["${aws_s3_bucket.videos.arn}/*"]
  }

  dynamic "statement" {
    for_each = var.enable_analytics ? [1] : []
    content {
      sid       = "VideoShareAnalyticsWriteAndRead"
      effect    = "Allow"
      actions   = ["s3:PutObject", "s3:GetObject"]
      resources = ["${aws_s3_bucket.analytics[0].arn}/*"]
    }
  }

  dynamic "statement" {
    for_each = var.enable_analytics ? [1] : []
    content {
      sid       = "VideoShareAnalyticsList"
      effect    = "Allow"
      actions   = ["s3:ListBucket"]
      resources = [aws_s3_bucket.analytics[0].arn]
    }
  }
}

resource "aws_iam_user_policy" "gateway" {
  name   = "${local.name}-gateway"
  user   = aws_iam_user.gateway.name
  policy = data.aws_iam_policy_document.gateway.json
}

# --- The Lambda's own role ---------------------------------------------------

# Distinct from the IAM user above and deliberately empty of S3: the function's
# execution role grants it nothing but CloudWatch Logs. The bucket authority
# travels in the environment as an access key, because that is the credential
# aws4fetch signs presigned URLs with — a URL signed by a role's temporary
# credentials would expire with the role's session rather than with
# PRESIGN_EXPIRY_SECONDS.
data "aws_iam_policy_document" "lambda_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda" {
  name               = "${local.name}-gateway-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "lambda_logs" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}
