#!/usr/bin/env node

import { createHash } from "node:crypto";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { CdpClient } from "./lib/cdp-client.mjs";
import {
  createOwnedRunDirectory,
  createOwnedTemporaryConfigDirectory,
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

const saveConvertedFixtureSource = (runtimeFixture) => `(function () {
  if (!app.project || app.project.file || app.project.dirty !== true) {
    return JSON.stringify({ ok: false, reason: "converted-project-state-mismatch" });
  }
  var comp = app.project.activeItem;
  if (!(comp instanceof CompItem) || comp.id !== 1 || comp.name !== "A3 Exact Identity Mixed AE25" ||
      comp.numLayers !== 2 || comp.layer(1).id !== 14 || comp.layer(2).id !== 13) {
    return JSON.stringify({ ok: false, reason: "converted-project-ownership-mismatch" });
  }
  var destination = new File(${JSON.stringify(runtimeFixture)});
  if (destination.exists) return JSON.stringify({ ok: false, reason: "runtime-fixture-already-exists" });
  app.project.save(destination);
  return JSON.stringify({
    ok: app.project.file && app.project.file.fsName === destination.fsName && app.project.dirty === false,
    version: app.version,
    projectPath: app.project.file ? app.project.file.fsName : null,
    dirty: app.project.dirty,
    compId: comp.id,
    selectedLayers: comp.selectedLayers.length,
    selectedProperties: comp.layer(1).selectedProperties.length + comp.layer(2).selectedProperties.length
  });
})()`;

const restoreProjectSource = (projectPath, restoreEmptyProject, fixtureCopy, runtimeFixture) => `(function () {
  if (!app.project) return JSON.stringify({ restored: false, reason: "fixture-project-missing" });
  var active = app.project.activeItem;
  var ownedSavedCopy = app.project.file &&
    (app.project.file.fsName === ${JSON.stringify(fixtureCopy)} ||
      app.project.file.fsName === ${JSON.stringify(runtimeFixture)});
  var ownedConvertedCopy = !app.project.file &&
    active instanceof CompItem && active.id === 1 && active.name === "A3 Exact Identity Mixed AE25" &&
    active.numLayers === 2 && active.layer(1).id === 14 && active.layer(2).id === 13;
  if (!ownedSavedCopy && !ownedConvertedCopy) {
    return JSON.stringify({ restored: false, reason: "fixture-project-ownership-mismatch" });
  }
  app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);
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

const aeMajor = (version) => {
  const match = /^(\d+)(?:\.|x|$)/.exec(String(version || ""));
  return match ? Number(match[1]) : null;
};

const MIN_SUPPORTED_AE_MAJOR = 22;
const MAX_SUPPORTED_AE_MAJOR = 26;

export const canLoadReviewedNativeGradientFixture = (runtimeVersion, expectedVersion) => {
  const runtimeMajor = aeMajor(runtimeVersion);
  const expectedMajor = aeMajor(expectedVersion);
  const supportedRuntime =
    runtimeMajor !== null &&
    runtimeMajor >= MIN_SUPPORTED_AE_MAJOR &&
    runtimeMajor <= MAX_SUPPORTED_AE_MAJOR;
  return (
    supportedRuntime &&
    (String(runtimeVersion || "") === String(expectedVersion || "") ||
      (expectedMajor !== null && runtimeMajor > expectedMajor))
  );
};

export const classifyNativeGradientFixtureLoad = ({ setup, expectedVersion, fixtureCopy }) => {
  const runtimeMajor = aeMajor(setup?.version);
  const expectedMajor = aeMajor(expectedVersion);
  const commonIdentity =
    setup?.ok === true &&
    runtimeMajor !== null &&
    runtimeMajor >= MIN_SUPPORTED_AE_MAJOR &&
    runtimeMajor <= MAX_SUPPORTED_AE_MAJOR &&
    setup.compId === 1 &&
    setup.selectedLayers === 2 &&
    setup.selectedProperties === 0;
  const exact =
    commonIdentity &&
    setup.version === expectedVersion &&
    setup.projectPath === fixtureCopy &&
    setup.dirty === false;
  const converted =
    commonIdentity &&
    expectedMajor !== null &&
    runtimeMajor > expectedMajor &&
    setup.projectPath === null &&
    setup.dirty === true;
  return { accepted: exact || converted, exact, converted, runtimeMajor, expectedMajor };
};

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

const descriptorIdentityProjection = (descriptor) => ({
  compId: descriptor.compId,
  layerId: descriptor.layerId,
  layerIndex: descriptor.layerIndex,
  kind: descriptor.kind,
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

const main = async (outputDirectory) => {
  const scratch = await createOwnedTemporaryConfigDirectory({ tokenPrefix: "chroma-relay-native-gradient" });
  const temporaryRoot = scratch.path;
  const fixtureCopy = resolve(temporaryRoot, "exact-identity-ae25.aep");
  const convertedFixtureCopy = resolve(temporaryRoot, "exact-identity-runtime.aep");
  let runtimeFixture = fixtureCopy;
  let runtimeSave = null;
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
    if (
      !canLoadReviewedNativeGradientFixture(
        originalProject.version,
        sourceExpected.afterEffectsVersion
      )
    ) {
      throw new Error(
        `AE ${originalProject.version} cannot safely open reviewed fixture ${sourceExpected.afterEffectsVersion}`
      );
    }

    setupAttempted = true;
    setup = await evalHost(client, openFixtureSource(fixtureCopy));
    const fixtureLoad = classifyNativeGradientFixtureLoad({
      setup,
      expectedVersion: sourceExpected.afterEffectsVersion,
      fixtureCopy,
    });
    if (!fixtureLoad.accepted) {
      throw new Error(`AE fixture setup failed: ${JSON.stringify(setup)}`);
    }
    if (fixtureLoad.converted) {
      runtimeFixture = convertedFixtureCopy;
      runtimeSave = await evalHost(client, saveConvertedFixtureSource(runtimeFixture));
      if (
        runtimeSave.ok !== true ||
        runtimeSave.version !== setup.version ||
        runtimeSave.projectPath !== runtimeFixture ||
        runtimeSave.dirty !== false ||
        runtimeSave.compId !== 1 ||
        runtimeSave.selectedLayers !== 2 ||
        runtimeSave.selectedProperties !== 0
      ) {
        throw new Error(`Converted fixture save failed: ${JSON.stringify(runtimeSave)}`);
      }
    }
    const runtimeHashBefore = await sha256(runtimeFixture);

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
    const runtimeHashAfter = await sha256(runtimeFixture);
    let stored = null;
    try {
      stored = JSON.parse(await readFile(resolve(temporaryRoot, "palette.json"), "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const lastHostResult = snapshot.state.lastHostResult;
    const descriptors = lastHostResult?.selection?.nativeGradients?.descriptors ?? [];
    const entries = lastHostResult?.selection?.colors?.entries ?? [];
    const gradients = lastHostResult?.gradients ?? [];
    const comparisonProjection = fixtureLoad.converted
      ? descriptorIdentityProjection
      : descriptorProjection;
    const expectedDescriptors = sourceExpected.targets.map(comparisonProjection);
    const actualDescriptors = descriptors.map(comparisonProjection);
    const expectedGradients = sourceExpected.targets.map((target) => target.gradient);
    const expectedEntries = expectedGradients.map((_, gradientIndex) => ({
      type: "native-gradient",
      gradientIndex,
    }));
    const actualEntries = entries.map((entry) => ({
      type: entry.type,
      gradientIndex: entry.gradientIndex,
    }));
    const expectedPalette = expectedGradients.map((gradient) => [
      Math.fround(gradient.colorStops[0].rgb[0]),
      Math.fround(gradient.colorStops[0].rgb[1]),
      Math.fround(gradient.colorStops[0].rgb[2]),
      1,
    ]);
    const storedActive = stored?.palettes?.find((palette) => palette.id === stored.activePaletteId);
    const storedPalette = storedActive ? storedActive.colors.map((color) => color.rgba) : null;
    const storedGradients = storedActive ? storedActive.colors.map((color) => color.gradient) : null;
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
      JSON.stringify(lastHostResult?.selection?.colors?.colors) !== JSON.stringify([]) ||
      JSON.stringify(actualEntries) !== JSON.stringify(expectedEntries) ||
      JSON.stringify(actualDescriptors) !== JSON.stringify(expectedDescriptors) ||
      JSON.stringify(gradients) !== JSON.stringify(expectedGradients) ||
      JSON.stringify(statePalette) !== JSON.stringify(expectedPalette) ||
      JSON.stringify(storedPalette) !== JSON.stringify(expectedPalette) ||
      JSON.stringify(storedGradients) !== JSON.stringify(expectedGradients) ||
      snapshot.state.lastResult !== null ||
      JSON.stringify(before) !== JSON.stringify(after) ||
      copyHashAfter !== copyHashBefore ||
      runtimeHashAfter !== runtimeHashBefore
    ) {
      throw new Error(
        `Track A assertion failed: ${JSON.stringify({
          accepted,
          counters: snapshot.counters,
          state: snapshot.state,
          actualDescriptors,
          expectedDescriptors,
          gradients,
          expectedGradients,
          storedPalette,
          storedGradients,
          before,
          after,
          copyHashBefore,
          copyHashAfter,
          runtimeHashBefore,
          runtimeHashAfter,
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
      fixtureLoad,
      runtimeSave,
      runtimeFixture,
      before,
      after,
      accepted,
      counters: snapshot.counters,
      paletteRevision: snapshot.state.paletteRevision,
      lastResult: snapshot.state.lastResult,
      descriptors: actualDescriptors,
      gradients,
      palette: statePalette,
      persistedPalette: storedPalette,
      persistedGradients: storedGradients,
      copyHashBefore,
      copyHashAfter,
      runtimeHashBefore,
      runtimeHashAfter,
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
            restoreProjectSource(
              originalProject.projectPath,
              restoreEmptyProject,
              fixtureCopy,
              runtimeFixture
            )
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
  return main(run.path);
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  cli().catch((error) => {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  });
}
