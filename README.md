# vscode_private_market_place_sync
To sync the vscode private market place.
# VS Code Curated Extension Gallery — README

A local HTTPS proxy that makes VS Code show only an org-approved list of
extensions (sourced from Nexus / GitLab / a local folder), packaged as a
standalone `.exe` so end users never need Node.js, admin rights, or a
terminal to use it.

---

## 1. What gets built

| File | Purpose | Built from |
|---|---|---|
| `vscode-gallery-proxy.exe` | The gallery proxy itself — runs on `https://127.0.0.1:8080`, translates VS Code's gallery API calls into Nexus/GitLab/local-folder file lookups | `local-gallery-proxy-final-vX.js` |
| `setup-demo.exe` | One-time, admin-only setup: generates/imports the TLS cert, finds and patches `product.json`, disables VS Code auto-update | `setup-demo.js` |
| `launch-vscode-with-gallery.bat` | Everyday, non-admin launcher: starts the proxy, waits for it to be healthy, opens VS Code | (plain batch script, not packaged) |

---

## 2. Creating the packages with `pkg`

### 2.1 Prerequisites on the build machine
- Node.js 18+
- npm

### 2.2 Install dependencies (all together, in one command)

```bash
npm install express node-fetch@2 adm-zip node-forge https-proxy-agent
npm install -g pkg
```

> **Do not** install one package at a time into an existing `node_modules`
> without a `package.json` present — `npm install <single-package>` will
> **prune** every other dependency not listed in `package.json`, silently
> breaking the build. Always install all dependencies together, or run
> plain `npm install` first to restore from `package.json`.

### 2.3 `package.json` — required for reliable bundling

`pkg` reads a `pkg` config block from `package.json` to know what to
force-include. Some dependencies (notably `https-proxy-agent`) don't get
picked up correctly by `pkg`'s static analysis alone.

```json
{
  "name": "vscode-gallery-proxy",
  "version": "1.0.0",
  "main": "local-gallery-proxy-final-v6.js",
  "dependencies": {
    "express": "^4.18.0",
    "node-fetch": "^2.7.0",
    "adm-zip": "^0.5.0",
    "https-proxy-agent": "^5.0.1"
  },
  "pkg": {
    "scripts": ["local-gallery-proxy-final-v6.js"],
    "assets": [
      "node_modules/https-proxy-agent/**/*",
      "node_modules/agent-base/**/*",
      "node_modules/debug/**/*"
    ]
  }
}
```

> **Pin `https-proxy-agent` to `5.0.1`, not the latest major version.**
> Version 7+ dropped the classic `"main"` field in `package.json` in favor
> of an `"exports"` map, which older `pkg` releases (5.x) cannot resolve —
> this causes `Entry 'main' not found` warnings and a runtime
> `MODULE_NOT_FOUND` crash even though the files are physically bundled.

### 2.4 Build

```bash
pkg .\local-gallery-proxy-final-v6.js --target node18-win-x64 --output vscode-gallery-proxy.exe
pkg setup-demo.js --target node18-win-x64 --output setup-demo.exe
```

Using `pkg .` (reading the whole `package.json`) instead of pointing
directly at the `.js` file is what makes the `assets` list actually take
effect — passing the script path directly on the command line causes
`pkg` to ignore the `pkg` block in `package.json`.

### 2.5 Verify before shipping

Always test the built `.exe` by running it from an **already-open
terminal**, not by double-clicking it in File Explorer — a crash on
double-click closes the console instantly (a "flash" and nothing else),
so you never see the actual error.

```powershell
.\vscode-gallery-proxy.exe
```
Should print `Gallery proxy listening on https://127.0.0.1:8080` and
stay running.

---

## 3. Using it on another machine

### 3.1 Folder layout to copy over

```
OrgVSCodeGallery\
  setup-demo.exe
  vscode-gallery-proxy.exe
  launch-vscode-with-gallery.bat
  manifest.json
  *.vsix files                      (if using local-folder backend)
  key.pem / cert.pem                (created by setup-demo.exe, or your org-CA pair)
```

Copy this entire folder to the target machine — no installers, no Node.js
needed there at all, since everything is already compiled into the
`.exe`s.

### 3.2 Unblock the files first (if copied from another machine/downloaded)

Files that arrive via download, email, or a network copy sometimes get an
invisible "Mark of the Web" flag that triggers extra Windows security
prompts:
```powershell
Get-ChildItem -Recurse | Unblock-File
```

---

## 4. Steps to take on the package for it to work reliably

1. **Certs must sit next to the exe.** The proxy looks for `key.pem` /
   `cert.pem` in its own folder (via `process.execPath`, which correctly
   resolves to the real exe location even when compiled).
2. **HTTPS is mandatory, not optional.** VS Code's Content-Security-Policy
   blocks plain `http://` outright — there is no setting to disable this.
