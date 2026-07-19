# I01 Runtime Evidence — Openable Two-Panel Scaffold

Date: 2026-07-17
Milestone: I01 only
Repository: `/Users/REDACTED/Documents/Dev_code/_Collaborations/chroma-relay`

## Scope

This checkpoint proves a neutral two-panel CEP foundation. It intentionally contains no palette logic, settings synchronization, persistence, host color functions, drag/drop, or final visual design.

## Scaffold provenance

- Generator: `create-bolt-cep@2.2.3`
- Framework: React + TypeScript + Sass
- Host: AEFT only, version `[24.0,99.9]`
- Bundle ID: `com.zimoby.chroma-relay`
- The upstream CLI value-option parser discarded supplied values and attempted TTY prompts. The same pinned package's exported `createBoltCEP()` function was therefore called with the explicit generator arguments.
- The untouched generated scaffold completed `npm run build` before panel edits.

## Build and installation proof

Final verification command:

```bash
COREPACK_ENABLE_PROJECT_SPEC=0 yarn run build
```

Result: passed with Yarn 1.22.22. TypeScript compiled, Vite transformed 43 modules, and the manifest, `.debug`, Main page, Settings page, and hashed assets were emitted.

The Corepack environment override was command-local. It bypassed `/Users/REDACTED/package.json` declaring pnpm; no package-manager metadata was changed.

Development link:

```text
/Users/REDACTED/Library/Application Support/Adobe/CEP/extensions/com.zimoby.chroma-relay
→ /Users/REDACTED/Documents/Dev_code/_Collaborations/chroma-relay/dist/cep
```

Generated manifest contract:

- `com.zimoby.chroma-relay.main` → `main/index.html`
- `com.zimoby.chroma-relay.settings` → `settings/index.html`
- Settings is a hidden, non-auto-visible Panel.
- Debug ports: Main 8198, Settings 8199.

## Live After Effects proof

- Host: After Effects `26.3x87`
- No project was open during the required restart.
- Main Extensions-menu command ID after restart: `5098`
- Main opened through the real AE Extensions menu.
- Hidden Settings opened from Main with CEP `requestOpenExtension()`.

### Main

- Port: `8198`
- Extension ID: `com.zimoby.chroma-relay.main`
- URL: `file:///Users/REDACTED/Library/Application%20Support/Adobe/CEP/extensions/com.zimoby.chroma-relay/main/index.html`
- Title: `Chroma Relay — Main`
- Marker: `Main · I01 · 0.0.1`
- Ready state: `complete`
- Runtime exceptions: `0`
- CDP log entries: `0`
- Expected page-load info message observed.

Artifacts:

- [main.json](main.json)
- [main.png](main.png)

### Settings

- Port: `8199`
- Extension ID: `com.zimoby.chroma-relay.settings`
- URL: `file:///Users/REDACTED/Library/Application%20Support/Adobe/CEP/extensions/com.zimoby.chroma-relay/settings/index.html`
- Title: `Chroma Relay — Settings`
- Marker: `Settings · I01 · 0.0.1`
- Ready state: `complete`
- Runtime exceptions: `0`
- CDP log entries: `0`
- Expected page-load info message observed.

Artifacts:

- [settings.json](settings.json)
- [settings.png](settings.png)

## Visual check

Both live renderer screenshots are non-blank. The intended heading and page marker are visible, with no clipping, overlap, or rendering errors. Styling remains deliberately neutral for the I01 technical gate.

## Result

I01 passes. Both real CEP surfaces open from the intended symlinked build and expose the exact planned IDs, ports, pages, assets, and markers. Stop here for review; I02 has not started.
