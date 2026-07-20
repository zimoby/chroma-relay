# Native gradient fixture provenance

## Scope and ownership

Run ID: `20260718T024931Z`

This document preserves the historical acquisition facts for the four fixtures that originally lived under `tests/fixtures/native-gradient/`. Fixture files, frozen models, canonical provenance, codec implementation, templates, and CLI are now owned by the standalone private `@zimoby/ae-native-gradient` toolkit. Chroma Relay, then using the Chroma Relay codename, completed migration at exact toolkit commit `891eb6ba964ffdf99a382c285eef249fb24ce180` and retains no duplicate fixture assets.

Chroma Relay keeps only product semantics, UI, CEP bridge, and future runtime adapters. `Chroma Relay` remains its legacy codename/storage identity; `Zimoby` and `com.zimoby.chroma-relay` remain provisional technical/publisher identities and do not define toolkit ownership.

The four historical fixtures were created from a blank, token-owned After Effects project at:

`/private/tmp/chroma-relay-gradient-20260718T6x7Ba3/chroma-relay-gradient-20260718T6x7Ba3.aep`

No imported media, fonts, third-party presets, production projects, `Super Morphings.aep`, or `MP_pseudo3Dstyle.ffx` were used. The project contained one composition, one shape layer, one rectangle, and exactly one native Shape gradient at each AEP capture point.

Distributability review: approved for toolkit test use. The fixtures contain only user-authored geometry/color choices plus standard After Effects serialization. The external `py-aep` source was not copied into either repository and was used only as an MIT-licensed read-only oracle.

## Acquisition environment

- Acquired: `2026-07-18T13:13:47Z`
- After Effects: `26.3x87`
- Platform: macOS `15.7.1` build `24G231`, `arm64`
- Node: `v22.22.3`
- npm: `10.9.8`
- Oracle Python: `3.13.14`
- Existing live helper note: `ae_file_json` uses Python internally. That is a local harness prerequisite, not shipped runtime code.

The parent gate required the exact clean token-scoped project path before fixture mutation. Acquisition scripts refused project creation, close, replacement, or Save As. The scratch project was saved in place only after exact path, comp, layer, and target checks passed.

## FFX templates

`fill-template.ffx` and `stroke-template.ffx` were captured separately through After Effects' Save Animation Preset UI. In each capture, the sole selected property was `ADBE Vector Grad Colors` under the expected native parent.

Both templates:

- are `RIFX/FaFX`;
- are 6,332 bytes;
- have declared end/trailer start 2,540;
- preserve a 3,792-byte trailer;
- contain exactly one `LIST(GCky)`;
- contain exactly one `Utf8` child;
- decode to one valid two-color/two-alpha default gradient;
- contain `ADBE Vector Grad Colors` evidence.

Kind identity was checked directly in the acquired bytes:

- Fill contains `ADBE Vector Graphic - G-Fill` and not `G-Stroke`.
- Stroke contains `ADBE Vector Graphic - G-Stroke` and not `G-Fill`.

The captured templates remain unmodified. Their exact structure, hashes, identity, and normalized gradient are frozen in `fill-template.expected.json` and `stroke-template.expected.json`.

## AE 25.6 product templates

Capture ID: `20260719T050253Z-8D444EFF`

Chroma Relay owns separate property-scoped runtime templates for the AE 25.6 host family:

- `src/assets/native-gradient/ae25-6/fill-template.ffx`
  - 6,326 bytes
  - SHA-256 `a0cddaf936cc337a427d3a81c4224764fd6fc1f13a9bbeb6ae863276fa28dc59`
- `src/assets/native-gradient/ae25-6/stroke-template.ffx`
  - 6,326 bytes
  - SHA-256 `cb1ffe6195604834203a950433a83dd7097e971f8477567fdc2c32e3c34ed9dd`

They were captured through AE's `Save Animation Preset...` command on macOS 15.7.1 build 24G231, arm64, in After Effects `25.6.6x4`. The source was a token-owned copy of `tests/fixtures/native-gradient/exact-identity-ae25.aep`, SHA-256 `9a2bfccb07eab5cfaab2ee18ad0565787ab4f6bdc70788085881b3b456d04267`. For each capture, a strict script resolved layer ID 14 and selected exactly one `ADBE Vector Grad Colors` property under the expected Fill or Stroke parent. The scratch project remained clean and the original zero-item project was restored byte-for-byte.

