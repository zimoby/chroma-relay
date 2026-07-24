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
