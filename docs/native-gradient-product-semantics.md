# Native Gradient Product Semantics

> Decision date: 2026-07-18
> Approved by: Denis
> Selected state: `both_serially`
> Implementation order: exact collection first, active-palette application second
> Gradient-slot amendment: 2026-07-19, approved by Denis
> Windows runtime amendment: 2026-07-20, approved by Denis

## Decision

Chroma Relay supports native After Effects Shape Gradient Fill and Stroke through independently reviewed paths:

1. collect native gradient color stops into ordinary color slots;
2. alternatively collect each exact native gradient ramp into one gradient slot;
3. apply ordinary active-palette colors as a newly constructed native gradient;
4. apply an exact stored gradient ramp by clicking its gradient slot.

Layout settings expose **Selected gradients: Color stops / Gradient slot**. `Color stops` remains the migration-safe default. Palette schema v3 stores an optional validated native-gradient payload on an ordered swatch record; portable palette v2 preserves it through export/import while continuing to read portable v1.

An exact gradient slot stores the native ramp: ordered color and alpha stops, offsets, midpoints, RGB/alpha, schema version, and color-stop `extra`. It does not store or overwrite Fill/Stroke geometry such as type, start/end points, highlight settings, or stroke width.

Layer Style gradients, keyframed gradients, expression-controlled gradients, direct AEP writes, and whole Fill/Stroke geometry objects remain out of scope.

## Track A — Collect gradient stops

### User action and location

The existing Main `+` action collects a supported selected native Shape Gradient Fill or Stroke alongside the existing solid-color collection behavior.

### Stored versus derived data

For each color stop, Chroma Relay stores one ordinary RGBA swatch:

- RGB is preserved from the exact saved-AEP gradient payload after float32 normalization;
- alpha is derived at the color stop offset by linear interpolation across the ordered alpha-stop list;
- before the first alpha stop and after the last, the nearest endpoint alpha is used;
- if duplicate alpha offsets make the value at a required color offset non-unique, collection rejects that gradient rather than guessing;
- color-stop order and duplicate color-stop offsets are preserved as palette order;
- original color/alpha offsets, midpoints, stop-list structure, and Fill/Stroke kind are not stored.

Linear alpha derivation is the approved swatch conversion policy; it does not claim to preserve the original gradient's midpoint-shaped opacity curve after the gradient geometry is discarded.

### Supported state

Exact gradient collection requires:

- CEP platform `darwin` or `win32` and an After Effects 22–26 host version;
- a saved, clean project;
- one or more exactly resolved static native Shape Gradient Fill/Stroke targets;
- stable comp, layer, property-index, and match-name identity;
- no keys, expressions, locks, descriptor drift, or ambiguous saved-AEP candidates.

The collector never saves, selects, alerts, opens an Undo group, or mutates the project. It never resolves by display name, nearest offset, or first-candidate fallback.

For a clean saved project, mixed solid-color and supported native-gradient selections collect both in deterministic property traversal order. If an included native gradient cannot be resolved exactly, the action reports the gradient failure and does not silently substitute approximate stops.

### Resulting limitation

A gradient with stops at 0%, 35%, and 100% is collected as three ordered swatches. The 35% offset and all midpoint values are discarded. Reapplying those swatches later uses the Track B construction policy, not the original geometry.

## Track A2 — Store exact gradient slots

When **Selected gradients** is set to **Gradient slot**, the existing Main `+` action stores one exact gradient slot per supported selected native Shape gradient. Selected solids remain ordinary color slots. Mixed solids and gradients retain deterministic traversal order, preserve duplicate gradient ramps, share the 64-slot limit, and commit atomically.

The exact model passes the toolkit's generated-gradient validator and is deep-cloned before persistence. Each supported model has 2–8 ordered color stops and 2–8 ordered alpha stops. Existing palette schema v1/v2 files migrate losslessly to schema v3 ordinary slots.

Main and Settings render a gradient button/preview. The CEP-safe CSS preview samples every unique color/alpha stop position but linearly approximates AE midpoint interpolation. This visual approximation never changes stored or applied data.

Gradient slots support reorder, remove, local persistence, and portable v2 export/import. They do not expose the flat RGBA editor. A compatibility RGBA value is stored only for legacy/debug fallback and is never used for gradient-slot application.

## Track B — Apply active palette as gradient

### User action and location

Main's panel flyout exposes **Apply Active Palette as Gradient** for ordinary color slots. Clicking an ordinary swatch keeps the existing solid-color behavior. Clicking a gradient slot explicitly applies that slot's exact ramp to one selected supported native gradient target.

### Gradient construction

The flyout action requires exactly one explicitly selected static native Shape Gradient Fill or Stroke target and 2–8 ordinary color slots in the active palette. Gradient slots are excluded from this construction path.

It constructs:

- color stops in active-palette order;
- evenly spaced offsets `i / (n - 1)`;
- midpoint `0.5` for every color and alpha stop;
- one alpha stop per palette color using that swatch's stored alpha;
- the existing toolkit default for the native color-stop `extra` field.

