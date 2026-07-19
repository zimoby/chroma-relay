import {
  buildPaletteSync,
  type ColorDistanceFormula,
  type PaletteQuantization,
  utils,
} from "image-q";
import type { Rgba } from "./palette-domain";
import type { ExtractionPreset } from "./layout-settings-domain";

export const IMAGE_PALETTE_SIZE = 5;

export type ExtractionPresetOptions = {
  paletteQuantization: PaletteQuantization;
  colorDistanceFormula: ColorDistanceFormula;
  fallbackQuantization: PaletteQuantization;
  fallbackDistanceFormula: ColorDistanceFormula;
};

export const EXTRACTION_PRESETS: Record<ExtractionPreset, ExtractionPresetOptions> = {
  balanced: {
    paletteQuantization: "wuquant",
    colorDistanceFormula: "ciede2000",
    fallbackQuantization: "wuquant",
    fallbackDistanceFormula: "ciede2000",
  },
  tonal: {
    paletteQuantization: "neuquant-float",
    colorDistanceFormula: "ciede2000",
    fallbackQuantization: "wuquant",
    fallbackDistanceFormula: "ciede2000",
  },
  contrast: {
    paletteQuantization: "rgbquant",
    colorDistanceFormula: "euclidean-bt709-noalpha",
    fallbackQuantization: "wuquant",
    fallbackDistanceFormula: "euclidean-bt709-noalpha",
  },
};

export type ImagePaletteExtractionResult = {
  preset: ExtractionPreset;
  colors: Rgba[];
  fallbackUsed: boolean;
  inputPixelCount: number;
  uniqueColorCount: number;
};

type QuantizedPoint = {
  r: number;
  g: number;
  b: number;
  a: number;
};

const pointKey = ({ r, g, b, a }: QuantizedPoint) => `${r},${g},${b},${a}`;

const normalizePoint = ({ r, g, b, a }: QuantizedPoint): Rgba => [
  r / 255,
  g / 255,
  b / 255,
  a / 255,
];

const buildColors = (
  source: ReturnType<typeof utils.PointContainer.fromUint8Array>,
  paletteQuantization: PaletteQuantization,
  colorDistanceFormula: ColorDistanceFormula,
  colors: number
) =>
  buildPaletteSync([source], {
    colors,
    paletteQuantization,
    colorDistanceFormula,
  })
    .getPointContainer()
    .getPointArray()
    .filter(({ a }) => a > 0) as QuantizedPoint[];

export const extractPaletteFromRgba = async (
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  preset: ExtractionPreset
): Promise<ImagePaletteExtractionResult> => {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    rgba.length !== width * height * 4
  ) {
    throw new Error("RGBA data does not match the supplied image dimensions");
  }

  const options = EXTRACTION_PRESETS[preset];
  if (!options) throw new Error("Unknown image extraction preset");

  const visible: number[] = [];
  const unique = new Map<string, QuantizedPoint>();
  for (let offset = 0; offset < rgba.length; offset += 4) {
    const alpha = rgba[offset + 3];
    if (alpha === 0) continue;
    const point: QuantizedPoint = {
      r: rgba[offset],
      g: rgba[offset + 1],
      b: rgba[offset + 2],
      a: alpha,
    };
    visible.push(point.r, point.g, point.b, point.a);
    const key = pointKey(point);
    if (!unique.has(key)) unique.set(key, point);
  }

  const inputPixelCount = visible.length / 4;
  if (inputPixelCount === 0) throw new Error("Image contains no visible colors");

  const targetCount = Math.min(IMAGE_PALETTE_SIZE, unique.size);
  if (unique.size <= IMAGE_PALETTE_SIZE) {
    return {
      preset,
      colors: [...unique.values()].map(normalizePoint),
      fallbackUsed: false,
      inputPixelCount,
      uniqueColorCount: unique.size,
    };
  }

  const packed = Uint8Array.from(visible);
  const source = utils.PointContainer.fromUint8Array(packed, inputPixelCount, 1);
  let fallbackUsed = false;
  let points: QuantizedPoint[] = [];
  try {
    points = buildColors(
      source,
      options.paletteQuantization,
      options.colorDistanceFormula,
      targetCount
    );
  } catch (_error) {
    fallbackUsed = true;
  }

  const seen = new Set(points.map(pointKey));
  if (points.length < targetCount) {
    fallbackUsed = true;
    const fallback = buildColors(
      source,
      options.fallbackQuantization,
      options.fallbackDistanceFormula,
      targetCount
    );
    for (const point of fallback) {
      const key = pointKey(point);
      if (seen.has(key)) continue;
      points.push(point);
      seen.add(key);
      if (points.length === targetCount) break;
    }
  }

  return {
    preset,
    colors: points.slice(0, targetCount).map(normalizePoint),
    fallbackUsed,
    inputPixelCount,
    uniqueColorCount: unique.size,
  };
};
