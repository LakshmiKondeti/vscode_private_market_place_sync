# Why a Local Gallery Proxy Is Needed (Not a Direct Nexus URL)

## Question
Why does `product.json` need a custom Node.js proxy in front of Nexus,
instead of pointing `extensionsGallery.serviceUrl` directly at a Nexus
repository URL?

## Short answer
VS Code's Extensions panel doesn't fetch a static file — it calls a
specific API protocol (the "VS Code Gallery API") with structured
requests and expects structured, dynamically-built responses. Nexus (or
any generic file/artifact host) only serves static files at fixed paths
and cannot generate, filter, or transform a response on the fly. The
proxy exists purely to translate between the two.

---

## What VS Code actually requires vs. what Nexus provides

| Requirement | What VS Code needs | What Nexus (or any raw file host) provides |
|---|---|---|
| Search / listing | `POST /extensionquery` with a structured JSON filter body, returning a filtered result set | Static `GET` of a fixed file — no request body processing, no filtering logic |
| Response shape | A specific JSON envelope: `{"results":[{"extensions":[...], "resultMetadata":[...]}]}` | Whatever raw bytes are stored at the path, unmodified |
| Asset extraction | The `Microsoft.VisualStudio.Code.Manifest` asset must return the extension's real `package.json`, extracted **from inside** the `.vsix` zip | No unzip/extraction capability — serves the file exactly as uploaded |
| Asset delivery | The `VSIXPackage` asset must stream the actual `.vsix` binary | This part Nexus *can* do natively (plain file serving) |
| CORS headers | VS Code's Electron renderer (running under the `vscode-file://` origin) requires specific `Access-Control-Allow-*` response headers on every call | Not configured for this by default; Nexus isn't aware of VS Code's origin requirements |
| Transport | Must be served over **HTTPS**, specifically reachable at `127.0.0.1` from the local machine — VS Code's Content-Security-Policy blocks plain `http://` outright | Nexus normally runs on its own real hostname/port, not `127.0.0.1`, and may not be HTTPS-only |

---

## Concrete issues this project hit that prove the point

These aren't theoretical — each of these was an actual blocker encountered
during development, and each one is something a static file host cannot
solve on its own:

1. **`POST /extensionquery` with a filter body** — Nexus has no mechanism
   to accept a request body and return a computed, filtered response.
   The proxy fetches the full `manifest.json` from Nexus, then filters it
   in memory based on what VS Code searched for.

2. **`TypeError: Cannot read properties of undefined (reading 'indexOf')`**
   — VS Code's parser expects every extension version to include `files`
   and `properties` arrays in a specific shape. A hand-uploaded static
   JSON file has to be built to match this exactly; Nexus has no way to
   validate or generate this shape itself.

3. **`Error: Installing Extension ... failed: Manifest is not found.`**
   — VS Code needs the real `extension/package.json`, extracted from
   inside the `.vsix` zip, as a *separate* asset from the `.vsix` itself.
   Nexus stores the `.vsix` as one opaque binary; it cannot unzip and
   serve an internal file. The proxy does this extraction live, using
   `adm-zip`, on every request.

4. **CORS preflight rejection** (`Request header field x-market-user-id
   is not allowed`) — VS Code's renderer sends custom headers that must
   be explicitly allowed via `Access-Control-Allow-Headers`. A raw file
   host returns no CORS headers at all by default.

5. **CSP block** (`Refused to connect because it violates the document's
   Content Security Policy`) — VS Code blocks any `http://` connection
   from its Extensions panel outright, and expects the gallery service to
   be reachable at `127.0.0.1`. Nexus is a remote, named-host service; it
   is not designed to be addressed as a local HTTPS endpoint.

---

## What the proxy actually does (summary)

The proxy is a small translation layer that:

1. Accepts VS Code's real gallery API calls (`/api/extensionquery`,
   `/api/item`, `/api/vscode/{publisher}/{name}/latest`,
   `/api/assets/{publisher}/{name}/{version}/{file}`)
2. Fetches the simple, flat `manifest.json` + `.vsix` files from Nexus
   (or GitLab, or a local folder — any plain file store) behind the
   scenes
3. Reshapes / filters / extracts what it gets back into exactly the
   response format VS Code expects
4. Serves all of this over HTTPS on `127.0.0.1`, with the CORS headers
   VS Code's renderer requires

Nexus (or any equivalent artifact store) remains the **single source of
truth for approved extensions** — the proxy adds no content of its own
and stores nothing permanently; it is a stateless, request-time
translator between "what VS Code speaks" and "what a plain artifact
store provides."

---

## Why this is not unique to our setup

This is exactly why the official VS Code Marketplace and the open-source
**Open VSX Registry** are both full server applications — implementing a
database, search index, and this same API — rather than just a folder of
files on a web server. Our local proxy is a minimal, purpose-built
version of that same necessary layer, scoped to only what our curated
extension list needs.