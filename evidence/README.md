# Chroma Relay evidence index

Evidence is preserved by milestone. A failed runner output is evidence that a gate failed closed; it is not a product pass.

## Authoritative milestone evidence

- I01: `i01/README.md` — two-panel runtime scaffold.
- I02: `i02/README.md` and `i02-fail-closed/README.md` — exact-target inspection and fail-closed behavior.
- I03: `i03/comparison.png`, `i03/seam/contact-sheet.png` — selected Seam direction.
- I04: `i04/README.md` — responsive real-surface and live wide/tall captures.
- I05: `i05/README.md`, `i05/settings-smoke/report.json`, and `i05/responsive/settings/report.json` — schema-v1→v2 Settings migration, disabled-color preference synchronization, fixed Add size/adjacency, and current Settings visual proof.
- I06: `i06/persistence-smoke-attempt-3/report.json` — original persistence milestone pass. Superseded for recovery hardening by `final-review/persistence-storage-guard/report.json`.
- I07: `i07/host-smoke/report.json` — live AE selected-property/group, whole multi-layer, and disabled-branch collection pass. `i07/host-smoke/failure.json` preserves the corrected obsolete no-selection-copy expectation after Plus became image-aware.
- I08: `i08/apply-smoke/report.json` and `i08/apply-smoke/main-applied.png` — live AE exact apply/readback, keyed/expression preservation, rapid-click deduplication, and exact single-Undo restoration pass. The earlier `failure.json` is retained as corrected-harness evidence.
- I09: `i09/mutation-smoke/report.json` — live one-click/keyboard remove, auto-clearing notice, reorder, and persistence pass.
- I10: `i10/design-matrix-pass-2/main/report.json` and `i10/design-matrix-pass-2/settings/report.json` — exact I11 strict four-viewport/state/native/Settings matrix pass; `i10/design-matrix-pass-2/fixtures-contact-sheet.png` and `i10/design-matrix-pass-2/states-contact-sheet.png` — reviewed visual proof; `i10/settings-smoke/report.json`, `i10/persistence-smoke-final/report.json`, and `i10/mutation-smoke-final-2/report.json` — final regression passes. `i10/design-matrix-current/main/failure.json` preserves the original undersized compositor refusal, `i10/design-matrix-pass/main/failure.json` preserves the stale-temp-root harness finding corrected before the pass, and `i05/settings-smoke/failure.json` preserves one transient pre-retry CEP target crash.
- I11/final review: `final-review/README.md`.

## Post-I11 design-hardening evidence

- `local/unified-background/` — exact-target Main/Settings reports and screenshots after both surfaces were unified on the AE-native background.
- `local/settings-no-status/` — exact-target reports and screenshots proving the rendered Settings footer/status was removed without panel identity or runtime errors.
- `local/min-width/responsive-128/` — passing current 128×32, 160×32, 128×160, and 200×200 matrix, four state previews, native Main capture, Settings capture, and geometry assertions.
- `local/min-width/direct-80.png` through `direct-136.png` — live floating-window width sweep showing the already-open host frame could remain below the new manifest minimum.
- `local/min-width/add-left-79.png` — preserved pre-reload/fallback screenshot where the Add glyph still tracked the clipped 132 px layout center.
- `local/min-width/add-left-79-production.png` — authoritative final production screenshot at the unchanged 79 px outer window, with the Fixed Add control fully visible and left-aligned.
- `local/image-extraction/live-smoke/report.json` — six passing Project-panel JPEG/PNG cases across Balanced, Tonal, and Contrast.
- `local/image-extraction/selection-smoke/report.json` and `main-selection-gates.png` — six passing layer-source, identity-deduplication, mixed/multiple, unsupported, and corrupt-image cases with self-cleaning AE fixtures.
- `local/image-extraction/selection-smoke/investigation.md` — preserved exact failures and repairs for false still-layer colors, unavailable ExtendScript `Object.keys`, and corrected harness assumptions.
- `local/palette-management/milestone-a/report.json` and screenshots — live Main drag reorder, Alt/Option removal, and explicit remove-mode proof at wide and tall geometries.
- `local/palette-management/milestone-c/visual-report.json` and screenshots — reviewed General/Palettes Settings layouts at normal and compact sizes.
- `local/palette-management/management-smoke/report.json` and `final-settings.png` — passing temporary-root create/rename/select/reorder/remove/two-step-delete flow; seven Main writes, zero Settings writes, zero host calls, and exact RGBA preservation.

The first `local/min-width/responsive-128/main/failure.json` records a stale loaded panel rejecting the new 128×32 fixture before page reload. The same build passed after the panel loaded the current bundle; it is preserved as harness/runtime-load evidence, not a product failure.

## React Doctor

Milestone reports are stored under `i07/`, `i08/`, `i09/`, and `i10/`. The final bounded run is `react-doctor.txt`. It completed with no correctness errors; because that run was offline, React Doctor did not calculate a score and reported 55 warnings dominated by custom Vite/ExtendScript entry false positives and non-blocking component-size/state suggestions.

## Evidence policy

- Reports from isolated temporary roots do not touch production user data.
- Failure JSON and first failed attempts are retained when they explain a corrected harness or a blocked prerequisite.
- Generated `dist/` artifacts are not the durable evidence source; the final package report is copied to `final-review/alpha-package-report.json`.
- `final-review/alpha-package-report.json` is historical proof for the pre-hardening I11 archive. It is not current package proof after the post-I11 UI, manifest, fixture, and Add-alignment changes.
