# Storage contract

Chroma Relay stores user data beneath the CEP user-data root. The existing `Chroma Relay/` directory remains authoritative for compatibility; `palette.json` and `settings.json` have independent schemas and owners.

## Palette document

Current schema: v2.

```json
{
  "schemaVersion": 2,
  "revision": 7,
  "activePaletteId": "palette-default",
  "palettes": [
    {
      "id": "palette-default",
      "name": "Palette 1",
      "colors": [{ "id": "coral", "rgba": [0.85, 0.4, 0.29, 1] }]
    }
  ]
}
```

- Main is the only `palette.json` writer.
- Settings may load palette data read-only. Mutations are revisioned CEP commands sent to Main; Main validates, persists once, and returns the authoritative cloned document.
- The Settings Colors-heading `+` sends one `add-color` command. Main appends one independent opaque black `[0, 0, 0, 1]` color, persists once, broadcasts the authoritative document, and Settings opens the new color's Hex editor. Existing black colors do not block another addition; a full 64-color palette is unchanged. The empty strip preview is not rendered when the active palette has no colors.
- The Settings color editor commits Hex/RGB/CMYK/alpha input as one `update-color` command carrying exact normalized RGBA (hex bytes become byte/255 fractions). Opening an editor, switching formats, invalid input, unchanged commits, and cancelled drags never write. Out-of-display-gamut (HDR/negative) values are shown as exact raw RGBA and are never clamp-saved by the editor.
- A schema-v1 `{schemaVersion, revision, colors}` document migrates in memory to one active `Palette 1`. Loading alone does not rewrite the file; the first successful mutation persists schema v2.
- Color IDs and RGBA arrays remain exact. Display CSS conversion never replaces persisted finite values, including HDR or negative channels.
- Writes are serialized, temporary-file verified, and recover from valid `.tmp` or `.bak` data. Malformed primary data is preserved and write-protected.

## Portable palette transfer (v1)

Import/Export in Settings uses a portable single-palette JSON format, produced and validated by the pure `src/js/shared/palette-transfer.ts` module:

```json
{
  "format": "chroma-relay",
  "version": 1,
  "name": "Palette name",
  "colors": [{ "rgba": [0.2, 0.4, 0.6, 1] }]
}
```

- Export serializes only the active palette: no schema version, document revision, active ID, palette ID, or color IDs leave the app. RGBA numbers stay exact, including HDR/negative components. Output is deterministic two-space JSON with a trailing newline.
- Export writes through the native `showSaveDialogEx` result only (a filesystem-safe `<name>.chroma-relay.json` is proposed; a missing `.json` is appended). The JSON payload retains `format: "chroma-relay"`, so files exported before the public rename remain importable. If appending the extension would target an existing file that the native dialog did not confirm, export fails closed and asks the user to choose that exact file in Save. Settings writes the confirmed/new external file directly, reads it back, and verifies the exact payload before reporting success. This is the one permitted Settings write and it is never `palette.json`.
- Import reads the `showOpenDialogEx`/`showOpenDialog` selection (native path or `file://` URL) as UTF-8, capped at 1 MiB, and validates the exact format/version, a non-empty trimmed name of at most 48 characters, at most 64 colors, and four finite RGBA numbers per color. Malformed or oversized files are rejected whole, never truncated. A valid empty palette is allowed.
- A valid import dispatches one revisioned `import-palette` command. Main owns the mutation: `importPalette` atomically appends one new active palette with fresh internal IDs, resolves duplicate names as `Name 2`, `Name 3`, … within the 48-character limit, increments the revision once, persists with one normal `palette.json` write, and broadcasts the authoritative document. At the 32-palette limit or for invalid input the document is unchanged.
- Cancelled dialogs are strict no-ops: no status error, no command, no write.

## Settings document

Current schema: v3. Settings is its sole writer. It stores layout mode, fixed swatch size, disabled-branch collection, and image-extraction preset. Main receives revisioned settings events but does not write `settings.json`.

## Verification

```bash
pnpm run test:domain
pnpm run cdp:persistence
pnpm run cdp:palette-management
```

Both CDP smokes use temporary roots and restore the live panels to the real root during cleanup.