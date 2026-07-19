# Image selection live-smoke investigation

Date: 2026-07-17
Host: After Effects 26.3 on macOS
Final report: `report.json`

## Product defects found and fixed

1. Selected still-image layer falsely appeared to contain both colors and an image.
   - Observed host result: `colors.status: "ok"`, black `[0,0,0,1]`, `selectedPropertyCount: 40`, plus one valid PNG image.
   - Visible result: `Choose selected colors or one image, not both` with zero writes.
   - Cause: whole-layer color recursion inspected synthetic/internal color properties on a selected still layer.
   - Fix: unified Plus collection skips whole-layer color recursion for still-image layers while preserving explicitly selected color-property handling. The legacy color collector keeps its existing default behavior.

2. Multiple-image selection failed inside ExtendScript.
   - Exact error: `ReferenceError: Function Object.keys is undefined` at generated `jsx/index.js` line 117.
   - Cause: object spread in the multiple-image result was lowered by Babel to an `Object.keys` helper unavailable in ExtendScript.
   - Fix: return an explicit result object and reject generated `Object.keys` in `scripts/check-cep-compat.mjs`.

## Harness defects corrected

- Bare `resolvePaletteAddSelection` probing was replaced with the real Bolt namespace: `$["com.zimoby.chroma-relay"]`.
- A PNG renamed to `.tif` was not a valid TIFF and AE rejected it at import. The unsupported-format fixture is now a valid embedded 1×1 GIF.
- Legacy collect expected obsolete copy, `Select one or more layers`. The image-aware product copy is `Select layers or a JPEG/PNG in the Project panel`.
- Host probe failures now retain ExtendScript message, line, and file name.

## Final live result

Six of six selection/error cases passed. Successful extraction cases made one host call and one palette write. All rejection/error cases made zero palette writes. Console errors, log errors, and runtime exceptions were zero. Cleanup removed all six owned `CP_*` AE fixtures; a separate live query confirmed no `CP_*` residue.
