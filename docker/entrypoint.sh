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

# Function to monitor two background processes
# Exits when either process terminates
monitor_processes() {
    PID1=$1
    PID2=$2

    while kill -0 "$PID1" 2>/dev/null && kill -0 "$PID2" 2>/dev/null; do
        sleep 1
    done

    # One process died, kill the other
    kill "$PID1" "$PID2" 2>/dev/null || true
    wait "$PID1" "$PID2" 2>/dev/null || true
}

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

    # Monitor both processes
    monitor_processes $GATEWAY_PID $CLOUDFLARED_PID

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

    # Monitor both processes
    monitor_processes $GATEWAY_PID $CADDY_PID

else
    echo "Mode: Plain HTTP"
    echo "Starting gateway on port $GATEWAY_PORT..."

    # Handle shutdown
    trap "exit 0" SIGTERM SIGINT

    # Run gateway in foreground
    exec bun run /app/src/index.ts gateway start --foreground
fi
