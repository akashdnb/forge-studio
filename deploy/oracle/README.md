# Oracle VM deployment

This bundle runs Forge Studio as a single-host Docker Compose deployment on an Oracle Cloud ARM VM.

## Recommended Oracle shape

Use `VM.Standard.A1.Flex` with 2 OCPUs and 12 GB RAM. Keep the existing `VM.Standard.E2.1.Micro` instance separate; it cannot be resized and is too small for the full Compose topology.

## Bootstrap

1. Provision an Ubuntu ARM64 Oracle VM with at least 80 GB boot storage.
2. Install Docker Engine and the Compose plugin.
3. Clone this repository and check out the release SHA you intend to deploy.
4. From this directory:

```bash
cp .env.example .env
chmod 600 .env
```

Generate secrets locally on the VM, for example:

```bash
openssl rand -hex 32
openssl rand -hex 32
openssl rand -hex 32
openssl rand -hex 32
```

Use those values for the password and application secrets in `.env`.

5. Build and migrate:

```bash
docker compose build
docker compose run --rm migrate
```

6. Start the stack:

```bash
docker compose up -d
```

7. Verify:

```bash
docker compose ps
curl -fsS http://127.0.0.1/healthz
curl -fsS http://127.0.0.1/readyz
```

The dashboard is available on port 80. Enter the same host URL and the `API_BEARER_TOKEN` from `.env` in the dashboard's connection panel.

## Services

- `forge-api`: main Forge Studio API on internal port 8080.
- `forge-worker`: durable workflow worker and local render scratch worker.
- `forge-event-worker`: durable event delivery worker.
- `forge-event-api`: authenticated event-delivery API on internal port 8090.
- `forge-inbound-webhook`: signed inbound webhook API on internal port 8091.
- `postgres`: private PostgreSQL database.
- `caddy`: public HTTP/HTTPS entry point and static dashboard server.

Only Caddy publishes ports 80/443. PostgreSQL is never published.

## Production hardening after bootstrap

- Attach a real DNS name and let Caddy manage HTTPS.
- Move artifact storage from local disk to OCI Object Storage (`FORGE_STORAGE_DRIVER=s3`).
- Add a least-privilege GitHub token and enable GitHub Actions execution for heavy jobs.
- Restrict OCI security-list ingress to 22/tcp from the operator IP and 80/443/tcp publicly.
- Back up the PostgreSQL volume and test restore before using the VM as the only durable copy.
- Keep `.env` outside Git and at mode `0600`.
