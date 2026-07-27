/**
 * generate-manifest.js
 *
 * Reads every .vsix file in a folder, extracts the real publisher/name/
 * version/displayName from the extension's own package.json (inside the
 * vsix zip), and writes out manifest.json in the shape the gallery proxy
 * expects.
 *
 * Usage:
 *   npm install adm-zip
 *   node generate-manifest.js ./vsix-folder ./manifest.json
 */

/**
 * generate-manifest.js
 *
 * Reads every .vsix file in a folder, extracts the real publisher/name/
 * version/displayName from the extension's own package.json (inside the
 * vsix zip), and writes out manifest.json in the shape VS Code's gallery
 * client actually expects.
 *
 * IMPORTANT: VS Code's extensionGalleryService parser reads several fields
 * on each version object unconditionally (e.g. calling .indexOf() on
 * `files` and `properties` arrays to locate the VSIX asset and engine
 * compatibility). If these arrays are missing, VS Code throws:
 *   TypeError: Cannot read properties of undefined (reading 'indexOf')
 * and the whole gallery query fails silently in the UI. This script always
 * includes them, even though our proxy's /api/assets route ignores the
 * exact `source` URL path segment and just re-derives the file from
 * publisher/name/version — the `files` array just needs to LOOK complete
 * enough for VS Code's parser to not choke.
 *
 * Usage:
 *   npm install adm-zip uuid
 *   node generate-manifest.js ./vsix-folder ./manifest.json https://127.0.0.1:8080
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

const [, , inputDir, outputFile, proxyBaseUrl] = process.argv;

if (!inputDir || !outputFile) {
  console.error('Usage: node generate-manifest.js <vsix-folder> <output-manifest.json> [proxyBaseUrl]');
  process.exit(1);
}

const PROXY_BASE = proxyBaseUrl || 'https://127.0.0.1:8080';

const files = fs.readdirSync(inputDir).filter(f => f.endsWith('.vsix'));

if (files.length === 0) {
  console.error(`No .vsix files found in ${inputDir}`);
  process.exit(1);
}

const manifest = [];

for (const file of files) {
  const fullPath = path.join(inputDir, file);
  try {
    const zip = new AdmZip(fullPath);
    const entry = zip.getEntry('extension/package.json');
    if (!entry) {
      console.warn(`Skipping ${file}: no extension/package.json found inside`);
      continue;
    }
    const pkg = JSON.parse(zip.readAsText(entry));

    const publisherName = pkg.publisher;
    const extensionName = pkg.name;
    const version = pkg.version;
    const displayName = pkg.displayName || pkg.name;
    const description = pkg.description || '';
    const engineVersion = (pkg.engines && pkg.engines.vscode) || '*';

    if (!publisherName || !extensionName || !version) {
      console.warn(`Skipping ${file}: missing publisher/name/version in package.json`);
      continue;
    }

    // Sanity check: does the filename match what the proxy will expect?
    const expectedFilename = `${publisherName}.${extensionName}-${version}.vsix`;
    if (file !== expectedFilename) {
      console.warn(
        `WARNING: ${file} does not match expected Nexus filename "${expectedFilename}". ` +
        `Rename it in Nexus to match, or the proxy's asset download will 404.`
      );
    }

    const assetBase = `${PROXY_BASE}/api/assets/${publisherName}/${extensionName}/${version}`;

    manifest.push({
      extensionId: crypto.randomUUID(),
      extensionName,
      displayName,
      shortDescription: description.slice(0, 200),
      publisher: {
        publisherId: crypto.createHash('sha1').update(publisherName).digest('hex'),
        publisherName,
        displayName: publisherName,
        flags: 'verified'
      },
      flags: 'validated',
      statistics: [],
      tags: [],
      categories: pkg.categories || [],
      releaseDate: new Date().toISOString(),
      publishedDate: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      deploymentType: 0,
      versions: [
        {
          version,
          flags: 'validated',
          lastUpdated: new Date().toISOString(),
          // `properties` is where VS Code looks up engine compatibility
          // (Microsoft.VisualStudio.Code.Engine) and other metadata via
          // an indexOf/findIndex scan — must be a real array, not undefined.
          properties: [
            { key: 'Microsoft.VisualStudio.Code.Engine', value: engineVersion },
            { key: 'Microsoft.VisualStudio.Code.ExtensionDependencies', value: '' },
            { key: 'Microsoft.VisualStudio.Code.ExtensionPack', value: '' },
            { key: 'Microsoft.VisualStudio.Code.ExtensionKind', value: 'ui,workspace' }
          ],
          // `files` maps asset types to download URLs. Our proxy serves
          // VSIXPackage by streaming the real .vsix, and Manifest by
          // extracting extension/package.json from inside that .vsix —
          // both are real, correctly-served content. Other optional types
          // (Icons, Content.Details, Content.Changelog) are NOT included
          // since the proxy can't serve them correctly yet and VS Code
          // treats their absence as "not available" rather than erroring.
          files: [
            {
              assetType: 'Microsoft.VisualStudio.Services.VSIXPackage',
              source: `${assetBase}/Microsoft.VisualStudio.Services.VSIXPackage`
            },
            {
              assetType: 'Microsoft.VisualStudio.Code.Manifest',
              source: `${assetBase}/Microsoft.VisualStudio.Code.Manifest`
            }
          ],
          assetUri: assetBase,
          fallbackAssetUri: assetBase
        }
      ]
    });

    console.log(`Added: ${publisherName}.${extensionName} @ ${version}`);
  } catch (err) {
    console.warn(`Skipping ${file}: failed to read (${err.message})`);
  }
}

fs.writeFileSync(outputFile, JSON.stringify(manifest, null, 2));
console.log(`\nWrote ${manifest.length} extension(s) to ${outputFile}`);
