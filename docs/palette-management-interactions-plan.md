# Palette Management and Interaction Implementation Plan

> **For Hermes:** Implement one review milestone at a time. Do not continue past a visual/runtime review boundary without Denis choosing continue or revise.

**Date:** 2026-07-18

**Goal:** Make color reordering and removal visually explicit, then evolve the single-palette document into multiple named palettes managed from a new Settings tab without losing existing user colors.

**Architecture:** Preserve Main as the only durable `palette.json` writer. Settings reads palette state and sends typed palette commands to Main over application-scoped CEP events; Main validates, serializes, persists, and publishes a typed result/change event. Migrate palette schema v1 in memory to schema v2 with one named default palette and one active palette, preserving revision, color IDs, exact RGBA/HDR values, recovery behavior, and the existing user-data path.

**Tech stack:** React 19, TypeScript 5, Sass, CEP/CSInterface application events, existing atomic palette storage, Node domain tests, CDP runtime evidence, AE 26.3 live validation.

---

## Approved scope translated into concrete behavior

### Main drag interaction

- Keep the compact Seam rail and native horizontal/vertical orientation.
- During drag, render a controlled swatch preview under the pointer rather than relying on an inconsistent browser ghost.
- Fade the source slot but keep its original location legible.
- Show a 2 px insertion marker before or after the current destination based on the pointer half and panel orientation.
- Keep destination feedback stable while auto-scrolling the existing palette strip.
- Persist exactly once on a changed drop; cancellation restores the original order and writes nothing.
- Continue suppressing the click/apply action emitted after a drag.
- Keep keyboard reordering. No new decorative animation; feedback uses the existing 80 ms timing.

### Main remove interaction

- Remove every corner delete button from Main.
- Holding Alt/Option puts all available swatches into removal mode.
- Removal mode is represented by a 2 px inner destructive stroke around each swatch; no X badge or corner chrome.
- Alt/Option-click removes the clicked color and never applies it.
- Alt/Option + Enter/Space removes the focused color for keyboard parity.
- Release Alt/Option, panel/window blur, drag start, and pending mutation all clear removal mode.
- Normal click continues to apply the color.
- Existing storage-error protection remains: loaded colors can still apply, but removal/reorder/add remain disabled.

### Multiple palettes

- Keep the file name and location: `USER_DATA/Chroma Relay/palette.json`.
- Palette schema v2:

```ts
type PaletteDocument = {
  schemaVersion: 2;
  revision: number;
  activePaletteId: string;
  palettes: Array<{
    id: string;
    name: string;
    colors: PaletteColor[];
  }>;
};
```

- Migrate schema v1 `{ colors }` to one palette `{ id: "palette-default", name: "Palette 1", colors }` without changing the document revision, color IDs, color order, or RGBA values.
- Keep up to 32 palettes and 64 colors per palette.
- Palette IDs are stable and unique. Names are trimmed, 1–48 characters, and case-insensitively unique.
- Creating a palette creates an empty uniquely named `Palette N` and makes it active.
- At least one palette must always exist; the final palette cannot be deleted.
- Deleting the active palette activates the nearest remaining palette.
- Main displays, applies, adds, removes, and reorders colors only in the active palette.
- No import/export, palette sharing, color-value editing, moving colors between palettes, folders, cloud sync, or Main-panel palette selector in this milestone.

### Settings palette manager

- Add two tabs under the existing Settings header: `General` and `Palettes`.
- `General` contains the current Layout and Image extraction controls unchanged.
- `Palettes` is the only palette-management surface for now.
- Palette rows show name, color count, compact color preview, and active state.
- Clicking a palette row makes it active and updates Main after one persisted write.
- Provide compact create, inline rename, and delete actions. Delete is disabled for the last palette.
- The selected palette exposes its colors below as compact swatches that can be reordered or removed. Do not add color-value editing.
- The manager scrolls inside Settings and remains usable at the declared 280×220 minimum.
- Routine success feedback remains quiet. Command/storage failures render actionable error-only copy in the Settings surface.

## Ownership and synchronization contract

- `palette-storage.ts` remains the only filesystem implementation and keeps one serialized write queue.
- Main remains the only caller of `savePalette`.
- Add `palette-events.ts` with defensive parsers and two application-scoped events:
  - `com.zimoby.chroma-relay.command`
  - `com.zimoby.chroma-relay.changed`
