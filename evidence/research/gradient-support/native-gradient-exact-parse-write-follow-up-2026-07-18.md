# Native AE gradient exact parse/write follow-up

Date: 2026-07-18
Scope: Chroma Relay support for native Shape Gradient Fill/Stroke and Layer Style gradients
Status: source-backed mechanism found; offline proof completed; live scratch-project preset application still gated

## Corrected verdict

The earlier conclusion that native Shape/Layer Style stop data was not exactly recoverable was too broad.

ExtendScript cannot read or set these `NO_VALUE` properties directly, but production open-source tools bypass that API:

1. **Exact read:** save/read an `.aep` snapshot and parse the `GCky` `<prop.map>` payload.
2. **Exact live write for Shape gradients:** generate a temporary binary `.ffx` preset containing a patched `GCky` payload and call `layer.applyPreset()`.
3. **Exact saved-project write:** modify the `GCky` payload in a copied `.aep`, as implemented by `py-aep`.
4. **Exact dirty/unsaved read with a native companion:** use `AEGP_SaveProjectToPath` to make a temporary `.aep` snapshot without relying on ExtendScript's inaccessible property value, then parse it.

Therefore exact static Shape Gradient Fill and Shape Gradient Stroke support is feasible.

## Terminology clarification

### Shape Layer Gradient Stroke

`ADBE Vector Graphic - G-Stroke` with child `ADBE Vector Grad Colors` is supported by the same read/write mechanisms as Shape Gradient Fill.

### Layer Styles > Stroke

Adobe's Layer Styles match-name reference exposes only:

- `frameFX/enabled`
- `frameFX/mode2`
- `frameFX/color`
- `frameFX/size`
- `frameFX/opacity`
- `frameFX/style`

There is no documented `frameFX/gradient` property. The local production `.ffx` corpus likewise contained `frameFX/color`, not `frameFX/gradient`. After Effects' Layer Style Stroke appears solid-only.

If “layer stroke” means Shape Layer Gradient Stroke, it is solved by the Bodymovin/AEUX techniques below.

Layer Style Gradient Overlay and Glow gradients are separate properties and do contain exact `GCky` data.

## 1. Bodymovin's exact Shape Gradient parser

Bodymovin does not read `ADBE Vector Grad Colors.value`.

Its Shape Gradient Fill and Stroke reporters call `bm_ProjectHelper.getGradientData(...)`. The project helper:

1. opens the saved `.aep` as a binary/text stream;
2. locates the composition and layer structures;
3. navigates the Shape group path;
4. finds `ADBE Vector Grad Colors`;
5. finds `prop.map`/`GCky` data;
6. parses color and opacity stop arrays;
7. supplies synthetic values to Bodymovin's normal keyframe serializer.

It supports static and keyframed Shape gradients because it collects multiple `<prop.map>` payloads when the property is animated.

Important limitation: the pure CEP/ExtendScript version reads the saved file. Unsaved or dirty changes are stale unless the project is saved first.

Primary sources, pinned to commit `a400a2551d7564691400b1ceef43fe9bab16900a`:

- Shape Gradient Fill reporter:
  https://github.com/bodymovin/bodymovin-extension/blob/a400a2551d7564691400b1ceef43fe9bab16900a/bundle/jsx/reports/layers/shapes/shapeGradientFillReport.jsx
- Shape Gradient Stroke reporter:
  https://github.com/bodymovin/bodymovin-extension/blob/a400a2551d7564691400b1ceef43fe9bab16900a/bundle/jsx/reports/layers/shapes/shapeGradientStrokeReport.jsx
- saved-project parser:
  https://github.com/bodymovin/bodymovin-extension/blob/a400a2551d7564691400b1ceef43fe9bab16900a/bundle/jsx/utils/ProjectParser.jsx
- shape helper integration:
  https://github.com/bodymovin/bodymovin-extension/blob/a400a2551d7564691400b1ceef43fe9bab16900a/bundle/jsx/utils/shapeHelper.jsx

License: MIT.

## 2. AEUX's exact Shape Gradient writer

AEUX solves the write side with dynamic animation presets.

In `Ae/AEUX/src/host/AEFT/host.ts`:

- `applyGradientFfx()` selects the target Gradient Fill/Stroke property;
- chooses an embedded binary `.ffx` template by stop count;
- replaces placeholders such as:
  - `points[n].rampPoint`
  - `points[n].midPoint`
  - `points[n].color[0..2]`
  - `points[n].opacity`
