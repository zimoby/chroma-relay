# Chroma Relay CEP Extension — Implementation Plan

> This document now has two purposes: the canonical from-scratch rebuild sequence incorporates the implementation and live-AE lessons, while the original recovered plan remains at the end as historical provenance only. Implement from the canonical sequence, not from the historical appendix.

## Current reconciliation — 2026-07-17

Current phase: Tasks 0–10 plus image-selected palette extraction are implemented and live-validated for the Mac internal-alpha scope. The historical I11 unsigned package passed before post-I11 design and feature work, but it is no longer the current package. Detailed execution evidence and exact commands remain in `docs/implementation-status.md` and `evidence/README.md`.

New scope, planned but not yet implemented: explicit drag/drop feedback, Alt/Option removal mode, palette schema v2, and Settings-owned palette-management UI are specified in [`docs/palette-management-interactions-plan.md`](palette-management-interactions-plan.md). Execute only its first visual review milestone before continuing to schema work.

### Original Tasks 0–11 checklist

- [x] Task 0 — two-panel architecture gate, responsive Main, Settings launch/sync, temporary-root test seams, and instrumented events/writes proved in live CEP.
- [x] Task 1 — Bolt-based Main/Settings scaffold, exact extension IDs, distinct CDP ports, generated manifest, and build contract implemented. Current host floor was broadened from planned AE 24.0 to validated AE 22.0.
- [x] Task 2 — versioned palette/settings schemas, validation, exact RGBA/HDR handling, stable IDs, dedupe, remove, reorder, and revision behavior implemented and tested.
- [x] Task 3 — owner-specific palette/settings storage, serialized palette writes, verified temp/final replacement, backup recovery, malformed-primary preservation, and temporary-root regressions passed.
- [x] Task 4 — one-way application-scoped Settings event synchronization, defensive payload parsing, revision gating, reload recovery, and no-echo behavior passed.
- [x] Task 5 — hidden Settings panel and exact flyout launch passed. The approved controls changed from forced Auto/Horizontal/Vertical to Stretch/Fixed sizing plus Include Disabled Colors; orientation remains automatic.
- [x] Task 6 — single-axis responsive rail, empty/error/native states, independent scrolling, and always-visible Add behavior passed. The original 32 px-wide contract was superseded by a declared 128×32 Main minimum and current 128×32, 160×32, 128×160, and 200×200 matrix.
- [x] Task 7 — read-only recursive selected-property/group and whole-selected-layer COLOR traversal, deterministic ordering, disabled-branch preference, exact floats/HDR, and typed no-result states passed in live AE.
- [x] Task 8 — exact static/keyframed application, expression preservation, per-target isolation, rapid-click deduplication, one balanced undo group, exact readback, and exact single-Undo restoration passed in live AE 26.3.
- [x] Task 9 — compact one-click and keyboard removal, keyboard/pointer reorder, stable IDs, click suppression after drag, persistence, and focus behavior passed.
- [x] Task 10 — serial Mac AE two-surface runtime validation, strict CDP identity, collection, application, persistence, settings, mutation, and responsive/state evidence passed. Windows storage/runtime validation remains a release-boundary gate before any cross-platform claim.
- [x] Task 11 — the historical I11 internal-alpha build, review/fix loop, package verification, and Mac smoke passed. This checkbox records that historical gate only; post-I11 changes require a new package/report/SHA before the artifact is current.

### Post-I11 work completed after the original plan

- [x] Selected and froze the compact Seam visual direction.
- [x] Unified Main and Settings on one AE-native `#1c1d1f` background and replaced the Settings card with separators.
- [x] Removed routine Settings footer/status rendering.
- [x] Raised Main's manifest minimum width from 32 px to 128 px while retaining a 32 px minimum height.
- [x] Updated strict design fixtures and Add-bound assertions to the 128 px contract.
- [x] Investigated the already-open floating window from 136 px down to 79 px outer width; its internal CEP viewport remained 132 px.
- [x] Kept Fixed Add equal to the configured swatch size and left-aligned in vertical layouts.
- [x] Added a vertical Stretch fallback at the measured 132 px internal floor: compact 24×24 px Add aligned at the left edge.
- [x] Verified the final production panel at the unchanged 79 px outer-window edge case and rebuilt successfully.
- [x] Implemented and live-validated JPEG/PNG five-color extraction, three Settings presets, selected-layer/project identity handling, mixed/multiple-selection rejection, unsupported-format handling, and corrupt-image failure behavior.

### Approved deviations and clarifications

- Repository location changed from the planned `_Extensions_dev/chroma-relay` path to `/Users/REDACTED/Documents/Dev_code/_Collaborations/chroma-relay`.
- Product identity is now locked as `Chroma Relay` with bundle `com.zimoby.chroma-relay`, Main `com.zimoby.chroma-relay.main`, and Settings `com.zimoby.chroma-relay.settings`.
- The validated host floor is AE 22.0 rather than the planned AE 24.0 baseline.
- Settings schema v3 is `{ schemaVersion, revision, layoutMode: "stretch" | "fixed", swatchSize: 24..64, includeDisabledColors, extractionPreset }`; there is no manual orientation override.
- Orientation remains geometry-derived: horizontal when width ≥ height, vertical otherwise.
- Current user-data files live under `USER_DATA/Chroma Relay/`, not the originally proposed `USER_DATA/ChromaRelay/com.zimoby.chroma-relay/` path.
- The test implementation uses focused domain/host-contract tests plus strict CDP/live smoke runners instead of reproducing the exact planned test-file tree.
- The current build uses a corner remove control; the 2026-07-18 scope supersedes it with a planned Alt/Option removal mode after visual approval.
- `minWidth: 128` is a host declaration, not a retroactive CSS/window guarantee. An already-open AE frame remained at 79 px externally while CEP floored at 132 px internally.
- Routine Settings status is intentionally quiet; the current implementation also hides save-failure copy, which remains an explicit UX decision before external testing.

### Open gates before the next release/distribution phase

- [ ] Verify a freshly closed/reopened Main panel enforces the declared 128 px host minimum. Do not close/restart AE without approval; the current 79 px window is preserved live evidence.
- [ ] Decide whether Settings should restore error-only save feedback while keeping routine success/status text removed.
- [ ] Establish the repository's first Git baseline/commit when Denis approves committing. Resolve the current dual-lockfile state in favor of npm/`package-lock.json`; the repository currently has no `HEAD` and all project files are untracked.
- [ ] After the next code/design freeze, rerun focused checks and `npm run package:alpha`; replace the historical package report and record a new SHA-256.
- [ ] Run the storage/replacement and runtime fixture on Windows before making any public cross-platform package claim.

