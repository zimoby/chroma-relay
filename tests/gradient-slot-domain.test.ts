import assert from "node:assert/strict";
import test from "node:test";
import {
  validateGeneratedGradient,
  type NativeGradient,
} from "@zimoby/ae-native-gradient";
import {
  DEFAULT_PALETTE,
  PALETTE_SCHEMA_VERSION,
  addPaletteGradients,
  clonePaletteDocument,
  getActivePalette,
  getPaletteSolidColors,
  isPaletteDocument,
  isPaletteGradient,
  migratePaletteDocument,
} from "../src/js/shared/palette-domain.ts";
import { migrateLayoutSettings } from "../src/js/shared/layout-settings-domain.ts";
import { nativeGradientToCssPreview } from "../src/js/shared/native-gradient-preview.ts";

const EXACT_GRADIENT: NativeGradient = {
  schemaVersion: 1,
  colorStops: [
    { offset: 0, midpoint: 0.25, rgb: [0.1, 0.2, 0.3], extra: 1 },
    { offset: 0.7, midpoint: 0.8, rgb: [0.8, 0.4, 0.2], extra: 0 },
    { offset: 1, midpoint: 0.5, rgb: [1, 1, 1], extra: 1 },
  ],
  alphaStops: [
    { offset: 0, midpoint: 0.4, alpha: 0.2 },
    { offset: 0.35, midpoint: 0.6, alpha: 0.9 },
    { offset: 1, midpoint: 0.5, alpha: 1 },
  ],
};
const NORMALIZED_GRADIENT = validateGeneratedGradient(EXACT_GRADIENT);

test("migrates schema v2 colors losslessly into gradient-capable schema v3", () => {
  const legacy = {
    schemaVersion: 2,
    revision: 7,
    activePaletteId: "palette-default",
    palettes: [
      {
        id: "palette-default",
        name: "Palette 1",
        colors: [{ id: "exact-hdr", rgba: [1.25, -0.1, 0.5000004, 0.875] }],
      },
    ],
  };
  const migrated = migratePaletteDocument(legacy);
  assert.equal(PALETTE_SCHEMA_VERSION, 3);
  assert.equal(migrated?.schemaVersion, 3);
  assert.deepEqual(migrated?.palettes[0].colors, legacy.palettes[0].colors);
  assert.notEqual(migrated?.palettes[0].colors[0], legacy.palettes[0].colors[0]);
});

test("stores exact gradients as ordered slots and deep-clones their stop data", () => {
  const next = addPaletteGradients(DEFAULT_PALETTE, [EXACT_GRADIENT, EXACT_GRADIENT]);
  const slots = getActivePalette(next).colors;
  const gradients = slots.filter(isPaletteGradient);
  assert.equal(gradients.length, 2);
  assert.deepEqual(gradients.map((slot) => slot.gradient), [
    NORMALIZED_GRADIENT,
    NORMALIZED_GRADIENT,
  ]);
  assert.notEqual(gradients[0].gradient, EXACT_GRADIENT);
  assert.notEqual(gradients[0].gradient.colorStops, EXACT_GRADIENT.colorStops);
  assert.equal(
    getPaletteSolidColors(getActivePalette(next)).length,
    getActivePalette(DEFAULT_PALETTE).colors.length,
  );
  assert.equal(isPaletteDocument(next), true);

  const clone = clonePaletteDocument(next);
  const clonedGradient = getActivePalette(clone).colors.filter(isPaletteGradient)[0];
  assert.notEqual(clonedGradient.gradient, gradients[0].gradient);
  assert.notEqual(clonedGradient.gradient.alphaStops, gradients[0].gradient.alphaStops);
});

test("rejects invalid or partial gradient-slot writes atomically", () => {
  const invalid = {
    ...EXACT_GRADIENT,
    colorStops: [{ ...EXACT_GRADIENT.colorStops[0] }],
  };
  assert.strictEqual(addPaletteGradients(DEFAULT_PALETTE, [invalid]), DEFAULT_PALETTE);

  const full = clonePaletteDocument(DEFAULT_PALETTE);
  getActivePalette(full).colors = Array.from({ length: 64 }, (_, index) => ({
    id: `full-${index}`,
    rgba: [0, 0, 0, 1],
  }));
  assert.strictEqual(addPaletteGradients(full, [EXACT_GRADIENT]), full);
});

test("migrates existing layout settings to gradient-slot collection mode", () => {
  const migrated = migrateLayoutSettings({
    schemaVersion: 3,
    revision: 4,
    layoutMode: "fixed",
    swatchSize: 40,
    includeDisabledColors: true,
    extractionPreset: "tonal",
  });
  assert.equal(migrated?.gradientCollectionMode, "gradient-slot");
  assert.equal(migrated?.smartApply, true);
  assert.equal(
    migrateLayoutSettings({ ...migrated, gradientCollectionMode: "gradient-slot" })
      ?.gradientCollectionMode,
    "gradient-slot"
  );
  assert.equal(
    migrateLayoutSettings({ ...migrated, gradientCollectionMode: "unsupported" }),
    null
  );
});

test("renders a gradient preview with both color-only and alpha-only stop positions", () => {
  const css = nativeGradientToCssPreview(EXACT_GRADIENT);
  assert.match(css, /^linear-gradient\(90deg, /);
  assert.match(css, / 35%/);
  assert.match(css, / 70%/);
  assert.match(css, / 100%\)$/);
});

test("rotates the gradient preview by 90 degrees for a vertical palette", () => {
  const horizontal = nativeGradientToCssPreview(EXACT_GRADIENT, 90);
  const vertical = nativeGradientToCssPreview(EXACT_GRADIENT, 180);
  assert.match(horizontal, /^linear-gradient\(90deg, /);
  assert.match(vertical, /^linear-gradient\(180deg, /);
  assert.equal(vertical.slice(vertical.indexOf(", ")), horizontal.slice(horizontal.indexOf(", ")));
});
