import {
  validateGeneratedGradient,
  type NativeGradient,
} from "@zimoby/ae-native-gradient";
import contract from "../../shared/product-contract.json" with { type: "json" };

export const PALETTE_SCHEMA_VERSION = contract.schemas.palette as 3;
export const MAX_PALETTE_COLORS = 64;
export const MAX_PALETTES = 32;
export const MAX_PALETTE_NAME_LENGTH = 48;
export const COLOR_EPSILON = 1e-6;

export type Rgba = [number, number, number, number];

export const DEFAULT_NEW_PALETTE_COLOR: Rgba = [0, 0, 0, 1];

export type PaletteColor = {
  id: string;
  rgba: Rgba;
  gradient?: NativeGradient;
};

export type PaletteImportItem = Omit<PaletteColor, "id">;

export type PaletteGradient = PaletteColor & { gradient: NativeGradient };

export type Palette = {
  id: string;
  name: string;
  colors: PaletteColor[];
};

export type PaletteDocument = {
  schemaVersion: typeof PALETTE_SCHEMA_VERSION;
  revision: number;
  activePaletteId: string;
  palettes: Palette[];
};

type PaletteDocumentV1 = {
  schemaVersion: 1;
  revision: number;
  colors: PaletteColor[];
};

type PaletteDocumentV2 = {
  schemaVersion: 2;
  revision: number;
  activePaletteId: string;
  palettes: Palette[];
};

export type PaletteDropEdge = "before" | "after";

export type PaletteCollectionEntry = {
  rgba: Rgba;
  preserveDuplicate: boolean;
};

export type PaletteCollectionItem =
  | ({ type: "color" } & PaletteCollectionEntry)
  | { type: "gradient"; gradient: NativeGradient };

const ENTITY_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DEFAULT_PALETTE_ID = "palette-default";

const copyRgba = (rgba: Rgba): Rgba => [rgba[0], rgba[1], rgba[2], rgba[3]];
const normalizeGradient = (value: unknown): NativeGradient | null => {
  try {
    return validateGeneratedGradient(value);
  } catch {
    return null;
  }
};
const cloneGradient = (gradient: NativeGradient): NativeGradient => {
  const clone = normalizeGradient(gradient);
  if (!clone) throw new Error("Palette gradient is invalid");
  return clone;
};
const cloneColor = (color: PaletteColor): PaletteColor => ({
  id: color.id,
  rgba: copyRgba(color.rgba),
  ...(color.gradient ? { gradient: cloneGradient(color.gradient) } : {}),
});
const clonePalette = (palette: Palette): Palette => ({
  id: palette.id,
  name: palette.name,
  colors: palette.colors.map(cloneColor),
});

export const clonePaletteDocument = (document: PaletteDocument): PaletteDocument => ({
  schemaVersion: PALETTE_SCHEMA_VERSION,
  revision: document.revision,
  activePaletteId: document.activePaletteId,
  palettes: document.palettes.map(clonePalette),
});

export const DEFAULT_PALETTE: PaletteDocument = {
  schemaVersion: PALETTE_SCHEMA_VERSION,
  revision: 0,
  activePaletteId: DEFAULT_PALETTE_ID,
  palettes: [
    {
      id: DEFAULT_PALETTE_ID,
      name: "Palette 1",
      colors: [
        { id: "coral", rgba: [224 / 255, 90 / 255, 79 / 255, 1] },
        { id: "amber", rgba: [229 / 255, 185 / 255, 76 / 255, 1] },
        { id: "leaf", rgba: [85 / 255, 168 / 255, 111 / 255, 1] },
        { id: "sky", rgba: [86 / 255, 143 / 255, 209 / 255, 1] },
        { id: "violet", rgba: [155 / 255, 108 / 255, 203 / 255, 1] },
      ],
    },
  ],
};

export const isRgba = (value: unknown): value is Rgba =>
  Array.isArray(value) &&
  value.length === 4 &&
  value.every((component) => typeof component === "number" && Number.isFinite(component));

export const isPaletteImportItem = (value: unknown): value is PaletteImportItem => {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<PaletteImportItem>;
  return isRgba(item.rgba) && (item.gradient === undefined || normalizeGradient(item.gradient) !== null);
};

export const isPaletteColor = (value: unknown): value is PaletteColor => {
  if (!value || typeof value !== "object") return false;
  const color = value as Partial<PaletteColor>;
  return (
    typeof color.id === "string" &&
    ENTITY_ID.test(color.id) &&
    isRgba(color.rgba) &&
    (color.gradient === undefined || normalizeGradient(color.gradient) !== null)
  );
};

