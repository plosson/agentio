# Agentio Gateway Docker

A single Docker image for running the Agentio Gateway with three deployment modes:

| Mode | Use Case | Ports Required |
|------|----------|----------------|
| **Cloudflare Tunnel** | Behind NAT, no public IP | None |
| **Caddy** | Public server with domain | 443 |
| **Plain HTTP** | Local dev, external proxy | 7890 |

## Prerequisites

Export your agentio configuration locally:

```bash
agentio config export
```

This outputs two environment variables:
- `AGENTIO_KEY` - Encryption key (64 hex characters)
- `AGENTIO_CONFIG` - Encrypted configuration blob

## Building the Image

From the repository root:

```bash
docker build -f docker/Dockerfile -t agentio-gateway .
```

## Deployment Modes

### Mode 1: Cloudflare Tunnel (Recommended)

Best for: Servers behind NAT, home labs, no public IP needed.

1. Create a tunnel in [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com/)
2. Configure the tunnel to point to `http://localhost:7890`
3. Copy the tunnel token

```bash
docker run -d \
  --name agentio-gateway \
  -e AGENTIO_KEY=your_key_here \
  -e AGENTIO_CONFIG=your_config_here \
  -e CLOUDFLARE_TUNNEL_TOKEN=eyJhIjoiYWNj... \
  -v agentio-data:/data \
  --restart unless-stopped \
  agentio-gateway
```

### Mode 2: Caddy with Let's Encrypt

Best for: VPS or server with public IP and domain name.

Requirements:
- Port 443 accessible from the internet
- DNS A record pointing to your server

```bash
docker run -d \
  --name agentio-gateway \
  -e AGENTIO_KEY=your_key_here \
  -e AGENTIO_CONFIG=your_config_here \
  -e DOMAIN=gateway.example.com \
  -p 443:443 \
  -v agentio-data:/data \
  -v agentio-certs:/certs \
  --restart unless-stopped \
  agentio-gateway
```

Caddy automatically obtains and renews Let's Encrypt certificates using TLS-ALPN-01 challenge (no port 80 needed).

### Mode 3: Plain HTTP

Best for: Local development, testing, or behind an external reverse proxy.

```bash
docker run -d \
  --name agentio-gateway \
  -e AGENTIO_KEY=your_key_here \
  -e AGENTIO_CONFIG=your_config_here \
  -p 7890:7890 \
  -v agentio-data:/data \
  --restart unless-stopped \
  agentio-gateway
```

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `AGENTIO_KEY` | Encryption key from `agentio config export` |
| `AGENTIO_CONFIG` | Encrypted config from `agentio config export` |

### Mode-specific

| Variable | Mode | Description |
|----------|------|-------------|
| `CLOUDFLARE_TUNNEL_TOKEN` | Cloudflare | Tunnel token from Cloudflare dashboard |
| `DOMAIN` | Caddy | Public domain for TLS certificate |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `GATEWAY_PORT` | `7890` | Internal gateway port |
| `ACME_EMAIL` | (none) | Email for Let's Encrypt notifications |

## Volumes

| Path | Description |
|------|-------------|
| `/data` | Configuration, database, media files |
| `/certs` | TLS certificates (Caddy mode only) |

## Health Check

The container includes a health check on the `/health` endpoint:

```bash
docker inspect --format='{{.State.Health.Status}}' agentio-gateway
```

## Logs

```bash
# View logs
docker logs agentio-gateway

# Follow logs
docker logs -f agentio-gateway
```

## Updating

```bash
docker pull agentio-gateway:latest
docker stop agentio-gateway
docker rm agentio-gateway
# Re-run with same docker run command
```

## WhatsApp Pairing

If you're using WhatsApp and need to pair a new device:

1. Ensure the gateway is running and accessible
2. Access the pairing endpoint: `GET /whatsapp/pair/{profile}`
3. Scan the QR code with WhatsApp

For remote gateways, you can use teleport to migrate existing WhatsApp sessions:

```bash
# On your local machine with an authenticated WhatsApp session
agentio gateway teleport https://your-gateway.example.com
```

## Troubleshooting

### Configuration not loading

Verify your environment variables are set correctly:
```bash
docker exec agentio-gateway env | grep AGENTIO
```

### Cloudflare tunnel not connecting

Check cloudflared logs:
```bash
docker logs agentio-gateway 2>&1 | grep cloudflared
```

### Caddy certificate issues

Ensure:
- Port 443 is accessible from the internet
- DNS is correctly configured
- Domain resolves to your server's IP

Check Caddy logs:
```bash
docker logs agentio-gateway 2>&1 | grep caddy
```

### Gateway not starting

Check if the gateway process is running:
```bash
docker exec agentio-gateway ps aux
```
