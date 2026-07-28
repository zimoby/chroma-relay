import test from "node:test";
import assert from "node:assert/strict";
import type { NativeGradient } from "@zimoby/ae-native-gradient";
import {
  DEFAULT_NEW_PALETTE_COLOR,
  DEFAULT_PALETTE,
  MAX_PALETTE_COLORS,
  MAX_PALETTE_NAME_LENGTH,
  MAX_PALETTES,
  PALETTE_SCHEMA_VERSION,
  type PaletteDocument,
  type Rgba,
  addPaletteColorToPalette,
  addPaletteCollectionEntries,
  addPaletteCollectionItems,
  addPaletteColors,
  clonePaletteDocument,
  createPalette,
  getActivePalette,
  importPalette,
  isPaletteDocument,
  migratePaletteDocument,
  removePaletteColor,
  removePalette,
  renamePalette,
  reorderPaletteColor,
  rgbaToCss,
  selectPalette,
  updatePaletteColor,
  updatePaletteColorInPalette,
} from "../src/js/shared/palette-domain.ts";

const DUPLICATE_TEST_GRADIENT: NativeGradient = {
  schemaVersion: 1,
  colorStops: [
    { offset: 0, midpoint: 0.5, rgb: [1, 1, 1], extra: 1 },
    { offset: 1, midpoint: 0.5, rgb: [0, 0, 0], extra: 1 },
  ],
  alphaStops: [
    { offset: 0, midpoint: 0.5, alpha: 1 },
    { offset: 1, midpoint: 0.5, alpha: 1 },
  ],
};

const colorIds = (document: PaletteDocument) =>
  getActivePalette(document).colors.map((color) => color.id);

test("default palette uses the branded five-color spectrum", () => {
  assert.deepEqual(colorIds(DEFAULT_PALETTE), ["coral", "amber", "leaf", "sky", "violet"]);
  assert.deepEqual(
    getActivePalette(DEFAULT_PALETTE).colors.map((color) => color.rgba),
    [
      [224 / 255, 90 / 255, 79 / 255, 1],
      [229 / 255, 185 / 255, 76 / 255, 1],
      [85 / 255, 168 / 255, 111 / 255, 1],
      [86 / 255, 143 / 255, 209 / 255, 1],
      [155 / 255, 108 / 255, 203 / 255, 1],
    ],
  );
});

test("adds an independent default black color and permits another black", () => {
  const empty = createPalette(DEFAULT_PALETTE);
  const paletteId = getActivePalette(empty).id;

  const first = addPaletteColorToPalette(empty, paletteId);
  assert.equal(first.revision, empty.revision + 1);
  assert.deepEqual(getActivePalette(first).colors[0].rgba, DEFAULT_NEW_PALETTE_COLOR);
  assert.notStrictEqual(getActivePalette(first).colors[0].rgba, DEFAULT_NEW_PALETTE_COLOR);

  const second = addPaletteColorToPalette(first, paletteId);
  assert.equal(second.revision, first.revision + 1);
  assert.equal(getActivePalette(second).colors.length, 2);
  assert.deepEqual(
    getActivePalette(second).colors.map((color) => color.rgba),
    [DEFAULT_NEW_PALETTE_COLOR, DEFAULT_NEW_PALETTE_COLOR]
  );
  assert.notEqual(getActivePalette(second).colors[0].id, getActivePalette(second).colors[1].id);

  assert.strictEqual(addPaletteColorToPalette(second, "missing-palette"), second);

  const full = clonePaletteDocument(second);
  getActivePalette(full).colors = Array.from({ length: MAX_PALETTE_COLORS }, (_, index) => ({
    id: `full-${index}`,
    rgba: [0, 0, 0, 1],
  }));
  assert.strictEqual(addPaletteColorToPalette(full, paletteId), full);
});

