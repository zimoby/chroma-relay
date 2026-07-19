# Chroma Relay gradient support investigation

Date: 2026-07-18
Status: superseded in part; no product implementation started

> **Correction:** The direct ExtendScript result below remains valid, but the
> conclusion that exact native Shape gradients are unsupported is superseded.
> Bodymovin parses their serialized `.aep` `GCky` payload, and AEUX writes them
> with generated `.ffx` presets. See
> `native-gradient-exact-parse-write-follow-up-2026-07-18.md` for source traces,
> local proofs, and the corrected architecture.

## Decision

Implement gradient support, but split the feature into two explicit capability classes:

1. **Exact managed gradients:** Gradient Ramp (`ADBE Ramp`) and 4-Color Gradient (`ADBE 4ColorGradient`). Their child colors and geometry are ordinary scriptable properties. Chroma Relay can capture, persist, preview, and apply these exactly after a live fixture closes the remaining effect-property evidence gap.
2. **Native stop payloads require a bypass:** Shape Gradient Fill/Stroke and Layer Style gradient/glow stop data remain inaccessible through direct ExtendScript `.value`/`.setValue()`, but exact serialized-file parsing and `.ffx` application paths exist. See the correction above.

The recommended first code change is a narrow correctness fix: replace the broad name-based gradient guard with exact leaf/property-type classification. This will expose scriptable Gradient Ramp and 4-Color child `COLOR` properties and stop locale-dependent skipping. It is useful, but it is not yet first-class gradient persistence or application.

Recommended commitment: **AGREE_WITH_CHANGES**.

- Readiness for the classification fix and scriptable effect-gradient work: **8/10**, after a clean live effect fixture.
- Readiness for direct `.value`/`.setValue()` access remains **0/10**. Exact support instead uses saved-project `GCky` parsing plus generated `.ffx` presets; live scratch-project validation is still required.

## Evidence gathered

### Local product architecture

Current gradient handling is a broad early-return heuristic duplicated in:

- `src/jsx/aeft/aeft.ts:52-60`, used before recursion at `src/jsx/aeft/aeft.ts:102-107`
- `src/jsx/aeft/color-apply.ts:27-35`, used before recursion at `src/jsx/aeft/color-apply.ts:47-51`

The heuristic matches `grad` in `matchName` or `gradient` in localized display `name`. It therefore skips whole groups before inspecting child properties.

Consequences:

- English `Gradient Ramp` is skipped because its display name contains `gradient`, even though `ADBE Ramp-0002` and `ADBE Ramp-0004` are ordinary color endpoints.
- `ADBE 4ColorGradient` is skipped in every locale because its match name contains `grad`.
- A user-renamed group/layer containing `gradient` can be skipped wholesale, including ordinary solid-color descendants.
- Behavior can differ by AE UI language because display names are localized.
- Shape gradient geometry children whose match names contain `Grad` can be counted individually as unsupported if traversal reaches them, inflating skipped counts.

Current persistence is solid-only:

- `src/js/shared/palette-domain.ts:7-20` defines `PaletteColor { id, rgba }` and `Palette.colors`.
- `PALETTE_SCHEMA_VERSION` is 2.
- Portable transfer version 1 also stores only color RGBA arrays (`docs/STORAGE.md:32-49`).

True persisted gradients therefore require a schema/API/UI feature, not only a host traversal fix.

### Live AE 26.3 read-only scan

Artifact:

- `evidence/research/gradient-support/ae-26.3-readonly-gradient-scan.json`

The scan traversed an already-open unsaved project without changing selection or values. Before/after selection snapshots are identical.

Observed:

- AE build: `26.3x87`
- 20 Shape `ADBE Vector Grad Colors` properties
  - 20 were `PropertyValueType.NO_VALUE`
  - 0 reads succeeded
  - 20 reads failed