- Settings sends `{ requestId, baseRevision, command }`.
- Main rejects malformed commands and stale `baseRevision` values without writing.
- Main executes one command against its current document, saves one validated v2 document, updates local state, then publishes `{ requestId, ok, document, error }`.
- Main-originated add/remove/reorder actions also publish the same changed event after persistence so an open Settings panel stays synchronized.
- Settings updates only from a valid newer document or the matching command result. It never writes `palette.json` directly.
- If Main is unavailable, Settings times out the pending command and shows `Open the Main panel to change palettes`; it must not fall back to a second writer.

---

## Review milestone A — visible Main interaction prototype

**Visible artifact:** Current single palette in live Main with controlled drag preview/insertion marker and Alt/Option removal stroke. No schema or Settings changes yet.

**Included:** Main drag/remove state and styling; focused debug state needed to capture those interactions.

**Excluded:** Palette schema v2, tabs, palette creation, palette events, Settings management.

### Task A1 — Add explicit drag state

**Files:**
- Modify: `src/js/main/main.tsx`
- Modify: `src/js/main/main.scss`
- Modify: `src/js/shared/debug-api.ts`
- Modify: `src/js/shared/palette-domain.ts`

**Steps:**
1. Replace the single `draggingId` state with source ID, target ID, insertion edge, and pointer-preview geometry.
2. Build and remove one controlled drag preview element for each drag lifecycle.
3. Compute `before`/`after` from horizontal x-half or vertical y-half.
4. Extend the pure reorder helper with an explicit before/after edge so the persisted result matches the visible marker; retain legacy inferred behavior when the edge is omitted.
5. Clear every drag state on drop, drag end, cancellation, and unmount.
6. Preserve post-drag apply suppression.

### Task A2 — Render destination feedback

**Files:**
- Modify: `src/js/main/main.tsx`
- Modify: `src/js/main/main.scss`

**Steps:**
1. Add source, target-before, and target-after classes to swatch shells.
2. Open a temporary 4 px destination gap and render a 2 px light/dark insertion seam inside it so the location remains visible beneath the carried swatch.
3. Fade the source enough to show it was picked up while preserving its original slot.
4. Ensure the treatment works in Stretch/Fixed and both orientations.

### Task A3 — Replace corner delete with Alt/Option removal mode

**Files:**
- Modify: `src/js/main/main.tsx`
- Modify: `src/js/main/main.scss`
- Modify: `scripts/cep-functional-smoke.mjs` only after design approval

**Steps:**
1. Delete the `swatch-remove` button markup and CSS.
2. Track Alt/Option through window keydown/keyup, pointer movement, and blur.
3. Add `data-remove-mode` to Main and render a 2 px inner muted-red stroke on available swatches.
4. Route Alt/Option-click and Alt/Option + Enter/Space to `handleRemoveColor`; normal click still applies.
5. Keep focused swatch focus after a neighboring removal when possible.

**Automated proof before review:** Build development output only; do not run mutation tests before Denis reviews the visual direction because the existing test encodes the old corner-delete contract.

**Saved evidence:**
- Wide Main screenshot: default, dragging, drag destination, removal mode.
- Tall Main screenshot: drag destination and removal mode.
- Short JSON state/geometry report with no persistence mutation for preview-only states.

**Review question:** Is it visually obvious which color is being carried, exactly where it will land, and that Alt/Option-click will remove rather than apply?

**Boundary:** Stop for continue/revise/stop. Do not migrate the palette document until this interaction is approved.

---

## Review milestone B — schema v2 and migration

**Visible artifact:** Main still looks like the approved milestone A UI but runs from an active palette inside schema v2.

**Included:** Pure domain model, v1 migration, storage read/validation, active-palette operations.

**Excluded:** Settings tabs and command events.

### Task B1 — Write failing schema/migration tests

**Files:**
- Modify: `tests/palette-domain.test.ts`
- Modify: `src/js/shared/palette-domain.ts`

**Cases:**
1. Exact v1 document migrates to one `Palette 1` with unchanged revision/colors.
2. Valid v2 requires one or more palettes, unique palette IDs/names, valid active ID, and unique color IDs within each palette.
3. Invalid/missing active palette, duplicate names/IDs, empty names, too many palettes/colors, and malformed RGBA reject.
4. Clone preserves exact values without shared arrays.