test("collection entries preserve gradient duplicates and reject partial capacity writes", () => {
  const existing = DEFAULT_PALETTE.palettes[0].colors[0].rgba;
  const gradientStop: Rgba = [0.125, 0.25, 0.5, 0.75];
  const next = addPaletteCollectionEntries(DEFAULT_PALETTE, [
    { rgba: existing, preserveDuplicate: false },
    { rgba: gradientStop, preserveDuplicate: true },
    { rgba: gradientStop, preserveDuplicate: true },
  ]);
  assert.deepEqual(
    getActivePalette(next).colors.slice(-2).map((color) => color.rgba),
    [gradientStop, gradientStop]
  );
  assert.equal(next.revision, DEFAULT_PALETTE.revision + 1);

  const oneSlot = clonePaletteDocument(DEFAULT_PALETTE);
  getActivePalette(oneSlot).colors = Array.from(
    { length: MAX_PALETTE_COLORS - 1 },
    (_, index) => ({ id: `occupied-${index}`, rgba: [index, 0, 0, 1] })
  );
  assert.strictEqual(
    addPaletteCollectionEntries(oneSlot, [
      { rgba: gradientStop, preserveDuplicate: true },
      { rgba: gradientStop, preserveDuplicate: true },
    ]),
    oneSlot
  );
  assert.equal(getActivePalette(oneSlot).colors.length, MAX_PALETTE_COLORS - 1);
});

test("collection duplicate policy applies equally to solids and exact gradients", () => {
  const empty = createPalette(DEFAULT_PALETTE);
  const solid: Rgba = [0.25, 0.5, 0.75, 1];
  const united = addPaletteCollectionItems(empty, [
    { type: "color", rgba: solid, preserveDuplicate: false },
    { type: "color", rgba: solid, preserveDuplicate: false },
    { type: "gradient", gradient: DUPLICATE_TEST_GRADIENT, preserveDuplicate: false },
    { type: "gradient", gradient: DUPLICATE_TEST_GRADIENT, preserveDuplicate: false },
  ]);
  assert.equal(getActivePalette(united).colors.length, 2);
  assert.strictEqual(
    addPaletteCollectionItems(united, [
      { type: "color", rgba: solid, preserveDuplicate: false },
      { type: "gradient", gradient: DUPLICATE_TEST_GRADIENT, preserveDuplicate: false },
    ]),
    united,
  );

  const preserved = addPaletteCollectionItems(empty, [
    { type: "color", rgba: solid, preserveDuplicate: true },
    { type: "color", rgba: solid, preserveDuplicate: true },
    { type: "gradient", gradient: DUPLICATE_TEST_GRADIENT, preserveDuplicate: true },
    { type: "gradient", gradient: DUPLICATE_TEST_GRADIENT, preserveDuplicate: true },
  ]);
  assert.equal(getActivePalette(preserved).colors.length, 4);

  const repeatedPreserved = addPaletteCollectionItems(preserved, [
    { type: "color", rgba: solid, preserveDuplicate: true },
    { type: "gradient", gradient: DUPLICATE_TEST_GRADIENT, preserveDuplicate: true },
  ]);
  assert.equal(getActivePalette(repeatedPreserved).colors.length, 6);
  assert.equal(repeatedPreserved.revision, preserved.revision + 1);
});

test("migrates v1 exactly into one active Palette 1", () => {
  const legacy = {
    schemaVersion: 1,
    revision: 7,
    colors: [{ id: "exact-hdr", rgba: [1.25, -0.1, 0.5000004, 0.875] }],
  };
  const migrated = migratePaletteDocument(legacy);
  assert.deepEqual(migrated, {
    schemaVersion: 3,
    revision: 7,
    activePaletteId: "palette-default",
    palettes: [
      {
        id: "palette-default",
        name: "Palette 1",
        colors: legacy.colors,
      },
    ],
  });
  assert.notEqual(migrated?.palettes[0].colors, legacy.colors);
  assert.notEqual(migrated?.palettes[0].colors[0].rgba, legacy.colors[0].rgba);
});

