# Agentio Gateway Docker Image
# Supports three modes based on environment variables:
#   - Cloudflare Tunnel: set CLOUDFLARE_TUNNEL_TOKEN
#   - Caddy (TLS-ALPN-01): set DOMAIN
#   - Plain HTTP: neither (for dev or external reverse proxy)

FROM oven/bun:1-alpine AS base

# Architecture for multi-platform builds
ARG TARGETARCH

# Install runtime dependencies
RUN apk add --no-cache \
    ca-certificates \
    curl \
    tini

# Install Caddy (multi-arch)
RUN CADDY_ARCH=$([ "$TARGETARCH" = "arm64" ] && echo "arm64" || echo "amd64") && \
    curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v2.8.4/caddy_2.8.4_linux_${CADDY_ARCH}.tar.gz" \
    | tar -xz -C /usr/local/bin caddy && \
    chmod +x /usr/local/bin/caddy

# Install cloudflared (multi-arch)
RUN CF_ARCH=$([ "$TARGETARCH" = "arm64" ] && echo "arm64" || echo "amd64") && \
    curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_ARCH}" \
    -o /usr/local/bin/cloudflared && \
    chmod +x /usr/local/bin/cloudflared

# Create non-root user (use different IDs to avoid conflicts with base image)
RUN addgroup -g 1001 agentio \
    && adduser -u 1001 -G agentio -h /home/agentio -D agentio

# Set up directories
RUN mkdir -p /app /data /certs \
    && chown -R agentio:agentio /app /data /certs

WORKDIR /app

# Copy application source
COPY --chown=agentio:agentio package.json bun.lock* ./
COPY --chown=agentio:agentio src ./src

# Install dependencies
RUN bun install --frozen-lockfile --production

# Copy entrypoint and config files
COPY --chown=agentio:agentio docker/entrypoint.sh /entrypoint.sh
COPY --chown=agentio:agentio docker/Caddyfile /etc/caddy/Caddyfile

RUN chmod +x /entrypoint.sh

# Switch to non-root user
USER agentio

# Set config directory to /data (mounted volume)
ENV HOME=/data
ENV XDG_CONFIG_HOME=/data

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -sf http://localhost:${GATEWAY_PORT:-7890}/health || exit 1

# Expose default gateway port (only used in HTTP/Caddy modes)
EXPOSE 7890 443

# Use tini as init system for proper signal handling
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/entrypoint.sh"]