### Current source-of-truth links

- `docs/palette-management-interactions-plan.md` — active next-scope plan for explicit drag feedback, Alt/Option removal, multiple palettes, and Settings palette management.
- `docs/demo-implementation-plan.md` — disposable two-panel, JSON-persisted shortcut for demo work only; it intentionally omits production hardening and automated validation and does not supersede the canonical sequence below.
- `docs/implementation-status.md` — detailed milestone results, validation evidence, exact implementation surface, and current package provenance.
- `docs/design-direction.md` — selected Seam direction and post-I11 minimum-width design contract.
- `evidence/README.md` — authoritative evidence and preserved failure index.
- `evidence/final-review/README.md` — historical I11 hardening/package proof and provenance warning.

---

## Canonical from-scratch rebuild plan

> **Execution rule:** implement one review milestone at a time. Automated checks prove the active milestone; they do not authorize continuing past a live/design review boundary.

**Goal:** Create Chroma Relay from a clean Bolt CEP scaffold without repeating the product-contract, minimum-width, persistence, runtime-identity, evidence, or package-provenance problems found during the first implementation.

**Architecture:** One bundle contains a compact Main panel and a hidden dockable Settings panel. Main alone owns palette state; Settings alone writes settings; synchronization is one-way and revision-gated. AE host work remains in small typed ExtendScript functions, while a development-only debug contract provides exact live identity, fixtures, counters, and temporary-root isolation.

**Tech stack:** Bolt CEP/vite-cep-plugin 2.2.3, React 19, TypeScript 5, Sass, Node test runner, CDP, and ES3-compatible ExtendScript for AEFT 22.0+.

### Canonical product contract — lock before code

- Product name: `Chroma Relay`.
- Repository: `/Users/REDACTED/Documents/Dev_code/_Collaborations/chroma-relay`.
- Bundle ID: `com.zimoby.chroma-relay`.
- Main ID/port: `com.zimoby.chroma-relay.main` / 8198.
- Settings ID/port: `com.zimoby.chroma-relay.settings` / 8199.
- Host floor: AEFT `[22.0,99.9]`; panel compatibility target is the AE 2022 CEP/Chrome 74 class; host output must remain ES3-compatible.
- Main geometry: default 320×80, declared minimum 128×32. Settings remains independent at default 320×280 and minimum 280×220.
- Orientation is always derived from measured Main geometry: horizontal when width ≥ height, vertical otherwise. Do not add Auto/Horizontal/Vertical settings or hidden debug state that models a manual orientation preference.
- Settings schema is v2: `{ schemaVersion: 2, revision, layoutMode: "stretch" | "fixed", swatchSize: 24..64, includeDisabledColors }`.
- User-data continuity path is `USER_DATA/Chroma Relay/` with `palette.json` and `settings.json`. Do not silently rename or re-namespace it after users have data.
- Static AE color properties are writable. Keyed and expression-enabled color properties are preserved and counted, not modified. Gradients and TextDocument colors are explicitly unsupported in v1.
- Visual direction is Seam: one AE-native `#1c1d1f` canvas, thin separators, no raised Settings card, no routine success footer, and visible actionable error-only feedback unless an explicit product decision removes it.
- Fixed Add matches the selected swatch size and remains top/left aligned. Stretch Add fills normally, but at the measured 132 px internal vertical floor it becomes a left-aligned 24×24 px control.
- The active next scope includes multiple named palettes managed from Settings. It still excludes import/export/share/cloud, cross-palette color moves, color-value editing, color generation, gradients, eyedropper sampling, TextDocument/SolidSource/nested-precomp traversal, licensing, telemetry, updates, and marketplace work.

### Failure-prevention rules

1. Create a Git baseline before bespoke feature work. Do not repeat a full implementation with no `HEAD`; obtain approval before committing, keep one chosen lockfile, and make generated-vs-custom changes reviewable.
2. Use npm/`package-lock.json` for this project. On this Mac, bare Yarn walks up to `/Users/REDACTED/package.json`, sees its `packageManager: pnpm@...`, and aborts before running project scripts. Verify `npm --version` in the project root and use `npm ci`/`npm run ...`.
3. Run the untouched pinned scaffold build before editing. If the pinned generator CLI falls into TTY prompts, call that exact package's exported generator API; do not hand-copy a template.
4. Prove both live panel surfaces and exact runtime identity before host behavior. An extension ID, checked menu item, or open port alone is insufficient.
5. Treat build, renderer, and product failures separately. A clean build can remove file-backed assets and terminate an open renderer while AE remains healthy.
6. Use a fresh runner-owned `/tmp/chroma-relay-*` root for every persistence/sync run. Delete it before assignment, restore both panels to production root, and verify cleanup.
7. Preserve the first failed report/screenshot with a classification: product, harness, stale build/runtime load, undersized compositor, or transient CEP target failure. Never overwrite it with a retry pass.
8. Never request a screenshot fixture larger than the real CEP compositor. Resize the real floating panel first, measure `window.innerWidth/innerHeight`, and fail closed if it is below the largest fixture.
9. Distinguish manifest minimum, AE outer-window bounds, and CEP viewport. A new `<MinSize>` does not retroactively resize an already-open floating panel.
10. Run AE-backed scenarios serially. Do not overlap a CEP `evalScript` action with `ae_run` or another panel action.
11. Recheck project identity and dirty state immediately before every mutating fixture and cleanup step. Delete only uniquely prefixed test objects.
12. A package report and SHA become historical immediately after source/config/design changes. Repackage only after the next freeze; do not claim an old archive is current.
13. Mac proof is not Windows proof. Validate replacement/recovery and installed runtime on Windows before any public cross-platform claim.

### Review milestone A — clean foundation and exact live surfaces

#### Task R0 — Freeze decisions, package manager, and repository baseline

**Objective:** Remove identity, host-floor, settings-model, storage-path, and provenance ambiguity before scaffolding.

**Files:**
- Create/update: `README.md`, `docs/implementation-plan.md`, `.gitignore`, `.npmrc`.
- Generated baseline: `package.json`, `package-lock.json`, `cep.config.ts`, `src/`.

**Steps:**
1. Record the canonical product contract above before running the generator.
2. Use npm consistently for this project. Keep `package-lock.json`; do not intentionally create or retain `yarn.lock` in a fresh rebuild.
3. Confirm the destination is empty or intentionally replaceable; never scaffold over an unknown tree.
4. Initialize Git, inspect ignored/generated paths, and obtain approval before creating the untouched-scaffold baseline commit.
5. Verify `git status --short` distinguishes generated baseline from later work.

