# I03 Design Direction

Status: Seam selected and frozen for I04. Index is retained below only as review history; its runtime code was removed. The selection used the documented agent fallback after the review prompt timed out and remains open to a later Denis override.

## Product shape

Chroma Relay is a compact AE utility. Color swatches are the interface, not content inside a surrounding dashboard. Main therefore has no title bar, cards, onboarding panel, in-panel Settings button, decorative illustration, or orientation choice. Settings uses compact flat General/Palettes tabs for layout and palette management. Main derives orientation automatically from its dimensions.

## Shared rules

- Dark-first and visually native beside After Effects.
- Flat structure with 1 px boundaries, small spacing, and square or 2 px geometry.
- System UI font only; text appears only for empty/error feedback and Settings.
- Swatches keep exact display color and carry the visual energy.
- One cool functional focus accent; muted red only for errors.
- 24 px minimum interactive target; `+` remains a separate fixed control.
- 80 ms linear state transitions; no decorative movement.
- Visible keyboard focus, compact remove affordance, and distinct selected/drag-ready marker.
- Main derives horizontal/vertical orientation from its measured dimensions with `ResizeObserver`; there is no manual mode.

## Approved direction — Seam

A continuous color rail with 1 px dark seams. Swatches read as one precise strip rather than separate cards. The fixed `+` is a quiet graphite control separated from the colors by 2 px.

Frozen tokens:

| Token | Value |
|---|---|
| Background | `#1c1d1f` |
| Surface | `#26282b` |
| Separator | `#111214` |
| Text | `#d8dadd` |
| Muted text | `#8f9398` |
| Focus | `#9ac9e4` |
| Error | `#e06d6d` |
| Spacing | 2 px outer, 1 px swatch seam |
| Interaction timing | 80 ms linear |

Strength: maximum color area and minimum chrome. Risk: adjacent similar colors may need stronger separation.

## Rejected review direction — Index

Separated technical sample wells with 3 px gutters and a restrained cool-blue index mark. The functional mark appears on selected state and the `+` control, not as general decoration.

Candidate token differences:

| Token | Value |
|---|---|
| Background | `#202225` |
| Surface | `#2b2e32` |
| Separator | `#121416` |
| Focus/index | `#78b9dc` |
| Spacing | 4 px outer, 3 px swatch gutter |
| Corner radius | 2 px swatches only |

Strength: clearer individual color identity and interaction state. Risk: gutters consume more space at minimum sizes and may feel slightly more web-like than Seam.

## Review evidence

Both directions were captured from the running CEP panels at 32×32, 160×32, 32×160, and 200×200. The 200×200 state captures show hover/remove, keyboard focus, selected/drag-ready, empty, disabled, and error treatments. The real Settings surface contains no Auto/Horizontal/Vertical controls; current palette-management captures are indexed in `evidence/README.md`.

Evidence:

- `evidence/i03/comparison.png`
- `evidence/i03/seam/contact-sheet.png`
- `evidence/i03/index/contact-sheet.png`

Objective findings:

- Seam preserves more color area at 32 px cross-axis sizes; Index spends additional pixels on wells and gutters.
- Index separates neighboring colors more strongly; Seam still has a one-pixel dark boundary.
- The first colored focus ring failed non-text contrast against all three sample colors at 1.33–2.00:1. Both candidates now use a dual light/dark ring so arbitrary swatches retain a visible keyboard boundary.
- The first error sentence clipped at 200 px. The corrected `No supported colors selected` copy fits.
- Both candidates retain a clear `+`, visible disabled state, remove affordance, and drag-ready marker.

Taste choice: flush continuous bands versus individually framed samples. This is not a usability defect in either direction.

Recommendation: Seam. It is the more compact, AE-native base. If stronger separation is wanted, adopt only Index's darker separator—not its full well/gutter system.

Selection record: Seam continued because it preserved the most color area, used the least chrome, and read most naturally beside AE. Index selectors, direction state, and direction-switching capture arguments were removed; no theme system remains.

## I04 responsive proof

