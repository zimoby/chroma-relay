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

const storage = await import("../src/js/shared/palette-storage.ts");
const { DEFAULT_PALETTE, clonePaletteDocument } = await import(
  "../src/js/shared/palette-domain.ts"
);

const makeRoot = async () => mkdtemp(join(tmpdir(), "chroma-relay-storage-"));
const pathsFor = (root: string) => storage.getPalettePaths(root)!;
const writeJson = (filePath: string, value: unknown) =>
  writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");

test("palette inspection is read-only and Main promotion owns recovery", async () => {
  const root = await makeRoot();
  try {
    const paths = pathsFor(root);
    const recovered = clonePaletteDocument(DEFAULT_PALETTE);
    recovered.revision = 4;
    await writeJson(paths.temp, recovered);

    const inspected = storage.inspectPalette(root);
    assert.equal(inspected.recovery, "temp");
    assert.deepEqual(inspected.document, recovered);
    assert.equal(await readFile(paths.temp, "utf8"), `${JSON.stringify(recovered, null, 2)}\n`);
    assert.equal(storage.inspectPalette(root).recovery, "temp");
    assert.equal((await readdir(root)).includes("palette.json"), false);

    const promoted = storage.loadPalette(root);
    assert.equal(promoted.recovery, "temp");
    assert.equal(promoted.error, null);
    assert.deepEqual(promoted.document, recovered);
    assert.deepEqual(JSON.parse(await readFile(paths.final, "utf8")), recovered);
    assert.equal((await readdir(root)).includes("palette.json.tmp"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("palette recovery preserves invalid primary, interrupted candidates, and residue", async () => {
  const root = await makeRoot();
  try {
    const paths = pathsFor(root);
    const recovered = clonePaletteDocument(DEFAULT_PALETTE);
    recovered.revision = 9;
    const backup = clonePaletteDocument(DEFAULT_PALETTE);
    backup.revision = 8;
    await writeFile(paths.final, "not-json\n", "utf8");
    await writeJson(paths.temp, recovered);
    await writeJson(paths.backup, backup);

    const loaded = storage.loadPalette(root);
    assert.equal(loaded.recovery, "temp");
    assert.equal(loaded.error, null);
    assert.deepEqual(loaded.document, recovered);
    assert.deepEqual(JSON.parse(await readFile(paths.final, "utf8")), recovered);
    assert.deepEqual(JSON.parse(await readFile(paths.backup, "utf8")), backup);
    const residue = (await readdir(root)).filter((name) => name.startsWith("palette.json.invalid"));
    assert.equal(residue.length, 1);
    assert.equal(await readFile(join(root, residue[0]), "utf8"), "not-json\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("palette promotion reports failure and rolls an invalid primary back into place", async () => {
  const root = await makeRoot();
  try {
    const paths = pathsFor(root);
    const recovered = clonePaletteDocument(DEFAULT_PALETTE);
    recovered.revision = 3;
    await writeFile(paths.final, "invalid-primary\n", "utf8");
    await writeJson(paths.temp, recovered);
    const realFs = nodeRequire("node:fs");
    const io = {
      ...realFs,
      renameSync(from: string, to: string) {
        if (from === paths.temp && to === paths.final) {
          throw new Error("replacement interrupted");
        }
        return realFs.renameSync(from, to);
      },
    };

    const loaded = storage.loadPalette(root, io);
    assert.equal(loaded.recovery, "temp");
    assert.match(loaded.error ?? "", /promot|replacement|interrupted/i);
    assert.equal(await readFile(paths.final, "utf8"), "invalid-primary\n");
    assert.equal(await readFile(paths.temp, "utf8"), `${JSON.stringify(recovered, null, 2)}\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("queued palette writes converge to the last document without temporary residue", async () => {
  const root = await makeRoot();
  try {
    const first = clonePaletteDocument(DEFAULT_PALETTE);
    first.revision = 1;
    const second = clonePaletteDocument(DEFAULT_PALETTE);
    second.revision = 2;
    await Promise.all([storage.savePalette(first, root), storage.savePalette(second, root)]);
    const paths = pathsFor(root);
    assert.deepEqual(JSON.parse(await readFile(paths.final, "utf8")), second);
    assert.equal((await readdir(root)).includes("palette.json.tmp"), false);
    assert.equal((await readdir(root)).includes("palette.json.bak"), false);
  } finally {
    await storage.waitForPaletteWrites();
    await rm(root, { recursive: true, force: true });
  }
});

test("unknown palette completion converges by inspection and never creates a resend", async () => {
  const root = await makeRoot();
  try {
    const paths = pathsFor(root);
    const authoritative = clonePaletteDocument(DEFAULT_PALETTE);
    authoritative.revision = 12;
    await writeJson(paths.final, authoritative);
    const settled = storage.inspectPaletteAfterUnknownCommand(root);
    assert.deepEqual(settled.document, authoritative);
    assert.match(settled.message, /completion is unknown/i);
    assert.equal(settled.recovery, "none");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("savePalette rejects an invalid primary and preserves its original bytes", async () => {
  const root = await makeRoot();
  try {
    const paths = pathsFor(root);
    const next = clonePaletteDocument(DEFAULT_PALETTE);
    next.revision = 20;
    await writeFile(paths.final, "invalid-primary-that-must-not-be-quarantined\n", "utf8");
    const interruptedTemp = clonePaletteDocument(DEFAULT_PALETTE);
    interruptedTemp.revision = 18;
    const interruptedBackup = clonePaletteDocument(DEFAULT_PALETTE);
    interruptedBackup.revision = 19;
    const tempBytes = `${JSON.stringify(interruptedTemp, null, 2)}\n`;
    const backupBytes = `${JSON.stringify(interruptedBackup, null, 2)}\n`;
    await writeFile(paths.temp, tempBytes, "utf8");
    await writeFile(paths.backup, backupBytes, "utf8");

    await assert.rejects(
      storage.savePalette(next, root),
      /Refusing to replace an invalid saved palette/
    );
    assert.equal(
      await readFile(paths.final, "utf8"),
      "invalid-primary-that-must-not-be-quarantined\n"
    );
    assert.equal(await readFile(paths.temp, "utf8"), tempBytes);
    assert.equal(await readFile(paths.backup, "utf8"), backupBytes);
    assert.equal((await readdir(root)).some((name) => name.startsWith("palette.json.invalid")), false);
  } finally {
    await storage.waitForPaletteWrites();
    await rm(root, { recursive: true, force: true });
  }
});

test("palette promotion reparses the current candidate and returns the verified document", async () => {
  const root = await makeRoot();
  try {
    const paths = pathsFor(root);
    const inspectedDocument = clonePaletteDocument(DEFAULT_PALETTE);
    inspectedDocument.revision = 21;
    const currentCandidate = clonePaletteDocument(DEFAULT_PALETTE);
    currentCandidate.revision = 22;
    await writeJson(paths.temp, inspectedDocument);

    const inspected = storage.inspectPalette(root);
    await writeJson(paths.temp, currentCandidate);
    const promoted = storage.promotePaletteRecovery(root, inspected);

    assert.equal(promoted.error, null);
    assert.equal(promoted.recovery, "temp");
    assert.deepEqual(promoted.document, currentCandidate);
    assert.deepEqual(JSON.parse(await readFile(paths.final, "utf8")), currentCandidate);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("palette promotion does not overwrite a valid final that wins the race", async () => {
  const root = await makeRoot();
  try {
    const paths = pathsFor(root);
    const candidate = clonePaletteDocument(DEFAULT_PALETTE);
    candidate.revision = 23;
    const winningFinal = clonePaletteDocument(DEFAULT_PALETTE);
    winningFinal.revision = 24;
    await writeJson(paths.temp, candidate);
    const inspected = storage.inspectPalette(root);
    await writeJson(paths.final, winningFinal);

    const promoted = storage.promotePaletteRecovery(root, inspected);

    assert.equal(promoted.error, null);
    assert.equal(promoted.recovery, "none");
    assert.deepEqual(promoted.document, winningFinal);
    assert.deepEqual(JSON.parse(await readFile(paths.final, "utf8")), winningFinal);
    assert.deepEqual(JSON.parse(await readFile(paths.temp, "utf8")), candidate);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Settings production timeout settles visible inspection errors once and never resends", async () => {
  const root = await makeRoot();
  try {
    const paths = pathsFor(root);
    await writeFile(paths.final, "invalid-primary-for-timeout\n", "utf8");
    const timers: Array<{ callback: () => void; delayMs: number }> = [];
    const requestId = "settings-timeout-request";
    let pending: string | null = null;
    const dispatched: string[] = [];
    const setPending = (next: string) => {
      pending = next;
    };
    assert.equal(
      storage.beginPaletteCommandRequest(
        requestId,
        () => pending,
        setPending,
        () => dispatched.push(requestId)
      ),
      true
    );
    assert.equal(dispatched.length, 1);
    assert.equal(pending, requestId);

    let clearCount = 0;
    let settledDocument = null;
    let settledError: string | null = null;
    let settledStatus = "";
    storage.scheduleSettingsPaletteCommandTimeout({
      requestId,
      isCurrentRequest: (currentRequestId) => pending === currentRequestId,
      temporaryRoot: root,
      clearPending: () => {
        clearCount += 1;
        pending = null;
      },
      setDocument: (document) => {
        settledDocument = document;
      },
      setError: (error) => {
        settledError = error;
      },
      setStatus: (status) => {
        settledStatus = status;
      },
      schedule: (callback, delayMs) => {
        timers.push({ callback, delayMs });
        return timers.length;
      },
      delayMs: 3500,
    });
    assert.equal(timers[0].delayMs, 3500);
    timers[0].callback();

    assert.ok(settledDocument);
    assert.equal(clearCount, 1);
    assert.equal(pending, null);
    assert.equal(dispatched.length, 1);
    const visibleStatus = storage.combinePaletteStatus(settledStatus, settledError);
    assert.match(visibleStatus, /completion is unknown/i);
    assert.match(visibleStatus, /invalid|preserved/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
