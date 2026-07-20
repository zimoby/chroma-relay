# Chroma Relay Demo Implementation Plan

> **For Hermes:** Execute only this demo scope, one milestone at a time. Do not import systems from the production rebuild plan unless the user explicitly promotes the demo to a real product build.

**Goal:** Produce the smallest credible live After Effects demo of Chroma Relay: collect directly selected color properties into a visible palette, then click a swatch to apply it to writable static color properties.

**Architecture:** One CEP bundle contains Main and a hidden Settings panel. Main owns a palette persisted in isolated `palette.json`, renders fixed-size swatches, and derives horizontal/vertical orientation from its live geometry. Settings owns one persisted 24–64 px size value in isolated `settings.json`, while one CEP event updates Main during the current session. Both files are read at startup and survive panel or AE restarts. Two small ES3-compatible ExtendScript functions handle direct selected-property collection and static-property application through Bolt's existing typed `evalTS` bridge. The demo is disposable: no versioned/atomic recovery protocol, automation harness, package, or release claim.

**Tech stack:** Pinned Bolt CEP/vite-cep-plugin 2.2.3, React, TypeScript, Sass, npm/`package-lock.json`, and ES3-compatible ExtendScript for AEFT 22.0+.

**Disposable target:** `$HOME/Documents/Dev_code/_Collaborations/chroma-relay-demo`. Use bundle ID `com.zimoby.chroma-relay.demo`, panel IDs `com.zimoby.chroma-relay.demo.main` and `com.zimoby.chroma-relay.demo.settings`, display name `Chroma Relay Demo`, and debug ports 8298/8299 so the demo cannot replace or masquerade as the current extension.

---

## Demo success contract

The demo is complete when all of the following work in one live AE session:

1. **Window → Extensions → Chroma Relay Demo** opens the 320×80 Main panel.
2. Main's flyout opens a separate hidden Settings panel.
3. Settings changes the fixed 24–64 px swatch size, creates/updates `settings.json`, and Main restores that size after restart.
4. Resizing Main wide or tall automatically switches the swatch rail between horizontal and vertical.
5. On first launch, Main creates `palette.json` with three starter swatches; later launches restore the saved palette.
6. Selecting one or more leaf COLOR properties and clicking Add appends their current colors and saves the complete palette JSON.
7. Selecting one or more writable static leaf COLOR properties and clicking a swatch applies that color in one undo group.
8. Keyframed and expression-enabled properties are skipped, never rewritten.
9. **Edit → Undo** restores the applied values.

Reloading either panel or restarting AE restores the complete saved palette and swatch size from the two demo JSON files.

## Explicit simplifications

| Production capability | Demo decision |
|---|---|
| Main + hidden Settings panels | Kept |
| Stretch/Fixed sizing and automatic orientation | Fixed 24–64 px swatches only; automatic horizontal/vertical orientation kept |
| Palette/settings JSON persistence | Kept with isolated `palette.json` and `settings.json`; both are created, read, and updated |
| CEP events and one-way synchronization | One Settings event plus startup file reads; no revisions, polling, or recovery protocol |
| Recursive selected groups/layers | Directly selected leaf COLOR properties only |
| Disabled-branch preference | Removed |
| Gradients and TextDocument accounting | Ignore as unsupported |
| Remove and drag/keyboard reorder | Removed |
| Stable persisted IDs/revisions/migrations | Removed |
| Recoverable queued file replacement | Removed |
| Development debug API and CDP target identity | Removed |
| Unit, contract, integration, and screenshot tests | Removed |
| Evidence reports and failure matrix | Removed |
| Alpha ZIP/ZXP/package validation | Removed |
| Windows validation and public compatibility claim | Removed |
| Release hardening, licensing, telemetry, updates | Removed |

**Important:** “No testing layer” means no reusable automated test infrastructure. It does not mean shipping an unexercised panel; the final task is one short manual live-AE smoke gate.

## Speed rules

