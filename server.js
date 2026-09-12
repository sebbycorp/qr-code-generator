const express = require('express');
const QRCode = require('qrcode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { Firestore, FieldValue } = require('@google-cloud/firestore');

const app = express();
app.set('trust proxy', true);
app.use(express.json());

const PORT = parseInt(process.env.PORT || '4242', 10);
const DATA_DIR = path.join(__dirname, 'data');
const SHORT_DB_PATH = process.env.SHORT_DB_PATH || path.join(DATA_DIR, 'shortener.sqlite');
const SHORT_BASE_URL = (process.env.SHORT_BASE_URL || '').replace(/\/+$/, '');
const FIRESTORE_COLLECTION = process.env.FIRESTORE_COLLECTION || 'short_links';
const SHORT_CODE_LENGTH = parseInt(process.env.SHORT_CODE_LENGTH || '6', 10);
const SHORT_STORAGE = detectStorageBackend();
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const SQLJS_DIST_DIR = path.dirname(require.resolve('sql.js/dist/sql-wasm.js'));
const LOGOS_DIR = path.join(__dirname, 'public', 'logos');

// Bundled logo presets (Solo.io open source projects). Files live in public/logos and are
// served at /logos/*. Each preset has a square mark plus a wordmark for light and dark QR
// backgrounds. Logos are trademarks of their respective projects.
const LOGO_PRESETS = [
  {
    id: 'kgateway',
    name: 'kgateway',
    mark: '/logos/kgateway-mark.svg',
    wordmark: '/logos/kgateway-wordmark.svg',
    wordmarkDark: '/logos/kgateway-wordmark-dark.svg',
    source: 'https://github.com/kgateway-dev/kgateway',
  },
  {
    id: 'kagent',
    name: 'kagent',
    mark: '/logos/kagent-mark.svg',
    wordmark: '/logos/kagent-wordmark.svg',
    wordmarkDark: '/logos/kagent-wordmark-dark.svg',
    source: 'https://github.com/kagent-dev/kagent',
  },
  {
    id: 'agentgateway',
    name: 'agentgateway',
    mark: '/logos/agentgateway-mark.svg',
    wordmark: '/logos/agentgateway-wordmark.svg',
    wordmarkDark: '/logos/agentgateway-wordmark-dark.svg',
    source: 'https://github.com/agentgateway/agentgateway',
  },
  {
    id: 'agentregistry',
    name: 'agentregistry',
    mark: '/logos/agentregistry-mark.svg',
    wordmark: '/logos/agentregistry-wordmark.svg',
    wordmarkDark: '/logos/agentregistry-wordmark-dark.svg',
    source: 'https://github.com/agentregistry-dev/agentregistry',
  },
  {
    id: 'agentdesktop',
    name: 'agentdesktop',
    mark: '/logos/agentdesktop-mark.svg',
    wordmark: '/logos/agentdesktop-wordmark.svg',
    wordmarkDark: '/logos/agentdesktop-wordmark-dark.svg',
    source: 'https://github.com/agentdesktop-dev/agentdesktop',
  },
];

class SqliteShortLinkStore {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
    this.SQL = null;
  }

  async init() {
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });

    this.SQL = await initSqlJs({
      locateFile: (file) => path.join(SQLJS_DIST_DIR, file),
    });

    if (fs.existsSync(this.dbPath)) {
      this.db = new this.SQL.Database(fs.readFileSync(this.dbPath));
    } else {
      this.db = new this.SQL.Database();
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS links (
        code TEXT PRIMARY KEY,
        long_url TEXT NOT NULL,
        created_at TEXT NOT NULL,
        hit_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_links_created_at ON links(created_at);
    `);

    this.persist();
  }

  persist() {
    fs.writeFileSync(this.dbPath, Buffer.from(this.db.export()));
  }

  get(code) {
    const stmt = this.db.prepare(
      'SELECT code, long_url, created_at, hit_count FROM links WHERE code = ? LIMIT 1'
    );

    try {
      stmt.bind([code]);
      if (!stmt.step()) return null;

      const row = stmt.getAsObject();
      return {
        code: row.code,
        longUrl: row.long_url,
        createdAt: row.created_at,
        hitCount: Number(row.hit_count || 0),
      };
    } finally {
      stmt.free();
    }
  }

  create(code, longUrl) {
    const createdAt = new Date().toISOString();
    this.db.run(
      'INSERT INTO links (code, long_url, created_at, hit_count) VALUES (?, ?, ?, 0)',
      [code, longUrl, createdAt]
    );
    this.persist();
    return { code, longUrl, createdAt, hitCount: 0 };
  }

  incrementHitCount(code) {
    this.db.run('UPDATE links SET hit_count = hit_count + 1 WHERE code = ?', [code]);
    this.persist();
  }
}

class FirestoreShortLinkStore {
  constructor() {
    this.collection = null;
  }

  async init() {
    const firestore = new Firestore();
    this.collection = firestore.collection(FIRESTORE_COLLECTION);
  }

  async get(code) {
    const snap = await this.collection.doc(code).get();
    if (!snap.exists) return null;

    const data = snap.data();
    return {
      code,
      longUrl: data.longUrl,
      createdAt: data.createdAt,
      hitCount: Number(data.hitCount || 0),
    };
  }

  async create(code, longUrl) {
    const createdAt = new Date().toISOString();
    await this.collection.doc(code).create({
      longUrl,
      createdAt,
      hitCount: 0,
    });

    return { code, longUrl, createdAt, hitCount: 0 };
  }

  async incrementHitCount(code) {
    await this.collection.doc(code).set(
      {
        hitCount: FieldValue.increment(1),
        lastAccessedAt: new Date().toISOString(),
      },
      { merge: true }
    );
  }
}

function detectStorageBackend() {
  if (process.env.SHORT_STORAGE) return process.env.SHORT_STORAGE;
  if (process.env.K_SERVICE && (process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT)) {
    return 'firestore';
  }
  return 'sqlite';
}

function createStore() {
  if (SHORT_STORAGE === 'firestore') return new FirestoreShortLinkStore();
  if (SHORT_STORAGE === 'sqlite') return new SqliteShortLinkStore(SHORT_DB_PATH);
  throw new Error(`Unsupported SHORT_STORAGE backend: ${SHORT_STORAGE}`);
}

const shortLinkStore = createStore();
const shortLinkStoreReady = shortLinkStore.init();

function buildBaseUrl(req) {
  if (SHORT_BASE_URL) return SHORT_BASE_URL;
  return `${req.protocol}://${req.get('host')}`;
}

function normalizeHttpUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new Error('Enter a valid http(s) URL to shorten.');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only http(s) URLs can be shortened.');
  }

  return parsed.toString();
}

