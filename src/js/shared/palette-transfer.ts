import { validateGeneratedGradient } from "@zimoby/ae-native-gradient";
import {
  MAX_PALETTE_COLORS,
  MAX_PALETTE_NAME_LENGTH,
  type PaletteColor,
  type PaletteImportItem,
  type Rgba,
  isRgba,
} from "./palette-domain.ts";
import contract from "../../shared/product-contract.json" with { type: "json" };

export const PALETTE_TRANSFER_FORMAT = contract.compatibility.portableFormat;
export const PALETTE_TRANSFER_VERSION = contract.schemas.portable as 2;
export const PALETTE_TRANSFER_EXTENSION = contract.portable.fileExtension;
export const MAX_PALETTE_TRANSFER_BYTES = 1024 * 1024;

export type PortablePalette = {
  format: typeof PALETTE_TRANSFER_FORMAT;
  version: typeof PALETTE_TRANSFER_VERSION;
  name: string;
  items: PaletteImportItem[];
};

export type PortablePaletteParseResult =
  | { ok: true; name: string; items: PaletteImportItem[]; colors: Rgba[] }
  | { ok: false; error: string };

const copyRgba = (rgba: Rgba): Rgba => [rgba[0], rgba[1], rgba[2], rgba[3]];

const isPortableName = (value: unknown): value is string =>
  typeof value === "string" &&
  value === value.trim() &&
  value.length > 0 &&
  value.length <= MAX_PALETTE_NAME_LENGTH;

const normalizePortableItem = (value: unknown): PaletteImportItem | null => {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<PaletteImportItem>;
  if (!isRgba(candidate.rgba)) return null;
  if (candidate.gradient === undefined) return { rgba: copyRgba(candidate.rgba) };
  try {
    return {
      rgba: copyRgba(candidate.rgba),
      gradient: validateGeneratedGradient(candidate.gradient),
    };
  } catch {
    return null;
  }
};

export const serializePortablePalette = (
  name: string,
  values: readonly (Rgba | PaletteColor)[]
): string => {
  const items = values.map((value) =>
    normalizePortableItem(Array.isArray(value) ? { rgba: value } : value)
  );
  if (items.some((item) => item === null)) throw new Error("Palette contains an invalid item");
  const payload: PortablePalette = {
    format: PALETTE_TRANSFER_FORMAT,
    version: PALETTE_TRANSFER_VERSION,
    name,
    items: items as PaletteImportItem[],
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
};

export const parsePortablePalette = (text: string): PortablePaletteParseResult => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, error: "File is not valid JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: `File is not a ${contract.product.displayName} export` };
  }
  const record = parsed as Record<string, unknown>;
  if (record.format !== PALETTE_TRANSFER_FORMAT) {
    return { ok: false, error: `File is not a ${contract.product.displayName} export` };
  }
  if (record.version !== 1 && record.version !== PALETTE_TRANSFER_VERSION) {
    return { ok: false, error: "Palette export version is not supported" };
  }
  if (!isPortableName(record.name)) {
    return {
      ok: false,
      error: `Palette name must be trimmed, non-empty, and at most ${MAX_PALETTE_NAME_LENGTH} characters`,
    };
  }
  const rawItems =
    record.version === 1
      ? Array.isArray(record.colors)
        ? record.colors
        : null
      : Array.isArray(record.items)
        ? record.items
        : null;
  if (!rawItems) return { ok: false, error: "Palette items are missing" };
  if (rawItems.length > MAX_PALETTE_COLORS) {
    return { ok: false, error: `Palette holds more than ${MAX_PALETTE_COLORS} colors` };
  }
  const items: PaletteImportItem[] = [];
  for (const rawItem of rawItems) {
    const item = normalizePortableItem(rawItem);
    if (!item) return { ok: false, error: "Each palette item is invalid" };
    items.push(item);
  }
  return {
    ok: true,
    name: record.name as string,
    items,
    colors: items.map((item) => copyRgba(item.rgba)),
  };
};

export const portablePaletteFileName = (name: string): string => {
  const safe = name
    .replace(/[\u0000-\u001f\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.+$/, "");
  return `${safe || "palette"}${PALETTE_TRANSFER_EXTENSION}`;
};

export const ensureJsonExtension = (filePath: string): string =>
  /\.json$/i.test(filePath) ? filePath : `${filePath}.json`;
