# I05 — Settings launch and first layout option

Captured in live After Effects 2026 on 2026-07-17 from the installed symlink targeting this checkout's `dist/cep`.

## Result

- Main flyout event called the CEP host launcher with exact ID `com.zimoby.chroma-relay.settings` and empty startup params.
- Opening Settings left settings counters at zero.
- Default layout was Stretch at revision 0.
- Selecting Fixed produced revision 1, one Settings disk write, one Settings event, one Main receive, and zero Main writes.
- Changing the size to 40 px produced revision 2 with the same one-write/one-event/one-receive delta.
- All three Main swatches measured exactly 32×32 after Fixed selection and 40×40 after the size change.
- Both panels recovered Fixed 40 px after reload from the same temporary `settings.json` snapshot.
- Switching back to Stretch produced one fresh write/event/receive delta and restored equal-fill, non-square swatch geometry.
- Main and Settings produced no console errors, runtime exceptions, or CDP log errors.
- The temporary root was removed after each run; production user data was not touched by the smoke.

## Evidence

- `settings-smoke/report.json` — authoritative state, counters, geometry, flyout target, reload result, and console evidence.
- `settings-smoke/main-fixed-40.png` — live Main panel at Fixed 40 px.
- `settings-smoke/settings-fixed-40.png` — live Settings panel with Fixed selected and synchronized 40 px controls.
- `inspect/summary.json` — exact-page/port inspection summary.
- `inspect/main.json`, `inspect/settings.json` — independent panel identity/state/counter/geometry reports.
- `inspect/main.png`, `inspect/settings.png` — general live-panel screenshots.

## Preserved failure

`settings-smoke/failure.json` records the first smoke attempt. Fixed mode synchronized correctly, but the harness used non-bubbling programmatic blur semantics, so the numeric input did not commit 40 px. The product emitted no exception. The runner was corrected to send the delegated bubbling `focusout` event used by React; the complete rerun passed and is recorded in `report.json`.

## Commands

```bash
COREPACK_ENABLE_PROJECT_SPEC=0 yarn run build:dev
COREPACK_ENABLE_PROJECT_SPEC=0 yarn run cdp:self-test
COREPACK_ENABLE_PROJECT_SPEC=0 yarn run cdp:settings --output=evidence/i05/settings-smoke
COREPACK_ENABLE_PROJECT_SPEC=0 yarn run cdp:inspect --output=evidence/i05/inspect
COREPACK_ENABLE_PROJECT_SPEC=0 yarn run build
```
