#!/usr/bin/env bash
# Builds the Lambda deployment package this module deploys.
#
#   ./build.sh            -> examples/terraform/aws/gateway.zip
#   ./build.sh /tmp/x.zip -> /tmp/x.zip
#   ./build.sh out.zip    -> ./out.zip, relative to wherever you ran this from
#
# The zip holds three things and nothing else: dist/ (tsc output, plain ESM),
# package.json, and the production node_modules — which is two packages, jose
# and aws4fetch.
#
# package.json is in there for its "type": "module". Without it the runtime reads
# the .js files as CommonJS and every import fails.
#
# The production install happens in a staging directory rather than in gateway/,
# so this never prunes the dev dependencies out from under whoever is working on
# the gateway.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
gateway="$repo/gateway"

# Resolved to an absolute path here, before anything else runs. The zip is
# written from inside the staging directory (`cd "$stage" && zip …`), so a
# relative $out would land in the temp directory and be deleted by the trap
# below — after `rm -f "$out"` had already run against the caller's cwd.
out="${1:-$here/gateway.zip}"
mkdir -p "$(dirname "$out")"
out="$(cd "$(dirname "$out")" && pwd)/$(basename "$out")"

[ -f "$gateway/package.json" ] || {
  echo "build.sh: no gateway/package.json under $repo — run this from a checkout" >&2
  exit 1
}

echo "==> npm ci  ($gateway)"
npm --prefix "$gateway" ci

echo "==> npm run build"
npm --prefix "$gateway" run build

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

echo "==> staging"
cp -R "$gateway/dist" "$stage/dist"
cp "$gateway/package.json" "$stage/package.json"
cp "$gateway/package-lock.json" "$stage/package-lock.json"

echo "==> npm ci --omit=dev  (staging)"
# --ignore-scripts: nothing in this dependency tree has install scripts, and a
# deployment package is not the place to start running them.
(cd "$stage" && npm ci --omit=dev --ignore-scripts)
rm -f "$stage/package-lock.json"

echo "==> zip"
rm -f "$out"
(cd "$stage" && zip -qr "$out" dist node_modules package.json)

echo "$out"
ls -lh "$out" | awk '{print "    " $5}'
