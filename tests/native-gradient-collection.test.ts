import assert from "node:assert/strict";
import { closeSync, ftruncateSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ImmutableNativeGradient } from "@zimoby/ae-native-gradient";

const nodeRequire = createRequire(import.meta.url);
Object.defineProperty(globalThis, "require", { value: nodeRequire, configurable: true });
Object.defineProperty(globalThis, "window", {
  value: { cep: true, cep_node: { require: nodeRequire } },
  configurable: true,
});

const {
  NativeGradientCollectionError,
  alphaAtGradientOffset,
  collectNativeGradientColorsFromProject,
  collectNativeGradientsFromProject,
  nativeGradientToPaletteColors,
} = await import("../src/js/shared/native-gradient-collection.ts");

const gradient = (
  colorStops: ImmutableNativeGradient["colorStops"],
  alphaStops: ImmutableNativeGradient["alphaStops"]
): ImmutableNativeGradient => ({
  schemaVersion: 1,
  colorStops,
  alphaStops,
});

test("converts every ordered color stop with float32 RGB and linear endpoint alpha", () => {
  const source = gradient(
    [
      { offset: 0, midpoint: 0.5, rgb: [0.1, 0.2, 0.3], extra: 0 },
      { offset: 0.25, midpoint: 0.5, rgb: [1.25, -0.5, 0.75], extra: 0 },
      { offset: 0.25, midpoint: 0.25, rgb: [0.9, 0.8, 0.7], extra: 1 },
      { offset: 1, midpoint: 0.5, rgb: [1, 1, 1], extra: 0 },
    ],
    [
      { offset: 0, midpoint: 0.2, alpha: 0.2 },
      { offset: 0.5, midpoint: 0.8, alpha: 0.6 },
      { offset: 1, midpoint: 0.5, alpha: 1 },
    ]
  );

  assert.deepEqual(nativeGradientToPaletteColors(source), [
    [Math.fround(0.1), Math.fround(0.2), Math.fround(0.3), 0.2],
    [Math.fround(1.25), Math.fround(-0.5), Math.fround(0.75), 0.4],
    [Math.fround(0.9), Math.fround(0.8), Math.fround(0.7), 0.4],
    [1, 1, 1, 1],
  ]);
});

test("uses nearest endpoint alpha outside the alpha-stop range", () => {
  const stops = [
    { offset: 0.2, midpoint: 0.5, alpha: 0.3 },
    { offset: 0.8, midpoint: 0.5, alpha: 0.9 },
  ] as const;
  assert.equal(alphaAtGradientOffset(stops, 0), 0.3);
  assert.equal(alphaAtGradientOffset(stops, 1), 0.9);
  assert.equal(alphaAtGradientOffset(stops, 0.5), 0.6);
});

test("rejects duplicate alpha offsets only when they make a required value non-unique", () => {
  const ambiguousStops = [
    { offset: 0, midpoint: 0.5, alpha: 0.2 },
    { offset: 0.5, midpoint: 0.5, alpha: 0.4 },
    { offset: 0.5, midpoint: 0.5, alpha: 0.7 },
    { offset: 1, midpoint: 0.5, alpha: 1 },
  ] as const;
  assert.equal(alphaAtGradientOffset(ambiguousStops, 0), 0.2);
  assert.throws(
    () => alphaAtGradientOffset(ambiguousStops, 0.5),
    (error) =>
      error instanceof NativeGradientCollectionError && error.code === "alpha-ambiguous"
  );
  assert.throws(
    () => alphaAtGradientOffset(ambiguousStops, 0.75),
    (error) =>
      error instanceof NativeGradientCollectionError && error.code === "alpha-ambiguous"
  );
});

test("rejects out-of-order alpha stops and accepts no-op empty descriptor collection", () => {
  assert.throws(
    () =>
      alphaAtGradientOffset(
        [
          { offset: 0.8, midpoint: 0.5, alpha: 1 },
          { offset: 0.2, midpoint: 0.5, alpha: 0 },
        ],
        0.5
      ),
    (error) =>
      error instanceof NativeGradientCollectionError && error.code === "gradient-invalid"
  );
  assert.deepEqual(collectNativeGradientColorsFromProject([]), []);
  assert.deepEqual(collectNativeGradientsFromProject([]), []);
});

test("rejects an oversized sparse AEP before reading or resolving it", () => {
  const directory = mkdtempSync(join(tmpdir(), "chroma-relay-aep-"));
  const filePath = join(directory, "oversized.aep");
  const fileDescriptor = openSync(filePath, "w");
  try {
    ftruncateSync(fileDescriptor, 256 * 1024 * 1024 + 1);
  } finally {
    closeSync(fileDescriptor);
  }
  try {
    assert.throws(
      () =>
        collectNativeGradientColorsFromProject([
          {
            projectPath: filePath,
            projectDirty: false,
            compId: 1,
            layerId: 1,
            layerIndex: 1,
            kind: "fill",
            propertyIndexPath: [1],
            matchNamePath: ["ADBE Vector Grad Colors"],
          },
        ]),
      (error) =>
        error instanceof NativeGradientCollectionError && error.code === "project-read-failed"
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
