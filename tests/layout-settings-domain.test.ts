import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_LAYOUT_SETTINGS,
  LAYOUT_SETTINGS_SCHEMA_VERSION,
  migrateLayoutSettings,
} from "../src/js/shared/layout-settings-domain.ts";

test("migrates older settings to schema v6 with Smart Apply and duplicate uniting enabled", () => {
  assert.deepEqual(
    migrateLayoutSettings({
      schemaVersion: 1,
      revision: 7,
      layoutMode: "fixed",
      swatchSize: 44,
    }),
    {
      schemaVersion: 6,
      revision: 7,
      layoutMode: "fixed",
      swatchSize: 44,
      includeDisabledColors: false,
      extractionPreset: "balanced",
      gradientCollectionMode: "gradient-slot",
      smartApply: true,
      uniteDuplicates: true,
    },
  );
  assert.deepEqual(
    migrateLayoutSettings({
      schemaVersion: 2,
      revision: 9,
      layoutMode: "stretch",
      swatchSize: 32,
      includeDisabledColors: true,
    }),
    {
      schemaVersion: 6,
      revision: 9,
      layoutMode: "stretch",
      swatchSize: 32,
      includeDisabledColors: true,
      extractionPreset: "balanced",
      gradientCollectionMode: "gradient-slot",
      smartApply: true,
      uniteDuplicates: true,
    },
  );
  assert.deepEqual(
    migrateLayoutSettings({
      schemaVersion: 4,
      revision: 11,
      layoutMode: "fixed",
      swatchSize: 36,
      includeDisabledColors: false,
      extractionPreset: "contrast",
      gradientCollectionMode: "gradient-slot",
    }),
    {
      schemaVersion: 6,
      revision: 11,
      layoutMode: "fixed",
      swatchSize: 36,
      includeDisabledColors: false,
      extractionPreset: "contrast",
      gradientCollectionMode: "gradient-slot",
      smartApply: true,
      uniteDuplicates: true,
    },
  );
  assert.deepEqual(
    migrateLayoutSettings({
      schemaVersion: 5,
      revision: 12,
      layoutMode: "stretch",
      swatchSize: 32,
      includeDisabledColors: false,
      extractionPreset: "balanced",
      gradientCollectionMode: "gradient-slot",
      smartApply: false,
    }),
    {
      schemaVersion: 6,
      revision: 12,
      layoutMode: "stretch",
      swatchSize: 32,
      includeDisabledColors: false,
      extractionPreset: "balanced",
      gradientCollectionMode: "gradient-slot",
      smartApply: false,
      uniteDuplicates: true,
    },
  );
});

test("accepts valid schema v6 settings and rejects invalid boolean settings", () => {
  assert.equal(LAYOUT_SETTINGS_SCHEMA_VERSION, 6);
  assert.equal(DEFAULT_LAYOUT_SETTINGS.extractionPreset, "balanced");
  assert.equal(DEFAULT_LAYOUT_SETTINGS.gradientCollectionMode, "gradient-slot");
  assert.equal(DEFAULT_LAYOUT_SETTINGS.smartApply, true);
  assert.equal(DEFAULT_LAYOUT_SETTINGS.uniteDuplicates, true);
  assert.equal(
    migrateLayoutSettings({ ...DEFAULT_LAYOUT_SETTINGS, extractionPreset: "tonal" })
      ?.extractionPreset,
    "tonal",
  );
  assert.equal(
    migrateLayoutSettings({ ...DEFAULT_LAYOUT_SETTINGS, extractionPreset: "contrast" })
      ?.extractionPreset,
    "contrast",
  );
  assert.equal(
    migrateLayoutSettings({ ...DEFAULT_LAYOUT_SETTINGS, extractionPreset: "unknown" }),
    null,
  );
  assert.equal(
    migrateLayoutSettings({ ...DEFAULT_LAYOUT_SETTINGS, swatchSize: 999 }),
    null,
  );
  assert.equal(
    migrateLayoutSettings({ ...DEFAULT_LAYOUT_SETTINGS, gradientCollectionMode: "unknown" }),
    null,
  );
  assert.equal(migrateLayoutSettings({ ...DEFAULT_LAYOUT_SETTINGS, smartApply: "yes" }), null);
  assert.equal(
    migrateLayoutSettings({ ...DEFAULT_LAYOUT_SETTINGS, uniteDuplicates: "yes" }),
    null,
  );
});