export const isPaletteGradient = (color: PaletteColor): color is PaletteGradient =>
  color.gradient !== undefined;

const isPaletteName = (value: unknown): value is string =>
  typeof value === "string" &&
  value === value.trim() &&
  value.length > 0 &&
  value.length <= MAX_PALETTE_NAME_LENGTH;

const isColorList = (value: unknown): value is PaletteColor[] => {
  if (
    !Array.isArray(value) ||
    value.length > MAX_PALETTE_COLORS ||
    !value.every(isPaletteColor)
  ) {
    return false;
  }
  return new Set(value.map((color) => color.id)).size === value.length;
};

const isPalette = (value: unknown): value is Palette => {
  if (!value || typeof value !== "object") return false;
  const palette = value as Partial<Palette>;
  return (
    typeof palette.id === "string" &&
    ENTITY_ID.test(palette.id) &&
    isPaletteName(palette.name) &&
    isColorList(palette.colors)
  );
};

const isRevision = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 0;

const isPaletteDocumentV2 = (value: unknown): value is PaletteDocumentV2 => {
  if (!value || typeof value !== "object") return false;
  const document = value as Partial<PaletteDocumentV2>;
  if (
    document.schemaVersion !== 2 ||
    !isRevision(document.revision) ||
    typeof document.activePaletteId !== "string" ||
    !ENTITY_ID.test(document.activePaletteId) ||
    !Array.isArray(document.palettes) ||
    document.palettes.length === 0 ||
    document.palettes.length > MAX_PALETTES ||
    !document.palettes.every(
      (palette) =>
        isPalette(palette) && palette.colors.every((color) => !isPaletteGradient(color))
    )
  ) {
    return false;
  }
  const paletteIds = document.palettes.map((palette) => palette.id);
  const paletteNames = document.palettes.map((palette) => palette.name.toLowerCase());
  return (
    new Set(paletteIds).size === paletteIds.length &&
    new Set(paletteNames).size === paletteNames.length &&
    paletteIds.includes(document.activePaletteId)
  );
};

const isPaletteDocumentV1 = (value: unknown): value is PaletteDocumentV1 => {
  if (!value || typeof value !== "object") return false;
  const document = value as Partial<PaletteDocumentV1>;
  return (
    document.schemaVersion === 1 &&
    isRevision(document.revision) &&
    isColorList(document.colors)
  );
};

export const isPaletteDocument = (value: unknown): value is PaletteDocument => {
  if (!value || typeof value !== "object") return false;
  const document = value as Partial<PaletteDocument>;
  if (
    document.schemaVersion !== PALETTE_SCHEMA_VERSION ||
    !isRevision(document.revision) ||
    typeof document.activePaletteId !== "string" ||
    !ENTITY_ID.test(document.activePaletteId) ||
    !Array.isArray(document.palettes) ||
    document.palettes.length === 0 ||
    document.palettes.length > MAX_PALETTES ||
    !document.palettes.every(isPalette)
  ) {
    return false;
  }

  const paletteIds = document.palettes.map((palette) => palette.id);
  const paletteNames = document.palettes.map((palette) => palette.name.toLowerCase());
  return (
    new Set(paletteIds).size === paletteIds.length &&
    new Set(paletteNames).size === paletteNames.length &&
    paletteIds.includes(document.activePaletteId)
  );
};

export const migratePaletteDocument = (value: unknown): PaletteDocument | null => {
  if (isPaletteDocument(value)) return clonePaletteDocument(value);
  if (isPaletteDocumentV2(value)) {
    return {
      schemaVersion: PALETTE_SCHEMA_VERSION,
      revision: value.revision,
      activePaletteId: value.activePaletteId,
      palettes: value.palettes.map(clonePalette),
    };
  }
  if (!isPaletteDocumentV1(value)) return null;
  return {
    schemaVersion: PALETTE_SCHEMA_VERSION,
    revision: value.revision,
    activePaletteId: DEFAULT_PALETTE_ID,
    palettes: [
      {
        id: DEFAULT_PALETTE_ID,
        name: "Palette 1",
        colors: value.colors.map(cloneColor),
      },
    ],
  };
};

export const getPalette = (document: PaletteDocument, paletteId: string) =>
  document.palettes.find((palette) => palette.id === paletteId) ?? null;

export const getActivePalette = (document: PaletteDocument): Palette => {
  const active = getPalette(document, document.activePaletteId);
  if (!active) throw new Error("Palette document has no active palette");
  return active;
};

export const getPaletteSolidColors = (palette: Palette): PaletteColor[] =>
  palette.colors.filter((color) => !isPaletteGradient(color));