**Gate:** The repo has a reviewable baseline and locked IDs/path/host floor before any product code. Stop if commit approval is unavailable; do not continue to a large unversioned implementation.

#### Task R1 — Generate the pinned untouched scaffold

**Objective:** Preserve generator provenance and prove the toolchain before customization.

**Files:** generated project plus `package.json`, `package-lock.json`, `cep.config.ts`.

**Steps:**
1. Invoke pinned `create-bolt-cep@2.2.3` for React/TypeScript/AEFT only.
2. If CLI value options are discarded and `ERR_TTY_INIT_FAILED` occurs, verify the destination is still absent, load the same package with `BOLT_MODULEONLY=1`, and call its exported `createBoltCEP({...})` with explicit values.
3. Install through npm and preserve `package-lock.json`; use `npm ci` once the lockfile exists.
4. Run `npm run build` before any edits.
5. Record generator command/fallback and untouched build output.

**Gate:** Untouched TypeScript/Vite build passes. Do not debug later product failures until this baseline is proven.

#### Task R2 — Configure the real two-panel and compatibility contract

**Objective:** Make generated manifest/runtime identity match the locked product contract from the first customized build.

**Files:**
- Modify: `cep.config.ts`, `vite.config.ts`, `vite.es.config.ts`, `src/js/main/*`, `src/js/settings/*`, `src/js/lib/utils/init-cep.ts`.
- Create: `tests/host-contract.test.mjs`, `scripts/check-cep-compat.mjs`.

**Steps:**
1. Configure exactly two Panel entries, exact IDs, distinct ports, and independent geometry. Start Main at 128×32 minimum, not the obsolete 32×32 width.
2. Keep Settings hidden from the normal Extensions list with `panelDisplayName: ""` and `autoVisible: false`.
3. Set AEFT `[22.0,99.9]`, conservative panel output, and ES3 host output.
4. Inspect Bolt bootstrap before flyout customization. Modify its single initialization path rather than stacking duplicate flyout/context listeners.
5. Run `npm run build`, then inspect generated `dist/cep/CSXS/manifest.xml` for both IDs, both sizes, host range, and ports.
6. Run `npm run test:host-contract` and `npm run check:cep`.

**Gate:** Source config, generated manifest, panel bundle, and host bundle agree. A new extension scan or manifest-cache refresh may require panel reopen/AE restart; obtain approval before either.

#### Task R3 — Add the development-only debug contract and fail-closed runner

**Objective:** Establish safe automation before stateful product behavior.

**Files:**
- Create/modify: `src/js/shared/debug-api.ts`, `scripts/cep-cdp.mjs`, `package.json`, panel entry files.

**Steps:**
1. Gate `window.__CHROMA_RELAY_DEBUG__` with explicit `VITE_CHROMA_RELAY_DEBUG=true`; do not rely on `import.meta.env.DEV` for static builds.
2. Expose identity, state, geometry, counters, fixture viewport, design state, temporary config root, visible-control dispatch, reset, and reload only in development builds.
3. Identity must include exact extension ID, page, version, build marker, URL, script/style URLs, and config root.
4. The runner must require one exact target on each declared port, realpath loaded assets under the expected build, and reject stale marker, wrong ID/page, duplicate target, unknown CLI option, and escaped asset.
5. Run production omission first: `npm run build`; scan executable bundles for the debug global/mutators.
6. Run `npm run build:dev` and `npm run cdp:self-test`; preserve live negative-control failure evidence.
7. If `rimraf dist/*` ghosts an open panel, first prove AE health and rebuilt files, then use one approved AE-native menu-command activation or a CDP page reload. Do not call it a product crash without an exception/signature.

**Gate:** Production omits debug surfaces; development exposes them; exact-target self-tests and negative controls pass.

#### Task R4 — Prove the smallest live two-panel architecture

**Objective:** Validate the highest-risk CEP assumptions before storage or AE color logic.

**Visible artifact:** Main with three fixture swatches and separate Add; hidden Settings opened from Main flyout.

**Steps:**
1. Build development output and prove the active Main page is the intended file-backed build by ID, page, marker, URL, and loaded assets.
2. Open Settings through the actual flyout event and `requestOpenExtension()`; parse object/string event payloads defensively.
3. Prove exactly one page on ports 8198 and 8199.
4. Exercise one temporary Settings value and confirm one emitted event, one Settings write, one Main receive, and zero Main writes.
5. Suppress one event and prove startup/focus/throttled-pointer disk recovery.
6. Restore production roots, remove the unique temp directory, verify counters, capture screenshots/JSON, and confirm AE remains responsive.

**Review question:** Do the exact live surfaces, launch flow, and one-way ownership model behave correctly enough to continue?

**Boundary:** Stop for continue/revise/stop review. Do not implement host collection/application before this pass.

### Review milestone B — durable state, Settings, and accepted design

#### Task R5 — Implement pure schemas and recoverable persistence

**Objective:** Make palette/settings data deterministic, exact, recoverable, and testable without production user-data mutation.

**Files:**
- Create/modify: `src/js/shared/palette-domain.ts`, `src/js/shared/palette-storage.ts`, `src/js/shared/layout-settings.ts`, `tests/palette-domain.test.ts`, `scripts/cep-persistence-smoke.mjs`.

**Steps:**
1. Implement stable color IDs, exact finite RGBA/HDR storage, first-value-preserving epsilon dedupe, remove/reorder, and revisions.
2. Main alone reads/writes `palette.json`; Settings alone writes `settings.json`.
3. Queue palette writes. Validate source document, write UTF-8 temp, verify temp, rotate final to backup, rename temp to absent final, verify final, then delete backup.
4. If final exists but is malformed, preserve its exact bytes and write-protect mutations; never replace it with defaults.
5. On missing final, prefer a valid temp, then valid backup. Preserve invalid interrupted artifacts and report the error.
6. Use a newly created runner-owned root for each case: missing, valid, malformed final, valid/invalid temp, valid backup, interrupted replace, queued writes, and a failed write followed by successful queue recovery.
7. Run `npm run test:domain` and `npm run cdp:persistence`.

**Gate:** All persistence cases pass in isolation; both panels restore production root; temp residue is zero. Windows replacement remains a release gate, not an assumed pass.

#### Task R6 — Implement Settings and one-way synchronization

**Objective:** Ship the corrected settings model without reintroducing a manual orientation preference or stale-write echo.

**Files:** `src/js/settings/settings.tsx`, `src/js/settings/settings.scss`, `src/js/shared/layout-settings.ts`, Main consumer code, `scripts/cep-cdp.mjs`.