- Automatic rule: horizontal when width ≥ height; vertical otherwise.
- Swatches remain a single non-wrapping axis with 24 px minimum extent and primary-axis scrolling.
- The fixed 24 px `+` stays outside the swatch scroller.
- Geometry assertions passed at 32×32, 160×32, 32×160, and 200×200.
- Real AE arrangements passed at 250×81 horizontal and 132×200 vertical; the floating panel was restored to its original 254×127 outer size.
- Authoritative fixture/state evidence: `evidence/i04/responsive-real-surface/`.
- Real arrangement evidence: `evidence/i04/live-wide/` and `evidence/i04/live-tall/`.
- A first 200×200 capture repeated the last 27 px because the real CEP compositor was only 173 px tall. That failed artifact is preserved under `evidence/i04/responsive/`; the hardened capture runner now rejects compositor surfaces smaller than 200×200 instead of saving malformed evidence.

## Post-I11 design hardening

Status: approved in the live panels on 2026-07-17 and now part of the current design contract. This section supersedes the old 32 px-wide fixture as the present minimum-width target without rewriting the historical I03/I04 evidence above.

- Main and Settings now share one continuous `#1c1d1f` AE-native background. Settings keeps hierarchy through a slim index mark and horizontal separators rather than a raised card.
- Routine Settings status/footer copy is no longer rendered. The controls and help text remain the complete visible Settings surface; transient status state is still exposed to development diagnostics.
- Main's manifest minimum is 128×32. The current strict matrix is 128×32, 160×32, 128×160, and 200×200.
- The 128×32 fixture keeps three swatches and the 24 px Add control visible on one horizontal axis.
- Fixed mode keeps Add equal to the selected 24–64 px swatch size and left-aligned in vertical layouts.
- An already-open AE floating panel can remain narrower than the new manifest minimum. In the observed 79 px outer window, CEP retained a 132 px internal viewport; vertical Stretch therefore collapses Add to a left-aligned 24×24 px control at `max-width: 132px`.
- The fallback is deliberately limited to vertical Stretch. Wider Stretch layouts retain full cross-axis Add sizing, and Fixed mode retains swatch-size parity.

Evidence:

- `evidence/local/unified-background/main.png`
- `evidence/local/unified-background/settings.png`
- `evidence/local/settings-no-status/settings.png`
- `evidence/local/min-width/responsive-128/summary.json`
- `evidence/local/min-width/responsive-128/main/128x32.png`
- `evidence/local/min-width/responsive-128/main/128x160.png`
- `evidence/local/min-width/add-left-79-production.png`

Known decision boundary: the removed Settings footer also means save failures are not currently rendered. Preserve the quiet success state, but decide whether error-only feedback should return before external testing.

## Settings deep redesign (2026-07-18)

Second pass over the Settings surface after feedback that the first redesign remained noisy.

- The panel sets a 10 px base font so `font: inherit` controls can no longer fall back to the 16 px browser default — the root cause of the oversized button text.
- Tabs are equal-width with centered labels. General is grouped into flat Swatches / Collection / Image extraction sections with one label column and a single concise help line.
- Palettes uses one native dropdown for palette selection, a thin full-width color strip preview only when colors exist, and 24 px icon-level create/delete controls. The Colors heading keeps its count and a quiet 18 px `+`; adding creates black and opens its editor immediately. Delete arms a compact inline Delete/Cancel confirmation strip instead of a wide button.
- Color rows are pressable summaries (`aria-expanded`) that unfold a subordinate editor band with a centered Hex/RGB/CMYK switch, alpha in percent, Enter/✓ commit, and Escape cancel. Only an explicit valid commit dispatches `update-color`; HDR values render as exact raw RGBA with no inputs.
- Up/down arrow buttons are gone. A hover/focus drag grip in a reserved 24 px rail initiates HTML5 drag with before/after drop lines; Alt+ArrowUp/Down on the grip is the keyboard fallback.
- The palette toolbar is one fixed row in the order palette selector · New · Import · Export · Delete. Import/Export are 24 px icon-only tray/arrow controls (arrow into the tray for Import, out of it for Export) that open the native CEP file dialogs; they add no text labels and do not widen the row. Import disables while busy, on a palette load error, or at the 32-palette limit; Export disables while busy or on a palette load error.

Evidence: `evidence/local/settings-ui-deep-redesign/` (before/final pairs at 320×360 and 240×300, expanded editor, armed delete, live hex edit from the temporary-root smoke, `final-palettes-import-export-320x360.png` / `final-palettes-import-export-240x300.png` for the five-control toolbar, plus `empty-palette-add-color-320x360.png` and `added-black-color-editor-320x360.png` for the direct-add flow).