Fewer than 2 or more than 8 colors are rejected without padding, truncation, sorting, or deduplication. The action performs no palette disk write.

Gradient-slot application bypasses this lossy construction and sends the validated stored ramp directly to preset generation. Color/alpha stop order, offsets, midpoints, values, and color-stop `extra` are preserved. The property-scoped preset changes only `ADBE Vector Grad Colors`, so destination Fill/Stroke geometry remains intact.

### Target and mutation contract

Application supports only an exactly identified, static, unlocked native Shape Gradient Fill or Stroke in the already-active composition. It rejects keyed, expression-controlled, locked, wrong-kind, wrong-comp, ambiguous, drifted, or unsupported targets before mutation.

One successful action uses one host call and one balanced Undo group, restores layer/property selection in `finally`, and never saves the project, invokes Undo itself, or changes the active item. Validation failures open no Undo group. Unknown-completion failures are not automatically retried.

Errors are returned as concise copyable Main notices rather than alerts. Generated preset failure evidence is preserved according to the product temp-file contract before owned cleanup.

The renderer accepts only CEP platforms `darwin` and `win32`, then resolves the live CEP host version to an explicit template family before reading templates or generating presets: AE 22.0–25.5 use `assets/native-gradient/ae22-6/`, AE 25.6–26.2 use `assets/native-gradient/ae25-6/`, and AE 26.3–26.99 use `assets/native-gradient/ae26-3/`. Other platforms return `unsupported-platform`; host versions outside AE 22–26 return `unsupported-host-version`. Both failures produce no generated files and no host mutation call. CEP reports the product version without AE's `xN` build suffix, while ExtendScript includes it. The host therefore compares the normalized major/minor/patch product versions before preset validation or mutation, rejects `host-version-drift` if they differ, and preserves the exact ExtendScript `app.version` in its result.

If the host call throws or returns `apply-unknown-completion`, both verified token-owned preset roots are atomically moved to token-bound evidence roots and their exact byte lengths and SHA-256 hashes remain in the renderer report. Successful and deterministic rejection paths remove their generated roots. The host result preserves a bounded nested `applyError` record with `name`, `message`, `line`, and `number`; it never replaces `status` or `primaryStatus`.

## Numeric policy

Collection preserves exact finite float32 RGB values represented by the saved gradient payload.

Initial product application accepts only RGB components in `[0,1]`, for constructed palettes and exact gradient slots alike. HDR or negative components may remain stored exactly but are rejected on application; they are never silently clamped. The package can encode finite HDR/negative values, but live AE application behavior for that range has not yet passed the dedicated product/version gate.

Alpha must be finite and within `[0,1]` for application.

## Mixed and unsupported behavior

- Existing solid-color collection and application remain unchanged.
- Ordinary swatch application continues to report native gradients as unsupported; only the flyout or a gradient-slot click applies one.
- Layer Style Gradient Overlay/Glow is unsupported.
- Keyframed and expression-controlled native gradients are preserved and rejected.
- Unsaved or dirty-project exact gradient collection is rejected; Chroma Relay never auto-saves the user's project.
- After Effects omits an untouched default gradient's stop payload from a clean saved AEP. Exact collection rejects that omitted payload rather than inventing default stops; changing a stop once or applying a stored gradient causes AE to serialize the payload.
- Applying a gradient slot requires exactly one selected static supported native Fill or Stroke and uses the same version/template/readback/Undo/cleanup gates as Track B.

## Implementation and release order

1. **Completed:** Chroma Relay uses the private `@zimoby/ae-native-gradient` package pinned at exact commit `52b4b5c199691b4bc5e352a7d716192e061c750e`. Chroma Relay owns product semantics, UI, CEP bridge, and runtime adapters under the `com.zimoby.chroma-relay` CEP identity; the standalone package independently owns the toolkit implementation.
2. **Track A implemented:** one read-only host selection returns exact descriptors plus solid/gradient traversal tokens; the renderer reads one bounded stable saved AEP snapshot, resolves every descriptor exactly, and performs one atomic active-palette write.
3. **Track A2 implemented:** schema v3/layout v4/portable v2 migration, exact collection, preview, management, round-trip transfer, direct preset generation, and click routing pass domain, native-gradient, host-contract, CEP-compatibility, TypeScript, and production-build gates.
4. **Track B implemented.** Gradient-slot click reuses this application path rather than owning a second mutation path.
5. Native-gradient runtime behavior is enabled only on `darwin` and `win32` for AE major versions 22–26 and remains fail-closed elsewhere.
6. Windows AE `24.6.4x3` has live apply → save → exact collect proof with canonical `%TEMP%` agreement, FFX readback, one balanced Undo group, restored selection, and owned temp cleanup. Windows AE 22, 23, and 25 remain live-unverified because their interactive panels could not be opened remotely; AE 26 was not installed on the test host. Do not describe those four live gates as passed.

The existing AE `26.3x87` toolkit mechanism proof covers normal-range Fill/Stroke generation at 2, 3, and 8 stops. It does not by itself establish AE 22–99, HDR/negative, or untested Windows host behavior.