function makeCode(length = SHORT_CODE_LENGTH) {
  let code = '';
  for (let i = 0; i < length; i += 1) {
    code += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  }
  return code;
}

async function generateUniqueCode() {
  await shortLinkStoreReady;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const code = makeCode();
    // eslint-disable-next-line no-await-in-loop
    const existing = await shortLinkStore.get(code);
    if (!existing) return code;
  }

  throw new Error('Unable to allocate a short code right now.');
}

function renderApp() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>QR Generator</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #0f0f0f;
      color: #e8e8e8;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 2rem;
    }
    .container {
      width: 100%;
      max-width: 560px;
    }
    h1 {
      font-size: 1.4rem;
      font-weight: 600;
      letter-spacing: -0.02em;
      margin-bottom: 0.25rem;
      color: #fff;
    }
    .subtitle {
      font-size: 0.8rem;
      color: #555;
      margin-bottom: 2rem;
    }
    label {
      display: block;
      font-size: 0.75rem;
      font-weight: 500;
      color: #888;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 0.5rem;
    }
    textarea {
      width: 100%;
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
      border-radius: 8px;
      color: #e8e8e8;
      font-size: 0.95rem;
      padding: 0.75rem 1rem;
      resize: vertical;
      min-height: 96px;
      outline: none;
      transition: border-color 0.15s;
      font-family: inherit;
    }
    textarea:focus { border-color: #444; }
    .row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1rem;
      margin-top: 1rem;
    }
    .field { display: flex; flex-direction: column; }
    select, input[type=range], input[type=color] {
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
      border-radius: 8px;
      color: #e8e8e8;
      padding: 0.6rem 0.75rem;
      font-size: 0.9rem;
      outline: none;
      width: 100%;
    }
    input[type=range] { padding: 0.4rem 0; cursor: pointer; accent-color: #7c6ff7; }
    .color-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1rem;
      margin-top: 1rem;
    }
    .color-picker {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
      border-radius: 8px;
      padding: 0.5rem 0.75rem;
    }
    input[type=color] {
      width: 28px;
      height: 28px;
      padding: 0;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      background: none;
    }
    .color-val { font-size: 0.8rem; color: #888; font-family: monospace; }
    .toggle-card {
      margin-top: 1rem;
      display: flex;
      align-items: flex-start;
      gap: 0.9rem;
      background: #141414;
      border: 1px solid #232323;
      border-radius: 12px;
      padding: 0.95rem 1rem;
    }
    .toggle-card input[type=checkbox] {
      margin-top: 0.1rem;
      width: 18px;
      height: 18px;
      accent-color: #7c6ff7;
      cursor: pointer;
    }
    .toggle-copy {
      display: flex;
      flex-direction: column;
      gap: 0.2rem;
    }
    .toggle-copy strong {
      font-size: 0.9rem;
      color: #f5f5f5;
      font-weight: 600;
    }
    .toggle-copy span {
      font-size: 0.78rem;
      color: #777;
      line-height: 1.45;
    }
    .logo-section { margin-top: 1.25rem; }
    .logo-tiles {
      display: flex;
      flex-wrap: wrap;
      gap: 0.6rem;
    }
    .logo-tile {
      margin: 0;
      width: 58px;
      height: 58px;
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
      border-radius: 10px;
      color: #999;
      font-size: 1.4rem;
      font-weight: 300;
      padding: 0;
      cursor: pointer;
      transition: border-color 0.15s, background 0.15s, box-shadow 0.15s;
      overflow: hidden;
    }
    .logo-tile:hover { background: #202020; border-color: #444; }
    .logo-tile.selected {
      border-color: #7c6ff7;
      box-shadow: 0 0 0 1px #7c6ff7;
      background: #1f1c33;
    }
    .logo-tile img {
      width: 36px;
      height: 36px;
      object-fit: contain;
      display: block;
      pointer-events: none;
    }
    .logo-tile img[hidden], .logo-tile span[hidden] { display: none; }
    .logo-tile.preset { background: #f7f7f9; }
    .logo-tile.preset:hover { background: #fff; }
    .logo-tile.preset.selected { background: #fff; }
    .logo-tile.upload.has-image img { width: 44px; height: 44px; }
    .logo-options {
      margin-top: 1rem;
      background: #141414;
      border: 1px solid #232323;
      border-radius: 12px;
      padding: 1rem;
    }
    .logo-options .row { margin-top: 0; }
    .logo-options .field + .field, .logo-options .stack { margin-top: 1rem; }
    .hint {
      margin-top: 0.75rem;
      font-size: 0.75rem;
      color: #777;
      line-height: 1.45;
    }
    .hint a { color: #9b8fff; text-decoration: none; }
    .logo-caption {
      margin-top: 0.5rem;
      font-size: 0.72rem;
      color: #555;
    }
    button {
      margin-top: 1.5rem;
      width: 100%;
      background: #7c6ff7;
      color: #fff;
      border: none;
      border-radius: 8px;
      padding: 0.8rem;
      font-size: 0.95rem;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s, transform 0.1s, opacity 0.15s;
    }
    button:hover { background: #6a5de8; }
    button:active { transform: scale(0.98); }
    button:disabled { opacity: 0.7; cursor: wait; }
    .output {
      margin-top: 2rem;
      display: none;
      flex-direction: column;
      align-items: center;
      gap: 1rem;
    }
    .output.visible { display: flex; }
    .link-card {
      width: 100%;
      background: #141414;
      border: 1px solid #232323;
      border-radius: 12px;
      padding: 0.9rem 1rem;
      display: none;
      flex-direction: column;
      gap: 0.55rem;
    }
    .link-card.visible { display: flex; }
    .link-label {
      font-size: 0.7rem;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: #666;
    }
    .link-card a, .link-card code {
      color: #9b8fff;
      text-decoration: none;
      word-break: break-all;
      font-size: 0.9rem;
    }
    .link-card p {
      color: #7b7b7b;
      font-size: 0.78rem;
      line-height: 1.45;
    }
    .qr-wrap {
      background: #fff;
      border-radius: 12px;
      padding: 1rem;
      display: inline-block;
    }
    .qr-wrap img { display: block; }
    .actions {
      display: flex;
      gap: 0.75rem;
      flex-wrap: wrap;
      justify-content: center;
    }
    .btn-dl {
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
      color: #e8e8e8;
      border-radius: 8px;
      padding: 0.55rem 1.1rem;
      font-size: 0.85rem;
      font-weight: 500;
      cursor: pointer;
      text-decoration: none;
      transition: border-color 0.15s, background 0.15s;
      width: auto;
      margin: 0;
    }
    .btn-dl:hover { border-color: #444; background: #202020; }
    .error {
      margin-top: 1rem;
      color: #f87171;
      font-size: 0.85rem;
      display: none;
    }
    .built-with {
      margin-top: 3rem;
      text-align: center;
      font-size: 0.7rem;
      color: #444;
      letter-spacing: 0.03em;
    }
    .built-with a {
      color: #666;
      text-decoration: none;
      transition: color 0.15s;
    }
    .built-with a:hover { color: #999; }
    @media (max-width: 640px) {
      body { padding: 1rem; }
      .row, .color-row { grid-template-columns: 1fr; }
      .actions { width: 100%; }
      .btn-dl { flex: 1 1 auto; text-align: center; }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>⬛ QR Generator</h1>
    <p class="subtitle">Free, local, no limits.</p>

    <label for="text">Content</label>
    <textarea id="text" placeholder="URL, text, email, phone, anything..."></textarea>

    <div class="toggle-card">
      <input type="checkbox" id="shortenToggle">
      <div class="toggle-copy">
        <strong>Shorten URL first</strong>
        <span>Turn a long http(s) link into a compact redirect before generating the QR code.</span>
      </div>
    </div>

    <div class="row">
      <div class="field">
        <label for="size">Size (px) — <span id="sizeVal">300</span></label>
        <input type="range" id="size" min="100" max="800" value="300" step="50">
      </div>
      <div class="field">
        <label for="ecLevel">Error Correction</label>
        <select id="ecLevel">
          <option value="L">Low (L)</option>
          <option value="M" selected>Medium (M)</option>
          <option value="Q">Quartile (Q)</option>
          <option value="H">High (H)</option>
        </select>
      </div>
    </div>

    <div class="color-row">
      <div class="field">
        <label>Dark color</label>
        <div class="color-picker">
          <input type="color" id="darkColor" value="#000000">
          <span class="color-val" id="darkVal">#000000</span>
        </div>
      </div>
      <div class="field">
        <label>Light color</label>
        <div class="color-picker">
          <input type="color" id="lightColor" value="#ffffff">
          <span class="color-val" id="lightVal">#ffffff</span>
        </div>
      </div>
    </div>

    <div class="logo-section">
      <label>Logo (optional)</label>
      <div class="logo-tiles" id="logoTiles">
        <button type="button" class="logo-tile selected" data-logo="none" title="No logo" aria-label="No logo">⊘</button>
        <button type="button" class="logo-tile upload" data-logo="upload" id="uploadTile" title="Upload your own image (PNG, JPG, SVG, WebP)" aria-label="Upload an image">
          <span id="uploadPlus">+</span><img id="uploadPreview" alt="" hidden>
        </button>
      </div>
      <input type="file" id="logoFile" accept="image/png,image/jpeg,image/svg+xml,image/webp" hidden>
      <p class="logo-caption" id="logoCaption">Pick a Solo.io open source project logo or upload your own.</p>

      <div class="logo-options" id="logoOptions" hidden>
        <div class="row">
          <div class="field" id="logoStyleField">
            <label for="logoStyle">Style</label>
            <select id="logoStyle">
              <option value="mark" selected>Icon</option>
              <option value="wordmark">Full logo</option>
            </select>
          </div>
          <div class="field">
            <label for="logoShape">Backdrop</label>
            <select id="logoShape">
              <option value="rounded" selected>Rounded square</option>
              <option value="circle">Circle / pill</option>
              <option value="square">Square</option>
            </select>
          </div>
        </div>
        <div class="field stack">
          <label for="logoSize">Logo size — <span id="logoSizeVal">20</span>%</label>
          <input type="range" id="logoSize" min="12" max="28" value="20" step="1">
        </div>
        <p class="hint">Error correction is locked to High (H) while a logo is embedded so the code stays scannable. Keep the logo small and test the result with your phone before printing.</p>
      </div>
    </div>

    <button id="genBtn">Generate QR Code</button>
    <div class="error" id="error"></div>

    <div class="output" id="output">
      <div class="link-card" id="linkCard">
        <span class="link-label">Short URL</span>
        <a id="shortUrlLink" href="#" target="_blank" rel="noopener noreferrer"></a>
        <p id="shortUrlMeta"></p>
      </div>

      <div class="qr-wrap"><img id="qrImg" src="" alt="QR Code"></div>
      <div class="actions">
        <a class="btn-dl" id="dlPng" download="qrcode.png">↓ PNG</a>
        <a class="btn-dl" id="dlSvg" download="qrcode.svg">↓ SVG</a>
        <button class="btn-dl" id="copyBtn" type="button">Copy PNG</button>
        <button class="btn-dl" id="copyShortBtn" type="button" style="display:none">Copy Short URL</button>
      </div>
    </div>

    <div class="built-with">
      Built with AI agents · <a href="https://github.com/openclaw/openclaw" target="_blank" rel="noopener">#openclaw</a>
    </div>
  </div>

  <script>
    const sizeEl = document.getElementById('size');
    const sizeVal = document.getElementById('sizeVal');
    const darkEl = document.getElementById('darkColor');
    const lightEl = document.getElementById('lightColor');
    const errorEl = document.getElementById('error');
    const outputEl = document.getElementById('output');
    const genBtn = document.getElementById('genBtn');
    const shortenToggle = document.getElementById('shortenToggle');
    const linkCard = document.getElementById('linkCard');
    const shortUrlLink = document.getElementById('shortUrlLink');
    const shortUrlMeta = document.getElementById('shortUrlMeta');
    const copyShortBtn = document.getElementById('copyShortBtn');

    const ecEl = document.getElementById('ecLevel');
    const logoTiles = document.getElementById('logoTiles');
    const uploadTile = document.getElementById('uploadTile');
    const uploadPreview = document.getElementById('uploadPreview');
    const uploadPlus = document.getElementById('uploadPlus');
    const logoFile = document.getElementById('logoFile');
    const logoOptions = document.getElementById('logoOptions');
    const logoStyleField = document.getElementById('logoStyleField');
    const logoStyleEl = document.getElementById('logoStyle');
    const logoShapeEl = document.getElementById('logoShape');
    const logoSizeEl = document.getElementById('logoSize');
    const logoSizeVal = document.getElementById('logoSizeVal');
    const logoCaption = document.getElementById('logoCaption');

    const LOGO_PRESETS = ${JSON.stringify(LOGO_PRESETS)};
    const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
    const logoDataUrlCache = {};
    let logoChoice = 'none';
    let uploadDataUrl = null;
    let userEcLevel = ecEl.value;

    sizeEl.addEventListener('input', () => sizeVal.textContent = sizeEl.value);
    darkEl.addEventListener('input', () => document.getElementById('darkVal').textContent = darkEl.value);
    lightEl.addEventListener('input', () => document.getElementById('lightVal').textContent = lightEl.value);
    logoSizeEl.addEventListener('input', () => logoSizeVal.textContent = logoSizeEl.value);
    ecEl.addEventListener('change', () => { if (!ecEl.disabled) userEcLevel = ecEl.value; });

    // --- Logo picker -------------------------------------------------------
    LOGO_PRESETS.forEach((preset) => {
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'logo-tile preset';
      tile.dataset.logo = preset.id;
      tile.title = preset.name;
      tile.setAttribute('aria-label', preset.name + ' logo');
      const img = document.createElement('img');
      img.src = preset.mark;
      img.alt = preset.name;
      tile.appendChild(img);
      logoTiles.appendChild(tile);
    });

    logoTiles.addEventListener('click', (event) => {
      const tile = event.target.closest('.logo-tile');
      if (!tile) return;
      const choice = tile.dataset.logo;
      if (choice === 'upload') {
        if (uploadDataUrl && logoChoice !== 'upload') {
          selectLogo('upload');
        } else {
          logoFile.click();
        }
        return;
      }
      selectLogo(choice);
    });

    logoFile.addEventListener('change', () => {
      const file = logoFile.files && logoFile.files[0];
      logoFile.value = '';
      if (!file) return;
      if (!/^image\\/(png|jpeg|svg\\+xml|webp)$/.test(file.type)) {
        showError('Use a PNG, JPG, SVG or WebP image for the logo.');
        return;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        showError('Logo image must be 2 MB or smaller.');
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        uploadDataUrl = reader.result;
        uploadPreview.src = uploadDataUrl;
        uploadPreview.hidden = false;
        uploadPlus.hidden = true;
        uploadTile.classList.add('has-image');
        uploadTile.title = file.name + ' — click to replace';
        selectLogo('upload');
      };
      reader.onerror = () => showError('Could not read that image.');
      reader.readAsDataURL(file);
    });

    function selectLogo(choice) {
      logoChoice = choice;
      logoTiles.querySelectorAll('.logo-tile').forEach((tile) => {
        tile.classList.toggle('selected', tile.dataset.logo === choice);
      });

      const hasLogo = choice !== 'none';
      logoOptions.hidden = !hasLogo;
      logoStyleField.style.display = choice === 'upload' ? 'none' : '';

      if (hasLogo) {
        if (!ecEl.disabled) userEcLevel = ecEl.value;
        ecEl.value = 'H';
        ecEl.disabled = true;
      } else {
        ecEl.disabled = false;
        ecEl.value = userEcLevel;
      }

      const preset = LOGO_PRESETS.find((p) => p.id === choice);
      if (preset) {
        logoCaption.innerHTML = 'Using the <strong>' + preset.name + '</strong> logo · <a href="' + preset.source + '" target="_blank" rel="noopener noreferrer" style="color:#9b8fff;text-decoration:none">project repo</a>. Logos are trademarks of their respective projects.';
      } else if (choice === 'upload') {
        logoCaption.textContent = 'Using your uploaded image. Images with a transparent background look best.';
      } else {
        logoCaption.textContent = 'Pick a Solo.io open source project logo or upload your own.';
      }
    }

    function relativeLuminance(hex) {
      const value = hex.replace('#', '');
      const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
      const [r, g, b] = [0, 2, 4].map((i) => {
        const channel = parseInt(full.slice(i, i + 2), 16) / 255;
        return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }

    async function fetchAsDataUrl(url) {
      if (logoDataUrlCache[url]) return logoDataUrlCache[url];
      const res = await fetch(url);
      if (!res.ok) throw new Error('Could not load logo (' + res.status + ')');
      const blob = await res.blob();
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Could not read logo'));
        reader.readAsDataURL(blob);
      });
      logoDataUrlCache[url] = dataUrl;
      return dataUrl;
    }

    async function resolveLogoDataUrl() {
      if (logoChoice === 'none') return null;
      if (logoChoice === 'upload') return uploadDataUrl;
      const preset = LOGO_PRESETS.find((p) => p.id === logoChoice);
      if (!preset) return null;
      if (logoStyleEl.value === 'wordmark') {
        const onDarkBackground = relativeLuminance(lightEl.value) < 0.4;
        return fetchAsDataUrl(onDarkBackground ? preset.wordmarkDark : preset.wordmark);
      }
      return fetchAsDataUrl(preset.mark);
    }

    function loadImage(src) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Could not decode the logo image.'));
        img.src = src;
      });
    }

    function roundedRectPath(ctx, x, y, w, h, r) {
      const radius = Math.min(r, w / 2, h / 2);
      ctx.beginPath();
      ctx.moveTo(x + radius, y);
      ctx.lineTo(x + w - radius, y);
      ctx.arcTo(x + w, y, x + w, y + radius, radius);
      ctx.lineTo(x + w, y + h - radius);
      ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
      ctx.lineTo(x + radius, y + h);
      ctx.arcTo(x, y + h, x, y + h - radius, radius);
      ctx.lineTo(x, y + radius);
      ctx.arcTo(x, y, x + radius, y, radius);
      ctx.closePath();
    }

    // Composite the logo into the centre of the QR code. All geometry is computed in QR
    // module units (the SVG viewBox), so the PNG and SVG outputs match exactly and the
    // backdrop snaps to whole modules — partially covered modules confuse scanners.
    async function embedLogo(qrData, logoDataUrl) {
      const viewBox = qrData.svg.match(/viewBox="0 0 (\\d+) (\\d+)"/);
      if (!viewBox) throw new Error('Unexpected QR SVG output.');
      const N = parseInt(viewBox[1], 10);

      const [qrImg, logoImg] = await Promise.all([loadImage(qrData.png), loadImage(logoDataUrl)]);
      const ratio = logoImg.naturalWidth && logoImg.naturalHeight
        ? logoImg.naturalWidth / logoImg.naturalHeight
        : 1;

      // The slider sets the logo footprint as if it were square; wide logos keep the same
      // area but grow horizontally, so a wordmark stays legible without covering more code.
      const pct = parseInt(logoSizeEl.value, 10) / 100;
      const area = (pct * N) * (pct * N);
      let w = Math.sqrt(area * ratio);
      let h = Math.sqrt(area / ratio);
      const maxW = 0.55 * N;
      if (w > maxW) { w = maxW; h = w / ratio; }
      const pad = Math.max(0.6, Math.min(w, h) * 0.14);

      const bx = Math.max(0, Math.floor((N - w) / 2 - pad));
      const by = Math.max(0, Math.floor((N - h) / 2 - pad));
      const bw = Math.min(N, Math.ceil((N + w) / 2 + pad)) - bx;
      const bh = Math.min(N, Math.ceil((N + h) / 2 + pad)) - by;
      const lx = (N - w) / 2;
      const ly = (N - h) / 2;

      const shape = logoShapeEl.value;
      const rx = shape === 'circle' ? Math.min(bw, bh) / 2 : shape === 'rounded' ? Math.min(bw, bh) * 0.22 : 0;
      const light = lightEl.value;

      // PNG via canvas.
      const S = qrImg.naturalWidth;
      const s = S / N;
      const canvas = document.createElement('canvas');
      canvas.width = S;
      canvas.height = qrImg.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(qrImg, 0, 0);
      ctx.fillStyle = light;
      roundedRectPath(ctx, bx * s, by * s, bw * s, bh * s, rx * s);
      ctx.fill();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(logoImg, lx * s, ly * s, w * s, h * s);
      const png = canvas.toDataURL('image/png');

      // SVG via injection into the generated markup.
      const fmt = (n) => Number(n.toFixed(3)).toString();
      const overlay =
        '<rect x="' + bx + '" y="' + by + '" width="' + bw + '" height="' + bh + '" rx="' + fmt(rx) + '" fill="' + light + '" shape-rendering="geometricPrecision"/>' +
        '<image x="' + fmt(lx) + '" y="' + fmt(ly) + '" width="' + fmt(w) + '" height="' + fmt(h) + '" preserveAspectRatio="xMidYMid meet" href="' + logoDataUrl + '"/>';
      const svg = qrData.svg.replace(/<\\/svg>\\s*$/, overlay + '</svg>');

      return { png, svg };
    }

    function showError(message) {
      errorEl.textContent = message;
      errorEl.style.display = 'block';
    }

    document.getElementById('genBtn').addEventListener('click', generate);
    document.getElementById('text').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) generate();
    });

    async function generate() {
      const text = document.getElementById('text').value.trim();
      errorEl.style.display = 'none';
      outputEl.classList.remove('visible');
      linkCard.classList.remove('visible');
      copyShortBtn.style.display = 'none';

      if (!text) {
        errorEl.textContent = 'Enter some content first.';
        errorEl.style.display = 'block';
        return;
      }

      let qrContent = text;
      let shortResult = null;
      genBtn.disabled = true;
      genBtn.textContent = 'Working…';

      try {
        if (shortenToggle.checked) {
          const shortRes = await fetch('/shorten', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: text }),
          });

          shortResult = await shortRes.json();
          if (!shortRes.ok) throw new Error(shortResult.error || 'Shortening failed');
          qrContent = shortResult.shortUrl;
        }

        const logoDataUrl = await resolveLogoDataUrl();
        const params = new URLSearchParams({
          text: qrContent,
          size: sizeEl.value,
          ec: logoDataUrl ? 'H' : ecEl.value,
          dark: darkEl.value,
          light: lightEl.value,
        });

        const qrRes = await fetch('/qr?' + params.toString());
        let qrData = await qrRes.json();
        if (!qrRes.ok) throw new Error(qrData.error || 'Generation failed');

        if (logoDataUrl) qrData = await embedLogo(qrData, logoDataUrl);

        const img = document.getElementById('qrImg');
        img.src = qrData.png;
        img.width = img.height = parseInt(sizeEl.value, 10);

        document.getElementById('dlPng').href = qrData.png;
        document.getElementById('dlSvg').href = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(qrData.svg);

        document.getElementById('copyBtn').onclick = async () => {
          const blob = await (await fetch(qrData.png)).blob();
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          document.getElementById('copyBtn').textContent = 'Copied!';
          setTimeout(() => document.getElementById('copyBtn').textContent = 'Copy PNG', 1500);
        };

        if (shortResult) {
          shortUrlLink.href = shortResult.shortUrl;
          shortUrlLink.textContent = shortResult.shortUrl;
          shortUrlMeta.textContent = 'Redirects to ' + shortResult.longUrl;
          linkCard.classList.add('visible');
          copyShortBtn.style.display = 'inline-flex';
          copyShortBtn.onclick = async () => {
            await navigator.clipboard.writeText(shortResult.shortUrl);
            copyShortBtn.textContent = 'Copied!';
            setTimeout(() => copyShortBtn.textContent = 'Copy Short URL', 1500);
          };
        }

        outputEl.classList.add('visible');
      } catch (error) {
        errorEl.textContent = error.message;
        errorEl.style.display = 'block';
      } finally {
        genBtn.disabled = false;
        genBtn.textContent = 'Generate QR Code';
      }
    }
  </script>
</body>
</html>`;
}

app.get('/', (req, res) => {
  res.send(renderApp());
});

app.use('/logos', express.static(LOGOS_DIR, { maxAge: '7d', fallthrough: false }));

// Keep browser favicon probes from hitting the short-link lookup below.
app.get('/favicon.ico', (req, res) => res.status(204).end());

app.get('/api/logos', (req, res) => {
  res.json({ logos: LOGO_PRESETS });
});

app.get(['/healthz', '/api/healthz'], async (req, res) => {
  await shortLinkStoreReady;
  res.json({ ok: true, storage: SHORT_STORAGE });
});

app.post('/shorten', async (req, res) => {
  try {
    await shortLinkStoreReady;
    const longUrl = normalizeHttpUrl((req.body && req.body.url) || '');
    const code = await generateUniqueCode();
    const record = await shortLinkStore.create(code, longUrl);
    res.status(201).json({
      code: record.code,
      longUrl: record.longUrl,
      shortUrl: `${buildBaseUrl(req)}/${record.code}`,
      createdAt: record.createdAt,
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/qr', async (req, res) => {
  const { text, size = 300, ec = 'M', dark = '#000000', light = '#ffffff' } = req.query;
  if (!text) return res.status(400).json({ error: 'text is required' });

  const opts = {
    errorCorrectionLevel: ec,
    width: parseInt(size, 10),
    color: { dark, light },
    margin: 1,
  };

  try {
    const [png, svg] = await Promise.all([
      QRCode.toDataURL(text, opts),
      QRCode.toString(text, { ...opts, type: 'svg' }),
    ]);
    res.json({ png, svg });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/:code', async (req, res) => {
  try {
    await shortLinkStoreReady;
    const record = await shortLinkStore.get(req.params.code);
    if (!record) return res.status(404).send('Short link not found.');

    Promise.resolve(shortLinkStore.incrementHitCount(req.params.code)).catch((error) => {
      console.error('Failed to increment hit count:', error.message);
    });

    return res.redirect(302, record.longUrl);
  } catch (error) {
    return res.status(500).send(error.message);
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`QR Generator running → http://localhost:${PORT} [storage=${SHORT_STORAGE}]`);
});
