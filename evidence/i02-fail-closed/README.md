# Discarded pre-fix negative-control run

Do not use this directory as I02 fail-closed evidence.

The command used an unknown `--expect-main-id` option before unknown CLI arguments were rejected, so the runner performed a normal passing inspection. This exposed and led to the argument-validation fix in `scripts/cep-cdp.mjs`.

Authoritative negative-control evidence: `../i02-fail-closed-live/main-failure.json`.
