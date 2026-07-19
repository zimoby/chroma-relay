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
  getNativeGradientTempBasePath,
  nativeGradientResultMessage,
  paletteRgbaToNativeGradient,
  probeNativeGradientNodeCapabilities,
  validateNativeGradientForApplication,
} = await import("../src/js/main/native-gradient-files.ts");

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const OWNED_TEMPLATE_ROOT = join(REPO_ROOT, "src/assets/native-gradient");
const OWNED_TEMPLATES = {
  fill: join(OWNED_TEMPLATE_ROOT, "ae25-6/fill-template.ffx"),
  stroke: join(OWNED_TEMPLATE_ROOT, "ae25-6/stroke-template.ffx"),
} as const;
const TEMPLATE_SHA256 = {
  fill: "a0cddaf936cc337a427d3a81c4224764fd6fc1f13a9bbeb6ae863276fa28dc59",
  stroke: "cb1ffe6195604834203a950433a83dd7097e971f8477567fdc2c32e3c34ed9dd",
} as const;
const RENDERER_HOST_VERSION = "25.6.6";
const rendererOptions = (palette: readonly [number, number, number, number][], base: string) => ({
  palette,
  tempBasePath: base,
  templateRootPath: OWNED_TEMPLATE_ROOT,
  hostVersion: RENDERER_HOST_VERSION,
  includeDisabledTargets: false,
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

test("owns AE25 kind-specific templates distinct from the AE26 toolkit assets", () => {
  const packageTemplates = {
    fill: fileURLToPath(import.meta.resolve("@zimoby/ae-native-gradient/templates/fill.ffx")),
    stroke: fileURLToPath(import.meta.resolve("@zimoby/ae-native-gradient/templates/stroke.ffx")),
  } as const;

  for (const kind of ["fill", "stroke"] as const) {
    const owned = readFileSync(OWNED_TEMPLATES[kind]);
    const installed = readFileSync(packageTemplates[kind]);
    assert.notDeepEqual(owned, installed);
    assert.equal(sha256(owned), TEMPLATE_SHA256[kind]);
    assert.equal(owned.includes(Buffer.from("Adobe After Effects 2025 (Macintosh)")), true);
    assert.equal(installed.includes(Buffer.from("Adobe After Effects 2026 (Macintosh)")), true);
  }

  const config = readFileSync(join(REPO_ROOT, "cep.config.ts"), "utf8");
  assert.match(config, /assets\/native-gradient\/ae25-6\/fill-template\.ffx/);
  assert.match(config, /assets\/native-gradient\/ae25-6\/stroke-template\.ffx/);
});

test("atomically publishes a token-owned preset and reports exact generated evidence", async () => {
  await withTempBase((base) => {
    const palette = [rgba(0), rgba(1), rgba(2)];
    const lease = createNativeGradientPreset({
      palette,
      kind: "fill",
      tempBasePath: base,
      templatePath: OWNED_TEMPLATES.fill,
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
      templatePath: OWNED_TEMPLATES.fill,
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
      templatePath: OWNED_TEMPLATES.stroke,
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
          templatePath: OWNED_TEMPLATES.fill,
        }),
      assertFileError("template-mismatch"),
    );
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
        templatePath: OWNED_TEMPLATES.fill,
      });
      assert.throws(
        () =>
          createNativeGradientPreset({
            palette: [rgba(0), rgba(1)],
            kind: "fill",
            tempBasePath: base,
            templatePath: OWNED_TEMPLATES.fill,
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
      templatePath: OWNED_TEMPLATES.fill,
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
        templatePath: OWNED_TEMPLATES.fill,
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
            templatePath: OWNED_TEMPLATES.fill,
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
            templatePath: OWNED_TEMPLATES.fill,
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
    const hostResult = { status: "ok", mutationAttempted: true, applyCompleted: true };
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

test("B3 renderer rejects an unproven host before template reads or host mutation", async () => {
  await withTempBase(async (base) => {
    let hostCalls = 0;
    const report = await applyActivePaletteNativeGradient(
      {
        ...rendererOptions([rgba(0), rgba(1)], base),
        hostVersion: "26.3x87",
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
      async () => ({
        status: "selection-restore-failed",
        primaryStatus: "ok",
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

test("B3 resolves the live macOS Folder.temp base without adding a Windows subdirectory", () => {
  assert.equal(
    getNativeGradientTempBasePath("darwin", "/private/var/folders/example/T"),
    "/private/var/folders/example/T/TemporaryItems",
  );
  assert.equal(getNativeGradientTempBasePath("win32", "C:\\Temp"), "C:\\Temp");
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
    const hostResult = {
      status: "apply-unknown-completion",
      mutationAttempted: true,
      applyCompleted: null,
      selectedTargetCount: 3,
      appliedTargetCount: 1,
      unknownCompletionTargetIndex: 1,
    };
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
    const templateFamilyPath = join(templateRootPath, "ae25-6");
    mkdirSync(templateFamilyPath, { recursive: true });
    writeFileSync(join(templateFamilyPath, "fill-template.ffx"), readFileSync(OWNED_TEMPLATES.fill));
    writeFileSync(join(templateFamilyPath, "stroke-template.ffx"), readFileSync(OWNED_TEMPLATES.fill));
    const report = await applyActivePaletteNativeGradient(
      {
        palette: [rgba(0), rgba(1)],
        tempBasePath: base,
        templateRootPath,
        hostVersion: RENDERER_HOST_VERSION,
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
    "Applied 3-color native gradient to 3 properties; skipped 2",
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

test("B3 Main exposes only the explicit flyout gradient action and preserves normal swatch apply", () => {
  const initSource = readFileSync(join(REPO_ROOT, "src/js/lib/utils/init-cep.ts"), "utf8");
  const mainSource = readFileSync(join(REPO_ROOT, "src/js/main/main.tsx"), "utf8");
  assert.match(initSource, /Id="apply-active-palette-gradient"/);
  assert.match(initSource, /Label="Apply Active Palette as Gradient"/);
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
    /evalTS\(\s*"applyColorToSelectedProperties",\s*rgba,\s*layoutSettings\.includeDisabledColors\s*\)/
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
  const navigateIndex = startupSource.indexOf("navigateMain(client, devUrl, true)");
  const waitIndex = startupSource.indexOf("await waitForDebug(client)");
  const productionRestoreIndex = startupSource.indexOf('runCanonicalBuild("build")');

  assert.ok(targetIndex >= 0, "runner does not select the exact realpath Main target");
  assert.ok(enableIndex >= 0, "runner does not enable the CDP Page domain");
  assert.ok(productionIndex > enableIndex, "runner does not capture production after CDP enablement");
  assert.ok(devBuildIndex > productionIndex, "runner builds debug before capturing production identity");
  assert.ok(navigateIndex > devBuildIndex, "runner navigates before its owned debug build exists");
  assert.ok(waitIndex > navigateIndex, "runner waits for debug before owned debug navigation");
  assert.ok(productionRestoreIndex > waitIndex, "runner does not restore the canonical production build");
  assert.doesNotMatch(startupSource, /Page\.reload/);
});
