# Chroma Relay implementation status

Date: 2026-07-17
Candidate version: 0.0.1 unsigned internal alpha
Host floor: After Effects 22.0
Current phase: post-I11 image extraction and multi-palette management implemented and live-validated on macOS; restart/Windows gates and refreshed unsigned package pending

Canonical from-scratch rebuild plan, current reconciliation, and historical Tasks 0–11 appendix: `docs/implementation-plan.md`.

## Milestone checklist

- [x] I01 — openable Main and hidden Settings CEP panels.
- [x] I02 — strict CDP identity and fail-closed runtime inspection.
- [x] I03 — selected Seam visual direction and state fixtures.
- [x] I04 — responsive horizontal/vertical Main layout.
- [x] I05 — Settings-owned Stretch/Fixed swatch sizing with live synchronization.
- [x] I06 — versioned palette domain, exact RGBA persistence, serialized writes, interrupted-write recovery, and malformed-file preservation.
- [x] I07 — deterministic recursive selected-property/group and whole selected-layer color collection across multiple layers, configurable disabled-branch parsing, exact floats, and HDR values; validated in live AE.
- [x] I08 — exact selected-target color application, rapid-click deduplication, preserved keyed/expression state, and one balanced undo group passed through the actual Main panel in live AE 26.3. Stable Undo command ID 16 restored the exact pre-apply snapshot.
- [x] I09 — compact one-click/keyboard remove, transient notices, keyboard reorder, pointer drag reorder, persistence, and focus behavior.
- [x] I10 — strict 32×32, 160×32, 32×160, and 200×200 design matrix; interaction/empty/disabled/error/native Main states; Settings capture; settings synchronization; persistence; and mutation regressions passed on the exact I11 panels.
- [x] I11 — blocker-only CLI review/fix loop, release hardening, production verification, and unsigned internal-alpha package.

The I01-I11 candidate completed all planned live acceptance gates. The current post-I11 runtime is suitable for continued internal testing, but the earlier unsigned ZIP predates the design-hardening changes and is not the current distributable candidate.

## Post-I11 design-hardening checklist

- [x] Unified Main and Settings on the same AE-native `#1c1d1f` panel background; Settings uses separators instead of a raised card/container.
- [x] Kept Settings feedback in a low-priority footer while palette controls remain compact and scroll-safe.
- [x] Raised Main's declared minimum width from 32 px to 128 px while retaining the 32 px minimum height.
- [x] Replaced the obsolete 32 px-wide runtime fixtures with the current 128×32, 160×32, 128×160, and 200×200 matrix.
- [x] Added strict geometry assertions that the Add control remains at least 24×24 px and fully inside every fixture.
- [x] Investigated the already-open floating-panel edge case from 136 px down to 79 px outer width. AE allowed the existing window below the new manifest minimum while its internal CEP viewport remained 132 px wide.
- [x] Kept Fixed mode's Add control equal to the configured swatch size and left-aligned in vertical layouts.
- [x] At the 132 px internal minimum, made vertical Stretch mode use a left-aligned 24×24 px Add control so further host-frame clipping cannot move `+` beyond the visible boundary.
- [x] Verified the final production panel at the user's unchanged 79 px outer window: Fixed Add was fully visible at the left edge with the glyph centered; a non-persistent Stretch probe measured 24×24 px at x=2.
- [x] Rebuilt the canonical production bundle successfully after the final minimum-width CSS change.

## Clarified boundaries

- `minWidth: 128` is a host declaration, not a CSS viewport guarantee. It did not retroactively enlarge the already-open 79 px floating panel during the live investigation.
- The live CEP content viewport floored at 132 px while the outer AE window continued shrinking. The 132 px CSS breakpoint is intentionally based on that measured internal viewport, not the 128 px manifest value.
- The extension content remains safe below the declared host minimum, but AE's native floating-window title can still clip when an old window is already narrower than 128 px.
- Fresh close/reopen enforcement of the 128 px host minimum has not yet been verified and remains a separate live gate.
- Settings displays concise mutation/save feedback in a low-priority footer without changing the panel hierarchy.

## Implemented contracts

### Palette persistence

- Schema version 2 stores named palettes, one active palette, and exact numeric RGBA values including HDR/out-of-range finite values.
- Schema-v1 palette files migrate in memory to one active `Palette 1` and are rewritten only on the next successful mutation.
- Main is the sole palette writer. Settings loads read-only state and sends revisioned commands through the palette event bridge.
- Writes are queued and use verified temp → final replacement with backup recovery.
- A verified temp wins after an interrupted replacement; an invalid temp cannot mask a valid backup.
- An invalid primary is never overwritten by `savePalette`; the original bytes are preserved and mutations are write-protected.

