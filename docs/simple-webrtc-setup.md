# WebRTC Setup (STUN/TURN) with Dedicated coturn-server Stack

This guide explains how to configure a WebRTC relay server (STUN/TURN) using `coturn` with the dedicated Docker Compose stack.

Goal:
- configure TURN/STUN support for peer-to-peer connectivity reliability
- use TURN relay only when direct peer connectivity is not possible

## Architecture Overview

Recommended model:
- Your application signaling/authentication layer: control-plane
- WebRTC data channel: direct peer-to-peer data path
- TURN/STUN (coturn): NAT traversal and fallback relay for difficult networks

## Prerequisites

- Docker Engine
- Docker Compose plugin (`docker compose`)
- Public server reachable from peers
- Open firewall ports for TURN/STUN

## 1) Configure turnserver.conf

Edit:

- `turnserver.conf`

Set at least:

```conf
realm=www.example.com
user=coturn:replace-with-strong-password
listening-port=3478
tls-listening-port=5349
cert=/var/lib/coturn/certs/cert.pem
pkey=/var/lib/coturn/certs/key.pem
min-port=49160
max-port=49200
# external-ip=YOUR_PUBLIC_IP_OR_DNS
```

Notes:
- `external-ip` is strongly recommended in production.
- Use a strong password in the `user=` directive.
- Keep relay port range reasonably small for easier firewall management.

### Generate TURN TLS certificate

The preferred path is to run the CLI from the host repo checkout so the certificate lands in `cert/` and the container can be restarted automatically when Docker Compose is available:

```bash
node daemonctl.js generate-tls-cert --bits 2048 --days 3650
```

If you prefer to generate the certificate directly inside the running coturn container, use the OpenSSL one-liner below and then recreate the service:

```bash
docker compose up -d
docker compose exec coturn sh -lc "openssl req -x509 -newkey rsa:2048 -keyout /var/lib/coturn/certs/key.pem -out /var/lib/coturn/certs/cert.pem -days 3650 -nodes -subj '/CN=turn.local' && chmod 700 /var/lib/coturn/certs && chmod 644 /var/lib/coturn/certs/cert.pem && chmod 600 /var/lib/coturn/certs/key.pem"
docker compose up -d --force-recreate coturn
```

Notes:
- Certificate and key are persisted in `cert/` and mounted into the container.
- For production use a real certificate and set CN/SAN to your public TURN hostname.
- If you generated certs previously from host and still see TLS permission errors, regenerate with `docker compose exec` as shown above.

## 2) Start Services

Start coturn stack:

```bash
docker compose up -d
```

Check service status:

```bash
docker compose ps
```

Read coturn logs:

```bash
docker compose logs -f coturn
```

## 3) Firewall / Network Rules

Allow inbound to the host:

- UDP `3478` (STUN/TURN)
- TCP `3478` (TURN over TCP)
- TCP `5349` (TURN over TLS)
- UDP relay range `49160-49200` (or your configured range)

If you use cloud security groups, open the same ports there.

## 4) TURN URL Configuration in Clients

Use these ICE server entries in your WebRTC implementation:

- `stun:YOUR_HOST:3478`
- `turn:YOUR_HOST:3478?transport=udp`
- `turn:YOUR_HOST:3478?transport=tcp`
- `turns:YOUR_HOST:5349?transport=tcp` (if TLS configured)

Credentials:
- username: from `user=<username>:<password>` in `turnserver.conf`
- credential: from `user=<username>:<password>` in `turnserver.conf`

## 5) Production Hardening (Recommended)

- Prefer DNS hostname in `COTURN_REALM` and client URLs.
- Use strong secrets in the `user=` directive.
- Enable TLS for TURN (`5349`) with valid certificates.
- Restrict relay port range and monitor usage.
- Rotate TURN credentials periodically.

## 6) Verify Connectivity

Basic checks:

```bash
docker compose config
```

```bash
docker compose logs -f coturn
```

When peers connect, check logs for allocations/relay usage.

Expected behavior:
- direct P2P when possible
- TURN relay only when direct path fails

## 7) Troubleshooting

If peers cannot connect:

1. Verify `external-ip` in `turnserver.conf` is correct.
2. Verify host firewall and cloud security groups allow required ports.
3. Verify client ICE config includes both STUN and TURN entries.
4. Verify TURN credentials match `turnserver.conf`.
5. Verify NAT-heavy mobile networks may require TURN relay more often.

If TURN allocates but traffic is unstable:

1. Increase relay UDP range if heavily loaded.
2. Ensure no upstream firewall/NAT timeout is killing UDP flows.
3. Prefer TURN over TLS (`5349`) in restrictive enterprise networks.

## 8) Operations

Stop coturn stack:

```bash
docker compose down
```

Preserve runtime data by default (named volume `vol-coturn-data`).

To remove all persisted data volumes:

```bash
docker compose down -v
```
