/**
 * local-gallery-proxy.js
 *
 * Minimal VS Code Marketplace-compatible gallery proxy.
 * Runs on localhost only. Translates VS Code gallery API calls
 * into requests against an internal Nexus repository hosting
 * approved .vsix files + a manifest.json.
 *
 * Requires:
 *   npm install express node-fetch@2
 *
 * Optional packaging:
 *   npm install -g pkg
 *   pkg local-gallery-proxy.js --target node18-win-x64 --output vscode-gallery-proxy.exe
 */

const express = require('express');
const fetch = require('node-fetch');
const net = require('net');

const PORT = Number(process.env.GALLERY_PROXY_PORT || 8080);
const HOST = '127.0.0.1';
const PUBLIC_BASE = process.env.PUBLIC_BASE_URL || `http://${HOST}:${PORT}`;
const NEXUS_BASE = process.env.NEXUS_BASE_URL || 'https://nexus.internal/repository/vscode-extensions';
const NEXUS_TOKEN = process.env.NEXUS_TOKEN || '';
const MANIFEST_CACHE_TTL_MS = 30 * 1000;
const DEFAULT_ENGINE = process.env.DEFAULT_VSCODE_ENGINE || '^1.70.0';

let manifestCache = { data: null, fetchedAt: 0 };

function authHeaders() {
  return NEXUS_TOKEN ? { Authorization: `Bearer ${NEXUS_TOKEN}` } : {};
}

async function getManifest() {
  const now = Date.now();
  if (manifestCache.data && (now - manifestCache.fetchedAt) < MANIFEST_CACHE_TTL_MS) {
    return manifestCache.data;
  }

  const res = await fetch(`${NEXUS_BASE}/manifest.json`, { headers: authHeaders() });
  if (!res.ok) {
    throw new Error(`Failed to fetch manifest from Nexus: ${res.status}`);
  }

  const data = await res.json();
  if (!Array.isArray(data)) {
    throw new Error('Manifest must be a JSON array');
  }

  manifestCache = { data, fetchedAt: now };
  return data;
}

function alreadyRunning(cb) {
  const tester = net.createServer()
    .once('error', () => cb(true))
    .once('listening', () => tester.close(() => cb(false)))
    .listen(PORT, HOST);
}

function extractSearchText(body) {
  try {
    const filters = body?.filters || [];
    for (const filter of filters) {
      const criteria = filter?.criteria || [];
      const textCriterion = criteria.find(c => c.filterType === 10);
      if (textCriterion?.value) {
        return String(textCriterion.value).toLowerCase().trim();
      }
    }
    return '';
  } catch {
    return '';
  }
}

function extractExtensionId(body) {
  try {
    const filters = body?.filters || [];
    for (const filter of filters) {
      const criteria = filter?.criteria || [];
      const idCriterion = criteria.find(c => c.filterType === 7);
      if (idCriterion?.value) {
        return String(idCriterion.value).trim();
      }
    }
    return '';
  } catch {
    return '';
  }
}