### AE host behavior

- Collection traverses selected properties/groups recursively; when a selected layer has no selected properties, it traverses that whole layer. Multiple selected layers are combined.
- Disabled layers/groups are skipped by default and included only when the schema-v3 Settings preference is enabled; schema-v1/v2 snapshots migrate with the preference off and Balanced extraction.
- Collection is read-only and deduplicates UI entries without rounding stored floats.
- Unified Plus resolution accepts one file-backed still JPEG/PNG from Project selection or a selected composition layer, deduplicated by file identity.
- Whole-layer color recursion is skipped for selected still-image layers during unified Plus resolution so internal layer properties cannot create false mixed selections; explicitly selected color properties still count as colors.
- Apply remains scoped to selected supported target properties.
- Apply uses one balanced undo group and preserves keyed/static/expression behavior according to the host contract.
- Host source remains ExtendScript-compatible and the generated host bundle is checked for AE 22 compatibility.

### UI behavior

- One responsive swatch rail switches orientation from measured panel geometry.
- Stretch and Fixed sizing remain Settings-owned and synchronized; Fixed places an equally sized, left-aligned Add button after the final color.
- Main declares a 128 px minimum width. The current responsive matrix is 128×32, 160×32, 128×160, and 200×200.
- At the measured 132 px internal viewport floor, vertical Stretch uses a compact left-aligned 24 px Add button as a clipped-host fallback.
- Click applies a swatch; Plus collects selected AE colors or extracts up to five colors from one selected JPEG/PNG.
- Alt/Option-click removes directly; the compact × control enables explicit pointer/keyboard remove mode.
- Transient operation notices clear after 2.5 seconds.
- Arrow controls and pointer drag reorder colors with persisted revisions.
- Storage errors disable mutations while leaving swatch application available.
- Settings provides flat General/Palettes tabs with palette create/select/rename/two-step-delete and color reorder/remove controls.

### Release behavior

- Production artifacts omit `.debug`, source maps, and `window.__CHROMA_RELAY_DEBUG__`.
- The panel context menu no longer exposes `process.abort()`.
- A real 32×32 CEP icon is copied and all manifest icon references resolve.
- `yarn package:alpha` creates and verifies an unsigned ZIP rooted at `com.zimoby.chroma-relay/`.

## Validation status

I01-I11 passed on 2026-07-17:

- `yarn test:domain` — 4/4 tests.
- `yarn test:host-contract` — 5/5 tests.
- `yarn check:cep` — AEFT 22.0, Chrome 74, host bundle and source scan passed.
- `yarn cdp:self-test` — exact target, wrong page, duplicate page, and wrong runtime ID cases passed.
- `yarn cdp:persistence` — missing/valid/malformed/temp/backup/interrupted/invalid-temp and queued-write cases passed in an isolated temporary root.
- `yarn cdp:collect` — selected properties, nested selected groups, whole multi-layer traversal, disabled-branch skip/include, exact persistence, and read-only snapshots passed in live AE 26.3.
- `yarn cdp:apply` — actual Main-panel click applied exact RGBA to one static property, preserved expression/keyframed properties, collapsed rapid clicks to one host call, performed no disk write, and restored the exact snapshot with one Undo.
- `yarn cdp:mutate` — one-click and Space-key removal, reorder persistence, zero host calls, and notice auto-dismiss passed.
- `yarn cdp:design -- --output=evidence/i10/design-matrix-pass-2` — exact I11 Main and Settings targets passed the four viewport fixtures, four state previews, native capture, geometry assertions, zero-error console/log checks, and visual screenshot review.
- `yarn cdp:settings` — live schema-v1→v2 migration, disabled-color checkbox synchronization, exact write/event counters, fixed Add parity/adjacency at 32 and 40 px, reload recovery, and Stretch restoration passed. One immediately preceding CEP target crash is preserved as transient failure evidence; the clean retry completed without product-code changes.
- `yarn react:doctor` — completed with no correctness errors; the final offline run could not calculate a score and reported 55 warnings, primarily custom-entry false positives plus non-blocking component-size/state suggestions.
- `git diff --check` — passed.
- Targeted final Codex review after repairs — `OK TO DEPLOY` for the blocker-fix paths.
- Unsigned archive integrity, manifest XML, icon existence, forbidden-file scan, debug-surface scan, ZIP test, and SHA-256 verification — passed.

