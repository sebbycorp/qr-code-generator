# QR Code Generator

Free QR code generator with optional URL shortening. Dark UI, no limits, no sign-up, no ads.

**Features:**
- URL, text, email, phone — anything goes
- Optional built-in URL shortener for long links
- Adjustable size (100–800px) and error correction level
- Custom dark/light colors
- Embed a logo in the centre: upload your own image or pick a bundled Solo.io open source project logo
- Download as PNG or SVG (the logo is baked into both)
- Copy PNG or the generated short URL
- Runs locally with SQLite by default

## Logos in QR codes

Choose a logo under **Logo (optional)**. You can upload a PNG, JPG, SVG or WebP (2 MB max, transparent background recommended) or use one of the bundled presets, each available as an icon or a full wordmark:

| Preset | Source |
| --- | --- |
| kgateway | [kgateway-dev/kgateway](https://github.com/kgateway-dev/kgateway) (assets from [kgateway.dev](https://github.com/kgateway-dev/kgateway.dev)) |
| kagent | [kagent-dev/kagent](https://github.com/kagent-dev/kagent) |
| agentgateway | [agentgateway/agentgateway](https://github.com/agentgateway/agentgateway) |
| agentregistry | [agentregistry-dev/agentregistry](https://github.com/agentregistry-dev/agentregistry) |
| agentdesktop | [agentdesktop-dev/agentdesktop](https://github.com/agentdesktop-dev/agentdesktop) |

How it works:

- The server still renders the plain QR code; the browser composites the logo onto a backdrop in the centre and produces the final PNG (canvas) and SVG (embedded `<image>`), so no native image libraries are needed.
- Error correction is forced to **High (H)** whenever a logo is present. The logo size slider controls the footprint (12–28% of the code width); wide wordmarks keep the same area but stretch horizontally.
- The backdrop snaps to whole QR modules so partially covered modules never confuse scanners. Always test the result with a phone before printing.
- Wordmarks automatically switch to their light-on-dark variant when the QR light colour is dark.

Preset files live in `public/logos/` and are served from `/logos/*`; `/api/logos` lists them. The logos are trademarks of their respective projects and are included only for convenience.

## Run with Docker (recommended)

```bash
docker compose up -d
```

Open [http://localhost:4242](http://localhost:4242)

### Local short-link storage

Docker Compose uses a named volume and stores short links in SQLite at `/app/data/shortener.sqlite`.

If you want the generated links to use a public hostname, set:

```bash
SHORT_BASE_URL=https://s.maniak.io
```

## Run without Docker

```bash
npm install
npm start
```

Requires Node.js 18+.

By default the app uses SQLite locally. Override if needed:

```bash
SHORT_STORAGE=sqlite
SHORT_DB_PATH=./data/shortener.sqlite
SHORT_BASE_URL=http://localhost:4242
```

## Production on Cloud Run

This repo includes Terraform for Cloud Run. In production the app is configured to use **Firestore** for durable short-link storage and serves:

- `https://qr.maniak.io` → QR generator UI
- `https://s.maniak.io/<code>` → short redirects

## Build the image manually

```bash
docker build -t qr-generator .
docker run -p 4242:4242 qr-generator
```
