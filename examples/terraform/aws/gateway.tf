locals {
  # SPEC §15.2 / docs/gateway-setup.md §2. This list is the deployment: there is
  # no config file and no state anywhere.
  gateway_env = merge(
    {
      # Path-style URLs are built from this. The recorder's part PUTs are signed
      # against it; PUBLIC_BASE_URL below is where the player reads them back.
      BUCKET_ENDPOINT = "https://s3.${var.region}.amazonaws.com"
      BUCKET_NAME     = aws_s3_bucket.videos.id
      BUCKET_REGION   = var.region

      BUCKET_ACCESS_KEY_ID     = aws_iam_access_key.gateway.id
      BUCKET_SECRET_ACCESS_KEY = aws_iam_access_key.gateway.secret

      # Virtual-hosted form, because that is what a CDN in front of S3 expects
      # and what ranged GETs are cheapest against.
      PUBLIC_BASE_URL = "https://${aws_s3_bucket.videos.id}.s3.${var.region}.amazonaws.com"

      GOOGLE_CLIENT_ID       = var.google_client_id
      ALLOWED_EMAILS         = join(",", var.allowed_emails)
      ALLOWED_ORIGINS        = join(",", local.site_origins)
      PRESIGN_EXPIRY_SECONDS = tostring(var.presign_expiry)
    },
    var.enable_analytics ? { ANALYTICS_BUCKET = aws_s3_bucket.analytics[0].id } : {},
  )
}

# Created here rather than left to Lambda so `terraform destroy` takes the logs
# with it and the retention is not "forever" by default.
resource "aws_cloudwatch_log_group" "gateway" {
  name              = "/aws/lambda/${local.name}-gateway"
  retention_in_days = 14
  tags              = var.tags
}

# The gateway itself. 256 MB and 15 seconds are sized for what it actually does:
# verify a JWT against a cached JWKS and derive a SigV4 signature. It never
# carries object bytes (SPEC §15), so no amount of video changes these numbers.
#
# Invoke mode stays at the default BUFFERED. Response streaming is exactly what a
# proxy would need, and this gateway must never become one.
resource "aws_lambda_function" "gateway" {
  function_name = "${local.name}-gateway"
  role          = aws_iam_role.lambda.arn

  runtime = "nodejs22.x"
  handler = "dist/lambda.handler"

  # Built by ./build.sh. package.json goes into the zip for its "type": "module"
  # — without it the runtime reads the .js files as CommonJS and every import
  # fails.
  filename         = var.lambda_zip
  source_code_hash = filebase64sha256(var.lambda_zip)

  memory_size = 256
  timeout     = 15

  environment {
    variables = local.gateway_env
  }

  tags = var.tags

  depends_on = [
    aws_iam_role_policy_attachment.lambda_logs,
    aws_cloudwatch_log_group.gateway,
  ]
}

# --- The HTTP API in front of it ---------------------------------------------

# A Lambda *function URL* is what docs/gateway-setup.md §3 describes and it is
# the simpler shape, but on the account this stack was validated against every
# request to one came back 403 despite auth type NONE and a correct
# lambda:InvokeFunctionUrl resource policy for principal "*" — most likely an
# organisation-level control, and not something the function's own configuration
# can override. An HTTP API with a $default route is the shape that works, and it
# speaks the same payload format 2.0 the adapter reads.
#
# Note "payload format 2.0": an API Gateway *REST* proxy sends 1.0 and the
# adapter does not read it.
resource "aws_apigatewayv2_api" "gateway" {
  name          = "${local.name}-gateway"
  protocol_type = "HTTP"
  tags          = var.tags

  # No cors_configuration on purpose. The gateway answers preflights itself and
  # refuses an Origin that is not in ALLOWED_ORIGINS (core.ts) — an API-level
  # CORS block would either shadow that with a second, looser policy or send two
  # Access-Control-Allow-Origin headers, which browsers reject outright.
}

resource "aws_apigatewayv2_integration" "gateway" {
  api_id                 = aws_apigatewayv2_api.gateway.id
  integration_type       = "AWS_PROXY"
  integration_method     = "POST"
  integration_uri        = aws_lambda_function.gateway.invoke_arn
  payload_format_version = "2.0"
}

# One catch-all route: the gateway routes on the path itself, and accepts both
# /api/... and bare /... mount points.
resource "aws_apigatewayv2_route" "default" {
  api_id    = aws_apigatewayv2_api.gateway.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.gateway.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.gateway.id
  name        = "$default"
  auto_deploy = true
  tags        = var.tags
}

# Authorization is the gateway's own job — it verifies a Google ID token on every
# request — so the API is open and the function trusts the API to call it.
resource "aws_lambda_permission" "api_gateway" {
  statement_id  = "AllowExecutionFromAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.gateway.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.gateway.execution_arn}/*/*"
}
