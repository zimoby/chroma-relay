import assert from "node:assert/strict";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { NATIVE_GRADIENT_TEMPLATE_METADATA } from "@zimoby/ae-native-gradient";

const nodeRequire = createRequire(import.meta.url);
Object.defineProperty(globalThis, "require", { value: nodeRequire, configurable: true });
Object.defineProperty(globalThis, "window", {
  value: { cep: true, cep_node: { require: nodeRequire } },
  configurable: true,
});

const {
  NativeGradientFileError,
  applyActivePaletteNativeGradient,
  cleanupNativeGradientPreset,
  createNativeGradientPreset,
  decodeNativeGradientApplyResult: decodeNativeGradientApplyResultWire,
  getNativeGradientTempBasePath,
  nativeGradientResultMessage,
  paletteRgbaToNativeGradient,
  probeNativeGradientNodeCapabilities,
  resolveNativeGradientRuntime,
  validateNativeGradientForApplication,
} = await import("../src/js/main/native-gradient-files.ts");
const {
  boundNativeGradientDiagnostics,
  MAX_NATIVE_GRADIENT_DIAGNOSTIC_LENGTH,
  orchestrateNativeGradientCollection,
  resolveNativeGradientCollectionDecision,
  resolveNativeGradientCollectionRuntime,
} = await import(
  "../src/js/shared/native-gradient-contract.ts"
);
const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const AE22_FILL_TEMPLATE = fileURLToPath(
  import.meta.resolve("@zimoby/ae-native-gradient/templates/ae22-6/fill.ffx"),
);
const TOOLKIT_TEMPLATE_ROOT = dirname(dirname(AE22_FILL_TEMPLATE));
const TOOLKIT_TEMPLATES = {
  fill: AE22_FILL_TEMPLATE,
  stroke: fileURLToPath(
    import.meta.resolve("@zimoby/ae-native-gradient/templates/ae22-6/stroke.ffx"),
  ),
} as const;
const TEMPLATE_SHA256 = {
  fill: NATIVE_GRADIENT_TEMPLATE_METADATA["ae22-6"].fill.sha256,
  stroke: NATIVE_GRADIENT_TEMPLATE_METADATA["ae22-6"].stroke.sha256,
} as const;
const RENDERER_HOST_VERSION = "22.6.5";
const decodeNativeGradientApplyResult = (
  value: unknown,
  expectedHostVersion = RENDERER_HOST_VERSION,
) => decodeNativeGradientApplyResultWire(value, expectedHostVersion);
const rendererOptions = (palette: readonly [number, number, number, number][], base: string) => ({
  palette,
  tempBasePath: base,
  templateRootPath: TOOLKIT_TEMPLATE_ROOT,
  hostVersion: RENDERER_HOST_VERSION,
  platform: "darwin",
  includeDisabledTargets: false,
  smartApply: false,
});
const rgba = (index: number): [number, number, number, number] => [
  index / 10,
  (index + 1) / 10,
  (index + 2) / 10,
  (index + 3) / 10,
];
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const float32Gradient = (gradient: ReturnType<typeof paletteRgbaToNativeGradient>) => ({
  schemaVersion: 1 as const,
  colorStops: gradient.colorStops.map((stop) => ({
    ...stop,
    offset: Math.fround(stop.offset),
    midpoint: Math.fround(stop.midpoint),
    rgb: stop.rgb.map(Math.fround),
    extra: Math.fround(stop.extra),
  })),
  alphaStops: gradient.alphaStops.map((stop) => ({
    ...stop,
    offset: Math.fround(stop.offset),
    midpoint: Math.fround(stop.midpoint),
    alpha: Math.fround(stop.alpha),
  })),
});
const validTarget = {
  compId: 1,
  layerId: 2,
  layerIndex: 1,
  kind: "fill",
  propertyIndexPath: [1, 1, 1, 1],
  matchNamePath: [
    "ADBE Root Vectors Group",
    "ADBE Vector Group",
    "ADBE Vector Graphic - G-Fill",
    "ADBE Vector Grad Colors",
  ],
};
const validHostResult = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  status: "ok",
  primaryStatus: "ok",
  hostVersion: RENDERER_HOST_VERSION,
  target: validTarget,
  targets: [validTarget],
  selectedTargetCount: 1,
  selectedPropertyCount: 1,
  attemptedTargetCount: 1,
  attemptedPropertyCount: 1,
  appliedTargetCount: 1,
  appliedPropertyCount: 1,
  failedTargetIndex: null,
  failedPropertyIndex: null,
  unknownCompletionTargetIndex: null,
  unknownCompletionPropertyIndex: null,
  skippedDisabledCount: 0,
  skippedDisabledBranchCount: 0,
  preservedStateCount: 0,
  preservedPropertyCount: 0,
  mutationAttempted: true,
  applyCompleted: true,
  undoGroupOpened: true,
  undoGroupCloseAttempted: true,
  undoGroupClosed: true,
  selectionRestoreAttempted: true,
  selectionRestored: true,
  selectionRestorationMode:
    overrides.selectionRestorationMode ??
    (overrides.selectionRestoreAttempted === false
      ? "not-attempted"
      : overrides.selectionRestored === false
        ? "failed"
        : "exact"),
  applyError: null,
  ...overrides,
});
const failedSelectionDiagnostics = () => ({
  schemaVersion: 1,
  inGroup: {
    stage: "verify",
    error: {
      name: "Error",
      message: "Selection restoration was not exact",
      line: null,
      number: null,
    },
    expected: [{
      layerId: 2,
      layerIndex: 1,
      selected: true,
      properties: [{
        propertyIndexPath: validTarget.propertyIndexPath,
        matchNamePath: validTarget.matchNamePath,
      }],
    }],
    expectedTruncated: false,
    actual: [{ layerId: 2, layerIndex: 1, selected: true, properties: [] }],
    actualTruncated: false,
    exact: false,
    acceptedNormalization: false,
    layers: [],
    layersTruncated: false,
  },
  afterUndoGroup: {
    actual: [{ layerId: 2, layerIndex: 1, selected: true, properties: [] }],
    actualTruncated: false,
    exact: false,
    acceptedNormalization: false,
  },
});
const validUnknownHostResult = (overrides: Record<string, unknown> = {}) =>
  validHostResult({
    status: "apply-unknown-completion",
    primaryStatus: "apply-unknown-completion",
    attemptedTargetCount: 1,
    attemptedPropertyCount: 1,
    appliedTargetCount: 0,
    appliedPropertyCount: 0,
    failedTargetIndex: null,
    failedPropertyIndex: null,
    unknownCompletionTargetIndex: 0,
    unknownCompletionPropertyIndex: 0,
    mutationAttempted: true,
    applyCompleted: false,
    applyError: { name: "Error", message: "unknown", line: null, number: null },
    ...overrides,
  });
