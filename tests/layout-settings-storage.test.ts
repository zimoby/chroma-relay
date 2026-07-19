import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const nodeRequire = createRequire(import.meta.url);
(globalThis as any).require = nodeRequire;
(globalThis as any).window = {
  cep: {},
  __adobe_cep__: {
    getApplicationID: () => "test-app",
    getExtensionID: () => "test-extension",
    getHostEnvironment: () => JSON.stringify({ appVersion: "25.6.0" }),
  },
};
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { appVersion: "Macintosh" },
});

const settingsModule = await import("../src/js/shared/layout-settings.ts");
const { DEFAULT_LAYOUT_SETTINGS } = settingsModule;

const makeRoot = async () => mkdtemp(join(tmpdir(), "chroma-relay-layout-"));
const pathsFor = (root: string) => settingsModule.getLayoutSettingsPaths(root)!;
const writeJson = (filePath: string, value: unknown) =>
  writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");

test("layout recovery reads valid temp or backup content without load-time writes", async () => {
  const root = await makeRoot();
  try {
    const paths = pathsFor(root);
    const tempSettings = { ...DEFAULT_LAYOUT_SETTINGS, revision: 6, layoutMode: "fixed" as const };
    const backupSettings = { ...DEFAULT_LAYOUT_SETTINGS, revision: 5, layoutMode: "stretch" as const };
    await writeJson(paths.temp, tempSettings);
    await writeJson(paths.backup, backupSettings);
    const writes: string[] = [];
    const realFs = nodeRequire("node:fs");
    const io = {
      ...realFs,
      mkdirSync() {
        writes.push("mkdir");
      },
      renameSync() {
        writes.push("rename");
      },
      unlinkSync() {
        writes.push("unlink");
      },
      writeFileSync() {
        writes.push("write");
      },
    };
    const loaded = settingsModule.loadLayoutSettings(root, io);
    assert.deepEqual(loaded.settings, tempSettings);
    assert.equal(loaded.error, null);
    assert.deepEqual(writes, []);
    assert.equal((await readdir(root)).includes("settings.json.tmp"), true);
    assert.equal((await readdir(root)).includes("settings.json.bak"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("layout recovery preserves invalid primary and valid backup candidates", async () => {
  const root = await makeRoot();
  try {
    const paths = pathsFor(root);
    const backupSettings = { ...DEFAULT_LAYOUT_SETTINGS, revision: 7 };
    await writeFile(paths.final, "invalid-settings\n", "utf8");
    await writeJson(paths.temp, { invalid: true });
    await writeJson(paths.backup, backupSettings);

    const loaded = settingsModule.loadLayoutSettings(root);
    assert.deepEqual(loaded.settings, backupSettings);
    assert.match(loaded.error ?? "", /recovery|invalid|preserved/i);
    assert.equal(await readFile(paths.final, "utf8"), "invalid-settings\n");
    assert.deepEqual(JSON.parse(await readFile(paths.backup, "utf8")), backupSettings);
    assert.equal((await readdir(root)).includes("settings.json.tmp"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("settings writer quarantines invalid primary and cleans only its own successful residue", async () => {
  const root = await makeRoot();
  try {
    const paths = pathsFor(root);
    const next = { ...DEFAULT_LAYOUT_SETTINGS, revision: 10, swatchSize: 48 };
    await writeFile(paths.final, "invalid-settings\n", "utf8");
    await settingsModule.saveLayoutSettings(next, root);
    assert.deepEqual(JSON.parse(await readFile(paths.final, "utf8")), next);
    assert.equal((await readdir(root)).includes("settings.json.tmp"), false);
    assert.equal((await readdir(root)).includes("settings.json.bak"), false);
    const residue = (await readdir(root)).filter((name) => name.startsWith("settings.json.invalid"));
    assert.equal(residue.length, 1);
    assert.equal(await readFile(join(root, residue[0]), "utf8"), "invalid-settings\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