test("validates schema v3 IDs, names, active palette, and bounds", () => {
  assert.equal(isPaletteDocument(DEFAULT_PALETTE), true);
  const invalid = clonePaletteDocument(DEFAULT_PALETTE);
  invalid.activePaletteId = "missing";
  assert.equal(isPaletteDocument(invalid), false);

  const duplicateColor = clonePaletteDocument(DEFAULT_PALETTE);
  duplicateColor.palettes[0].colors[1].id = duplicateColor.palettes[0].colors[0].id;
  assert.equal(isPaletteDocument(duplicateColor), false);

  const duplicatePalette = createPalette(DEFAULT_PALETTE);
  duplicatePalette.palettes[1].name = "palette 1";
  assert.equal(isPaletteDocument(duplicatePalette), false);
  duplicatePalette.palettes[1].name = "Palette 2";
  duplicatePalette.palettes[1].id = duplicatePalette.palettes[0].id;
  assert.equal(isPaletteDocument(duplicatePalette), false);

  assert.equal(
    isPaletteDocument({
      schemaVersion: PALETTE_SCHEMA_VERSION,
      revision: 0,
      activePaletteId: "palette-default",
      palettes: [],
    }),
    false
  );
  assert.equal(migratePaletteDocument({ schemaVersion: 1, revision: 0, colors: [] }) !== null, true);
  assert.equal(migratePaletteDocument({ schemaVersion: 1, revision: 0, colors: new Array(MAX_PALETTE_COLORS + 1) }), null);
  assert.equal(MAX_PALETTES, 32);
});

test("dedupes by epsilon while preserving the first exact floats and HDR values", () => {
  const base: PaletteDocument = {
    schemaVersion: PALETTE_SCHEMA_VERSION,
    revision: 4,
    activePaletteId: "empty",
    palettes: [{ id: "empty", name: "Empty", colors: [] }],
  };
  const hdr: [number, number, number, number] = [1.25, -0.1, 0.5000004, 1];
  const result = addPaletteColors(base, [hdr, [1.2500001, -0.0999999, 0.5, 1]]);
  assert.equal(result.revision, 5);
  assert.equal(getActivePalette(result).colors.length, 1);
  assert.deepEqual(getActivePalette(result).colors[0].rgba, hdr);
  assert.equal(rgbaToCss(hdr), "rgba(255, 0, 128, 1)");
});

test("ignores invalid or already-present colors without a revision change", () => {
  const document = clonePaletteDocument(DEFAULT_PALETTE);
  const same = addPaletteColors(document, [
    getActivePalette(document).colors[0].rgba,
    [Number.NaN, 0, 0, 1],
  ]);
  assert.equal(same, document);
  assert.equal(same.revision, 0);
});

test("creates, selects, renames, and removes palettes deterministically", () => {
  const second = createPalette(DEFAULT_PALETTE);
  assert.equal(second.revision, 1);
  assert.equal(second.palettes.length, 2);
  assert.equal(getActivePalette(second).name, "Palette 2");
  assert.deepEqual(getActivePalette(second).colors, []);

  const renamed = renamePalette(second, second.activePaletteId, "  Brand  ");
  assert.equal(getActivePalette(renamed).name, "Brand");
  assert.equal(renamed.revision, 2);
  assert.equal(renamePalette(renamed, renamed.activePaletteId, "palette 1"), renamed);

  const first = selectPalette(renamed, "palette-default");
  assert.equal(first.activePaletteId, "palette-default");
  assert.equal(first.revision, 3);
  assert.equal(selectPalette(first, "palette-default"), first);

  const removedFirst = removePalette(first, "palette-default");
  assert.equal(removedFirst.palettes.length, 1);
  assert.equal(getActivePalette(removedFirst).name, "Brand");
  assert.equal(removePalette(removedFirst, removedFirst.activePaletteId), removedFirst);
});

test("active-palette remove and reorder are stable, revisioned, and edge-exact", () => {
  const removed = removePaletteColor(DEFAULT_PALETTE, "leaf");
  assert.deepEqual(colorIds(removed), ["coral", "amber", "sky", "violet"]);
  assert.equal(removed.revision, 1);
  assert.equal(removePaletteColor(removed, "missing"), removed);

  const reordered = reorderPaletteColor(DEFAULT_PALETTE, "sky", "coral");
  assert.deepEqual(colorIds(reordered), ["sky", "coral", "amber", "leaf", "violet"]);
  assert.equal(reordered.revision, 1);
  assert.equal(reorderPaletteColor(reordered, "sky", "sky"), reordered);

  const after = reorderPaletteColor(DEFAULT_PALETTE, "coral", "sky", "after");
  assert.deepEqual(colorIds(after), ["amber", "leaf", "sky", "coral", "violet"]);
  const before = reorderPaletteColor(DEFAULT_PALETTE, "sky", "coral", "before");
  assert.deepEqual(colorIds(before), ["sky", "coral", "amber", "leaf", "violet"]);
  assert.equal(reorderPaletteColor(DEFAULT_PALETTE, "coral", "amber", "before"), DEFAULT_PALETTE);
});

