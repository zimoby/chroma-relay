# Contributing

Keep changes narrow and preserve the CEP/AE ownership boundaries.

## Local checks

Use the repository-pinned toolchain: Node `22.22.3` and npm `10.9.8`. Ensure `/Users/REDACTED/.local/bin` precedes the obsolete system Node on `PATH`.

```bash
export PATH=/Users/REDACTED/.local/bin:$PATH
node --version
npm --version
npm ci
npm run build
npm run test:domain
npm run test:host-contract
npm run test:native-gradient
npm run check:cep
```

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