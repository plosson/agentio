#!/bin/sh
set -e

BIN_DIR="/home/agentio/bin"

# Detect platform
ARCH=$(uname -m)
case "$ARCH" in
  aarch64|arm64) PLATFORM="linux-arm64" ;;
  *)             PLATFORM="linux-x64" ;;
esac

# Resolve version (use AGENTIO_VERSION env var, or fetch latest)
if [ -n "$AGENTIO_VERSION" ]; then
  VERSION="$AGENTIO_VERSION"
else
  # Read the /releases/latest redirect rather than api.github.com, which caps
  # unauthenticated IPs at 60 requests/hour
  VERSION=$(curl -sI https://github.com/plosson/agentio/releases/latest \
    | tr -d '\r' | sed -n 's|.*[Ll]ocation:.*/releases/tag/v||p' | head -n 1)
fi

echo "Installing agentio v${VERSION} (${PLATFORM})..."
curl -fL "https://github.com/plosson/agentio/releases/download/v${VERSION}/agentio-${PLATFORM}" \
    -o "${BIN_DIR}/agentio"
chmod +x "${BIN_DIR}/agentio"

exec "$@"
