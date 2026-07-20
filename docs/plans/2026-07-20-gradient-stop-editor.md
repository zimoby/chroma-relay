# Gradient Stop Editing Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task. Execute one review milestone at a time and stop at every continue / revise / stop boundary.

**Date:** 2026-07-20

**Goal:** Let users expand an exact gradient slot in Settings → Palettes and edit its color and opacity stops with the same explicit Apply/Cancel behavior used by solid-color editing.

**Architecture:** Keep Main as the sole `palette.json` writer. Settings owns only an in-memory gradient draft, then sends one revisioned `update-gradient` command containing a complete validated `NativeGradient`; Main validates again, performs one pure document mutation, persists once, and broadcasts the authoritative document. Reuse palette schema v3 and portable palette v2 because both already store the complete gradient payload.

**Tech Stack:** React 19, TypeScript 5, Sass, `@zimoby/ae-native-gradient`, existing application-scoped CEP events, existing atomic palette storage, Node domain/contract tests, CDP temporary-root smokes, AE 26.3 live validation.

---

## Product contract

### Included in the first implementation

- Gradient rows in Settings → Palettes expand from the same summary surface as solid colors.
- A full-width gradient preview and two compact editor modes: `Color` and `Opacity`.
- Select a stop from an in-panel stop rail.
- Add and remove color stops independently from opacity stops.
- Edit the selected stop position numerically and by dragging its handle.
- Edit an in-range color stop with the existing Hex/RGB/CMYK conversion rules.
- Edit an opacity stop as 0–100%.
- Apply the complete draft once or cancel without mutation.
- Preserve slot ID, palette order, neighboring slots, untouched stop values, and native metadata.
- Keep 2–8 color stops and 2–8 opacity stops, matching `validateGeneratedGradient`.
- Keep duplicate offsets valid and deterministic.

### Explicitly deferred

- No editor in Main.
- No Fill/Stroke geometry editing: type, start/end points, highlight, stroke width, and property identity remain outside palette data.
- No keyframes, expressions, Layer Style gradients, or direct AEP writes.
- No midpoint editor in the first implementation. Existing midpoint values remain exact; new stops use `0.5`.
- No native color-stop `extra` editor. Existing values remain exact; new color stops use the product’s proven default `1`.
- No raw-float HDR color editor. Existing HDR/negative RGB remains exact and read-only for color-value editing, while stop selection and position remain available.
- No live disk write on drag, add/remove, mode change, format change, or field typing.
- No schema migration and no portable-format version change.

### Why midpoint editing is deferred

`nativeGradientToCssPreview` currently approximates the ramp and does not render AE midpoint interpolation exactly. The first editor must not expose a control whose visible result is materially misleading. A later midpoint milestone requires a documented interpolation model or a bounded native-render preview proof before enabling that field.

## Data and mutation rules

The stored shape remains:

```ts
type NativeGradient = {
  schemaVersion: 1;
  colorStops: Array<{
    offset: number;
    midpoint: number;
    rgb: [number, number, number];
    extra: number;
  }>;
  alphaStops: Array<{
    offset: number;
    midpoint: number;
    alpha: number;
  }>;
};
```

Rules:

1. Normalize every committed draft with `validateGeneratedGradient` before dispatch and again in Main/domain code.
2. Every stop list contains 2–8 entries.
3. Offset, midpoint, and alpha remain finite float32 values in `[0,1]`; RGB remains finite float32 and may retain out-of-display values.
4. Stop offsets remain nondecreasing. Position edits use a stable sort by offset; equal offsets retain draft order.
5. Opening/closing, selecting a stop, switching Color/Opacity, switching Hex/RGB/CMYK, invalid input, exact no-op Apply, and Cancel emit no command and cause zero writes.
6. One valid changed Apply sends one `update-gradient` command, increments the palette revision exactly once, and produces one Main disk write.
7. Existing stops receive ephemeral draft IDs only; draft IDs are never persisted or exported.
8. Existing `midpoint` and color-stop `extra` travel with their stop when its position changes.
9. A new stop duplicates the selected stop’s value, uses `midpoint: 0.5`, and, for color, `extra: 1`. It is inserted immediately after the selected draft stop and then stable-sorted by offset.
10. Add is disabled at eight stops. Remove is disabled at two stops.
11. Main recomputes the slot’s non-authoritative compatibility RGBA from the normalized first color stop RGB and first alpha-stop alpha, matching the current gradient-collection policy. Gradient application continues to use only `gradient`.
12. Existing gradient application range gates remain unchanged: stored HDR/negative RGB may persist but still rejects application until separately enabled.

