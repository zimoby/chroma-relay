import test from "node:test";
import assert from "node:assert/strict";
import type { Rgba } from "../src/js/shared/palette-domain.ts";
import {
  cmykToRgb,
  formatByteValue,
  formatPercentValue,
  formatRawRgba,
  isDisplayRgba,
  parseByteInput,
  parseHexInput,
  parsePercentInput,
  rgbToCmykDisplay,
  rgbaToHexDisplay,
} from "../src/js/shared/color-format.ts";

const closeTo = (actual: number, expected: number, epsilon = 1e-12) =>
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `${actual} should be within ${epsilon} of ${expected}`
  );

test("hex parsing produces exact byte fractions and preserves alpha for six digits", () => {
  assert.deepEqual(parseHexInput("#33669980", 1), [
    51 / 255,
    102 / 255,
    153 / 255,
    128 / 255,
  ]);
  assert.deepEqual(parseHexInput("336699", 0.875), [51 / 255, 102 / 255, 153 / 255, 0.875]);
  assert.deepEqual(parseHexInput("  #ffFFff  ", 0.25), [1, 1, 1, 0.25]);
  assert.deepEqual(parseHexInput("#000000FF", 0.25), [0, 0, 0, 1]);
  assert.equal(parseHexInput("#33669", 1), null);
  assert.equal(parseHexInput("#3366zz", 1), null);
  assert.equal(parseHexInput("", 1), null);
  assert.equal(parseHexInput("#336699801", 1), null);
  assert.equal(parseHexInput("rgb(1,2,3)", 1), null);
});

test("decimal RGB and percent fields convert deterministically and reject out-of-range", () => {
  assert.equal(parseByteInput("216.5"), 216.5 / 255);
  assert.equal(parseByteInput("0"), 0);
  assert.equal(parseByteInput("255"), 1);
  assert.equal(parseByteInput(" 12 "), 12 / 255);
  assert.equal(parseByteInput(".5"), 0.5 / 255);
  assert.equal(parseByteInput("256"), null);
  assert.equal(parseByteInput("-1"), null);
  assert.equal(parseByteInput("1e2"), null);
  assert.equal(parseByteInput(""), null);
  assert.equal(parseByteInput("12,5"), null);
  assert.equal(parsePercentInput("100"), 1);
  assert.equal(parsePercentInput("37.5"), 0.375);
  assert.equal(parsePercentInput("0"), 0);
  assert.equal(parsePercentInput("100.1"), null);
  assert.equal(parsePercentInput("abc"), null);
});

test("CMYK uses the standard device conversion for black, white, and basic colors", () => {
  assert.deepEqual(cmykToRgb(0, 0, 0, 1), [0, 0, 0]);
  assert.deepEqual(cmykToRgb(0, 0, 0, 0), [1, 1, 1]);
  assert.deepEqual(cmykToRgb(1, 0, 0, 0), [0, 1, 1]);
  assert.deepEqual(cmykToRgb(0.2, 0.4, 0.6, 0.5), [
    (1 - 0.2) * 0.5,
    (1 - 0.4) * 0.5,
    (1 - 0.6) * 0.5,
  ]);
  assert.deepEqual(rgbToCmykDisplay([0, 0, 0, 1]), {
    cyan: 0,
    magenta: 0,
    yellow: 0,
    black: 1,
  });
  assert.deepEqual(rgbToCmykDisplay([1, 1, 1, 1]), {
    cyan: 0,
    magenta: 0,
    yellow: 0,
    black: 0,
  });

  const source: Rgba = [0.4, 0.3, 0.2, 1];
  const cmyk = rgbToCmykDisplay(source);
  const roundTrip = cmykToRgb(cmyk.cyan, cmyk.magenta, cmyk.yellow, cmyk.black);
  closeTo(roundTrip[0], 0.4);
  closeTo(roundTrip[1], 0.3);
  closeTo(roundTrip[2], 0.2);

  const hdr: Rgba = [1.25, -0.1, 0.5, 1];
  rgbToCmykDisplay(hdr);
  assert.deepEqual(hdr, [1.25, -0.1, 0.5, 1], "display conversion never mutates input");
});

test("hex display is clamped for display only and flags out-of-gamut values", () => {
  assert.equal(rgbaToHexDisplay([51 / 255, 102 / 255, 153 / 255, 1]), "#336699");
  assert.equal(rgbaToHexDisplay([51 / 255, 102 / 255, 153 / 255, 128 / 255]), "#33669980");
  const hdr: Rgba = [1.25, -0.1, 0.5000004, 1];
  assert.equal(rgbaToHexDisplay(hdr), "#FF0080");
  assert.deepEqual(hdr, [1.25, -0.1, 0.5000004, 1]);
  assert.equal(isDisplayRgba(hdr), false);
  assert.equal(isDisplayRgba([0, 1, 0.5, 1]), true);
  assert.equal(isDisplayRgba([0, 0, 0, 1.0001]), false);
  assert.equal(
    formatRawRgba([1.25, -0.1, 0.5000004, 0.875]),
    "1.25, -0.1, 0.5000004, 0.875"
  );
});

test("compact field formatting rounds the display string only", () => {
  assert.equal(formatByteValue(216 / 255), "216");
  assert.equal(formatByteValue(0.5), "127.5");
  assert.equal(formatByteValue(1 / 3), "85");
  assert.equal(formatByteValue(216.5 / 255), "216.5");
  assert.equal(formatPercentValue(1), "100");
  assert.equal(formatPercentValue(128 / 255), "50.2");
  assert.equal(formatPercentValue(0.875), "87.5");
  assert.equal(formatPercentValue(0), "0");
});
