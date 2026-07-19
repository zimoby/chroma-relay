import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const contract = JSON.parse(
  await readFile(new URL("../src/shared/product-contract.json", import.meta.url), "utf8")
);
const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8")
);

test("the product contract owns current technical identity and schemas", async () => {
  assert.equal(contract.product.extensionId, "com.zimoby.chroma-relay");
  assert.equal(contract.product.panelIds.main, "com.zimoby.chroma-relay.main");
  assert.equal(contract.product.panelIds.settings, "com.zimoby.chroma-relay.settings");
  assert.equal(contract.schemas.palette, 3);
  assert.equal(contract.schemas.settings, 4);
  assert.equal(contract.schemas.portable, 2);
  assert.equal(contract.marker.lineage, "I11");
  assert.equal(contract.marker.current, "Palette v2");
  assert.deepEqual(
    { lineage: contract.marker.lineage, current: contract.marker.current },
    { lineage: "I11", current: "Palette v2" }
  );
  assert.equal(packageJson.version, "0.0.1");
});

test("runtime and config consumers derive current values from the contract", async () => {
  const sources = await Promise.all(
    [
      "../cep.config.ts",
      "../src/js/shared/debug-api.ts",
      "../src/js/shared/palette-domain.ts",
      "../src/js/shared/layout-settings-domain.ts",
      "../src/js/shared/layout-settings.ts",
      "../src/js/shared/palette-transfer.ts",
      "../src/js/shared/palette-events.ts",
    ].map((path) => readFile(new URL(path, import.meta.url), "utf8"))
  );
  for (const source of sources) assert.match(source, /product-contract\.json/);
  assert.doesNotMatch(sources[1], /Palette v2|I11\s*·/);
  assert.doesNotMatch(sources[4], /com\.zimoby\.palette\.(?:main|settings)/);
  assert.doesNotMatch(sources[5], /PALETTE_TRANSFER_VERSION\s*=\s*2/);
});

test("historical evidence is not rewritten by the current contract", async () => {
  const historical = await readFile(
    new URL("../evidence/final-review/alpha-package-report.json", import.meta.url),
    "utf8"
  );
  assert.match(historical, /I11|0\.0\.1/);
});