export const rgbaEqual = (left: Rgba, right: Rgba, epsilon = COLOR_EPSILON) =>
  left.every((component, index) => Math.abs(component - right[index]) <= epsilon);

const paletteColorEqual = (left: PaletteColor, right: PaletteColor) =>
  left.id === right.id &&
  rgbaEqual(left.rgba, right.rgba, 0) &&
  JSON.stringify(left.gradient ?? null) === JSON.stringify(right.gradient ?? null);

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

export const rgbaToCss = (rgba: Rgba) => {
  const red = Math.round(clamp01(rgba[0]) * 255);
  const green = Math.round(clamp01(rgba[1]) * 255);
  const blue = Math.round(clamp01(rgba[2]) * 255);
  return `rgba(${red}, ${green}, ${blue}, ${clamp01(rgba[3])})`;
};

const paletteNameTaken = (document: PaletteDocument, name: string, exceptId?: string) =>
  document.palettes.some(
    (palette) => palette.id !== exceptId && palette.name.toLowerCase() === name.toLowerCase()
  );

const nextPaletteName = (document: PaletteDocument) => {
  let number = document.palettes.length + 1;
  while (paletteNameTaken(document, `Palette ${number}`)) number += 1;
  return `Palette ${number}`;
};

const nextPaletteId = (document: PaletteDocument) => {
  const base = `palette-${document.revision + 1}`;
  let candidate = base;
  let suffix = 2;
  const ids = new Set(document.palettes.map((palette) => palette.id));
  while (ids.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
};

export const createPalette = (
  document: PaletteDocument,
  requestedName?: string
): PaletteDocument => {
  if (document.palettes.length >= MAX_PALETTES) return document;
  const name = requestedName === undefined ? nextPaletteName(document) : requestedName.trim();
  if (!isPaletteName(name) || paletteNameTaken(document, name)) return document;
  const palette: Palette = { id: nextPaletteId(document), name, colors: [] };
  return {
    schemaVersion: PALETTE_SCHEMA_VERSION,
    revision: document.revision + 1,
    activePaletteId: palette.id,
    palettes: [...document.palettes.map(clonePalette), palette],
  };
};

const resolveImportedPaletteName = (document: PaletteDocument, requestedName: string) => {
  if (!paletteNameTaken(document, requestedName)) return requestedName;
  for (let counter = 2; ; counter += 1) {
    const suffix = ` ${counter}`;
    const base = requestedName
      .slice(0, MAX_PALETTE_NAME_LENGTH - suffix.length)
      .replace(/\s+$/, "");
    const candidate = `${base}${suffix}`;
    if (!paletteNameTaken(document, candidate)) return candidate;
  }
};

export const importPaletteItems = (
  document: PaletteDocument,
  requestedName: string,
  values: readonly PaletteImportItem[]
): PaletteDocument => {
  if (document.palettes.length >= MAX_PALETTES) return document;
  if (typeof requestedName !== "string") return document;
  const name = requestedName.trim();
  if (!isPaletteName(name)) return document;
  if (
    !Array.isArray(values) ||
    values.length > MAX_PALETTE_COLORS ||
    !values.every(isPaletteImportItem)
  ) {
    return document;
  }
  const colors: PaletteColor[] = [];
  values.forEach((value, index) => {
    colors.push({
      id: nextColorId(document, colors, index),
      rgba: copyRgba(value.rgba),
      ...(value.gradient ? { gradient: cloneGradient(value.gradient) } : {}),
    });
  });
  const palette: Palette = {
    id: nextPaletteId(document),
    name: resolveImportedPaletteName(document, name),
    colors,
  };
  return {
    schemaVersion: PALETTE_SCHEMA_VERSION,
    revision: document.revision + 1,
    activePaletteId: palette.id,
    palettes: [...document.palettes.map(clonePalette), palette],
  };
};

export const importPalette = (
  document: PaletteDocument,
  requestedName: string,
  values: Rgba[]
): PaletteDocument =>
  importPaletteItems(
    document,
    requestedName,
    values.map((rgba) => ({ rgba }))
  );

export const selectPalette = (document: PaletteDocument, paletteId: string): PaletteDocument => {
  if (paletteId === document.activePaletteId || !getPalette(document, paletteId)) return document;
  const next = clonePaletteDocument(document);
  next.revision += 1;
  next.activePaletteId = paletteId;
  return next;
};

export const renamePalette = (
  document: PaletteDocument,
  paletteId: string,
  requestedName: string
): PaletteDocument => {
  const palette = getPalette(document, paletteId);
  const name = requestedName.trim();
  if (
    !palette ||
    !isPaletteName(name) ||
    palette.name === name ||
    paletteNameTaken(document, name, paletteId)
  ) {
    return document;
  }
  const next = clonePaletteDocument(document);
  const nextPalette = getPalette(next, paletteId);
  if (!nextPalette) return document;
  nextPalette.name = name;
  next.revision += 1;
  return next;
};

export const removePalette = (document: PaletteDocument, paletteId: string): PaletteDocument => {
  if (document.palettes.length === 1) return document;
  const index = document.palettes.findIndex((palette) => palette.id === paletteId);
  if (index < 0) return document;
  const palettes = document.palettes.filter((palette) => palette.id !== paletteId).map(clonePalette);
  const activePaletteId =
    document.activePaletteId === paletteId
      ? palettes[Math.min(index, palettes.length - 1)].id
      : document.activePaletteId;
  return {
    schemaVersion: PALETTE_SCHEMA_VERSION,
    revision: document.revision + 1,
    activePaletteId,
    palettes,
  };
};

const nextColorId = (
  document: PaletteDocument,
  colors: PaletteColor[],
  offset: number
) => {
  const base = `color-${document.revision + 1}-${offset + 1}`;
  let candidate = base;
  let suffix = 2;
  const ids = new Set(colors.map((color) => color.id));
  while (ids.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
};

export const addPaletteColorToPalette = (
  document: PaletteDocument,
  paletteId: string,
  rgba: Rgba = DEFAULT_NEW_PALETTE_COLOR
): PaletteDocument => {
  if (!isRgba(rgba)) return document;
  const palette = getPalette(document, paletteId);
  if (!palette || palette.colors.length >= MAX_PALETTE_COLORS) return document;
  const colors = palette.colors.map(cloneColor);
  colors.push({
    id: nextColorId(document, colors, colors.length),
    rgba: copyRgba(rgba),
  });
  const next = clonePaletteDocument(document);
  const nextPalette = getPalette(next, paletteId);
  if (!nextPalette) return document;
  nextPalette.colors = colors;
  next.revision += 1;
  return next;
};

export const addPaletteColorsToPalette = (
  document: PaletteDocument,
  paletteId: string,
  values: Rgba[],
  epsilon = COLOR_EPSILON
): PaletteDocument => {
  const palette = getPalette(document, paletteId);
  if (!palette) return document;
  const colors = palette.colors.map(cloneColor);
  values.forEach((rgba, index) => {
    if (
      colors.length < MAX_PALETTE_COLORS &&
      isRgba(rgba) &&
      !colors.some(
        (color) => !isPaletteGradient(color) && rgbaEqual(color.rgba, rgba, epsilon)
      )
    ) {
      colors.push({ id: nextColorId(document, colors, index), rgba: copyRgba(rgba) });
    }
  });
  if (colors.length === palette.colors.length) return document;
  const next = clonePaletteDocument(document);
  const nextPalette = getPalette(next, paletteId);
  if (!nextPalette) return document;
  nextPalette.colors = colors;
  next.revision += 1;
  return next;
};

export const addPaletteColors = (
  document: PaletteDocument,
  values: Rgba[],
  epsilon = COLOR_EPSILON
) => addPaletteColorsToPalette(document, document.activePaletteId, values, epsilon);

export const addPaletteCollectionItems = (
  document: PaletteDocument,
  items: readonly PaletteCollectionItem[],
  epsilon = COLOR_EPSILON
): PaletteDocument => {
  const palette = getActivePalette(document);
  const colors = palette.colors.map(cloneColor);
  let changed = false;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item || (item.type !== "color" && item.type !== "gradient")) return document;
    if (item.type === "gradient") {
      const gradient = normalizeGradient(item.gradient);
      if (!gradient || colors.length >= MAX_PALETTE_COLORS) return document;
      const firstColor = gradient.colorStops[0];
      colors.push({
        id: nextColorId(document, colors, index),
        rgba: [
          firstColor.rgb[0],
          firstColor.rgb[1],
          firstColor.rgb[2],
          gradient.alphaStops[0].alpha,
        ],
        gradient,
      });
      changed = true;
      continue;
    }
    if (!isRgba(item.rgba) || typeof item.preserveDuplicate !== "boolean") return document;
    if (
      !item.preserveDuplicate &&
      colors.some(
        (color) => !isPaletteGradient(color) && rgbaEqual(color.rgba, item.rgba, epsilon)
      )
    ) {
      continue;
    }
    if (colors.length >= MAX_PALETTE_COLORS) return document;
    colors.push({ id: nextColorId(document, colors, index), rgba: copyRgba(item.rgba) });
    changed = true;
  }
  if (!changed) return document;
  const next = clonePaletteDocument(document);
  getActivePalette(next).colors = colors;
  next.revision += 1;
  return next;
};

