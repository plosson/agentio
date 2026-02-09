#!/usr/bin/env bash
set -euo pipefail

IMAGE="plosson999/agentio-gateway"
VERSION=$(grep '"version"' "$(dirname "$0")/../package.json" | sed -E 's/.*"([0-9]+\.[0-9]+\.[0-9]+)".*/\1/')

echo "Building ${IMAGE}:${VERSION} ..."
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --build-arg AGENTIO_VERSION="${VERSION}" \
  -t "${IMAGE}:${VERSION}" \
  -t "${IMAGE}:latest" \
  --push \
  "$(dirname "$0")"
