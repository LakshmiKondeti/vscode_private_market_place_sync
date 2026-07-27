/**
 * local-gallery-proxy.js
 *
 * Minimal VS Code Marketplace-compatible gallery proxy.
 * Runs on localhost only. Translates VS Code's gallery API calls
 * into requests against an internal Nexus repository hosting
 * approved .vsix files + a manifest.json.
 *
 * Package with pkg:
 *   npm install express node-fetch@2
 *   npm install -g pkg
 *   pkg local-gallery-proxy.js --target node18-win-x64 --output vscode-gallery-proxy.exe
 *
 * NOTE: use node-fetch@2 (CommonJS) — v3 is ESM-only and breaks pkg bundling.
 */
console.log('STEP 1: script loaded');
const express = require('express');
const fetch = require('node-fetch');
const net = require('net');

// ---- Configuration ----------------------------------------------------
// These can also be overridden via environment variables at packaging time
// (e.g. baked into the Numecent layer / choco install / devfile image).
const PORT = process.env.GALLERY_PROXY_PORT || 8080;
const HOST = '127.0.0.1'; // localhost only — never binds externally
const NEXUS_BASE = process.env.NEXUS_BASE_URL || 'https://nexus.internal/repository/vscode-extensions';
const NEXUS_TOKEN = process.env.NEXUS_TOKEN || ''; // service token, not user credentials
const MANIFEST_CACHE_TTL_MS = 30 * 1000; // small cache to avoid hammering Nexus on every keystroke search

// ---- Simple in-memory manifest cache -----------------------------------
let manifestCache = { data: null, fetchedAt: 0 };

async function getManifest() {
  const now = Date.now();
  if (manifestCache.data && (now - manifestCache.fetchedAt) < MANIFEST_CACHE_TTL_MS) {
    return manifestCache.data;
  }
  const res = await fetch(`${NEXUS_BASE}/manifest.json`, {
    headers: NEXUS_TOKEN ? { Authorization: `Bearer ${NEXUS_TOKEN}` } : {}
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch manifest from Nexus: ${res.status}`);
  }
  const data = await res.json();
  manifestCache = { data, fetchedAt: now };
  return data;
}

// ---- Port check: if something's already listening, exit quietly --------
// Prevents errors if the user double-launches VS Code (and the wrapper
// tries to start the proxy twice).
function alreadyRunning(cb) {
  const tester = net.createServer()
    .once('error', () => cb(true))
    .once('listening', () => {
      tester.close(() => cb(false));
    })
    .listen(PORT, HOST);
}

// ---- App -----------------------------------------------------------------
function startServer() {
  const app = express();
  app.use(express.json());

  // Health check — handy for the wrapper script / troubleshooting
  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  // VS Code calls this (POST) to search/list extensions in the Extensions panel
  app.post('/api/extensionquery', async (req, res) => {
    try {
      const manifest = await getManifest();

      // Optional: basic filtering based on search text VS Code sends,
      // so the Extensions panel search box behaves sensibly.
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

  // VS Code calls this to fetch extension metadata by publisher.name
  app.get('/api/item', async (req, res) => {
    try {
      const manifest = await getManifest();
      const itemName = req.query.itemName; // e.g. "ms-python.python"
      const found = manifest.find(ext => `${ext.publisher.publisherName}.${ext.extensionName}` === itemName);
      if (!found) return res.status(404).end();
      res.json(found);
    } catch (err) {
      res.status(502).json({ error: 'Gallery backend unavailable' });
    }
  });

  // VS Code calls this to download the actual .vsix (and other assets
  // like icons/changelog) — stream straight from Nexus, no local disk write.
  app.get('/api/assets/:publisher/:name/:version/:file', async (req, res) => {
    const { publisher, name, version, file } = req.params;
    const nexusUrl = `${NEXUS_BASE}/${publisher}.${name}-${version}.vsix`;

    try {
      const nexusRes = await fetch(nexusUrl, {
        headers: NEXUS_TOKEN ? { Authorization: `Bearer ${NEXUS_TOKEN}` } : {}
      });
      if (!nexusRes.ok) {
        return res.status(404).json({ error: `Asset not found in Nexus: ${publisher}.${name}-${version}` });
      }
      res.setHeader('Content-Type', 'application/octet-stream');
      nexusRes.body.pipe(res);
    } catch (err) {
      console.error('Asset stream failed:', err.message);
      res.status(502).json({ error: 'Failed to stream asset from Nexus' });
    }
  });

  const server = app.listen(PORT, HOST, () => {
    console.log(`Gallery proxy listening on http://${HOST}:${PORT}`);
    console.log(`Backed by Nexus: ${NEXUS_BASE}`);
  });

  // Graceful shutdown on Ctrl+C / taskkill
  process.on('SIGINT', () => server.close(() => process.exit(0)));
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}

// ---- Helpers ---------------------------------------------------------
function extractSearchText(body) {
  try {
    const filters = body?.filters?.[0]?.criteria || [];
    const textCriterion = filters.find(c => c.filterType === 10); // 10 = SearchText in gallery API
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