function matchesSearch(ext, searchText) {
  if (!searchText) return true;
  const haystack = [
    ext?.publisher?.publisherName,
    ext?.publisher?.displayName,
    ext?.extensionName,
    ext?.displayName,
    ext?.shortDescription,
    ...(Array.isArray(ext?.tags) ? ext.tags : []),
    ...(Array.isArray(ext?.categories) ? ext.categories : [])
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return haystack.includes(searchText);
}

function safePublisherDisplayName(ext) {
  return ext?.publisher?.displayName || ext?.publisher?.publisherName || 'Unknown Publisher';
}

function safeDisplayName(ext) {
  if (ext?.displayName && !/^%.*%$/.test(ext.displayName)) return ext.displayName;
  return ext?.extensionName || 'Unknown Extension';
}

function safeDescription(ext) {
  if (ext?.shortDescription && !/^%.*%$/.test(ext.shortDescription)) return ext.shortDescription;
  return '';
}

function extensionId(ext) {
  return `${ext?.publisher?.publisherName || ''}.${ext?.extensionName || ''}`;
}

function normalizeVersion(ext, versionObj) {
  const version = versionObj?.version;
  const publisher = ext?.publisher?.publisherName;
  const name = ext?.extensionName;
  const engine =
    Array.isArray(versionObj?.properties)
      ? (versionObj.properties.find(p => p.key === 'Microsoft.VisualStudio.Code.Engine')?.value || DEFAULT_ENGINE)
      : DEFAULT_ENGINE;

  return {
    version,
    lastUpdated: versionObj?.lastUpdated || ext?.lastUpdated || ext?.publishedDate || new Date().toISOString(),
    files: [
      {
        assetType: 'Microsoft.VisualStudio.Services.VSIXPackage',
        source: `${PUBLIC_BASE}/api/assets/${encodeURIComponent(publisher)}/${encodeURIComponent(name)}/${encodeURIComponent(version)}/Microsoft.VisualStudio.Services.VSIXPackage`
      }
    ],
    properties: [
      {
        key: 'Microsoft.VisualStudio.Code.Engine',
        value: engine
      },
      {
        key: 'Microsoft.VisualStudio.Code.PreRelease',
        value: 'false'
      }
    ]
  };
}

function toGalleryExtension(ext) {
  const versions = Array.isArray(ext?.versions) ? ext.versions.filter(v => v?.version) : [];
  const normalizedVersions = versions.map(v => normalizeVersion(ext, v));

  return {
    publisher: {
      publisherId: ext?.publisher?.publisherId || ext?.publisher?.publisherName || '',
      publisherName: ext?.publisher?.publisherName || '',
      displayName: safePublisherDisplayName(ext),
      flags: ext?.publisher?.flags || 'verified'
    },
    extensionId: ext?.extensionId || extensionId(ext),
    extensionName: ext?.extensionName || '',
    displayName: safeDisplayName(ext),
    shortDescription: safeDescription(ext),
    categories: Array.isArray(ext?.categories) ? ext.categories : [],
    tags: Array.isArray(ext?.tags) ? ext.tags : [],
    statistics: Array.isArray(ext?.statistics) ? ext.statistics : [
      { statisticName: 'install', value: 1 },
      { statisticName: 'averagerating', value: 0 },
      { statisticName: 'ratingcount', value: 0 }
    ],
    publishedDate: ext?.publishedDate || ext?.lastUpdated || new Date().toISOString(),
    releaseDate: ext?.lastUpdated || ext?.publishedDate || new Date().toISOString(),
    lastUpdated: ext?.lastUpdated || ext?.publishedDate || new Date().toISOString(),
    versions: normalizedVersions
  };
}

function buildQueryResponse(extensions) {
  return {
    results: [
      {
        extensions,
        pagingToken: null,
        resultMetadata: [
          {
            metadataType: 'ResultCount',
            metadataItems: [
              {
                name: 'TotalCount',
                count: extensions.length
              }
            ]
          }
        ]
      }
    ]
  };
}

function resolveVsixUrl(publisher, name, version) {
  return `${NEXUS_BASE}/${publisher}.${name}-${version}.vsix`;
}

function startServer() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  app.post('/api/extensionquery', async (req, res) => {
    try {
      const manifest = await getManifest();

      const searchText = extractSearchText(req.body);
      const extId = extractExtensionId(req.body);

      let filtered = manifest;

      if (extId) {
        filtered = filtered.filter(ext => extensionId(ext).toLowerCase() === extId.toLowerCase());
      } else if (searchText) {
        filtered = filtered.filter(ext => matchesSearch(ext, searchText));
      }

      const galleryExtensions = filtered.map(toGalleryExtension);
      res.json(buildQueryResponse(galleryExtensions));
    } catch (err) {
      console.error('extensionquery failed:', err);
      res.status(502).json({ error: 'Gallery backend unavailable' });
    }
  });

  app.get('/api/item', async (req, res) => {
    try {
      const manifest = await getManifest();
      const itemName = String(req.query.itemName || '').trim();

      if (!itemName) {
        return res.status(400).json({ error: 'itemName is required' });
      }

      const found = manifest.find(ext => extensionId(ext).toLowerCase() === itemName.toLowerCase());
      if (!found) {
        return res.status(404).json({ error: 'Extension not found' });
      }

      res.json(toGalleryExtension(found));
    } catch (err) {
      console.error('item GET failed:', err);
      res.status(502).json({ error: 'Gallery backend unavailable' });
    }
  });

  app.post('/api/item', async (req, res) => {
    try {
      const manifest = await getManifest();
      const itemName = String(req.body?.itemName || '').trim();

      if (!itemName) {
        return res.status(400).json({ error: 'itemName is required' });
      }

      const found = manifest.find(ext => extensionId(ext).toLowerCase() === itemName.toLowerCase());
      if (!found) {
        return res.status(404).json({ error: 'Extension not found' });
      }

      res.json(toGalleryExtension(found));
    } catch (err) {
      console.error('item POST failed:', err);
      res.status(502).json({ error: 'Gallery backend unavailable' });
    }
  });

  app.get('/api/assets/:publisher/:name/:version/:assetType', async (req, res) => {
    const { publisher, name, version, assetType } = req.params;

    if (assetType !== 'Microsoft.VisualStudio.Services.VSIXPackage') {
      return res.status(404).json({ error: `Unsupported asset type: ${assetType}` });
    }

    const nexusUrl = resolveVsixUrl(publisher, name, version);

    try {
      const nexusRes = await fetch(nexusUrl, { headers: authHeaders() });

      if (!nexusRes.ok) {
        return res.status(404).json({ error: `VSIX not found: ${publisher}.${name}@${version}` });
      }

      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${publisher}.${name}-${version}.vsix"`);

      if (nexusRes.headers.get('content-length')) {
        res.setHeader('Content-Length', nexusRes.headers.get('content-length'));
      }

      nexusRes.body.pipe(res);
    } catch (err) {
      console.error('asset stream failed:', err);
      res.status(502).json({ error: 'Failed to stream asset from Nexus' });
    }
  });

  app.use((req, res) => {
    res.status(404).json({ error: `Cannot ${req.method} ${req.path}` });
  });

  const server = app.listen(PORT, HOST, () => {
    console.log(`Gallery proxy listening on ${PUBLIC_BASE}`);
    console.log(`Backed by Nexus: ${NEXUS_BASE}`);
  });

  server.on('error', (err) => {
    console.error('Server error:', err);
  });

  process.on('SIGINT', () => server.close(() => process.exit(0)));
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}

alreadyRunning((running) => {
  if (running) {
    console.log('Gallery proxy already running on this port — exiting quietly.');
    process.exit(0);
  }
  startServer();
});