const withTempBase = async (run: (base: string) => void | Promise<void>) => {
  const base = mkdtempSync(join(tmpdir(), "chroma-relay-native-gradient-test-"));
  try {
    await run(base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
};
const assertFileError = (code: string) => (error: unknown) =>
  error instanceof NativeGradientFileError && error.code === code;

for (const count of [2, 3, 8]) {
  test(`constructs an exact ordered ${count}-color native gradient`, () => {
    const colors = Array.from({ length: count }, (_, index) => rgba(index));
    const gradient = paletteRgbaToNativeGradient(colors);

    assert.equal(gradient.schemaVersion, 1);
    assert.equal(gradient.colorStops.length, count);
    assert.equal(gradient.alphaStops.length, count);
    for (let index = 0; index < count; index += 1) {
      const offset = index / (count - 1);
      assert.deepEqual(gradient.colorStops[index], {
        offset,
        midpoint: 0.5,
        rgb: colors[index].slice(0, 3),
        extra: 1,
      });
      assert.deepEqual(gradient.alphaStops[index], {
        offset,
        midpoint: 0.5,
        alpha: colors[index][3],
      });
    }
  });
}

test("rejects count, shape, non-finite, and out-of-range RGBA before filesystem mutation", async () => {
  const invalidPalettes: unknown[] = [
    [rgba(0)],
    Array.from({ length: 9 }, (_, index) => rgba(index)),
    new Array(2),
    [[0, 0, 0]],
    [[0, 0, 0, 1], [Number.NaN, 0, 0, 1]],
    [[0, 0, 0, 1], [0, 0, 0, Number.NaN]],
    [[0, 0, 0, 1], [0, 0, Number.POSITIVE_INFINITY, 1]],
    [[0, 0, 0, 1], [Number.NEGATIVE_INFINITY, 0, 0, 1]],
    [[0, 0, 0, 1], [0, 0, 0, Number.POSITIVE_INFINITY]],
    [[0, 0, 0, 1], [0, 0, 0, Number.NEGATIVE_INFINITY]],
    [[0, 0, 0, 1], [-0.001, 0, 0, 1]],
    [[0, 0, 0, 1], [0, 1.001, 0, 1]],
    [[0, 0, 0, 1], [0, 0, 0, -0.001]],
    [[0, 0, 0, 1], [0, 0, 0, 1.001]],
  ];

  for (const palette of invalidPalettes) {
    assert.throws(() => paletteRgbaToNativeGradient(palette), assertFileError("palette-invalid"));
  }

  await withTempBase((base) => {
    const before = readdirSync(base);
    assert.throws(
      () =>
        createNativeGradientPreset({
          palette: [[0, 0, 0, 1]],
          kind: "fill",
          tempBasePath: base,
          templatePath: join(base, "missing-template.ffx"),
        }),
      assertFileError("palette-invalid"),
    );
    assert.deepEqual(readdirSync(base), before);
  });
});

test("uses toolkit-owned templates and stages every supported family", () => {
  for (const family of ["ae22-6", "ae25-6", "ae26-3"] as const) {
    for (const kind of ["fill", "stroke"] as const) {
      const templatePath = fileURLToPath(
        import.meta.resolve(`@zimoby/ae-native-gradient/templates/${family}/${kind}.ffx`),
      );
      const bytes = readFileSync(templatePath);
      assert.equal(sha256(bytes), NATIVE_GRADIENT_TEMPLATE_METADATA[family][kind].sha256);
    }
  }

  const config = readFileSync(join(REPO_ROOT, "cep.config.ts"), "utf8");
  assert.doesNotMatch(config, /assets\/native-gradient\/ae(?:22|25|26)/);
  const viteConfig = readFileSync(join(REPO_ROOT, "vite.config.ts"), "utf8");
  assert.match(viteConfig, /NATIVE_GRADIENT_TEMPLATE_METADATA/);
  assert.match(viteConfig, /templates\/\$\{family\}\/\$\{kind\}\.ffx/);
  const liveRunner = readFileSync(join(REPO_ROOT, "scripts/run-live-ae-tests.mjs"), "utf8");
  assert.match(liveRunner, /templates\/ae25-6\/fill\.ffx/);
  assert.match(liveRunner, /templates\/ae25-6\/stroke\.ffx/);
  for (const family of ["ae22-6", "ae25-6", "ae26-3"]) {
    assert.match(liveRunner, new RegExp(`assets/native-gradient/${family}/fill-template\\.ffx`));
    assert.match(liveRunner, new RegExp(`assets/native-gradient/${family}/stroke-template\\.ffx`));
  }
});

test("atomically publishes a token-owned preset and reports exact generated evidence", async () => {
  await withTempBase((base) => {
    const palette = [rgba(0), rgba(1), rgba(2)];
    const lease = createNativeGradientPreset({
      palette,
      kind: "fill",
      tempBasePath: base,
      templatePath: TOOLKIT_TEMPLATES.fill,
    });

    assert.match(lease.runToken, /^[A-F0-9]{32}$/);
    assert.equal(lease.kind, "fill");
    assert.equal(lease.stopCount, 3);
    const canonicalBase = realpathSync(resolve(base));
    assert.equal(
      lease.rootPath,
      join(canonicalBase, `chroma-relay-native-gradient-${lease.runToken}`),
    );
    assert.equal(dirname(lease.rootPath), canonicalBase);
    assert.equal(
      lease.filename,
      `chroma-relay-native-gradient-${lease.runToken}-fill-3.ffx`,
    );
    assert.equal(lease.presetPath, join(lease.rootPath, lease.filename));
    assert.equal(basename(lease.presetPath), lease.filename);
    assert.deepEqual(readdirSync(lease.rootPath), [lease.filename]);

    const published = readFileSync(lease.presetPath);
    assert.equal(lease.byteLength, published.byteLength);
    assert.equal(lease.sha256, sha256(published));
    assert.equal(lease.templateSha256, TEMPLATE_SHA256.fill);
    assert.equal(lease.toolkitReport.schemaVersion, 1);
    assert.equal(lease.toolkitReport.kind, "fill");
    assert.equal(lease.toolkitReport.kindEvidence.expectedCount, 1);
    assert.equal(lease.toolkitReport.kindEvidence.oppositeCount, 0);
    assert.deepEqual(
      lease.toolkitReport.gradient,
      float32Gradient(paletteRgbaToNativeGradient(palette)),
    );

    const cleaned = cleanupNativeGradientPreset(lease);
    assert.deepEqual(cleaned, {
      removed: true,
      alreadyAbsent: false,
      preserved: false,
      evidenceRootPath: null,
      evidencePresetPath: null,
    });
    assert.equal(existsSync(lease.rootPath), false);
    assert.deepEqual(cleanupNativeGradientPreset(lease), {
      removed: false,
      alreadyAbsent: true,
      preserved: false,
      evidenceRootPath: null,
      evidencePresetPath: null,
    });
  });
});

test("publishes an exact stored gradient without rebuilding evenly spaced stops", async () => {
  await withTempBase((base) => {
    const gradient = validateNativeGradientForApplication({
      schemaVersion: 1,
      colorStops: [
        { offset: 0, midpoint: 0.2, rgb: [0.1, 0.2, 0.3], extra: 7 },
        { offset: 0.7, midpoint: 0.8, rgb: [0.8, 0.4, 0.2], extra: 0 },
      ],
      alphaStops: [
        { offset: 0, midpoint: 0.3, alpha: 0.25 },
        { offset: 0.35, midpoint: 0.7, alpha: 0.9 },
        { offset: 1, midpoint: 0.5, alpha: 1 },
      ],
    });
    const lease = createNativeGradientPreset({
      gradient,
      kind: "fill",
      tempBasePath: base,
      templatePath: TOOLKIT_TEMPLATES.fill,
    });
    assert.equal(lease.stopCount, 2);
    assert.deepEqual(lease.toolkitReport.gradient, gradient);
    cleanupNativeGradientPreset(lease);

    assert.throws(
      () =>
        validateNativeGradientForApplication({
          ...gradient,
          colorStops: [
            { ...gradient.colorStops[0], rgb: [1.1, 0.2, 0.3] },
            gradient.colorStops[1],
          ],
        }),
      assertFileError("gradient-invalid")
    );
  });
});

test("uses the matching stroke template and rejects a kind-substituted template", async () => {
  await withTempBase((base) => {
    const lease = createNativeGradientPreset({
      palette: [rgba(0), rgba(1)],
      kind: "stroke",
      tempBasePath: base,
      templatePath: TOOLKIT_TEMPLATES.stroke,
    });
    assert.equal(lease.kind, "stroke");
    assert.equal(lease.templateSha256, TEMPLATE_SHA256.stroke);
    assert.equal(lease.toolkitReport.kind, "stroke");
    cleanupNativeGradientPreset(lease);

    assert.throws(
      () =>
        createNativeGradientPreset({
          palette: [rgba(0), rgba(1)],
          kind: "stroke",
          tempBasePath: base,
          templatePath: TOOLKIT_TEMPLATES.fill,
        }),
      assertFileError("template-mismatch"),
    );

    const wrongFamilyRoot = join(base, "wrong-family", "ae22-6");
    mkdirSync(wrongFamilyRoot, { recursive: true });
    const wrongFamilyTemplate = join(wrongFamilyRoot, "fill-template.ffx");
    writeFileSync(
      wrongFamilyTemplate,
      readFileSync(fileURLToPath(import.meta.resolve("@zimoby/ae-native-gradient/templates/fill.ffx"))),
    );
    assert.throws(
      () =>
        createNativeGradientPreset({
          palette: [rgba(0), rgba(1)],
          kind: "fill",
          tempBasePath: base,
          templatePath: wrongFamilyTemplate,
        }),
      assertFileError("template-mismatch"),
    );
    rmSync(join(base, "wrong-family"), { recursive: true });
    assert.deepEqual(readdirSync(base), []);
  });
});

test("refuses a cryptographic token collision without disturbing the first preset", async () => {
  await withTempBase((base) => {
    const cryptoModule = nodeRequire("crypto") as {
      randomBytes: (size: number) => Buffer;
    };
    const originalRandomBytes = cryptoModule.randomBytes;
    cryptoModule.randomBytes = (size: number) => Buffer.alloc(size, 0xab);
    let lease: ReturnType<typeof createNativeGradientPreset> | undefined;
    try {
      lease = createNativeGradientPreset({
        palette: [rgba(0), rgba(1)],
        kind: "fill",
        tempBasePath: base,
        templatePath: TOOLKIT_TEMPLATES.fill,
      });
      assert.throws(
        () =>
          createNativeGradientPreset({
            palette: [rgba(0), rgba(1)],
            kind: "fill",
            tempBasePath: base,
            templatePath: TOOLKIT_TEMPLATES.fill,
          }),
        assertFileError("path-collision"),
      );
      assert.equal(existsSync(lease.presetPath), true);
    } finally {
      cryptoModule.randomBytes = originalRandomBytes;
      if (lease) cleanupNativeGradientPreset(lease);
    }
  });
});

test("cleanup refuses extra-entry collision, content tamper, and traversal-shaped leases", async () => {
  await withTempBase((base) => {
    const lease = createNativeGradientPreset({
      palette: [rgba(0), rgba(1)],
      kind: "fill",
      tempBasePath: base,
      templatePath: TOOLKIT_TEMPLATES.fill,
    });
    const original = readFileSync(lease.presetPath);

    const collisionPath = join(lease.rootPath, "unexpected-entry");
    writeFileSync(collisionPath, "collision");
    assert.throws(() => cleanupNativeGradientPreset(lease), assertFileError("cleanup-refused"));
    assert.equal(existsSync(collisionPath), true);
    unlinkSync(collisionPath);

    const descriptor = openSync(lease.presetPath, "r+");
    try {
      writeSync(descriptor, Buffer.from([original[0] ^ 0xff]), 0, 1, 0);
    } finally {
      closeSync(descriptor);
    }
    assert.throws(() => cleanupNativeGradientPreset(lease), assertFileError("cleanup-refused"));
    assert.equal(existsSync(lease.rootPath), true);
    writeFileSync(lease.presetPath, original);

    const victimRoot = join(base, "victim");
    writeFileSync(victimRoot, "do-not-remove");
    const traversalLease = {
      ...lease,
      rootPath: join(base, "..", basename(base), "victim"),
      presetPath: join(base, "..", basename(base), "victim", lease.filename),
    };
    assert.throws(
      () => cleanupNativeGradientPreset(traversalLease),
      assertFileError("cleanup-refused"),
    );
    assert.equal(readFileSync(victimRoot, "utf8"), "do-not-remove");

    cleanupNativeGradientPreset(lease);
  });
});

test("capability probe records CEP facts, exercises rename, and leaves no residue", async () => {
  await withTempBase((base) => {
    const before = readdirSync(base);
    const report = probeNativeGradientNodeCapabilities({
      testTempBasePath: base,
      userAgent: "ChromaRelayCapabilityTest/1",
    });

    assert.equal(report.passed, true);
    assert.equal(report.processVersion, process.version);
    assert.equal(report.userAgent, "ChromaRelayCapabilityTest/1");
    assert.deepEqual(report.capabilities, { fs: true, crypto: true, rename: true });
    assert.deepEqual(report.renameProbe, { attempted: true, passed: true });
    assert.deepEqual(report.errors, []);
    assert.deepEqual(readdirSync(base), before);
  });
});

test("capability probe is injectable and fails closed when modules are unavailable", async () => {
  await withTempBase((base) => {
    const report = probeNativeGradientNodeCapabilities(
      { testTempBasePath: base, userAgent: "InjectedCEP/0" },
      { processVersion: "v0.0.0", fs: null, path: null, crypto: null },
    );

    assert.equal(report.passed, false);
    assert.equal(report.processVersion, "v0.0.0");
    assert.equal(report.userAgent, "InjectedCEP/0");
    assert.deepEqual(report.capabilities, { fs: false, crypto: false, rename: false });
    assert.deepEqual(report.renameProbe, { attempted: false, passed: false });
    assert.ok(report.errors.length > 0);
    assert.deepEqual(readdirSync(base), []);
  });
});

test("capability probe preserves a colliding non-owned root", async () => {
  await withTempBase((base) => {
    const cryptoModule = nodeRequire("crypto") as { randomBytes: (size: number) => Buffer };
    const originalRandomBytes = cryptoModule.randomBytes;
    const token = "AB".repeat(16);
    const collidingRoot = join(
      realpathSync(base),
      `chroma-relay-native-gradient-PROBE-${token}`,
    );
    mkdirSync(collidingRoot);
    cryptoModule.randomBytes = (size: number) => Buffer.alloc(size, 0xab);
    try {
      const report = probeNativeGradientNodeCapabilities({
        testTempBasePath: base,
        userAgent: "CollisionProbe/1",
      });
      assert.equal(report.passed, false);
      assert.equal(existsSync(collidingRoot), true);
    } finally {
      cryptoModule.randomBytes = originalRandomBytes;
      rmSync(collidingRoot, { recursive: true, force: true });
    }
  });
});

test("capability probe bounds an injected oversized capability error", async () => {
  await withTempBase((base) => {
    const fsModule = nodeRequire("fs") as typeof import("node:fs");
    const oversizedError = "capability-error-".repeat(1000);
    const boundedFs = {
      ...fsModule,
      mkdirSync: () => {
        throw new Error(oversizedError);
      },
    } as typeof fsModule;
    const report = probeNativeGradientNodeCapabilities(
      { testTempBasePath: base, userAgent: "CapabilityLimit/1" },
      { fs: boundedFs },
    );
    assert.equal(report.passed, false);
    assert.equal(report.errors.length <= 16, true);
    assert.equal(report.errors.every((error) => error.length <= 512), true);
    assert.equal(report.errors.some((error) => error.includes("capability-error-")), true);
  });
});

test("publication uses exclusive temp write and rename, then cleans rename and hash failures", async () => {
  await withTempBase((base) => {
    const fsModule = nodeRequire("fs") as typeof import("node:fs");
    const originalOpenSync = fsModule.openSync;
    const originalRenameSync = fsModule.renameSync;
    const originalReadFileSync = fsModule.readFileSync;
    let exclusiveTempOpened = false;
    let renamed = false;
    let finalReread = false;

    (fsModule as any).openSync = (filePath: string, flags: string, mode?: number) => {
      if (filePath.includes("chroma-relay-native-gradient-") && filePath.endsWith(".tmp")) {
        exclusiveTempOpened = flags === "wx";
      }
      return originalOpenSync(filePath, flags, mode);
    };
    (fsModule as any).renameSync = (sourcePath: string, destinationPath: string) => {
      assert.equal(sourcePath.endsWith(".tmp"), true);
      assert.equal(destinationPath.endsWith(".ffx"), true);
      assert.equal(existsSync(sourcePath), true);
      assert.equal(existsSync(destinationPath), false);
      renamed = true;
      return originalRenameSync(sourcePath, destinationPath);
    };
    (fsModule as any).readFileSync = (filePath: string, ...args: any[]) => {
      if (renamed && filePath.endsWith(".ffx") && filePath.includes(realpathSync(base))) {
        finalReread = true;
      }
      return (originalReadFileSync as any)(filePath, ...args);
    };
    try {
      const lease = createNativeGradientPreset({
        palette: [rgba(0), rgba(1)],
        kind: "fill",
        tempBasePath: base,
        templatePath: TOOLKIT_TEMPLATES.fill,
      });
      assert.equal(exclusiveTempOpened, true);
      assert.equal(renamed, true);
      assert.equal(finalReread, true);
      cleanupNativeGradientPreset(lease);
    } finally {
      (fsModule as any).openSync = originalOpenSync;
      (fsModule as any).renameSync = originalRenameSync;
      (fsModule as any).readFileSync = originalReadFileSync;
    }

    (fsModule as any).renameSync = () => {
      throw new Error("injected rename failure");
    };
    try {
      assert.throws(
        () =>
          createNativeGradientPreset({
            palette: [rgba(0), rgba(1)],
            kind: "fill",
            tempBasePath: base,
            templatePath: TOOLKIT_TEMPLATES.fill,
          }),
        assertFileError("publication-failed"),
      );
      assert.deepEqual(readdirSync(base), []);
    } finally {
      (fsModule as any).renameSync = originalRenameSync;
    }

    let corruptPublishedRead = false;
    (fsModule as any).readFileSync = (filePath: string, ...args: any[]) => {
      const bytes = (originalReadFileSync as any)(filePath, ...args);
      if (
        !corruptPublishedRead &&
        filePath.endsWith(".ffx") &&
        filePath.includes(realpathSync(base))
      ) {
        corruptPublishedRead = true;
        const corrupted = Buffer.from(bytes);
        corrupted[0] ^= 0xff;
        return corrupted;
      }
      return bytes;
    };
    try {
      assert.throws(
        () =>
          createNativeGradientPreset({
            palette: [rgba(0), rgba(1)],
            kind: "fill",
            tempBasePath: base,
            templatePath: TOOLKIT_TEMPLATES.fill,
          }),
        assertFileError("verification-failed"),
      );
      assert.deepEqual(readdirSync(base), []);
    } finally {
      (fsModule as any).readFileSync = originalReadFileSync;
    }
  });
});

test("B3 renderer generates both kind leases, makes one host call, and cleans all residue", async () => {
  await withTempBase(async (base) => {
    const hostRequests: unknown[] = [];
    const hostResult = validHostResult();
    const report = await applyActivePaletteNativeGradient(
      rendererOptions([rgba(0), rgba(1), rgba(2)], base),
      async (request: unknown) => {
        hostRequests.push(request);
        return hostResult;
      },
    );

    assert.equal(report.status, "ok");
    assert.equal(report.primaryStatus, "ok");
    assert.equal(report.hostCallAttempted, true);
    assert.equal(report.hostResult, hostResult);
    assert.equal(hostRequests.length, 1);
    const request = hostRequests[0] as any;
    assert.equal(request.schemaVersion, 1);
    assert.equal(request.expectedHostVersion, RENDERER_HOST_VERSION);
    assert.equal(request.stopCount, 3);
    assert.equal(request.includeDisabledTargets, false);
    assert.equal(request.smartApply, false);
    assert.deepEqual(Object.keys(request.presets).sort(), ["fill", "stroke"]);
    for (const kind of ["fill", "stroke"] as const) {
      assert.deepEqual(Object.keys(request.presets[kind]).sort(), [
        "byteLength",
        "filename",
        "presetPath",
        "rootPath",
        "runToken",
        "tempBasePath",
      ]);
      assert.match(request.presets[kind].runToken, /^[A-F0-9]{32}$/);
    }
    assert.notEqual(request.presets.fill.runToken, request.presets.stroke.runToken);
    assert.equal(report.generated.length, 2);
    assert.equal(report.cleanup.length, 2);
    assert.equal(report.cleanup.every((entry: any) => entry.removed === true), true);
    assert.deepEqual(report.errors, []);
    assert.deepEqual(readdirSync(base), []);
  });
});

test("B3 renderer emits a Windows host request and cleans both generated presets", async () => {
  await withTempBase(async (base) => {
    let requestPlatform: unknown = null;
    const report = await applyActivePaletteNativeGradient(
      { ...rendererOptions([rgba(0), rgba(1)], base), platform: "win32" },
      async (request) => {
        requestPlatform = request.platform;
        return validHostResult();
      },
    );

    assert.equal(requestPlatform, "win32");
    assert.equal(report.status, "ok");
    assert.equal(report.hostCallAttempted, true);
    assert.equal(report.generated.length, 2);
    assert.equal(report.cleanup.every((entry: any) => entry.removed === true), true);
    assert.deepEqual(readdirSync(base), []);
  });
});

test("B3 renderer rejects an unproven host before template reads or host mutation", async () => {
  await withTempBase(async (base) => {
    let hostCalls = 0;
    const report = await applyActivePaletteNativeGradient(
      {
        ...rendererOptions([rgba(0), rgba(1)], base),
        hostVersion: "27.0x1",
      },
      async () => {
        hostCalls += 1;
        return { status: "ok" };
      },
    );
    assert.equal(report.status, "host-rejected");
    assert.equal(report.primaryStatus, "host-rejected");
    assert.equal(report.hostCallAttempted, false);
    assert.equal((report.hostResult as any).status, "unsupported-host-version");
    assert.equal(hostCalls, 0);
    assert.deepEqual(report.generated, []);
    assert.deepEqual(report.cleanup, []);
    assert.deepEqual(readdirSync(base), []);
  });
});

test("B3 renderer distinguishes apply success from host finalization failure", async () => {
  await withTempBase(async (base) => {
    const report = await applyActivePaletteNativeGradient(
      rendererOptions([rgba(0), rgba(1)], base),
      async () =>
        validHostResult({
          status: "selection-restore-failed",
          primaryStatus: "ok",
          selectionRestored: false,
          selectionDiagnostics: failedSelectionDiagnostics(),
        }),
    );
    assert.equal(report.status, "host-finalization-failed");
    assert.equal(report.primaryStatus, "ok");
    assert.equal(report.cleanup.every((entry: any) => entry.removed === true), true);
    assert.equal(
      nativeGradientResultMessage(report, 2),
      "Applied 2-color native gradient; After Effects selection restoration also failed",
    );
    assert.deepEqual(readdirSync(base), []);
  });
});

test("selection diagnostics are structurally bounded and validated at the wire boundary", () => {
  const validDiagnostics = {
    schemaVersion: 1,
    inGroup: {
      stage: "verify",
      error: {
        name: "Error",
        message: "Selection restoration was not exact",
        line: null,
        number: null,
      },
      expected: [
        {
          layerId: 2,
          layerIndex: 1,
          selected: true,
          properties: [
            {
              propertyIndexPath: validTarget.propertyIndexPath,
              matchNamePath: validTarget.matchNamePath,
            },
          ],
        },
      ],
      expectedTruncated: false,
      actual: [
        {
          layerId: 2,
          layerIndex: 1,
          selected: true,
          properties: [],
        },
      ],
      actualTruncated: false,
      exact: false,
      acceptedNormalization: false,
      layers: [
        {
          layerId: 2,
          layerIndex: 1,
          selected: true,
          resolved: true,
          selectedAfterSet: true,
          properties: [
            {
              propertyIndexPath: validTarget.propertyIndexPath,
              matchNamePath: validTarget.matchNamePath,
              resolved: true,
              selectedAfterSet: false,
            },
          ],
        },
      ],
      layersTruncated: false,
    },
    afterUndoGroup: {
      actual: [
        {
          layerId: 2,
          layerIndex: 1,
          selected: true,
          properties: [],
        },
      ],
      actualTruncated: false,
      exact: false,
      acceptedNormalization: false,
    },
  };
  assert.equal(
    decodeNativeGradientApplyResult(
      validHostResult({
        status: "selection-restore-failed",
        primaryStatus: "ok",
        selectionRestored: false,
        selectionDiagnostics: validDiagnostics,
      }),
    )?.status,
    "selection-restore-failed",
  );
  assert.equal(
    decodeNativeGradientApplyResult(
      validHostResult({
        status: "selection-restore-failed",
        primaryStatus: "ok",
        selectionRestored: false,
        selectionDiagnostics: {
          ...validDiagnostics,
          schemaVersion: 999,
        },
      }),
    ),
    null,
  );
  assert.equal(
    decodeNativeGradientApplyResult(
      validHostResult({
        status: "selection-restore-failed",
        primaryStatus: "ok",
        selectionRestored: false,
        selectionDiagnostics: {
          ...validDiagnostics,
          inGroup: {
            ...validDiagnostics.inGroup,
            error: {
              name: "Error",
              message: "x".repeat(MAX_NATIVE_GRADIENT_DIAGNOSTIC_LENGTH + 1),
              line: null,
              number: null,
            },
          },
        },
      }),
    ),
    null,
  );
  assert.equal(
    decodeNativeGradientApplyResult(
      validHostResult({
        status: "ok",
        selectionDiagnostics: validDiagnostics,
      }),
    ),
    null,
  );
});

test("B3 resolves the live macOS Folder.temp base without adding a Windows subdirectory", () => {
  assert.equal(
    getNativeGradientTempBasePath("darwin", "/private/var/folders/example/T"),
    "/private/var/folders/example/T/TemporaryItems",
  );
  assert.equal(getNativeGradientTempBasePath("win32", "C:\\Temp"), "C:\\Temp");
});

test("S2 runtime gate is atomic and explicit for platform plus AE version", () => {
  const cases = [
    ["darwin", "22.0.0", true, "ae22-6"],
    ["darwin", "22.6.5x2", true, "ae22-6"],
    ["darwin", "23.6.6x2", true, "ae22-6"],
    ["darwin", "24.0.0", true, "ae22-6"],
    ["darwin", "24.6.5x2", true, "ae22-6"],
    ["darwin", "25.5.0", true, "ae22-6"],
    ["darwin", "25.6.6", true, "ae25-6"],
    ["darwin", "25.6.6x4", true, "ae25-6"],
    ["darwin", "26.0.0", true, "ae25-6"],
    ["darwin", "26.2.9x12", true, "ae25-6"],
    ["darwin", "26.3.0", true, "ae26-3"],
    ["darwin", "26.3x87", true, "ae26-3"],
    ["win32", "22.6.5x2", true, "ae22-6"],
    ["win32", "24.6.4x3", true, "ae22-6"],
    ["win32", "25.6.6", true, "ae25-6"],
    ["win32", "26.3x87", true, "ae26-3"],
    ["linux", "25.6.6", false, "unsupported-platform"],
    ["", "25.6.6", false, "unsupported-platform"],
    ["darwin", "21.6.0", false, "unsupported-host-version"],
    ["darwin", "27.0.0", false, "unsupported-host-version"],
    ["darwin", "unknown", false, "unsupported-host-version"],
  ] as const;
  for (const [platform, hostVersion, supported, expected] of cases) {
    const decision = resolveNativeGradientRuntime(platform, hostVersion);
    assert.equal(decision.supported, supported, `${platform}/${hostVersion}`);
    assert.equal(decision.supported ? decision.templateFamily : decision.reason, expected);
  }
});

test("S2 optimistic application routing covers every AE 22-26 minor", () => {
  for (const platform of ["darwin", "win32"] as const) {
    for (let major = 22; major <= 26; major += 1) {
      for (let minor = 0; minor <= 99; minor += 1) {
        const hostVersion = `${major}.${minor}.9x123`;
        const expectedFamily =
          major === 26 && minor >= 3
            ? "ae26-3"
            : major === 26 || (major === 25 && minor >= 6)
              ? "ae25-6"
              : "ae22-6";
        const decision = resolveNativeGradientRuntime(platform, hostVersion);
        assert.equal(decision.supported, true, `${platform}/${hostVersion}`);
        assert.equal(
          decision.supported ? decision.templateFamily : null,
          expectedFamily,
          `${platform}/${hostVersion}`,
        );
      }
    }
  }
});

test("S2 collection runtime optimistically covers every AE 22-26 minor", () => {
  const cases = [
    ["darwin", "22.0.0", true, null],
    ["darwin", "24.6.5x2", true, null],
    ["darwin", "25.5.0", true, null],
    ["darwin", "25.6.6", true, null],
    ["darwin", "26.2", true, null],
    ["darwin", "26.3", true, null],
    ["darwin", "26.3x87", true, null],
    ["darwin", "26.4", true, null],
    ["win32", "22.0", true, null],
    ["win32", "24.6.4x3", true, null],
    ["win32", "25.6.6", true, null],
    ["win32", "26.3x87", true, null],
    ["darwin", "", false, "unsupported-host-version"],
    ["darwin", "26.3beta", false, "unsupported-host-version"],
    ["darwin", "unknown", false, "unsupported-host-version"],
    ["darwin", "21.99", false, "unsupported-host-version"],
    ["darwin", "27.0", false, "unsupported-host-version"],
    ["darwin", undefined, false, "unsupported-host-version"],
    ["darwin", 26.3, false, "unsupported-host-version"],
    ["linux", "26.3", false, "unsupported-platform"],
    [null, "26.3", false, "unsupported-platform"],
  ] as const;
  for (const [platform, hostVersion, supported, reason] of cases) {
    const decision = resolveNativeGradientCollectionRuntime(platform, hostVersion);
    assert.equal(decision.supported, supported, `${platform}/${hostVersion}`);
    assert.equal(decision.supported ? null : decision.reason, reason);
  }
  for (const platform of ["darwin", "win32"] as const) {
    for (let major = 22; major <= 26; major += 1) {
      for (let minor = 0; minor <= 99; minor += 1) {
        const hostVersion = `${major}.${minor}.9x123`;
        assert.equal(
          resolveNativeGradientCollectionRuntime(platform, hostVersion).supported,
          true,
          `${platform}/${hostVersion}`,
        );
      }
    }
  }
  assert.equal(resolveNativeGradientRuntime("darwin", "26.3x87").supported, true);
  const mainSource = readFileSync(join(REPO_ROOT, "src/js/main/main.tsx"), "utf8");
  assert.match(mainSource, /const nativeRuntime = resolveNativeGradientCollectionRuntime\(/);
  assert.doesNotMatch(mainSource, /const nativeRuntime = resolveNativeGradientRuntime\(/);
});

test("S2 unsupported platform performs no native template read, lease, host call, or residue", async () => {
  await withTempBase(async (base) => {
    let hostCalls = 0;
    let templateReads = 0;
    const originalReadFileSync = nodeRequire("fs").readFileSync;
    const fsModule = nodeRequire("fs");
    fsModule.readFileSync = (...args: any[]) => {
      if (String(args[0]).includes("native-gradient")) templateReads += 1;
      return originalReadFileSync(...args);
    };
    try {
      const report = await applyActivePaletteNativeGradient(
        { ...rendererOptions([rgba(0), rgba(1)], base), platform: "linux" },
        async () => {
          hostCalls += 1;
          return validHostResult();
        },
      );
      assert.equal(report.hostCallAttempted, false);
      assert.equal(hostCalls, 0);
      assert.equal(templateReads, 0);
      assert.equal(report.generated.length, 0);
      assert.deepEqual(report.cleanup, []);
      assert.deepEqual(readdirSync(base), []);
      assert.equal((report.hostResult as any).status, "unsupported-platform");
    } finally {
      fsModule.readFileSync = originalReadFileSync;
    }
  });
});

test("S2 collection seam permits optimistic AE 22-26 parsing without template or lease access", () => {
  const exercise = async (platform: string, hostVersion: string, nativeEntryCount: number) => {
    const operations = { parser: 0, templates: 0, leases: 0, paletteWriter: 0 };
    const runtime = resolveNativeGradientCollectionRuntime(platform, hostVersion);
    const result = await orchestrateNativeGradientCollection({
      nativeSelectionStatus: nativeEntryCount === 0 ? "none" : "ok",
      nativeEntryCount,
      runtime,
      entries:
        nativeEntryCount === 0
          ? [{ type: "solid", colorIndex: 0 }]
          : [{ type: "native-gradient", gradientIndex: 0 }],
      colors: [[0, 0, 0, 1]],
      descriptors: [],
      baseDocument: { revision: 0 },
    }, {
      nativeParser: () => {
        operations.parser += 1;
        return [{ id: "gradient" }];
      },
      nativeTemplateReader: () => {
        operations.templates += 1;
      },
      nativeLeaseCreator: () => {
        operations.leases += 1;
      },
      solidItem: (rgba) => ({ type: "solid", rgba }),
      gradientItems: (gradient) => [{ type: "gradient", gradient }],
      buildDocument: (items) => ({ revision: items.length }),
      writePalette: () => {
        operations.paletteWriter += 1;
      },
    });
    return { operations, result };
  };
  return Promise.all([
    exercise("linux", RENDERER_HOST_VERSION, 2),
    exercise("darwin", "27.0.0", 2),
    exercise("darwin", "24.6.5x2", 2),
    exercise("win32", "24.6.4x3", 2),
    exercise("win32", "26.3.0", 0),
  ]).then(([
    unsupportedPlatform,
    unsupportedVersion,
    supportedDarwinCollection,
    supportedWindowsCollection,
    solidOnly,
  ]) => {
    assert.deepEqual(unsupportedPlatform.operations, {
    parser: 0,
    templates: 0,
    leases: 0,
    paletteWriter: 0,
    });
    assert.equal(unsupportedPlatform.result.allowed, false);
    assert.deepEqual(unsupportedVersion.operations, {
    parser: 0,
    templates: 0,
    leases: 0,
    paletteWriter: 0,
    });
    assert.equal(unsupportedVersion.result.allowed, false);
    for (const supportedCollection of [supportedDarwinCollection, supportedWindowsCollection]) {
      assert.deepEqual(supportedCollection.operations, {
        parser: 1,
        templates: 0,
        leases: 0,
        paletteWriter: 1,
      });
      assert.equal(supportedCollection.result.allowed, true);
    }
    assert.deepEqual(solidOnly.operations, {
    parser: 0,
    templates: 0,
    leases: 0,
    paletteWriter: 1,
    });
    assert.equal(solidOnly.result.allowed, true);
  });
});

test("S2 collection seam materializes implicit defaults without saved-AEP parsing", async () => {
  const operations = { parser: 0, implicit: 0, paletteWriter: 0 };
  const result = await orchestrateNativeGradientCollection({
    nativeSelectionStatus: "none",
    nativeEntryCount: 0,
    runtime: resolveNativeGradientCollectionRuntime("darwin", "26.3.0"),
    entries: [{ type: "implicit-gradient" }],
    colors: [],
    descriptors: [],
    baseDocument: { revision: 0 },
  }, {
    nativeParser: () => {
      operations.parser += 1;
      return [];
    },
    implicitGradient: () => {
      operations.implicit += 1;
      return { id: "implicit-default" };
    },
    solidItem: (rgba) => ({ type: "solid", rgba }),
    gradientItems: (gradient) => [{ type: "gradient", gradient }],
    buildDocument: (items) => ({ revision: items.length }),
    writePalette: () => {
      operations.paletteWriter += 1;
    },
  });

  assert.deepEqual(operations, { parser: 0, implicit: 1, paletteWriter: 1 });
  assert.equal(result.allowed, true);
  assert.equal(result.parseNativeGradients, false);
  assert.deepEqual(result.sourceItems, [
    { type: "gradient", gradient: { id: "implicit-default" } },
  ]);
});

test("S2 collection seam rejects implicit defaults outside the supported runtime before materialization", async () => {
  for (const [platform, version, reason] of [
    ["darwin", "27.0.0", "unsupported-host-version"],
    ["linux", "26.3.0", "unsupported-platform"],
  ] as const) {
    const operations = { parser: 0, implicit: 0, paletteWriter: 0 };
    const result = await orchestrateNativeGradientCollection({
      nativeSelectionStatus: "none",
      nativeEntryCount: 0,
      runtime: resolveNativeGradientCollectionRuntime(platform, version),
      entries: [{ type: "implicit-gradient" }],
      colors: [],
      descriptors: [],
      baseDocument: { revision: 0 },
    }, {
      nativeParser: () => {
        operations.parser += 1;
        return [];
      },
      implicitGradient: () => {
        operations.implicit += 1;
        return { id: "implicit-default" };
      },
      solidItem: (rgba): { type: string; rgba?: unknown; gradient?: unknown } => ({
        type: "solid",
        rgba,
      }),
      gradientItems: (gradient) => [{ type: "gradient", gradient }],
      buildDocument: (items) => ({ revision: items.length }),
      writePalette: () => {
        operations.paletteWriter += 1;
      },
    });

    assert.deepEqual(operations, { parser: 0, implicit: 0, paletteWriter: 0 });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, reason);
  }
});

test("S2 decoder rejects status evidence contradictions before renderer cleanup", async () => {
  const secondTarget = { ...validTarget, layerId: 3, layerIndex: 2 };
  const thirdTarget = { ...validTarget, layerId: 4, layerIndex: 3 };
  const oneSidedCountAlias = validHostResult();
  delete (oneSidedCountAlias as any).selectedPropertyCount;
  const oneSidedIndexAlias = validHostResult();
  delete (oneSidedIndexAlias as any).failedPropertyIndex;
  const malformed: Array<[string, unknown]> = [
    [
      "early rejection carries selection evidence",
      validHostResult({ status: "no-project", primaryStatus: "no-project" }),
    ],
    [
      "success has zero targets",
      validHostResult({
        target: null,
        targets: [],
        selectedTargetCount: 0,
        selectedPropertyCount: 0,
        attemptedTargetCount: 0,
        attemptedPropertyCount: 0,
        appliedTargetCount: 0,
        appliedPropertyCount: 0,
        mutationAttempted: false,
        applyCompleted: false,
        undoGroupOpened: false,
        undoGroupCloseAttempted: false,
        undoGroupClosed: false,
        selectionRestoreAttempted: false,
        selectionRestored: false,
      }),
    ],
    ["one-sided count alias", oneSidedCountAlias],
    ["one-sided index alias", oneSidedIndexAlias],
    [
      "non-adjacent duplicate target",
      validHostResult({
        target: validTarget,
        targets: [validTarget, secondTarget, thirdTarget, validTarget],
        selectedTargetCount: 4,
        selectedPropertyCount: 4,
        attemptedTargetCount: 4,
        attemptedPropertyCount: 4,
        appliedTargetCount: 4,
        appliedPropertyCount: 4,
      }),
    ],
    [
      "post-selection state lacks positive selection",
      validHostResult({
        status: "selection-mutation-failed",
        primaryStatus: "selection-mutation-failed",
        target: null,
        targets: [],
        selectedTargetCount: 0,
        selectedPropertyCount: 0,
        attemptedTargetCount: 0,
        attemptedPropertyCount: 0,
        appliedTargetCount: 0,
        appliedPropertyCount: 0,
        mutationAttempted: false,
        applyCompleted: false,
        failedTargetIndex: 0,
        failedPropertyIndex: 0,
      }),
    ],
  ];
  for (const [label, value] of malformed) {
    assert.equal(decodeNativeGradientApplyResult(value), null, label);
    await withTempBase(async (base) => {
      let hostCalls = 0;
      const report = await applyActivePaletteNativeGradient(
        rendererOptions([rgba(0), rgba(1)], base),
        async () => {
          hostCalls += 1;
          return value;
        },
      );
      assert.equal(hostCalls, 1, label);
      assert.equal(report.primaryStatus, "host-unknown-completion", label);
      assert.equal(report.cleanup.length, 2, label);
      assert.equal(report.cleanup.every((entry: any) => entry.preserved === true), true, label);
    });
  }
});

test("AEFT22 host source has no Array.prototype.every dependency", () => {
  const source = readFileSync(join(REPO_ROOT, "src/jsx/aeft/native-gradient-apply.ts"), "utf8");
  assert.doesNotMatch(source, /\.every\s*\(/);
});

test("pre-Undo host target drift keeps failure index aliases synchronized for deterministic decoding", () => {
  const source = readFileSync(join(REPO_ROOT, "src/jsx/aeft/native-gradient-apply.ts"), "utf8");
  assert.match(
    source,
    /if \(!target\) \{\s*result\.failedTargetIndex = index;\s*result\.failedPropertyIndex = index;\s*return failBeforeMutation\(result, "target-drift"\);\s*\}/,
  );
  assert.equal(
    decodeNativeGradientApplyResult(
      validHostResult({
        status: "target-drift",
        primaryStatus: "target-drift",
        attemptedTargetCount: 0,
        attemptedPropertyCount: 0,
        appliedTargetCount: 0,
        appliedPropertyCount: 0,
        failedTargetIndex: 0,
        failedPropertyIndex: 0,
        mutationAttempted: false,
        applyCompleted: false,
        undoGroupOpened: false,
        undoGroupCloseAttempted: false,
        undoGroupClosed: false,
        selectionRestoreAttempted: false,
        selectionRestored: false,
      }),
      RENDERER_HOST_VERSION,
    )?.primaryStatus,
    "target-drift",
  );
});

test("S2 fulfilled post-call uncertainty is table-driven, preserved, and never retried", async () => {
  const cases: Array<[string, unknown]> = [
    ["null", null],
    ["empty", {}],
    ["truncated success", { schemaVersion: 1, status: "ok" }],
    ["unknown future status", validHostResult({ status: "future-status" })],
    [
      "contradictory status",
      validUnknownHostResult({ status: "ok", primaryStatus: "apply-unknown-completion" }),
    ],
    ["impossible count", validHostResult({ appliedTargetCount: 2, appliedPropertyCount: 2 })],
    ["impossible index", validUnknownHostResult({ unknownCompletionTargetIndex: 9, unknownCompletionPropertyIndex: 9 })],
    ["invalid finalization flags", validHostResult({ selectionRestored: true, selectionRestoreAttempted: false })],
  ];
  for (const [label, hostResult] of cases) {
    await withTempBase(async (base) => {
      let hostCalls = 0;
      const report = await applyActivePaletteNativeGradient(
        rendererOptions([rgba(0), rgba(1)], base),
        async () => {
          hostCalls += 1;
          return hostResult;
        },
      );
      assert.equal(report.hostCallAttempted, true, label);
      assert.equal(hostCalls, 1, label);
      assert.equal(report.primaryStatus, "host-unknown-completion", label);
      assert.equal(report.status, "host-unknown-completion", label);
      assert.equal(report.cleanup.length, 2, label);
      assert.equal(report.cleanup.every((entry: any) => entry.preserved === true), true, label);
      assert.equal(report.cleanup.every((entry: any) => entry.error === null), true, label);
      assert.equal(readdirSync(base).length, 2, label);
    });
  }
});

test("S2 decoder requires schemaVersion 1 and rejects contradictory wire results", () => {
  const invalidCases = [
    ["missing schema", { ...validHostResult(), schemaVersion: undefined }],
    ["future schema", { ...validHostResult(), schemaVersion: 2 }],
    ["unknown status", validHostResult({ status: "future-status" })],
    ["count exceeds selected", validHostResult({ attemptedTargetCount: 2, attemptedPropertyCount: 2 })],
    ["target index out of range", validUnknownHostResult({ unknownCompletionTargetIndex: 2, unknownCompletionPropertyIndex: 2 })],
    ["apply completed with unknown index", validHostResult({ unknownCompletionTargetIndex: 0, unknownCompletionPropertyIndex: 0 })],
    ["restored without attempt", validHostResult({ selectionRestoreAttempted: false, selectionRestored: true })],
  ] as const;
  for (const [label, value] of invalidCases) {
    assert.equal(decodeNativeGradientApplyResult(value), null, label);
  }
  assert.deepEqual(decodeNativeGradientApplyResult(validHostResult())?.status, "ok");
});

test("S2 correction matrix accepts post-Undo drift and rejects malformed near-neighbors", () => {
  const secondTarget = { ...validTarget, layerId: 3, layerIndex: 2 };
  const postUndoDrift = validHostResult({
    status: "target-drift",
    primaryStatus: "target-drift",
    target: validTarget,
    targets: [validTarget, secondTarget],
    selectedTargetCount: 2,
    selectedPropertyCount: 2,
    attemptedTargetCount: 1,
    attemptedPropertyCount: 1,
    appliedTargetCount: 1,
    appliedPropertyCount: 1,
    failedTargetIndex: 1,
    failedPropertyIndex: 1,
    mutationAttempted: true,
    applyCompleted: false,
  });
  assert.equal(decodeNativeGradientApplyResult(postUndoDrift)?.status, "target-drift");

  const finalizationStates = [
    [
      "selection-restore-failed",
      { selectionRestored: false, selectionDiagnostics: failedSelectionDiagnostics() },
    ],
    ["undo-close-failed", { undoGroupClosed: false }],
    [
      "finalization-failed",
      {
        selectionRestored: false,
        undoGroupClosed: false,
        selectionDiagnostics: failedSelectionDiagnostics(),
      },
    ],
  ] as const;
  for (const [status, overrides] of finalizationStates) {
    assert.equal(
      decodeNativeGradientApplyResult(
        validHostResult({ status, primaryStatus: "ok", ...overrides }),
      )?.status,
      status,
    );
  }

  const malformed = [
    ["failed index after all targets applied", validHostResult({ failedTargetIndex: 0, failedPropertyIndex: 0 })],
    [
      "descriptor path lengths differ",
      validHostResult({
        target: { ...validTarget, matchNamePath: ["only-one"] },
        targets: [{ ...validTarget, matchNamePath: ["only-one"] }],
      }),
    ],
    [
      "error number is not finite",
      validUnknownHostResult({ applyError: { name: "Error", message: "x", line: "1", number: null } }),
    ],
    ["missing error object", validUnknownHostResult({ applyError: undefined })],
    [
      "success claims no mutation",
      validHostResult({ mutationAttempted: false }),
    ],
  ] as const;
  for (const [label, value] of malformed) {
    assert.equal(decodeNativeGradientApplyResult(value), null, label);
  }
});

test("S2 final review rejects impossible descriptor grammar and collection identity", async () => {
  const secondTarget = { ...validTarget, layerId: 3, layerIndex: 2 };
  const malformedResults: Array<[string, unknown]> = [
    [
      "fill kind with stroke terminal",
      validHostResult({
        target: { ...validTarget, matchNamePath: ["ADBE Root Vectors Group", "ADBE Vector Graphic - G-Stroke"] },
        targets: [{ ...validTarget, matchNamePath: ["ADBE Root Vectors Group", "ADBE Vector Graphic - G-Stroke"] }],
      }),
    ],
    [
      "wrong payload terminal",
      validHostResult({
        target: { ...validTarget, matchNamePath: ["ADBE Root Vectors Group", "ADBE Vector Graphic - G-Fill", "ADBE Vector Fill Color"] },
        targets: [{ ...validTarget, matchNamePath: ["ADBE Root Vectors Group", "ADBE Vector Graphic - G-Fill", "ADBE Vector Fill Color"] }],
      }),
    ],
    [
      "cross-comp target",
      validHostResult({
        target: validTarget,
        targets: [validTarget, { ...secondTarget, compId: 2 }],
        selectedTargetCount: 2,
        selectedPropertyCount: 2,
        attemptedTargetCount: 2,
        attemptedPropertyCount: 2,
        appliedTargetCount: 2,
        appliedPropertyCount: 2,
      }),
    ],
    [
      "same layer id with different index",
      validHostResult({
        target: validTarget,
        targets: [validTarget, { ...secondTarget, layerId: validTarget.layerId }],
        selectedTargetCount: 2,
        selectedPropertyCount: 2,
        attemptedTargetCount: 2,
        attemptedPropertyCount: 2,
        appliedTargetCount: 2,
        appliedPropertyCount: 2,
      }),
    ],
    [
      "same layer index with different id",
      validHostResult({
        target: validTarget,
        targets: [validTarget, { ...secondTarget, layerIndex: validTarget.layerIndex }],
        selectedTargetCount: 2,
        selectedPropertyCount: 2,
        attemptedTargetCount: 2,
        attemptedPropertyCount: 2,
        appliedTargetCount: 2,
        appliedPropertyCount: 2,
      }),
    ],
  ];
  for (const [label, value] of malformedResults) {
    assert.equal(decodeNativeGradientApplyResult(value), null, label);
    await withTempBase(async (base) => {
      let hostCalls = 0;
      const report = await applyActivePaletteNativeGradient(
        rendererOptions([rgba(0), rgba(1)], base),
        async () => {
          hostCalls += 1;
          return value;
        },
      );
      assert.equal(hostCalls, 1, label);
      assert.equal(report.primaryStatus, "host-unknown-completion", label);
      assert.equal(report.cleanup.length, 2, label);
      assert.equal(report.cleanup.every((entry: any) => entry.preserved === true), true, label);
    });
  }
});

test("S2 final review binds decoded host versions and status semantics to the request", () => {
  assert.equal(
    decodeNativeGradientApplyResult(validHostResult({ hostVersion: "25.6.6x4" }), "25.6.6")?.status,
    "ok",
  );
  assert.equal(
    decodeNativeGradientApplyResult(validHostResult({ hostVersion: "25.6.6" }), "25.6.6x4")?.status,
    "ok",
  );
  const unsupported = validHostResult({
    status: "unsupported-host-version",
    primaryStatus: "unsupported-host-version",
    hostVersion: "27.0.0",
    target: null,
    targets: [],
    selectedTargetCount: 0,
    selectedPropertyCount: 0,
    attemptedTargetCount: 0,
    attemptedPropertyCount: 0,
    appliedTargetCount: 0,
    appliedPropertyCount: 0,
    mutationAttempted: false,
    applyCompleted: false,
    undoGroupOpened: false,
    undoGroupCloseAttempted: false,
    undoGroupClosed: false,
    selectionRestoreAttempted: false,
    selectionRestored: false,
  });
  assert.equal(decodeNativeGradientApplyResult(unsupported, "27.0.0")?.status, "unsupported-host-version");

  const malformed: Array<[string, unknown, string]> = [
    ["mismatched version", validHostResult({ hostVersion: "26.3.0" }), "25.6.6"],
    ["empty version", validHostResult({ hostVersion: "" }), "25.6.6"],
    ["malformed version", validHostResult({ hostVersion: "25.6" }), "25.6.6"],
    ["supported version claims unsupported", validHostResult({
      status: "unsupported-host-version",
      primaryStatus: "unsupported-host-version",
      target: null,
      targets: [],
      selectedTargetCount: 0,
      selectedPropertyCount: 0,
      attemptedTargetCount: 0,
      attemptedPropertyCount: 0,
      appliedTargetCount: 0,
      appliedPropertyCount: 0,
      mutationAttempted: false,
      applyCompleted: false,
      undoGroupOpened: false,
      undoGroupCloseAttempted: false,
      undoGroupClosed: false,
      selectionRestoreAttempted: false,
      selectionRestored: false,
    }), "25.6.6"],
    ["version drift status", validHostResult({
      status: "host-version-drift",
      primaryStatus: "host-version-drift",
      target: null,
      targets: [],
      selectedTargetCount: 0,
      selectedPropertyCount: 0,
      attemptedTargetCount: 0,
      attemptedPropertyCount: 0,
      appliedTargetCount: 0,
      appliedPropertyCount: 0,
      mutationAttempted: false,
      applyCompleted: false,
      undoGroupOpened: false,
      undoGroupCloseAttempted: false,
      undoGroupClosed: false,
      selectionRestoreAttempted: false,
      selectionRestored: false,
    }), "25.6.6"],
  ];
  for (const [label, value, expectedVersion] of malformed) {
    assert.equal(decodeNativeGradientApplyResult(value, expectedVersion), null, label);
  }
});

test("S2 final review round-trips legitimate disabled-only and preserved-only zero-target host outcomes", async () => {
  const zeroTarget = (status: string, skippedDisabledCount: number, preservedStateCount: number) =>
    validHostResult({
      status,
      primaryStatus: status,
      target: null,
      targets: [],
      selectedTargetCount: 0,
      selectedPropertyCount: 0,
      attemptedTargetCount: 0,
      attemptedPropertyCount: 0,
      appliedTargetCount: 0,
      appliedPropertyCount: 0,
      skippedDisabledCount,
      skippedDisabledBranchCount: skippedDisabledCount,
      preservedStateCount,
      preservedPropertyCount: preservedStateCount,
      mutationAttempted: false,
      applyCompleted: false,
      undoGroupOpened: false,
      undoGroupCloseAttempted: false,
      undoGroupClosed: false,
      selectionRestoreAttempted: false,
      selectionRestored: false,
    });
  const fixtures = [
    ["disabled-only", zeroTarget("no-selected-gradient", 1, 0)],
    ["preserved-only", zeroTarget("unsupported-selected-gradient", 0, 1)],
  ] as const;
  for (const [label, hostResult] of fixtures) {
    assert.equal(decodeNativeGradientApplyResult(hostResult, RENDERER_HOST_VERSION)?.status, hostResult.status, label);
    await withTempBase(async (base) => {
      const report = await applyActivePaletteNativeGradient(
        rendererOptions([rgba(0), rgba(1)], base),
        async () => hostResult,
      );
      assert.equal(report.primaryStatus, "host-rejected", label);
      assert.equal(report.status, "host-rejected", label);
      assert.equal(report.cleanup.every((entry: any) => entry.removed === true), true, label);
      assert.deepEqual(readdirSync(base), [], label);
    });
  }

  const malformed = [
    zeroTarget("no-selected-gradient", 1, 1),
    { ...zeroTarget("no-selected-gradient", 1, 0), mutationAttempted: true },
    zeroTarget("unsupported-selected-gradient", 1, 0),
  ];
  for (const value of malformed) {
    assert.equal(decodeNativeGradientApplyResult(value, RENDERER_HOST_VERSION), null);
  }
});

test("S2 correction decoder rejects over-limit wire targets, paths, names, and diagnostics", () => {
  const tooManyTargets = Array.from({ length: 65 }, (_, index) => ({
    ...validTarget,
    layerId: index + 2,
    layerIndex: index + 1,
  }));
  assert.equal(
    decodeNativeGradientApplyResult(
      validHostResult({
        target: tooManyTargets[0],
        targets: tooManyTargets,
        selectedTargetCount: tooManyTargets.length,
        selectedPropertyCount: tooManyTargets.length,
        attemptedTargetCount: 0,
        attemptedPropertyCount: 0,
        appliedTargetCount: 0,
        appliedPropertyCount: 0,
        mutationAttempted: false,
        applyCompleted: false,
      }),
    ),
    null,
  );
  const tooDeep = Array.from({ length: 65 }, () => 1);
  const tooLongName = "x".repeat(257);
  assert.equal(
    decodeNativeGradientApplyResult(
      validHostResult({
        target: { ...validTarget, propertyIndexPath: tooDeep, matchNamePath: tooDeep.map(() => "x") },
        targets: [{ ...validTarget, propertyIndexPath: tooDeep, matchNamePath: tooDeep.map(() => "x") }],
      }),
    ),
    null,
  );
  assert.equal(
    decodeNativeGradientApplyResult(
      validHostResult({
        target: { ...validTarget, matchNamePath: ["x", tooLongName] },
        targets: [{ ...validTarget, matchNamePath: ["x", tooLongName] }],
      }),
    ),
    null,
  );
  assert.equal(
    decodeNativeGradientApplyResult(
      validUnknownHostResult({
        applyError: { name: "E", message: "x".repeat(513), line: null, number: null },
      }),
    ),
    null,
  );
});

test("S2 decoder table covers every current host primary outcome and finalization truth table", () => {
  const preStatuses = [
    "unsupported-platform",
    "invalid-request",
    "invalid-preset",
    "no-project",
    "no-active-comp",
    "no-selected-gradient",
    "ambiguous-selected-gradient",
    "unsupported-selected-gradient",
  ] as const;
  for (const status of preStatuses) {
    assert.equal(
      decodeNativeGradientApplyResult(
        validHostResult({
          status,
          primaryStatus: status,
          target: null,
          targets: [],
          selectedTargetCount: 0,
          selectedPropertyCount: 0,
          attemptedTargetCount: 0,
          attemptedPropertyCount: 0,
          appliedTargetCount: 0,
          appliedPropertyCount: 0,
          mutationAttempted: false,
          applyCompleted: false,
          undoGroupOpened: false,
          undoGroupCloseAttempted: false,
          undoGroupClosed: false,
          selectionRestoreAttempted: false,
          selectionRestored: false,
        }),
      )?.primaryStatus,
      status,
    );
  }
  const unsupportedVersionResult = validHostResult({
    status: "unsupported-host-version",
    primaryStatus: "unsupported-host-version",
    hostVersion: "27.0.0",
    target: null,
    targets: [],
    selectedTargetCount: 0,
    selectedPropertyCount: 0,
    attemptedTargetCount: 0,
    attemptedPropertyCount: 0,
    appliedTargetCount: 0,
    appliedPropertyCount: 0,
    mutationAttempted: false,
    applyCompleted: false,
    undoGroupOpened: false,
    undoGroupCloseAttempted: false,
    undoGroupClosed: false,
    selectionRestoreAttempted: false,
    selectionRestored: false,
  });
  assert.equal(
    decodeNativeGradientApplyResult(unsupportedVersionResult, "27.0.0")?.primaryStatus,
    "unsupported-host-version",
  );
  for (const status of ["target-drift", "undo-open-failed"] as const) {
    assert.equal(
      decodeNativeGradientApplyResult(
        validHostResult({
          status,
          primaryStatus: status,
          attemptedTargetCount: 0,
          attemptedPropertyCount: 0,
          appliedTargetCount: 0,
          appliedPropertyCount: 0,
          mutationAttempted: false,
          applyCompleted: false,
          undoGroupOpened: false,
          undoGroupCloseAttempted: false,
          undoGroupClosed: false,
          selectionRestoreAttempted: false,
          selectionRestored: false,
          ...(status === "target-drift"
            ? { failedTargetIndex: 0, failedPropertyIndex: 0 }
            : { failedTargetIndex: null, failedPropertyIndex: null }),
        }),
      )?.primaryStatus,
      status,
    );
  }
  assert.equal(
    decodeNativeGradientApplyResult(
      validHostResult({
        status: "selection-snapshot-failed",
        primaryStatus: "selection-snapshot-failed",
        target: null,
        targets: [],
        selectedTargetCount: 0,
        selectedPropertyCount: 0,
        attemptedTargetCount: 0,
        attemptedPropertyCount: 0,
        appliedTargetCount: 0,
        appliedPropertyCount: 0,
        mutationAttempted: false,
        applyCompleted: false,
        undoGroupOpened: false,
        undoGroupCloseAttempted: false,
        undoGroupClosed: false,
        selectionRestoreAttempted: false,
        selectionRestored: false,
      }),
    )?.primaryStatus,
    "selection-snapshot-failed",
  );
  const secondTarget = { ...validTarget, layerId: 3, layerIndex: 2 };
  for (const status of ["target-drift", "selection-mutation-failed"] as const) {
    assert.equal(
      decodeNativeGradientApplyResult(
        validHostResult({
          status,
          primaryStatus: status,
          target: validTarget,
          targets: [validTarget, secondTarget],
          selectedTargetCount: 2,
          selectedPropertyCount: 2,
          attemptedTargetCount: 1,
          attemptedPropertyCount: 1,
          appliedTargetCount: 1,
          appliedPropertyCount: 1,
          failedTargetIndex: 1,
          failedPropertyIndex: 1,
          mutationAttempted: true,
          applyCompleted: false,
        }),
      )?.primaryStatus,
      status,
    );
  }
  assert.equal(decodeNativeGradientApplyResult(validUnknownHostResult())?.primaryStatus, "apply-unknown-completion");
  assert.equal(decodeNativeGradientApplyResult(validHostResult())?.primaryStatus, "ok");
  assert.equal(
    boundNativeGradientDiagnostics(Array.from({ length: 40 }, () => "x".repeat(1000))).length,
    16,
  );
});

test("S2 second RNG failure after owned root creation removes the root", async () => {
  await withTempBase(async (base) => {
    const cryptoModule = nodeRequire("crypto") as { randomBytes: (size: number) => Buffer };
    const originalRandomBytes = cryptoModule.randomBytes;
    let calls = 0;
    cryptoModule.randomBytes = (size: number) => {
      calls += 1;
      if (calls === 2) throw new Error("second RNG failure");
      return Buffer.alloc(size, 0xcd);
    };
    try {
      assert.throws(
        () =>
          createNativeGradientPreset({
            palette: [rgba(0), rgba(1)],
            kind: "fill",
            tempBasePath: base,
            templatePath: TOOLKIT_TEMPLATES.fill,
          }),
        assertFileError("publication-failed"),
      );
      assert.deepEqual(readdirSync(base), []);
    } finally {
      cryptoModule.randomBytes = originalRandomBytes;
    }
  });
});

test("S2 finalization and cleanup failures are both reported", async () => {
  await withTempBase(async (base) => {
    const report = await applyActivePaletteNativeGradient(
      rendererOptions([rgba(0), rgba(1)], base),
      async (request: any) => {
        writeFileSync(join(request.presets.fill.rootPath, "foreign.txt"), "preserve");
        return validHostResult({
          status: "finalization-failed",
          primaryStatus: "ok",
          selectionRestored: false,
          undoGroupClosed: false,
          selectionDiagnostics: failedSelectionDiagnostics(),
        });
      },
    );
    assert.equal(report.status, "cleanup-failed");
    assert.equal(report.primaryStatus, "ok");
    assert.equal(report.cleanup.length, 2);
    assert.equal(report.cleanup[0].error !== null, true);
    assert.equal(report.cleanup[1].removed, true);
    assert.match(nativeGradientResultMessage(report, 2), /selection and Undo finalization also failed/);
    assert.match(nativeGradientResultMessage(report, 2), /temporary preset cleanup also failed/);
  });
});

test("S2 diagnostics are bounded by count and length", async () => {
  await withTempBase(async (base) => {
    const report = await applyActivePaletteNativeGradient(
      rendererOptions([rgba(0), rgba(1)], base),
      async () => {
        throw new Error("x".repeat(5000));
      },
    );
    assert.equal(report.errors.length <= 16, true);
    assert.equal(report.errors.every((entry) => entry.length <= 512), true);
  });
  await withTempBase(async (base) => {
    const fsModule = nodeRequire("fs");
    const originalReaddirSync = fsModule.readdirSync;
    fsModule.readdirSync = () => {
      throw new Error("cleanup-".repeat(2000));
    };
    try {
      const report = await applyActivePaletteNativeGradient(
        rendererOptions([rgba(0), rgba(1)], base),
        async () => validHostResult(),
      );
      assert.equal(report.cleanup.every((entry: any) => (entry.error?.length ?? 0) <= 512), true);
    } finally {
      fsModule.readdirSync = originalReaddirSync;
    }
  });
});

test("B3 renderer never retries transport-unknown completion and preserves both leases", async () => {
  await withTempBase(async (base) => {
    let hostCalls = 0;
    const report = await applyActivePaletteNativeGradient(
      rendererOptions([rgba(0), rgba(1)], base),
      async () => {
        hostCalls += 1;
        throw new Error("transport unknown completion");
      },
    );
    assert.equal(report.status, "host-call-unknown-completion");
    assert.equal(report.primaryStatus, "host-call-unknown-completion");
    assert.equal(report.hostCallAttempted, true);
    assert.equal(hostCalls, 1);
    assert.equal(report.cleanup.length, 2);
    assert.equal(report.cleanup.every((entry: any) => entry.preserved === true), true);
    assert.equal(readdirSync(base).length, 2);
    for (const entry of report.cleanup) {
      assert.equal(entry.error, null);
      assert.equal(existsSync(entry.evidencePresetPath!), true);
    }
  });
});

test("B3 renderer classifies a host-returned unknown completion and preserves both leases", async () => {
  await withTempBase(async (base) => {
    let hostCalls = 0;
    const hostResult = validUnknownHostResult({
      targets: [
        validTarget,
        { ...validTarget, layerId: 3 },
        { ...validTarget, layerId: 4 },
      ],
      target: validTarget,
      selectedTargetCount: 3,
      selectedPropertyCount: 3,
      attemptedTargetCount: 2,
      attemptedPropertyCount: 2,
      appliedTargetCount: 1,
      appliedPropertyCount: 1,
      unknownCompletionTargetIndex: 1,
      unknownCompletionPropertyIndex: 1,
    });
    const report = await applyActivePaletteNativeGradient(
      rendererOptions([rgba(0), rgba(1)], base),
      async () => {
        hostCalls += 1;
        return hostResult;
      },
    );
    assert.equal(report.status, "host-unknown-completion");
    assert.equal(report.primaryStatus, "host-unknown-completion");
    assert.equal(report.hostResult, hostResult);
    assert.equal(hostCalls, 1);
    assert.equal(report.cleanup.length, 2);
    assert.equal(report.cleanup.every((entry: any) => entry.preserved === true), true);
    assert.equal(readdirSync(base).length, 2);
    assert.equal(
      nativeGradientResultMessage(report, 2),
      "Gradient apply may have completed on target 2 of 3; 1 earlier confirmed; temporary presets preserved for diagnosis",
    );
  });
});

test("B3 renderer cleans the first lease when second-kind generation fails before host", async () => {
  await withTempBase(async (base) => {
    let hostCalls = 0;
    const templateRootPath = join(base, "templates");
    const templateFamilyPath = join(templateRootPath, "ae22-6");
    mkdirSync(templateFamilyPath, { recursive: true });
    writeFileSync(join(templateFamilyPath, "fill-template.ffx"), readFileSync(TOOLKIT_TEMPLATES.fill));
    writeFileSync(join(templateFamilyPath, "stroke-template.ffx"), readFileSync(TOOLKIT_TEMPLATES.fill));
    const report = await applyActivePaletteNativeGradient(
      {
        palette: [rgba(0), rgba(1)],
        tempBasePath: base,
        templateRootPath,
        hostVersion: RENDERER_HOST_VERSION,
        platform: "darwin",
      },
      async () => {
        hostCalls += 1;
        return { status: "ok" };
      },
    );
    assert.equal(report.status, "preset-generation-failed");
    assert.equal(report.hostCallAttempted, false);
    assert.equal(hostCalls, 0);
    assert.equal(report.generated.length, 1);
    assert.equal(report.cleanup.length, 1);
    assert.deepEqual(readdirSync(base), ["templates"]);
  });
});

test("B3 preserves unknown completion when cleanup also fails and continues cleanup", async () => {
  await withTempBase(async (base) => {
    const report = await applyActivePaletteNativeGradient(
      rendererOptions([rgba(0), rgba(1)], base),
      async (request: any) => {
        writeFileSync(join(request.presets.fill.rootPath, "foreign.txt"), "preserve");
        throw new Error("transport unknown completion");
      },
    );

    assert.equal(report.status, "cleanup-failed");
    assert.equal(report.primaryStatus, "host-call-unknown-completion");
    assert.equal(report.cleanup.length, 2);
    assert.deepEqual(
      report.cleanup.map((entry: any) => [entry.kind, entry.removed, entry.error !== null]),
      [
        ["fill", false, true],
        ["stroke", false, false],
      ],
    );
    assert.equal(report.cleanup[1].preserved, true);
    assert.equal(
      nativeGradientResultMessage(report, 2),
      "Gradient apply may have completed; verify the selected gradient; temporary preset cleanup also failed",
    );
  });
});

test("B3 renderer accepts AE-normalized restoration as success and rejects contradictory evidence", async () => {
  const expected = [
    {
      layerId: 2,
      layerIndex: 1,
      selected: true,
      properties: [{
        propertyIndexPath: validTarget.propertyIndexPath,
        matchNamePath: validTarget.matchNamePath,
      }],
    },
    {
      layerId: 3,
      layerIndex: 2,
      selected: true,
      properties: [{
        propertyIndexPath: [1, 1, 1, 1],
        matchNamePath: [
          "ADBE Root Vectors Group",
          "ADBE Vector Group",
          "ADBE Vector Graphic - G-Stroke",
          "ADBE Vector Grad Colors",
        ],
      }],
    },
  ];
  const actual = [
    {
      ...expected[0],
      properties: [
        {
          propertyIndexPath: [1, 1],
          matchNamePath: ["ADBE Root Vectors Group", "ADBE Vector Group"],
        },
        ...expected[0].properties,
      ],
    },
    expected[1],
  ];
  const operationLayers = (entries: typeof expected) => entries
    .filter((entry) => entry.selected || entry.properties.length > 0)
    .map((entry) => ({
      layerId: entry.layerId,
      layerIndex: entry.layerIndex,
      selected: entry.selected,
      resolved: true,
      selectedAfterSet: entry.selected,
      properties: entry.properties.map((property) => ({
        ...property,
        resolved: true,
        selectedAfterSet: true,
      })),
    }));
  const diagnostics = {
    schemaVersion: 1,
    inGroup: {
      stage: "complete",
      error: null,
      expected,
      expectedTruncated: false,
      actual,
      actualTruncated: false,
      exact: false,
      acceptedNormalization: true,
      layers: operationLayers(expected),
      layersTruncated: false,
    },
    afterUndoGroup: {
      actual,
      actualTruncated: false,
      exact: false,
      acceptedNormalization: true,
    },
  };
  await withTempBase(async (base) => {
    const report = await applyActivePaletteNativeGradient(
      { ...rendererOptions([rgba(0), rgba(1)], base), hostVersion: "23.6x62" },
      async () => validHostResult({
        hostVersion: "23.6x62",
        selectionRestorationMode: "ae-normalized",
        selectionDiagnostics: diagnostics,
      }),
    );
    assert.equal(report.status, "ok");
    assert.equal(report.primaryStatus, "ok");
    assert.equal(nativeGradientResultMessage(report, 2), "Applied 2-color native gradient");
    assert.deepEqual(readdirSync(base), []);
  });
  assert.equal(
    decodeNativeGradientApplyResult(
      validHostResult({
        hostVersion: "23.6x62",
        selectionRestorationMode: "ae-normalized",
        selectionDiagnostics: {
          ...diagnostics,
          inGroup: { ...diagnostics.inGroup, acceptedNormalization: false },
        },
      }),
      "23.6x62",
    ),
    null,
  );
  assert.equal(
    decodeNativeGradientApplyResult(
      validHostResult({
        hostVersion: "23.6x62",
        selectionRestorationMode: "ae-normalized",
        selectionDiagnostics: {
          ...diagnostics,
          inGroup: { ...diagnostics.inGroup, layersTruncated: true },
        },
      }),
      "23.6x62",
    ),
    null,
  );
  assert.equal(
    decodeNativeGradientApplyResult(
      validHostResult({
        hostVersion: "23.6x62",
        selectionRestorationMode: "ae-normalized",
        selectionDiagnostics: {
          ...diagnostics,
          inGroup: { ...diagnostics.inGroup, layers: [] },
        },
      }),
      "23.6x62",
    ),
    null,
  );
  const duplicatedExpected = [expected[0], { ...expected[0] }];
  const duplicatedActual = [actual[0], { ...actual[0] }];
  assert.equal(
    decodeNativeGradientApplyResult(
      validHostResult({
        hostVersion: "23.6x62",
        selectionRestorationMode: "ae-normalized",
        selectionDiagnostics: {
          ...diagnostics,
          inGroup: {
            ...diagnostics.inGroup,
            expected: duplicatedExpected,
            actual: duplicatedActual,
            layers: operationLayers(duplicatedExpected),
          },
          afterUndoGroup: {
            ...diagnostics.afterUndoGroup,
            actual: duplicatedActual,
          },
        },
      }),
      "23.6x62",
    ),
    null,
  );
  const mixedExpected = [
    expected[0],
    {
      ...expected[1],
      properties: [{
        propertyIndexPath: [1],
        matchNamePath: ["ADBE Opacity"],
      }],
    },
  ];
  const mixedActual = [
    {
      ...mixedExpected[0],
      properties: [actual[0].properties[0], ...mixedExpected[0].properties],
    },
    mixedExpected[1],
  ];
  assert.equal(
    decodeNativeGradientApplyResult(
      validHostResult({
        hostVersion: "23.6x62",
        selectionRestorationMode: "ae-normalized",
        selectionDiagnostics: {
          ...diagnostics,
          inGroup: {
            ...diagnostics.inGroup,
            expected: mixedExpected,
            actual: mixedActual,
            layers: operationLayers(mixedExpected),
          },
          afterUndoGroup: {
            ...diagnostics.afterUndoGroup,
            actual: mixedActual,
          },
        },
      }),
      "23.6x62",
    ),
    null,
  );
  const driftedAfterUndo = [actual[0], { ...actual[1], properties: [] }];
  assert.equal(
    decodeNativeGradientApplyResult(
      validHostResult({
        status: "selection-restore-failed",
        primaryStatus: "ok",
        hostVersion: "23.6x62",
        selectionRestored: false,
        selectionDiagnostics: {
          ...diagnostics,
          afterUndoGroup: {
            actual: driftedAfterUndo,
            actualTruncated: false,
            exact: false,
            acceptedNormalization: false,
          },
        },
      }),
      "23.6x62",
    )?.status,
    "selection-restore-failed",
  );
  assert.equal(
    decodeNativeGradientApplyResult(
      validHostResult({
        hostVersion: "23.6x62",
        selectionRestorationMode: "ae-normalized",
        selectionDiagnostics: {
          ...diagnostics,
          inGroup: { ...diagnostics.inGroup, actual: expected },
          afterUndoGroup: { ...diagnostics.afterUndoGroup, actual: expected },
        },
      }),
      "23.6x62",
    ),
    null,
  );
});

test("B3 result messages use exact B2 status literals and preserve cleanup evidence", () => {
  const report = (status: string, cleanupFailed = false, primaryStatus?: string) => ({
    status: cleanupFailed ? "cleanup-failed" : "host-rejected",
    primaryStatus: "host-rejected",
    hostCallAttempted: true,
    hostResult: { status, primaryStatus },
    generated: [],
    cleanup: [],
    errors: [],
  });

  assert.equal(
    nativeGradientResultMessage(report("ambiguous-selected-gradient") as any, 3),
    "Could not resolve the selected native gradients",
  );
  assert.equal(
    nativeGradientResultMessage(
      {
        status: "ok",
        primaryStatus: "ok",
        hostCallAttempted: true,
        hostResult: {
          status: "ok",
          primaryStatus: "ok",
          appliedTargetCount: 3,
          skippedDisabledCount: 1,
          preservedStateCount: 1,
        },
        generated: [],
        cleanup: [],
        errors: [],
      } as any,
      3,
    ),
    "Applied 3-color native gradient to 3 properties; skipped 1 disabled branches; preserved 1 properties",
  );
  assert.equal(
    nativeGradientResultMessage(report("unsupported-selected-gradient") as any, 3),
    "Select a static, unlocked native gradient",
  );
  assert.equal(
    nativeGradientResultMessage(report("selection-snapshot-failed") as any, 3),
    "The property selection changed before apply",
  );
  assert.equal(
    nativeGradientResultMessage(report("apply-unknown-completion", true) as any, 3),
    "Gradient apply may have completed; verify the selected gradient; temporary preset cleanup also failed",
  );
  assert.equal(
    nativeGradientResultMessage(
      report("finalization-failed", false, "apply-unknown-completion") as any,
      3,
    ),
    "Gradient apply may have completed; verify the selected gradient; After Effects selection and Undo finalization also failed",
  );
  assert.equal(
    nativeGradientResultMessage(
      report("finalization-failed", true, "apply-unknown-completion") as any,
      3,
    ),
    "Gradient apply may have completed; verify the selected gradient; After Effects selection and Undo finalization also failed; temporary preset cleanup also failed",
  );
});

test("B3 Main removes the flyout gradient action while preserving automation and swatch apply", () => {
  const initSource = readFileSync(join(REPO_ROOT, "src/js/lib/utils/init-cep.ts"), "utf8");
  const mainSource = readFileSync(join(REPO_ROOT, "src/js/main/main.tsx"), "utf8");
  assert.doesNotMatch(initSource, /Id="apply-active-palette-gradient"/);
  assert.doesNotMatch(initSource, /Label="Apply Active Palette as Gradient"/);
  assert.match(initSource, /APPLY_ACTIVE_PALETTE_GRADIENT_EVENT/);
  assert.match(mainSource, /applyActivePaletteNativeGradient/);
  assert.match(mainSource, /applyNativeGradientPresetToSelectedTarget/);
  assert.match(mainSource, /APPLY_ACTIVE_PALETTE_GRADIENT_EVENT/);
  assert.match(mainSource, /dispatchPaletteResult/);
  assert.match(mainSource, /hostActionRef\.current \|\| paletteMutationRef\.current/);
  assert.match(mainSource, /hostActionRef\.current = true;[\s\S]*paletteMutationRef\.current = true;[\s\S]*setPendingHostAction\("gradient"\)/);
  assert.doesNotMatch(mainSource, /multiple-selected-gradients|target-state-unsupported|selection-drift/);
  assert.match(
    mainSource,
    /evalTS\(\s*"applyColorToSelectedProperties",\s*rgba,\s*layoutSettings\.includeDisabledColors,\s*layoutSettings\.smartApply\s*\)/
  );
  assert.doesNotMatch(mainSource, /onClick=\{[^}]*applyActivePaletteNativeGradient/);
});

test("Track B runner proves production identity before owned debug navigation and restores production", () => {
  const runnerSource = readFileSync(join(REPO_ROOT, "scripts/run-live-ae-tests.mjs"), "utf8");
  const startupSource = runnerSource.slice(runnerSource.indexOf("const main = async () => {"));
  const targetIndex = startupSource.indexOf("const target = await exactMainTarget()");
  const enableIndex = startupSource.indexOf('client.send("Page.enable")');
  const productionIndex = startupSource.indexOf('createBuildManifest("production-pre-run")');
  const devBuildIndex = startupSource.indexOf('runCanonicalBuild("build:dev")');
  const navigateIndex = startupSource.indexOf("navigateMain(client, devUrl, true, operationGuard)");
  const waitIndex = startupSource.indexOf("await waitForDebug(client, operationGuard)");
  const productionRestoreIndex = startupSource.indexOf("prepareProductionBuild()");

  assert.ok(targetIndex >= 0, "runner does not select the exact realpath Main target");
  assert.ok(enableIndex >= 0, "runner does not enable the CDP Page domain");
  assert.ok(productionIndex > enableIndex, "runner does not capture production after CDP enablement");
  assert.ok(devBuildIndex > productionIndex, "runner builds debug before capturing production identity");
  assert.ok(navigateIndex > devBuildIndex, "runner navigates before its owned debug build exists");
  assert.ok(waitIndex > navigateIndex, "runner waits for debug before owned debug navigation");
  assert.ok(productionRestoreIndex > waitIndex, "runner does not restore the canonical production build");
  assert.doesNotMatch(startupSource, /Page\.reload/);
});