3. **`product.json`'s `serviceUrl` must be the API root, not the full
   endpoint.** VS Code appends `/extensionquery`,
   `/vscode/{publisher}/{name}/latest`, and
   `/gallery/{publisher}/{name}/{version}` onto whatever `serviceUrl` is
   set to — set it to `.../api`, not `.../api/extensionquery`.
4. **Disable VS Code auto-update** (`update.mode: none`), or the next
   background update silently reinstalls into a new hash-named folder
   with an unpatched `product.json`, wiping the fix.
5. **Manifest entries need real structure**, not a minimal hand-written
   JSON — each version needs `files[]` (asset download URLs) and
   `properties[]` (engine compatibility, etc.) or VS Code's parser throws
   `Cannot read properties of undefined (reading 'indexOf')`. Always
   generate the manifest from real `.vsix` files with
   `generate-manifest.js` rather than typing it by hand.
6. **Only advertise asset types the proxy can actually serve** —
   `VSIXPackage` (streamed raw) and `Manifest` (extracted from inside the
   zip). Advertising types like `Icons.Default` or `Content.Details` that
   just get the raw `.vsix` bytes back causes VS Code to try to
   `JSON.parse` binary data and crash.
7. **Filenames must exactly match** `{publisher}.{name}-{version}.vsix`
   between the manifest and the actual uploaded/local file — version
   typos are the single most common cause of 404s.
8. **Check for platform-specific builds.** Some extensions (e.g. Jupyter)
   publish separate `.vsix` per OS/architecture under the same version
   number. Always fetch with `?targetPlatform=win32-x64` explicitly for
   Windows targets, or you may silently get an ARM64/Linux build.

---

## 5. Admin steps vs. normal user steps

### Admin (one-time per machine)
Run **`setup-demo.exe`**. It self-elevates via a UAC prompt and:
1. Generates `key.pem` / `cert.pem` if they don't already exist (skips if
   you've placed your own org-CA-signed pair in the folder beforehand)
2. Imports the cert into `Cert:\LocalMachine\Root`
3. Finds every VS Code / VSCodium install on the machine (standard,
   per-user, Chocolatey, and hash-folder layouts) and patches
   `extensionsGallery` in each `product.json` found, keeping a `.bak`
   backup of the original
4. Sets `update.mode: none` in the user's VS Code settings

This does **not** start the proxy or open VS Code.

### Normal user (every time)
Double-click the desktop shortcut pointing at
**`launch-vscode-with-gallery.bat`**. No admin rights needed. It:
1. Starts `vscode-gallery-proxy.exe` minimized
2. Polls `/health` until the proxy responds (up to 15 seconds), instead
   of a blind timer
3. Opens VS Code

If the shortcut itself prompts for admin unexpectedly, check (in order):
- Shortcut **Properties → Advanced → "Run as administrator"** — uncheck it
- The `.bat` file's own **Properties → Compatibility → "Run this program
  as an administrator"** — uncheck it
