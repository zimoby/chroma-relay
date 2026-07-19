import { validateGeneratedGradient, type NativeGradient } from "@zimoby/ae-native-gradient";
import { rgbaToCss, type Rgba } from "./palette-domain.ts";

type NumericStop<T> = Readonly<{ offset: number; value: T }>;

const sampleStops = <T>(
  stops: readonly NumericStop<T>[],
  offset: number,
  interpolate: (left: T, right: T, progress: number) => T
): T => {
  if (offset <= stops[0].offset) return stops[0].value;
  if (offset >= stops[stops.length - 1].offset) return stops[stops.length - 1].value;
  for (let index = 1; index < stops.length; index += 1) {
    const upper = stops[index];
    if (offset > upper.offset) continue;
    if (offset === upper.offset) {
      let duplicateIndex = index;
      while (
        duplicateIndex + 1 < stops.length &&
        stops[duplicateIndex + 1].offset === offset
      ) {
        duplicateIndex += 1;
      }
      return stops[duplicateIndex].value;
    }
    const lower = stops[index - 1];
    const progress = (offset - lower.offset) / (upper.offset - lower.offset);
    return interpolate(lower.value, upper.value, progress);
  }
  return stops[stops.length - 1].value;
};

const formatPercent = (offset: number) => {
  const fixed = (offset * 100).toFixed(3).replace(/\.?0+$/, "");
  return `${fixed}%`;
};

export const nativeGradientToCssPreview = (value: unknown): string => {
  const gradient: NativeGradient = validateGeneratedGradient(value);
  const colorStops: Array<NumericStop<readonly [number, number, number]>> =
    gradient.colorStops.map((stop) => ({ offset: stop.offset, value: stop.rgb }));
  const alphaStops: Array<NumericStop<number>> = gradient.alphaStops.map((stop) => ({
    offset: stop.offset,
    value: stop.alpha,
  }));
  const offsets = Array.from(
    new Set([
      ...gradient.colorStops.map((stop) => stop.offset),
      ...gradient.alphaStops.map((stop) => stop.offset),
    ])
  ).sort((left, right) => left - right);
  const parts = offsets.map((offset) => {
    const rgb = sampleStops(
      colorStops,
      offset,
      (left, right, progress): readonly [number, number, number] => [
        left[0] + (right[0] - left[0]) * progress,
        left[1] + (right[1] - left[1]) * progress,
        left[2] + (right[2] - left[2]) * progress,
      ]
    );
    const alpha = sampleStops(
      alphaStops,
      offset,
      (left, right, progress) => left + (right - left) * progress
    );
    return `${rgbaToCss([rgb[0], rgb[1], rgb[2], alpha] as Rgba)} ${formatPercent(offset)}`;
  });
  return `linear-gradient(90deg, ${parts.join(", ")})`;
};