1. Use npm and `package-lock.json`. Do not use bare Yarn on this Mac because the ancestor `$HOME/package.json` declares pnpm and blocks project Yarn commands.
2. Scaffold only in the disposable `chroma-relay-demo` target. Never scaffold or symlink this plan over `$HOME/Documents/Dev_code/_Collaborations/chroma-relay`.
3. Generate exactly two AEFT panels from the start: visible Main and hidden Settings.
4. Run the untouched scaffold build before editing so generator/toolchain failures remain separate from demo failures.
5. Keep all demo host logic in `src/jsx/aeft/aeft.ts`; do not create production abstractions.
6. Keep palette/UI state in `src/js/main/main.tsx` and Settings UI state in `src/js/settings/settings.tsx`; use one tiny shared storage module, not context, reducers, revisions, or schemas.
7. Persist exactly two files under `USER_DATA/Chroma Relay Demo/`: `palette.json` with `{ "colors": [[1, 0, 0, 1], ...] }` and `settings.json` with `{ "swatchSize": 32 }`.
8. Main is the only `palette.json` writer. Settings is the only `settings.json` writer. Main reads both files; Settings reads only `settings.json`.
9. Use one direct CEP Settings event after a successful settings save. Keep direct formatted JSON writes, but do not add temp/backup replacement, write queues, startup polling, acknowledgements, revisions, or migrations.
10. Do not add `tests/`, CDP scripts, debug globals, evidence directories, package scripts, or release workflows.
11. Do not solve edge cases outside the success contract. Show a short inline status for no selection, no supported color, malformed palette/settings, failed save, skipped properties, or host error.
12. Stop after the manual smoke passes. If the concept is approved, start the production path from `docs/implementation-plan.md` rather than expanding this disposable demo.

## Milestone A — openable two-panel visual demo

### Task D0 — Generate and configure the two-panel scaffold

**Objective:** Reach an untouched, buildable two-panel AE extension before product code.

**Files:**
- Generate: `package.json`, `package-lock.json`, `cep.config.ts`, `vite.config.ts`, `vite.es.config.ts`, `src/js/main/`, `src/js/settings/`, and `src/jsx/`.
- Modify after the untouched build: `cep.config.ts`.

**Steps:**
1. Scaffold pinned `create-bolt-cep@2.2.3` with React, TypeScript, and AEFT only.
2. If the CLI fails with `ERR_TTY_INIT_FAILED`, use the same package's `BOLT_MODULEONLY=1` exported `createBoltCEP({...})` API; do not hand-copy a template.
3. Keep npm/`package-lock.json`; run `npm ci` after the lockfile exists.
4. Run `npm run build` before customization.
5. Configure exactly two panels:
   - bundle ID `com.zimoby.chroma-relay.demo`
   - Main ID `com.zimoby.chroma-relay.demo.main`, display name `Chroma Relay Demo`, port 8298, default 320×80, minimum 128×32
   - Settings ID `com.zimoby.chroma-relay.demo.settings`, blank display name, port 8299, default 320×220, minimum 280×180, `autoVisible: false`
   - AEFT range `[22.0,99.9]`
   - `jsxBin: "off"`
6. Run `npm run build` again and inspect `dist/cep/CSXS/manifest.xml` for the two expected demo panels, isolated IDs/ports, and AE 22 floor.

**Gate:** Build succeeds and the generated manifest contains exactly Main and hidden Settings.

### Task D1 — Render both static Seam-style surfaces

**Objective:** Produce the complete Main and Settings appearance before wiring panels or AE behavior.

**Files:**
- Modify: `src/js/main/main.tsx`
- Modify: `src/js/main/main.scss`
- Modify: `src/js/settings/settings.tsx`
- Modify: `src/js/settings/settings.scss`
- Keep: `src/js/settings/index-react.tsx`
- Modify if needed: `src/js/index.scss`
- Keep: `src/js/main/index-react.tsx`

**Steps:**
1. Replace Main template UI with one no-wrap rail on `#1c1d1f`; its flex direction is controlled by the measured orientation.
2. Initialize Main with three starter RGBA values—red, green, and blue—and default demo settings `{ swatchSize: 32 }`.
3. Render each value as a swatch button; clamp display channels to 0–255 only when producing CSS.
4. Render one separate Add button with a visible plus glyph.
5. Always render swatches and Add at the selected 24–64 px size. Use `ResizeObserver` to set horizontal orientation when width ≥ height and vertical orientation otherwise.
6. Add one compact Main status area for actionable/no-op messages, plus visible focus and simple hover states. Do not add remove, reorder, notices, or animations.
7. Render Settings on the same `#1c1d1f` canvas with one `input[type="range"]` (24–64, step 1), a numeric value label, and an error-only inline message region. Do not add Stretch/Fixed, manual orientation, Include Disabled Colors, or routine success/footer text.
8. Run `npm run build` and `npm run symlink`; open Main and confirm its starter swatches and Add control. Settings is built here but intentionally inspected only after D2 wires its flyout launch.