**Steps:**
1. Render only Stretch/Fixed, fixed size 24–64, and Include Disabled Colors. State explicitly that orientation follows Main automatically.
2. Migrate schema v1 to v2 with `includeDisabledColors: false` while preserving layout, size, and revision.
3. Subscribe Main before disk hydration; route disk/event snapshots through one revision gate. Newer wins; malformed revisions fail; equal revision with different content triggers disk re-read.
4. Persist Settings before broadcasting. Main applies received state in memory and never writes it.
5. For the range control, keep `onChange` draft-only; commit with desktop `onMouseUp`, keyboard `onKeyUp`, and `onBlur` fallback. Test the range itself with a bubbled `mouseup`.
6. Keep routine successful saves visually quiet. Render actionable save/read errors near the affected control by default; removing error-only feedback requires explicit sign-off and a recorded rationale.
7. Run `npm run cdp:settings`; assert exact writes/events, Main geometry, reload recovery, migration, and production-root restoration.

**Gate:** Settings produces one write/event per completed change, Main produces no echo write, and range/number/checkbox paths all converge.

#### Task R7 — Freeze the live design and responsive minimum before host logic

**Objective:** Validate the actual floating-panel geometry and selected visual direction while changes are still cheap.

**Files:** `src/js/main/main.scss`, `src/js/settings/settings.scss`, `src/js/main/main.tsx`, `scripts/cep-design-capture.mjs`, `docs/design-direction.md`.

**Steps:**
1. Implement Seam: shared `#1c1d1f` root, transparent child canvas where appropriate, separators instead of a card, 24 px minimum targets, visible focus, compact remove, and transient Main notices.
2. Use a single no-wrap rail and `ResizeObserver`; horizontal when width ≥ height, vertical otherwise.
3. Validate current strict fixtures: 128×32, 160×32, 128×160, and 200×200. Assert the debug setter returns `true`, Add is at least 24×24 and fully in bounds, and fixed swatches/Add are top/left aligned.
4. Before 200×200 capture, make the real CEP compositor at least 200×200. Reject undersized surfaces; preserve repeated-edge captures as failed harness evidence.
5. Validate one real wide and one real tall AE arrangement separately from fixture-root screenshots.
6. Measure manifest minimum, AX/Quartz outer bounds, and CDP viewport separately. Capture the real window by Quartz ID, not foreground-region capture, and restore exact original bounds in cleanup.
7. Start with manifest `minWidth: 128`. Verify generated `<MinSize>`, then—only with approval—close/reopen the panel to prove fresh enforcement. If cached, classify AE restart as a separate approval gate.
8. Keep the measured 132 px internal-floor fallback narrow: only vertical Stretch collapses Add to left-aligned 24×24. Fixed retains size parity; wider Stretch remains full cross-axis.
9. Run `npm run cdp:design -- --output=<new-evidence-dir>`, visually inspect screenshots, then run standalone `npm run build` and reload the live page if it must end on production output.

**Review question:** Is the real Main/Settings appearance, 128 px host floor, 132 px clipped-host fallback, and control alignment accepted?

**Boundary:** Freeze design before host behavior. Do not treat fixture screenshots alone as host-window proof.

### Review milestone C — AE color behavior and palette interactions

#### Task R8 — Implement the read-only color collector

**Objective:** Collect exact supported AE colors without mutating the project or importing MTP's broad controller behavior.

**Files:** `src/jsx/aeft/aeft.ts`, `src/jsx/index.ts`, `tests/host-contract.test.mjs`, `scripts/cep-functional-smoke.mjs`.

**Steps:**
1. Require project, active comp, and selected layers.
2. For each selected layer, traverse selected properties/groups when present; otherwise traverse the whole selected layer. Preserve deterministic layer/path order.
3. Skip disabled branches by default; include them only from the explicit Settings preference.
4. Detect gradient groups by stable match/display-name evidence and count each once without recursing into internal stops. Count TextDocument colors as unsupported.
5. Isolate throwing getters, require finite components, preserve exact three/four-channel host values, and dedupe UI entries without rounding storage values.
6. Return typed statuses/counts; never alert and never call a mutating AE API.
7. Run `npm run test:host-contract`, `npm run check:cep`, and serial `npm run cdp:collect` against a uniquely prefixed disposable fixture.

**Gate:** Exact live collection passes for selected leaf, selected parent group, whole multi-layer fallback, disabled skip/include, gradients, HDR, and read-only before/after snapshots.

#### Task R9 — Implement exact static-property application and Undo

**Objective:** Apply stored colors only to writable static COLOR properties while preserving keyed/expression state and one deterministic Undo entry.

**Files:** `src/jsx/aeft/color-apply.ts`, Main apply handler, `tests/host-contract.test.mjs`, `scripts/cep-functional-smoke.mjs`.

**Steps:**
1. Resolve explicitly selected properties/groups only; do not silently broaden apply to unrelated whole-layer properties.
2. Preserve any property with `expressionEnabled` or `numKeys > 0`; increment `preservedStateCount`. Do not use `setValueAtTime()` in v1.
3. Skip gradients/TextDocument, isolate per-property failures, and return applied/skipped/failed counts.
4. Open one undo group only when writable targets exist and close it in `finally`.
5. Prevent overlapping/rapid host actions in Main; multiple rapid clicks produce one host call.
6. After the panel callback, perform applied-state snapshot, stable Undo command ID 16, and restored-state snapshot atomically in one follow-up `evalScript`. A separate readback call can displace the actionable Undo entry.
7. Run `npm run cdp:apply`; compare exact host-returned values and full pre/post/Undo snapshots.

**Gate:** Static values apply exactly; keyed/expression values, key structure, and expression text remain unchanged; one Undo restores the exact fixture; palette storage writes remain zero.

#### Task R10 — Implement remove, reorder, focus, and notices

**Objective:** Complete compact palette editing without accidental apply or write amplification.

**Files:** `src/js/main/main.tsx`, `src/js/main/main.scss`, `src/js/shared/palette-domain.ts`, `scripts/cep-functional-smoke.mjs`.

**Steps:**
1. Use one-click focusable remove plus explicit Enter/Space/Delete/Backspace handling and deterministic focus recovery.
2. Use stable IDs for keyboard and pointer/native-drag reorder in both orientations.
3. Preview reorder locally, persist once after a changed drop, restore on cancellation, and suppress the post-drag apply click.
4. Keep Main operation notices transient (current contract: 2.5 seconds). Storage errors disable mutations but do not block applying an already loaded swatch.
5. Run `npm run cdp:mutate`; assert one write per completed change, zero host calls for mutation, reload persistence, notice dismissal, and no apply after drag.