### Task B2 — Implement schema v2 domain operations

**Files:**
- Modify: `src/js/shared/palette-domain.ts`

**Operations:**
- `migratePaletteDocument`
- `getActivePalette`
- `createPalette`
- `renamePalette`
- `removePalette`
- `selectPalette`
- active-palette add/remove/reorder by final insertion index
- palette-specific remove/reorder for Settings commands

Every changed operation increments the document revision exactly once; every semantic no-op returns the original object.

### Task B3 — Migrate storage reads without changing recovery authority

**Files:**
- Modify: `src/js/shared/palette-storage.ts`
- Modify: `scripts/cep-persistence-smoke.mjs`

**Steps:**
1. Parse and migrate v1/v2 candidates through one read function.
2. Continue preserving malformed primary bytes and invalid interrupted artifacts.
3. Do not eagerly rewrite a valid v1 primary merely because it was read.
4. Persist v2 on the next user mutation.
5. Update temp/backup/interrupted/queued-write fixtures for v2 and retain one explicit v1 migration case.

### Task B4 — Adapt Main and debug state to active palette

**Files:**
- Modify: `src/js/main/main.tsx`
- Modify: `src/js/shared/debug-api.ts`
- Modify: `scripts/cep-functional-smoke.mjs`

**Steps:**
1. Render active palette colors only.
2. Add/extract/apply/remove/reorder against the active palette.
3. Expose document revision, active palette ID/name, and palette summaries in development state.
4. Keep existing test helpers narrow; do not expose production palette mutators.

**Verification after implementation:**
- `npm run test:domain`
- `npm run cdp:persistence`
- updated focused mutation smoke
- `npm run check:cep`

**Review question:** Does schema migration preserve the existing palette exactly while establishing a safe active-palette model?

**Boundary:** Stop if migration, recovery, or invalid-primary preservation is not exact.

---

## Review milestone C — Settings tabs and palette manager

**Visible artifact:** Live Settings panel with compact `General` and `Palettes` tabs; Main changes immediately after palette commands.

**Included:** Settings UI, command/result events, single-writer Main command handling, palette management.

**Excluded:** Main palette selector, import/export, color editing, cross-palette drag.

### Task C1 — Add typed palette event transport

**Files:**
- Create: `src/js/shared/palette-events.ts`
- Modify: `src/js/main/main.tsx`
- Modify: `src/js/settings/settings.tsx`
- Modify: `tests/host-contract.test.mjs`

**Steps:**
1. Define command/result unions and strict runtime parsers.
2. Register one Main listener and one Settings result/change listener with cleanup.
3. Validate `baseRevision` before mutation.
4. Serialize command writes through Main’s existing mutation guard/queue.
5. Publish success only after durable save; publish a typed error on rejection/failure.
6. Prove Settings imports `loadPalette` but never `savePalette`.

### Task C2 — Add Settings tabs

**Files:**
- Modify: `src/js/settings/settings.tsx`
- Modify: `src/js/settings/settings.scss`
- Modify: `src/js/shared/debug-api.ts`

**Steps:**
1. Add an accessible two-tab control with `General` selected by default.
2. Move current controls into the General tab without changing their behavior.
3. Keep panel header and AE-native Seam styling.
4. Make each tab body independently scrollable at the 280×220 minimum.

### Task C3 — Build palette list management

**Files:**
- Modify: `src/js/settings/settings.tsx`
- Modify: `src/js/settings/settings.scss`

**Steps:**
1. Load the palette document read-only on Settings startup/config-root change.
2. Render palette rows with active state, name, count, and miniature ordered preview.
3. Add create, activate, inline rename, and delete commands.
4. Disable delete on the last palette and pending commands.
5. On command timeout, show error-only feedback and reload the document read-only.

### Task C4 — Build active-palette color management

**Files:**
- Modify: `src/js/settings/settings.tsx`
- Modify: `src/js/settings/settings.scss`

**Steps:**
1. Render active palette colors as compact rows/swatches with exact CSS color.
2. Reuse explicit insertion-target drag semantics for color reorder.
3. Provide clear Settings-only remove controls; Main remains Alt/Option removal.
4. Send one command per completed reorder/removal and wait for Main’s saved result.
5. Preserve focus and scroll position after results.