Post-I11 design hardening passed on 2026-07-17:

- `yarn cdp:inspect -- --output=evidence/local/unified-background` — both exact panel targets passed after the unified-background refinement.
- `yarn cdp:inspect -- --output=evidence/local/settings-no-status` — Settings rendered without the persistent footer/status node and both exact targets remained error-free.
- `yarn cdp:design -- --output=evidence/local/min-width/responsive-128` — the updated 128×32, 160×32, 128×160, and 200×200 matrix, state previews, native Main, and Settings capture passed.
- Live AX/window-ID/CDP investigation — existing Main window narrowed from 136 px through 79 px outer width while CEP reported a 132 px internal viewport floor.
- Final live production screenshot — `evidence/local/min-width/add-left-79-production.png` shows the Add control fully visible and left-aligned at the 79 px outer-window edge case.
- Computed-style probe at the 132 px CEP floor — Fixed measured 31×31 px at x=2; temporary Stretch measured 24×24 px at x=2 and the real Fixed state was restored immediately.
- `yarn run build` — TypeScript, Vite, manifest generation, and asset copy passed after the final CSS change.

Post-I11 image palette extraction passed on 2026-07-17:

- `npm run test:domain` — 11/11 tests.
- `npm run test:host-contract` — 6/6 tests.
- `npm run check:cep` — AEFT 22.0/Chrome 74 checks passed, including a generated-host-bundle guard against unavailable ExtendScript `Object.keys`.
- `npm run cdp:image` — Project-panel JPEG and PNG passed Balanced, Tonal, and Contrast with five colors, one host call, one palette write, and zero runtime errors in all six cases.
- `npm run cdp:image-selection` — selected layer source, Project/layer identity deduplication, multiple selection, mixed COLOR + image, unsupported GIF, and corrupt PNG passed all six live cases. Rejection/error cases made zero palette writes and cleanup removed all owned AE fixtures.
- `npm run cdp:collect` — legacy selected-color collection passed after recreating and removing its known fixture; the image-aware no-selection message was verified.
- `npm run build` — the 51-module production build passed; the reloaded Main panel exposed no debug API and kept Plus visible.
- Evidence: `evidence/local/image-extraction/live-smoke/`, `evidence/local/image-extraction/selection-smoke/`, and `evidence/i07/host-smoke/report.json`.

Post-I11 palette management passed on 2026-07-17:

- `pnpm run test:domain` — 14/14 tests, including v1→v2 migration, palette CRUD, exact edge reorder, deduplication, and deep cloning.
- `pnpm run test:host-contract` — 6/6 source contracts, including Settings read-only palette access and Main-owned command/result events.
- `pnpm run check:cep` — AEFT 22.0 and Chrome 74 compatibility passed across 18 scanned source files.
- `pnpm run cdp:palette-management` — create, rename, select, reorder, remove, select, and two-step delete converged through both real CEP panels in a temporary root; Main wrote exactly seven times, Settings zero, and neither panel called the AE host.
- `pnpm run cdp:persistence` — migration, recovery, malformed-data protection, serialized writes, and deterministic disk re-read passed in an isolated temporary root.
- Evidence: `evidence/local/palette-management/` and `evidence/i06/persistence-smoke/report.json`.

Historical I01-I11 blocked live gates: none.

## Current next-step gates

- [ ] Prove palette persistence through a full AE restart. In-session reload/storage is proven; restart recovery is not.
- [ ] Validate Windows path decoding and the Windows CEP image decoder before a cross-platform image-extraction claim.
- [ ] Live-test a physically missing selected image source separately; corrupt decode and unsupported-format rejection are already proven.
- [ ] Close and reopen Main in live AE to verify a fresh host instance enforces the declared 128 px minimum width. This requires an explicit UI-operation decision because the current 79 px window is preserved evidence.
- [ ] Establish the repository's first Git baseline/commit when Denis approves committing. Resolve the current dual-lockfile state in favor of npm/`package-lock.json`; the repository currently has no `HEAD` and all project files are untracked.
- [ ] After the next code/design freeze, rerun the focused checks and `npm run package:alpha`; replace `evidence/final-review/alpha-package-report.json` and record the new SHA-256. The previous report is historical I11 evidence only.
- [ ] Run the storage/replacement and runtime fixture on Windows before making any public cross-platform package claim.