test("update-color replaces one color exactly, preserving ID, order, and neighbors", () => {
  const rgba: Rgba = [51 / 255, 102 / 255, 153 / 255, 128 / 255];
  const updated = updatePaletteColor(DEFAULT_PALETTE, "leaf", rgba);
  assert.notEqual(updated, DEFAULT_PALETTE);
  assert.equal(updated.revision, 1);
  const colors = getActivePalette(updated).colors;
  assert.deepEqual(colors.map((color) => color.id), ["coral", "amber", "leaf", "sky", "violet"]);
  assert.deepEqual(colors[2].rgba, rgba);
  assert.notEqual(colors[2].rgba, rgba);
  assert.deepEqual(colors[0].rgba, DEFAULT_PALETTE.palettes[0].colors[0].rgba);
  assert.deepEqual(colors[1].rgba, DEFAULT_PALETTE.palettes[0].colors[1].rgba);
  assert.deepEqual(colors[3].rgba, DEFAULT_PALETTE.palettes[0].colors[3].rgba);
  assert.deepEqual(colors[4].rgba, DEFAULT_PALETTE.palettes[0].colors[4].rgba);
  assert.notEqual(updated.palettes, DEFAULT_PALETTE.palettes);
  assert.equal(DEFAULT_PALETTE.revision, 0);

  const coral = DEFAULT_PALETTE.palettes[0].colors[0].rgba;
  const duplicated = updatePaletteColor(DEFAULT_PALETTE, "leaf", [
    coral[0],
    coral[1],
    coral[2],
    coral[3],
  ]);
  assert.equal(duplicated.revision, 1, "duplicates are allowed without dedupe");
  assert.deepEqual(getActivePalette(duplicated).colors[2].rgba, coral);

  const hdr: Rgba = [1.25, -0.1, 0.5000004, 2];
  const hdrUpdated = updatePaletteColor(DEFAULT_PALETTE, "leaf", hdr);
  assert.deepEqual(getActivePalette(hdrUpdated).colors[2].rgba, hdr);
});

test("update-color returns the same document for missing, invalid, or exact no-op input", () => {
  assert.equal(updatePaletteColor(DEFAULT_PALETTE, "missing", [0, 0, 0, 1]), DEFAULT_PALETTE);
  assert.equal(
    updatePaletteColorInPalette(DEFAULT_PALETTE, "missing-palette", "leaf", [0, 0, 0, 1]),
    DEFAULT_PALETTE
  );
  assert.equal(
    updatePaletteColor(DEFAULT_PALETTE, "leaf", [Number.NaN, 0, 0, 1]),
    DEFAULT_PALETTE
  );
  assert.equal(
    updatePaletteColor(DEFAULT_PALETTE, "leaf", [Number.POSITIVE_INFINITY, 0, 0, 1]),
    DEFAULT_PALETTE
  );
  assert.equal(
    updatePaletteColor(DEFAULT_PALETTE, "leaf", [0, 0, 1] as unknown as Rgba),
    DEFAULT_PALETTE
  );

  const exact = DEFAULT_PALETTE.palettes[0].colors[2].rgba;
  assert.equal(
    updatePaletteColor(DEFAULT_PALETTE, "leaf", [exact[0], exact[1], exact[2], exact[3]]),
    DEFAULT_PALETTE
  );
  const nearlyEqual = updatePaletteColor(DEFAULT_PALETTE, "leaf", [
    exact[0] + 1e-9,
    exact[1],
    exact[2],
    exact[3],
  ]);
  assert.notEqual(nearlyEqual, DEFAULT_PALETTE, "only exact matches are no-ops");
});

