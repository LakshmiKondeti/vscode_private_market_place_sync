/**
 * setup-demo.js
 *
 * One-shot installer for the curated VS Code extension gallery demo.
 * Run this once on a new machine and it does everything:
 *   1. Generates a self-signed cert (if not already present)
 *   2. Imports it into the Windows Trusted Root store (needs admin —
 *      auto-elevates itself if not already running elevated)
 *   3. Finds the active VS Code install and patches product.json
 *      (backs up the original first, disables auto-update)
 *   4. Creates a desktop shortcut that starts the proxy + VS Code together
 *
 * Works both as a plain script (`node setup-demo.js`) and as a packaged
 * .exe built with pkg — in the exe case, __dirname points inside pkg's
 * virtual snapshot filesystem, NOT the real folder the exe sits in, so
 * we use path.dirname(process.execPath) instead whenever process.pkg
 * is set, to correctly find/write real files (cert, shortcut, backups)
 * next to the actual exe on disk.
 *
 * Package as a single exe:
 *   npm install node-forge
 *   npm install -g pkg
 *   pkg setup-demo.js --target node18-win-x64 --output setup-demo.exe
 *
 * Then place setup-demo.exe in the same folder as:
 *   vscode-gallery-proxy.exe (the proxy, built separately from
 *     local-gallery-proxy-final-v4.js)
 *   launch-vscode-with-gallery.bat
 *   manifest.json + *.vsix files
 *   icon.ico (optional)
 *
 * Run setup-demo.exe once (accept the UAC prompt) — it self-elevates,
 * does all setup steps, and leaves a desktop shortcut behind that starts
 * the proxy + VS Code together on every subsequent use.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawnSync } = require('child_process');

// When packaged with pkg, __dirname resolves inside the virtual snapshot,
// not the real folder the .exe lives in — use process.execPath's folder
// instead so we read/write real files on disk correctly.
const HERE = process.pkg ? path.dirname(process.execPath) : __dirname;

const KEY_PATH = path.join(HERE, 'key.pem');
const CERT_PATH = path.join(HERE, 'cert.pem');
const PROXY_EXE = path.join(HERE, 'vscode-gallery-proxy.exe');
const PROXY_SCRIPT = path.join(HERE, 'local-gallery-proxy-final-v4.js');
const LAUNCHER_BAT = path.join(HERE, 'launch-vscode-with-gallery.bat');

function log(msg) { console.log(`[setup] ${msg}`); }
function fail(msg) { console.error(`[setup] ERROR: ${msg}`); process.exit(1); }

// ---------------------------------------------------------------------
// Step 0: Confirm elevation, self-elevate if needed (cert import needs admin)
// ---------------------------------------------------------------------
function isElevated() {
  try {
    execSync('net session', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

if (!isElevated()) {
  log('Not running elevated — relaunching as Administrator (accept the UAC prompt)...');

  // Relaunch THIS SAME PROCESS — works whether running as `node setup-demo.js`
  // (process.execPath = node.exe, need to also pass the script path) or as a
  // packaged exe (process.execPath = setup-demo.exe itself, no script arg needed).
  const isPkg = !!process.pkg;
  const exePath = process.execPath;
  const argList = isPkg ? '' : `-ArgumentList '"${__filename}"'`;

  const psCommand =
    `Start-Process -FilePath "${exePath}" ${argList} -Verb RunAs -Wait`;
  const result = spawnSync('powershell', ['-NoProfile', '-Command', psCommand], { stdio: 'inherit' });
  if (result.status !== 0) {
    fail('Elevation was cancelled or failed. Re-run this script and accept the UAC prompt.');
  }
  log('Elevated run finished. Setup complete.');
  process.exit(0);
}

log('Running elevated. Proceeding with setup...');

// ---------------------------------------------------------------------
// Step 1: Generate self-signed cert if not already present
// ---------------------------------------------------------------------
if (fs.existsSync(KEY_PATH) && fs.existsSync(CERT_PATH)) {
  log('Cert already exists (key.pem/cert.pem found) — skipping generation.');
} else {
  log('Generating self-signed cert (key.pem/cert.pem)...');
  const forge = require('node-forge');

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 2);
  const attrs = [{ name: 'commonName', value: 'localhost' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [
      { type: 2, value: 'localhost' },
      { type: 7, ip: '127.0.0.1' }
    ]}
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  fs.writeFileSync(KEY_PATH, forge.pki.privateKeyToPem(keys.privateKey));
  fs.writeFileSync(CERT_PATH, forge.pki.certificateToPem(cert));
  log('Cert generated.');
}

// ---------------------------------------------------------------------
// Step 2: Import cert into Trusted Root (idempotent — skip if already there)
// ---------------------------------------------------------------------
log('Checking if cert is already trusted...');
const checkResult = spawnSync('powershell', ['-NoProfile', '-Command',
  `$c = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2("${CERT_PATH}"); ` +
  `$found = Get-ChildItem Cert:\\LocalMachine\\Root | Where-Object { $_.Thumbprint -eq $c.Thumbprint }; ` +
  `if ($found) { Write-Output "TRUSTED" } else { Write-Output "NOT_TRUSTED" }`
], { encoding: 'utf8' });

if (checkResult.stdout.includes('TRUSTED') && !checkResult.stdout.includes('NOT_TRUSTED')) {
  log('Cert already trusted — skipping import.');
} else {
  log('Importing cert into Trusted Root store...');
  const importResult = spawnSync('powershell', ['-NoProfile', '-Command',
    `Import-Certificate -FilePath "${CERT_PATH}" -CertStoreLocation Cert:\\LocalMachine\\Root`
  ], { stdio: 'inherit' });
  if (importResult.status !== 0) fail('Failed to import certificate.');
  log('Cert imported and trusted.');
}

// ---------------------------------------------------------------------
// Step 3: Find the active VS Code install and patch product.json
// ---------------------------------------------------------------------
function findVSCodeProductJson() {
  const candidates = [];

  // Per-user install (most common on locked-down machines)
  const userProgs = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Microsoft VS Code');
  if (fs.existsSync(userProgs)) {
    for (const entry of fs.readdirSync(userProgs)) {
      const p = path.join(userProgs, entry, 'resources', 'app', 'product.json');
      if (fs.existsSync(p)) candidates.push(p);
    }
    // Some installs put product.json directly, no hash folder
    const direct = path.join(userProgs, 'resources', 'app', 'product.json');
    if (fs.existsSync(direct)) candidates.push(direct);
  }

  // Machine-wide install
  const machineWide = 'C:\\Program Files\\Microsoft VS Code\\resources\\app\\product.json';
  if (fs.existsSync(machineWide)) candidates.push(machineWide);

  return candidates;
}

const productJsonCandidates = findVSCodeProductJson();

if (productJsonCandidates.length === 0) {
  log('WARNING: Could not find product.json automatically.');
  log('Install/launch VS Code once first, then re-run this script,');
  log('or edit product.json manually — see the setup guide.');
} else {
  // If multiple candidates, prefer the most recently modified (likely the active version)
  const target = productJsonCandidates
    .map(p => ({ p, mtime: fs.statSync(p).mtime }))
    .sort((a, b) => b.mtime - a.mtime)[0].p;

  log(`Found product.json: ${target}`);

  const backupPath = target + '.backup-' + Date.now();
  fs.copyFileSync(target, backupPath);
  log(`Backed up original to: ${backupPath}`);

  let productJson = JSON.parse(fs.readFileSync(target, 'utf8'));

  productJson.extensionsGallery = {
    ...(productJson.extensionsGallery || {}),
    serviceUrl: 'https://127.0.0.1:8080/api',
    itemUrl: 'https://127.0.0.1:8080/api/item',
    resourceUrlTemplate: 'https://127.0.0.1:8080/api/assets/{publisher}/{name}/{version}/{path}'
  };

  fs.writeFileSync(target, JSON.stringify(productJson, null, '\t'));
  log('Patched extensionsGallery in product.json.');

  // Disable auto-update via user settings.json, so VS Code doesn't wipe
  // this patch on its next background update check.
  const settingsPath = path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User', 'settings.json');
  try {
    let settings = {};
    if (fs.existsSync(settingsPath)) {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } else {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    }
    settings['update.mode'] = 'none';
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 4));
    log('Set update.mode: none in user settings.json.');
  } catch (err) {
    log(`WARNING: Could not update settings.json automatically (${err.message}). Set "update.mode": "none" manually.`);
  }
}

// ---------------------------------------------------------------------
// Step 4: Create the desktop shortcut
// ---------------------------------------------------------------------
log('Creating desktop shortcut...');

const desktopPath = path.join(os.homedir(), 'Desktop', 'Company VS Code (Curated).lnk');
const iconPath = fs.existsSync(path.join(HERE, 'icon.ico'))
  ? path.join(HERE, 'icon.ico')
  : path.join(HERE, 'vscode-gallery-proxy.exe'); // falls back to the exe's own icon

const shortcutScript = `
$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut("${desktopPath.replace(/\\/g, '\\\\')}")
$Shortcut.TargetPath = "${LAUNCHER_BAT.replace(/\\/g, '\\\\')}"
$Shortcut.WorkingDirectory = "${HERE.replace(/\\/g, '\\\\')}"
$Shortcut.IconLocation = "${iconPath.replace(/\\/g, '\\\\')}"
$Shortcut.Save()
`;

const shortcutResult = spawnSync('powershell', ['-NoProfile', '-Command', shortcutScript], { stdio: 'inherit' });
if (shortcutResult.status === 0) {
  log(`Desktop shortcut created: ${desktopPath}`);
} else {
  log('WARNING: Could not create desktop shortcut automatically.');
}

// ---------------------------------------------------------------------
// Done — launch immediately so setup + first run happen in one go
// ---------------------------------------------------------------------
log('');
log('=================================================================');
log('Setup complete. Starting the gallery proxy + VS Code now...');
log('=================================================================');

if (fs.existsSync(LAUNCHER_BAT)) {
  spawnSync('cmd.exe', ['/c', 'start', '""', LAUNCHER_BAT], { cwd: HERE, stdio: 'ignore', detached: true });
  log('Launched. VS Code should open shortly.');
  log(`A desktop shortcut ("Company VS Code (Curated)") was also created`);
  log('for starting this again next time, without re-running setup.');
} else {
  log(`WARNING: ${LAUNCHER_BAT} not found — could not auto-launch.`);
  log('Use the desktop shortcut, or run launch-vscode-with-gallery.bat manually.');
}