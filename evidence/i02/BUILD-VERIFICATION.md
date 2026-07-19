# I02 build and runtime verification

Verified 2026-07-17 on the installed After Effects 26.3 CEP surfaces.

## Production gate

- `COREPACK_ENABLE_PROJECT_SPEC=0 yarn run build` exited 0.
- A runtime-only search across `dist/cep/assets/*.cjs` found zero occurrences of `__CHROMA_RELAY_DEBUG__`, `setTemporaryConfigRoot`, or `seedPalette`.
- Source maps retain authored source text by design; executable bundles do not expose the API.

## Development gate

- `COREPACK_ENABLE_PROJECT_SPEC=0 yarn run build:dev` exited 0 with `VITE_CHROMA_RELAY_DEBUG=true` scoped to that command.
- `node --check scripts/cep-cdp.mjs` exited 0.
- `yarn run cdp:self-test` passed single exact target, wrong page, duplicate exact pages, and wrong runtime ID cases.
- An unknown option exited 2 instead of being ignored.
- A live `--main-id=com.zimoby.chroma-relay.WRONG` inspection exited 1 and preserved `../i02-fail-closed-live/main-failure.json`.
- Final `yarn run cdp:inspect --output=evidence/i02` passed Main 8198 and Settings 8199.

See `main.json`, `settings.json`, and `summary.json` for the machine-readable final evidence.