### Task D2 — Open Settings, persist size, and update Main

**Objective:** Prove both demo panels, the settings half of the isolated JSON storage, and the live size handoff without production persistence hardening.

**Files:**
- Create: `src/js/shared/demo-storage.ts`
- Modify: `src/js/lib/utils/init-cep.ts`
- Modify: `src/js/main/main.tsx`
- Modify: `src/js/settings/settings.tsx`

**Steps:**
1. In `demo-storage.ts`, define the two extension IDs, one event name, `RGBA = [number, number, number, number]`, `DemoSettings = { swatchSize: number }`, `DemoPalette = { colors: RGBA[] }`, `DEFAULT_DEMO_SETTINGS`, `DEFAULT_DEMO_PALETTE`, their validators, and a 24–64 size clamp. Resolve the isolated directory with `new CSInterface().getSystemPath("userData")` plus Node `path.join(..., "Chroma Relay Demo")`; derive `settings.json` and `palette.json` beneath it.
2. Customize Bolt's existing single flyout initialization path. Main gets `Settings…` and Refresh; Settings gets Refresh only. Do not stack a second flyout listener after `initBolt()`.
3. On Main's Settings menu item, call `requestOpenExtension("com.zimoby.chroma-relay.demo.settings", "")`.
4. Implement read-only `readDemoSettings()` returning `{ settings, missing, error }`, plus `saveDemoSettings()`. Reading never creates directories or files. A missing file returns defaults with `missing: true`; valid JSON is clamped; malformed JSON returns defaults plus an error without changing the file.
5. Main subscribes to the application-scoped event before its startup read, then calls only `readDemoSettings()`. It surfaces any read error in Main's compact error/no-op area, accepts object or JSON-string event data, clamps the size, updates immediately, and removes the listener during effect cleanup. Main never calls `saveDemoSettings()`.
6. Settings calls `readDemoSettings()` on mount. If the file is missing, Settings calls `saveDemoSettings(DEFAULT_DEMO_SETTINGS)` to create the directory/default file and dispatches the saved default. If malformed, it shows the error-only message and waits for an explicit user save before overwriting. `onChange` updates the local preview; `onMouseUp`, `onKeyUp`, or `onBlur` commits only when the normalized value differs from the last persisted value, writes formatted JSON once, and dispatches one event only after a successful save.
7. Keep direct demo writes simple. Do not add revisions, temp files, backups, queues, acknowledgements, polling, migrations, or cross-process locking.
8. Run `npm run build`, reload Main, open Settings from the real flyout, change size, and confirm Main updates. Reload both panels and confirm the saved size is restored.

**Review question:** Are both minimal panels, automatic orientation, and persisted fixed swatch size sufficient for the demo?

**Boundary:** Stop for continue/revise/stop review before adding host behavior.

## Milestone B — live color workflow

### Task D3 — Collect and persist directly selected colors

**Objective:** Make Add read current values from explicitly selected leaf COLOR properties, append them, and persist the complete palette across panel and AE restarts; host collection remains read-only even for keyed or expression-driven properties.

**Files:**
- Modify: `src/jsx/aeft/aeft.ts`
- Modify: `src/js/shared/demo-storage.ts`
- Modify: `src/js/main/main.tsx`

**Host contract:**

```text
collectDemoColors() -> {
  status: "ok" | "no-project" | "no-active-comp" | "no-supported-colors",
  colors: [number, number, number, number][]
}
```