test("importPalette atomically creates one active palette with exact colors and fresh IDs", () => {
  const values: Rgba[] = [
    [1.25, -0.1, 0.5000004, 0.875],
    [0, 0, 0, 0],
    [0.2, 0.35, 0.95, 0.5],
  ];
  const imported = importPalette(DEFAULT_PALETTE, "Brand", values);
  assert.notEqual(imported, DEFAULT_PALETTE);
  assert.equal(imported.revision, 1, "import increments the revision exactly once");
  assert.equal(imported.palettes.length, 2);
  assert.equal(isPaletteDocument(imported), true, "generated IDs must be valid");
  assert.equal(DEFAULT_PALETTE.revision, 0, "the source document is untouched");
  assert.equal(DEFAULT_PALETTE.palettes.length, 1);

  const active = getActivePalette(imported);
  assert.equal(active.name, "Brand");
  assert.equal(active.id === "palette-default", false, "imported palette gets a fresh ID");
  assert.equal(imported.activePaletteId, active.id, "the imported palette becomes active");
  assert.deepEqual(
    active.colors.map((color) => color.rgba),
    values,
    "color order and exact RGBA are preserved"
  );
  assert.notEqual(active.colors[0].rgba, values[0], "RGBA arrays are copied");
  const ids = active.colors.map((color) => color.id);
  assert.equal(new Set(ids).size, ids.length, "generated color IDs are unique");
  const existingIds = DEFAULT_PALETTE.palettes[0].colors.map((color) => color.id);
  assert.equal(ids.some((id) => existingIds.includes(id)), false);

  const trimmed = importPalette(DEFAULT_PALETTE, "  Brand  ", []);
  assert.equal(getActivePalette(trimmed).name, "Brand");
  assert.deepEqual(getActivePalette(trimmed).colors, [], "a valid empty palette imports");
});

test("importPalette resolves duplicate names deterministically within 48 characters", () => {
  const second = importPalette(DEFAULT_PALETTE, "Palette 1", []);
  assert.equal(getActivePalette(second).name, "Palette 1 2");
  const third = importPalette(second, "Palette 1", []);
  assert.equal(getActivePalette(third).name, "Palette 1 3");

  const longName = "X".repeat(MAX_PALETTE_NAME_LENGTH);
  const first = importPalette(DEFAULT_PALETTE, longName, []);
  assert.equal(getActivePalette(first).name, longName);
  const collided = importPalette(first, longName, []);
  const resolved = getActivePalette(collided).name;
  assert.equal(resolved, `${"X".repeat(MAX_PALETTE_NAME_LENGTH - 2)} 2`);
  assert.equal(resolved.length, MAX_PALETTE_NAME_LENGTH);
  assert.equal(isPaletteDocument(collided), true);
});

test("importPalette returns the same document for invalid input or at the palette limit", () => {
  assert.equal(importPalette(DEFAULT_PALETTE, "", []), DEFAULT_PALETTE);
  assert.equal(importPalette(DEFAULT_PALETTE, "   ", []), DEFAULT_PALETTE);
  assert.equal(
    importPalette(DEFAULT_PALETTE, "N".repeat(MAX_PALETTE_NAME_LENGTH + 1), []),
    DEFAULT_PALETTE
  );
  assert.equal(
    importPalette(DEFAULT_PALETTE, "Brand", [[Number.NaN, 0, 0, 1]]),
    DEFAULT_PALETTE
  );
  assert.equal(
    importPalette(DEFAULT_PALETTE, "Brand", [[0, 0, 1]] as unknown as Rgba[]),
    DEFAULT_PALETTE
  );
  assert.equal(
    importPalette(
      DEFAULT_PALETTE,
      "Brand",
      Array.from({ length: MAX_PALETTE_COLORS + 1 }, (): Rgba => [0, 0, 0, 1])
    ),
    DEFAULT_PALETTE
  );

  let full = clonePaletteDocument(DEFAULT_PALETTE);
  while (full.palettes.length < MAX_PALETTES) full = createPalette(full);
  assert.equal(full.palettes.length, MAX_PALETTES);
  assert.equal(importPalette(full, "Overflow", []), full);
});

test("clone has no shared palette, color, or RGBA arrays", () => {
  const clone = clonePaletteDocument(DEFAULT_PALETTE);
  assert.notEqual(clone.palettes, DEFAULT_PALETTE.palettes);
  assert.notEqual(clone.palettes[0], DEFAULT_PALETTE.palettes[0]);
  assert.notEqual(clone.palettes[0].colors, DEFAULT_PALETTE.palettes[0].colors);
  assert.notEqual(clone.palettes[0].colors[0].rgba, DEFAULT_PALETTE.palettes[0].colors[0].rgba);
});
