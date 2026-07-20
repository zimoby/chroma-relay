# Windows native gradients for AE 22–26

> Date: 2026-07-20
> Scope: Chroma Relay native Shape Gradient Fill/Stroke collection and application on Windows

## Goal

Enable the existing exact saved-AEP collection and generated-FFX application paths on `win32` for the same AE 22–26 template-family routing already enabled on macOS, without weakening target identity, temp containment, version drift, Undo, readback, or cleanup contracts.

## Implementation

1. Widen the shared native-gradient platform contract from Darwin-only to `darwin | win32`; keep Linux, empty, and unknown platforms fail-closed.
2. Accept `win32` in the ExtendScript request preflight while retaining the exact `Folder.temp` canonical-path and token-owned file checks.
3. Add renderer, collection, runtime-routing, and host-envelope regressions for Windows plus unsupported-platform negatives.
4. Build an instrumented panel, install the exact bytes on a Windows test host, and prove collection/application in AE 2024 first.
5. Run the same isolated native-gradient smoke in Windows AE 2022, 2023, 2025, and 2026 when available; preserve exact reports/screenshots and failures.
6. Restore a production build and update product semantics only to the extent established by live evidence.

## Verification

- `npm run test:native-gradient`
- `npm run test:host-contract`
- `npm run build:dev`
- `npm run check:cep`
- live Windows CEP/AE temp-path probe
- live saved-AEP collection and generated-FFX apply/readback/Undo/cleanup per AE version
- final `npm run build` and production runtime identity check

## Result

- Runtime and host preflight now accept only `darwin | win32` and route every AE 22–26 minor through the frozen template-family map.
- Windows AE `24.6.4x3` passed generated-FFX application, readback, Undo finalization, selection restoration, save, exact AEP collection, and owned temp cleanup.
- Windows AE 22, 23, and 25 remained live-unverified because their interactive CEP panels could not be opened through the remote session. AE 26 was not installed on the test host.
- `npm run verify:static` passed and produced the final production build; the exact production bytes were installed on the Windows test host after the debug test build was removed.
