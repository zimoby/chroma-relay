<p align="center">
  <img src="src/assets/chroma-relay-icon.svg" width="72" height="72" alt="Chroma Relay icon">
</p>

<h1 align="center">Chroma Relay</h1>

<p align="center">
  A compact After Effects palette for collecting, organizing, and applying exact colors and native gradients.
</p>

<p align="center">
  <strong>Internal alpha · v0.0.1 · After Effects 2022+</strong>
</p>

## Overview

Chroma Relay is a two-surface CEP extension for After Effects:

- **Main** is a responsive color rail. It collects colors, gradients, or a palette from one selected image, then applies stored entries to supported AE properties.
- **Settings** controls swatch layout, collection behavior, image extraction, and named palette management.

The interface stays intentionally small: the swatches are the product, not content inside a dashboard. Main automatically becomes horizontal when its width is at least its height and vertical otherwise.

Status notifications are failure-only: clean saves, applies, exports, and palette changes stay silent, while blocked, partial, recovery, and error outcomes remain visible.

> Chroma Relay is currently an unsigned internal-alpha candidate, not a public release. macOS runtime paths and Windows AE 2024 native gradients have live validation; the remaining Windows-version and final publication gates remain open.

## Features

### Collect

Use Main's **+** control to collect from the current After Effects selection:

- exact RGBA values from supported color properties;
- supported properties inside selected groups;
- supported properties across whole selected layers when no properties are selected;
- multiple selected layers in deterministic layer/property-path order;
- native gradients as individual color stops or exact reusable gradient slots;
- up to five colors from one selected JPEG or PNG using Balanced, Tonal, or Contrast extraction.

Disabled layers and groups are skipped by default and can be included from Settings. Collection is read-only and deduplicates entries without rounding stored values.

### Apply

- Click a color swatch to apply its exact RGBA value to selected writable color properties.
- Click a gradient slot to apply the stored native gradient to supported targets.
- **Smart Apply**, enabled by default in Settings, expands a target-free property or group to the nearest parent group containing matching colors or gradients. Direct matches remain exact, and the fallback never expands to the whole layer.
- Color and gradient operations share the scoped host transaction and one balanced Undo group.

Collecting an exact native gradient from project properties requires a clean saved project and stable descriptor identity. Applying an already stored gradient also fails closed on ambiguous targets, but supports dirty or unsaved projects when the selected targets are static, unlocked, and exactly resolvable.

### Organize

- Use the split **Add / Palettes** control in Main to replace the swatch rail with full-bleed palette previews; selecting a palette returns immediately to its colors.
- In palette-preview mode, **+** creates an empty palette when nothing is selected or creates a populated palette from the current color, gradient, or image selection.
- Drag swatches to reorder them.
- Alt/Option-click a swatch to remove it immediately.
- Alt/Option-click a palette preview to remove the whole palette while keeping at least one palette.
- Use the compact **×** control for explicit pointer or keyboard remove mode.
- Create, select, rename, import, export, and two-step-delete named palettes in Settings.
- Edit color entries as Hex, RGB, CMYK, and alpha without replacing exact HDR/out-of-range values with rounded previews.
- Choose Stretch sizing or fixed 24–64 px swatches.
- The panel flyout exposes only **Settings…** and **Refresh**; right-click opens **Settings**.

A document supports up to 32 palettes and 64 color or gradient entries per palette.

## Requirements

### Extension runtime

- Adobe After Effects 2022 / AEFT 22.0 or later
- CEP runtime 9 or later
- Chrome 74-compatible browser output

The manifest targets AE 22.0+. Native gradients are enabled on macOS and Windows for AE 22–26. Current Windows live evidence covers AE 2024; do not infer that the remaining Windows versions have passed live validation from the manifest or static routing alone.

### Development

- Node.js 22.x — the repository is currently pinned to Node 22.22.3
- npm 10.x — `package.json` declares npm 10.9.8
- A local After Effects installation for CEP/runtime validation
- GitHub read access to the private `zimoby/ae-native-gradient-toolkit` dependency, with Git authentication configured on the development device

## Local setup

The native-gradient dependency is pinned to an immutable commit in a private repository. Authenticate GitHub access before running `npm ci`; never copy access tokens into this repository or a tracked npm configuration file.

```bash
node --version
npm --version
npm ci
npm run build
npm run symlink
```

The local CEP link points to:

```text
~/Library/Application Support/Adobe/CEP/extensions/com.zimoby.chroma-relay
```

Restart or refresh After Effects, then open:

```text
Window → Extensions → Chroma Relay
```

Open Settings from Main's panel flyout with **Settings…**. The development CDP targets use ports 8198 for Main and 8199 for Settings.

Use `npm run delsymlink` to remove the local CEP link.

## Development commands

