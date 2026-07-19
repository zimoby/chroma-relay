import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_LAYOUT_SETTINGS,
  LAYOUT_SETTINGS_SCHEMA_VERSION,
  migrateLayoutSettings,
} from "../src/js/shared/layout-settings-domain.ts";

test("migrates v1 and v2 settings to schema v4 without losing existing choices", () => {
  assert.deepEqual(
    migrateLayoutSettings({
      schemaVersion: 1,
      revision: 7,
      layoutMode: "fixed",
      swatchSize: 44,
    }),
    {
      schemaVersion: 4,
      revision: 7,
      layoutMode: "fixed",
      swatchSize: 44,
      includeDisabledColors: false,
      extractionPreset: "balanced",
      gradientCollectionMode: "color-stops",
    }
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
      schemaVersion: 4,
      revision: 9,
      layoutMode: "stretch",
      swatchSize: 32,
      includeDisabledColors: true,
      extractionPreset: "balanced",
      gradientCollectionMode: "color-stops",
    }
  );
});

test("accepts valid schema v4 presets and rejects invalid saved values", () => {
  assert.equal(LAYOUT_SETTINGS_SCHEMA_VERSION, 4);
  assert.equal(DEFAULT_LAYOUT_SETTINGS.extractionPreset, "balanced");
  assert.equal(DEFAULT_LAYOUT_SETTINGS.gradientCollectionMode, "color-stops");
  assert.equal(
    migrateLayoutSettings({ ...DEFAULT_LAYOUT_SETTINGS, extractionPreset: "tonal" })
      ?.extractionPreset,
    "tonal"
  );
  assert.equal(
    migrateLayoutSettings({ ...DEFAULT_LAYOUT_SETTINGS, extractionPreset: "contrast" })
      ?.extractionPreset,
    "contrast"
  );
  assert.equal(
    migrateLayoutSettings({ ...DEFAULT_LAYOUT_SETTINGS, extractionPreset: "unknown" }),
    null
  );
  assert.equal(
    migrateLayoutSettings({ ...DEFAULT_LAYOUT_SETTINGS, swatchSize: 999 }),
    null
  );
  assert.equal(
    migrateLayoutSettings({ ...DEFAULT_LAYOUT_SETTINGS, gradientCollectionMode: "unknown" }),
    null
  );
});
