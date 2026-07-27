/**
 * local-gallery-proxy.js
 *
 * Minimal VS Code Marketplace-compatible gallery proxy.
 * Runs on localhost only (HTTPS, self-signed cert). Translates VS Code's
 * gallery API calls into requests against an internal Nexus repository
 * hosting approved .vsix files + a manifest.json.
 *
 * Package with pkg:
 *   npm install express node-fetch@2 adm-zip
 *   npm install -g pkg
 *   pkg local-gallery-proxy.js --target node18-win-x64 --output vscode-gallery-proxy.exe
 *
 * NOTE: use node-fetch@2 (CommonJS) — v3 is ESM-only and breaks pkg bundling.
 *
 * Requires key.pem + cert.pem to sit alongside the exe/script (or point
 * GALLERY_PROXY_CERT_DIR at wherever they are). VS Code's CSP blocks plain
 * http:// entirely, so this MUST serve HTTPS, even for localhost.
 */

const express = require('express');
const fetch = require('node-fetch');
const net = require('net');
const https = require('https');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { HttpsProxyAgent } = require('https-proxy-agent');

// ---- Configuration ----------------------------------------------------
const PORT = process.env.GALLERY_PROXY_PORT || 8080;
const HOST = '127.0.0.1'; // localhost only — never binds externally
const NEXUS_BASE = process.env.NEXUS_BASE_URL || 'https://nexus.internal/repository/vscode-extensions';
const NEXUS_TOKEN = process.env.NEXUS_TOKEN || ''; // service token, not user credentials
const NEXUS_AUTH_HEADER = process.env.NEXUS_AUTH_HEADER || 'Authorization'; // some backends (e.g. GitLab) want 'PRIVATE-TOKEN' instead
const MANIFEST_CACHE_TTL_MS = 30 * 1000;

// Corporate web proxy support: if the org network requires all outbound
// traffic (even to internal GitLab) to go through a proxy with its own
// Basic/LDAP auth, set CORPORATE_PROXY_URL with credentials embedded, e.g.
//   https://DOMAIN%5Cusername:password@proxy.corp.local:8080
// (note: backslash in a domain\username must be URL-encoded as %5C)
const CORPORATE_PROXY_URL = process.env.CORPORATE_PROXY_URL || process.env.HTTPS_PROXY || '';
const proxyAgent = CORPORATE_PROXY_URL ? new HttpsProxyAgent(CORPORATE_PROXY_URL) : undefined;

function nexusAuthHeaders() {
  if (!NEXUS_TOKEN) return {};
  if (NEXUS_AUTH_HEADER.toLowerCase() === 'authorization') {
    return { Authorization: `Bearer ${NEXUS_TOKEN}` };
  }
  return { [NEXUS_AUTH_HEADER]: NEXUS_TOKEN };
}

function fetchOpts(extraHeaders = {}) {
  return {
    headers: { ...nexusAuthHeaders(), ...extraHeaders },
    ...(proxyAgent ? { agent: proxyAgent } : {})
  };
}

// pkg-compiled exes run from a virtual filesystem; use the real exe's
// directory (process.execPath) rather than __dirname so cert files placed
// next to the .exe on disk are found correctly.
const BASE_DIR = process.pkg ? path.dirname(process.execPath) : __dirname;
const CERT_DIR = process.env.GALLERY_PROXY_CERT_DIR || BASE_DIR;
const KEY_PATH = process.env.GALLERY_PROXY_KEY || path.join(CERT_DIR, 'key.pem');
const CERT_PATH = process.env.GALLERY_PROXY_CERT || path.join(CERT_DIR, 'cert.pem');

// ---- Simple in-memory manifest cache -----------------------------------
let manifestCache = { data: null, fetchedAt: 0 };

// If NEXUS_BASE points at a local folder instead of a URL, read files
// straight off disk — no network, no corporate proxy, no auth needed.
// Useful when the corporate proxy uses NTLM/Kerberos (browser-only,
// transparent) that Node can't easily replicate, but you can still just
// download the files via the browser and serve them locally instead.
const IS_LOCAL_BACKEND = !/^https?:\/\//i.test(NEXUS_BASE);

