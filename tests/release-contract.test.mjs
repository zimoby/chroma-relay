import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  hostCompatibilityFailures,
  rendererCoverageFailures,
} from "../scripts/check-cep-compat.mjs";

const readText = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("one static command covers build, product tests, runner contracts, and CEP scan", async () => {
  const packageJson = JSON.parse(await readText("../package.json"));
  assert.equal(
    packageJson.scripts["test:runner-contract"],
    "node --experimental-strip-types --test tests/product-contract.test.mjs tests/live-runner-contract.test.mjs && node --test tests/live-runner.test.mjs",
  );
  const verify = packageJson.scripts["verify:static"];
  for (const command of [
    "npm run build",
    "npm run test:domain",
    "npm run test:storage",
    "npm run test:host-contract",
    "npm run test:native-gradient",
    "npm run test:runner-contract",
    "npm run test:release-contract",
    "npm run check:cep",
  ]) {
    assert.ok(verify.includes(command), `verify:static must include ${command}`);
  }
});

test("build and package scripts use one Bolt Vite pipeline", async () => {
  const packageJson = JSON.parse(await readText("../package.json"));
  const viteConfig = await readText("../vite.config.ts");

  assert.equal(
    packageJson.scripts.build,
    'rimraf dist/* && tsc -p "tsconfig-build.json" && vite build --watch false'
  );
  assert.equal(packageJson.scripts["package:alpha"], undefined);
  assert.match(packageJson.scripts.zxp, /ZXP_PACKAGE=true vite build --watch false/);
  assert.match(packageJson.scripts.zip, /ZIP_PACKAGE=true vite build --watch false$/);
  assert.match(packageJson.scripts["cdp:native-gradient:prepare"], /prepareProductionBuild/);
  assert.match(viteConfig, /cep\(config\)/);
  assert.doesNotMatch(viteConfig, /ALPHA_PACKAGE|isUnsignedAlpha/);
});

test("tag workflow verifies static input and scans the actual ZXP build before publishing", async () => {
  const packageJson = JSON.parse(await readText("../package.json"));
  const workflow = await readText("../.github/workflows/main.yml");
  const verifyIndex = workflow.indexOf("npm run verify:static");
  const buildIndex = workflow.indexOf("npm run zxp");
  const releaseIndex = workflow.indexOf("softprops/action-gh-release");
  assert.ok(verifyIndex >= 0, "workflow must run verify:static");
  assert.ok(buildIndex > verifyIndex, "ZXP build must follow static verification");
  assert.ok(releaseIndex > buildIndex, "release upload must follow the ZXP build");
  assert.match(workflow, /^  pull_request:\r?$/m);
  assert.match(workflow, /^  workflow_dispatch:\r?$/m);
  assert.match(workflow, /^  contents: read\r?$/m);
  const tagPushGuard = "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/')";
  const buildStep = workflow.match(
    /^      - name: Build ZXP\r?\n((?: {8,}.*(?:\r?\n|$))+)/m,
  )?.[0];
  const uploadStep = workflow.match(
    /^      - name: Upload ZXP artifact\r?\n((?: {8,}.*(?:\r?\n|$))+)/m,
  )?.[0];
  const downloadStep = workflow.match(
    /^      - name: Download ZXP artifact\r?\n((?: {8,}.*(?:\r?\n|$))+)/m,
  )?.[0];
  const releaseStep = workflow.match(
    /^      - name: GitHub Release\r?\n((?: {8,}.*(?:\r?\n|$))+)/m,
  )?.[0];
  assert.ok(buildStep, "expected one bounded ZXP build step");
  assert.ok(uploadStep, "expected one bounded ZXP upload step");
  assert.ok(downloadStep, "expected one bounded ZXP download step");
  assert.ok(releaseStep, "expected one bounded GitHub Release step");
  assert.match(buildStep, new RegExp(`^        if: ${tagPushGuard.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\r?$`, "m"));
  assert.match(uploadStep, new RegExp(`^        if: ${tagPushGuard.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\r?$`, "m"));
  assert.match(uploadStep, /^        uses: actions\/upload-artifact@v4\r?$/m);
  assert.match(uploadStep, /^          name: chroma-relay-zxp\r?$/m);
  assert.match(uploadStep, /^          path: "\.\/dist\/zxp\/\*"\r?$/m);
  assert.match(uploadStep, /^          if-no-files-found: error\r?$/m);
  assert.match(downloadStep, /^        uses: actions\/download-artifact@v4\r?$/m);
  assert.match(downloadStep, /^          name: chroma-relay-zxp\r?$/m);
  assert.match(downloadStep, /^          path: \.\/dist\/zxp\r?$/m);
  assert.match(releaseStep, /^        uses: softprops\/action-gh-release@3bb12739c298aeb8a4eeaf626c5b8d85266b0e65 # v2\.6\.2\r?$/m);
  assert.match(releaseStep, /^          files: "\.\/dist\/zxp\/\*"\r?$/m);
  assert.match(
    workflow,
    /^  release:\r?\n    if: github\.event_name == 'push' && startsWith\(github\.ref, 'refs\/tags\/'\)\r?\n    needs: verify\r?$/m,
  );
  assert.match(workflow, /^    permissions:\r?\n      contents: write\r?$/m);
  assert.match(packageJson.scripts.zxp, /vite build --watch false && npm run check:cep$/);
});

test("CEP compatibility scan includes and requires emitted renderer assets", async () => {
  const source = await readText("../scripts/check-cep-compat.mjs");
  assert.match(source, /dist\/cep\/assets/);
  assert.match(source, /scannedRendererFiles/);
  assert.deepEqual(rendererCoverageFailures([]), [
    "dist/cep/assets must contain at least one emitted renderer JavaScript bundle",
  ]);
  assert.deepEqual(rendererCoverageFailures(["main.cjs"]), []);
});

test("CEP compatibility rejects Node globals in the ExtendScript bundle", () => {
  assert.deepEqual(hostCompatibilityFailures("var id = process.env.EXTENSION_ID;"), [
    "dist/cep/jsx/index.js still contains an ES3-incompatible Node process global",
  ]);
  assert.deepEqual(hostCompatibilityFailures('var id = "com.zimoby.chroma-relay";'), []);
});
