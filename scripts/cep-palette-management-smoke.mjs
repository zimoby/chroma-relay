import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CdpClient } from "./lib/cdp-client.mjs";
import {
  createOwnedRunDirectory,
  createOwnedScratchDirectory,
  parseRunnerArgs,
  removeOwnedRunDirectory,
} from "./lib/live-runner-policy.mjs";
import contract from "../src/shared/product-contract.json" with { type: "json" };
import packageJson from "../package.json" with { type: "json" };

const EXPECTED_BUILD_MARKER = `${contract.marker.current} · ${packageJson.version}`;
const REDESIGN_EVIDENCE_DIRECTORY = resolve("evidence/local/settings-ui-deep-redesign");
const PORTS = { main: 8198, settings: 8199 };
const EDITED_RGBA = [51 / 255, 102 / 255, 153 / 255, 128 / 255];
const ADDED_COLOR_RGBA = [195 / 255, 40 / 255, 40 / 255, 1];
const HDR_RGBA = [1.25, -0.1, 0.5000004, 0.875];
const IMPORT_SECOND_RGBA = [0, 0.5, 1, 0.25];
const EXPORT_COLLISION_SENTINEL = "existing export must remain untouched\n";
const LEGACY_PALETTE_SCHEMA_VERSION = 2;

const pathsFor = (temporaryRoot) => {
  const exportPath = resolve(temporaryRoot, "exported.chroma-relay.json");
  const collisionBasePath = resolve(temporaryRoot, "existing-export");
  return {
    temporaryRoot,
    palettePath: resolve(temporaryRoot, "palette.json"),
    exportPath,
    collisionBasePath,
    collisionPath: `${collisionBasePath}.json`,
    importFixturePath: resolve(temporaryRoot, "import-fixture.chroma-relay.json"),
  };
};

const connectPanel = async (page, register = () => {}) => {
  const response = await fetch(`http://127.0.0.1:${PORTS[page]}/json/list`);
  if (!response.ok) throw new Error(`${page}: target list returned ${response.status}`);
  const targets = await response.json();
  const suffix = `/${page}/index.html`;
  const matches = targets.filter(
    (target) => target.type === "page" && new URL(target.url).pathname.endsWith(suffix)
  );
  assert.equal(matches.length, 1, `${page}: expected one exact target`);
  const client = new CdpClient(matches[0].webSocketDebuggerUrl);
  client.page = page;
  register(client);
  await client.connect();
  return client;
};

const serializeError = (error, ancestors = new Set()) => {
  if (error === null || (typeof error !== "object" && typeof error !== "function")) {
    return { name: typeof error, message: String(error), value: error };
  }
  if (ancestors.has(error)) {
    return {
      name: error.name || error.constructor?.name || "Error",
      message: error.message || String(error),
      circular: true,
    };
  }

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(error);
  const diagnostic = {
    name: error.name || error.constructor?.name || "Error",
    message: typeof error.message === "string" ? error.message : String(error),
  };
  if (typeof error.stack === "string") diagnostic.stack = error.stack;
  if ("cause" in error) diagnostic.cause = serializeError(error.cause, nextAncestors);
  if (Array.isArray(error.errors)) {
    diagnostic.errors = error.errors.map((cause) => serializeError(cause, nextAncestors));
  }
  for (const key of Object.keys(error)) {
    if (key === "cause" || key === "errors") continue;
    diagnostic[key] = error[key];
  }
  return diagnostic;
};

const wait = (milliseconds) => new Promise((pass) => setTimeout(pass, milliseconds));
const settle = (client) =>
  client.evaluate(
    "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))"
  );

const waitForDebug = async (client) => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await client.evaluate("Boolean(window.__CHROMA_RELAY_DEBUG__)")) return;
    await wait(100);
  }
  throw new Error(`${client.page}: debug API did not become ready`);
};

const state = (client) => client.evaluate("window.__CHROMA_RELAY_DEBUG__.getState()");
const counters = (client) =>
  client.evaluate("window.__CHROMA_RELAY_DEBUG__.getCounters()");
const callDebug = (client, body) =>
  client.evaluate(`((api) => { ${body} })(window.__CHROMA_RELAY_DEBUG__)`);

