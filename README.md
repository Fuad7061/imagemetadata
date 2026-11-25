# ImageMetadata

Self-hosted image metadata API + admin dashboard. It embeds realistic EXIF/XMP/IPTC camera metadata into images, strips metadata when asked, and exposes everything through a protected web UI.

The original Cloudflare Worker (`worker.js`) is kept untouched as a reference. `src/core.js` is a direct port of its logic: same endpoints, same request fields, same validation limits, same camera profiles, same EXIF/XMP/IPTC tags, and the same default upload chain (`tmpfiles.org` → `uguu.se` → `litterbox`), with `catbox.moe` (permanent) available as an extra provider in Settings.

## Features

- **Same API as the worker**: `POST /embed-metadata`, `POST /strip-metadata`, `GET /docs`.
- **Dashboard at `/`** protected by an admin key (session cookie, HttpOnly).
- **API keys** generated in the UI; cURL uses `Authorization: Bearer <key>`. Per-key expiry, rate limit, enable/disable, delete, and usage counters.
- **Playground** to test requests from the UI and copy the equivalent cURL.
- **Local self-hosted storage** option (toggle in Settings) instead of third-party temp hosts, with file expiry and cleanup.
- **Rate limiting**, request logs, live stats, and audit trail for admin actions.
- **10-day log retention, enforced**: the setting is hard-capped at 10 days, cleanup runs hourly and on boot, and Docker log rotation is configured in `docker-compose.yml`.
- **Zero runtime dependencies**, gzip responses, in-memory static assets, small single-stage Docker image (`node:22-bookworm-slim`, non-root).

## Quick start

### Local (Node 20+)

```bash
npm start
```

On first boot, if `ADMIN_KEY` is not set, a random key is printed in the terminal and written to `data/ADMIN_KEY.txt`. Open <http://localhost:3000> and sign in with it.

### Docker Compose

```bash
cp .env.example .env      # optional; set ADMIN_KEY before first boot if you want a fixed key
docker compose up -d --build
```

Dashboard: <http://localhost:3000>. Data persists in `./data`.

## Push to GitHub

The repository is ready to initialise and push:

```bash
git init
git add .
git commit -m "Initial ImageMetadata deployment"
git remote add origin https://github.com/<your-user>/<your-repo>.git
git branch -M main
git push -u origin main
```

The `.gitignore` excludes `data/`, `node_modules/`, and local env files, so no keys or logs are committed.

## Deploy in Coolify (Dockerfile)

1. In Coolify, create a **New resource → Application**.
2. Source: **GitHub** → select the repository and branch `main`.
3. Build pack: **Dockerfile** (Coolify detects `Dockerfile` at the repo root).
4. Set the port to **3000**.
5. Add environment variables in Coolify:
   - `ADMIN_KEY` = a long random secret (required recommendation)
   - `PUBLIC_BASE_URL` = `https://<your-coolify-domain>` (so returned links are correct)
   - `LOG_RETENTION_DAYS` = `10`
   - `MAX_BODY_SIZE_MB` = `15`
   - `TRUST_PROXY` = `1` (Coolify sits behind a proxy)
6. Add a persistent volume: `/app/data` → mount to a local path or named volume, so API keys and the admin key survive redeploys.
7. Deploy. Health check hits `GET /health`.

If `ADMIN_KEY` is omitted, read the generated key from the container logs or from `/app/data/ADMIN_KEY.txt` inside the volume.

## API

All `/embed-metadata` and `/strip-metadata` calls require a key created in the dashboard:

```
Authorization: Bearer im_xxxxxxxxxxxxxxxxxxxxxxxx
```

`GET /docs` returns raw markdown documentation; `GET /health` is public.

### `POST /embed-metadata`

| Field | Type | Required | Notes |
|---|---|---|---|
| `image_path` | string | yes | Public HTTP(S) URL or Base64 (`data:image/...` or raw) |
| `title` | string | yes | max 200 chars |
| `description` | string | no | max 2000 chars |
| `keywords` | array | no | max 50 strings |
| `category`, `creator`, `copyright` | string | no | IPTC/XMP fields |
| `camera_profile` | string | no | `sony-a7iv-85`, `nikon-z8-35`, `canon-r5-50`, `fuji-xt5-23`; random if omitted |
| `software` | string | no | overrides EXIF Software |
| `location` | object | no | `{lat, lon, city, country}`; random city if omitted |