- writes a temporary binary `.ffx`;
- calls `layer.applyPreset(ffxFile)`;
- deletes the temporary preset.

AEUX ships templates for 2–8 stops and applies this path to both:

- `ADBE Vector Graphic - G-Fill`
- `ADBE Vector Graphic - G-Stroke`

Primary source, pinned to commit `573d07d63b13059c6ebeb02561c89b39bb829180`:

https://github.com/google/AEUX/blob/573d07d63b13059c6ebeb02561c89b39bb829180/Ae/AEUX/src/host/AEFT/host.ts

Relevant implementation is around `applyGradientFfx`, the `presetFiles.template_grad2` through `template_grad8` payloads, and `createFile`.

License: Apache-2.0.

### AEUX importer contrast

Bodymovin's own Lottie importer does not solve the write side. It explicitly warns:

> Gradient data can't be imported. You will need to fill it manually.

AEUX is the relevant importer because it uses generated `.ffx` presets rather than direct `.setValue()`.

## 3. The `GCky` payload

Native gradients are stored as UTF-8 XML embedded inside an AE RIFX chunk:

- chunk identifier: `GCky`
- root: `<prop.map version='4'>`
- `Gradient Color Data`
- `Color Stops`
- `Alpha Stops`
- `Stops List`
- `Stops Size`
- `Gradient Colors` version string

Each color stop preserves:

- offset;
- midpoint;
- RGB;
- an additional stored component used by AE's serialized structure.

Each alpha stop preserves:

- offset;
- midpoint;
- alpha.

The color and alpha stop lists are independent.

## 4. Layer Style gradients

A local production preset was inspected:

`/Users/REDACTED/Documents/Dev_code/_Extensions_dev/PhysicsSimple/presets/MP_pseudo3Dstyle.ffx`

It is a big-endian RIFX animation preset containing:

- `ADBE Layer Styles`
- `outerGlow/gradient`
- `innerGlow/gradient`
- `gradientFill/gradient`
- three `GCky` payloads

The payloads were extracted and parsed with `py-aep` successfully.

Recovered values included:

- exact two-stop white-to-black glow gradients;
- Gradient Overlay color-stop positions `0.30280846` and `0.86516351`;
- midpoint `0.5`;
- exact alpha stops.

This demonstrates that Layer Style Gradient Overlay/Glow presets store the same editable gradient XML structure. A minimal property-scoped Layer Style preset should be captured before product implementation so applying it does not overwrite unrelated Layer Styles.

### libpag exact Layer Style read

libpag's native AE exporter parses saved-project `GCky` data for:

- `gradientFill/gradient`;
- `outerGlow/gradient`.

Its current Stroke exporter reads only `frameFX/color`, consistent with AE's solid-only Layer Style Stroke property set.

Sources, pinned to commit `4a8fb4f97f9578b23a0496640675bcfa17d5ff59`:

- Layer Style extraction:
  https://github.com/Tencent/libpag/blob/4a8fb4f97f9578b23a0496640675bcfa17d5ff59/exporter/src/export/data/LayerStyle.cpp
- gradient stream handling:
  https://github.com/Tencent/libpag/blob/4a8fb4f97f9578b23a0496640675bcfa17d5ff59/exporter/src/export/stream/StreamValue.cpp
- project snapshot implementation:
  https://github.com/Tencent/libpag/blob/4a8fb4f97f9578b23a0496640675bcfa17d5ff59/exporter/src/utils/AEHelper.cpp#L195-L280
- project-byte gradient lookup:
  https://github.com/Tencent/libpag/blob/4a8fb4f97f9578b23a0496640675bcfa17d5ff59/exporter/src/utils/PAGExportSession.cpp

libpag's repository license is a modified Apache-style license and must be reviewed before copying implementation code. The architecture can be independently reimplemented.

## 5. Exact unsaved-project read

libpag handles dirty, unsaved, and `.aepx` projects by:

1. querying `AEGP_ProjectIsDirty`;
2. calling `AEGP_SaveProjectToPath` with a temporary `.aep` path;
3. waiting/retrying for the asynchronous file write;
4. reading the snapshot bytes;
5. parsing gradient data;
6. deleting the temporary file.