**Gate:** Remove/reorder behavior passes at minimum wide/tall layouts and after reload with stable focus/order.

### Review milestone D — full serial regression and truthful package

#### Task R11 — Run the full live matrix with safe fixture ownership

**Objective:** Prove the exact current development build across both panels without contaminating user state or confusing harness failures with product failures.

**Steps:**
1. Run AE preflight with real macOS HOME and prove the intended app/version, exact build URL/assets, extension IDs, ports, marker, and temporary-root state.
2. Recheck project identity/dirty state immediately before setup, each mutating scenario, Undo, and cleanup. Abort if ownership changes.
3. Run live commands serially in this order: `npm run cdp:self-test`, `npm run cdp:persistence`, `npm run cdp:settings`, `npm run cdp:design -- --output=<dir>`, `npm run cdp:collect`, `npm run cdp:apply`, `npm run cdp:mutate`.
4. Run `npm run test:domain`, `npm run test:host-contract`, `npm run check:cep`, `npm run react:doctor`, `npm run build`, and `git diff --check`.
5. Preserve and classify first failures. Known harness classes include stale loaded bundle after static build, reused temp-root state, undersized compositor edge repetition, AE-native extra nested colors that invalidate an overly strict fixture expectation, and transient target loss followed by a clean no-code-change retry.
6. Confirm exact-prefixed AE fixture cleanup, production config roots restored, runner temp directories removed, no runtime/console/log errors, and AE responsive.

**Review question:** Does the complete current build pass with credible product evidence and no hidden harness/state contamination?

**Boundary:** Stop for blocker-only review and design/code freeze before packaging.

#### Task R12 — Build and verify the unsigned internal alpha after freeze

**Objective:** Produce a current, production-like unsigned ZIP with provenance that matches the frozen source.

**Files:** `scripts/package-alpha.mjs`, `package.json`, `.gitignore`, `evidence/final-review/alpha-package-report.json`, `evidence/final-review/README.md`.

**Steps:**
1. Run the blocker-only review/fix loop; after any fix, rerun its focused check and the affected live smoke before refreezing.
2. Run `npm run package:alpha` only after source/design freeze.
3. Verify archive root `com.zimoby.chroma-relay/`, manifest XML, icon paths, ZIP integrity, and expected host files.
4. Reject `.debug`, source maps, development debug API/mutators, secrets, tests, evidence, and destructive reload/abort controls from the staged artifact.
5. Copy the generated report into durable evidence and independently record SHA-256, file size, source version, build time, and validation results.
6. Smoke the unpacked/installed payload on Mac. Do not describe it as signed or public-ready.
7. If source/config/design changes afterward, immediately label this report/SHA historical and schedule a new package after the next freeze.

**Gate:** Current source, report, archive, and SHA match; Mac installed smoke passes; no development surfaces ship.

#### Task R13 — Prove Windows before a cross-platform claim

**Objective:** Close the platform boundary that macOS cannot prove.

**Steps:**
1. On Windows, run the same missing/valid/malformed/temp/backup/interrupted replacement matrix against a disposable user-data root.
2. Verify rename-to-absent-final behavior, rollback, queue recovery, UTF-8 paths, and zero residue.
3. Validate the packaged Main/Settings identities, flyout launch, settings commit/event behavior, collection, static apply/Undo, and mutation smoke in a running supported AE version.
4. Verify installed payload hashes against the packaged artifact and preserve Windows report/screenshots.
5. Only then update README/package wording from “Mac-validated internal alpha” to an evidence-backed cross-platform claim.

**Gate:** Windows storage and packaged runtime pass. Failure is a release blocker, not permission to weaken persistence or silently overwrite files.

### Canonical completion commands

```bash
npm run test:domain
npm run test:host-contract
npm run check:cep
npm run cdp:self-test
npm run cdp:persistence
npm run cdp:settings
npm run cdp:design -- --output=<new-evidence-dir>
npm run cdp:collect
npm run cdp:apply
npm run cdp:mutate
npm run react:doctor
npm run build
git diff --check
npm run package:alpha
```

### Reopen rules

- If two-panel events fail, preserve the failure and prove disk recovery through the named seams before considering polling.
- If a static build leaves a checked-but-dead panel, prove renderer lifecycle and exact files/ports before editing product code or restarting AE.
- If the fresh 128 px manifest minimum is not enforced, record source manifest, generated manifest, outer bounds, and viewport; do not “fix” it with CSS alone.
- If Settings persistence can fail without visible actionable feedback, resolve the explicit error-only UX gate before external testing.
- If a requested screenshot exceeds the compositor, enlarge the real panel or reduce the fixture contract; never crop/synthesize a pass.
- If AE reports a second script is already running, stop and wait; do not retry unknown-completion work.
- If the active project/fixture identity changes, abort mutation and cleanup rather than touching unrelated user work.
- If Windows replacement semantics fail, keep Windows support blocked until storage is hardened and rerun.

---

## Historical appendix — original converged pre-implementation plan

> **Do not implement from this appendix.** It is preserved to explain the original intent and subsequent deviations. The canonical rebuild sequence above supersedes its AE 24 floor, 32 px Main width, Auto/Horizontal/Vertical Settings, old user-data path, keyed-property mutation, hover-first removal, and pre-freeze packaging instructions.

> Status: converged and ready for Task 0. This is a new extension, not a Motion Tools Pro fork; implementation has not started.

Two independent Codex/Claude review passes were completed. The first pass drove scope and architecture corrections; the second found only scaffold-provenance and live-preflight gaps, both resolved below.

## Decision

Adopt the idea with constraints:

- Build a new, small, open-source After Effects CEP extension on the pinned Bolt CEP 2.2.3 scaffold.
- Use two CEP panel surfaces in one extension bundle: `main` and `settings`.
- Keep the first release to one palette, one responsive single-axis view, exact color collection/application, remove, reorder, persistence, and cross-panel settings synchronization.
- Reuse Motion Tools Pro behavior lessons, but do not copy its large Redux/layout/settings architecture or its compiled host script.

## Goal

Create a compact color-palette extension that changes between horizontal and vertical layouts as its panel dimensions change. The user can collect colors from selected AE layers/properties with `+`, apply a stored color, remove colors, drag colors to reorder them, and open a companion Settings panel from the main panel flyout menu. Palette changes must survive main-panel reloads; settings must persist and synchronize one-way from Settings to Main without echo writes or stale-state overwrites.

## Evidence inspected

