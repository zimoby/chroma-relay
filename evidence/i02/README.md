# I02 verification evidence

Captured from live After Effects CEP panels on exact CDP ports 8198 and 8199.

- `summary.json`: final passing two-panel runner result.
- `main.json` / `settings.json`: runtime identity, state, counters, fixture geometry, realpath asset proof, interactions, and console evidence.
- `main.png` / `settings.png`: final visual evidence.
- `../i02-fail-closed-live/main-failure.json`: intentional live wrong-runtime-ID rejection.

Final command:

```bash
npm run cdp:inspect -- --output=evidence/i02
```

The reports record zero disk writes, emitted/received events, and host calls. Temporary config roots are in-memory seams only; the runner does not create those directories.
