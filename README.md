<p align="center">
  <img src="src/assets/chroma-relay-icon.svg" width="72" height="72" alt="Chroma Relay icon">
</p>

<h1 align="center">Chroma Relay</h1>

<p align="center">A compact After Effects palette for exact colors and native gradients.</p>

<p align="center"><strong>v0.0.1 · After Effects 2022+</strong></p>

## Capabilities

- **Default palette:** five balanced brand colors ordered coral, amber, leaf, sky, and violet.
- **Collect:** exact RGBA values, supported group/layer properties, native gradient stops or reusable slots, and up to five colors from a selected JPEG or PNG.
- **Apply:** click stored colors or gradients to update exactly resolved writable targets in one balanced Undo group.
- **Smart Apply:** when a direct scope has no target, search only the nearest matching parent group—never the whole layer.
- **Organize:** create and switch palettes, drag to reorder, remove entries, and import/export portable palettes.
- **Edit:** use Hex, RGB, CMYK, and alpha while preserving exact HDR and out-of-range values.

Collection is read-only, deterministic across multiple selected layers, and skips disabled layers/groups by default. A document supports 32 palettes with 64 entries each.

Collecting an exact native gradient requires a clean saved project and stable descriptor identity. Applying a stored gradient fails closed on ambiguity, but supports dirty or unsaved projects when targets are static, unlocked, and exactly resolvable.

## Requirements

- After Effects 2022 / AEFT 22.0 or later
- CEP 9 or later with Chrome 74-compatible output
- Node.js 22.x and npm 10.x for development
- Local After Effects for runtime testing
- GitHub access to the private, immutable `@zimoby/ae-native-gradient` dependency

Native gradients are enabled on macOS and Windows for AE 22–26. Live Windows evidence currently covers AE 2024 only; static routing does not prove the other versions.

## Setup

Authenticate Git before installing the private dependency. Never store access tokens in the repository or tracked npm configuration.

```bash
npm ci
npm run build
npm run symlink
```

The link targets:

```text
~/Library/Application Support/Adobe/CEP/extensions/com.zimoby.chroma-relay
```

Restart or refresh After Effects, then open **Window → Extensions → Chroma Relay**. Use `npm run delsymlink` to remove the link.

## Commands

| Command | Purpose |
|---|---|
| `npm run build` | Clean production build through Bolt/Vite. |
| `npm run build:dev` / `npm run watch` | Debug build or watch mode. |
| `npm run verify:static` | Canonical build, tests, contracts, and CEP scan. |
| `npm run zxp` | Build the signed ZXP through Bolt CEP. |
| `npm run zip` | Build Bolt's signed ZXP meta-package ZIP. |

Development loads `dist/cep` through the Bolt symlink. Generated `dist/` output is not durable evidence and must not be committed.

## Live validation

Build the guarded debug bundle before bounded CDP runners:

```bash
npm run build:dev
npm run cdp:self-test
```

Additional inspection and mutation runners are listed in `package.json`. They require the exact Main/Settings surfaces; mutation needs explicit approval and cleanup, while persistence tests must use temporary storage rather than user data.

Formal native-gradient Track B is separate from static verification:

```bash
npm run cdp:native-gradient:prepare
npm run cdp:native-gradient:apply
```

Preparation runs the normal Bolt build and binds its bytes to provenance. Run Track B only against frozen, reviewed bits with explicit approval.

## Identity and data

| Contract | Value |
|---|---|
| Extension | `com.zimoby.chroma-relay` |
| Main / Settings | `com.zimoby.chroma-relay.main` / `com.zimoby.chroma-relay.settings` |
| Storage | `Chroma Relay/` |
| Portable format | `chroma-relay` / `.chroma-relay.json` |

| Document | Schema | Writer |
|---|---:|---|
| `palette.json` | 3 | Main |
| `settings.json` | 5 | Settings |
| Portable palette | 2 | Settings import/export |

Main owns palette persistence and AE calls. Settings owns settings and sends revisioned palette commands to Main. Writes are serialized, verified, recovery-aware, and preserve malformed primary data instead of overwriting it.

## Status

Static verification, bounded macOS evidence, and Windows AE 2024 native-gradient proof exist. Remaining validation work covers Windows AE 22, 23, 25, and 26, restart persistence, the 128 px minimum width, and final signing/distribution.

Canonical identities and schemas live in [`src/shared/product-contract.json`](src/shared/product-contract.json). Do not infer release readiness from generated artifacts.

## License

See [`LICENSE`](LICENSE). MIT license with Hyper Brew LLC attribution inherited from Bolt CEP.