Current source/runtime blockers: none. Current distributable-package gate: pending refreshed alpha package.

## Package provenance clarification

`evidence/final-review/alpha-package-report.json` and SHA-256 `015de5df5a7c49aaa4a331f5a8dc531977fe4e0e12af6a8628f076dc0cd40f85` prove the pre-hardening I11 package only. Subsequent Settings, background, manifest-minimum, fixture, and Add-alignment changes mean that archive must not be presented as the current candidate. The latest normal build also cleared `dist/alpha`, so no current unsigned ZIP exists in `dist/`.

## Exact implementation surface

Git has no `HEAD` and all project files are untracked, so an objective baseline diff does not exist. The exact bespoke I06–I11 implementation/test/package surface is:

Configuration and build:

- `.gitignore`
- `cep.config.ts`
- `package.json`
- `package-lock.json`
- `yarn.lock`
- `tsconfig-build.json`
- `tsconfig.json`
- `vite.config.ts`
- `vite.es.config.ts`

CEP UI and shared domain:

- `src/assets/chroma-relay-icon.svg`
- `src/assets/chroma-relay-icon.png`
- `src/js/lib/utils/init-cep.ts`
- `src/js/main/index-react.tsx`
- `src/js/main/main.tsx`
- `src/js/main/main.scss`
- `src/js/settings/index-react.tsx`
- `src/js/settings/settings.tsx`
- `src/js/settings/settings.scss`
- `src/js/shared/debug-api.ts`
- `src/js/shared/layout-settings.ts`
- `src/js/shared/palette-domain.ts`
- `src/js/shared/palette-events.ts`
- `src/js/shared/palette-storage.ts`

ExtendScript host:

- `src/jsx/index.ts`
- `src/jsx/aeft/aeft.ts`
- `src/jsx/aeft/color-apply.ts`
- `src/jsx/aeft/tsconfig.json`

Automation and tests:

- `scripts/ae-i07-i08-setup.jsx`
- `scripts/ae-i07-i08-cleanup.jsx`
- `scripts/cep-cdp.mjs`
- `scripts/cep-design-capture.mjs`
- `scripts/cep-functional-smoke.mjs`
- `scripts/cep-palette-management-smoke.mjs`
- `scripts/cep-persistence-smoke.mjs`
- `scripts/check-cep-compat.mjs`
- `scripts/package-alpha.mjs`
- `scripts/run-react-doctor.mjs`
- `tests/palette-domain.test.ts`
- `tests/host-contract.test.mjs`

Documentation/evidence indexes:

- `README.md`
- `CONTRIBUTING.md`
- `docs/STORAGE.md`
- `docs/design-direction.md`
- `docs/implementation-plan.md`
- `docs/implementation-status.md`
- `evidence/README.md`
- `evidence/final-review/README.md`
- `evidence/final-review/alpha-package-report.json`

## Final review fix inventory

The blocker-only review/fix loop changed these exact paths:

- `.gitignore` — excludes `.env.production`, `dist`, and local runtime output.
- `cep.config.ts` — AE 22 floor, real icon references, copied icon asset.
- `package.json` — focused checks and unsigned-alpha packaging command.
- `scripts/cep-persistence-smoke.mjs` — recovery ordering and storage-layer malformed-write regression.
- `scripts/package-alpha.mjs` — raw-build and staged-artifact validator plus unsigned archive builder.
- `src/assets/chroma-relay-icon.svg`
- `src/assets/chroma-relay-icon.png`
- `src/js/lib/utils/init-cep.ts` — removed destructive Force Reload menu item.
- `src/js/main/index-react.tsx` — current I11 runtime load marker.
- `src/js/main/main.tsx` — storage-error mutation guard.
- `src/js/settings/index-react.tsx` — current I11 runtime load marker.
- `src/js/shared/debug-api.ts` — current I11 build marker.
- `src/js/shared/palette-storage.ts` — deterministic recovery and storage-layer invalid-primary protection.
- `vite.config.ts` — release sanitizer/source-map suppression and awaited ExtendScript build.
- `vite.es.config.ts` — returns the host build promise and suppresses release host source maps through the unified package flag.
- `README.md`
- `docs/implementation-status.md`
- `evidence/README.md`
- `evidence/final-review/README.md`
- `evidence/final-review/alpha-package-report.json`