- Bolt CEP local checkout: `/Users/REDACTED/Documents/Dev_code/_Extensions_dev/bolt-cep` (local 2.2.0, reference only); npm packages `bolt-cep` and `create-bolt-cep` plus remote current version checked as 2.2.3.
- Bolt CEP README and `cep.config.ts`: supports multiple panel pages, explicit panel IDs, `requestOpenExtension`, React/TypeScript, and typed `evalTS()` host calls.
- Motion Tools Pro palette UI: `/Users/REDACTED/Documents/Dev_code/_Extensions_dev/motion_tools_pro/motion_tools_plugin_system/src/js/common/Widgets/Palette/index.tsx`.
- MTP palette persistence: `.../src/js/common/store/slices/scriptsData.slice.ts:645-823`.
- Readable MTP host implementation: `/Users/REDACTED/Documents/Dev_code/_Extensions_dev/motion_tools_pro/motion_tools_2025/src/jsx/motion_tools_basic.jsx:7570-7898`.
- MTP multi-surface events and write suppression: `.../src/js/common/hooks/Listeners/useSyncListeners.ts` plus `/Users/REDACTED/.hermes/profiles/ae-ops-worker/skills/software-development/ae-cep-support-runtime/references/cep-multisurface-sync-validation.md` and `cep-isolated-five-surface-sync.md`.
- MTP color exactness support evidence: plugins KB `source-materials/notes3/business/support/cases/motion-tools-pro/mtp-color-collect-palette-preview-mismatch-2026-05-15.md`.

## Working project identity

Until Denis chooses a public name, use:

- Working product name: `Chroma Relay`
- Planned repo: `/Users/REDACTED/Documents/Dev_code/_Extensions_dev/chroma-relay`
- Bundle ID: `com.zimoby.chroma-relay`
- Main extension ID: `com.zimoby.chroma-relay.main`
- Settings extension ID: `com.zimoby.chroma-relay.settings`

The public name and permanent bundle ID are a packaging decision; changing IDs after users install the extension breaks CEP identity and settings continuity, so lock them before the first shared ZXP.

## Architecture

### Foundation

- Scaffold with Bolt CEP 2.2.3, React, TypeScript, Sass, and After Effects only (`AEFT`). Pin generated dependencies and the lockfile rather than depending on an unbounded latest version.
- Set the initial host floor to After Effects 24.0 / CC 2024 so `ResizeObserver`, Pointer Events, and the generated Bolt runtime are tested against an explicit baseline.
- Configure two `Panel` entries in `cep.config.ts`; do not assume the current scaffold creates the settings page automatically because the current upstream config contains only `main` despite the README describing `main` plus `settings`.
- Use React state plus small domain hooks. Do not add Redux/Zustand for one palette and two settings.
- Use Bolt `evalTS()` for typed CEP-to-ExtendScript calls.

### Panels

1. `main` — compact palette UI; owns palette mutations.
2. `settings` — normal-width companion panel opened from the main flyout; owns settings mutations.

The settings surface is a second dockable CEP panel, not an in-panel modal and not a CEP `ModalDialog`. Configure it with `panelDisplayName: ""` and `autoVisible: false` so it is launched from the main flyout rather than appearing as a normal Extensions menu item. Give it a usable default/minimum geometry (target minimum 280 × 220) so the main palette never needs resizing to edit settings. The main panel minimum is 32 × 32, with explicit acceptance sizes at 32 × 32, 160 × 32, 32 × 160, and 200 × 200.

### State ownership and synchronization

Use two small versioned JSON documents under `CSInterface.getSystemPath(SystemPath.USER_DATA)/ChromaRelay/com.zimoby.chroma-relay/`:

- `palette.json`: `{ schemaVersion, revision, colors[] }`
- `settings.json`: `{ schemaVersion, revision, layoutMode }`

Color record:

```text
{ id: string, rgba: [number, number, number, number] }
```

Rules:

- Main panel is the only reader/writer of `palette.json`; the settings panel does not display or synchronize palette data in v1.
- Settings panel is the only writer of `settings.json`; main reads it and applies updates.
- Settings writes validated UTF-8 JSON first, then broadcasts `com.zimoby.chroma-relay.settings.changed` as an application-scoped `CSEvent` containing `schemaVersion`, integer `revision`, and the complete small settings snapshot.
- Main subscribes before its initial disk load. Both event and disk hydration pass through one revision gate, so a slower disk load cannot overwrite a newer event. Newer revision wins; equal revision with different content is treated as invalid and triggers a disk re-read; invalid/non-integer revisions are rejected.
- Parse `event.data` defensively because CEP may supply an object or encoded JSON string. Ignore malformed payloads. The main receiver updates memory only and never writes synchronized data, preventing echo-write races by construction.
- Recover missed events by re-reading `settings.json` at main startup, on `window.focus`, and on a throttled main-root `pointerenter`; treat `visibilitychange`/application-activation as optional extra signals, not the guarantee. Prove the actual live AE behavior in the architecture gate.
- Do not broadcast palette events, load palette data in Settings, or add `fs.watch`, polling, WebSockets, a background service, or leader election.
- Use a serialized, recoverable two-phase replacement per writer: write and close a unique same-directory temp file, rotate the current file to `.bak`, rename temp to the absent final path, then remove `.bak`; restore/read `.bak` on interrupted startup. Validate before write and after read. This avoids relying on replacing an existing destination with `rename` on Windows.
- Alpha supports one active AE process per user-data root. Two simultaneous AE versions are a documented limitation until a concrete conflict justifies file locking/optimistic concurrency.

### Flyout settings launch

- Bolt `initBolt()` currently calls `initializeCEP()`, which installs its own flyout and context-menu handlers. Customize the generated `init-cep.ts` to build one flyout and one listener rather than stacking a second handler after `initBolt()`.
- Include `Settings…` and `Refresh` in that flyout.
- Parse `com.adobe.csxs.events.flyoutMenuClicked` data defensively using Bolt's object/string handling pattern.
- On the exact menu ID, call `requestOpenExtension("com.zimoby.chroma-relay.settings", "")`.
- Keep the settings extension ID in one shared constant used by `cep.config.ts`, launch code, and tests; do not derive it by appending to the current panel ID at runtime.

### Responsive layout

- Observe the main panel content box with `ResizeObserver`.
- `layoutMode = auto`: horizontal when usable width is greater than or equal to usable height, otherwise vertical.
- Settings may override Auto with Horizontal or Vertical for testing/accessibility.
- Keep the palette single-axis: no grid and no wrap in v1.
- Put swatches inside a dedicated scrollable viewport. They share available space along the primary axis and fill the cross axis. If they would become smaller than the constant 24 px minimum, keep the minimum and scroll on the primary axis.
- Put the fixed 24 px `+` control outside the scrollable viewport so it cannot scroll out of view.
- Use stable color IDs as React keys; never use array indices once reorder is supported.

