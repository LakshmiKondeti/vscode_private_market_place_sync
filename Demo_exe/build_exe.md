# Building the One-Click Demo Package (.exe)

This produces a self-contained package: copy one folder to any new Windows
machine, double-click one file, and the entire curated VS Code extension
gallery demo sets itself up and launches — cert generation, trust import,
`product.json` patching, desktop shortcut, and first launch, all in one go.
No Node.js, no manual PowerShell, no pre-existing certs required on the
target machine.

---

## Prerequisites (on YOUR build machine only)

The target/demo machine needs none of these — only your own machine, where
you build the `.exe` files, needs:

| Tool | Purpose |
|---|---|
| Node.js 18+ | Runs the build tooling |
| npm | Installs dependencies |
| `pkg` (installed via npm) | Bundles Node + script into a single `.exe` |

---

## Part 1: Build the Proxy `.exe`

This is the long-running server that VS Code talks to. It needs to be
compiled once, then copied as-is to every demo machine.

### 1.1 Create a clean build folder
```bash
mkdir build-proxy
cd build-proxy
```

### 1.2 Copy in the proxy source file
Copy `local-gallery-proxy-final-v4.js` into this folder.

### 1.3 Initialize and install dependencies
```bash
npm init -y
npm install express node-fetch@2 adm-zip
```

### 1.4 Install `pkg` globally (one-time, on your machine)
```bash
npm install -g pkg
```

### 1.5 Build the executable
```bash
pkg local-gallery-proxy-final-v4.js --target node18-win-x64 --output vscode-gallery-proxy.exe
```

### 1.6 Confirm it was created
```bash
dir vscode-gallery-proxy.exe
```
It appears **in this same `build-proxy` folder**, alongside the `.js` file
you pointed `pkg` at.

---

## Part 2: Build the Setup `.exe`

This is the one-time installer: it generates the cert, imports it, patches
`product.json`, creates the desktop shortcut, and launches everything.

### 2.1 Create a clean build folder
```bash
mkdir build-setup
cd build-setup
```

### 2.2 Copy in the setup script
Copy `setup-demo.js` into this folder.

### 2.3 Initialize and install dependencies
```bash
npm init -y
npm install node-forge
```

### 2.4 Build the executable
```bash
pkg setup-demo.js --target node18-win-x64 --output setup-demo.exe
```

### 2.5 Confirm it was created
```bash
dir setup-demo.exe
```
Again, appears in this same `build-setup` folder.

---

## Part 3: Assemble the Final Demo Package

Create one folder that will be copied to the target machine, containing
**only** these files — no `key.pem`/`cert.pem` needed here, since
`setup-demo.exe` generates them fresh at runtime on the target machine:

```
demo-package\
  setup-demo.exe                    <- from Part 2
  vscode-gallery-proxy.exe           <- from Part 1
  launch-vscode-with-gallery.bat
  manifest.json
  ms-python.python-2024.8.1.vsix
  ms-toolsai.jupyter-2025.9.1.vsix
  icon.ico                           (optional — custom shortcut icon)
```

### 3.1 Copy the built exes in
```bash
copy build-proxy\vscode-gallery-proxy.exe demo-package\
copy build-setup\setup-demo.exe demo-package\
```

### 3.2 Copy in your approved extensions and manifest
```bash
copy manifest.json demo-package\
copy *.vsix demo-package\
```

### 3.3 Copy the launcher batch file
```bash
copy launch-vscode-with-gallery.bat demo-package\
```

At this point, zip the whole `demo-package` folder, or copy it directly via
USB/network share to the target machine.

---

## Part 4: Run on the Target Machine

### 4.1 Copy the `demo-package` folder onto the new machine
Anywhere convenient — Desktop, `C:\`, wherever.

### 4.2 Double-click `setup-demo.exe`

What happens, automatically, in order:

1. **UAC prompt appears** — accept it (needed once, for the cert-trust step)
2. Generates a fresh self-signed certificate (`key.pem` + `cert.pem`), specific to this machine
3. Imports that certificate into the Windows Trusted Root store
4. Searches for the active VS Code install and locates its `product.json`
5. **Backs up** the original `product.json` before touching it
6. Patches `extensionsGallery` to point at the local proxy
7. Sets `update.mode: none` in VS Code's user settings, so the patch survives future auto-updates
8. Creates a desktop shortcut named **"Company VS Code (Curated)"**
9. **Immediately launches** the proxy and VS Code — no second step needed

### 4.3 Confirm it worked

VS Code opens automatically. Open the Extensions panel (`Ctrl+Shift+X`) —
only the extensions listed in `manifest.json` should be visible and
installable.

### 4.4 For every subsequent use

No need to re-run `setup-demo.exe` — just double-click the **"Company VS
Code (Curated)"** desktop shortcut. It starts the proxy and VS Code together
each time.

---

## What Each File Does

| File | Role |
|---|---|
| `setup-demo.exe` | One-time installer — cert, trust, `product.json` patch, shortcut, first launch |
| `vscode-gallery-proxy.exe` | The actual running server VS Code talks to, every time |
| `launch-vscode-with-gallery.bat` | Starts the proxy, waits for it to be healthy, then opens VS Code — used by both the shortcut and the setup exe's first launch |
| `manifest.json` | The list of approved extensions the proxy serves |
| `*.vsix` | The actual approved extension packages |
| `key.pem` / `cert.pem` | Generated fresh on the target machine by `setup-demo.exe` — not shipped in the package |

---

## Troubleshooting Notes

- **UAC prompt doesn't appear / setup seems to hang** — some environments block `Start-Process -Verb RunAs` from a non-interactive session; try right-clicking `setup-demo.exe` → **Run as administrator** manually instead
- **"Could not find product.json automatically"** — open VS Code once first (so its install folder exists), close it, then re-run `setup-demo.exe`
- **Re-running `setup-demo.exe` is safe** — it checks whether the cert is already trusted and skips re-importing if so; it re-patches `product.json` fresh each time (taking a new timestamped backup each run)
- **Changing which extensions are approved** — just replace `manifest.json` and the `.vsix` files in the package folder; no need to re-run `setup-demo.exe`, only relaunch the proxy (via the desktop shortcut)

---

## Known Item to Verify Once

`pkg`'s handling of `Start-Process -Verb RunAs` self-elevation for a
packaged `.exe` can behave slightly differently across `pkg`/Node versions
compared to a plain script. Do one full dry run on a spare machine or VM
before relying on this for a live demo — specifically confirm the
UAC-elevated relaunch correctly locates its own folder (via
`path.dirname(process.execPath)`) and successfully generates/imports the
certificate.