## Interaction design

Expanded gradient editor, from top to bottom:

1. Wide preview ramp with a quiet 1 px boundary.
2. Equal-width `Color` / `Opacity` mode switch.
3. Stop rail:
   - color handles below the ramp;
   - opacity handles above or in a separate single rail when Opacity mode is active;
   - selected handle uses the existing dual light/dark focus treatment;
   - handle order remains visible for duplicate offsets.
4. Selected-stop controls:
   - position percentage field;
   - Color mode: existing Hex/RGB/CMYK switch and RGB fields, with no alpha field;
   - Opacity mode: one opacity percentage field;
   - compact add and remove icon actions.
5. Explicit Apply and Cancel actions plus inline validation copy.

Keyboard contract:

- Left/Right selects the previous/next stop in draft order.
- Home/End selects the first/last stop.
- Alt+Left/Right nudges position by 1%; Shift+Alt+Left/Right nudges by 0.1%.
- Enter applies a valid changed draft when focus is in a value field.
- Escape cancels and returns focus to the gradient summary.
- Delete/Backspace removes the selected stop only when more than two remain and focus is on the stop handle, never while typing in a field.

Physical-pointer contract:

- Use in-DOM pointer handlers; do not depend on a native CEP popup.
- Pointer movement updates only local draft position.
- Pointer up does not persist; Apply is still required.
- Outside interaction must not silently discard a dirty draft. Keep it open or request explicit Apply/Cancel within the row; do not add a modal.

---

## Review milestone A — pure draft model and visible editor prototype

**Visible artifact:** A live Settings gradient row expanded against a runner-owned temporary palette, showing Color and Opacity modes, selected handles, min/max stop states, and dirty/invalid states. No `update-gradient` command exists yet.

**Included:** Pure draft helpers, editor markup/styles, development-only fixture state, keyboard/pointer draft behavior.

**Excluded:** Palette persistence, Main command handling, real-user palette mutation, AE host calls.

### Task A1 — Add failing pure draft tests

**Files:**
- Create: `tests/gradient-editor-domain.test.ts`
- Create: `src/js/shared/native-gradient-edit.ts`
- Modify: `package.json:28`

**Test cases:**

1. Convert a validated gradient to draft state without shared arrays.
2. Preserve color/alpha stop order, duplicate offsets, midpoint, RGB/alpha, and `extra`.
3. Select stops by ephemeral draft ID without changing the gradient.
4. Add a color stop and opacity stop with the selected value, midpoint `0.5`, and color `extra: 1`.
5. Reject add at eight and remove at two.
6. Stable-sort a moved stop by offset while preserving equal-offset order.
7. Reject NaN, Infinity, out-of-range offset/alpha, malformed RGB, and wrong stop counts.
8. Convert a changed draft through `validateGeneratedGradient` and confirm float32 normalization.
9. Exact unchanged draft compares equal and produces no replacement.
10. HDR/negative RGB survives unrelated position edits exactly apart from required float32 normalization.

Run:

```bash
node --experimental-strip-types --test tests/gradient-editor-domain.test.ts
```

Expected before implementation: FAIL because `native-gradient-edit.ts` and its exports do not exist.

### Task A2 — Implement the pure draft domain

**Files:**
- Create: `src/js/shared/native-gradient-edit.ts`
- Modify: `tests/gradient-editor-domain.test.ts`

Required public surface:

```ts
export type GradientStopKind = "color" | "alpha";
export type GradientDraft = Readonly<{
  source: NativeGradient;
  colorStops: readonly GradientColorStopDraft[];
  alphaStops: readonly GradientAlphaStopDraft[];
}>;

export const createGradientDraft: (gradient: NativeGradient) => GradientDraft;
export const addGradientDraftStop: (...args: unknown[]) => GradientDraft;
export const removeGradientDraftStop: (...args: unknown[]) => GradientDraft;
export const updateGradientDraftStop: (...args: unknown[]) => GradientDraft;
export const gradientDraftToNativeGradient: (draft: GradientDraft) => NativeGradient;
export const nativeGradientsEqual: (left: NativeGradient, right: NativeGradient) => boolean;
```

Implementation requirements:

- Keep the module browser-safe: no CEP, filesystem, Node, React, or host imports.
- Generate draft IDs locally and deterministically for tests; never add IDs to `NativeGradient`.
- Use explicit stable sorting rather than relying on runtime sort stability.
- Normalize only at the conversion boundary so field typing does not continually lose precision.
- Return the same draft object for invalid or exact no-op operations where practical.

### Task A3 — Add the expandable gradient editor prototype

**Files:**
- Create: `src/js/settings/gradient-editor.tsx`
- Modify: `src/js/settings/settings.tsx:1400-1485`
- Modify: `src/js/settings/settings.scss:639-878`
- Modify: `src/js/shared/debug-api.ts` only if a narrow fixture selector is missing
- Modify: `tests/host-contract.test.mjs`

Steps:

1. Allow gradient summaries to set `aria-expanded` and open the same subordinate editor band used by solids.
2. Keep at most one slot editor expanded.
3. Create a local draft when a gradient row opens; do not mutate `paletteDocument`.
4. Render preview, mode switch, stop rail, selected-stop controls, add/remove, Apply, Cancel, and inline errors.
5. Reuse `color-format.ts` parsing/formatting rules for in-range color-stop RGB.
6. Do not render an alpha field in Color mode; opacity remains an independent stop list.
7. For an HDR/negative selected color stop, show exact raw RGB and keep only position/selection controls active.
8. Add semantic test IDs for the row, mode, handles, position, value fields, add/remove, Apply, and Cancel.
9. Keep the Palettes tab usable at 240×300 through local scrolling; do not widen Settings or Main.

### Task A4 — Capture and review the visual prototype

Build and capture:

```bash
npm run test:domain
npm run test:host-contract
npm run build:dev
npm run cdp:design -- --output=evidence/local/gradient-stop-editor/prototype
```

Required evidence:

- `320x360-gradient-color.png`
- `320x360-gradient-opacity.png`
- `240x300-gradient-color.png`
- `duplicate-offsets.png`
- `two-stop-remove-disabled.png`
- `eight-stop-add-disabled.png`
- `hdr-stop-read-only.png`
- geometry/state JSON proving zero writes/events/host calls

**Review question:** Is selecting and controlling color/opacity stops clear and compact enough for the Palettes tab, without making a gradient row feel like a separate application?

**Boundary:** Stop for Denis to choose continue / revise / stop. Do not add `update-gradient` or persistence before visual approval.

---

## Review milestone B — validated single-writer persistence

**Visible artifact:** The approved editor applies one full gradient draft and both panels immediately show the authoritative persisted result.

**Included:** Pure palette mutation, command parser, Main ownership, exact no-op and failure behavior.

**Excluded:** AE project mutation and release claims.

### Task B1 — Add gradient replacement domain tests

**Files:**
- Modify: `src/js/shared/palette-domain.ts:615-636`
- Modify: `tests/gradient-slot-domain.test.ts`

Add tests for `updatePaletteGradientInPalette`:

1. Replace one exact gradient payload while preserving slot ID, palette ID, slot order, and neighbors.
2. Recompute only compatibility RGBA plus `gradient`.
3. Increment revision exactly once.
4. Deep-clone normalized stop arrays.
5. Return the same document for missing palette, missing slot, solid slot, malformed gradient, invalid count/order/value, or exact normalized no-op.
6. Preserve unrelated palettes and every untouched slot exactly.
7. Permit duplicate offsets and finite HDR/negative RGB storage.

### Task B2 — Implement the pure palette mutation