export const addPaletteCollectionEntries = (
  document: PaletteDocument,
  entries: readonly PaletteCollectionEntry[],
  epsilon = COLOR_EPSILON
): PaletteDocument =>
  addPaletteCollectionItems(
    document,
    entries.map((entry) => ({ type: "color", ...entry })),
    epsilon
  );

export const addPaletteGradients = (
  document: PaletteDocument,
  values: readonly unknown[]
): PaletteDocument =>
  Array.isArray(values) && values.length > 0
    ? addPaletteCollectionItems(
        document,
        values.map((gradient) => ({ type: "gradient", gradient } as PaletteCollectionItem))
      )
    : document;

export const replacePaletteColors = (
  document: PaletteDocument,
  paletteId: string,
  colors: PaletteColor[]
): PaletteDocument => {
  const palette = getPalette(document, paletteId);
  if (!palette || !isColorList(colors)) return document;
  const unchanged =
    colors.length === palette.colors.length &&
    colors.every((color, index) => paletteColorEqual(color, palette.colors[index]));
  if (unchanged) return document;
  const next = clonePaletteDocument(document);
  const nextPalette = getPalette(next, paletteId);
  if (!nextPalette) return document;
  nextPalette.colors = colors.map(cloneColor);
  next.revision += 1;
  return next;
};

