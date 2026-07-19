import type { Rgba } from "./palette-domain";

export type ColorEditorFormat = "hex" | "rgb" | "cmyk";

const HEX_PATTERN = /^#?([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/;
const DECIMAL_PATTERN = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

export const isDisplayRgba = (rgba: Rgba) =>
  rgba.every((component) => component >= 0 && component <= 1);

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

const byteHex = (fraction: number) =>
  Math.round(clamp01(fraction) * 255)
    .toString(16)
    .padStart(2, "0")
    .toUpperCase();

export const rgbaToHexDisplay = (rgba: Rgba) => {
  const base = `#${byteHex(rgba[0])}${byteHex(rgba[1])}${byteHex(rgba[2])}`;
  return rgba[3] >= 1 ? base : `${base}${byteHex(rgba[3])}`;
};

export const parseHexInput = (text: string, currentAlpha: number): Rgba | null => {
  const match = HEX_PATTERN.exec(text.trim());
  if (!match) return null;
  const digits = match[1];
  const alpha =
    match[2] === undefined ? currentAlpha : Number.parseInt(match[2], 16) / 255;
  return [
    Number.parseInt(digits.slice(0, 2), 16) / 255,
    Number.parseInt(digits.slice(2, 4), 16) / 255,
    Number.parseInt(digits.slice(4, 6), 16) / 255,
    alpha,
  ];
};

const parseDecimal = (text: string, maximum: number): number | null => {
  const trimmed = text.trim();
  if (!DECIMAL_PATTERN.test(trimmed)) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0 || value > maximum) return null;
  return value;
};

export const parseByteInput = (text: string): number | null => {
  const value = parseDecimal(text, 255);
  return value === null ? null : value / 255;
};

export const parsePercentInput = (text: string): number | null => {
  const value = parseDecimal(text, 100);
  return value === null ? null : value / 100;
};

export const cmykToRgb = (
  cyan: number,
  magenta: number,
  yellow: number,
  black: number
): [number, number, number] => [
  (1 - cyan) * (1 - black),
  (1 - magenta) * (1 - black),
  (1 - yellow) * (1 - black),
];

export const rgbToCmykDisplay = (
  rgba: Rgba
): { cyan: number; magenta: number; yellow: number; black: number } => {
  const red = clamp01(rgba[0]);
  const green = clamp01(rgba[1]);
  const blue = clamp01(rgba[2]);
  const black = 1 - Math.max(red, green, blue);
  if (black >= 1) return { cyan: 0, magenta: 0, yellow: 0, black: 1 };
  return {
    cyan: (1 - red - black) / (1 - black),
    magenta: (1 - green - black) / (1 - black),
    yellow: (1 - blue - black) / (1 - black),
    black,
  };
};

const compactNumber = (value: number, decimals: number) => {
  const scale = 10 ** decimals;
  return String(Math.round(value * scale) / scale);
};

export const formatByteValue = (fraction: number) => compactNumber(fraction * 255, 2);

export const formatPercentValue = (fraction: number) => compactNumber(fraction * 100, 1);

export const formatRawRgba = (rgba: Rgba) =>
  rgba.map((component) => String(component)).join(", ");