**Automated proof before review:** Domain/event parser tests and development build. Defer broad visual/mutation suites until Denis approves the Settings direction.

**Saved evidence:**
- Settings at 280×220, 320×280, and a taller viewport.
- General tab, Palettes tab, create/rename/delete states, empty palette, pending/error state.
- Main before/after active-palette change.

**Review question:** Is palette creation/selection and color management clear and compact enough for an AE Settings panel without adding Main chrome?

**Boundary:** Stop for continue/revise/stop before broad live persistence validation.

---

## Review milestone D — integrated live validation and documentation

### Task D1 — Add a self-cleaning two-panel palette-management smoke

**Files:**
- Create: `scripts/cep-palette-management-smoke.mjs`
- Modify: `package.json`
- Modify: `src/js/shared/debug-api.ts` only if a narrow test seam is missing

**Cases:**
1. v1 file loads identically in Main and Settings.
2. Create a second palette: one Main write, one result event, active empty Main.
3. Add colors to the second palette and verify first palette unchanged.
4. Select first palette and verify Main switches without host calls.
5. Rename with exact persistence and duplicate-name rejection.
6. Reorder/remove colors through Settings with one write each.
7. Delete active palette and verify deterministic fallback.
8. Attempt to delete the last palette and verify zero writes.
9. Reload both panels and verify active palette, names, order, colors, and revision.
10. Restore both panels to production root and delete the runner-owned temporary root.

### Task D2 — Update old mutation and design contracts

**Files:**
- Modify: `scripts/cep-functional-smoke.mjs`
- Modify: `scripts/cep-design-capture.mjs`
- Modify: `tests/host-contract.test.mjs`

**Steps:**
1. Remove corner-delete selectors and keyboard-tab assertions.
2. Add Alt/Option removal and no-apply assertions.
3. Assert source preview, insertion edge, changed-drop single write, cancelled-drop zero writes, and both orientations.
4. Add Settings tab geometry and minimum-height overflow checks.

### Task D3 — Run current verification after visual approval

Run serially:

```bash
npm run test:domain
npm run test:host-contract
npm run check:cep
npm run build:dev
npm run cdp:persistence
npm run cdp:mutate
npm run cdp:palette-management
npm run cdp:design -- --output=evidence/local/palette-management/design
npm run build
```

Then reload open panels to the final production bundle and verify the debug API is absent.

### Task D4 — Reconcile product documentation

**Files:**
- Modify: `docs/implementation-plan.md`
- Modify: `docs/implementation-status.md`
- Modify: `docs/design-direction.md`
- Modify: `evidence/README.md`
- Modify: `README.md` if its visible feature list is stale

**Steps:**
1. Mark the old one-click corner delete and single-palette exclusions as superseded.
2. Record schema v1→v2 migration and single-writer command ownership.
3. Index accepted screenshots, reports, and classified failures.
4. Keep the prior unsigned archive/SHA historical until a later package freeze.

**Completion contract:** The feature is complete only when the user approves both visual milestones, schema migration preserves exact existing data, Main remains the sole writer, the integrated live smoke passes with zero temporary residue, and the open panel is restored to a production bundle.

## Risks and rollback

- **Alt/Option delivery in CEP:** Track keyboard events plus pointer `altKey`; if live AE cannot expose a stable pre-click mode, stop and choose a different explicit modifier contract rather than hiding unreliability.
- **Native drag inconsistency:** Keep preview/insertion UI in DOM and treat `dataTransfer` only as transport. If live CEP ghost rendering remains inconsistent, switch the approved prototype to pointer events before schema work.
- **Cross-panel concurrency:** Never add a Settings filesystem writer. Reject stale base revisions and refresh from Main’s result.
- **Data loss:** Preserve the exact v1 primary until a successful user mutation writes validated v2. Keep malformed-primary write protection and temp/backup authority unchanged.
- **Small Settings viewport:** Use tab-local scrolling; do not enlarge Main or add palette chrome there to solve Settings density.
- **Rollback:** Schema code can continue reading v1 and v2, but once a user writes v2 an old build cannot read it. Do not package or distribute this milestone until the final integrated gate and migration decision are accepted.
