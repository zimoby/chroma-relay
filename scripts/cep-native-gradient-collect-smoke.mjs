#!/usr/bin/env node

import { createHash } from "node:crypto";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const FIXTURE_SOURCE = resolve(
  REPO_ROOT,
  "tests/fixtures/native-gradient/exact-identity-ae25.aep"
);
const EXPECTED_SOURCE = resolve(
  REPO_ROOT,
  "tests/fixtures/native-gradient/exact-identity-ae25.expected.json"
);
const EXPECTED_BUILD_MARKER = `${contract.marker.current} · ${packageJson.version}`;

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
const sha256 = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");
const debugCall = (callback) => `(() => {
  const api = window.__CHROMA_RELAY_DEBUG__;
  if (!api) throw new Error("Chroma Relay debug API unavailable");
  return (${callback})(api);
})()`;

const waitForDebug = async (client) => {
  let stable = 0;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const ready = await client.evaluate(
      'document.readyState === "complete" && Boolean(window.__CHROMA_RELAY_DEBUG__)'
    );
    stable = ready ? stable + 1 : 0;
    if (stable === 3) return;
    if (attempt === 79) throw new Error("Main debug API did not stabilize");
    await delay(50);
  }
};

const afterRender = (client) =>
  client.evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");

const waitForIdle = async (client) => {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const snapshot = await client.evaluate(
      debugCall("(api) => ({ state: api.getState(), counters: api.getCounters() })")
    );
    if (
      snapshot.state.pendingHostAction === null &&
      snapshot.state.pendingPaletteMutation === false
    ) {
      await afterRender(client);
      return snapshot;
    }
    if (attempt === 119) throw new Error("Native-gradient collection did not become idle");
    await delay(50);
  }
};

const evalHost = (client, source) =>
  client.evaluate(`new Promise((resolve, reject) => {
    window.__adobe_cep__.evalScript(${JSON.stringify(source)}, (result) => {
      try { resolve(JSON.parse(result)); } catch (error) { reject(new Error(result)); }
    });
  })`);

const projectStateSource = `(function () {
  if (!app.project) return JSON.stringify({ project: null });
  var active = app.project.activeItem;
  var layers = [];
  if (active instanceof CompItem) {
    for (var index = 1; index <= active.numLayers; index += 1) {
      var layer = active.layer(index);
      layers.push({
        id: layer.id,
        index: layer.index,
        selected: layer.selected === true,
        selectedProperties: layer.selectedProperties.length
      });
    }
  }
  return JSON.stringify({
    version: app.version,
    projectPath: app.project.file ? app.project.file.fsName : null,
    dirty: app.project.dirty,
    numItems: app.project.numItems,
    activeCompId: active instanceof CompItem ? active.id : null,
    activeCompName: active instanceof CompItem ? active.name : null,
    layers: layers
  });
})()`;

const openFixtureSource = (fixtureCopy) => `(function () {
  if (!app.project || app.project.dirty !== false) {
    return JSON.stringify({ ok: false, reason: "current-project-not-clean" });
  }
  var fixture = new File(${JSON.stringify(fixtureCopy)});
  if (!fixture.exists) return JSON.stringify({ ok: false, reason: "fixture-missing" });
  app.open(fixture);
  var comp = null;
  for (var itemIndex = 1; itemIndex <= app.project.numItems; itemIndex += 1) {
    var item = app.project.item(itemIndex);
    if (item instanceof CompItem && item.id === 1) comp = item;
    item.selected = false;
  }
  if (!comp || comp.numLayers !== 2) {
    return JSON.stringify({ ok: false, reason: "target-comp-mismatch" });
  }
  comp.openInViewer();
  var expectedLayerIds = [14, 13];
  for (var layerIndex = 1; layerIndex <= comp.numLayers; layerIndex += 1) {
    var layer = comp.layer(layerIndex);
    var selected = layer.selectedProperties;
    for (var selectedIndex = selected.length - 1; selectedIndex >= 0; selectedIndex -= 1) {
      selected[selectedIndex].selected = false;
    }
    layer.selected = false;
    if (layer.id !== expectedLayerIds[layerIndex - 1]) {
      return JSON.stringify({ ok: false, reason: "layer-id-mismatch", index: layerIndex, id: layer.id });
    }
  }
  comp.layer(1).selected = true;
  comp.layer(2).selected = true;
  return JSON.stringify({
    ok: true,
    version: app.version,
    projectPath: app.project.file ? app.project.file.fsName : null,
    dirty: app.project.dirty,
    compId: comp.id,
    selectedLayers: comp.selectedLayers.length,
    selectedProperties: comp.layer(1).selectedProperties.length + comp.layer(2).selectedProperties.length
  });
})()`;