export const removePaletteColorFromPalette = (
  document: PaletteDocument,
  paletteId: string,
  colorId: string
): PaletteDocument => {
  const palette = getPalette(document, paletteId);
  if (!palette) return document;
  const colors = palette.colors.filter((color) => color.id !== colorId);
  if (colors.length === palette.colors.length) return document;
  const next = clonePaletteDocument(document);
  const nextPalette = getPalette(next, paletteId);
  if (!nextPalette) return document;
  nextPalette.colors = colors.map(cloneColor);
  next.revision += 1;
  return next;
};

export const removePaletteColor = (document: PaletteDocument, colorId: string) =>
  removePaletteColorFromPalette(document, document.activePaletteId, colorId);

export const updatePaletteColorInPalette = (
  document: PaletteDocument,
  paletteId: string,
  colorId: string,
  rgba: Rgba
): PaletteDocument => {
  if (!isRgba(rgba)) return document;
  const palette = getPalette(document, paletteId);
  if (!palette) return document;
  const index = palette.colors.findIndex((color) => color.id === colorId);
  if (index < 0 || isPaletteGradient(palette.colors[index])) return document;
  if (rgbaEqual(palette.colors[index].rgba, rgba, 0)) return document;
  const next = clonePaletteDocument(document);
  const nextPalette = getPalette(next, paletteId);
  if (!nextPalette) return document;
  nextPalette.colors[index] = { id: colorId, rgba: copyRgba(rgba) };
  next.revision += 1;
  return next;
};

export const updatePaletteColor = (document: PaletteDocument, colorId: string, rgba: Rgba) =>
  updatePaletteColorInPalette(document, document.activePaletteId, colorId, rgba);

export const reorderPaletteColorInPalette = (
  document: PaletteDocument,
  paletteId: string,
  sourceId: string,
  targetId: string,
  edge?: PaletteDropEdge
): PaletteDocument => {
  if (sourceId === targetId) return document;
  const palette = getPalette(document, paletteId);
  if (!palette) return document;
  const sourceIndex = palette.colors.findIndex((color) => color.id === sourceId);
  const targetIndex = palette.colors.findIndex((color) => color.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0) return document;

  const colors = palette.colors.map(cloneColor);
  const moved = colors.splice(sourceIndex, 1)[0];
  const targetIndexAfterRemoval = colors.findIndex((color) => color.id === targetId);
  const resolvedEdge = edge ?? (sourceIndex < targetIndex ? "after" : "before");
  colors.splice(targetIndexAfterRemoval + (resolvedEdge === "after" ? 1 : 0), 0, moved);
  if (colors.every((color, index) => color.id === palette.colors[index]?.id)) return document;

  const next = clonePaletteDocument(document);
  const nextPalette = getPalette(next, paletteId);
  if (!nextPalette) return document;
  nextPalette.colors = colors;
  next.revision += 1;
  return next;
};

export const reorderPaletteColor = (
  document: PaletteDocument,
  sourceId: string,
  targetId: string,
  edge?: PaletteDropEdge
) => reorderPaletteColorInPalette(document, document.activePaletteId, sourceId, targetId, edge);