**Files:**
- Modify: `src/js/shared/palette-domain.ts`
- Modify: `src/js/shared/native-gradient-edit.ts`

Required signature:

```ts
export const updatePaletteGradientInPalette = (
  document: PaletteDocument,
  paletteId: string,
  colorId: string,
  gradient: NativeGradient
): PaletteDocument;
```

Use `validateGeneratedGradient`, exact normalized equality, one clone, and one revision increment. Do not modify storage code or schema versions.

### Task B3 — Add and validate the revisioned command

**Files:**
- Modify: `src/js/shared/palette-events.ts:19-34,64-109`
- Modify: `src/js/main/main.tsx:applyPaletteCommand`
- Modify: `src/js/main/main.tsx:paletteCommandMessage`
- Modify: `tests/host-contract.test.mjs`

Command:

```ts
{ type: "update-gradient"; paletteId: string; colorId: string; gradient: NativeGradient }
```

Requirements:

1. Event parser checks entity IDs and validates the complete gradient.
2. Main validates the base revision before mutation through the existing command path.
3. Main calls `updatePaletteGradientInPalette` and remains the only `savePalette` caller.
4. Success is published only after one durable save.
5. Invalid, stale, exact no-op, timeout, or unavailable Main produces no write.
6. Settings never imports or calls `savePalette`.

### Task B4 — Connect Apply/Cancel

**Files:**
- Modify: `src/js/settings/gradient-editor.tsx`
- Modify: `src/js/settings/settings.tsx`
- Modify: `tests/host-contract.test.mjs`

Steps:

1. Apply converts and validates the full draft locally.
2. Exact no-op closes quietly or remains open without dispatch, matching the approved visual behavior.
3. A valid change dispatches one `update-gradient` command using the current document revision.
4. Keep the editor pending until the matching authoritative result arrives.
5. On success, replace local state from the result and close or refresh the editor deterministically.
6. On rejection/timeout, preserve the user’s draft and show actionable inline error copy.
7. Cancel discards only local draft and restores focus to the summary.

Verification:

```bash
npm run test:domain
npm run test:host-contract
npm run check:cep
```

**Review question:** Does Apply/Cancel feel consistent with solid-color editing while making it obvious that the entire ramp commits atomically?

**Boundary:** Stop if one Apply causes more than one revision/write, Settings writes directly, invalid input dispatches, or a failed command loses the draft.

---

## Review milestone C — self-cleaning live two-panel smoke

**Visible artifact:** A temporary gradient is edited from real Settings, persists once through Main, survives in-panel reload/readback, and leaves the user palette untouched.

### Task C1 — Extend the palette-management smoke

**Files:**
- Modify: `scripts/cep-palette-management-smoke.mjs:537-587`
- Modify: `src/js/shared/debug-api.ts` only if the existing state lacks selected gradient draft information
- Modify: `package.json` only if a focused script alias is needed

Smoke phases:

1. Create a fresh runner-owned config root and seed one 3-color/3-opacity exact gradient with non-default midpoint, duplicate-offset, and `extra` evidence.
2. Open the gradient editor and switch Color/Opacity without writes/events/host calls.
3. Attempt invalid position/color/opacity input; assert `aria-invalid`, zero command, zero write.
4. Add and remove draft stops; assert zero write before Apply.
5. Cancel; assert exact persisted bytes/revision and both-panel state unchanged.
6. Reopen, edit one color, one opacity, and one position, then Apply.
7. Assert one emitted command, one Main write, one revision increment, and identical authoritative gradient in Main, Settings, and `palette.json`.
8. Assert untouched midpoint/`extra`, duplicate-offset order, slot ID, slot order, and neighboring slots remain exact.
9. Assert portable export contains the edited complete gradient without internal draft IDs.
10. Reload from disk in-panel and verify the edited ramp without repeated full-page reloads.
11. Restore both panels to the real production root and remove the runner-owned root in `finally`.

### Task C2 — Physical pointer acceptance

Manual live Settings checks:

1. Physically click a gradient summary and select color and opacity handles.
2. Physically drag one handle, then verify no persistence before Apply.
3. Apply and verify the preview updates in Settings and Main.
4. Reopen and Cancel a second edit.
5. Verify no option/handle disappears on CEP null-`relatedTarget` blur ordering.

Trusted CDP input is supporting evidence only; it does not replace this physical-pointer check.

### Task C3 — Final production restoration

Run serially:

```bash
npm run verify:static
npm run build:dev
npm run cdp:palette-management
npm run cdp:design -- --output=evidence/local/gradient-stop-editor/final
npm run build
npm run check:cep
```

Then prove:

- open Main and Settings use the final production HTML/chunks;
- production debug API is absent;
- the real palette root and active palette are restored;
- runner roots are absent;
- no AE host call occurred during the editor smoke.

**Review question:** Does the real physical-pointer editor behave reliably and preserve the exact persisted gradient through Apply, Cancel, and reload?

**Boundary:** Stop on unknown completion, stale renderer identity, storage drift, extra writes, residue, or failed user-state restoration.

---

## Review milestone D — optional edited-gradient AE application gate

This milestone mutates an AE scratch fixture and requires separate explicit approval. It is not authorized by implementing the Settings editor.

### Task D1 — Prove one edited gradient through the existing application path

**Files:**
- Modify the existing native-gradient live runner only if it lacks an input hook for a supplied stored gradient.
- Do not create a second apply path.

Required proof:

1. Exact supported AE version/template family and live production bundle identity.
2. Approved saved scratch project and exact selected static Shape Gradient Fill/Stroke target.
3. Apply the edited stored gradient through the existing gradient-slot click path.
4. Saved-AEP readback matches edited color/alpha stops, positions, preserved midpoint, and `extra` after float32 normalization.
5. One later Undo restores the exact fixture gradient.
6. No save of user work, no automatic retry on unknown completion, and no preset/temp residue.

**Boundary:** Passing the editor smoke does not authorize this host mutation. Stop for explicit approval before D1.

---

## Documentation after implementation

**Files:**
- Modify: `docs/native-gradient-product-semantics.md:60-69`
- Modify: `docs/implementation-status.md`
- Modify: `docs/design-direction.md`
- Modify: `evidence/README.md`
- Modify: `README.md` only if the visible feature list becomes stale
- Update the plugins KB runtime/status/handoff documents after fresh live evidence

Record:

- gradient editing is Palettes-only;
- Main remains the single writer;
- schema v3 and portable v2 remain unchanged;
- editable versus preserved/deferred fields;
- one-Apply/one-write contract;
- preview midpoint limitation;
- physical-pointer acceptance;
- exact live evidence and any residual AE-application gate.

## Risks and stop conditions

- **Misleading preview:** Do not expose midpoint editing until preview semantics are proven.
- **Precision loss:** Parse only changed display fields; never round untouched floats back into storage.
- **HDR destruction:** Never clamp or convert out-of-range RGB silently.
- **Stop identity:** Draft IDs are UI-only; stable-sort explicitly and preserve equal-offset order.
- **Write storms:** Dragging and typing remain local. Only Apply can emit one command.
- **Second writer:** Settings must never call `savePalette`.
- **Schema churn:** No schema/portable bump unless implementation discovers data that cannot fit the existing exact payload; stop and revise this plan before changing versions.
- **CEP pointer divergence:** Require physical drag/click acceptance and capture event ordering if CDP differs.
- **User-state risk:** All automated editing uses a fresh temporary config root with restoration in `finally`.
- **Host mutation:** Palette editing itself makes zero AE host calls. Applying an edited gradient is a separate approval-gated milestone.

## Completion contract

The feature is complete only when:

1. Denis approves the visual prototype;
2. every invalid/cancelled/non-mutating interaction causes zero command and zero write;
3. one valid Apply causes exactly one revision and one Main write;
4. the complete normalized gradient persists and round-trips without losing untouched midpoint/`extra`/HDR data;
5. both panels and the file agree after reload;
6. physical pointer behavior passes in live CEP;
7. the user palette and production bundle are restored with no runner residue;
8. documentation distinguishes the completed editor from any still-pending AE application gate.