const restoreProjectSource = (projectPath, restoreEmptyProject) => `(function () {
  if (!app.project || app.project.dirty !== false) {
    return JSON.stringify({ restored: false, reason: "fixture-project-dirty" });
  }
  if (${restoreEmptyProject === true ? "true" : "false"}) {
    app.newProject();
    return JSON.stringify({
      restored: true,
      projectPath: app.project.file ? app.project.file.fsName : null,
      dirty: app.project.dirty,
      numItems: app.project.numItems
    });
  }
  var previous = new File(${JSON.stringify(projectPath)});
  if (!previous.exists) return JSON.stringify({ restored: false, reason: "previous-project-missing" });
  app.open(previous);
  return JSON.stringify({
    restored: true,
    projectPath: app.project.file ? app.project.file.fsName : null,
    dirty: app.project.dirty
  });
})()`;

const consoleEvidence = (events) => ({
  console: events
    .filter((event) => event.method === "Runtime.consoleAPICalled")
    .map((event) => ({
      type: event.params.type,
      values: event.params.args.map((argument) => argument.value ?? argument.description ?? null),
    })),
  exceptions: events
    .filter((event) => event.method === "Runtime.exceptionThrown")
    .map((event) => event.params.exceptionDetails),
});

const descriptorProjection = (descriptor) => ({
  compId: descriptor.compId,
  layerId: descriptor.layerId,
  layerIndex: descriptor.layerIndex,
  kind: descriptor.kind,
  propertyIndexPath: descriptor.propertyIndexPath,
  matchNamePath: descriptor.matchNamePath,
});

export const assessNativeGradientCleanup = ({
  report,
  failure,
  setup,
  setupAttempted = Boolean(setup),
  cleanup,
}) => {
  const panelRestored = cleanup.panel?.restored === true;
  const projectRestored = cleanup.project?.restored === true;
  const retainScratch = setupAttempted && (!panelRestored || !projectRestored);
  const restorationFailed = setupAttempted && (!panelRestored || !projectRestored);
  const cleanupFailed =
    restorationFailed || (Boolean(report) && cleanup.temp?.removed !== true);
  let nextFailure = failure;
  let nextReport = report;
  if (cleanupFailed) {
    nextFailure ||= new Error(`Cleanup failed: ${JSON.stringify(cleanup)}`);
    nextReport = null;
  }
  return { report: nextReport, failure: nextFailure, retainScratch };
};

