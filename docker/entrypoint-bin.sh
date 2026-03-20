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
  VERSION=$(curl -sL https://api.github.com/repos/plosson/agentio/releases/latest \
    | grep '"tag_name"' | sed -E 's/.*"v([^"]+)".*/\1/')
fi

echo "Installing agentio v${VERSION} (${PLATFORM})..."
curl -fL "https://github.com/plosson/agentio/releases/download/v${VERSION}/agentio-${PLATFORM}" \
    -o "${BIN_DIR}/agentio"
chmod +x "${BIN_DIR}/agentio"

exec "$@"
