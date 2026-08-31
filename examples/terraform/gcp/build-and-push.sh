#!/usr/bin/env bash
# Builds the gateway container and pushes it to this stack's Artifact Registry
# repository.
#
#   ./build-and-push.sh <project> [region] [name-suffix] [tag]
#   ./build-and-push.sh videoshare-506902 us-central1 val01 latest
#
# The resulting reference is
#   {region}-docker.pkg.dev/{project}/videoshare-{suffix}/videoshare-gateway:{tag}
# which is exactly what the Terraform `gateway_image` output computes, so the two
# agree without anything being pasted between them.
#
# THE FIRST DEPLOY IS TWO APPLIES. This script pushes into an Artifact Registry
# repository that Terraform owns (google_artifact_registry_repository.gateway),
# and Cloud Run will not accept a service whose image does not exist yet — so
# neither half can go first on a greenfield project. Break the cycle by creating
# the repository on its own, the same shape as the aws/ module's ACM dance:
#
#   terraform init
#   terraform apply -target=google_artifact_registry_repository.gateway
#   ./build-and-push.sh <project> <region> <suffix>
#   terraform apply
#
# Every later build is just this script plus `terraform apply`. The check below
# fails fast rather than letting `gcloud builds submit` discover it after a full
# npm ci and build.
#
# WHY `gcloud builds submit` AND NOT `docker buildx`:
#
#   - Cloud Run runs linux/amd64. This repository is developed on Apple Silicon,
#     where a plain `docker build` produces an arm64 image that Cloud Run rejects
#     at deploy time with an unhelpful error. Building in Cloud Build sidesteps
#     the cross-build entirely rather than relying on everyone remembering
#     --platform.
#   - It needs no local Docker daemon and no `gcloud auth configure-docker`
#     credential helper, so the only prerequisite is the gcloud login the
#     Terraform module already needs.
#
# The cost is that Cloud Build must be enabled and billable on the project. If
# you would rather build locally, this is the equivalent:
#
#   docker buildx build --platform linux/amd64 -t "$IMAGE" --push "$stage"
#
# after `gcloud auth configure-docker {region}-docker.pkg.dev`.
set -euo pipefail

project="${1:?usage: build-and-push.sh <project> [region] [name-suffix] [tag]}"
region="${2:-us-central1}"
suffix="${3:-}"
tag="${4:-latest}"

[ -n "$suffix" ] || { echo "build-and-push.sh: name-suffix is required (3rd argument)" >&2; exit 1; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
gateway="$repo/gateway"
registry="videoshare-${suffix}"
image="${region}-docker.pkg.dev/${project}/${registry}/videoshare-gateway:${tag}"

[ -f "$gateway/package.json" ] || {
  echo "build-and-push.sh: no gateway/package.json under $repo — run this from a checkout" >&2
  exit 1
}

# Checked before the build, not after: `gcloud builds submit` only finds out at
# push time, which is a wasted npm ci and a much worse error message.
#
# --quiet matters. With the Artifact Registry API disabled — which is the state
# of a greenfield project, and the exact case this check is for — gcloud offers
# to enable it and waits on stdin. The output is redirected, so that prompt would
# be an invisible hang. --quiet takes the default answer (no) and fails.
echo "==> checking Artifact Registry repository $registry ($region)"
gcloud artifacts repositories describe "$registry" --quiet \
  --project "$project" --location "$region" >/dev/null 2>&1 || {
  cat >&2 <<EOF
build-and-push.sh: Artifact Registry repository "$registry" does not exist in
$region (or the Artifact Registry API is not enabled on $project).

Terraform owns that repository, and Cloud Run will not accept a service whose
image does not exist yet — so on a greenfield project neither can go first.
Create the repository on its own, then come back here:

  terraform apply -target=google_artifact_registry_repository.gateway
  ./build-and-push.sh $project $region $suffix
  terraform apply
EOF
  exit 1
}

echo "==> npm ci  ($gateway)"
npm --prefix "$gateway" ci

echo "==> npm run build"
npm --prefix "$gateway" run build

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

echo "==> staging build context"
cp -R "$gateway/dist" "$stage/dist"
cp "$gateway/package.json" "$stage/package.json"
cp "$gateway/package-lock.json" "$stage/package-lock.json"
cp "$here/Dockerfile" "$stage/Dockerfile"

echo "==> npm ci --omit=dev  (staging)"
# The production tree is two packages: jose and aws4fetch. Installing here rather
# than in the Dockerfile keeps the image free of a package manager and the build
# context small — Cloud Build uploads whatever is in this directory.
(cd "$stage" && npm ci --omit=dev --ignore-scripts)
rm -f "$stage/package-lock.json"

echo "==> gcloud builds submit -> $image"
gcloud builds submit "$stage" --project "$project" --tag "$image"

echo
echo "  image: $image"
echo "  now:   terraform apply   (gateway_image_tag = \"$tag\")"