const main = async (outputDirectory, parentRun) => {
  const scratch = await createOwnedScratchDirectory(parentRun);
  const temporaryRoot = scratch.path;
  const fixtureCopy = resolve(temporaryRoot, "exact-identity-ae25.aep");
  let client = null;
  let originalProject = null;
  let originalConfigRoot = null;
  let setup = null;
  let setupAttempted = false;
  let cleanup = { panel: null, project: null, temp: null };
  let failure = null;
  let report = null;

  try {
    await copyFile(FIXTURE_SOURCE, fixtureCopy);
    const response = await fetch("http://127.0.0.1:8198/json/list");
    if (!response.ok) throw new Error(`CDP target list failed: HTTP ${response.status}`);
    const targets = await response.json();
    const matches = targets.filter(
      (target) =>
        target.type === "page" && new URL(target.url).pathname.endsWith("/main/index.html")
    );
    if (matches.length !== 1) throw new Error(`Expected one Main target, found ${matches.length}`);

    client = new CdpClient(matches[0].webSocketDebuggerUrl);
    await client.connect();
    await Promise.all([
      client.send("Runtime.enable"),
      client.send("Log.enable"),
      client.send("Page.enable"),
    ]);
    client.events = [];
    await client.send("Page.reload", { ignoreCache: true });
    await waitForDebug(client);
    await afterRender(client);

    const identity = await client.evaluate(debugCall("(api) => api.getIdentity()"));
    if (
      identity.extensionId !== contract.product.panelIds.main ||
      identity.page !== "main" ||
      !String(identity.url || "").endsWith("/main/index.html") ||
      identity.buildMarker !== EXPECTED_BUILD_MARKER
    ) {
      throw new Error(`Unexpected panel identity: ${JSON.stringify(identity)}`);
    }
    originalConfigRoot = identity.configRoot ?? null;

    originalProject = await evalHost(client, projectStateSource);
    const restoreEmptyProject =
      originalProject.projectPath === null &&
      originalProject.dirty === false &&
      originalProject.numItems === 0;
    if (
      originalProject.dirty !== false ||
      (!originalProject.projectPath && !restoreEmptyProject)
    ) {
      throw new Error(`Refusing to replace current project: ${JSON.stringify(originalProject)}`);
    }

    const sourceExpected = JSON.parse(await readFile(EXPECTED_SOURCE, "utf8"));
    const sourceHash = await sha256(FIXTURE_SOURCE);
    const copyHashBefore = await sha256(fixtureCopy);
    if (sourceHash !== sourceExpected.file.sha256 || copyHashBefore !== sourceHash) {
      throw new Error("Fixture hash does not match its reviewed expectation");
    }

    setupAttempted = true;
    setup = await evalHost(client, openFixtureSource(fixtureCopy));
    if (
      setup.ok !== true ||
      setup.version !== sourceExpected.afterEffectsVersion ||
      setup.projectPath !== fixtureCopy ||
      setup.dirty !== false ||
      setup.compId !== 1 ||
      setup.selectedLayers !== 2 ||
      setup.selectedProperties !== 0
    ) {
      throw new Error(`AE fixture setup failed: ${JSON.stringify(setup)}`);
    }

    await client.evaluate(debugCall("(api) => api.resetTestState()"));
    await afterRender(client);
    await client.evaluate(
      debugCall(`(api) => api.setTemporaryConfigRoot(${JSON.stringify(temporaryRoot)})`)
    );
    await afterRender(client);
    await client.evaluate(debugCall("(api) => api.seedPalette([])"));
    await afterRender(client);

    const before = await evalHost(client, projectStateSource);
    const accepted = await client.evaluate(debugCall('(api) => api.dispatchClick("palette-add")'));
    const snapshot = await waitForIdle(client);
    const after = await evalHost(client, projectStateSource);
    const copyHashAfter = await sha256(fixtureCopy);
    const stored = JSON.parse(await readFile(resolve(temporaryRoot, "palette.json"), "utf8"));
    const lastHostResult = snapshot.state.lastHostResult;
    const descriptors = lastHostResult?.selection?.nativeGradients?.descriptors ?? [];
    const entries = lastHostResult?.selection?.colors?.entries ?? [];
    const gradientColors = lastHostResult?.gradientColors ?? [];
    const expectedDescriptors = sourceExpected.targets.map(descriptorProjection);
    const actualDescriptors = descriptors.map(descriptorProjection);
    const expectedGroups = sourceExpected.targets.map((target) =>
      target.gradient.colorStops.map((stop) => [
        Math.fround(stop.rgb[0]),
        Math.fround(stop.rgb[1]),
        Math.fround(stop.rgb[2]),
        1,
      ])
    );
    const expectedSolidColors = [
      [1, 0, 0, 1],
      [0, 0, 0, 1],
    ];
    const expectedEntries = [
      { type: "native-gradient", gradientIndex: 0 },
      { type: "solid", colorIndex: 0 },
      { type: "native-gradient", gradientIndex: 1 },
      { type: "solid", colorIndex: 1 },
      { type: "native-gradient", gradientIndex: 2 },
      { type: "native-gradient", gradientIndex: 3 },
    ];
    const expectedPalette = [];
    for (const entry of expectedEntries) {
      if (entry.type === "native-gradient") {
        expectedPalette.push(...expectedGroups[entry.gradientIndex]);
      } else {
        const solid = expectedSolidColors[entry.colorIndex];
        if (!expectedPalette.some((color) => JSON.stringify(color) === JSON.stringify(solid))) {
          expectedPalette.push(solid);
        }
      }
    }
    const storedActive = stored.palettes.find((palette) => palette.id === stored.activePaletteId);
    const storedPalette = storedActive ? storedActive.colors.map((color) => color.rgba) : null;
    const statePalette = snapshot.state.palette.map((color) => color.rgba);

    if (
      accepted !== true ||
      snapshot.counters.hostCalls !== 1 ||
      snapshot.counters.diskWrites !== 1 ||
      snapshot.state.paletteRevision !== 1 ||
      snapshot.state.pendingHostAction !== null ||
      snapshot.state.pendingPaletteMutation !== false ||
      lastHostResult?.selection?.nativeGradients?.status !== "ok" ||
      lastHostResult?.selection?.colors?.unsupportedGradientCount !== 4 ||
      lastHostResult?.selection?.colors?.readErrorCount !== 0 ||
      JSON.stringify(lastHostResult?.selection?.colors?.colors) !==
        JSON.stringify(expectedSolidColors) ||
      JSON.stringify(entries) !== JSON.stringify(expectedEntries) ||
      JSON.stringify(actualDescriptors) !== JSON.stringify(expectedDescriptors) ||
      JSON.stringify(gradientColors) !== JSON.stringify(expectedGroups) ||
      JSON.stringify(statePalette) !== JSON.stringify(expectedPalette) ||
      JSON.stringify(storedPalette) !== JSON.stringify(expectedPalette) ||
      snapshot.state.lastResult !== "Added 9 colors" ||
      JSON.stringify(before) !== JSON.stringify(after) ||
      copyHashAfter !== copyHashBefore
    ) {
      throw new Error(
        `Track A assertion failed: ${JSON.stringify({
          accepted,
          counters: snapshot.counters,
          state: snapshot.state,
          actualDescriptors,
          expectedDescriptors,
          gradientColors,
          expectedGroups,
          storedPalette,
          before,
          after,
          copyHashBefore,
          copyHashAfter,
        })}`
      );
    }

    const screenshot = await client.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    await writeFile(
      resolve(outputDirectory, "main-native-gradient-collected.png"),
      Buffer.from(screenshot.data, "base64")
    );
    const console = consoleEvidence(client.events);
    const errors = console.console.filter((entry) => ["error", "assert"].includes(entry.type));
    if (errors.length > 0 || console.exceptions.length > 0) {
      throw new Error(`Panel emitted errors: ${JSON.stringify(console)}`);
    }

    report = {
      capturedAt: new Date().toISOString(),
      passed: true,
      toolkitSha: "52b4b5c199691b4bc5e352a7d716192e061c750e",
      identity,
      fixture: {
        source: FIXTURE_SOURCE,
        copy: fixtureCopy,
        sha256: sourceHash,
        expected: EXPECTED_SOURCE,
      },
      originalProject,
      setup,
      before,
      after,
      accepted,
      counters: snapshot.counters,
      paletteRevision: snapshot.state.paletteRevision,
      lastResult: snapshot.state.lastResult,
      descriptors: actualDescriptors,
      gradientColors,
      palette: statePalette,
      persistedPalette: storedPalette,
      copyHashBefore,
      copyHashAfter,
      console,
      screenshots: ["main-native-gradient-collected.png"],
    };
  } catch (error) {
    failure = error;
  } finally {
    if (client) {
      try {
        await client.evaluate(debugCall("(api) => api.resetTestState()"));
        await afterRender(client);
        await client.evaluate(
          debugCall(
            `(api) => api.setTemporaryConfigRoot(${JSON.stringify(originalConfigRoot)})`
          )
        );
        await afterRender(client);
        const loaded = await client.evaluate(debugCall("(api) => api.reloadPalette()"));
        await afterRender(client);
        const restoredIdentity = await client.evaluate(debugCall("(api) => api.getIdentity()"));
        cleanup.panel = {
          restored: restoredIdentity.configRoot === originalConfigRoot,
          originalConfigRoot,
          configRoot: restoredIdentity.configRoot,
          loaded,
        };
      } catch (error) {
        cleanup.panel = { restored: false, error: String(error) };
      }
      if (originalProject) {
        try {
          const restoreEmptyProject =
            originalProject.projectPath === null &&
            originalProject.dirty === false &&
            originalProject.numItems === 0;
          cleanup.project = await evalHost(
            client,
            restoreProjectSource(originalProject.projectPath, restoreEmptyProject)
          );
        } catch (error) {
          cleanup.project = { restored: false, error: String(error) };
        }
      }
      try {
        await client.close();
      } catch (error) {
        cleanup.close = { closed: false, error: String(error?.stack || error) };
        failure ||= error;
      }
    }
    try {
      const cleanupState = assessNativeGradientCleanup({
        report: null,
        failure,
        setup,
        setupAttempted,
        cleanup,
      });
      if (!cleanupState.retainScratch) {
        await removeOwnedRunDirectory(scratch);
        cleanup.temp = { removed: true, path: temporaryRoot };
      } else {
        cleanup.temp = { removed: false, reason: "panel-state-unrestored-or-restore-failed" };
      }
    } catch (error) {
      cleanup.temp = { removed: false, error: String(error) };
    }
  }

  const cleanupState = assessNativeGradientCleanup({
    report: report ? { ...report, cleanup } : report,
    failure,
    setup,
    setupAttempted,
    cleanup,
  });
  report = cleanupState.report;
  failure = cleanupState.failure;

  if (failure) {
    const failureReport = {
      capturedAt: new Date().toISOString(),
      passed: false,
      error: String(failure?.stack || failure),
      originalProject,
      setup,
      cleanup,
    };
    await writeFile(
      resolve(outputDirectory, "failure.json"),
      `${JSON.stringify(failureReport, null, 2)}\n`
    );
    throw failure;
  }

  await writeFile(resolve(outputDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ passed: true, outputDirectory }, null, 2));
};

const cli = async () => {
  const options = parseRunnerArgs(process.argv.slice(2), { allowed: ["output"] });
  const root = options.output || "evidence/local/native-gradient/track-a-collect-ae25";
  const run = await createOwnedRunDirectory(resolve(REPO_ROOT, root));
  return main(run.path, run);
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  cli().catch((error) => {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  });
}
