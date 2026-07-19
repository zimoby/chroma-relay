import assert from "node:assert/strict";
import test from "node:test";
import {
  EXTRACTION_PRESETS,
  extractPaletteFromRgba,
} from "../src/js/shared/image-palette-domain.ts";

const rgba = (...values: number[]) => Uint8ClampedArray.from(values);

const makeHighKeyFixture = () => {
  const size = 256;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      const accent = x >= 208 && x <= 235 && y >= 204 && y <= 231;
      const level = Math.round(210 + (40 * (x + y)) / 510);
      data[offset] = accent ? 35 : level;
      data[offset + 1] = accent ? 111 : level - 3;
      data[offset + 2] = accent ? 171 : level - 7;
      data[offset + 3] = 255;
    }
  }
  return { data, width: size, height: size };
};

test("freezes three genuinely different guarded extraction presets", () => {
  assert.deepEqual(EXTRACTION_PRESETS, {
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
  });
});

test("ignores fully transparent pixels and preserves exact low-cardinality colors", async () => {
  const result = await extractPaletteFromRgba(
    rgba(
      255, 0, 0, 255,
      0, 0, 0, 0,
      0, 0, 255, 128,
      255, 0, 0, 255
    ),
    2,
    2,
    "contrast"
  );
  assert.equal(result.preset, "contrast");
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.inputPixelCount, 3);
  assert.equal(result.uniqueColorCount, 2);
  assert.deepEqual(result.colors, [
    [1, 0, 0, 1],
    [0, 0, 1, 128 / 255],
  ]);
});

test("rejects images without visible pixels", async () => {
  await assert.rejects(
    extractPaletteFromRgba(rgba(20, 30, 40, 0), 1, 1, "balanced"),
    /no visible colors/i
  );
});

test("filters NeuQuant transparent padding and fills the five-color result with Wu fallback", async () => {
  const fixture = makeHighKeyFixture();
  const result = await extractPaletteFromRgba(
    fixture.data,
    fixture.width,
    fixture.height,
    "tonal"
  );
  assert.equal(result.preset, "tonal");
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.colors.length, 5);
  assert.equal(result.colors.every((color) => color[3] > 0), true);
  assert.equal(
    result.colors.some(([red, green, blue]) => blue > red && blue > green),
    true,
    "the small blue accent should survive extraction"
  );
});

test("validates the RGBA buffer dimensions", async () => {
  await assert.rejects(
    extractPaletteFromRgba(rgba(255, 0, 0, 255), 2, 2, "balanced"),
    /dimensions/i
  );
});
