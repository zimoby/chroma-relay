import test from "node:test";
import assert from "node:assert/strict";
import { validateGeneratedGradient } from "@zimoby/ae-native-gradient";
import {
  MAX_PALETTE_COLORS,
  MAX_PALETTE_NAME_LENGTH,
  type Rgba,
} from "../src/js/shared/palette-domain.ts";
import {
  MAX_PALETTE_TRANSFER_BYTES,
  PALETTE_TRANSFER_EXTENSION,
  PALETTE_TRANSFER_FORMAT,
  PALETTE_TRANSFER_VERSION,
  ensureJsonExtension,
  parsePortablePalette,
  portablePaletteFileName,
  serializePortablePalette,
} from "../src/js/shared/palette-transfer.ts";

const HDR_COLORS: Rgba[] = [
  [1.25, -0.1, 0.5000004, 0.875],
  [51 / 255, 102 / 255, 153 / 255, 128 / 255],
  [0, 0, 0, 0],
];

test("round-trips exact HDR, negative, and alpha values deterministically", () => {
  const first = serializePortablePalette("Studio Warm", HDR_COLORS);
  const second = serializePortablePalette("Studio Warm", HDR_COLORS);
  assert.equal(first, second, "serialization must be deterministic");
  assert.match(first, /\n$/, "serialized palette ends with a trailing newline");
  assert.equal(first, `${JSON.stringify(JSON.parse(first), null, 2)}\n`, "pretty two-space JSON");

  const parsed = parsePortablePalette(first);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.name, "Studio Warm");
  assert.deepEqual(parsed.colors, HDR_COLORS);
  assert.notEqual(parsed.colors[0], HDR_COLORS[0], "parsed RGBA arrays are copies");
});

test("round-trips an exact gradient slot without IDs or flattening", () => {
  const gradient = validateGeneratedGradient({
    schemaVersion: 1,
    colorStops: [
      { offset: 0, midpoint: 0.2, rgb: [0.1, 0.2, 0.3], extra: 7 },
      { offset: 0.7, midpoint: 0.8, rgb: [0.8, 0.4, 0.2], extra: 0 },
    ],
    alphaStops: [
      { offset: 0, midpoint: 0.3, alpha: 0.25 },
      { offset: 1, midpoint: 0.5, alpha: 1 },
    ],
  });
  const text = serializePortablePalette("Exact", [
    { id: "gradient-1", rgba: [0.1, 0.2, 0.3, 0.25], gradient },
  ]);
  assert.doesNotMatch(text, /"id"/);

  const parsed = parsePortablePalette(text);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.items, [{ rgba: [0.1, 0.2, 0.3, 0.25], gradient }]);
  assert.notEqual(parsed.items[0].gradient, gradient);
  assert.deepEqual(parsed.colors, [[0.1, 0.2, 0.3, 0.25]]);
});

test("exports the exact portable shape with no internal identity fields", () => {
  const text = serializePortablePalette("Brand", [HDR_COLORS[0]]);
  const payload = JSON.parse(text) as Record<string, unknown>;
  assert.deepEqual(Object.keys(payload), ["format", "version", "name", "items"]);
  assert.equal(payload.format, PALETTE_TRANSFER_FORMAT);
  assert.equal(payload.version, PALETTE_TRANSFER_VERSION);
  assert.deepEqual(payload.items, [{ rgba: HDR_COLORS[0] }]);
  assert.deepEqual(Object.keys((payload.items as object[])[0]), ["rgba"]);
  assert.doesNotMatch(text, /schemaVersion|revision|activePaletteId|"id"/);
});

test("a valid empty palette round-trips", () => {
  const parsed = parsePortablePalette(serializePortablePalette("Empty", []));
  assert.deepEqual(parsed, { ok: true, name: "Empty", items: [], colors: [] });
});

test("rejects malformed JSON, wrong format, and unsupported versions", () => {
  assert.equal(parsePortablePalette("not json").ok, false);
  assert.equal(parsePortablePalette("[]").ok, false);
  assert.equal(parsePortablePalette("null").ok, false);
  assert.equal(
    parsePortablePalette(JSON.stringify({ format: "swatches", version: 1, name: "A", colors: [] }))
      .ok,
    false
  );
  const versioned = parsePortablePalette(
    JSON.stringify({ format: PALETTE_TRANSFER_FORMAT, version: 3, name: "A", items: [] })
  );
  assert.deepEqual(versioned, { ok: false, error: "Palette export version is not supported" });
});

test("rejects untrimmed, empty, and overlong names", () => {
  const withName = (name: unknown) =>
    parsePortablePalette(
      JSON.stringify({ format: PALETTE_TRANSFER_FORMAT, version: 1, name, colors: [] })
    );
  assert.equal(withName(" Studio ").ok, false);
  assert.equal(withName("").ok, false);
  assert.equal(withName("N".repeat(MAX_PALETTE_NAME_LENGTH + 1)).ok, false);
  assert.equal(withName(7).ok, false);
  assert.equal(withName("N".repeat(MAX_PALETTE_NAME_LENGTH)).ok, true);
});

test("rejects oversized color lists and bad RGBA entries without truncating", () => {
  const withColors = (colors: unknown) =>
    parsePortablePalette(
      JSON.stringify({ format: PALETTE_TRANSFER_FORMAT, version: 1, name: "A", colors })
    );
  const tooMany = Array.from({ length: MAX_PALETTE_COLORS + 1 }, () => ({ rgba: [0, 0, 0, 1] }));
  const oversized = withColors(tooMany);
  assert.equal(oversized.ok, false, "oversized imports are rejected, never truncated");
  assert.equal(withColors(Array.from({ length: MAX_PALETTE_COLORS }, () => ({ rgba: [0, 0, 0, 1] }))).ok, true);
  assert.equal(withColors(undefined).ok, false);
  assert.equal(withColors("colors").ok, false);
  assert.equal(withColors([null]).ok, false);
  assert.equal(withColors([[0, 0, 0, 1]]).ok, false, "bare arrays are not { rgba } objects");
  assert.equal(withColors([{ rgba: [0, 0, 1] }]).ok, false);
  assert.equal(withColors([{ rgba: [0, 0, 0, null] }]).ok, false);
  assert.equal(withColors([{ rgba: [0, 0, 0, "1"] }]).ok, false);
  assert.equal(withColors([{ rgba: [1e400, 0, 0, 1] }]).ok, false, "Infinity is not finite");
});

test("builds filesystem-safe export names and normalizes .json extensions", () => {
  assert.equal(
    portablePaletteFileName('My: "Palette"/2*?'),
    `My Palette 2${PALETTE_TRANSFER_EXTENSION}`
  );
  assert.equal(portablePaletteFileName("///"), `palette${PALETTE_TRANSFER_EXTENSION}`);
  assert.equal(portablePaletteFileName("Warm"), `Warm${PALETTE_TRANSFER_EXTENSION}`);
  assert.equal(ensureJsonExtension("/tmp/warm"), "/tmp/warm.json");
  assert.equal(ensureJsonExtension("/tmp/warm.JSON"), "/tmp/warm.JSON");
  assert.equal(
    ensureJsonExtension(`/tmp/warm${PALETTE_TRANSFER_EXTENSION}`),
    `/tmp/warm${PALETTE_TRANSFER_EXTENSION}`
  );
  assert.equal(MAX_PALETTE_TRANSFER_BYTES, 1024 * 1024);
});
