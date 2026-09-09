# Agentio daemon Docker image
# Runs `agentio daemon start --foreground` (daemon API /health on port 7890).
# Binary is fetched at container start to always use the latest version.
# Pin a version with AGENTIO_VERSION env var.

FROM ubuntu:24.04

# Install runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl tini \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd -g 1001 agentio \
    && useradd -u 1001 -g agentio -d /home/agentio -m agentio

# Set up data and bin directories
RUN mkdir -p /data /home/agentio/bin && chown -R agentio:agentio /data /home/agentio/bin

# Install entrypoint that fetches latest agentio on start (vault-imports when AGENTIO_KEY+AGENTIO_CONFIG set)
COPY --chmod=755 entrypoint-bin.sh /usr/local/bin/entrypoint-bin.sh

# Switch to non-root user
USER agentio

# Config directory and binary path
ENV HOME=/data
ENV XDG_CONFIG_HOME=/data
ENV PATH="/home/agentio/bin:${PATH}"

# Health check (daemon API)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -sf http://localhost:7890/health || exit 1

EXPOSE 7890

ENTRYPOINT ["/usr/bin/tini", "--", "entrypoint-bin.sh"]
CMD ["agentio", "daemon", "start", "--foreground"]