**Steps:**
1. In `collectDemoColors`, require an active `CompItem`.
2. Iterate `selectedLayers`, then each layer's `selectedProperties`.
3. Read only leaf properties whose `propertyValueType === PropertyValueType.COLOR`.
4. Accept finite three- or four-channel values; normalize missing alpha to 1.
5. Deduplicate exact/epsilon-equal values within the returned call only.
6. Do not recurse into groups or whole layers. Ignore gradients, text colors, disabled state, and throwing getters.
7. Implement read-only `readDemoPalette()` returning `{ palette, missing, error }`, plus `saveDemoPalette()`. Validate finite three/four-channel colors and normalize them to RGBA. Reading never writes; saving creates the isolated directory when needed. Invalid JSON returns the starter palette plus an error without changing the original file; only a later explicit Add may replace it with a complete valid palette.
8. On Main startup, call `readDemoPalette()`. If missing, Main calls `saveDemoPalette(DEFAULT_DEMO_PALETTE)` to create `palette.json`; otherwise it renders the saved palette. Main is the only palette writer.
9. In Main, call `evalTS("collectDemoColors")` when Add is clicked, then build the complete deduplicated next palette.
10. If the next palette has no new colors, do not write. Otherwise call `saveDemoPalette(nextPalette)` before committing React state; on failure, preserve the last displayed/persisted palette and show an error.
11. Disable Add while the host call/save is running and show only no-op/error status text.
12. Run `npm run build`, reload the panel, select a leaf Fill/Stroke Color property, and confirm Add creates a matching swatch and updates `palette.json`. Reload Main and confirm the swatch returns.

**Gate:** One directly selected color is stored in the complete palette JSON and restored after Main reload without debug API or test harness code.

### Task D4 — Apply a swatch to directly selected static colors

**Objective:** Make swatch click apply one color safely enough for a live demonstration.

**Files:**
- Modify: `src/jsx/aeft/aeft.ts`
- Modify: `src/js/main/main.tsx`

**Host contract:**

```text
applyDemoColor(rgba) -> {
  status: "ok" | "no-project" | "no-active-comp" | "no-writable-colors",
  appliedCount: number,
  skippedCount: number
}
```

**Steps:**
1. Validate four finite input channels.
2. Require an active `CompItem` and inspect only directly selected leaf COLOR properties.
3. Skip properties that cannot be set, have keys, or have an enabled expression.
4. Open one `app.beginUndoGroup("Chroma Relay Demo: Apply Color")` only when at least one writable target exists.
5. Call `setValue` with RGB or RGBA matching the property's existing channel length.
6. Close the undo group in `finally` and return applied/skipped counts.
7. In Main, disable all swatches while one host call is active so rapid clicks cannot overlap.
8. Call `evalTS("applyDemoColor", rgba)` on swatch click and show only no-op/error status text.
9. Run `npm run build`, reload the panel, apply a swatch to one directly selected static color property, and verify one AE Undo restores it.

**Gate:** Collect → click swatch → visible AE change → one Undo works in the intended demo composition.

### Task D5 — Run the minimal manual demo smoke

**Objective:** Confirm the exact demo path once without creating a testing layer.

**Files:** No new files. Do not create a report/evidence directory.

**Steps:**
1. Run `npm run build` and confirm exit code 0.
2. Run `npm run symlink` if the extension link is not already active.
3. Open Chroma Relay Demo in AE 22+; confirm the saved palette—or three starter swatches on a genuine first run—plus Add, and confirm `USER_DATA/Chroma Relay Demo/palette.json` exists. Never delete or reset existing demo storage during this smoke without explicit approval.
4. Open hidden Settings from Main's flyout; change size; confirm Main updates and `USER_DATA/Chroma Relay Demo/settings.json` contains that size.
5. Resize Main wide and tall; confirm orientation switches automatically while swatches remain fixed-size.
6. Select a leaf Fill or Stroke Color property; click Add; confirm one matching swatch appears and the complete `palette.json` contains it.
7. Select a different static leaf COLOR property; click the new swatch; confirm the property changes.
8. Invoke AE Undo once; confirm the original value returns.
9. Select a keyed or expression-enabled color property; click a swatch; confirm it is skipped and not rewritten.
10. Reload both panels, then—after saving/closing unrelated AE work and obtaining approval—fully restart AE and reopen Main/Settings; confirm the complete saved palette and swatch size both return.
11. Add another color after restart; confirm `palette.json` retains the previous colors and appends the new one.
12. Confirm the repository contains no demo-created `tests/`, CDP/debug/evidence, atomic recovery, packaging, or release code.

**Demo completion statement:** “The disposable Mac demo proves the two-panel Chroma Relay interaction, automatic orientation, complete JSON persistence for palette and settings across AE restarts, and the basic color workflow in live After Effects. It is not production-tested, recovery-hardened, packaged, Windows-validated, or release-ready.”

## Only commands required

```bash
cd $HOME/Documents/Dev_code/_Collaborations/chroma-relay-demo
npm ci
npm run build
npm run symlink
```
