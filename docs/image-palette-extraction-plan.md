# Image Palette Extraction — Library Decision and Feature Plan

**Decision date:** 2026-07-17

**Status:** Implemented and live-validated on macOS in After Effects 26.3; remaining public cross-platform gates are listed below

**Primary library:** [`image-q@4.0.0`](https://www.npmjs.com/package/image-q), pinned exactly

**License:** MIT

## Feature contract

When the user selects one supported still image and presses Plus, Chroma Relay extracts up to five useful colors and appends them to the current palette in one persisted palette update.

The extraction method must be selectable because there is no single objectively correct image palette. The initial product modes should be curated presets over real quantizer and color-distance choices, not cosmetic aliases for one algorithm.

## Decision

Use `image-q@4.0.0` as the extraction engine.

It is the only evaluated library that ships multiple genuinely different palette quantizers and multiple selectable color-distance formulas in one browser-compatible TypeScript package:

- Palette quantizers: `wuquant`, `rgbquant`, `neuquant`, `neuquant-float`
- Color distances: CIEDE2000, two CIE94 variants, Euclidean variants, Manhattan variants, CMetric, and PNGQuant distance
- Exact requested palette size through `colors: 5`
- Inputs suitable for CEP: `ImageData`, `HTMLCanvasElement`, `HTMLImageElement`, and typed RGBA arrays
- Sync and async APIs
- Alpha-channel support
- No native image-processing runtime

Pin `4.0.0` rather than using a version range. The package is mature but inactive: npm 4.0.0 was published in January 2022, the repository was last pushed in October 2023, and the repository is not archived. Chroma Relay therefore owns regression coverage for the exact pinned behavior.

## Frozen extraction presets

The labels and mappings below were frozen after the broader nine-fixture benchmark. They are extension-owned product presets over three real quantizers, with guarded WuQuant fallbacks for known library edges.

| Product mode | Primary mapping | Guarded fallback | Intended result |
|---|---|---|---|
| Balanced | `wuquant` + `ciede2000` | none | Broad coverage of major and secondary color families; default |
| Tonal | `neuquant-float` + `ciede2000` | Balanced if transparent padding leaves fewer than five colors | Softer grouping of nearby shades |
| Contrast | `rgbquant` + `euclidean-bt709-noalpha` | `wuquant` + `euclidean-bt709-noalpha` if RGBQuant fails or under-fills | Faster, more separated palette |

All modes bypass quantization when the visible source has five or fewer unique colors, preserving exact source colors. Fully transparent pixels and transparent-black quantizer padding are removed before output. Fallback colors are appended only when the primary quantizer fails or returns fewer than the requested five.

Balanced remains the default, but Settings describes Tonal and Contrast without implying one universally correct palette.

## Candidate comparison

Current package and repository facts were checked on 2026-07-17.

| Candidate | Current version | Actual extraction choices | Vite Chrome 58 bundle spike | Maintenance | Decision |
|---|---:|---|---:|---|---|
| `image-q` | 4.0.0 | 4 quantizers × 11 distance formulas | 68.19 kB minified / 15.59 kB gzip | Mature, inactive, not archived | **Use** |
| `colorthief` | 3.4.0 | Built-in MMCQ; RGB/OKLCH spaces; raw palette and semantic swatches; custom quantizer interface | 26.02 kB / 8.52 kB gzip | Published July 2026, active | Best fallback if semantic Vibrant/Muted output becomes more important than several built-in algorithms |
| `node-vibrant` | 4.0.4 | One registered MMCQ quantizer plus semantic Vibrant/Muted generation | 23.64 kB / 6.73 kB gzip | Published January 2026, active | Reject for this requirement: useful semantic generation, but not several built-in quantizers |
| `extract-colors` | 4.2.1 | One extraction approach with distance/HSL merge tuning | 13.77 kB / 3.98 kB gzip | Published August 2025 | Reject for this requirement: knobs are not multiple algorithms and output count is not the same fixed-palette contract |

Sources:

- `image-q`: <https://github.com/ibezkrovnyi/image-quantization/tree/main/packages/image-q>
- Color Thief: <https://github.com/lokesh/color-thief>
- node-vibrant: <https://github.com/Vibrant-Colors/node-vibrant>
- extract-colors: <https://github.com/Namide/extract-colors>

## Executed spike evidence

The spike used Vite 6.3.5 with `target: "chrome58"`, which is more conservative than the project's AE 22 / Chrome 74-class panel floor.

Results:

1. All four `image-q` quantizers built successfully through Vite.
2. A real browser decoded a JPEG through `<img>` and canvas, passed `ImageData` to `image-q`, and every quantizer returned exactly five RGBA colors.
3. The browser console contained no JavaScript errors.
4. Three separate 320×239/240 photo crops were tested: ocean, rocky landscape, and autumn foliage.
5. Fast BT.709 runs on those crops:
   - NeuQuant/NeuQuantFloat: approximately 16–24 ms
   - RGBQuant: approximately 42–56 ms
   - WuQuant: approximately 288–367 ms
6. CIEDE2000 runs:
   - NeuQuant/NeuQuantFloat: approximately 369–451 ms
   - WuQuant: approximately 594–857 ms
   - RGBQuant: approximately 924–2,037 ms
7. Visual comparison showed that WuQuant and NeuQuantFloat produce distinct useful modes. RGBQuant over-selected extremes on these fixtures.

These are local Mac browser-spike timings, not a public performance claim. Live CEP timing must be measured separately with real waits.

## Broader fixture and live CEP evidence

The production preset decision used nine deterministic 256×256 fixtures: skin tones, dark/neon, low saturation, vivid spectrum, exact four-color artwork, warm/cool gradient, partial transparency, exact two-color artwork, and a high-key scene with a small accent.

The raw provisional NeuQuant modes were rejected because they emitted transparent-black padding on opaque inputs and lost an exact navy region in the four-color fixture. The guarded mappings above removed those defects. The final contact sheet and machine-readable outputs are stored at:

- `evidence/local/image-extraction/preset-benchmark.png`
- `evidence/local/image-extraction/preset-benchmark.json`

Live AE 26.3 smoke evidence on macOS covers PNG and JPEG through all three presets, using one real Plus click per case:

| Format | Balanced | Tonal | Contrast |
|---|---:|---:|---:|
| PNG, 11,520 visible pixels | 563 ms | 191 ms | 492 ms with guarded fallback |
| JPEG, 12,288 pixels | 508 ms | 188 ms | 119 ms |

Every case returned five nontransparent colors, made one host call, made one palette write, preserved the selected file identity, and emitted no console/runtime errors. The live report and screenshot are stored at:

- `evidence/local/image-extraction/live-smoke/report.json`
- `evidence/local/image-extraction/live-smoke/main-image-extracted.png`

An additional six-case AE 26.3 selection/error smoke proved the unified Plus dispatch:

| Case | Result | Palette writes |
|---|---|---:|
| Selected composition-layer PNG source | Added five colors | 1 |
| Same PNG selected as Project item and layer source | Deduplicated by file identity; added five colors | 1 |
| Two selected images | `Select one image at a time` | 0 |
| Selected AE colors plus one image | `Choose selected colors or one image, not both` | 0 |
| Valid unsupported GIF | `GIF is not supported; choose JPEG or PNG` | 0 |
| Corrupt file-backed PNG | `Could not extract colors from the selected image` | 0 |

The run emitted no console/runtime errors and removed all six owned AE fixtures. Evidence is stored at:

- `evidence/local/image-extraction/selection-smoke/report.json`
- `evidence/local/image-extraction/selection-smoke/main-selection-gates.png`
- `evidence/local/image-extraction/selection-smoke/investigation.md`

This live pass found and fixed two host-runtime defects: selected still layers were being recursively interpreted as synthetic layer colors, and the multiple-image result used object spread that Babel lowered to unavailable ExtendScript `Object.keys`. The unified resolver now skips whole-layer color recursion only for still-image layers while preserving explicitly selected color properties, and the generated host compatibility check rejects `Object.keys`.

The Settings CDP smoke also proved schema-v3 persistence and one-way Main synchronization with `extractionPreset: "tonal"` in `evidence/i05/settings-smoke/report.json`.

## Integration shape

### 1. Dependency and preset contract

Install with:

```bash
npm install --save-exact image-q@4.0.0
```

Define an extension-owned type rather than persisting library strings throughout the UI:

```text
ExtractionPreset = "balanced" | "tonal" | "contrast"
```

Keep one mapping from each product preset to the pinned `image-q` options. This makes a future library replacement or preset retuning a migration-free internal change.

### 2. Persist the user's choice

Promote the production Settings schema from v2 to v3 and add `extractionPreset` with default `"balanced"`.

Migration:

```text
v2 -> v3: preserve layoutMode, swatchSize, and includeDisabledColors; add extractionPreset: "balanced"
```

Settings remains the only settings writer. Main receives the existing one-way revisioned settings event and uses the persisted preset on Plus.

For the disposable demo, if image extraction is promoted into demo scope, extend its simpler settings document to:

```json
{
  "swatchSize": 32,
  "extractionPreset": "balanced"
}
```

### 3. Resolve one selected still-image source in AE

Add a small read-only ExtendScript host function returning a typed result such as:

```text
resolveSelectedImage() -> {
  status: "ok" | "no-project" | "no-selection" | "multiple-images" | "unsupported-source",
  path?: string
}
```

Initial selection sources:

- one selected `FootageItem` in the Project panel whose `file` exists; or
- one selected AV layer in the active composition whose `source` is a file-backed still `FootageItem`.

Do not infer identity from layer/source names. Use the selected object and its source/file identity. Reject generated solids, missing footage, sequences, video, and unsupported files explicitly in the first implementation.

### 4. Preserve existing Plus behavior without ambiguity

Plus currently collects selected AE COLOR properties. Use this dispatch rule:

1. If supported selected COLOR properties exist and no supported image is selected, keep the existing color-collection path.
2. If exactly one supported image is selected and no supported COLOR property is selected, run image extraction.
3. If both are present, do not guess; show a short ambiguous-selection status asking the user to select either colors or one image.
4. If neither is present, preserve the current no-supported-color status but expand its copy to mention a supported image.

### 5. Decode and bound pixels in CEP

Keep decoding in the CEP renderer, not ExtendScript and not a native Node image library:

1. Read the selected local file through the CEP/Node-capable panel path.
2. Decode into an `HTMLImageElement` or browser-supported bitmap.
3. Draw to an offscreen canvas while preserving aspect ratio.
4. Bound the working image to approximately 65,536 pixels for initial testing; do not upscale smaller images.
5. Obtain `ImageData`, pack visible pixels, and pass the bounded RGBA array to `PointContainer.fromUint8Array()`.
6. Ignore fully transparent pixels. Do not silently invent colors to reach five when the source has fewer than five useful unique colors.
7. Revoke temporary object URLs and release canvas/image references in `finally`.

Initial file support should be limited to formats proven by the CEP decoder, beginning with JPEG and PNG. PSD, TIFF, EXR, RAW, image sequences, and video require separate decode/render decisions.

### 6. Extract, normalize, deduplicate, and persist once

Call `buildPaletteSync` with the guarded preset mapping:

```text
colors: 5
paletteQuantization: preset.quantizer
colorDistanceFormula: preset.distance
```

Then:

1. Convert library 0–255 RGBA output to the extension's existing normalized RGBA representation.
2. Deduplicate against the existing palette with the existing exact/epsilon policy.
3. Preserve all existing colors and append only new extracted colors.
4. Perform one complete palette persistence update for the whole extracted set.
5. Update React state only after persistence succeeds.
6. On decode, extraction, or save failure, preserve the existing palette unchanged and show one actionable status.
7. Disable Plus during decode/extraction/save to prevent overlapping runs.

### 7. Validation gates

Completed:

- [x] Pinned `image-q@4.0.0` exactly and verified its MIT package license.
- [x] Unit-tested preset mapping, schema migration, channel normalization, transparent-pixel handling, exact fewer-than-five-color preservation, and the real Tonal fallback edge.
- [x] Reviewed a broader visual fixture sheet before freezing labels/default.
- [x] Proved Project-panel JPEG and PNG selection live in AE 26.3 for Balanced, Tonal, and Contrast.
- [x] Measured real bounded CEP runs with real waits.
- [x] Confirmed one Plus click makes one host call and one palette write in all six live cases.
- [x] Confirmed Settings schema v3 persists and synchronizes Tonal to Main with one revision/event.
- [x] Confirmed five swatches and Plus remain visible/aligned with no status overlap in the live narrow dock.
- [x] Proved selected composition-layer still extraction and Project/layer file-identity deduplication live in AE 26.3.
- [x] Proved mixed COLOR + image and multiple-image selections fail closed with zero palette writes.
- [x] Proved corrupt PNG decode failure and valid unsupported GIF rejection preserve the palette with zero writes.
- [x] Re-ran the legacy selected-color collection smoke after recreating its fixture; the updated image-aware no-selection copy passed.
- [x] Passed domain tests, host static contracts, AEFT 22.0/Chrome 74 compatibility, and production build.

Remaining before broader public claims:

- [ ] Live-test a physically missing file source separately; corrupt decode and unsupported still rejection are proven.
- [ ] Prove palette persistence through a full AE restart; one-write storage is proven, restart recovery is not.
- [ ] Validate Windows path decoding and the Windows CEP image decoder before a cross-platform claim.
- [ ] Decide separately whether to promote the feature into the disposable demo.

## Resolved product decisions

1. Expose Balanced, Tonal, and Contrast in Settings; keep Plus compact.
2. Keep extraction fixed at up to five colors initially.
3. Preserve light/dark output rather than adding an unreviewed extreme-color filter.
4. Use Balanced as the default after the nine-fixture review.