The AE SDK exposes both `AEGP_SaveProjectToPath` and `AEGP_SaveProjectAs` as separate calls. This strongly indicates `SaveProjectToPath` is the save-copy route used by libpag rather than a project-path-changing Save As operation.

Before shipping a native helper, a live fixture must still prove that these remain unchanged across `AEGP_SaveProjectToPath` in AE 26.3:

- active project path;
- dirty flag;
- active item;
- selected layers/properties;
- Undo stack.

Do not substitute `app.project.save(tempFile)` in ExtendScript without proof; that call can change the active project path/workflow.

## 6. `py-aep` saved-project read/write

`py-aep` v0.13.0 supports gradients that ExtendScript cannot access.

It can:

- parse `.aep` RIFX files;
- return a `Gradient` model from `GCky`;
- add/remove/reorder color and alpha stops;
- serialize arbitrary stop counts;
- save to a new `.aep`;
- preserve keyframed gradient structures.

Sources, pinned to commit `d52678605581f3290a891ec3195a34fd39ee802e`:

- README feature statement:
  https://github.com/forticheprod/py-aep/blob/d52678605581f3290a891ec3195a34fd39ee802e/readme.md
- gradient model:
  https://github.com/forticheprod/py-aep/blob/d52678605581f3290a891ec3195a34fd39ee802e/src/py_aep/models/properties/gradient.py
- gradient parser:
  https://github.com/forticheprod/py-aep/blob/d52678605581f3290a891ec3195a34fd39ee802e/src/py_aep/parsers/gradient.py
- round-trip tests:
  https://github.com/forticheprod/py-aep/blob/d52678605581f3290a891ec3195a34fd39ee802e/tests/roundtrip/test_gradient.py
- isolated parser/serializer tests:
  https://github.com/forticheprod/py-aep/blob/d52678605581f3290a891ec3195a34fd39ee802e/tests/unit/test_gradient.py

License: MIT.

### Local proof

The following read-only/scratch validations completed:

1. `py-aep` gradient parser/serializer tests:
   - result: `8 passed in 0.02s`.
2. Parsed all three real Layer Style `GCky` payloads from `MP_pseudo3Dstyle.ffx`.
3. Parsed a real local AEP:
   - `/Users/REDACTED/Documents/Dev_code/Original-motion-school-scripts/Super Morphings/Super Morphings.aep`
   - found one exact Shape Gradient Fill;
   - recovered RGB, offsets, midpoint, and alpha.
4. Modified only a scratch copy:
   - `/tmp/super-morphings-gradient-patched.aep`
   - changed the gradient to three RGB stops with non-default midpoints;
   - saved and reparsed successfully;
   - expected float32 quantization: `0.4` became `0.40000001`.
5. Opened the patched copy with AE 26.3 `aerender`:
   - AE accepted and converted the AE 17.1.1 Windows project;
   - exit code `0`;
   - original file remained unchanged.

## 7. Reuse of local AE binary tooling

The local automation repository already provides much of the binary foundation:

`/Users/REDACTED/Documents/Dev_code/AutoTools/ae-agent-scripts`

### Reusable FFX pieces

`pseudo-effect-tests/ffx-generate-from-spec.js` contains a working big-endian
RIFX parser/serializer. It recomputes chunk, `LIST`, and root sizes; preserves
opaque leaf payloads; and handles RIFF padding. Its node-only prefix, popup, and
expansion tests currently pass.

This parser/serializer should be extracted into a neutral library. The current
CLI is coupled to pseudo-effect `tdgp`/`parT` metadata and calls `main()`
unconditionally. `ffx-patch.js` should not be reused for gradients because it
performs equal-length global replacements.

For a gradient preset, treat `GCky` as an opaque RIFF leaf whose payload contains
an inner `Utf8` chunk. Replace the complete validated `GCky` payload and let the
neutral serializer update all affected sizes and padding.

### Reusable AEP pieces

`benchmark/level-17-special-folder/` provides:

- `l17-aep-structure-map.js`: recursive RIFX mapping and JSON reports;
- `l17-aep-anchored-patcher.js`: strict context matching, payload hashes,
  explain mode, and fail-closed ambiguity handling;
- `l17-aep-layer-duplicate.js`: proper RIFF tree walking and ancestor-size
  updates for inserted bytes.

The current anchored patcher only supports equal-length payload replacement, so
it is not directly sufficient for variable-size `GCky` XML. The layer duplicate
tool's ancestor-size mechanics are reusable, while its layer metadata assumptions
remain fixture-specific.