- 34 Layer Style `gradientFill/gradient` properties
  - 34 were `PropertyValueType.NO_VALUE`
  - 0 reads succeeded
  - 34 reads failed
- AE error for both families: `Can not get or set a value from this property ... This property's propertyValueType is PropertyValueType.NO_VALUE.`
- Shape gradient type/start/end/highlight/scale/rotation and Layer Style opacity/smoothness/angle/type/reverse/align/scale/offset are separate readable properties.
- The project contained no Gradient Ramp or 4-Color Gradient effects, so their complete child-property contracts remain a required Stage 0 live fixture.

No scratch fixture was created. The initial `ae_check` output had `project: null`, which means an unsaved project path, not absence of an `app.project` object. A preflight detected the existing 30-item project and returned before any mutation.

### Official and public-source evidence

- Adobe Property API and `PropertyValueType` contract:
  - <https://ae-scripting.docsforadobe.dev/property/property/#propertypropertyvaluetype>
- Adobe Shape Layer match names, including `ADBE Vector Grad Colors`:
  - <https://ae-scripting.docsforadobe.dev/matchnames/layer/shapelayer/>
- Adobe first-party effect match names, including `ADBE Ramp` and `ADBE 4ColorGradient`:
  - <https://ae-scripting.docsforadobe.dev/matchnames/effects/firstparty/>
- `coloramen` works around the Shape Gradient limitation by temporarily saving and reading the project, locating `<prop.map>`, and parsing stop floats. It is read-only extraction; it does not provide safe live write-back:
  - <https://github.com/kyletmartinez/coloramen/blob/master/source/jsx/coloramen.jsx>
- `py-aep` documents gradient colors as information available in the project binary but not in ExtendScript:
  - <https://github.com/forticheprod/py-aep/blob/main/docs/differences.md>
- `libpag` confirms that even a native AEGP exporter obtains gradient stops by reading project file bytes and parsing the `GCky` payload, not by reading a documented gradient stream value. `PAGExportSession::GetGradientColorsFromFileBytes` reads project bytes, finds the matching gradient group/tag, extracts XML text, and parses it:
  - <https://github.com/Tencent/libpag/blob/4a8fb4f97f9578b23a0496640675bcfa17d5ff59/exporter/src/utils/PAGExportSession.cpp#L85-L150>

These sources support exact read-only parsing from saved project bytes, but not safe dynamic write-back to an open project.

### Independent Fable 5 review

Verbatim model review:

- `evidence/research/gradient-support/fable-5-gradient-support-review-2026-07-18.md`

Fable 5 returned `AGREE_WITH_CHANGES`, readiness 8/10 for the narrow effect-gradient stages, and agreed that native stop round-trip is blocked. Its proposed generic ordered `stops` model needs one correction: 4-Color Gradient is four independent point/color pairs, not an ordered 1D stop list.

## Capability matrix

| Family | Exact detect | Exact collect | Exact persist/apply | Geometry | Recommended status |
|---|---:|---:|---:|---:|---|
| Shape Gradient Fill/Stroke | Yes | No: stop payload is `NO_VALUE` | No through ExtendScript | Mostly readable/writable separately | Report unsupported; optional approximate color extraction later |
| Layer Style Gradient Overlay | Yes | No: stop payload is `NO_VALUE` | No through ExtendScript | Partly readable/writable separately | Report unsupported; no exact promise |
| Layer Style Outer/Inner Glow gradient | Yes | No: live scan also shows `NO_VALUE` | No through ExtendScript | Some metadata readable | Report unsupported |
| Gradient Ramp effect | Yes | Expected yes | Expected yes | Expected yes | Stage 0 live proof, then exact managed support |
| 4-Color Gradient effect | Yes | Expected yes | Expected yes | Expected yes | Stage 0 live proof, then exact managed support |
| Rendered/sampled gradient | Visual only | Approximate colors | Apply only by converting to a managed effect | Reconstructed/approximate | Optional, visibly labeled approximate |