| Command | Purpose |
|---|---|
| `npm run build` | Clean and build the production CEP bundle, then write build provenance. |
| `npm run build:dev` | Build a development bundle with the guarded debug contract enabled. |
| `npm run watch` | Rebuild TypeScript and watch the Vite bundle. |
| `npm run verify:static` | Run the production build plus domain, storage, host, native-gradient, runner, release, and CEP compatibility checks. |
| `npm run react:doctor -- --verbose` | Run the bounded React Doctor review. |
| `npm run package:alpha` | Build and verify the unsigned internal-alpha ZIP. |
| `npm run cleanup:live-test-residue` | Report owned live-test residue; dry-run unless `--apply` is supplied explicitly. |

### Live CEP validation

Build the debug bundle before using the live runners:

```bash
npm run build:dev
npm run cdp:self-test
npm run cdp:inspect -- --output=evidence/local/inspect
npm run cdp:settings -- --output=evidence/local/settings-smoke
npm run cdp:persistence -- --output=evidence/local/persistence-smoke
npm run cdp:palette-management
npm run cdp:collect -- --output=evidence/local/host-smoke
npm run cdp:apply -- --output=evidence/local/apply-smoke
```

These commands require the exact running Main/Settings surfaces. Some commands inspect or mutate live AE state; run host mutation only through the documented approval and cleanup flow. Persistence and palette-management runners must use temporary storage roots rather than the user's real palette.

The formal native-gradient Track B runner is intentionally separate from static verification:

```bash
node scripts/run-live-ae-tests.mjs
```

It is a parent-owned live AE/CDP gate and must run only against frozen, reviewed bits with explicit approval.

## Verification and packaging

Run the canonical static gate:

```bash
npm run verify:static
```

Build the unsigned alpha artifact separately:

```bash
npm run package:alpha
```

The packager creates:

```text
dist/alpha/Chroma Relay_0.0.1-unsigned.zip
```

It reopens the archive and rejects missing manifest resources or icons, debug endpoints, source maps, unresolved runtime assets, and unexpected files. Package provenance, inventory, worktree state, and SHA-256 are written to `dist/alpha/report.json`.

Generated `dist/` output is not durable source evidence and should not be committed.

## Data and identity contract

User data is stored under the CEP user-data directory named `Chroma Relay/`.

| Document | Current schema | Writer |
|---|---:|---|
| `palette.json` | 3 | Main only |
| `settings.json` | 4 | Settings only |
| `.chroma-relay.json` transfer | 2 | Settings import/export flow |

Main owns all palette persistence and AE host calls. Settings reads palette state and sends revisioned mutation commands to Main; it owns only `settings.json` plus explicitly confirmed external palette exports.

Palette writes are serialized and verified, recover interrupted replacement from owned temporary/backup files, and preserve malformed primary data rather than overwriting it. Finite RGBA values are stored exactly, including HDR and negative channels; CSS previews never become canonical data.

The product has one canonical identity:

- extension ID: `com.zimoby.chroma-relay`
- Main panel: `com.zimoby.chroma-relay.main`
- Settings panel: `com.zimoby.chroma-relay.settings`
- storage directory: `Chroma Relay`
- portable format marker: `chroma-relay`

## Architecture

```text
src/js/main/        Main palette UI, collection/application orchestration, palette writer
src/js/settings/    Settings UI, settings writer, revisioned palette commands
src/js/shared/      Pure domains, storage, transfer, event, and runtime contracts
src/jsx/aeft/       After Effects ExtendScript host operations
src/assets/         Product icon and native-gradient FFX templates
scripts/            Build, packaging, compatibility, CDP, and live-host runners
tests/              Domain, host, native-gradient, runner, and release contracts
```

The native-gradient path uses `@zimoby/ae-native-gradient`, pinned to an exact Git commit. Toolkit package ownership remains independent from the product runtime identity.

## Project status

The source is an internal 0.0.1 alpha with static verification, bounded live macOS evidence, and Windows AE 2024 native-gradient proof. Remaining public-release gates include:

- live Windows AE 22, 23, 25, and 26 native-gradient validation;
- full-restart persistence proof;
- fresh-panel confirmation of the declared 128 px Main minimum width;
- final signing, distribution, and release-policy decisions.

Current identities and schemas live in [`src/shared/product-contract.json`](src/shared/product-contract.json). Do not infer release readiness from generated artifacts.

## Contributing

Keep changes narrow and preserve the runtime ownership boundaries. Run `npm run verify:static` and `npm run package:alpha` before proposing a distributable candidate. Live mutation tests must use exact panel identities, temporary data roots, explicit cleanup ownership, and preserved failure evidence.

## License and attribution

See [`LICENSE`](LICENSE). The repository retains the MIT license and Hyper Brew LLC attribution inherited from the Bolt CEP scaffold.
