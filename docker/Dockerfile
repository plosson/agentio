# Agentio Gateway Docker Image
# Runs the gateway on port 7890

FROM debian:bookworm-slim

ARG TARGETARCH
ARG AGENTIO_VERSION

# Install runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl tini \
    && rm -rf /var/lib/apt/lists/*

# Install agentio binary
RUN PLATFORM=$([ "$TARGETARCH" = "arm64" ] && echo "linux-arm64" || echo "linux-x64") && \
    if [ -n "$AGENTIO_VERSION" ]; then \
        VERSION="$AGENTIO_VERSION"; \
    else \
        VERSION=$(curl -sL https://api.github.com/repos/plosson/agentio/releases/latest | grep '"tag_name"' | sed -E 's/.*"v([^"]+)".*/\1/'); \
    fi && \
    curl -fL "https://github.com/plosson/agentio/releases/download/v${VERSION}/agentio-${PLATFORM}" \
        -o /usr/local/bin/agentio && \
    chmod +x /usr/local/bin/agentio

# Create non-root user
RUN groupadd -g 1001 agentio \
    && useradd -u 1001 -g agentio -d /home/agentio -m agentio

# Set up data directory
RUN mkdir -p /data && chown agentio:agentio /data

# Switch to non-root user
USER agentio

# Config directory
ENV HOME=/data
ENV XDG_CONFIG_HOME=/data

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -sf http://localhost:7890/health || exit 1

EXPOSE 7890

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["agentio", "gateway", "start", "--foreground"]