### Color collection and application

Write a new read-only collector in `src/jsx/aeft/aeft.ts`; do not copy MTP's large function because it includes controller-layer/global behavior and can remove disabled properties in some modes.

`collectSelectedColors()` v1 scope:

1. Require an active composition and at least one selected layer/property.
2. Prefer explicitly selected properties whose `propertyValueType === PropertyValueType.COLOR`, regardless of layer type.
3. If no color property is explicitly selected, recursively inspect each selected layer's property tree for readable `PropertyValueType.COLOR` properties. Use match-name/property-index paths, verify enabled properties/ancestors when that API exists, skip throwing getters individually, and never recurse into a precomp's source layers.
4. Return four finite AE color components in deterministic layer-index then property-index-path order, evaluated at the active composition time.
5. Dedupe only when all four components differ by no more than `1e-6`, preserving the first exact returned values. Do not clamp or quantize for dedupe. CSS preview conversion clamps a separate display copy to `[0,1]`; storage/application retain the host floats, including HDR values.
6. Return a typed result with `colors` plus a machine-readable empty/error reason (`no_comp`, `no_selection`, `no_supported_colors`). Do not alert from ExtendScript.

This generic property traversal covers Shape Fill/Stroke, Effect Color controls, and other real COLOR properties. Explicitly defer TextDocument fill/stroke fields, SolidSource color, nested-precomp source traversal, controller creation, global collection, and eyedropper/screen sampling until a real use case reopens them.

`applyColorToSelection(rgba)` v1 scope:

- Apply the exact four-component stored value inside one AE undo group guarded by `try/finally` so `endUndoGroup()` always runs.
- Prefer explicitly selected COLOR properties; otherwise use the same selected-layer COLOR traversal as collection.
- Skip expression-enabled properties with an explicit reason. For keyed properties call `setValueAtTime(comp.time, rgba)`; for static properties call `setValue(rgba)`. Catch failures per property so one target does not abort the rest.
- Return applied/skipped counts and categorized reasons; do not silently report success on a no-op.
- Live exactness means reading the property back through ExtendScript and comparing against AE's returned four floats, with `1e-7` test tolerance for host round-trip quantization; it does not mean the CSS preview is color-managed identically to AE.

### Main-panel interactions

- `+`: call `collectSelectedColors()`, append newly deduped colors, and persist once. Palette changes stay local to the main panel in v1.
- Swatch click: call `applyColorToSelection()` with the exact stored RGBA value.
- Remove: show a compact focusable remove affordance on hover/focus and support Delete/Backspace on a focused swatch. Do not add a CEP per-swatch context menu because Bolt already owns a panel-wide context menu path.
- Reorder: use a small pointer/native-drag implementation with stable IDs. Update local preview during drag, but persist only once on drop. Suppress the click-to-apply action after a completed drag.
- Empty state: show the `+` control and one short instruction; do not introduce onboarding screens.

## Planned repository files

```text
chroma-relay/
├── cep.config.ts
├── package.json
├── README.md
├── src/
│   ├── js/
│   │   ├── main/
│   │   │   ├── index.html
│   │   │   ├── index-react.tsx
│   │   │   ├── MainPanel.tsx
│   │   │   └── main.scss
│   │   ├── settings/
│   │   │   ├── index.html
│   │   │   ├── index-react.tsx
│   │   │   ├── SettingsPanel.tsx
│   │   │   └── settings.scss
│   │   └── shared/
│   │       ├── constants.ts
│   │       ├── types.ts
│   │       ├── validation.ts
│   │       ├── storage.ts
│   │       ├── settings-events.ts
│   │       ├── flyout.ts
│   │       ├── usePaletteState.ts
│   │       └── useSettingsConsumer.ts
│   └── jsx/
│       └── aeft/
│           ├── aeft.ts
│           └── color-properties.ts
└── tests/
    ├── layout.test.tsx
    ├── palette-reducer.test.ts
    ├── storage.test.ts
    ├── events.test.ts
    ├── flyout.test.ts
    └── fixtures/
```

Final scaffold filenames may vary slightly with Bolt 2.2.3; after scaffolding, update this plan to the generated paths rather than forcing stale template names.

## Implementation tasks

## Task 0 — Smallest reversible architecture gate

Preflight before scaffolding: verify Adobe After Effects 2024 or newer is installed, `PlayerDebugMode=1` for the active CSXS generation, ports 8198–8199 are free, and Bolt's build/dev command creates the CEP symlink. This Mac currently passes the install, CSXS.11/12 debug-mode, and free-port checks; re-run them because system state can change.

Before host scripting, prove the risky architecture with:

1. Bolt main + settings panels.
2. Three hardcoded colors in the main panel.
3. Auto horizontal/vertical rendering at the four explicit geometry fixtures, with a fixed `+` outside the swatch scroller.
4. Settings flyout launch.
5. Settings change synchronized to main with one writer and no echo write.
6. Missed-event recovery from a temporary config root through the named focus/pointerenter seam.
7. One instrumented write and one event per settings change.

This gate comprises the minimal parts of Tasks 1, 3, 4, 5, and 6. Execute it first and stop there for review. Preserve the working gate implementation when completing the uncovered acceptance criteria in Tasks 1–6. Only after the gate works in live AE should host collection/application and drag/drop be added.

### Task 1 — Scaffold and freeze the two-panel contract

- Scaffold from npm with `npx create-bolt-cep@2.2.3`; do not copy the local 2.2.0 checkout. Create the React project at the planned repo path and commit its generated dependency lockfile when implementation is approved.
- Restrict hosts to AEFT 24.0+ and configure the explicit main/settings IDs, geometry, visibility, and `startingDebugPort: 8198` (main 8198, settings 8199 for one AEFT host).
- Add the settings page manually if the generator omits it.
- Add a manifest/config test asserting exactly two extension IDs and distinct page/debug entries.
- Run the untouched scaffold build before feature code.

Acceptance: both pages build; generated manifest contains exactly the expected main and settings IDs.

### Task 2 — Define schemas, validation, and pure mutations

- Add the palette/settings types, schema version, validators, defaults, and pure add/remove/reorder/settings-patch functions.
- Add tests for stable IDs, epsilon dedupe that preserves the first exact float values without clamping HDR values, invalid RGBA, invalid JSON, unknown schema versions, no-op reorder, and revision increments.

