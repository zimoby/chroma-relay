# Final review evidence

Date: 2026-07-17

## Persistence hardening

Authoritative report:

- `persistence-storage-guard/report.json`
- `persistence-storage-guard/malformed-palette.json`
- `persistence-storage-guard/main-reloaded.png`

The live CEP runner used an isolated `/private/tmp` root and passed:

- missing and valid primary files;
- malformed primary preservation;
- deliberate UI-guard bypass followed by storage-layer write refusal;
- temp recovery;
- backup recovery;
- verified temp preference after an interrupted replacement;
- invalid-temp fallback to valid backup while preserving invalid evidence;
- queued-write serialization and reload.

## CLI review/fix loop

The first blocker-only Codex pass identified:

1. malformed-primary overwrite risk;
2. stale/invalid recovery-candidate ordering;
3. production `process.abort()` menu exposure;
4. missing manifest icon assets;
5. `.debug` in package output.

All five were validated against the source/artifact and repaired. The follow-up targeted Codex pass found the storage invariant still lived only at the UI boundary. The invariant was moved into `savePalette`, the smoke was changed to bypass the UI guard deliberately, and live validation passed. The final targeted Codex response was:

`OK TO DEPLOY`

Final artifact consistency checking then exposed an asynchronous ExtendScript-build race: `jsx/index.js.map` could land in raw `dist/cep` after alpha staging had already been verified. The host build is now awaited by Vite, release host source maps are unconditionally disabled, and the alpha packager rejects forbidden files in the raw CEP tree before copying. A follow-up Codex review also caught the development Rollup watcher closing after its first result; the watcher now remains active. A live `yarn dev` probe produced an initial `ExtendScript Change`, then a second change and both panel reloads after a timestamp-only JSX touch. The temporary server was stopped. The final targeted Codex response was again `OK TO DEPLOY`.

Broad second-pass Codex and Claude attempts exceeded their bounded five-minute review limits without verdicts; they were not counted as passes. The completed first-pass/fix/final-targeted loop is the authoritative CLI review.

## Production and alpha package

Provenance note: this section records the pre-hardening I11 package. Post-I11 background, Settings, manifest-minimum, fixture, and Add-alignment changes have not yet been repackaged. The normal production build cleared `dist/alpha`, so the artifact path below is historical and does not currently exist.

- `alpha-package-report.json` — durable copy of the successful package verifier report.
- Artifact: `dist/alpha/Chroma Relay_0.0.1-unsigned.zip`
- Archive root: `com.zimoby.chroma-relay/`
- SHA-256: `015de5df5a7c49aaa4a331f5a8dc531977fe4e0e12af6a8628f076dc0cd40f85`
- Size: 84,291 bytes
- ZIP integrity: passed.
- Manifest XML: passed.
- CEP icon references: one existing copied PNG.
- Forbidden `.debug`/source maps: none.
- Production debug runtime surface: absent.

## Remaining manual gates

None for the historical I11 scope. I08 live apply/readback/Undo and I10 strict responsive/state capture both passed on the exact I11 panels in live AE 26.3.

Current post-I11 and release-boundary gates are tracked in `docs/implementation-plan.md` and `docs/implementation-status.md`: fresh-panel enforcement of the 128 px host minimum, the Settings error-only-feedback decision, the first Git baseline, a refreshed unsigned-alpha package/report/SHA after the next freeze, and Windows validation before any public cross-platform claim.