Both templates are `RIFX/FaFX`, contain exactly one valid `LIST(GCky)` candidate, decode to the expected three-color/three-alpha fixture gradient, and carry `Adobe After Effects 2025 (Macintosh)` creator metadata. Fill contains `ADBE Vector Graphic - G-Fill` and not `G-Stroke`; Stroke contains `G-Stroke` and not `G-Fill`. Toolkit package templates remain AE 26.3 reference assets and are intentionally not used for the AE 25.6 product runtime.

## AEP inventory fixtures

An untouched default gradient is omitted from an AEP's serialized `GCky` inventory. The Fill fixture was therefore changed through AE's Gradient Editor to endpoint `FFF336`, then saved clean. The accepted normalized Fill gradient is:

- color 0: offset `0`, midpoint `0.5`, RGB `[1, 0.95294118, 0.21176471]`, extra `1`;
- color 1: offset `1`, midpoint `0.5`, RGB `[0, 0, 0]`, extra `1`;
- alpha stops: offsets `0` and `1`, midpoint `0.5`, alpha `1`.

For Stroke, the untouched property-scoped preset did not mark the property modified and was rolled back. A temporary derivative of the owned Stroke FFX changed only two XML bytes, converting the first stop from white to red. Its total length, all RIFF size fields, and the full 3,792-byte trailer remained identical; the derivative SHA-256 was `37851c1469b22ea562af7bf946605a89ed8be0585523e5ab3ba561671800e648`. It was applied only to the owned Stroke target, after which the script required the same layer ID, one `G-Stroke` parent, one colors property, `isModified=true`, and a clean save. The temporary derivative is not committed.

The accepted normalized Stroke gradient is red-to-black with `extra=1` on both color stops and two fully opaque alpha stops. Each accepted AEP contains exactly one valid gradient candidate under `inspect.mjs --unique`.

Both AEP fixtures are `RIFX/Egg!` with exactly one `LIST(GCky)` candidate and one `Utf8` child. Fill is 80,113 bytes with declared end/trailer start 74,320 and a 5,793-byte trailer. Stroke is 81,939 bytes with declared end/trailer start 76,146 and the same 5,793-byte trailer. These structural facts are frozen with root identity in the two AEP expected JSON files.

## Independent oracle

Oracle: `forticheprod/py-aep`

- Repository: <https://github.com/forticheprod/py-aep>
- Pinned commit: `d52678605581f3290a891ec3195a34fd39ee802e`
- Observed full-checkout package version: `0.1.dev250+gd52678605`
- License: MIT, Copyright (c) 2023 Fortiche production
- License source SHA-256: `7fc274705725a93e2397d3d9ab9aa834c8b52f55c5912812b425cdd32ab9cb24`
- External local adapter SHA-256: `82280573839ce34e56e2b2129c3a67534c48ed1ae28bdc3b4f2a2658848ec319`
- External local requirements SHA-256: `c8308a5a81c935dbe21568a7abc4baf2061f6c1b43b4018b07689a8db790413f`
- Raw adapter output SHA-256: `ac386ece0dbd1058f1c9667d80640b4a6544e1dff8c0401a917a0f5cea85cd04`
- Canonical normalized output SHA-256: `e95d494cf597dfc1ae3f07c65c88f5c77f8f8cabdcca1295f1b141d8c9815db6`

The adapter, requirements, environment, and regeneration command are local validation infrastructure outside this project. They are not required by repository tests and are not recorded as executable repository paths. Installing the pinned oracle may access the network and remains approval-gated. Repository validation consumes frozen expected models and the hashes above.

The final external adapter output was byte-identical under both the shallow editable checkout and a clean pinned-requirements installation. `py-aep`'s public color-stop model omits AE's sixth stored component, so the local adapter strictly read only that component from the same oracle-owned raw `Utf8` XML while requiring one type descriptor and six finite floats per stop. For both fixtures, the resulting complete model agreed with `inspect.mjs` on ordered color stops including `extra`, ordered alpha stops, Fill/Stroke parent identity, colors match name, and raw gradient XML SHA-256. Frozen parsed payloads are in `scratch-fill.expected.json` and `scratch-stroke.expected.json`.

## Preserved failures

Meaningful failures are preserved outside the repository at:

`$HOME/Documents/Dev_code/_Collaborations/.agent-baselines/chroma-relay-native-gradient/20260718T024931Z/evidence/TASK-3B/`

That evidence includes the 78,145-byte zero-`GCky` default Fill AEP and a read-only JSON summary of the hidden Miter Limit write, default Stroke preset no-op/rollback, and missing-Git-LFS checkout failure. These artifacts are intentionally excluded from shipped fixtures.