async function getManifest() {
  const now = Date.now();
  if (manifestCache.data && (now - manifestCache.fetchedAt) < MANIFEST_CACHE_TTL_MS) {
    return manifestCache.data;
  }

  let data;
  if (IS_LOCAL_BACKEND) {
    const manifestPath = path.join(NEXUS_BASE, 'manifest.json');
    data = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } else {
    const res = await fetch(`${NEXUS_BASE}/manifest.json`, fetchOpts());
    if (!res.ok) {
      throw new Error(`Failed to fetch manifest from Nexus: ${res.status}`);
    }
    data = await res.json();
  }

  manifestCache = { data, fetchedAt: now };
  return data;
}

// ---- Port check: if something's already listening, exit quietly --------
function alreadyRunning(cb) {
  const tester = net.createServer()
    .once('error', () => cb(true))
    .once('listening', () => tester.close(() => cb(false)))
    .listen(PORT, HOST);
}

// ---- App -----------------------------------------------------------------
function startServer() {
  const app = express();
  app.use(express.json());

  // CORS: VS Code's renderer runs under vscode-file://, treated as a real
  // cross-origin request by Electron's fetch(). Reflect back whatever
  // headers the preflight asks for, since VS Code sends several custom
  // "x-market-*" headers that vary by version.
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    const requestedHeaders = req.header('Access-Control-Request-Headers');
    res.header('Access-Control-Allow-Headers', requestedHeaders || 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  app.post('/api/extensionquery', async (req, res) => {
    try {
      const manifest = await getManifest();
      const searchText = extractSearchText(req.body);
      const filtered = searchText
        ? manifest.filter(ext => matchesSearch(ext, searchText))
        : manifest;

      res.json({
        results: [
          {
            extensions: filtered,
            resultMetadata: [
              { metadataType: 'ResultCount', metadataItems: [{ name: 'TotalCount', count: filtered.length }] }
            ]
          }
        ]
      });
    } catch (err) {
      console.error('extensionquery failed:', err.message);
      res.status(502).json({ error: 'Gallery backend unavailable' });
    }
  });

  app.get('/api/item', async (req, res) => {
    try {
      const manifest = await getManifest();
      const itemName = req.query.itemName;
      const found = manifest.find(ext => `${ext.publisher.publisherName}.${ext.extensionName}` === itemName);
      if (!found) return res.status(404).end();
      res.json(found);
    } catch (err) {
      res.status(502).json({ error: 'Gallery backend unavailable' });
    }
  });

  app.get('/api/vscode/:publisher/:name/latest', async (req, res) => {
    try {
      const manifest = await getManifest();
      const { publisher, name } = req.params;
      const found = manifest.find(
        ext => ext.publisher.publisherName.toLowerCase() === publisher.toLowerCase() &&
               ext.extensionName.toLowerCase() === name.toLowerCase()
      );
      if (!found) return res.status(404).end();
      res.json(found);
    } catch (err) {
      res.status(502).json({ error: 'Gallery backend unavailable' });
    }
  });

  app.get('/api/gallery/:publisher/:name/:version', async (req, res) => {
    try {
      const manifest = await getManifest();
      const { publisher, name } = req.params;
      const found = manifest.find(
        ext => ext.publisher.publisherName.toLowerCase() === publisher.toLowerCase() &&
               ext.extensionName.toLowerCase() === name.toLowerCase()
      );
      if (!found) return res.status(404).end();
      res.json(found);
    } catch (err) {
      res.status(502).json({ error: 'Gallery backend unavailable' });
    }
  });

  // VSIXPackage -> stream the real binary. Manifest -> extract real
  // package.json from inside the vsix (VS Code needs this to validate
  // before installing; serving the raw binary here breaks install).
  app.get('/api/assets/:publisher/:name/:version/:file', async (req, res) => {
    const { publisher, name, version, file } = req.params;
    const vsixFilename = `${publisher}.${name}-${version}.vsix`;

    try {
      let buffer;

      if (IS_LOCAL_BACKEND) {
        const localPath = path.join(NEXUS_BASE, vsixFilename);
        if (!fs.existsSync(localPath)) {
          console.warn(`[404] Asset not found locally: ${localPath} (asset type: ${file})`);
          return res.status(404).json({ error: `Asset not found: ${vsixFilename}` });
        }
        buffer = fs.readFileSync(localPath);
      } else {
        const nexusUrl = `${NEXUS_BASE}/${vsixFilename}`;
        const nexusRes = await fetch(nexusUrl, fetchOpts());
        if (!nexusRes.ok) {
          console.warn(`[404] Asset not found in Nexus: ${nexusUrl} (asset type: ${file})`);
          return res.status(404).json({ error: `Asset not found in Nexus: ${publisher}.${name}-${version}` });
        }
        buffer = await nexusRes.buffer();
      }

      if (file === 'Microsoft.VisualStudio.Code.Manifest') {
        const zip = new AdmZip(buffer);
        const entry = zip.getEntry('extension/package.json');
        if (!entry) {
          console.warn(`[404] extension/package.json not found inside vsix for ${publisher}.${name}-${version}`);
          return res.status(404).json({ error: 'extension/package.json not found inside vsix' });
        }
        res.setHeader('Content-Type', 'application/json');
        return res.send(zip.readAsText(entry));
      }

      res.setHeader('Content-Type', 'application/octet-stream');
      res.send(buffer);
    } catch (err) {
      console.error('Asset fetch failed:', err.message);
      res.status(502).json({ error: 'Failed to fetch asset' });
    }
  });

  let httpsOptions;
  try {
    httpsOptions = {
      key: fs.readFileSync(KEY_PATH),
      cert: fs.readFileSync(CERT_PATH)
    };
  } catch (err) {
    console.error(`[FATAL] Could not read TLS cert/key: ${err.message}`);
    console.error(`Expected key.pem and cert.pem in: ${CERT_DIR}`);
    console.error('Generate with mkcert (recommended) or openssl — see setup guide.');
    console.error('Press Enter to exit...');
    process.stdin.resume();
    process.stdin.on('data', () => process.exit(1));
    return;
  }

  const server = https.createServer(httpsOptions, app).listen(PORT, HOST, () => {
    console.log(`Gallery proxy listening on https://${HOST}:${PORT}`);
    if (IS_LOCAL_BACKEND) {
      console.log(`Backend mode: LOCAL FOLDER`);
      console.log(`Backend path: ${NEXUS_BASE}`);
      console.log(`Manifest expected at: ${path.join(NEXUS_BASE, 'manifest.json')}`);
      console.log(`Folder exists: ${fs.existsSync(NEXUS_BASE)}`);
      console.log(`manifest.json exists: ${fs.existsSync(path.join(NEXUS_BASE, 'manifest.json'))}`);
    } else {
      console.log(`Backend mode: REMOTE URL`);
      console.log(`Backend URL: ${NEXUS_BASE}`);
    }
    console.log('Keep this window open while using VS Code. Closing it disables the extension gallery.');
  });
  server.on('error', (err) => {
    console.error('Server error:', err.message);
  });

  process.on('SIGINT', () => server.close(() => process.exit(0)));
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}

// ---- Helpers ---------------------------------------------------------
function extractSearchText(body) {
  try {
    const filters = body?.filters?.[0]?.criteria || [];
    const textCriterion = filters.find(c => c.filterType === 10);
    return textCriterion?.value?.toLowerCase().trim() || '';
  } catch {
    return '';
  }
}

function matchesSearch(ext, searchText) {
  const haystack = `${ext.publisher.publisherName} ${ext.extensionName} ${ext.displayName || ''}`.toLowerCase();
  return haystack.includes(searchText);
}

// ---- Entry point -------------------------------------------------------
alreadyRunning((running) => {
  if (running) {
    console.log('Gallery proxy already running on this port — exiting quietly.');
    process.exit(0);
  }
  startServer();
});