- Whether the folder is under a protected path like `C:\Program Files\`
  — move it to a normal user-writable location instead

---

## 6. Full troubleshooting log — everything hit and fixed

| # | Symptom | Root cause | Fix |
|---|---|---|---|
| 1 | Nexus URL 404 | Files uploaded under an unexpected subfolder | Leave the upload "Directory" field blank, or match `NEXUS_BASE_URL` to the actual path |
| 2 | `curl` errors in PowerShell | PowerShell aliases `curl` to `Invoke-WebRequest`, different flag syntax | Use `curl.exe` explicitly, or native `Invoke-WebRequest` |
| 3 | Extensions panel empty, no error | Wrong/stale `product.json`, or auto-update silently reverted the patch | Confirm active install via `Help → About` commit hash; set `update.mode: none` |
| 4 | "Failed to fetch", nothing logged on proxy | VS Code's CSP blocks `http://` outright | Serve the proxy over HTTPS — no way around this |
| 5 | `ERR_CERT_AUTHORITY_INVALID` | Self-signed cert not trusted by Windows | Import into `Cert:\LocalMachine\Root`, or use an org-CA-signed cert (trusted automatically on domain-joined machines) |
| 6 | CORS error: header `x-market-user-id` not allowed | Fixed CORS header allowlist too narrow | Reflect back whatever `Access-Control-Request-Headers` the browser actually asks for, instead of a static list |
| 7 | Doubled URL paths (`/extensionquery/extensionquery`) | `serviceUrl` set to the full endpoint instead of the API root | `serviceUrl` = root only (e.g. `.../api`); VS Code appends the rest |
| 8 | `TypeError: Cannot read properties of undefined (reading 'indexOf')` | Manifest entries missing `files[]` / `properties[]` arrays | Always generate the manifest from real `.vsix` files via `generate-manifest.js` |
| 9 | `SyntaxError: Unexpected token 'P', "PK..."` | Advertised an asset type (icon, changelog, etc.) the proxy can't actually serve — client tried to JSON-parse raw zip bytes | Only advertise `VSIXPackage` and `Manifest` asset types |
| 10 | `Manifest is not found` on install | `Manifest` asset type missing from `files[]`, or served as raw binary instead of the real extracted `package.json` | Proxy extracts `extension/package.json` from inside the `.vsix` specifically for this asset type |
| 11 | `Server returned 404` when opening an extension's detail page | Manifest entry exists but the matching `.vsix` was never actually uploaded/present, or its version doesn't match | Confirm the file exists under the exact expected filename; regenerate manifest from real files |
| 12 | Wrong extension build downloaded (e.g. ARM64/Alpine instead of Windows) | Some extensions publish multiple platform-specific `.vsix` builds under one version | Always download with `?targetPlatform=win32-x64` explicitly |
| 13 | PowerShell `Get-Process` / `Invoke-WebRequest` UAC / proxy 403 confusion | Corporate web proxy requiring LDAP/NTLM Basic Auth, which Node's `fetch` doesn't negotiate the way a browser or `Invoke-WebRequest` (via WinINet) does | Either configure `https-proxy-agent` with explicit Basic Auth creds, get a network exception for the internal Git/Nexus host, or (fastest for a demo) switch the proxy to a **local-folder backend** |
| 14 | "invalid JSON response body" fetching manifest | Node doesn't trust the org's internal CA the way the OS/browser does — separate trust store | Set `NODE_EXTRA_CA_CERTS` to the org's Root CA `.pem`, or (demo-only, not production) `NODE_TLS_REJECT_UNAUTHORIZED=0` |
| 15 | GitLab raw file returns HTML sign-in page instead of JSON | Wrong auth header — GitLab raw endpoints often want `PRIVATE-TOKEN`, not `Authorization: Bearer` | Proxy supports a configurable `NEXUS_AUTH_HEADER` env var |
| 16 | GitLab `403 Forbidden` even with a token | Token missing `read_repository` scope, expired, or the token's user lacks project access | Reissue a token with correct scope and role, or set repo visibility to Internal |
| 17 | `.exe` flashes and exits instantly with no visible error | Double-clicking closes the console the instant the process exits | Run from an already-open terminal, or redirect output to a log file |
| 18 | `Error: Cannot find module 'https-proxy-agent'` in packaged exe | `pkg` didn't bundle the module into its virtual filesystem — a known limitation with certain package structures | Add explicit `pkg.assets` entries in `package.json`; build with `pkg .`, not `pkg <file>.js` |
| 19 | `npm install <single-package>` removed ~180 other packages | `npm install` reconciles `node_modules` against `package.json`; installing one package without the others listed prunes the rest | Always install all required dependencies together in one command |
| 20 | `Warning: Entry 'main' not found in ... package.json` | `https-proxy-agent@7.x` uses an `"exports"` map instead of a `"main"` field, which older `pkg` can't resolve | Pin to `https-proxy-agent@5.0.1`, which still has a plain `"main"` field |
| 21 | "Version mismatch in Marketplace" installing an extension | VS Code's real compatibility check reads the **actual** `engines.vscode` field from inside the `.vsix`'s own `package.json` — not anything in our external `manifest.json` | Check the real value via `Expand-Archive` on the `.vsix`; if genuinely incompatible, get a version matching your VS Code, or (demo-only) patch `engines.vscode` inside the `.vsix` itself |
| 22 | Same version-mismatch error persisting after edits | VS Code caches extension metadata on disk (`CachedExtensionVSIXs`, `CachedData`, `state.vscdb`) separately from the proxy's own 30-second in-memory cache | Fully quit VS Code, clear those cache paths (or rename the whole `%APPDATA%\Code` folder for a clean-slate test), restart the proxy fresh |
| 23 | Hand-repackaged `.vsix` (after editing `package.json` inside it) causes new failures | `Compress-Archive` does not reliably reproduce the exact OPC zip structure VS Code's installer expects | Avoid hand-editing/re-zipping `.vsix` files; prefer downloading a compatible original version instead |
| 24 | `.bat` launcher unexpectedly prompts for admin | A "Run as administrator" flag set on the shortcut or the file's own Compatibility settings — not caused by the script itself | Uncheck it in both places; also avoid placing the folder under a protected system path |

---

## 7. Key design decisions worth remembering

- **The proxy is completely stateless.** It holds only a 30-second
  in-memory manifest cache — nothing is ever written to disk. Any
  persistent "stale data" symptom is either the backend file itself, or
  VS Code's own local caches — never the proxy.
- **A translation layer is required** because VS Code's Extensions panel
  speaks a specific API protocol (`POST /extensionquery` with structured
  filters, a specific JSON response shape, dynamic asset extraction from
  inside `.vsix` zips, and required CORS headers) — a plain static file
  host like Nexus/GitLab cannot serve this directly. See
  `why-proxy-is-needed.md` for the full explanation.
- **Local-folder backend mode exists as a first-class option**, not just
  a fallback — set `NEXUS_BASE_URL` to a local path instead of a URL and
  the proxy reads files straight off disk, with zero network/auth
  dependency. Useful for demos and for isolating whether an issue is
  network-related or not.