const waitForRevision = async (clients, revision, label) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const snapshots = await Promise.all(clients.map(state));
    if (
      snapshots.every(
        (snapshot) =>
          snapshot.paletteRevision === revision && snapshot.pendingRequestId == null
      )
    ) {
      return snapshots;
    }
    await wait(100);
  }
  throw new Error(`${label}: panels did not converge on revision ${revision}`);
};

const click = async (client, testId) => {
  const clicked = await client.evaluate(
    `window.__CHROMA_RELAY_DEBUG__.dispatchClick(${JSON.stringify(testId)})`
  );
  assert.equal(clicked, true, `${client.page}: ${testId} should be clickable`);
};

const setInputValue = async (client, testId, value, { commit = true } = {}) => {
  const focused = await client.evaluate(`(() => {
    const input = document.querySelector('[data-testid="${testId}"]');
    if (!(input instanceof HTMLInputElement)) return false;
    input.focus();
    input.select();
    return true;
  })()`);
  assert.equal(focused, true, `${testId}: input should exist`);
  await client.send("Input.insertText", { text: value });
  await settle(client);
  if (!commit) return;
  await client.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  await client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
};

const setSelectValue = async (client, testId, value) => {
  const changed = await client.evaluate(`(() => {
    const select = document.querySelector('[data-testid="${testId}"]');
    if (!(select instanceof HTMLSelectElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
    setter.call(select, ${JSON.stringify(value)});
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
  assert.equal(changed, true, `${testId}: select should accept ${value}`);
};

// HTML5 drag semantics against the real Settings UI. Each phase runs in its
// own evaluate so React state committed by the previous phase is observable.
const dragPhase = async (client, body) => {
  const result = await client.evaluate(`(() => {
    const fire = (element, type, x, y) =>
      element.dispatchEvent(
        new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          dataTransfer: window.__cpSmokeDataTransfer,
        })
      );
    ${body}
  })()`);
  assert.equal(result, "ok", `drag phase should succeed: ${result}`);
  await settle(client);
};

const startColorDrag = (client, sourceId) =>
  dragPhase(
    client,
    `const grip = document.querySelector('[data-testid="color-grip-${sourceId}"]');
    if (!grip) return "missing grip ${sourceId}";
    window.__cpSmokeDataTransfer = new DataTransfer();
    const bounds = grip.getBoundingClientRect();
    fire(grip, "dragstart", bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
    return "ok";`
  );

const dragOverColor = (client, targetId, edge) =>
  dragPhase(
    client,
    `const row = document.querySelector('[data-testid="color-row-${targetId}"]');
    const line = row ? row.querySelector(".managed-color-line") : null;
    if (!line) return "missing row ${targetId}";
    const bounds = line.getBoundingClientRect();
    const y = ${edge === "after" ? "bounds.bottom - 3" : "bounds.top + 3"};
    fire(line, "dragover", bounds.left + bounds.width / 2, y);
    return "ok";`
  );

const dropOnColor = (client, targetId) =>
  dragPhase(
    client,
    `const row = document.querySelector('[data-testid="color-row-${targetId}"]');
    const line = row ? row.querySelector(".managed-color-line") : null;
    if (!line) return "missing row ${targetId}";
    const bounds = line.getBoundingClientRect();
    fire(line, "drop", bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
    return "ok";`
  );

const endColorDrag = (client, sourceId) =>
  dragPhase(
    client,
    `const grip = document.querySelector('[data-testid="color-grip-${sourceId}"]');
    if (!grip) return "missing grip ${sourceId}";
    const bounds = grip.getBoundingClientRect();
    fire(grip, "dragend", bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
    delete window.__cpSmokeDataTransfer;
    return "ok";`
  );

const assertTemporaryRoots = async (clients, temporaryRoot) => {
  const identities = await Promise.all(
    clients.map((client) => callDebug(client, "return api.getIdentity();"))
  );
  for (const identity of identities) {
    assert.equal(
      identity.configRoot,
      temporaryRoot,
      `${identity.page}: refusing palette command outside temporary root`
    );
  }
};

const readPaletteFile = async (palettePath) => JSON.parse(await readFile(palettePath, "utf8"));

const waitFor = async (predicate, label) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await predicate()) return;
    await wait(100);
  }
  throw new Error(`${label}: condition was not met`);
};

// Stub only the two native dialog methods; the button handlers, Node file
// system, pure parser, command event, and Main persistence stay real.
const installDialogStubs = (client) =>
  client.evaluate(`(() => {
    const cepFs = window.cep.fs;
    if (!window.__cpSmokeDialogOriginals) {
      window.__cpSmokeDialogOriginals = {
        showOpenDialogEx: cepFs.showOpenDialogEx,
        showSaveDialogEx: cepFs.showSaveDialogEx,
      };
    }
    window.__cpSmokeNextOpen = null;
    window.__cpSmokeNextSave = null;
    cepFs.showOpenDialogEx = () => ({
      err: 0,
      data: window.__cpSmokeNextOpen === null ? [] : [window.__cpSmokeNextOpen],
    });
    cepFs.showSaveDialogEx = () => ({
      err: 0,
      data: window.__cpSmokeNextSave === null ? "" : window.__cpSmokeNextSave,
    });
    return true;
  })()`);

const restoreDialogStubs = (client) =>
  client.evaluate(`(() => {
    const originals = window.__cpSmokeDialogOriginals;
    if (originals) {
      window.cep.fs.showOpenDialogEx = originals.showOpenDialogEx;
      window.cep.fs.showSaveDialogEx = originals.showSaveDialogEx;
    }
    delete window.__cpSmokeDialogOriginals;
    delete window.__cpSmokeNextOpen;
    delete window.__cpSmokeNextSave;
    return true;
  })()`);

const setNextDialogPaths = (client, { open = null, save = null }) =>
  client.evaluate(`(() => {
    window.__cpSmokeNextOpen = ${JSON.stringify(open)};
    window.__cpSmokeNextSave = ${JSON.stringify(save)};
    return true;
  })()`);

const screenshot = async (client, name, outputDirectory) => {
  const result = await client.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
  });
  await writeFile(resolve(outputDirectory, name), Buffer.from(result.data, "base64"));
};

const initialDocument = {
  // Explicit legacy input fixture; runtime persistence must use contract.schemas.palette.
  schemaVersion: LEGACY_PALETTE_SCHEMA_VERSION,
  revision: 0,
  activePaletteId: "palette-default",
  palettes: [
    {
      id: "palette-default",
      name: "Palette 1",
      colors: [
        { id: "a", rgba: [0.9, 0.2, 0.1, 1] },
        { id: "b", rgba: [0.1, 0.8, 0.3, 0.75] },
        { id: "c", rgba: [0.2, 0.35, 0.95, 0.5] },
      ],
    },
  ],
};

export const runPaletteManagementLifecycle = async ({
  acquireClient,
  execute,
  cleanupClient,
  cleanupScratch,
  writeFailure,
}) => {
  const clients = [];
  const registerClient = (client, page) => {
    if (client) {
      client.page = page;
      if (!clients.includes(client)) clients.push(client);
    }
    return client;
  };
  let result;
  let primaryError = null;
  const cleanupErrors = [];

  try {
    const acquire = (page) =>
      acquireClient(page, (client) => registerClient(client, page));
    const main = await acquire("main");
    const settings = await acquire("settings");
    result = await execute({ main, settings, clients });
  } catch (error) {
    primaryError = error;
  } finally {
    for (const client of [...clients].reverse()) {
      try {
        await cleanupClient(client);
      } catch (error) {
        cleanupErrors.push({
          phase: `close:${client.page || "panel"}`,
          page: client.page || "panel",
          error: serializeError(error),
          cause: error,
        });
      }
    }
    try {
      await cleanupScratch({ primaryError, cleanupErrors });
    } catch (error) {
      cleanupErrors.push({
        phase: "scratch",
        error: serializeError(error),
        cause: error,
      });
    }
  }

  if (primaryError || cleanupErrors.length > 0) {
    const failure = { primaryError, cleanupErrors, clients };
    try {
      await writeFailure(failure);
    } catch (error) {
      cleanupErrors.push({
        phase: "failure-evidence",
        error: serializeError(error),
        cause: error,
      });
      if (primaryError && (typeof primaryError === "object" || typeof primaryError === "function")) {
        try {
          primaryError.cleanupErrors = cleanupErrors;
        } catch {
          // Preserve the exact primary even when it cannot accept diagnostics.
        }
      }
    }
    if (primaryError) throw primaryError;
    throw new AggregateError(
      cleanupErrors.map(({ cause, error }) => cause || new Error(error.message)),
      "Palette management cleanup failed"
    );
  }
  return result;
};

const run = async (outputDirectory, parentRun) => {
  const scratch = await createOwnedScratchDirectory(parentRun);
  const paths = pathsFor(scratch.path);
  await mkdir(outputDirectory, { recursive: true });
  await mkdir(REDESIGN_EVIDENCE_DIRECTORY, { recursive: true });
  await writeFile(paths.palettePath, `${JSON.stringify(initialDocument, null, 2)}\n`);

  let passed = false;
  return runPaletteManagementLifecycle({
    acquireClient: (page, register) => connectPanel(page, register),
    execute: async ({ main, settings, clients }) => {
    await Promise.all(clients.map((client) => client.send("Runtime.enable")));
    await Promise.all(
      clients.map((client) => client.send("Page.reload", { ignoreCache: true }))
    );
    await wait(500);
    await Promise.all(clients.map(waitForDebug));

    for (const client of clients) {
      const identity = await callDebug(client, "return api.getIdentity();");
      assert.equal(identity.page, client.page);
      assert.equal(identity.buildMarker, EXPECTED_BUILD_MARKER);
      await callDebug(client, "api.resetTestState(); return true;");
    }
    await Promise.all(clients.map(settle));
    for (const client of clients) {
      await callDebug(
        client,
        `return api.setTemporaryConfigRoot(${JSON.stringify(paths.temporaryRoot)});`
      );
    }
    await Promise.all(clients.map(settle));
    let snapshots = await waitForRevision(clients, 0, "temporary-root load");
    assert.deepEqual(snapshots.map((snapshot) => snapshot.palette.map((color) => color.id)), [
      ["a", "b", "c"],
      ["a", "b", "c"],
    ]);
    await assertTemporaryRoots(clients, paths.temporaryRoot);

    await settings.send("Emulation.setDeviceMetricsOverride", {
      width: 320,
      height: 360,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await settle(settings);

    await click(settings, "settings-tab-palettes");
    await click(settings, "palette-create");
    snapshots = await waitForRevision(clients, 1, "create palette");
    assert.equal(snapshots[0].palettes.length, 2);
    assert.equal(snapshots[0].activePalette.id, "palette-1");
    assert.deepEqual(snapshots[0].palette, []);

    const emptyStripExists = await settings.evaluate(
      `Boolean(document.querySelector(".palette-strip-preview"))`
    );
    assert.equal(emptyStripExists, false, "an empty palette must not render the strip preview");
    const emptyMessage = await settings.evaluate(
      `document.querySelector(".palette-empty")?.textContent.trim()`
    );
    assert.equal(emptyMessage, "Add a color here or collect from the Main panel.");
    await screenshot(settings, "empty-palette.png", outputDirectory);
    await copyFile(
      resolve(outputDirectory, "empty-palette.png"),
      resolve(REDESIGN_EVIDENCE_DIRECTORY, "empty-palette-add-color-320x360.png")
    );

    const preAddColorCounters = await counters(main);
    await click(settings, "color-add");
    snapshots = await waitForRevision(clients, 2, "add default black color");
    assert.equal(snapshots[0].palette.length, 1);
    assert.equal(snapshots[0].palette[0].id, "color-2-1");
    assert.deepEqual(snapshots[0].palette[0].rgba, [0, 0, 0, 1]);
    assert.equal((await counters(main)).diskWrites, preAddColorCounters.diskWrites + 1);
    let settingsState = await state(settings);
    assert.equal(
      settingsState.expandedColorId,
      "color-2-1",
      "new color editor should open automatically"
    );
    assert.equal(
      await settings.evaluate(`Boolean(document.querySelector(".palette-strip-preview"))`),
      true,
      "the strip preview should return after adding a color"
    );
    await screenshot(settings, "added-black-color.png", outputDirectory);
    await copyFile(
      resolve(outputDirectory, "added-black-color.png"),
      resolve(REDESIGN_EVIDENCE_DIRECTORY, "added-black-color-editor-320x360.png")
    );

    await setInputValue(settings, "color-field-hex", "#C32828");
    snapshots = await waitForRevision(clients, 3, "edit newly added color");
    assert.deepEqual(snapshots[0].palette[0].rgba, ADDED_COLOR_RGBA);

    await setInputValue(settings, "palette-name", "Project Warm");
    snapshots = await waitForRevision(clients, 4, "rename palette");
    assert.equal(snapshots[0].activePalette.name, "Project Warm");
    assert.equal(snapshots[1].activePalette.name, "Project Warm");

    await setSelectValue(settings, "palette-select", "palette-default");
    snapshots = await waitForRevision(clients, 5, "select default palette");
    assert.equal(snapshots[0].activePalette.id, "palette-default");
    assert.deepEqual(snapshots[0].palette.map((color) => color.id), ["a", "b", "c"]);

    // Cancelled drag: dragstart + dragover + dragend without a drop must not
    // dispatch a command or write.
    const preDragCounters = await counters(main);
    await startColorDrag(settings, "a");
    await dragOverColor(settings, "b", "after");
    settingsState = await state(settings);
    assert.deepEqual(
      settingsState.colorDrag,
      { sourceId: "a", targetId: "b", edge: "after" },
      "dragover should arm the after-edge drop indicator"
    );
    await endColorDrag(settings, "a");
    await wait(300);
    settingsState = await state(settings);
    assert.equal(settingsState.colorDrag, null, "cancelled drag should clear drag state");
    assert.equal(settingsState.paletteRevision, 5, "cancelled drag must not change revision");
    assert.equal((await counters(main)).diskWrites, preDragCounters.diskWrites);

    // Real grip drag: move color a below color b via the after edge.
    await startColorDrag(settings, "a");
    await dragOverColor(settings, "b", "after");
    await dropOnColor(settings, "b");
    await endColorDrag(settings, "a");
    snapshots = await waitForRevision(clients, 6, "drag reorder color");
    assert.deepEqual(snapshots[0].palette.map((color) => color.id), ["b", "a", "c"]);
    assert.deepEqual(snapshots[1].palette.map((color) => color.id), ["b", "a", "c"]);

    // Expanding an editor, switching formats, and an invalid commit are all
    // read-only: no revision change and no disk write.
    await click(settings, "color-summary-a");
    await settle(settings);
    settingsState = await state(settings);
    assert.equal(settingsState.expandedColorId, "a", "summary click should expand the editor");
    await click(settings, "color-format-rgb");
    await click(settings, "color-format-cmyk");
    await click(settings, "color-format-hex");
    await settle(settings);
    const preEditCounters = await counters(main);
    const preEditSettingsCounters = await counters(settings);
    assert.equal((await readPaletteFile(paths.palettePath)).revision, 6, "format switching must not write");

    await setInputValue(settings, "color-field-hex", "not-a-color");
    await settle(settings);
    settingsState = await state(settings);
    assert.equal(settingsState.editorError, "Hex uses #RRGGBB or #RRGGBBAA");
    assert.equal(settingsState.paletteRevision, 6, "invalid hex must not dispatch");
    const invalidMarked = await settings.evaluate(
      `document.querySelector('[data-testid="color-field-hex"]').getAttribute("aria-invalid")`
    );
    assert.equal(invalidMarked, "true", "invalid hex field should carry aria-invalid");
    assert.equal(
      (await counters(settings)).emittedEvents,
      preEditSettingsCounters.emittedEvents,
      "invalid commit must not emit a command"
    );

    await setInputValue(settings, "color-field-hex", "#33669980");
    snapshots = await waitForRevision(clients, 7, "hex update-color");
    const editedMain = snapshots[0].palette.find((color) => color.id === "a");
    assert.deepEqual(editedMain.rgba, EDITED_RGBA, "Main should hold the exact fractions");
    assert.equal((await counters(main)).diskWrites, preEditCounters.diskWrites + 1);
    let paletteFile = await readPaletteFile(paths.palettePath);
    assert.deepEqual(
      paletteFile.palettes[0].colors.map((color) => color.id),
      ["b", "a", "c"]
    );
    assert.deepEqual(
      paletteFile.palettes[0].colors[1].rgba,
      EDITED_RGBA,
      "palette.json must contain byte/255 exact fractions"
    );
    await wait(2600); // let the transient status clear for a truthful capture
    await screenshot(settings, "expanded-editor.png", outputDirectory);
    await copyFile(
      resolve(outputDirectory, "expanded-editor.png"),
      resolve(REDESIGN_EVIDENCE_DIRECTORY, "live-edit-expanded-320x360.png")
    );

    await click(settings, "color-remove-b");
    snapshots = await waitForRevision(clients, 8, "remove color");
    assert.deepEqual(snapshots[0].palette.map((color) => color.id), ["a", "c"]);
    assert.deepEqual(snapshots[1].palette.map((color) => color.id), ["a", "c"]);

    await setSelectValue(settings, "palette-select", "palette-1");
    snapshots = await waitForRevision(clients, 9, "select second palette");
    assert.equal(snapshots[0].activePalette.name, "Project Warm");

    await click(settings, "palette-delete");
    await settle(settings);
    settingsState = await state(settings);
    assert.equal(settingsState.paletteRevision, 9, "first delete click must only arm deletion");
    assert.equal(settingsState.armedDeleteId, "palette-1");
    const confirmLabel = await settings.evaluate(
      "document.querySelector('[data-testid=\"palette-delete-confirm\"]')?.textContent.trim()"
    );
    assert.equal(confirmLabel, "Delete");
    await screenshot(settings, "armed-delete.png", outputDirectory);
    await copyFile(
      resolve(outputDirectory, "armed-delete.png"),
      resolve(REDESIGN_EVIDENCE_DIRECTORY, "armed-delete-320x360.png")
    );
    await click(settings, "palette-delete-confirm");
    snapshots = await waitForRevision(clients, 10, "delete palette");
    assert.equal(snapshots[0].palettes.length, 1);
    assert.equal(snapshots[0].activePalette.id, "palette-default");

    paletteFile = await readPaletteFile(paths.palettePath);
    assert.equal(paletteFile.schemaVersion, contract.schemas.palette);
    assert.equal(paletteFile.revision, 10);
    assert.equal(paletteFile.palettes.length, 1);
    assert.deepEqual(paletteFile.palettes[0].colors.map((color) => color.id), ["a", "c"]);
    assert.deepEqual(paletteFile.palettes[0].colors[0].rgba, EDITED_RGBA);
    assert.deepEqual(paletteFile.palettes[0].colors[1].rgba, [0.2, 0.35, 0.95, 0.5]);

    // --- Import/Export through the real toolbar buttons with stubbed dialogs ---
    await installDialogStubs(settings);
    await writeFile(
      paths.importFixturePath,
      `${JSON.stringify(
        {
          format: "chroma-relay",
          version: 1,
          name: "Palette 1",
          colors: [{ rgba: HDR_RGBA }, { rgba: IMPORT_SECOND_RGBA }],
        },
        null,
        2
      )}\n`
    );

    // Cancelled dialogs are strict no-ops: no command, no write, no revision.
    const preTransferCounters = {
      main: await counters(main),
      settings: await counters(settings),
    };
    await click(settings, "palette-export");
    await click(settings, "palette-import");
    await wait(300);
    settingsState = await state(settings);
    assert.equal(settingsState.paletteRevision, 10, "cancelled dialogs must not change revision");
    assert.equal(existsSync(paths.exportPath), false, "cancelled export must not write a file");
    assert.deepEqual(await counters(main), preTransferCounters.main);
    assert.deepEqual(await counters(settings), preTransferCounters.settings);

    // Real export of the active palette: exact portable JSON, no palette.json
    // revision, write, or event change.
    await setNextDialogPaths(settings, { save: paths.exportPath });
    await click(settings, "palette-export");
    await waitFor(async () => existsSync(paths.exportPath), "export file");
    const exportedText = await readFile(paths.exportPath, "utf8");
    const expectedExport = `${JSON.stringify(
      {
        format: "chroma-relay",
        version: contract.schemas.portable,
        name: "Palette 1",
        items: [{ rgba: EDITED_RGBA }, { rgba: [0.2, 0.35, 0.95, 0.5] }],
      },
      null,
      2
    )}\n`;
    assert.equal(exportedText, expectedExport, "export must be the exact portable payload");
    const exportedPayload = JSON.parse(exportedText);
    assert.deepEqual(Object.keys(exportedPayload), ["format", "version", "name", "items"]);
    for (const color of exportedPayload.items) {
      assert.deepEqual(Object.keys(color), ["rgba"], "no internal color IDs in exports");
    }
    assert.equal((await readPaletteFile(paths.palettePath)).revision, 10, "export must not touch palette.json");
    assert.equal((await counters(main)).diskWrites, 10, "export must not write via Main");
    assert.deepEqual(
      await counters(settings),
      preTransferCounters.settings,
      "export must not dispatch palette commands or count panel writes"
    );

    // If the user removes .json in the native dialog, appending it must not
    // overwrite a different existing file that the dialog never confirmed.
    await writeFile(paths.collisionPath, EXPORT_COLLISION_SENTINEL);
    const preCollisionCounters = {
      main: await counters(main),
      settings: await counters(settings),
    };
    await setNextDialogPaths(settings, { save: paths.collisionBasePath });
    await click(settings, "palette-export");
    await wait(300);
    assert.equal(
      await readFile(paths.collisionPath, "utf8"),
      EXPORT_COLLISION_SENTINEL,
      "extension append must not overwrite an unconfirmed existing .json file"
    );
    assert.equal(existsSync(paths.collisionBasePath), false);
    assert.equal((await readPaletteFile(paths.palettePath)).revision, 10);
    assert.deepEqual(await counters(main), preCollisionCounters.main);
    assert.deepEqual(await counters(settings), preCollisionCounters.settings);

    // Real import through a file:// URL: one command, one Main write, fresh
    // IDs, deterministic name collision, exact HDR/negative values.
    await setNextDialogPaths(settings, { open: pathToFileURL(paths.importFixturePath).href });
    await click(settings, "palette-import");
    snapshots = await waitForRevision(clients, 11, "import palette");
    assert.equal(snapshots[0].activePalette.id, "palette-11", "imported palette gets a fresh ID");
    assert.equal(
      snapshots[0].activePalette.name,
      "Palette 1 2",
      "duplicate import names resolve deterministically"
    );
    assert.equal(snapshots[1].activePalette.name, "Palette 1 2");
    assert.deepEqual(
      snapshots[0].palette.map((color) => color.id),
      ["color-11-1", "color-11-2"],
      "imported colors get fresh IDs"
    );
    assert.deepEqual(
      snapshots[0].palette.map((color) => color.rgba),
      [HDR_RGBA, IMPORT_SECOND_RGBA],
      "imported RGBA stays exact, including HDR/negative components"
    );
    paletteFile = await readPaletteFile(paths.palettePath);
    assert.equal(paletteFile.revision, 11);
    assert.equal(paletteFile.palettes.length, 2);
    assert.deepEqual(paletteFile.palettes[1].colors.map((color) => color.rgba), [
      HDR_RGBA,
      IMPORT_SECOND_RGBA,
    ]);
    assert.equal((await counters(main)).diskWrites, 11, "import performs exactly one Main write");
    assert.equal((await counters(settings)).diskWrites, 0, "Settings writes 0");
    await screenshot(settings, "imported-palette.png", outputDirectory);

    // Delete the imported palette through the UI so cleanup stays deterministic.
    await click(settings, "palette-delete");
    await settle(settings);
    await click(settings, "palette-delete-confirm");
    snapshots = await waitForRevision(clients, 12, "delete imported palette");
    assert.equal(snapshots[0].palettes.length, 1);
    assert.equal(snapshots[0].activePalette.id, "palette-default");

    paletteFile = await readPaletteFile(paths.palettePath);
    assert.equal(paletteFile.revision, 12);
    assert.equal(paletteFile.palettes.length, 1);
    assert.deepEqual(paletteFile.palettes[0].colors.map((color) => color.id), ["a", "c"]);

    const [mainCounters, settingsCounters] = await Promise.all([
      counters(main),
      counters(settings),
    ]);
    assert.equal(mainCounters.diskWrites, 12, "Main should write exactly once per command");
    assert.equal(settingsCounters.diskWrites, 0, "Settings must never write palette.json");
    assert.equal(mainCounters.hostCalls, 0);
    assert.equal(settingsCounters.hostCalls, 0);
    assert.equal(mainCounters.receivedEvents, 12);
    assert.equal(settingsCounters.emittedEvents, 12);
    assert.equal(settingsCounters.receivedEvents, 12);

    await settle(settings);
    await screenshot(settings, "final-settings.png", outputDirectory);

    const runtimeErrors = clients.flatMap((client) =>
      client.events.filter(
        (event) =>
          event.method === "Runtime.exceptionThrown" ||
          (event.method === "Runtime.consoleAPICalled" && event.params.type === "error")
      )
    );
    assert.deepEqual(runtimeErrors, [], "live run should have no runtime errors");

    const report = {
      capturedAt: new Date().toISOString(),
      passed: true,
      operations: [
        "create",
        "empty-strip-hidden (no write)",
        "add-default-black",
        "edit-new-color",
        "rename",
        "select",
        "drag-cancel (no write)",
        "drag-reorder-color",
        "expand+format-switch (no write)",
        "invalid-hex (no write)",
        "update-color-hex",
        "remove-color",
        "select",
        "two-step-delete",
        "export-cancel (no-op)",
        "import-cancel (no-op)",
        "export-portable (no palette write)",
        "export-extension-collision (no-op)",
        "import-palette",
        "two-step-delete-imported",
      ],
      finalDocument: paletteFile,
      mainState: snapshots[0],
      settingsState: snapshots[1],
      counters: { main: mainCounters, settings: settingsCounters },
      temporaryRoot: paths.temporaryRoot,
      screenshots: [
        "empty-palette.png",
        "added-black-color.png",
        "expanded-editor.png",
        "armed-delete.png",
        "imported-palette.png",
        "final-settings.png",
      ],
    };
    await writeFile(resolve(outputDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    passed = true;
    console.log(
      JSON.stringify(
        {
          passed: true,
          operations: report.operations,
          revisions: paletteFile.revision,
          writes: { main: mainCounters.diskWrites, settings: settingsCounters.diskWrites },
          outputDirectory,
        },
        null,
        2
      )
    );
    },
    cleanupClient: async (client) => {
      const errors = [];
      if (client.connected && !client.closed) {
        try {
          if (client.page === "settings") {
            await client.send("Emulation.clearDeviceMetricsOverride");
            await restoreDialogStubs(client);
          }
        } catch (error) {
          errors.push({ phase: "panel-state", error: String(error?.stack || error) });
        }
        try {
          await callDebug(client, "return api.setTemporaryConfigRoot(null);");
        } catch (error) {
          errors.push({ phase: "temporary-root", error: String(error?.stack || error) });
        }
      }
      try {
        await client.close();
      } catch (error) {
        errors.push({ phase: "close", error: String(error?.stack || error) });
      }
      if (errors.length > 0) {
        throw new AggregateError(
          errors.map(({ error }) => new Error(error)),
          `Panel cleanup failed for ${client.page || "panel"}`
        );
      }
    },
    cleanupScratch: async ({ primaryError, cleanupErrors }) => {
      const preserveEvidence = Boolean(primaryError) || cleanupErrors.length > 0;
      if (preserveEvidence && existsSync(paths.palettePath)) {
        await copyFile(paths.palettePath, resolve(outputDirectory, "failure-palette.json"));
      }
      if (!preserveEvidence && passed) {
        await rm(resolve(outputDirectory, "failure.json"), { force: true });
        await rm(resolve(outputDirectory, "failure-palette.json"), { force: true });
      }
      await removeOwnedRunDirectory(scratch);
    },
    writeFailure: async ({ primaryError, cleanupErrors, clients }) => {
      await rm(resolve(outputDirectory, "report.json"), { force: true });
      await writeFile(
        resolve(outputDirectory, "failure.json"),
        `${JSON.stringify(
          {
            capturedAt: new Date().toISOString(),
            passed: false,
            error: primaryError ? primaryError.stack || primaryError.message : null,
            cleanupErrors,
            clients: clients.map((client) => ({ page: client.page })),
            temporaryRoot: paths.temporaryRoot,
          },
          null,
          2
        )}\n`
      );
    },
  });
};

const cli = async () => {
  const options = parseRunnerArgs(process.argv.slice(2), { allowed: ["output"] });
  const root = options.output || "evidence/local/palette-management/management-smoke";
  const runDirectory = await createOwnedRunDirectory(resolve(process.cwd(), root));
  return run(runDirectory.path, runDirectory);
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  cli().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
