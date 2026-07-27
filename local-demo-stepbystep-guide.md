# Local Demo: Nexus + Gallery Proxy + VS Code Extension Allowlist

Full walkthrough to run everything on one machine: Nexus (Docker), the local
gallery proxy (Node), and VSCodium pointed at localhost instead of the public
Marketplace.

---

## Part 0: Prerequisites

Install these before starting:

| Tool | Why | Check |
|---|---|---|
| **Docker Desktop** | Runs Nexus in a container | `docker --version` |
| **Node.js 18+** | Runs the proxy script, needed for `pkg` | `node --version` |
| **npm** | Comes with Node | `npm --version` |
| **VSCodium** | Test client — regular VS Code won't let you override the gallery URL, VSCodium will | Download from https://vscodium.com |
| **A code editor / terminal** | To edit `product.json`, run commands | any |
| **curl or Postman** (optional) | To test Nexus/proxy endpoints directly | `curl --version` |

Minimum machine specs: 8GB RAM is comfortable (Nexus alone wants ~2GB heap by default), a few GB free disk for the Docker image + repo storage.

Windows users: run Docker Desktop with WSL2 backend, and use PowerShell or Git Bash for the commands below (adjust path syntax where needed — I'll flag Windows-specific spots).

---

## Part 1: Spin up Nexus in Docker

### 1.1 Run the container
```bash
docker volume create nexus-data

docker run -d \
  --name nexus \
  -p 8081:8081 \
  -v nexus-data:/nexus-data \
  sonatype/nexus3
```

This takes 1–3 minutes to fully start (Nexus is a Java app, slow first boot). Watch logs:
```bash
docker logs -f nexus
```
Wait until you see `Started Sonatype Nexus` (or similar "started" message), then Ctrl+C to stop tailing.

### 1.2 Get the admin password and log in
```bash
docker exec nexus cat /nexus-data/admin.password
```
Copy that string. Open `http://localhost:8081` in a browser, click **Sign in** (top right), username `admin`, paste the password. It'll prompt you to set a new password and (optionally) disable anonymous access — for this demo, **keep anonymous access enabled** to keep auth simple; you can lock it down later.

### 1.3 Create a raw hosted repository
- Left menu (gear icon) → **Repositories** → **Create repository**
- Choose **raw (hosted)**
- Name it: `vscode-extensions`
- Leave defaults, click **Create repository**

You now have a repo reachable at:
```
http://localhost:8081/repository/vscode-extensions/
```

### 1.4 Create a token/service account (optional for local demo)
Since anonymous read is on for the demo, you can skip auth entirely at first pass. If you want to test the auth path too:
- **Security → Users → Create local user**, give it a role with read access to the repo
- Or **Security → Users → admin → generate a user token** (Nexus has a "User Token" feature under user profile) to use as a Bearer token later

---

## Part 2: Get real extensions and upload them

### 2.1 Download a couple of real `.vsix` files
Easiest way — from the public Marketplace, each extension page has a "Download Extension" link if you visit via a browser with "..." → Install from VSIX docs, or use this direct pattern:
```
https://marketplace.visualstudio.com/_apis/public/gallery/publishers/{publisher}/vsextensions/{name}/{version}/vspackage
```
Example for Python:
```
https://marketplace.visualstudio.com/_apis/public/gallery/publishers/ms-python/vsextensions/python/2024.1.0/vspackage
```
Save the result as `ms-python.python-2024.1.0.vsix` (note: the download comes back gzip'd with a `.vsix` extension already correct — rename only if needed).

Grab 2–3 for the demo, e.g.:
- `ms-python.python`
- `dbaeumer.vscode-eslint`
- `esbenp.prettier-vscode`

### 2.2 Upload them to Nexus
Via UI: open the `vscode-extensions` repo in Nexus → **Upload** → drag the `.vsix` file → set the **Directory** field (e.g. leave blank for repo root) and **Filename** to match, e.g. `ms-python.python-2024.1.0.vsix` → Upload.

Or via curl (faster once you have several):
```bash
curl -u admin:<your-password> \
  --upload-file ms-python.python-2024.1.0.vsix \
  http://localhost:8081/repository/vscode-extensions/ms-python.python-2024.1.0.vsix
```
(Skip `-u` entirely if anonymous write happens to be enabled — usually it isn't, so keep the credential for uploads even if reads are anonymous.)

Verify it's there:
```bash
curl -I http://localhost:8081/repository/vscode-extensions/ms-python.python-2024.1.0.vsix
```
Should return `HTTP/1.1 200 OK`.

### 2.3 Upload the manifest
Use the `manifest.example.json` file from earlier, edit it to match exactly the extensions/versions you uploaded, then push it the same way:
```bash
curl -u admin:<your-password> \
  --upload-file manifest.json \
  http://localhost:8081/repository/vscode-extensions/manifest.json
```
Verify:
```bash
curl http://localhost:8081/repository/vscode-extensions/manifest.json
```
You should see your JSON back.

**Checkpoint:** at this point Nexus alone is fully working as a dumb file host — you have real `.vsix` files and a manifest reachable over HTTP. Nothing VS Code-specific yet.

---

## Part 3: Run the gallery proxy locally

### 3.1 Set up the project folder
```bash
mkdir gallery-proxy && cd gallery-proxy
npm init -y
npm install express node-fetch@2
```
Copy `local-gallery-proxy.js` (from earlier) into this folder.

### 3.2 Run it directly with Node first (skip .exe packaging for now — faster iteration)
```bash
export NEXUS_BASE_URL=http://localhost:8081/repository/vscode-extensions
export GALLERY_PROXY_PORT=8080
node local-gallery-proxy.js
```
Windows PowerShell equivalent:
```powershell
$env:NEXUS_BASE_URL="http://localhost:8081/repository/vscode-extensions"
$env:GALLERY_PROXY_PORT="8080"
node local-gallery-proxy.js
```
You should see:
```
Gallery proxy listening on http://127.0.0.1:8080
Backed by Nexus: http://localhost:8081/repository/vscode-extensions
```

### 3.3 Test the proxy directly before touching VS Code
Manifest passthrough (simulates what VS Code's search calls):
```bash
curl -X POST http://localhost:8080/api/extensionquery \
  -H "Content-Type: application/json" \
  -d '{"filters":[{"criteria":[]}]}'
```
You should get back JSON with your extensions listed under `results[0].extensions`.

Asset streaming (simulates an install download):
```bash
curl -I http://localhost:8080/api/assets/ms-python/python/2024.1.0/vspackage
```
Should return `200 OK` with `Content-Type: application/octet-stream` — confirms the proxy successfully streamed the file from Nexus.

**Checkpoint:** the full chain VS Code → proxy → Nexus is now provably working via curl, before you even open an editor. This is the most important debugging checkpoint — if something's wrong later, come back and re-test here first.

---

## Part 4: Point VSCodium at the local proxy

### 4.1 Locate `product.json`
- **Windows**: `C:\Users\<you>\AppData\Local\Programs\VSCodium\resources\app\product.json`
- **macOS**: `/Applications/VSCodium.app/Contents/Resources/app/product.json`
- **Linux**: `/usr/share/codium/resources/app/product.json` (or wherever your package manager put it)

Make a backup copy first:
```bash
cp product.json product.json.bak
```

### 4.2 Edit the `extensionsGallery` block
Open `product.json`, find (or add, if missing) the `extensionsGallery` key at the top level, and set:
```json
"extensionsGallery": {
  "serviceUrl": "http://127.0.0.1:8080/api/extensionquery",
  "itemUrl": "http://127.0.0.1:8080/api/item",
  "resourceUrlTemplate": "http://127.0.0.1:8080/api/assets/{publisher}/{name}/{version}/{path}"
}
```
Save the file.

### 4.3 Fully quit VSCodium and relaunch
Gallery config is only read at startup — quit from the tray/dock, don't just close the window, then reopen.

### 4.4 Verify in the UI
- Open the Extensions panel (`Ctrl+Shift+X`)
- You should see only the extensions from your manifest (2–3 items), not the full public catalog
- Try installing one — it should download via your proxy → Nexus, and install successfully
- Check your `node local-gallery-proxy.js` terminal — you'll see the incoming requests logged in real time, which is a great way to *show* people during a demo that the traffic is really flowing through your local proxy

### 4.5 Test the "not running" case
- Stop the proxy (`Ctrl+C` in its terminal)
- Fully quit and relaunch VSCodium (or just reload the Extensions panel)
- Confirm the Extensions panel now shows an error/empty state instead of the catalog — this proves the "no proxy running = no extensions visible" behavior

---

## Part 5: (Optional) Package as .exe for a cleaner demo

Only do this once Parts 1–4 all work via plain `node`:
```bash
npm install -g pkg
pkg local-gallery-proxy.js --target node18-win-x64 --output vscode-gallery-proxy.exe
```
Set env vars before running the exe the same way, then repeat the Part 4.4 verification using the exe instead of `node local-gallery-proxy.js`.

---

## Troubleshooting checklist

| Symptom | Likely cause |
|---|---|
| Extensions panel shows nothing, no error | `product.json` gallery URL typo, or VSCodium wasn't fully restarted |
| `curl` to proxy works but VS Code shows nothing | Response shape mismatch — open VS Code DevTools (`Help → Toggle Developer Tools`) and check the Network tab for the actual `extensionquery` request/response VS Code expects, compare to what the proxy returns |
| Proxy logs show request but Nexus 404s | Filename in Nexus doesn't exactly match `{publisher}.{name}-{version}.vsix` pattern the proxy constructs |
| Nexus container won't start / crashes | Low memory — Nexus wants ~2-4GB; check `docker logs nexus` for OOM errors, increase Docker Desktop's memory allocation |
| Install fails partway through | Check `Content-Type` header — must be `application/octet-stream`, and confirm the byte stream isn't being altered (e.g. some proxies/antivirus tools intercept and corrupt binary streams) |


## 
# Test 1: Bearer (what our proxy currently sends)
Invoke-WebRequest -Uri "$env:NEXUS_BASE_URL/manifest.json" -Headers @{Authorization="Bearer $env:NEXUS_TOKEN"} -UseBasicParsing

# Test 2: PRIVATE-TOKEN (GitLab's more common header for this)
Invoke-WebRequest -Uri "$env:NEXUS_BASE_URL/manifest.json" -Headers @{"PRIVATE-TOKEN"=$env:NEXUS_TOKEN} -UseBasicParsing
---

## What this local setup proves (for your org demo)

1. Nexus can be the real, single source of truth for approved extensions
2. A tiny local proxy (no shared server, no DB) can translate VS Code's gallery protocol into simple Nexus HTTP calls
3. The "only allowed extensions visible" requirement is satisfied structurally — there is no code path back to the public Marketplace once `product.json` is repointed
4. The "nothing visible when not running" requirement is a natural side effect of the localhost-only proxy, not something you had to specially build