`Expected` means supported by public executable examples and AE's ordinary effect-property model, but not yet validated against the exact AE 26.3 fixture required by this repository's live-proof standard.

## Corrected data model

Do not represent every gradient as ordered stops. Use a discriminated family model:

```ts
type PaletteItem =
  | { kind: "color"; id: string; rgba: Rgba }
  | { kind: "gradient"; id: string; gradient: ManagedGradient };

type ManagedGradient = RampGradient | FourColorGradient;

type RampGradient = {
  family: "ramp";
  startColor: Rgba;
  endColor: Rgba;
  startPoint: [number, number];
  endPoint: [number, number];
  rampShape: number;
  scatter: number;
  blendWithOriginal: number;
};

type FourColorPoint = {
  point: [number, number];
  color: Rgba;
};

type FourColorGradient = {
  family: "four-color";
  points: [FourColorPoint, FourColorPoint, FourColorPoint, FourColorPoint];
  blend: number;
  jitter: number;
  opacity: number;
};
```

The exact field list and numeric bounds must be generated from the Stage 0 AE 26.3 property snapshot; the example above is an architecture shape, not a final host contract.

Persistence implications:

- Increment palette schema to v3.
- Migrate each v2 `PaletteColor` to a v3 `{ kind: "color", ... }` item while preserving IDs and RGBA exactly.
- Replace `Palette.colors` with an ordered `Palette.items` union if mixed color/gradient order is a product requirement.
- Keep Main as the only `palette.json` writer and preserve one-command/one-write/revision semantics.
- Introduce portable transfer version 2 for gradient items; continue accepting version 1 color-only imports.
- Define gradient equality over every family field with documented numeric epsilon; do not deduplicate merely by endpoint colors.
- Count one gradient as one palette item, with an explicit maximum item count.

## Host API recommendation

Keep gradient operations separate from solid-color operations:

```ts
collectSelectedGradients(): GradientCollectionResult;
applyGradientToSelectedProperties(gradient: ManagedGradient): GradientApplyResult;
```

Do not overload `collectColorsFromSelectedProperties` or `applyColorToSelectedProperties` with a union payload.

Host rules:

1. Identify families only by exact non-localized match names.
2. Remove group-level display-name gradient rejection.
3. Recurse through groups so scriptable effect children remain reachable.
4. Classify known unreadable gradient leaves exactly (`ADBE Vector Grad Colors`, `gradientFill/gradient`, `outerGlow/gradient`, `innerGlow/gradient`) and generically fail closed on `NO_VALUE`/`CUSTOM_VALUE` leaves.
5. Count each unreadable gradient payload once, not each geometry child.
6. Gradient capture v1 accepts only static effect properties. If any required child is keyed, expression-enabled, unreadable, missing, or out of contract, skip the whole gradient atomically.
7. Gradient apply v1 targets the same effect family only. Preflight every required child before opening one balanced undo group. If any field cannot be written, write nothing.
8. After apply, read back the complete effect snapshot and compare it to the requested gradient. A separate invocation must verify one Undo restores the complete before snapshot.
9. Do not silently convert a selected Shape/Layer-Style gradient into an effect. A later explicit `Apply as new Gradient Ramp effect` action can be offered as a separate user-visible conversion.

## Staged implementation plan

### Stage 0: live effect contract fixture — required before code changes

Run only when a clean scratch project is authorized and no user project is open.

Fixture must include:

- Shape Gradient Fill and Gradient Stroke
- Layer Style Gradient Overlay
- Gradient Ramp effect with unique endpoints, points, shape, scatter, and blend values
- 4-Color Gradient with four unique colors/points and unique secondary settings
- an ordinary solid Fill inside a user-named group containing `gradient`

Capture:

- exact group/child match names
- property value types
- key/expression capability
- before snapshot
- set/readback snapshot
- one separate-invocation Undo snapshot
- selection before/after
- full fixture cleanup

