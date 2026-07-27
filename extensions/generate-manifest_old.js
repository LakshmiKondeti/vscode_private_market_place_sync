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

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const [, , inputDir, outputFile] = process.argv;

if (!inputDir || !outputFile) {
  console.error('Usage: node generate-manifest.js <vsix-folder> <output-manifest.json>');
  process.exit(1);
}

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

    manifest.push({
      publisher: { publisherName },
      extensionName,
      displayName,
      shortDescription: description.slice(0, 200),
      versions: [
        { version, lastUpdated: new Date().toISOString() }
      ]
    });

    console.log(`Added: ${publisherName}.${extensionName} @ ${version}`);
  } catch (err) {
    console.warn(`Skipping ${file}: failed to read (${err.message})`);
  }
}

fs.writeFileSync(outputFile, JSON.stringify(manifest, null, 2));
console.log(`\nWrote ${manifest.length} extension(s) to ${outputFile}`);