Acceptance: all domain behavior passes without CEP or AE.

### Task 3 — Add owner-specific recoverable storage

- Resolve the explicit namespaced user-data folder through CEP APIs and expose a test-only root override.
- Implement owner-specific `loadPalette/savePalette` and `loadSettings/saveSettings` functions.
- Validate before and after persistence.
- Serialize writes per owner and expose a test-only write counter.
- Add temporary-root tests for missing, valid, malformed, interrupted, temp, and backup files.

Acceptance: each surface can persist only its owned segment; malformed data is reported and never silently replaced.

### Task 4 — Add one-way application-scoped settings synchronization

- Add one typed, namespaced settings CSEvent publisher/subscriber and defensive object/string data parsing.
- Subscribe before initial settings hydration, then reconcile disk/event payloads through the same revision gate.
- Add `window.focus` plus throttled root `pointerenter` disk recovery; treat other CEP/DOM lifecycle signals as optional until live proof exists.
- Test that an incoming setting updates main memory but never invokes a write, a setting change produces exactly one disk write and one event, stale/invalid/equal-conflicting revisions are handled as specified, and listener cleanup is exact.

Acceptance: mocked settings/main contexts converge one-way without echo writes, and the recovery handlers are directly triggerable in tests.

### Task 5 — Build and test the Settings panel plus flyout launch

- Add only Auto/Horizontal/Vertical controls in v1; keep the 24 px minimum swatch size constant.
- Customize Bolt's generated CEP initialization to register one main-panel flyout and open the exact configured settings extension ID without duplicate listeners.
- Keep settings UI independent of main-panel dimensions.

Acceptance: changing a setting updates the main context immediately, records exactly one write/event, and survives both panel reloads.

### Task 6 — Build responsive palette rendering

- Render one palette strip plus fixed `+` control.
- Add `ResizeObserver` orientation logic, forced-mode overrides, minimum-size overflow, and empty state.
- Test 160 × 32, 32 × 160, 200 × 200, and 32 × 32 dimensions. Assert the swatch viewport scrolls independently while `+` remains visible.

Acceptance: no clipped `+` button; deterministic horizontal/vertical behavior; no grid/wrap.

### Task 7 — Implement the read-only AE color collector

- Add pure traversal helpers and `collectSelectedColors()` in the Bolt typed ExtendScript layer.
- Cover selected color property precedence, generic selected-layer COLOR traversal, enabled/disabled and throwing properties, deterministic layer-index/property-path order, four-finite-value validation, HDR preservation, epsilon dedupe, and typed no-result states.
- Build the ES3 host bundle and inspect the emitted function registration.

Acceptance: no collector path mutates AE; static tests/build pass.

### Task 8 — Implement exact color application

- Add `applyColorToSelection()` with one guaranteed-close undo group, keyed/static behavior, expression skips, per-property failure isolation, and structured counts.
- Wire swatch click through `evalTS()`.
- Add UI pending/error state so repeated clicks cannot overlap host actions.

Acceptance: read-back values match AE's returned floats within `1e-7`, keyed values are written at comp time, expression-driven targets are skipped visibly, and no-op results are visible.

### Task 9 — Implement remove and drag reorder

- Add the hover/focus remove affordance and Delete/Backspace keyboard behavior; do not add a CEP swatch context menu.
- Add stable-ID drag reorder for both orientations.
- Persist once on drop, not on every pointer movement; assert the storage write counter increments once.
- Prevent an apply click after drag.

Acceptance: reorder survives main-panel reload; deletion works at 32 × 32 and keyboard focus remains usable.

### Task 10 — Live AE two-surface validation

Run serially in a disposable comp:

1. Prove main/settings pages are the expected dev build via CDP URL, extension ID, version, and script assets.
2. Open Settings from the main flyout.
3. Resize main wide and tall; capture DOM rects/screenshots.
4. Create/select Shape Layers with known Fill/Stroke floats.
5. Click `+`; verify exact returned and stored values.
6. Reorder and remove; reload main; verify persistence/order and one write per completed action.
7. Change layout settings; verify immediate main-panel update and no repeated writes/events.
8. Apply a swatch to static, keyed, expression-driven, and partially failing targets; query AE properties and prove read-back tolerance plus one undo operation.
9. Suppress/detach the settings event in the test seam, then prove `window.focus` or root `pointerenter` recovers from disk in live AE.
10. Interrupt/seed the temp-backup storage states and prove recovery on Mac. Run the same replacement/recovery fixture on Windows before any public cross-platform package claim.

Acceptance: one retrievable JSON/log evidence file plus screenshots, with production user settings untouched by using a temporary config-root seam during automated sync tests.

### Task 11 — Package the webinar-ready alpha

- Write a short README with install/dev commands, supported collection scope, and explicit deferred features.
- Build the unsigned debug package and a test ZXP only after the live dev build passes.
- Do not add licensing, analytics, update checks, cloud sync, or a store pipeline.

Acceptance: clean build, tests, and Mac AE smoke. The alpha artifact is Mac-validated; Windows storage/runtime validation is mandatory before describing a later package as cross-platform.

## Explicit non-goals for v1

- Multiple named palettes or palette libraries.
- Import/export/share/cloud/community backend.
- Color generation, harmonies, gradients, eyedropper, or screen sampling.
- MTP controller layers, expressions, local/global modes, recursive precomps, or disabled-property cleanup.
- Redux, a generalized synchronization framework, WebSockets, polling, file watching, or a resident background process.
- Licensing, telemetry, update system, payments, or marketplace release work.
- Reusing MTP product code wholesale.

## Stop and reopen rules

- If two-panel CSEvents are unreliable in live AE, stop and capture evidence before adding polling; first prove disk reload through the named focus/pointerenter seam.
- If temp-file replacement is not reliable on both platforms, classify storage hardening as a release blocker; do not silently fall back to unvalidated overwrites.
- If users need TextDocument fields, SolidSource color, or nested-precomp source traversal, reopen host scope with a concrete fixture and expected order; do not add special cases by default.
- If responsive orientation oscillates near square sizes, add a small hysteresis threshold only after reproducing it.
- If native/pointer drag behavior is unreliable in CEP, adopt one small sortable dependency only after a live failure demonstrates the need.

## Open decisions that do not block the first slice

- Final public product name and permanent bundle ID.
- Visual branding and default empty-state copy.
- Whether a later release should support AE versions older than the explicit CC 2024 baseline.
- Whether TextDocument fields, SolidSource color, or nested-precomp sources enter a later release.
- Whether simultaneous writes from two running AE versions must be supported.
