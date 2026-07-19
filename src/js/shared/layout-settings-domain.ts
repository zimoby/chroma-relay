export const LAYOUT_SETTINGS_SCHEMA_VERSION = 4 as const;
export const MIN_SWATCH_SIZE = 24;
export const MAX_SWATCH_SIZE = 64;

export type LayoutMode = "stretch" | "fixed";
export type ExtractionPreset = "balanced" | "tonal" | "contrast";
export type GradientCollectionMode = "color-stops" | "gradient-slot";

export type LayoutSettings = {
  schemaVersion: typeof LAYOUT_SETTINGS_SCHEMA_VERSION;
  revision: number;
  layoutMode: LayoutMode;
  swatchSize: number;
  includeDisabledColors: boolean;
  extractionPreset: ExtractionPreset;
  gradientCollectionMode: GradientCollectionMode;
};

type LayoutSettingsV1 = Omit<
  LayoutSettings,
  "schemaVersion" | "includeDisabledColors" | "extractionPreset" | "gradientCollectionMode"
> & {
  schemaVersion: 1;
};

type LayoutSettingsV2 = Omit<
  LayoutSettings,
  "schemaVersion" | "extractionPreset" | "gradientCollectionMode"
> & {
  schemaVersion: 2;
};

type LayoutSettingsV3 = Omit<LayoutSettings, "schemaVersion" | "gradientCollectionMode"> & {
  schemaVersion: 3;
};

export const DEFAULT_LAYOUT_SETTINGS: LayoutSettings = {
  schemaVersion: LAYOUT_SETTINGS_SCHEMA_VERSION,
  revision: 0,
  layoutMode: "stretch",
  swatchSize: 32,
  includeDisabledColors: false,
  extractionPreset: "balanced",
  gradientCollectionMode: "color-stops",
};

export const clampSwatchSize = (value: number) =>
  Math.min(MAX_SWATCH_SIZE, Math.max(MIN_SWATCH_SIZE, Math.round(value)));

export const isExtractionPreset = (value: unknown): value is ExtractionPreset =>
  value === "balanced" || value === "tonal" || value === "contrast";

export const isGradientCollectionMode = (
  value: unknown
): value is GradientCollectionMode => value === "color-stops" || value === "gradient-slot";

const hasValidBaseSettings = (
  value: unknown
): value is {
  revision: number;
  layoutMode: LayoutMode;
  swatchSize: number;
} => {
  if (!value || typeof value !== "object") return false;
  const settings = value as Partial<LayoutSettings>;
  return (
    Number.isInteger(settings.revision) &&
    (settings.revision as number) >= 0 &&
    (settings.layoutMode === "stretch" || settings.layoutMode === "fixed") &&
    Number.isInteger(settings.swatchSize) &&
    (settings.swatchSize as number) >= MIN_SWATCH_SIZE &&
    (settings.swatchSize as number) <= MAX_SWATCH_SIZE
  );
};

const isLayoutSettingsV1 = (value: unknown): value is LayoutSettingsV1 =>
  hasValidBaseSettings(value) &&
  (value as { schemaVersion?: unknown }).schemaVersion === 1;

const isLayoutSettingsV2 = (value: unknown): value is LayoutSettingsV2 => {
  if (!hasValidBaseSettings(value)) return false;
  const settings = value as Partial<LayoutSettingsV2>;
  return settings.schemaVersion === 2 && typeof settings.includeDisabledColors === "boolean";
};

const isLayoutSettingsV3 = (value: unknown): value is LayoutSettingsV3 => {
  if (!hasValidBaseSettings(value)) return false;
  const settings = value as Partial<LayoutSettingsV3>;
  return (
    settings.schemaVersion === 3 &&
    typeof settings.includeDisabledColors === "boolean" &&
    isExtractionPreset(settings.extractionPreset)
  );
};

export const isLayoutSettings = (value: unknown): value is LayoutSettings => {
  if (!hasValidBaseSettings(value)) return false;
  const settings = value as Partial<LayoutSettings>;
  return (
    settings.schemaVersion === LAYOUT_SETTINGS_SCHEMA_VERSION &&
    typeof settings.includeDisabledColors === "boolean" &&
    isExtractionPreset(settings.extractionPreset) &&
    isGradientCollectionMode(settings.gradientCollectionMode)
  );
};

export const migrateLayoutSettings = (value: unknown): LayoutSettings | null => {
  if (isLayoutSettings(value)) return { ...value };
  if (isLayoutSettingsV3(value)) {
    return {
      ...value,
      schemaVersion: LAYOUT_SETTINGS_SCHEMA_VERSION,
      gradientCollectionMode: DEFAULT_LAYOUT_SETTINGS.gradientCollectionMode,
    };
  }
  if (isLayoutSettingsV2(value)) {
    return {
      ...value,
      schemaVersion: LAYOUT_SETTINGS_SCHEMA_VERSION,
      extractionPreset: DEFAULT_LAYOUT_SETTINGS.extractionPreset,
      gradientCollectionMode: DEFAULT_LAYOUT_SETTINGS.gradientCollectionMode,
    };
  }
  if (isLayoutSettingsV1(value)) {
    return {
      ...value,
      schemaVersion: LAYOUT_SETTINGS_SCHEMA_VERSION,
      includeDisabledColors: DEFAULT_LAYOUT_SETTINGS.includeDisabledColors,
      extractionPreset: DEFAULT_LAYOUT_SETTINGS.extractionPreset,
      gradientCollectionMode: DEFAULT_LAYOUT_SETTINGS.gradientCollectionMode,
    };
  }
  return null;
};
