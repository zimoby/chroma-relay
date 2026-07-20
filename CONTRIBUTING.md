# Contributing

Keep changes narrow and preserve the CEP/AE ownership boundaries.

## Local checks

Use the repository-pinned toolchain: Node `22.22.3` and npm `10.9.8`. Confirm that your active shell resolves those versions before installing dependencies.

Dependency installation also requires GitHub read access to the private, immutable `zimoby/ae-native-gradient-toolkit` pin. Configure Git authentication on the development device; do not place access tokens in tracked files.

```bash
node --version
npm --version
npm ci
npm run verify:static
npm run package:alpha
```

`verify:static` builds once and runs the domain, storage, host, native-gradient,
runner, release, and CEP compatibility checks. `package:alpha` is local and unsigned;
it reopens the ZIP and records its source commit, worktree state, identity,
inventory, and SHA-256 in `dist/alpha/report.json`.

For live CEP work, build the debug bundle and use exact Main/Settings targets on ports 8198/8199:

```bash
npm run build:dev
npm run cdp:persistence
npm run cdp:palette-management
```

Live mutation runners must use a fresh temporary config root, verify both panel identities before dispatch, restore the real root in `finally`, and preserve failure evidence. Never point synthetic mutation tests at the user's real palette.

## Boundaries

- Main alone writes `palette.json` and calls the AE host bridge.
- Settings alone writes `settings.json`; palette mutations are revisioned commands to Main.
- Persist exact finite RGBA values separately from rounded CSS previews.
- Keep Main edge controls visible and left-safe at narrow geometries.
- Do not commit generated `dist/` output or package artifacts as source evidence.