import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@zimoby/ae-native-gradient";
const PACKAGE_VERSION = "0.2.0";
const APPROVED_TARBALL =
  "https://registry.npmjs.org/@zimoby/ae-native-gradient/-/ae-native-gradient-0.2.0.tgz";
const APPROVED_INTEGRITY =
  "sha512-9Jko+z0AxDWfgwGKwU6Vg8aJhCn2p/7dGDPE9CpNS/5Qj+103/V890pYxvorKUgb5E6lrNLgflF6fNRDsIbCZA==";
const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

type JsonRecord = Record<string, unknown>;

function readJson(path: string): JsonRecord {
  return JSON.parse(readFileSync(path, "utf8")) as JsonRecord;
}

const installedPackageJsonPath = fileURLToPath(
  import.meta.resolve(`${PACKAGE_NAME}/package.json`),
);
const installedPackage = readJson(installedPackageJsonPath);
const rootPackage = readJson(join(REPO_ROOT, "package.json"));
const lock = readJson(join(REPO_ROOT, "package-lock.json"));
const workflow = readFileSync(join(REPO_ROOT, ".github/workflows/main.yml"), "utf8");
const packages = lock.packages as Record<string, JsonRecord>;
const rootLockEntry = packages[""];
const installedLockEntry = packages[`node_modules/${PACKAGE_NAME}`];

const templatePaths = {
  fill: fileURLToPath(import.meta.resolve(`${PACKAGE_NAME}/templates/fill.ffx`)),
  stroke: fileURLToPath(import.meta.resolve(`${PACKAGE_NAME}/templates/stroke.ffx`)),
};
const versionedTemplatePaths = Object.fromEntries(
  ["ae22-6", "ae25-6", "ae26-3"].map((family) => [
    family,
    {
      fill: fileURLToPath(import.meta.resolve(`${PACKAGE_NAME}/templates/${family}/fill.ffx`)),
      stroke: fileURLToPath(import.meta.resolve(`${PACKAGE_NAME}/templates/${family}/stroke.ffx`)),
    },
  ]),
) as Record<string, Record<"fill" | "stroke", string>>;

test("uses the exact public npm release and immutable registry artifact", () => {
  assert.equal(installedPackage.name, PACKAGE_NAME);
  assert.equal(installedPackage.version, PACKAGE_VERSION);
  assert.equal("private" in installedPackage, false);
  assert.equal(installedPackage.license, "MIT");
  const installedLicense = readFileSync(join(dirname(installedPackageJsonPath), "LICENSE"), "utf8");
  assert.equal(installedLicense.startsWith("MIT License\n\nCopyright (c) 2026 Zimoby\n"), true);

  const manifestDependencies = rootPackage.dependencies as Record<string, string>;
  assert.equal(manifestDependencies[PACKAGE_NAME], PACKAGE_VERSION);

  const rootDependencies = rootLockEntry.dependencies as Record<string, string>;
  assert.equal(rootDependencies[PACKAGE_NAME], PACKAGE_VERSION);

  assert.equal(installedLockEntry.version, PACKAGE_VERSION);
  assert.equal(installedLockEntry.license, "MIT");
  assert.equal(installedLockEntry.integrity, APPROVED_INTEGRITY);
  assert.equal(installedLockEntry.resolved, APPROVED_TARBALL);
});

