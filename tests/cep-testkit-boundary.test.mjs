import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  CEP_TESTKIT_INTEGRITY,
  boundaryFailures,
  collectSourceFiles,
  productionDistFailures,
} from "../scripts/check-cep-testkit-boundary.mjs";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const loadBoundaryInputs = async () => ({
  packageJson: JSON.parse(await read("package.json")),
  lock: JSON.parse(await read("package-lock.json")),
  cepConfigSource: await read("cep.config.ts"),
  viteConfigSource: await read("vite.config.ts"),
  sourceFiles: [],
});

test("consumer manifest and source topology pass the fail-closed testkit boundary", async () => {
  assert.deepEqual(boundaryFailures(await loadBoundaryInputs()), []);
});

test("boundary rejects a production dependency mutation", async () => {
  const input = await loadBoundaryInputs();
  input.packageJson.dependencies["@zimoby/cep-testkit"] = "0.1.0";
  assert.match(boundaryFailures(input).join("\n"), /production dependency/);
});

test("boundary rejects a non-exact registry lock mutation", async () => {
  const input = await loadBoundaryInputs();
  input.lock.packages["node_modules/@zimoby/cep-testkit"].integrity = CEP_TESTKIT_INTEGRITY.replace("nwa", "bad");
  assert.match(boundaryFailures(input).join("\n"), /exact registry artifact/);
});

test("boundary rejects a source import and topology mutation causally", async () => {
  const input = await loadBoundaryInputs();
  input.sourceFiles = [{ path: "src/js/main/main.tsx", source: 'import { CdpClient } from "@zimoby/cep-testkit/cdp";' }];
  assert.match(boundaryFailures(input).join("\n"), /production source imports/);
  const dynamic = await loadBoundaryInputs();
  dynamic.sourceFiles = [{ path: "src/js/main/lazy.ts", source: 'const load = () => import("@zimoby/cep-testkit/cdp");' }];
  assert.match(boundaryFailures(dynamic).join("\n"), /production source imports/);
  const resolved = await loadBoundaryInputs();
  resolved.sourceFiles = [{ path: "src/js/main/resolve.ts", source: 'require.resolve("@zimoby/cep-testkit/cdp");' }];
  assert.match(boundaryFailures(resolved).join("\n"), /production source imports/);
  const aliased = await loadBoundaryInputs();
  aliased.sourceFiles = [{ path: "src/js/main/alias.ts", source: 'const load = require; load("@zimoby/cep-testkit/cdp");' }];
  assert.match(boundaryFailures(aliased).join("\n"), /production source imports/);
  const innocent = await loadBoundaryInputs();
  innocent.sourceFiles = [
    { path: "src/js/main/innocent.ts", source: "const safe = true;" },
    { path: "src/js/main/compat.ts", source: 'const packageName = "@zimoby/cep-testkit-compat";' },
  ];
  assert.deepEqual(boundaryFailures(innocent), []);

  const configMutation = await loadBoundaryInputs();
  configMutation.cepConfigSource = configMutation.cepConfigSource.replace("installModules: [],", 'installModules: ["@zimoby/cep-testkit"],');
  assert.match(boundaryFailures(configMutation).join("\n"), /installModules/);

  const viteMutation = await loadBoundaryInputs();
  viteMutation.viteConfigSource = `${viteMutation.viteConfigSource}\nconst leaked = "@zimoby/cep-testkit";\n`;
  assert.match(boundaryFailures(viteMutation).join("\n"), /Vite.*must not mention/);
});

test("boundary rejects every source-tree symlink causally", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "chroma-relay-boundary-source-symlink-"));
  try {
    const target = join(fixture, "real.ts");
    const linked = join(fixture, "linked.ts");
    await writeFile(target, "export const safe = true;\n");
    await symlink(target, linked);

    const sourceFiles = await collectSourceFiles(fixture);
    assert.equal(sourceFiles.some((file) => file.path === linked && file.symbolicLink === true), true);

    const input = await loadBoundaryInputs();
    input.sourceFiles = sourceFiles;
    assert.match(boundaryFailures(input).join("\n"), /source tree contains a symlink/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("fresh production dist accepts clean output and rejects package text or symlinks", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "chroma-relay-boundary-test-"));
  try {
    await mkdir(join(fixture, "assets"), { recursive: true });
    await writeFile(join(fixture, "assets", "main.cjs"), "(() => {})();\n");
    assert.deepEqual(await productionDistFailures(fixture), []);

    await writeFile(join(fixture, "assets", "leak.txt"), "@zimoby/cep-testkit\n");
    assert.match((await productionDistFailures(fixture)).join("\n"), /testkit\/package source text/);

    await rm(join(fixture, "assets", "leak.txt"));
    await symlink(join(fixture, "assets", "main.cjs"), join(fixture, "assets", "linked.cjs"));
    assert.match((await productionDistFailures(fixture)).join("\n"), /contains a symlink/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