Acceptance:

- Ramp and 4-Color required children are static, readable, writable, and exactly restored by Undo.
- Shape/Layer-Style stop payloads remain classified once as unsupported.
- User-renamed groups do not suppress ordinary color descendants.

### Stage 1: classification correctness fix

- Replace both broad `isGradientProperty` implementations with exact unreadable-leaf classification plus generic `NO_VALUE`/`CUSTOM_VALUE` handling.
- Remove display-name matching.
- Preserve existing solid-color behavior.
- Add domain/host-contract tests for locale independence, renamed groups, one unsupported count per unreadable payload, and effect child traversal.

This stage enables existing solid collection/apply logic to see effect endpoint colors. It does **not** yet apply a whole gradient as one object.

### Stage 2: first-class exact Gradient Ramp

- Add v3 palette item schema and migration.
- Add separate collect/apply host API.
- Add one gradient preview/editor card.
- Apply only to an existing selected `ADBE Ramp` effect group.
- Require atomic preflight, one undo group, full readback, separate Undo proof, and one Main persistence write.

Ramp is the smallest real full-gradient feature because its model is two colors plus ordinary geometry/options.

### Stage 3: first-class exact 4-Color Gradient

- Add the independent four-point/four-color model.
- Do not coerce it into ordered stops.
- Reuse the same atomic host/result/persistence contracts.
- Provide a four-point preview that does not falsely imply a linear stop gradient.

### Stage 4: optional explicit conversion and approximate collection

Possible opt-in actions:

- `Apply as new Gradient Ramp effect` for supported layer targets.
- `Extract approximate colors from rendered result`, using the existing image palette extraction path.

Approximate extraction must be labeled approximate and must not claim stop positions, alpha stops, midpoints, interpolation, or native-gradient fidelity.

### Stage 5: separate research only

A saved-project parser can potentially import native Shape/Layer-Style stop data read-only. It is unsuitable for normal live operation because it requires saved project bytes, misses unsaved changes, is format/version fragile, and has no safe write-back path.

Do not schedule native/C++ work until an isolated SDK spike proves both read and set semantics without project-file rewriting. Current public native evidence still parses project file bytes.

## Rejected shortcuts

- **Parse and rewrite `.aep`:** unsafe for open projects; no production write-back.
- **Generate arbitrary `.ffx`:** undocumented/version-fragile binary format; presets can apply pre-authored gradients but do not provide arbitrary dynamic round-trip.
- **Clipboard/menu automation:** focus-, selection-, locale-, and timing-dependent; no reliable host readback.
- **Pretend sampled colors are stops:** loses positions, opacity stops, midpoints, interpolation, and effects/compositing context.
- **Apply one solid swatch to a gradient group:** collapses endpoint colors and is not gradient application.
- **One generic ordered-stop model for Ramp and 4-Color:** semantically wrong for 4-Color Gradient.
- **Name-based gradient detection:** localized and vulnerable to user renames.

## What the product can honestly promise

After Stages 0–3:

- Exact collect, storage, preview, and apply for supported static Gradient Ramp and 4-Color Gradient effects.
- Exact solid-color behavior remains intact.
- Clear detection and reporting for native gradients whose stop payload AE does not expose.
- Optional approximate visible-color extraction as a separate, clearly labeled action.

It must not promise:

- exact Shape Gradient Fill/Stroke stop collection or application through CEP/ExtendScript
- exact Layer Style gradient/glow stop collection or application
- native alpha-stop, midpoint, interpolation, or keyed-stop editing
- AEP write-back
- exact fidelity from sampled/rendered gradients
- silent cross-family conversion

## Next gate

Do not implement the schema/UI yet. First run Stage 0 in a clean authorized scratch project and save the effect child-property/readback/Undo evidence. If that gate passes, implement Stage 1 narrowly, verify existing color tests, and then plan Gradient Ramp as the first complete gradient entity.