The checked-in Level 17 example spec was stale against its fixture and correctly
failed strict explain. Rebuilding the spec from the known source/target pair in
`/tmp` restored a successful one-candidate explain. This confirms both the value
of its fail-closed contract and the need for generated fixture specs in tests.

`AEBenchmarkLauncher/scripts/prepare-versioned-aep.js` only patches known header
signature offsets for controlled benchmark projects. It is not a general AEP
version converter and should remain outside the gradient path.

### Recommended local module split

1. `riff-rifx`: neutral parser, walker, replacement/insertion, serialization,
   padding, and ancestor-size handling.
2. `gcky-gradient`: validated XML model for independent color and alpha stops.
3. `ffx-gradient`: minimal Fill/Stroke template patcher plus machine-readable
   explain/write reports.
4. `aep-gradient`: read-only lookup first; copied-file mutation only behind the
   Level 17 explain/write/AE-validation contract.

Use Bodymovin and `py-aep` as independent test oracles. For Chroma Relay,
prefer generated FFX for live application and use AEP parsing primarily for exact
collection and readback.

## 8. Recommended Chroma Relay architecture

### MVP without a native companion

Exact static Shape Gradient Fill/Stroke support can ship with:

#### Collect

1. Enumerate selected `ADBE Vector Grad Colors` properties in ExtendScript.
2. Build a stable target descriptor:
   - comp item identity/id;
   - layer identity/index;
   - match-name and property-index path from the layer root;
   - Fill versus Stroke parent match name.
3. If project is unsaved or dirty, show a clear `Save to collect exact gradients` gate.
4. Parse the saved `.aep` in CEP's Node process.
5. Resolve each target by identity/index path, not display names alone.
6. Return color and alpha stops plus type/geometry from ordinary scriptable sibling properties.

Bodymovin's name-based navigation should not be copied unchanged because duplicate names are valid. Chroma Relay should map by IDs/index paths where the parsed file format permits it.

#### Apply

1. Preflight a static Shape Gradient Fill/Stroke target.
2. Reject keyed, expression-controlled, locked, or unresolved targets for the first release.
3. Generate a temporary AEUX-style `.ffx` for 2–8 stops.
4. Snapshot and later restore all selection state.
5. Select only the target gradient property and containing layer.
6. Apply the preset inside one Undo group.
7. Create/read a temporary saved snapshot and compare all stops.
8. Delete the temporary `.ffx`.
9. Verify restoration through a separate Undo invocation during tests.

### Robust version with native AEGP companion

A thin AEGP helper is the best long-term exact-read architecture:

1. use `AEGP_SaveProjectToPath` for a temporary snapshot when dirty/unsaved;
2. return the snapshot path or parsed gradient JSON to CEP;
3. reuse a small independently implemented `GCky` parser;
4. retain CEP/ExtendScript for target enumeration and `.ffx` application.

This avoids requiring users to save before collection and avoids bundling Python.

### Saved-file workflow with `py-aep`

`py-aep` is excellent for:

- migration tools;
- batch conversion;
- tests and fixtures;
- validating CEP-generated `GCky` data;
- arbitrary stop counts and keyframed gradient files.

It is not by itself a good live-panel application path because modifying a copied `.aep` does not update the currently open project object.

## 9. Remaining live proof gate

Do not test the writer in the currently open unsaved 30-item project.

Use a clean scratch AE project containing:

1. Shape Gradient Fill with three color stops, separate alpha stops, and non-0.5 midpoints.
2. Shape Gradient Stroke with a different three-stop payload.
3. Optional Layer Style Gradient Overlay fixture.

For each target:

1. save baseline snapshot;
2. parse baseline exact values;
3. generate/apply temporary `.ffx`;
4. save/read a second snapshot;
5. compare all color and alpha stops, midpoint, geometry, and sibling settings;
6. verify unrelated properties and selection are unchanged;
7. invoke Undo separately;
8. save/read a third snapshot and prove exact restoration.

This is the only missing empirical gate before product implementation.

## Final answer

Yes: the converters remembered by the user solved native Shape Gradient parsing by reading the serialized `.aep` `GCky` payload, not through ExtendScript. AEUX solved writing with generated `.ffx` presets. The two techniques can be combined for exact Chroma Relay Shape Gradient Fill and Shape Gradient Stroke support.
