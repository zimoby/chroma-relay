import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@zimoby/ae-native-gradient";
const PACKAGE_VERSION = "0.1.0";
const APPROVED_SHA = "04144bea5f16e8b2dc2355b72f315f810c3f97e1";
const APPROVED_SOURCE = `git+https://github.com/zimoby/ae-native-gradient-toolkit.git#${APPROVED_SHA}`;
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

test("uses the approved installed package and exact immutable lock source", () => {
  assert.equal(installedPackage.name, PACKAGE_NAME);
  assert.equal(installedPackage.version, PACKAGE_VERSION);

  const manifestDependencies = rootPackage.dependencies as Record<string, string>;
  assert.equal(manifestDependencies[PACKAGE_NAME], APPROVED_SOURCE);

  const rootDependencies = rootLockEntry.dependencies as Record<string, string>;
  assert.equal(rootDependencies[PACKAGE_NAME], APPROVED_SOURCE);

  assert.equal(installedLockEntry.version, PACKAGE_VERSION);
  const resolved = installedLockEntry.resolved;
  assert.equal(typeof resolved, "string");
  assert.match(
    resolved,
    new RegExp(
      `^git\\+(?:https://github\\.com/|ssh://git@github\\.com/)(?:zimoby/ae-native-gradient-toolkit)(?:\\.git)?#${APPROVED_SHA}$`,
    ),
  );
});

test("tag-release install is deterministic, Node 22 aligned, and credential safe", () => {
  assert.match(workflow, /node-version: \[22\.22\.3\]/);

  const checkoutSteps = Array.from(
    workflow.matchAll(
      /^      - uses: actions\/checkout@v2\r?\n(?:(?!^      - ).*(?:\r?\n|$))*/gm,
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

  const installStep = workflow.match(
    /^      - name: Install dependencies\r?\n((?: {8,}.*(?:\r?\n|$))+)/m,
  )?.[0];
  assert.ok(installStep, "expected one bounded named install step");
  assert.match(installStep, /^        shell: bash$/m);
  assert.match(installStep, /^        run: \|$/m);
  assert.match(installStep, /^          npm ci$/m);
  assert.match(
    installStep,
    /^          AE_NATIVE_GRADIENT_READ_TOKEN: \$\{\{ secrets\.AE_NATIVE_GRADIENT_READ_TOKEN \}\}$/m,
  );
  assert.match(installStep, /^          GIT_CONFIG_COUNT: "2"$/m);
  assert.match(installStep, /^          GIT_CONFIG_KEY_0: url\.https:\/\/github\.com\/\.insteadOf$/m);
  assert.match(installStep, /^          GIT_CONFIG_VALUE_0: ssh:\/\/git@github\.com\/$/m);
  assert.match(installStep, /^          GIT_CONFIG_KEY_1: credential\.helper$/m);
  assert.match(
    installStep,
    /^          GIT_CONFIG_VALUE_1: >-\r?\n            .*password=\$AE_NATIVE_GRADIENT_READ_TOKEN/m,
  );
  assert.match(
    installStep,
    /if \[ -z "\$AE_NATIVE_GRADIENT_READ_TOKEN" \]; then[\s\S]*exit 1/,
  );
  assert.equal(
    workflow.match(/secrets\.AE_NATIVE_GRADIENT_READ_TOKEN/g)?.length,
    1,
    "the read token secret must only be injected into the install step",
  );
  assert.doesNotMatch(workflow, /npm i --legacy-peer-deps/);
});

test("public library import parses both exported readable FFX templates", async () => {
  const library = await import(PACKAGE_NAME);
  assert.equal(typeof library.parseRifx, "function");
  assert.equal(typeof library.indexAepNativeGradientTargets, "function");
  assert.equal(typeof library.resolveAepNativeGradientTarget, "function");

  for (const [kind, path] of Object.entries(templatePaths)) {
    assert.equal(statSync(path).isFile(), true, `${kind} export must resolve to a file`);
    const bytes = new Uint8Array(readFileSync(path));
    assert.ok(bytes.byteLength > 0, `${kind} template must be readable and non-empty`);
    const document = library.parseRifx(bytes);
    assert.equal(document.root.formType, "FaFX");
  }
});

test("installed CLI uniquely inspects an exported template", () => {
  const bin = installedPackage.bin as Record<string, string>;
  const cliPath = join(dirname(installedPackageJsonPath), bin["ae-native-gradient"]);
  const result = spawnSync(
    process.execPath,
    [cliPath, "inspect", "--unique", templatePaths.fill],
    { cwd: REPO_ROOT, encoding: "utf8", timeout: 15_000 },
  );

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout) as {
    schemaVersion: number;
    candidates: Array<{ status: string }>;
    uniqueProof?: { passed: boolean };
  };
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.candidates.length, 1);
  assert.equal(report.candidates[0]?.status, "valid");
  assert.equal(report.uniqueProof?.passed, true);
});