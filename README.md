## Configure

Create your local TURN config from the example:

```bash
cp turnserver.example.conf turnserver.conf
```

Edit `turnserver.conf`:

- `realm`
- `user=<username>:<password>`
- `listening-port`
- `tls-listening-port`
- `cert` / `pkey`
- `min-port` / `max-port`
- optional `external-ip`

Create a local `.env` from `.env.example` and set `USER_UID` and `USER_GID` to match the owner of `cert/` on the host. The container runs with those IDs so TLS files can be created without permission issues.

Generate a self-signed certificate into `cert/` from the host repo checkout:

```bash
node daemonctl.js generate-tls-cert --bits 4096 --days 3650
```

Generate a Let's Encrypt signed certificate (webroot challenge) from the host repo checkout:

```bash
node daemonctl.js generate-tls-cert --signed --cn example.com --domain www.example.com --webroot /var/www/html --bits 4096
```

Requirements for signed mode:

- `certbot` must be installed on the host.
- The domains must point to this server.
- Port `80` must be reachable for HTTP challenge.
- The provided `--webroot` must be served by your web server for those domains.

The CLI writes `cert.pem` and `key.pem` into `cert/`. When Docker Compose is available on the host, it also restarts the `coturn` container so the new certificate is picked up.

If you prefer to generate the certificate directly inside the running container, use:

```bash
docker compose up -d
docker compose exec coturn sh -lc "openssl req -x509 -newkey rsa:4096 -keyout /var/lib/coturn/certs/key.pem -out /var/lib/coturn/certs/cert.pem -days 3650 -nodes -subj '/CN=turn.local' && chmod 700 /var/lib/coturn/certs && chmod 644 /var/lib/coturn/certs/cert.pem && chmod 600 /var/lib/coturn/certs/key.pem"
```

If you replace `cert.pem` or `key.pem` from the host, restart the container manually:

```bash
docker compose restart coturn
```

If you still get TLS permission errors, regenerate the files from inside the container as shown above.

## Start

```bash
docker compose up -d
```

## Apply config changes

After editing `turnserver.conf`, restart the container:

```bash
docker compose restart coturn
```

## Logs

```bash
docker compose logs -f coturn
```

## Stop

```bash
docker compose down
```