Input formats: JPEG, PNG, WebP, GIF, BMP, TIFF. Output is always JPEG. Non-JPEG URLs are transcoded with wsrv.nl (`q=99`) before embedding.

```bash
curl -X POST https://<your-domain>/embed-metadata \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <API_KEY>" \
  -d '{
    "image_path": "https://example.com/photo.jpg",
    "title": "A beautiful sunset",
    "description": "Sunset over the mountains.",
    "keywords": ["sunset", "mountains", "nature"],
    "category": "Nature",
    "creator": "Your Name",
    "camera_profile": "sony-a7iv-85",
    "location": {"lat": 48.8566, "lon": 2.3522, "city": "Paris", "country": "France"}
  }'
```

Response includes `metadata_image_url` (the direct tmpfiles.org download link, ~1h), `metadata_image_page_url` (the tmpfiles.org file page URL), `expires_at`, `upload_provider`, `file_size_bytes`, `format`, `output_format`, `metadata`, and `exif_context`. Neither URL needs an extra upload. Optionally, `long_lived_image_url`, `long_lived_expires_at`, and `long_lived_upload_provider` (uguu.se, ~48h) are added when **Add 48-hour image URL** is enabled in Settings — it is off by default.

### `POST /strip-metadata`

Only `image_path` is required. Response includes `stripped_image_url`, `stripped_image_page_url`, `expires_at`, `upload_provider`, `file_size_bytes`, `format`, `output_format`, and the optional `long_lived_*` fields.

## Dashboard

- **Overview** — 24h requests, success rate, latency, active keys, hourly chart, recent activity, quick-start cURL.
- **API Keys** — create (secret shown once), enable/disable, delete, usage stats.
- **Playground** — send a test request and copy the cURL command.
- **Logs** — searchable request history; automatically pruned after 10 days.
- **Settings** — anonymous access toggle, upload target, 48-hour URL toggle (off by default), provider order (including permanent catbox.moe), public base URL, default camera/location, rate limits, local file lifetime (`0` = never), admin key rotation.
- **API Docs** — parameter reference and a cURL example using your key.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `ADMIN_KEY` | auto-generated | Dashboard admin key; generated and saved if omitted |
| `PORT` | `3000` | Listen port |
| `HOST` | `0.0.0.0` | Listen address |
| `DATA_DIR` | `./data` | Persistent state, keys, logs, local files |
| `PUBLIC_BASE_URL` | request host | Public origin used in generated links |
| `LOG_RETENTION_DAYS` | `10` | Hard-capped at 10 |
| `MAX_BODY_SIZE_MB` | `15` | Max JSON body (base64 images need more) |
| `SESSION_TTL_HOURS` | `168` | Admin session lifetime |
| `TRUST_PROXY` | off | Honour `X-Forwarded-For` |
| `CORS_ORIGIN` | `*` | Allowed browser origins for API endpoints |

## Security notes

- Admin key and API keys are stored as salted SHA-256 hashes; secrets are shown only once.
- Admin authentication uses timing-safe comparison, HttpOnly/SameSite cookies, and login throttling.
- Security headers and a strict CSP are applied to every response.
- The API is key-gated by default; anonymous access is an explicit opt-in.
- Mount `/app/data` as a persistent volume; rotating the admin key invalidates all sessions.

## Project structure

```
Dockerfile            single-stage, non-root, healthcheck
docker-compose.yml    local deployment + Docker log rotation
worker.js             original Cloudflare Worker (unchanged reference)
src/core.js           ported metadata engine (same parameters as worker.js)
src/server.js         HTTP server, public API, admin API
src/store.js          atomic JSON state, keys, logs, retention cleanup
src/auth.js           admin/API key verification, sessions
src/ratelimit.js      in-memory sliding-window limiter
src/http-utils.js     gzip, security headers, body limits, cookies
public/               dashboard UI (no external CDN dependencies)
```

## Suggestions / notes

- Keep `PUBLIC_BASE_URL` set in Coolify; otherwise links in API responses use the internal request host, which may not be reachable publicly.
- External upload providers are free temp hosts: the direct download URL lasts ~1h, the returned file-page URL is provided with no extra upload, and the optional uguu.se URL lasts ~48h. For no expiry, switch Settings → **Upload target** to **Self-hosted local storage** with TTL `0`, or move `catbox` to the top of **External provider order**. Keep `/app/data` persistent for local storage.
- If you expect large base64 images, raise `MAX_BODY_SIZE_MB` in Coolify.