test("CI install is deterministic, Node 22 aligned, public, and credential safe", () => {
  assert.equal(existsSync(join(REPO_ROOT, ".npmrc")), false, "project npm config must not bypass peers");
  assert.match(workflow, /node-version: \[22\.22\.3\]/);
  assert.match(workflow, /^  pull_request:\r?$/m);
  assert.match(workflow, /^  workflow_dispatch:\r?$/m);
  assert.match(workflow, /^      - main\r?$/m);
  assert.match(workflow, /^  contents: read\r?$/m);

  const checkoutSteps = Array.from(
    workflow.matchAll(
      /^      - uses: actions\/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5\.1\.0\r?\n(?:(?!^      - ).*(?:\r?\n|$))*/gm,
    ),
    (match) => match[0],
  );
  assert.equal(checkoutSteps.length, 1, "expected one bounded checkout step");
  const checkoutStep = checkoutSteps[0];
  const checkoutWithBlock = checkoutStep.match(
    /^        with:\r?\n((?: {10,}.*(?:\r?\n|$))+)/m,
  )?.[0];
  assert.ok(checkoutWithBlock, "expected one checkout with block");
  assert.match(checkoutWithBlock, /^          persist-credentials: false\r?$/m);
  assert.match(
    workflow,
    /^        uses: actions\/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5\.0\.0\r?$/m,
  );

  const installStep = workflow.match(
    /^      - name: Install dependencies\r?\n((?: {8,}.*(?:\r?\n|$))+)/m,
  )?.[0];
  assert.ok(installStep, "expected one bounded named install step");
  assert.match(installStep, /^        shell: bash$/m);
  assert.match(installStep, /^        run: \|$/m);
  assert.match(installStep, /^          npm ci --legacy-peer-deps=false$/m);
  assert.doesNotMatch(installStep, /GIT_CONFIG_|credential\.helper|password=|secrets\./);
  assert.doesNotMatch(workflow, /AE_NATIVE_GRADIENT_READ_TOKEN|private Git dependency/);
  assert.doesNotMatch(workflow, /legacy-peer-deps=true|npm i --legacy-peer-deps/);
});

test("public library exposes collection APIs and all versioned readable FFX templates", async () => {
  const library = await import(PACKAGE_NAME);
  assert.equal(typeof library.parseRifx, "function");
  assert.equal(typeof library.indexAepNativeGradientTargets, "function");
  assert.equal(typeof library.resolveAepNativeGradientTarget, "function");
  assert.equal(typeof library.resolveAepNativeGradients, "function");
  assert.equal(typeof library.createImplicitDefaultNativeGradient, "function");

  assert.deepEqual(Object.keys(library.NATIVE_GRADIENT_TEMPLATE_METADATA), [
    "ae22-6",
    "ae25-6",
    "ae26-3",
  ]);
  for (const [family, paths] of Object.entries(versionedTemplatePaths)) {
    for (const [kind, path] of Object.entries(paths)) {
      assert.equal(statSync(path).isFile(), true, `${family}/${kind} export must resolve`);
      const bytes = new Uint8Array(readFileSync(path));
      assert.ok(bytes.byteLength > 0, `${family}/${kind} template must be non-empty`);
      assert.equal(
        library.NATIVE_GRADIENT_TEMPLATE_METADATA[family][kind].sha256,
        (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex"),
      );
      assert.equal(library.parseRifx(bytes).root.formType, "FaFX");
    }
  }
});

test("installed CLI binds both exported templates to the exact implicit default model", () => {
  const bin = installedPackage.bin as Record<string, string>;
  const cliPath = join(dirname(installedPackageJsonPath), bin["ae-native-gradient"]);
  const expectedGradient = {
    schemaVersion: 1,
    colorStops: [
      { offset: 0, midpoint: 0.5, rgb: [1, 1, 1], extra: 1 },
      { offset: 1, midpoint: 0.5, rgb: [0, 0, 0], extra: 1 },
    ],
    alphaStops: [
      { offset: 0, midpoint: 0.5, alpha: 1 },
      { offset: 1, midpoint: 0.5, alpha: 1 },
    ],
  };

  for (const [kind, templatePath] of Object.entries(templatePaths)) {
    const result = spawnSync(
      process.execPath,
      [cliPath, "inspect", "--unique", templatePath],
      { cwd: REPO_ROOT, encoding: "utf8", timeout: 15_000 },
    );

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, `${kind}: ${result.stderr}`);
    const report = JSON.parse(result.stdout) as {
      schemaVersion: number;
      candidates: Array<{ status: string; gradient: unknown }>;
      uniqueProof?: { passed: boolean };
    };
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.candidates.length, 1);
    assert.equal(report.candidates[0]?.status, "valid");
    assert.deepEqual(report.candidates[0]?.gradient, expectedGradient);
    assert.equal(report.uniqueProof?.passed, true);
  }
});