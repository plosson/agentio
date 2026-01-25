#!/bin/sh
set -e

GATEWAY_PORT="${GATEWAY_PORT:-7890}"

echo "=== Agentio Gateway ==="

# Import configuration from environment variables
if [ -n "$AGENTIO_KEY" ] && [ -n "$AGENTIO_CONFIG" ]; then
    echo "Importing configuration..."
    bun run /app/src/index.ts config import
    echo "Configuration imported successfully"
else
    echo "WARNING: AGENTIO_KEY and AGENTIO_CONFIG not set"
    echo "Gateway will start but may not have service credentials"
fi

# Detect mode and start appropriate services
if [ -n "$CLOUDFLARE_TUNNEL_TOKEN" ]; then
    echo "Mode: Cloudflare Tunnel"
    echo "Starting cloudflared..."

    # Start cloudflared in background
    cloudflared tunnel run --token "$CLOUDFLARE_TUNNEL_TOKEN" &
    CLOUDFLARED_PID=$!

    # Wait for tunnel to initialize
    sleep 2

    echo "Starting gateway on port $GATEWAY_PORT..."
    bun run /app/src/index.ts gateway start --foreground &
    GATEWAY_PID=$!

    # Handle shutdown
    trap "kill $GATEWAY_PID $CLOUDFLARED_PID 2>/dev/null; exit 0" SIGTERM SIGINT

    # Wait for either process to exit
    wait -n $GATEWAY_PID $CLOUDFLARED_PID
    EXIT_CODE=$?

    # If one exits, stop the other
    kill $GATEWAY_PID $CLOUDFLARED_PID 2>/dev/null || true
    exit $EXIT_CODE

elif [ -n "$DOMAIN" ]; then
    echo "Mode: Caddy (TLS-ALPN-01)"
    echo "Domain: $DOMAIN"

    # Export for Caddyfile template
    export GATEWAY_PORT

    echo "Starting Caddy..."
    caddy run --config /etc/caddy/Caddyfile --adapter caddyfile &
    CADDY_PID=$!

    # Wait for Caddy to initialize
    sleep 2

    echo "Starting gateway on port $GATEWAY_PORT..."
    bun run /app/src/index.ts gateway start --foreground &
    GATEWAY_PID=$!

    # Handle shutdown
    trap "kill $GATEWAY_PID $CADDY_PID 2>/dev/null; exit 0" SIGTERM SIGINT

    # Wait for either process to exit
    wait -n $GATEWAY_PID $CADDY_PID
    EXIT_CODE=$?

    # If one exits, stop the other
    kill $GATEWAY_PID $CADDY_PID 2>/dev/null || true
    exit $EXIT_CODE

else
    echo "Mode: Plain HTTP"
    echo "Starting gateway on port $GATEWAY_PORT..."

    # Handle shutdown
    trap "exit 0" SIGTERM SIGINT

    # Run gateway in foreground
    exec bun run /app/src/index.ts gateway start --foreground
fi
