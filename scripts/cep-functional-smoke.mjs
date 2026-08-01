#!/usr/bin/env node

import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CdpClient } from "./lib/cdp-client.mjs";
import contract from "../src/shared/product-contract.json" with { type: "json" };
import packageJson from "../package.json" with { type: "json" };
import {
  assertCanonicalRuntimeUrl,
  createOwnedRunDirectory,
  createOwnedTemporaryConfigDirectory,
  guardClientEvaluations,
  isDirectCliInvocation,
  parseRunnerArgs,
  removeOwnedRunDirectory,
  restoreConfigRootWithReadback,
  selectCanonicalCdpTarget,
} from "./lib/live-runner-policy.mjs";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const isCliEntry = isDirectCliInvocation(import.meta.url);
const canonicalizePotentialOutput = async (path) => {
  const suffix = [];
  let cursor = path;
  while (true) {
    try {
      return resolve(await realpath(cursor), ...suffix.reverse());
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      suffix.push(relative(parent, cursor));
      cursor = parent;
    }
  }
};

export const extractExplicitFunctionalSmokeOutput = async (args) => {
  const outputArgs = args.filter((arg) => typeof arg === "string" && arg.startsWith("--output="));
  if (outputArgs.length === 0) return null;
  const outputs = [];
  for (const outputArg of outputArgs) {
    try {
      outputs.push(parseRunnerArgs([outputArg], { allowed: ["output"] }).output);
    } catch {
      return null;
    }
  }
  const destinations = await Promise.all(
    outputs.map((output) => canonicalizePotentialOutput(resolve(REPO_ROOT, output)))
  );
  if (destinations.some((destination) => destination !== destinations[0])) return null;
  return relative(REPO_ROOT, destinations[0]);
};
const rawCliArgs = isCliEntry ? process.argv.slice(2) : [];
let cliArgs;
let cliArgumentError = null;
try {
  cliArgs = parseRunnerArgs(rawCliArgs, { allowed: ["mode", "output"] });
} catch (error) {
  cliArgumentError = error;
  const explicitOutput = await extractExplicitFunctionalSmokeOutput(rawCliArgs);
  if (!explicitOutput) throw error;
  cliArgs = { output: explicitOutput };
}
const mode = cliArgumentError ? "invalid-cli" : cliArgs.mode || "collect";
const modeSupported = ["collect", "apply", "mutate", "image", "image-selection"].includes(mode);
const modeValidationError = cliArgumentError || (modeSupported
  ? null
  : new Error(`Unsupported functional smoke mode: ${mode}`));
const outputExplicit = Object.prototype.hasOwnProperty.call(cliArgs, "output");
if (modeValidationError && !outputExplicit) throw modeValidationError;
const requestedOutput = outputExplicit
  ? cliArgs.output
  : mode === "apply"
    ? "evidence/i08/apply-smoke"
    : mode === "mutate"
      ? "evidence/i09/mutation-smoke"
      : mode === "image"
        ? "evidence/local/image-extraction/live-smoke"
        : mode === "image-selection"
          ? "evidence/local/image-extraction/selection-smoke"
          : "evidence/i07/host-smoke";
let temporaryRoot = null;
const APPLY_RGBA = [0.75, 0.5, 0.25, 1];
const MUTATION_COLORS = [
  { id: "a", rgba: [1, 0, 0, 1] },
  { id: "b", rgba: [0, 1, 0, 1] },
  { id: "c", rgba: [0, 0, 1, 1] },
  { id: "d", rgba: [1, 1, 0, 1] },
];
export const activePaletteItems = (document) => {
  if (Array.isArray(document?.palettes)) {
    return document.palettes.find((palette) => palette.id === document.activePaletteId)?.colors ?? [];
  }
  return Array.isArray(document?.colors) ? document.colors : [];
};
export const colorSelectionResult = (lastHostResult) =>
  lastHostResult?.selection?.colors ?? lastHostResult;
const IMAGE_FIXTURES = ["png", "jpg"].map((format) => ({
  format,
  path: resolve(REPO_ROOT, `tests/fixtures/image-extraction/fixture.${format}`),
}));
const IMAGE_PRESETS = ["balanced", "tonal", "contrast"];
const COLOR_FIXTURE_SETUP_PATH = resolve(REPO_ROOT, "scripts/ae-i07-i08-setup.jsx");

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
const debugCall = (callback) => `(() => {
  const api = window.__CHROMA_RELAY_DEBUG__;
  if (!api) throw new Error("Chroma Relay debug API unavailable");
  return (${callback})(api);
})()`;
const assertFunctionalRuntime = async (client, label = "functional smoke Main runtime") => {
  const identity = await client.evaluate(debugCall("(api) => api.getIdentity()"));
  await assertCanonicalRuntimeUrl(
    identity.url,
    resolve(REPO_ROOT, "dist/cep/main/index.html"),
    { label }
  );
  if (
    identity.extensionId !== contract.product.panelIds.main ||
    identity.page !== "main" ||
    identity.buildMarker !== `${contract.marker.current} · ${packageJson.version}`
  ) {
    throw new Error(`Functional smoke Main identity mismatch: ${JSON.stringify(identity)}`);
  }
  return identity;
};

const waitForStableDebug = async (client, evaluationGuard) => {
  let stableFrames = 0;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const ready = await client.evaluate(
      'document.readyState === "complete" && Boolean(window.__CHROMA_RELAY_DEBUG__)'
    );
    stableFrames = ready ? stableFrames + 1 : 0;
    if (stableFrames === 3) return;
    if (attempt === 79) {
      evaluationGuard?.quarantine();
      throw new Error("Main debug API did not stabilize; renderer completion quarantined");
    }
    await delay(50);
  }
};

const afterRender = (client) =>
  client.evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");

const waitForHostIdle = async (client, evaluationGuard) => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const state = await client.evaluate(debugCall("(api) => api.getState()"));
    if (state.pendingHostAction === null) {
      await afterRender(client);
      return state;
    }
    if (attempt === 79) {
      evaluationGuard?.quarantine();
      throw new Error("Host action did not complete; renderer completion quarantined");
    }
    await delay(50);
  }
};

const waitForMutationRevision = async (client, revision, evaluationGuard) => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const snapshot = await client.evaluate(
      debugCall("(api) => ({ state: api.getState(), counters: api.getCounters() })")
    );
    if (!snapshot.state.pendingPaletteMutation && snapshot.state.paletteRevision === revision) {
      await afterRender(client);
      return snapshot;
    }
    if (attempt === 79) {
      evaluationGuard?.quarantine();
      throw new Error(
        `Palette mutation did not reach revision ${revision}; renderer completion quarantined`
      );
    }
    await delay(50);
  }
};


const waitForReloadedPalette = async (client, configRoot, revision, evaluationGuard) => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const snapshot = await client.evaluate(
      debugCall("(api) => ({ identity: api.getIdentity(), state: api.getState() })")
    );
    if (
      snapshot.identity.configRoot === configRoot &&
      snapshot.state.pendingPaletteMutation === false &&
      snapshot.state.paletteRevision === revision
    ) {
      await afterRender(client);
      return snapshot.state;
    }
    if (attempt === 79) {
      evaluationGuard?.quarantine();
      throw new Error(
        `Reloaded palette did not reach config root ${configRoot} at revision ${revision}; renderer completion quarantined`
      );
    }
    await delay(50);
  }
};

const evalHost = (client, source) =>
  client.evaluate(`new Promise((resolve, reject) => {
    window.__adobe_cep__.evalScript(${JSON.stringify(source)}, (result) => {
      try { resolve(JSON.parse(result)); } catch (error) { reject(new Error(result)); }
    });
  })`);

const resetImageSelectionCase = async (client) => {
  await writeFile(
    resolve(temporaryRoot, "palette.json"),
    `${JSON.stringify({ schemaVersion: 1, revision: 0, colors: [] }, null, 2)}\n`
  );
  await writeFile(
    resolve(temporaryRoot, "settings.json"),
    `${JSON.stringify(
      {
        schemaVersion: 3,
        revision: 1,
        layoutMode: "fixed",
        swatchSize: 40,
        includeDisabledColors: false,
        extractionPreset: "balanced",
      },
      null,
      2
    )}\n`
  );
  await client.evaluate(debugCall("(api) => api.resetTestState()"));
  await client.evaluate(
    debugCall(`(api) => api.setTemporaryConfigRoot(${JSON.stringify(temporaryRoot)})`)
  );
  await afterRender(client);
};

const importSelectedImageSource = (fixture) => `(function () {
  if (!app.project) return JSON.stringify({ ok: false, reason: "no-project" });
  for (var itemIndex = 1; itemIndex <= app.project.numItems; itemIndex += 1) {
    app.project.item(itemIndex).selected = false;
  }
  var activeItem = app.project.activeItem;
  if (activeItem instanceof CompItem) {
    for (var layerIndex = 1; layerIndex <= activeItem.numLayers; layerIndex += 1) {
      var layer = activeItem.layer(layerIndex);
      var selected = layer.selectedProperties;
      for (var propertyIndex = selected.length - 1; propertyIndex >= 0; propertyIndex -= 1) {
        selected[propertyIndex].selected = false;
      }
      layer.selected = false;
    }
  }
  var file = new File(${JSON.stringify(fixture.path)});
  if (!file.exists) return JSON.stringify({ ok: false, reason: "missing-file" });
  var imported = app.project.importFile(new ImportOptions(file));
  imported.name = ${JSON.stringify(`CP_IMAGE_FIXTURE_${fixture.format.toUpperCase()}`)};
  imported.selected = true;
  return JSON.stringify({
    ok: true,
    id: imported.id,
    name: imported.name,
    path: imported.file.fsName,
    selectedItems: app.project.selection.length
  });
})()`;

export const removeProjectItemSource = (itemId) => `(function () {
  if (!app.project) return JSON.stringify({ removed: false });
  for (var index = app.project.numItems; index >= 1; index -= 1) {
    var item = app.project.item(index);
    if (item.id === ${Number(itemId)}) {
      item.remove();
      return JSON.stringify({ removed: true });
    }
  }
  return JSON.stringify({ removed: false });
})()`;

const claimImageSelectionProjectSource = (runToken) => `(function () {
  if (!app.project || app.project.file || app.project.dirty !== false || app.project.numItems !== 0) {
    return JSON.stringify({ ok: false, reason: "project-not-empty-clean-unsaved" });
  }
  if ($.global.__CHROMA_FUNCTIONAL_PROJECT_OWNER__ != null ||
      $.global.__CHROMA_FUNCTIONAL_PROJECT__ != null) {
    return JSON.stringify({ ok: false, reason: "foreign-project-claim-present" });
  }
  $.global.__CHROMA_FUNCTIONAL_PROJECT_OWNER__ = ${JSON.stringify(runToken)};
  $.global.__CHROMA_FUNCTIONAL_PROJECT__ = app.project;
  return JSON.stringify({
    ok: true,
    projectPath: null,
    dirty: app.project.dirty,
    numItems: app.project.numItems
  });
})()`;

export const guardImageSelectionProjectSource = (runToken, source) => `(function () {
  if ($.global.__CHROMA_FUNCTIONAL_PROJECT_OWNER__ !== ${JSON.stringify(runToken)} ||
      $.global.__CHROMA_FUNCTIONAL_PROJECT__ !== app.project) {
    return JSON.stringify({ ok: false, reason: "image-selection-project-owner-mismatch" });
  }
  return ${source};
})()`;

const imageSelectionTopologyFunctions = `
  var snapshotValue = function (value) {
    if (value === null || value === undefined) return value === null ? null : "undefined";
    if (value instanceof Array) {
      var values = [];
      for (var valueIndex = 0; valueIndex < value.length; valueIndex += 1) {
        values.push(snapshotValue(value[valueIndex]));
      }
      return values;
    }
    if (typeof value !== "object") return value;
    var objectValue = { display: String(value) };
    var fields = ["text", "closed", "vertices", "inTangents", "outTangents"];
    for (var fieldIndex = 0; fieldIndex < fields.length; fieldIndex += 1) {
      var field = fields[fieldIndex];
      try {
        if (value[field] !== undefined) objectValue[field] = snapshotValue(value[field]);
      } catch (_) {}
    }
    return objectValue;
  };
  var snapshotProperty = function (property) {
    var result = {
      index: property.propertyIndex,
      name: property.name,
      matchName: property.matchName,
      propertyType: property.propertyType,
      numProperties: property.numProperties || 0
    };
    if (result.numProperties > 0) {
      result.children = [];
      for (var childIndex = 1; childIndex <= result.numProperties; childIndex += 1) {
        result.children.push(snapshotProperty(property.property(childIndex)));
      }
      return result;
    }
    try { result.value = snapshotValue(property.value); } catch (_) { result.value = "<unreadable>"; }
    try { result.expression = property.canSetExpression ? property.expression : null; } catch (_) {}
    try { result.expressionEnabled = property.canSetExpression ? property.expressionEnabled : null; } catch (_) {}
    try {
      result.keys = [];
      for (var keyIndex = 1; keyIndex <= property.numKeys; keyIndex += 1) {
        var key = { time: property.keyTime(keyIndex), value: snapshotValue(property.keyValue(keyIndex)) };
        try { key.inInterpolationType = String(property.keyInInterpolationType(keyIndex)); } catch (_) {}
        try { key.outInterpolationType = String(property.keyOutInterpolationType(keyIndex)); } catch (_) {}
        try {
          var inEase = property.keyInTemporalEase(keyIndex);
          key.inTemporalEase = [];
          for (var inEaseIndex = 0; inEaseIndex < inEase.length; inEaseIndex += 1) {
            key.inTemporalEase.push({ speed: inEase[inEaseIndex].speed, influence: inEase[inEaseIndex].influence });
          }
        } catch (_) {}
        try {
          var outEase = property.keyOutTemporalEase(keyIndex);
          key.outTemporalEase = [];
          for (var outEaseIndex = 0; outEaseIndex < outEase.length; outEaseIndex += 1) {
            key.outTemporalEase.push({ speed: outEase[outEaseIndex].speed, influence: outEase[outEaseIndex].influence });
          }
        } catch (_) {}
        try { key.temporalAutoBezier = property.keyTemporalAutoBezier(keyIndex); } catch (_) {}
        try { key.temporalContinuous = property.keyTemporalContinuous(keyIndex); } catch (_) {}
        try { key.roving = property.keyRoving(keyIndex); } catch (_) {}
        try { key.spatialAutoBezier = property.keySpatialAutoBezier(keyIndex); } catch (_) {}
        try { key.spatialContinuous = property.keySpatialContinuous(keyIndex); } catch (_) {}
        try { key.inSpatialTangent = snapshotValue(property.keyInSpatialTangent(keyIndex)); } catch (_) {}
        try { key.outSpatialTangent = snapshotValue(property.keyOutSpatialTangent(keyIndex)); } catch (_) {}
        result.keys.push(key);
      }
    } catch (_) {}
    return result;
  };
  var snapshotItem = function (item) {
    var kind = item instanceof CompItem ? "comp" : "footage";
    var result = {
      id: item.id,
      name: item.name,
      typeName: item.typeName,
      kind: kind,
      comment: item.comment,
      label: item.label
    };
    if (kind === "footage") {
      result.width = item.width;
      result.height = item.height;
      result.duration = item.duration;
      result.frameRate = item.frameRate;
      result.file = item.mainSource && item.mainSource.file ? item.mainSource.file.fsName : null;
      return result;
    }
    result.width = item.width;
    result.height = item.height;
    result.pixelAspect = item.pixelAspect;
    result.duration = item.duration;
    result.frameRate = item.frameRate;
    result.bgColor = snapshotValue(item.bgColor);
    result.layers = [];
    for (var layerIndex = 1; layerIndex <= item.numLayers; layerIndex += 1) {
      var layer = item.layer(layerIndex);
      var layerResult = {
        id: layer.id,
        index: layer.index,
        name: layer.name,
        matchName: layer.matchName,
        comment: layer.comment,
        label: layer.label,
        sourceId: layer.source ? layer.source.id : null,
        parentId: layer.parent ? layer.parent.id : null,
        enabled: layer.enabled,
        locked: layer.locked,
        shy: layer.shy,
        solo: layer.solo,
        adjustmentLayer: layer.adjustmentLayer,
        guideLayer: layer.guideLayer,
        threeDLayer: layer.threeDLayer,
        blendingMode: String(layer.blendingMode),
        trackMatteType: String(layer.trackMatteType),
        startTime: layer.startTime,
        inPoint: layer.inPoint,
        outPoint: layer.outPoint,
        stretch: layer.stretch,
        properties: []
      };
      for (var propertyIndex = 1; propertyIndex <= layer.numProperties; propertyIndex += 1) {
        layerResult.properties.push(snapshotProperty(layer.property(propertyIndex)));
      }
      result.layers.push(layerResult);
    }
    return result;
  };
`;

const cleanupImageSelectionFixturesSource = (runToken, ownedItems, expectedTopology) => `(function () {
  if ($.global.__CHROMA_FUNCTIONAL_PROJECT_OWNER__ !== ${JSON.stringify(runToken)} ||
      $.global.__CHROMA_FUNCTIONAL_PROJECT__ !== app.project) {
    return JSON.stringify({ removed: [], reason: "image-selection-project-owner-mismatch" });
  }
  var owned = ${JSON.stringify(ownedItems)};
  var expectedTopology = ${JSON.stringify(expectedTopology)};
  if (!expectedTopology || expectedTopology.length !== owned.length) {
    return JSON.stringify({ removed: [], reason: "owned-project-topology-unavailable" });
  }
  if (!app.project || app.project.file || app.project.numItems !== owned.length) {
    return JSON.stringify({ removed: [], reason: "owned-project-topology-mismatch" });
  }
  ${imageSelectionTopologyFunctions}
  for (var verifyIndex = 0; verifyIndex < owned.length; verifyIndex += 1) {
    var expected = owned[verifyIndex];
    var found = null;
    for (var findIndex = 1; findIndex <= app.project.numItems; findIndex += 1) {
      if (app.project.item(findIndex).id === expected.id) found = app.project.item(findIndex);
    }
    var foundKind = found instanceof CompItem ? "comp" : "footage";
    if (!found || found.name !== expected.name || foundKind !== expected.kind) {
      return JSON.stringify({ removed: [], reason: "owned-item-identity-mismatch", expected: expected });
    }
    if (JSON.stringify(snapshotItem(found)) !== JSON.stringify(expectedTopology[verifyIndex])) {
      return JSON.stringify({ removed: [], reason: "owned-item-topology-mismatch", expected: expected });
    }
  }
  var removed = [];
  var removeMatching = function (compsOnly) {
    for (var index = app.project.numItems; index >= 1; index -= 1) {
      var item = app.project.item(index);
      var isComp = item instanceof CompItem;
      for (var ownedIndex = 0; ownedIndex < owned.length; ownedIndex += 1) {
        if (item.id === owned[ownedIndex].id && (compsOnly ? isComp : !isComp)) {
          removed.push(item.name);
          item.remove();
          break;
        }
      }
    }
  };
  removeMatching(true);
  removeMatching(false);
  return JSON.stringify({ removed: removed });
})()`;

const imageSelectionProjectStateSource = `(function () {
  if (!app.project) return JSON.stringify({ exists: false });
  return JSON.stringify({
    exists: true,
    projectPath: app.project.file ? app.project.file.fsName : null,
    dirty: app.project.dirty,
    numItems: app.project.numItems
  });
})()`;

const archiveAndResetOwnedProjectSource = (runToken, archivePath) => `(function () {
  if ($.global.__CHROMA_FUNCTIONAL_PROJECT_OWNER__ !== ${JSON.stringify(runToken)} ||
      $.global.__CHROMA_FUNCTIONAL_PROJECT__ !== app.project) {
    return JSON.stringify({ reset: false, reason: "project-owner-mismatch" });
  }
  if (!app.project || app.project.file || app.project.numItems !== 0) {
    if (!app.project || app.project.file) {
      return JSON.stringify({ reset: false, reason: "project-not-owned-unsaved" });
    }
  }
  var archive = new File(${JSON.stringify(archivePath)});
  if (archive.exists) {
    return JSON.stringify({ reset: false, reason: "project-archive-already-exists" });
  }
  app.project.save(archive);
  if (!archive.exists || !app.project.file || app.project.file.fsName !== archive.fsName) {
    return JSON.stringify({ reset: false, reason: "project-archive-not-authoritative" });
  }
  var closed = app.project.close(CloseOptions.SAVE_CHANGES);
  if (closed !== true) {
    return JSON.stringify({ reset: false, reason: "project-close-refused" });
  }
  app.newProject();
  var reset = app.project && app.project.file === null &&
    app.project.dirty === false && app.project.numItems === 0;
  if (reset) {
    $.global.__CHROMA_FUNCTIONAL_PROJECT_OWNER__ = null;
    $.global.__CHROMA_FUNCTIONAL_PROJECT__ = null;
  }
  return JSON.stringify({
    reset: reset,
    archivePath: archive.fsName,
    projectPath: app.project.file ? app.project.file.fsName : null,
    dirty: app.project.dirty,
    numItems: app.project.numItems
  });
})()`;

const captureSetupTopologySource = (source, descriptorsSource) => `(function () {
  ${imageSelectionTopologyFunctions}
  var result = JSON.parse(${source});
  if (!result || result.ok !== true) return JSON.stringify(result);
  var descriptors = ${descriptorsSource};
  result.ownedTopology = [];
  for (var descriptorIndex = 0; descriptorIndex < descriptors.length; descriptorIndex += 1) {
    var descriptor = descriptors[descriptorIndex];
    var found = null;
    for (var itemIndex = 1; itemIndex <= app.project.numItems; itemIndex += 1) {
      if (app.project.item(itemIndex).id === descriptor.id) found = app.project.item(itemIndex);
    }
    var foundKind = found instanceof CompItem ? "comp" : "footage";
    if (!found || found.name !== descriptor.name || foundKind !== descriptor.kind) {
      return JSON.stringify({ ok: false, reason: "same-dispatch-topology-item-mismatch" });
    }
    result.ownedTopology.push(snapshotItem(found));
  }
  return JSON.stringify(result);
})()`;

const rawSetupColorFixtureSource = `(function () {
  return $.evalFile(new File(${JSON.stringify(COLOR_FIXTURE_SETUP_PATH)}));
})()`;

const setupColorFixtureSource = captureSetupTopologySource(
  rawSetupColorFixtureSource,
  `[{ id: result.compId, name: result.compName, kind: "comp" }]`
);

const rawSetupLayerImageFixtureSource = (fixture) => `(function () {
  var file = new File(${JSON.stringify(fixture.path)});
  if (!file.exists) return JSON.stringify({ ok: false, reason: "missing-file" });
  var imported = null;
  var comp = null;
  try {
    imported = app.project.importFile(new ImportOptions(file));
    imported.name = "CP_IMAGE_LAYER_PNG";
    comp = app.project.items.addComp("CP_IMAGE_LAYER_FIXTURE", 640, 360, 1, 2, 24);
    var layer = comp.layers.add(imported);
    layer.name = "CP_IMAGE_LAYER";
    comp.openInViewer();
    for (var itemIndex = 1; itemIndex <= app.project.numItems; itemIndex += 1) {
      app.project.item(itemIndex).selected = false;
    }
    layer.selected = true;
    return JSON.stringify({
      ok: true,
      compId: comp.id,
      itemId: imported.id,
      path: imported.file.fsName,
      selectedLayers: comp.selectedLayers.length,
      selectedItems: app.project.selection.length
    });
  } catch (error) {
    var importedId = imported ? imported.id : null;
    var compId = comp ? comp.id : null;
    var residualItems = [];
    for (var residualIndex = 1; residualIndex <= app.project.numItems; residualIndex += 1) {
      var residual = app.project.item(residualIndex);
      if (residual.id === compId) residualItems.push({ id: residual.id, name: residual.name, kind: "comp" });
      if (residual.id === importedId) residualItems.push({ id: residual.id, name: residual.name, kind: "footage" });
    }
    return JSON.stringify({
      ok: false,
      reason: "fixture-setup-failed",
      error: String(error),
      residualItems: residualItems
    });
  }
})()`;

const setupLayerImageFixtureSource = (fixture) => captureSetupTopologySource(
  rawSetupLayerImageFixtureSource(fixture),
  `[
    { id: result.compId, name: "CP_IMAGE_LAYER_FIXTURE", kind: "comp" },
    { id: result.itemId, name: "CP_IMAGE_LAYER_PNG", kind: "footage" }
  ]`
);

const selectLayerImageSource = (fixture, includeProjectItem) => `(function () {
  var comp = null;
  var item = null;
  for (var index = 1; index <= app.project.numItems; index += 1) {
    var candidate = app.project.item(index);
    candidate.selected = false;
    if (candidate.id === ${Number(fixture.compId)}) comp = candidate;
    if (candidate.id === ${Number(fixture.itemId)}) item = candidate;
  }
  if (!comp || !item) return JSON.stringify({ ok: false });
  comp.openInViewer();
  for (var layerIndex = 1; layerIndex <= comp.numLayers; layerIndex += 1) {
    comp.layer(layerIndex).selected = false;
  }
  comp.layer("CP_IMAGE_LAYER").selected = true;
  item.selected = ${includeProjectItem ? "true" : "false"};
  return JSON.stringify({
    ok: true,
    selectedLayers: comp.selectedLayers.length,
    selectedItems: app.project.selection.length
  });
})()`;

const rawImportProjectImageSource = (path, name) => `(function () {
  var file = new File(${JSON.stringify(path)});
  if (!file.exists) return JSON.stringify({ ok: false, reason: "missing-file" });
  var imported = null;
  try {
    imported = app.project.importFile(new ImportOptions(file));
    imported.name = ${JSON.stringify(name)};
    return JSON.stringify({
      ok: true,
      id: imported.id,
      name: imported.name,
      path: imported.file.fsName
    });
  } catch (error) {
    var importedId = imported ? imported.id : null;
    var residualItems = [];
    for (var residualIndex = 1; residualIndex <= app.project.numItems; residualIndex += 1) {
      var residual = app.project.item(residualIndex);
      if (residual.id === importedId) {
        residualItems.push({ id: residual.id, name: residual.name, kind: "footage" });
      }
    }
    return JSON.stringify({
      ok: false,
      reason: "image-import-failed",
      error: String(error),
      residualItems: residualItems
    });
  }
})()`;

const importProjectImageSource = (path, name) => captureSetupTopologySource(
  rawImportProjectImageSource(path, name),
  `[{ id: result.id, name: result.name, kind: "footage" }]`
);

const selectProjectImagesSource = (itemIds) => `(function () {
  var selectedIds = ${JSON.stringify(itemIds.map(Number))};
  var activeItem = app.project.activeItem;
  if (activeItem instanceof CompItem) {
    for (var layerIndex = 1; layerIndex <= activeItem.numLayers; layerIndex += 1) {
      activeItem.layer(layerIndex).selected = false;
    }
  }
  for (var itemIndex = 1; itemIndex <= app.project.numItems; itemIndex += 1) {
    var item = app.project.item(itemIndex);
    item.selected = false;
    for (var selectedIndex = 0; selectedIndex < selectedIds.length; selectedIndex += 1) {
      if (item.id === selectedIds[selectedIndex]) item.selected = true;
    }
  }
  return JSON.stringify({ selectedItems: app.project.selection.length });
})()`;

const selectMixedColorAndImageSource = (imageItemId) => `(function () {
  var comp = null;
  var image = null;
  for (var itemIndex = 1; itemIndex <= app.project.numItems; itemIndex += 1) {
    var item = app.project.item(itemIndex);
    item.selected = false;
    if (item.name === "CP_I07_I08_FIXTURE") comp = item;
    if (item.id === ${Number(imageItemId)}) image = item;
  }
  if (!comp || !image) return JSON.stringify({ ok: false });
  comp.openInViewer();
  for (var layerIndex = 1; layerIndex <= comp.numLayers; layerIndex += 1) {
    comp.layer(layerIndex).selected = false;
  }
  var shape = comp.layer("CP_COLOR_FIXTURE");
  var color = shape
    .property("ADBE Root Vectors Group")
    .property(1)
    .property("ADBE Vectors Group")
    .property(1)
    .property("ADBE Vector Fill Color");
  shape.selected = true;
  color.selected = true;
  image.selected = true;
  return JSON.stringify({
    ok: true,
    selectedLayers: comp.selectedLayers.length,
    selectedItems: app.project.selection.length,
    selectedProperties: shape.selectedProperties.length
  });
})()`;

const activateFixtureCompSource = `(function () {
  if (!app.project) return JSON.stringify({ activated: false });
  for (var itemIndex = 1; itemIndex <= app.project.numItems; itemIndex += 1) {
    var item = app.project.item(itemIndex);
    if (!(item instanceof CompItem)) continue;
    for (var layerIndex = 1; layerIndex <= item.numLayers; layerIndex += 1) {
      if (item.layer(layerIndex).name === "CP_COLOR_FIXTURE") {
        item.openInViewer();
        return JSON.stringify({ activated: true, id: item.id, name: item.name });
      }
    }
  }
  return JSON.stringify({ activated: false });
})()`;

const hostSnapshotSource = `(function () {
  var comp = app.project.activeItem;
  var shape = null;
  var secondShape = null;
  for (var index = 1; index <= comp.numLayers; index += 1) {
    if (comp.layer(index).name === "CP_COLOR_FIXTURE") shape = comp.layer(index);
    if (comp.layer(index).name === "CP_SECOND_COLOR_FIXTURE") secondShape = comp.layer(index);
  }
  var contents = shape.property("ADBE Root Vectors Group").property(1).property("ADBE Vectors Group");
  var disabledGroup = shape.property("ADBE Root Vectors Group").property("CP_DISABLED_GROUP");
  return JSON.stringify({
    fillA: contents.property(1).property("ADBE Vector Fill Color").value,
    fillB: contents.property(2).property("ADBE Vector Fill Color").value,
    secondColor: secondShape
      .property("ADBE Root Vectors Group")
      .property(1)
      .property("ADBE Vectors Group")
      .property(1)
      .property("ADBE Vector Fill Color")
      .value,
    disabledColor: disabledGroup
      .property("ADBE Vectors Group")
      .property(1)
      .property("ADBE Vector Fill Color")
      .value,
    disabledGroupEnabled: disabledGroup.enabled,
    selectedLayerCount: comp.selectedLayers.length,
    selectedPropertyCount: shape.selectedProperties.length
  });
})()`;

const applySnapshotSource = `(function () {
  var comp = app.project.activeItem;
  var shape = null;
  for (var index = 1; index <= comp.numLayers; index += 1) {
    if (comp.layer(index).name === "CP_COLOR_FIXTURE") shape = comp.layer(index);
  }
  var contents = shape.property("ADBE Root Vectors Group").property(1).property("ADBE Vectors Group");
  var staticColor = contents.property(1).property("ADBE Vector Fill Color");
  var expressionColor = contents.property(2).property("ADBE Vector Fill Color");
  var keyframedColor = contents.property(3).property("ADBE Vector Fill Color");
  return JSON.stringify({
    staticValue: staticColor.value,
    staticDimensions: staticColor.value.length,
    expressionValue: expressionColor.value,
    expression: expressionColor.expression,
    expressionEnabled: expressionColor.expressionEnabled,
    expressionKeys: expressionColor.numKeys,
    keyframedValue: keyframedColor.value,
    keyCount: keyframedColor.numKeys,
    keyOne: keyframedColor.keyValue(1),
    keyTwo: keyframedColor.keyValue(2),
    selectedLayerCount: comp.selectedLayers.length,
    selectedPropertyCount: shape.selectedProperties.length
  });
})()`;

const applyUndoCycleSource = `(function () {
  var snapshot = function () {
    var comp = app.project.activeItem;
    var shape = null;
    for (var index = 1; index <= comp.numLayers; index += 1) {
      if (comp.layer(index).name === "CP_COLOR_FIXTURE") shape = comp.layer(index);
    }
    var contents = shape.property("ADBE Root Vectors Group").property(1).property("ADBE Vectors Group");
    var staticColor = contents.property(1).property("ADBE Vector Fill Color");
    var expressionColor = contents.property(2).property("ADBE Vector Fill Color");
    var keyframedColor = contents.property(3).property("ADBE Vector Fill Color");
    return {
      staticValue: staticColor.value,
      staticDimensions: staticColor.value.length,
      expressionValue: expressionColor.value,
      expression: expressionColor.expression,
      expressionEnabled: expressionColor.expressionEnabled,
      expressionKeys: expressionColor.numKeys,
      keyframedValue: keyframedColor.value,
      keyCount: keyframedColor.numKeys,
      keyOne: keyframedColor.keyValue(1),
      keyTwo: keyframedColor.keyValue(2),
      selectedLayerCount: comp.selectedLayers.length,
      selectedPropertyCount: shape.selectedProperties.length
    };
  };
  var beforeUndo = snapshot();
  var commandId = 16;
  app.executeCommand(commandId);
  return JSON.stringify({ ok: true, commandId: commandId, beforeUndo: beforeUndo, afterUndo: snapshot() });
})()`;

const selectGroupSource = `(function () {
  var comp = app.project.activeItem;
  for (var layerIndex = 1; layerIndex <= comp.numLayers; layerIndex += 1) {
    var layer = comp.layer(layerIndex);
    var selected = layer.selectedProperties;
    for (var propertyIndex = selected.length - 1; propertyIndex >= 0; propertyIndex -= 1) {
      selected[propertyIndex].selected = false;
    }
    layer.selected = false;
  }
  var shape = null;
  for (var index = 1; index <= comp.numLayers; index += 1) {
    if (comp.layer(index).name === "CP_COLOR_FIXTURE") shape = comp.layer(index);
  }
  shape.selected = true;
  shape
    .property("ADBE Root Vectors Group")
    .property(1)
    .property("ADBE Vectors Group")
    .property(1)
    .selected = true;
  return JSON.stringify({ selected: shape.selectedProperties.length });
})()`;

const selectWholeLayersSource = `(function () {
  var comp = app.project.activeItem;
  var selectedNames = [];
  for (var layerIndex = 1; layerIndex <= comp.numLayers; layerIndex += 1) {
    var layer = comp.layer(layerIndex);
    var selected = layer.selectedProperties;
    for (var propertyIndex = selected.length - 1; propertyIndex >= 0; propertyIndex -= 1) {
      selected[propertyIndex].selected = false;
    }
    layer.selected = false;
  }
  for (var index = 1; index <= comp.numLayers; index += 1) {
    var candidate = comp.layer(index);
    if (
      candidate.name === "CP_COLOR_FIXTURE" ||
      candidate.name === "CP_SECOND_COLOR_FIXTURE"
    ) {
      candidate.selected = true;
      selectedNames.push(candidate.name);
    }
  }
  return JSON.stringify({
    selectedLayers: comp.selectedLayers.length,
    selectedNames: selectedNames
  });
})()`;

const selectDisabledGroupSource = `(function () {
  var comp = app.project.activeItem;
  var shape = null;
  for (var layerIndex = 1; layerIndex <= comp.numLayers; layerIndex += 1) {
    var layer = comp.layer(layerIndex);
    var selected = layer.selectedProperties;
    for (var propertyIndex = selected.length - 1; propertyIndex >= 0; propertyIndex -= 1) {
      selected[propertyIndex].selected = false;
    }
    layer.selected = false;
    if (layer.name === "CP_COLOR_FIXTURE") shape = layer;
  }
  var disabledGroup = shape.property("ADBE Root Vectors Group").property("CP_DISABLED_GROUP");
  shape.selected = true;
  disabledGroup.selected = true;
  return JSON.stringify({
    selectedLayers: comp.selectedLayers.length,
    selectedProperties: shape.selectedProperties.length,
    disabledGroupEnabled: disabledGroup.enabled,
    color: disabledGroup
      .property("ADBE Vectors Group")
      .property(1)
      .property("ADBE Vector Fill Color")
      .value
  });
})()`;

const deselectSource = `(function () {
  var comp = app.project.activeItem;
  for (var layerIndex = 1; layerIndex <= comp.numLayers; layerIndex += 1) {
    var layer = comp.layer(layerIndex);
    var selected = layer.selectedProperties;
    for (var propertyIndex = selected.length - 1; propertyIndex >= 0; propertyIndex -= 1) {
      selected[propertyIndex].selected = false;
    }
    layer.selected = false;
  }
  return JSON.stringify({ selectedLayers: comp.selectedLayers.length });
})()`;

const restoreSource = `(function () {
  var comp = app.project.activeItem;
  var shape = null;
  var text = null;
  for (var index = 1; index <= comp.numLayers; index += 1) {
    var layer = comp.layer(index);
    var selected = layer.selectedProperties;
    for (var propertyIndex = selected.length - 1; propertyIndex >= 0; propertyIndex -= 1) {
      selected[propertyIndex].selected = false;
    }
    layer.selected = false;
    if (comp.layer(index).name === "CP_COLOR_FIXTURE") shape = comp.layer(index);
    if (comp.layer(index).name === "CP_TEXT_FIXTURE") text = comp.layer(index);
  }
  var contents = shape.property("ADBE Root Vectors Group").property(1).property("ADBE Vectors Group");
  shape.selected = true;
  text.selected = true;
  contents.property(1).property("ADBE Vector Fill Color").selected = true;
  contents.property(2).property("ADBE Vector Fill Color").selected = true;
  contents.property(3).property("ADBE Vector Fill Color").selected = true;
  contents.property(4).property("ADBE Vector Grad Colors").selected = true;
  text.property("ADBE Text Properties").property("ADBE Text Document").selected = true;
  return JSON.stringify({ selectedLayers: comp.selectedLayers.length });
})()`;

const getConsoleEvidence = (events) => ({
  console: events
    .filter((event) => event.method === "Runtime.consoleAPICalled")
    .map((event) => ({
      type: event.params.type,
      values: event.params.args.map((value) => value.value ?? value.description ?? null),
    })),
  exceptions: events
    .filter((event) => event.method === "Runtime.exceptionThrown")
    .map((event) => event.params.exceptionDetails),
  logs: events
    .filter((event) => event.method === "Log.entryAdded")
    .map((event) => event.params.entry),
});

export const finalizeFunctionalSmoke = async ({
  primaryError = null,
  cleanupSteps = [],
  publishSuccess,
  writeFailure,
}) => {
  const cleanupErrors = [];
  for (const { phase, run: cleanup } of cleanupSteps) {
    try {
      await cleanup();
    } catch (error) {
      cleanupErrors.push({ phase, error: String(error?.stack || error) });
    }
  }
  if (!primaryError && cleanupErrors.length === 0) {
    try {
      await publishSuccess();
      return;
    } catch (error) {
      primaryError = error;
    }
  }
  try {
    await writeFailure({ primaryError, cleanupErrors });
  } catch (error) {
    cleanupErrors.push({ phase: "write-failure", error: String(error?.stack || error) });
  }

  if (primaryError) {
    if (cleanupErrors.length > 0 && (typeof primaryError === "object" || typeof primaryError === "function")) {
      try { primaryError.cleanupErrors = cleanupErrors; } catch {}
    }
    throw primaryError;
  }
  throw new AggregateError(
    cleanupErrors.map(({ error }) => new Error(error)),
    "Functional smoke cleanup failed"
  );
};

export const replaceFunctionalSmokeReport = async ({
  reportPath,
  pendingReportPath,
  report,
  beforeCommit = async () => undefined,
}) => {
  await writeFile(pendingReportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  try {
    await beforeCommit();
    await rm(reportPath, { force: true });
    await rename(pendingReportPath, reportPath);
  } catch (error) {
    await rm(pendingReportPath, { force: true }).catch(() => undefined);
    throw error;
  }
};

const run = async () => {
  const outputRun = await createOwnedRunDirectory(resolve(REPO_ROOT, requestedOutput));
  const outputDirectory = outputRun.path;
  let client;
  let configRun;
  let originalConfigRoot = null;
  let configMutationAttempted = false;
  let configRestored = false;
  let imageSelectionCleanupRequired = false;
  let imageSelectionProjectResetRequired = false;
  let imageSelectionHostStateKnown = true;
  let runtimeEvaluationGuard = null;
  const runtimeEvaluationCompletionKnown = () =>
    runtimeEvaluationGuard?.isCompletionKnown() !== false;
  const imageSelectionOwnedItems = [];
  const imageSelectionOwnedTopology = [];
  let primaryError = null;
  let successPublication = null;
  const runId = `${process.pid}-${Date.now()}`;
  const reportPath = resolve(outputDirectory, "report.json");
  const failurePath = resolve(outputDirectory, "failure.json");
  const pendingReportPath = resolve(outputDirectory, `.report-${runId}.pending.json`);
  const dispatchHostActionAndWait = async (expression) => {
    imageSelectionHostStateKnown = false;
    const accepted = await client.evaluate(debugCall(expression));
    const state = await waitForHostIdle(client, runtimeEvaluationGuard);
    imageSelectionHostStateKnown = true;
    return { accepted, state };
  };

  try {
    await mkdir(outputDirectory, { recursive: true });
    await replaceFunctionalSmokeReport({
      reportPath,
      pendingReportPath,
      report: {
        capturedAt: new Date().toISOString(),
        passed: false,
        status: "running",
        mode,
        runId,
      },
    });
    await rm(failurePath, { force: true });
    if (modeValidationError) throw modeValidationError;
    configRun = await createOwnedTemporaryConfigDirectory({
      tokenPrefix: `chroma-relay-functional-${mode}`,
    });
    temporaryRoot = configRun.path;
    const initialDocument = {
      schemaVersion: 1,
      revision: 0,
      colors:
        mode === "apply"
          ? [{ id: "apply-exact", rgba: APPLY_RGBA }]
          : mode === "mutate"
            ? MUTATION_COLORS
            : [],
    };
    await writeFile(
      resolve(temporaryRoot, "palette.json"),
      `${JSON.stringify(initialDocument, null, 2)}\n`
    );
    await writeFile(
      resolve(temporaryRoot, "settings.json"),
      `${JSON.stringify(
        {
          schemaVersion: 2,
          revision: 0,
          layoutMode: "stretch",
          swatchSize: 32,
          includeDisabledColors: false,
        },
        null,
        2
      )}\n`
    );

    const response = await fetch("http://127.0.0.1:8198/json/list", {
      signal: AbortSignal.timeout(3000),
    });
    const targets = await response.json();
    const target = await selectCanonicalCdpTarget(
      targets,
      resolve(REPO_ROOT, "dist/cep/main/index.html"),
      { label: "functional smoke Main" }
    );
    client = new CdpClient(target.webSocketDebuggerUrl);
    await client.connect();
    await Promise.all([
      client.send("Runtime.enable"),
      client.send("Log.enable"),
      client.send("Page.enable"),
    ]);
    runtimeEvaluationGuard = guardClientEvaluations(client, "functional smoke Main");
    await waitForStableDebug(client, runtimeEvaluationGuard);
    const baselineIdentity = await assertFunctionalRuntime(client, "functional smoke Main baseline runtime");
    originalConfigRoot = baselineIdentity.configRoot ?? null;
    client.events = [];
    await client.send("Page.reload", { ignoreCache: true });
    await waitForStableDebug(client, runtimeEvaluationGuard);
    await afterRender(client);
    const initialIdentity = await assertFunctionalRuntime(client);
    if ((initialIdentity.configRoot ?? null) !== originalConfigRoot) {
      throw new Error("Functional smoke config root changed during authenticated reload");
    }
    configMutationAttempted = true;
    imageSelectionHostStateKnown = false;
    await client.evaluate(
      debugCall(`(api) => api.setTemporaryConfigRoot(${JSON.stringify(temporaryRoot)})`)
    );
    await afterRender(client);
    const temporaryIdentity = await assertFunctionalRuntime(
      client,
      "functional smoke Main temporary config runtime"
    );
    if (temporaryIdentity.configRoot !== temporaryRoot) {
      throw new Error(
        `Functional smoke temporary config root readback failed: ${JSON.stringify(temporaryIdentity)}`
      );
    }
    imageSelectionHostStateKnown = true;

    if (mode === "mutate") {
      const initialSnapshot = await client.evaluate(
        debugCall("(api) => ({ state: api.getState(), counters: api.getCounters() })")
      );
      const removeDispatched = await client.evaluate(`(() => {
        const swatch = document.querySelector("[data-testid=swatch-b]");
        if (!swatch) return false;
        return swatch.dispatchEvent(
          new MouseEvent("click", { altKey: true, bubbles: true, cancelable: true })
        );
      })()`);
      const afterRemove = await waitForMutationRevision(client, 1, runtimeEvaluationGuard);
      if (
        removeDispatched !== true ||
        afterRemove.state.palette.map((color) => color.id).join(",") !== "a,c,d" ||
        afterRemove.counters.diskWrites !== 1 ||
        afterRemove.counters.hostCalls !== 0
      ) {
        throw new Error(`Single-click removal failed: ${JSON.stringify(afterRemove)}`);
      }

      const keyboardReorderDispatched = await client.evaluate(`(() => {
        const swatch = document.querySelector("[data-testid=swatch-d]");
        swatch.focus();
        return swatch.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "ArrowLeft",
            code: "ArrowLeft",
            altKey: true,
            bubbles: true,
            cancelable: true
          })
        );
      })()`);
      const afterKeyboardReorder = await waitForMutationRevision(client, 2, runtimeEvaluationGuard);
      if (
        keyboardReorderDispatched !== false ||
        afterKeyboardReorder.state.palette.map((color) => color.id).join(",") !== "a,d,c" ||
        afterKeyboardReorder.counters.diskWrites !== 2 ||
        afterKeyboardReorder.counters.hostCalls !== 0
      ) {
        throw new Error(`Keyboard reorder failed: ${JSON.stringify(afterKeyboardReorder)}`);
      }

      const dragStartDispatched = await client.evaluate(`(() => {
        const source = document.querySelector("[data-testid=swatch-a]");
        if (!source) return false;
        window.__chromaRelayMutationTransfer = new DataTransfer();
        const bounds = source.getBoundingClientRect();
        source.dispatchEvent(new DragEvent("dragstart", {
          bubbles: true,
          cancelable: true,
          clientX: bounds.left + bounds.width / 2,
          clientY: bounds.top + bounds.height / 2,
          dataTransfer: window.__chromaRelayMutationTransfer
        }));
        return true;
      })()`);
      await afterRender(client);
      const dragOverDispatched = await client.evaluate(`(() => {
        const target = document.querySelector("[data-testid=swatch-c]");
        if (!target || !window.__chromaRelayMutationTransfer) return false;
        const bounds = target.getBoundingClientRect();
        target.dispatchEvent(new DragEvent("dragover", {
          bubbles: true,
          cancelable: true,
          clientX: bounds.right - 1,
          clientY: bounds.top + bounds.height / 2,
          dataTransfer: window.__chromaRelayMutationTransfer
        }));
        return true;
      })()`);
      await afterRender(client);
      const dropDispatched = await client.evaluate(`(() => {
        const target = document.querySelector("[data-testid=swatch-c]");
        if (!target || !window.__chromaRelayMutationTransfer) return false;
        const bounds = target.getBoundingClientRect();
        target.dispatchEvent(new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          clientX: bounds.right - 1,
          clientY: bounds.top + bounds.height / 2,
          dataTransfer: window.__chromaRelayMutationTransfer
        }));
        return true;
      })()`);
      const afterDrag = await waitForMutationRevision(client, 3, runtimeEvaluationGuard);
      await client.evaluate(`(() => {
        const source = document.querySelector("[data-testid=swatch-a]");
        if (source && window.__chromaRelayMutationTransfer) {
          source.dispatchEvent(new DragEvent("dragend", {
            bubbles: true,
            cancelable: true,
            dataTransfer: window.__chromaRelayMutationTransfer
          }));
        }
        delete window.__chromaRelayMutationTransfer;
        return true;
      })()`);
      if (
        dragStartDispatched !== true ||
        dragOverDispatched !== true ||
        dropDispatched !== true ||
        afterDrag.state.palette.map((color) => color.id).join(",") !== "d,c,a" ||
        afterDrag.counters.diskWrites !== 3 ||
        afterDrag.counters.hostCalls !== 0
      ) {
        throw new Error(
          `Drag reorder failed: ${JSON.stringify({
            dragStartDispatched,
            dragOverDispatched,
            dropDispatched,
            afterDrag,
          })}`
        );
      }

      const keyboardFocusProof = await client.evaluate(`(() => {
        const swatch = document.querySelector("[data-testid=swatch-d]");
        swatch.focus();
        return {
          swatchTabIndex: swatch.tabIndex,
          activeTestId: document.activeElement.dataset.testid || null
        };
      })()`);
      const keyboardRemoveDispatched = await client.evaluate(`(() => {
        const swatch = document.querySelector("[data-testid=swatch-d]");
        return swatch.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            code: "Enter",
            altKey: true,
            bubbles: true,
            cancelable: true
          })
        );
      })()`);
      const afterKeyboardRemove = await waitForMutationRevision(client, 4, runtimeEvaluationGuard);
      const keyboardRemovalFocus = await client.evaluate(
        "document.activeElement?.dataset?.testid || null"
      );
      if (
        keyboardFocusProof.swatchTabIndex !== 0 ||
        keyboardFocusProof.activeTestId !== "swatch-d" ||
        keyboardRemoveDispatched !== false ||
        keyboardRemovalFocus !== "swatch-c" ||
        afterKeyboardRemove.state.palette.map((color) => color.id).join(",") !== "c,a" ||
        afterKeyboardRemove.counters.diskWrites !== 4 ||
        afterKeyboardRemove.counters.hostCalls !== 0
      ) {
        throw new Error(
          `Alt+Enter single-action removal failed: ${JSON.stringify({
            keyboardFocusProof,
            keyboardRemoveDispatched,
            keyboardRemovalFocus,
            afterKeyboardRemove,
          })}`
        );
      }

      await delay(2750);
      await afterRender(client);
      const clearedNotice = await client.evaluate(
        debugCall(`(api) => ({
          lastResult: api.getState().lastResult,
          statusText: document.querySelector(".palette-status").textContent
        })`)
      );
      if (clearedNotice.lastResult !== null || clearedNotice.statusText !== "") {
        throw new Error(`Mutation notice did not auto-clear: ${JSON.stringify(clearedNotice)}`);
      }

      const stored = JSON.parse(await readFile(resolve(temporaryRoot, "palette.json"), "utf8"));
      if (
        stored.revision !== 4 ||
        activePaletteItems(stored).map((color) => color.id).join(",") !== "c,a"
      ) {
        throw new Error(`Persisted mutation order is wrong: ${JSON.stringify(stored)}`);
      }

      await assertFunctionalRuntime(client, "functional smoke pre-mutation-reload runtime");
      await client.send("Page.reload", { ignoreCache: true });
      await waitForStableDebug(client, runtimeEvaluationGuard);
      await assertFunctionalRuntime(client, "functional smoke post-mutation-reload runtime");
      await client.evaluate(
        debugCall(`(api) => api.setTemporaryConfigRoot(${JSON.stringify(temporaryRoot)})`)
      );
      const afterReload = await waitForReloadedPalette(
        client,
        temporaryRoot,
        4,
        runtimeEvaluationGuard
      );
      if (
        afterReload.paletteRevision !== 4 ||
        afterReload.palette.map((color) => color.id).join(",") !== "c,a"
      ) {
        throw new Error(`Mutation reload failed: ${JSON.stringify(afterReload)}`);
      }

      const screenshot = await client.send("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false,
      });
      await writeFile(
        resolve(outputDirectory, "main-mutated.png"),
        Buffer.from(screenshot.data, "base64")
      );
      const consoleEvidence = getConsoleEvidence(client.events);
      const errors = consoleEvidence.console.filter((entry) =>
        ["error", "assert"].includes(entry.type)
      );
      const logErrors = consoleEvidence.logs.filter((entry) => entry.level === "error");
      if (errors.length || logErrors.length || consoleEvidence.exceptions.length) {
        throw new Error("Main emitted console, log, or runtime errors during mutation smoke");
      }
      const report = {
        capturedAt: new Date().toISOString(),
        passed: true,
        mode,
        temporaryRoot,
        initialSnapshot,
        removeDispatched,
        afterRemove,
        afterKeyboardReorder,
        dragStartDispatched,
        dragOverDispatched,
        dropDispatched,
        afterDrag,
        keyboardFocusProof,
        keyboardRemoveDispatched,
        keyboardRemovalFocus,
        afterKeyboardRemove,
        clearedNotice,
        stored,
        afterReload,
        consoleEvidence,
        screenshots: ["main-mutated.png"],
      };
      successPublication = { report, summary: { passed: true, mode, outputDirectory } };
      return;
    }

    let evalImageHost = null;
    if (mode === "image-selection" || mode === "image") {
      const projectState = await evalHost(client, claimImageSelectionProjectSource(runId));
      if (
        projectState.ok !== true ||
        projectState.projectPath !== null ||
        projectState.dirty !== false ||
        projectState.numItems !== 0
      ) {
        throw new Error(
          `${mode} requires an empty clean unsaved project: ${JSON.stringify(projectState)}`
        );
      }
      imageSelectionProjectResetRequired = true;
      imageSelectionCleanupRequired = true;
      evalImageHost = (source) =>
        (async () => {
          imageSelectionHostStateKnown = false;
          const result = await evalHost(
            client,
            guardImageSelectionProjectSource(runId, source)
          );
          imageSelectionHostStateKnown = true;
          return result;
        })();
    }

    if (mode === "image-selection") {
      const staleCleanup = { removed: [] };
      const captureNewOwnedTopology = (items, setupResult) => {
        if (setupResult.ownedTopology?.length !== items.length) {
          throw new Error(`Owned image fixture same-dispatch topology capture failed: ${JSON.stringify(setupResult)}`);
        }
        for (let index = 0; index < items.length; index += 1) {
          requireCondition(
            setupResult.ownedTopology[index]?.id === items[index].id &&
              setupResult.ownedTopology[index]?.name === items[index].name &&
              setupResult.ownedTopology[index]?.kind === items[index].kind,
            `Owned image fixture topology descriptor drifted: ${JSON.stringify({ item: items[index], topology: setupResult.ownedTopology[index] })}`
          );
        }
        imageSelectionOwnedTopology.push(...setupResult.ownedTopology);
      };
      const recordResidualItems = (result) => {
        if (!Array.isArray(result?.residualItems)) return;
        for (const item of result.residualItems) {
          if (
            Number.isInteger(item?.id) &&
            item.id > 0 &&
            typeof item.name === "string" &&
            (item.kind === "comp" || item.kind === "footage")
          ) {
            imageSelectionOwnedItems.push(item);
          }
        }
      };
      const pngFixture = IMAGE_FIXTURES.find((fixture) => fixture.format === "png");
      const jpgFixture = IMAGE_FIXTURES.find((fixture) => fixture.format === "jpg");
      const pngBytes = await readFile(pngFixture.path);
      const unsupportedPath = resolve(temporaryRoot, "fixture.gif");
      const corruptPath = resolve(temporaryRoot, "corrupt.png");
      await writeFile(
        unsupportedPath,
        Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64")
      );
      await writeFile(corruptPath, pngBytes);

      const colorFixture = await evalImageHost(setupColorFixtureSource);
      recordResidualItems(colorFixture);
      if (colorFixture.ok) {
        const colorOwnedItem = { id: colorFixture.compId, name: colorFixture.compName, kind: "comp" };
        imageSelectionOwnedItems.push(colorOwnedItem);
        captureNewOwnedTopology([colorOwnedItem], colorFixture);
      } else {
        throw new Error(`Color selection fixture setup failed: ${JSON.stringify(colorFixture)}`);
      }
      const layerFixture = await evalImageHost(setupLayerImageFixtureSource(pngFixture));
      recordResidualItems(layerFixture);
      if (layerFixture.ok) {
        const layerOwnedItems = [
          { id: layerFixture.compId, name: "CP_IMAGE_LAYER_FIXTURE", kind: "comp" },
          { id: layerFixture.itemId, name: "CP_IMAGE_LAYER_PNG", kind: "footage" }
        ];
        imageSelectionOwnedItems.push(...layerOwnedItems);
        captureNewOwnedTopology(layerOwnedItems, layerFixture);
      } else {
        throw new Error(`Layer image fixture setup failed: ${JSON.stringify(layerFixture)}`);
      }

      const cases = [];
      const executeCase = async (name, prepare) => {
        await resetImageSelectionCase(client);
        const selection = await prepare();
        const probe = await evalImageHost(
          `(function () {
            try {
              return JSON.stringify($["com.zimoby.chroma-relay"].resolvePaletteAddSelection(false));
            } catch (error) {
              return JSON.stringify({
                probeError: String(error),
                line: error.line || null,
                fileName: error.fileName || null
              });
            }
          })()`
        );
        if (probe.probeError) {
          throw new Error(`${name} host probe failed: ${JSON.stringify(probe)}`);
        }
        const startedAt = Date.now();
        imageSelectionHostStateKnown = false;
        const accepted = await client.evaluate(
          debugCall('(api) => api.dispatchClick("palette-add")')
        );
        const state = await waitForHostIdle(client, runtimeEvaluationGuard);
        const elapsedMs = Date.now() - startedAt;
        const snapshot = await client.evaluate(
          debugCall("(api) => ({ state: api.getState(), counters: api.getCounters() })")
        );
        imageSelectionHostStateKnown =
          accepted === true &&
          snapshot?.state?.pendingHostAction === null &&
          snapshot?.counters?.hostCalls === 1;
        const stored = JSON.parse(
          await readFile(resolve(temporaryRoot, "palette.json"), "utf8")
        );
        const result = { name, selection, probe, accepted, elapsedMs, state, snapshot, stored };
        cases.push(result);
        await writeFile(
          resolve(outputDirectory, "selection-progress.json"),
          `${JSON.stringify({ passedCases: cases }, null, 2)}\n`
        );
        return result;
      };

      const layerSource = await executeCase("selected-layer-source", () =>
        evalImageHost(selectLayerImageSource(layerFixture, false))
      );
      if (
        !layerSource.selection.ok ||
        layerSource.selection.selectedLayers !== 1 ||
        layerSource.selection.selectedItems !== 0 ||
        layerSource.probe.colors.status !== "no-supported-colors" ||
        layerSource.probe.image.status !== "ok" ||
        layerSource.probe.image.path !== layerFixture.path ||
        layerSource.probe.image.selectedImageCount !== 1 ||
        layerSource.accepted !== true ||
        layerSource.snapshot.counters.hostCalls !== 1 ||
        layerSource.snapshot.counters.diskWrites !== 1 ||
        layerSource.state.palette.length !== 5 ||
        layerSource.stored.revision !== 1 ||
        activePaletteItems(layerSource.stored).length !== 5
      ) {
        throw new Error(`Selected-layer source case failed: ${JSON.stringify(layerSource)}`);
      }

      const dedupedSource = await executeCase("project-layer-same-source-deduped", () =>
        evalImageHost(selectLayerImageSource(layerFixture, true))
      );
      if (
        !dedupedSource.selection.ok ||
        dedupedSource.selection.selectedLayers !== 1 ||
        dedupedSource.selection.selectedItems !== 1 ||
        dedupedSource.probe.image.status !== "ok" ||
        dedupedSource.probe.image.selectedImageCount !== 1 ||
        dedupedSource.snapshot.counters.diskWrites !== 1 ||
        dedupedSource.state.palette.length !== 5
      ) {
        throw new Error(`Project/layer dedupe case failed: ${JSON.stringify(dedupedSource)}`);
      }

      const secondImage = await evalImageHost(
        importProjectImageSource(jpgFixture.path, "CP_IMAGE_SECOND_JPG")
      );
      recordResidualItems(secondImage);
      if (!secondImage.ok) throw new Error(`Second image import failed: ${JSON.stringify(secondImage)}`);
      const secondOwnedItem = { id: secondImage.id, name: secondImage.name, kind: "footage" };
      imageSelectionOwnedItems.push(secondOwnedItem);
      captureNewOwnedTopology([secondOwnedItem], secondImage);
      const multipleImages = await executeCase("multiple-images-rejected", () =>
        evalImageHost(selectProjectImagesSource([layerFixture.itemId, secondImage.id]))
      );
      if (
        multipleImages.selection.selectedItems !== 2 ||
        multipleImages.probe.image.status !== "multiple-images" ||
        multipleImages.probe.image.selectedImageCount !== 2 ||
        multipleImages.state.lastResult !== "Select one image at a time" ||
        multipleImages.snapshot.counters.hostCalls !== 1 ||
        multipleImages.snapshot.counters.diskWrites !== 0 ||
        multipleImages.state.palette.length !== 0 ||
        multipleImages.stored.revision !== 0
      ) {
        throw new Error(`Multiple-image rejection failed: ${JSON.stringify(multipleImages)}`);
      }

      const mixedSelection = await executeCase("colors-and-image-rejected", () =>
        evalImageHost(selectMixedColorAndImageSource(layerFixture.itemId))
      );
      if (
        !mixedSelection.selection.ok ||
        mixedSelection.probe.colors.status !== "ok" ||
        mixedSelection.probe.image.status !== "ok" ||
        mixedSelection.probe.image.selectedImageCount !== 1 ||
        mixedSelection.state.lastResult !== "Choose selected colors or one image, not both" ||
        mixedSelection.snapshot.counters.hostCalls !== 1 ||
        mixedSelection.snapshot.counters.diskWrites !== 0 ||
        mixedSelection.state.palette.length !== 0 ||
        mixedSelection.stored.revision !== 0
      ) {
        throw new Error(`Mixed color/image rejection failed: ${JSON.stringify(mixedSelection)}`);
      }

      const unsupportedImage = await evalImageHost(
        importProjectImageSource(unsupportedPath, "CP_IMAGE_UNSUPPORTED_GIF")
      );
      recordResidualItems(unsupportedImage);
      if (!unsupportedImage.ok) {
        throw new Error(`Unsupported image import failed: ${JSON.stringify(unsupportedImage)}`);
      }
      const unsupportedOwnedItem = {
        id: unsupportedImage.id,
        name: unsupportedImage.name,
        kind: "footage",
      };
      imageSelectionOwnedItems.push(unsupportedOwnedItem);
      captureNewOwnedTopology([unsupportedOwnedItem], unsupportedImage);
      const unsupported = await executeCase("unsupported-gif-rejected", () =>
        evalImageHost(selectProjectImagesSource([unsupportedImage.id]))
      );
      if (
        unsupported.selection.selectedItems !== 1 ||
        unsupported.probe.image.status !== "unsupported-image" ||
        unsupported.probe.image.format !== "gif" ||
        unsupported.state.lastResult !== "GIF is not supported; choose JPEG or PNG" ||
        unsupported.snapshot.counters.hostCalls !== 1 ||
        unsupported.snapshot.counters.diskWrites !== 0 ||
        unsupported.state.palette.length !== 0 ||
        unsupported.stored.revision !== 0
      ) {
        throw new Error(`Unsupported-image rejection failed: ${JSON.stringify(unsupported)}`);
      }

      const corruptImage = await evalImageHost(
        importProjectImageSource(corruptPath, "CP_IMAGE_CORRUPT_PNG")
      );
      recordResidualItems(corruptImage);
      if (!corruptImage.ok) {
        throw new Error(`Corrupt image setup import failed: ${JSON.stringify(corruptImage)}`);
      }
      const corruptOwnedItem = { id: corruptImage.id, name: corruptImage.name, kind: "footage" };
      imageSelectionOwnedItems.push(corruptOwnedItem);
      captureNewOwnedTopology([corruptOwnedItem], corruptImage);
      await writeFile(corruptPath, "not a valid PNG");
      const corrupt = await executeCase("corrupt-png-decode-rejected", () =>
        evalImageHost(selectProjectImagesSource([corruptImage.id]))
      );
      if (
        corrupt.selection.selectedItems !== 1 ||
        corrupt.probe.image.status !== "ok" ||
        corrupt.probe.image.path !== corruptImage.path ||
        corrupt.state.lastResult !== "Could not extract colors from the selected image" ||
        corrupt.snapshot.counters.hostCalls !== 1 ||
        corrupt.snapshot.counters.diskWrites !== 0 ||
        corrupt.state.palette.length !== 0 ||
        corrupt.stored.revision !== 0
      ) {
        throw new Error(`Corrupt-image rejection failed: ${JSON.stringify(corrupt)}`);
      }

      const screenshot = await client.send("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false,
      });
      await writeFile(
        resolve(outputDirectory, "main-selection-gates.png"),
        Buffer.from(screenshot.data, "base64")
      );
      const cleanup = {
        deferredToProjectArchive: true,
        archive: "preserved-functional-project.aep",
        ownedItemCount: imageSelectionOwnedItems.length,
      };

      const consoleEvidence = getConsoleEvidence(client.events);
      const errors = consoleEvidence.console.filter((entry) =>
        ["error", "assert"].includes(entry.type)
      );
      const logErrors = consoleEvidence.logs.filter((entry) => entry.level === "error");
      if (errors.length || logErrors.length || consoleEvidence.exceptions.length) {
        throw new Error("Main emitted console, log, or runtime errors during selection smoke");
      }
      const report = {
        capturedAt: new Date().toISOString(),
        passed: true,
        mode,
        temporaryRoot,
        staleCleanup,
        colorFixture,
        layerFixture,
        cases,
        cleanup,
        consoleEvidence,
        screenshots: ["main-selection-gates.png"],
      };
      successPublication = {
        report,
        summary: { passed: true, mode, cases: cases.length, outputDirectory },
      };
      return;
    }

    if (mode === "image") {
      const cases = [];
      for (const fixture of IMAGE_FIXTURES) {
        for (const preset of IMAGE_PRESETS) {
          await writeFile(
            resolve(temporaryRoot, "palette.json"),
            `${JSON.stringify({ schemaVersion: 1, revision: 0, colors: [] }, null, 2)}\n`
          );
          await writeFile(
            resolve(temporaryRoot, "settings.json"),
            `${JSON.stringify(
              {
                schemaVersion: 3,
                revision: 1,
                layoutMode: "fixed",
                swatchSize: 40,
                includeDisabledColors: false,
                extractionPreset: preset,
              },
              null,
              2
            )}\n`
          );
          await client.evaluate(debugCall("(api) => api.resetTestState()"));
          await afterRender(client);
          await client.evaluate(
            debugCall(`(api) => api.setTemporaryConfigRoot(${JSON.stringify(temporaryRoot)})`)
          );
          await afterRender(client);

          let imported = null;
          try {
            imported = await evalImageHost(importSelectedImageSource(fixture));
            if (!imported.ok || imported.selectedItems !== 1) {
              throw new Error(`Image fixture selection failed: ${JSON.stringify(imported)}`);
            }
            const startedAt = Date.now();
            imageSelectionHostStateKnown = false;
            const accepted = await client.evaluate(
              debugCall('(api) => api.dispatchClick("palette-add")')
            );
            const state = await waitForHostIdle(client, runtimeEvaluationGuard);
            imageSelectionHostStateKnown = true;
            const elapsedMs = Date.now() - startedAt;
            const snapshot = await client.evaluate(
              debugCall("(api) => ({ state: api.getState(), counters: api.getCounters() })")
            );
            const stored = JSON.parse(
              await readFile(resolve(temporaryRoot, "palette.json"), "utf8")
            );
            const result = state.lastHostResult;
            if (
              accepted !== true ||
              snapshot.counters.hostCalls !== 1 ||
              snapshot.counters.diskWrites !== 1 ||
              state.settings.extractionPreset !== preset ||
              result?.image?.status !== "ok" ||
              result.image.path !== imported.path ||
              result.image.format !== fixture.format ||
              result?.extraction?.preset !== preset ||
              result.extraction.colors.length !== 5 ||
              result.extraction.colors.some((color) => color[3] <= 0) ||
              result.extraction.inputPixelCount <= 0 ||
              result.extraction.inputPixelCount > 65536 ||
              result.extraction.uniqueColorCount <= 5 ||
              state.palette.length !== 5 ||
              stored.revision !== 1 ||
              activePaletteItems(stored).length !== 5 ||
              state.lastResult !== null
            ) {
              throw new Error(
                `Image extraction assertion failed: ${JSON.stringify({
                  fixture,
                  preset,
                  imported,
                  accepted,
                  elapsedMs,
                  state,
                  counters: snapshot.counters,
                  stored,
                })}`
              );
            }
            cases.push({
              fixture,
              preset,
              imported,
              elapsedMs,
              state,
              counters: snapshot.counters,
              stored,
            });
            await writeFile(
              resolve(outputDirectory, "progress.json"),
              `${JSON.stringify({ passedCases: cases }, null, 2)}\n`
            );
          } catch (error) {
            throw error;
          }
        }
      }

      for (const fixture of IMAGE_FIXTURES) {
        const signatures = cases
          .filter((entry) => entry.fixture.format === fixture.format)
          .map((entry) => JSON.stringify(entry.state.lastHostResult.extraction.colors));
        if (new Set(signatures).size < 2) {
          throw new Error(`${fixture.format.toUpperCase()} presets did not produce distinct palettes`);
        }
      }

      const visualGeometry = await client.evaluate(`(() => {
        const root = document.querySelector(".chroma-relay-panel");
        const stage = document.querySelector(".palette-stage").getBoundingClientRect();
        const swatches = Array.from(document.querySelectorAll(".palette-swatch-shell"));
        const last = swatches[swatches.length - 1].getBoundingClientRect();
        const add = document.querySelector(".palette-add").getBoundingClientRect();
        const status = document.querySelector(".palette-status").getBoundingClientRect();
        return {
          orientation: root.dataset.orientation,
          swatchCount: swatches.length,
          addAfterLast:
            root.dataset.orientation === "horizontal"
              ? add.left >= last.right
              : add.top >= last.bottom,
          addInsideStage:
            add.right <= stage.right + 0.5 &&
            add.top >= stage.top - 0.5 &&
            add.bottom <= stage.bottom + 0.5,
          statusDoesNotCoverAdd:
            status.bottom <= add.top ||
            status.top >= add.bottom ||
            status.right <= add.left ||
            status.left >= add.right
        };
      })()`);
      if (
        visualGeometry.swatchCount !== 5 ||
        visualGeometry.addAfterLast !== true ||
        visualGeometry.addInsideStage !== true ||
        visualGeometry.statusDoesNotCoverAdd !== true
      ) {
        throw new Error(`Image extraction fixture geometry failed: ${JSON.stringify(visualGeometry)}`);
      }

      const screenshot = await client.send("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false,
      });
      await writeFile(
        resolve(outputDirectory, "main-image-extracted.png"),
        Buffer.from(screenshot.data, "base64")
      );
      const consoleEvidence = getConsoleEvidence(client.events);
      const errors = consoleEvidence.console.filter((entry) =>
        ["error", "assert"].includes(entry.type)
      );
      const logErrors = consoleEvidence.logs.filter((entry) => entry.level === "error");
      if (errors.length || logErrors.length || consoleEvidence.exceptions.length) {
        throw new Error("Main emitted console, log, or runtime errors during image extraction smoke");
      }
      const report = {
        capturedAt: new Date().toISOString(),
        passed: true,
        mode,
        temporaryRoot,
        cases,
        visualGeometry,
        consoleEvidence,
        screenshots: ["main-image-extracted.png"],
      };
      successPublication = {
        report,
        summary: { passed: true, mode, cases: cases.length, outputDirectory },
      };
      return;
    }

    if (mode === "apply") {
      const activated = await evalHost(client, activateFixtureCompSource);
      if (!activated.activated) throw new Error("AE fixture comp was not found before apply");
      const initialRestore = await evalHost(client, restoreSource);
      if (initialRestore.selectedLayers !== 2) {
        throw new Error("AE fixture could not restore direct-property selection before apply");
      }
      const beforeApply = await evalHost(client, applySnapshotSource);
      const applyAction = await dispatchHostActionAndWait(
        '(api) => [api.dispatchClick("swatch-apply-exact"), api.dispatchClick("swatch-apply-exact")]'
      );
      const rapidAccepted = applyAction.accepted;
      const appliedState = applyAction.state;
      const appliedSnapshot = await client.evaluate(
        debugCall("(api) => ({ state: api.getState(), counters: api.getCounters() })")
      );
      const undoCycle = await evalHost(client, applyUndoCycleSource);
      const afterApply = undoCycle.beforeUndo;
      const undo = { ok: undoCycle.ok, commandId: undoCycle.commandId };
      const afterUndo = undoCycle.afterUndo;
      const stored = JSON.parse(await readFile(resolve(temporaryRoot, "palette.json"), "utf8"));
      const hostResult = appliedState.lastHostResult;

      if (
        rapidAccepted[0] !== true ||
        rapidAccepted[1] !== true ||
        appliedSnapshot.counters.hostCalls !== 1 ||
        appliedSnapshot.counters.diskWrites !== 0 ||
        hostResult.status !== "ok" ||
        hostResult.appliedCount !== 1 ||
        hostResult.preservedStateCount !== 2 ||
        hostResult.unsupportedGradientCount !== 1 ||
        hostResult.unsupportedTextCount !== 1 ||
        hostResult.failedCount !== 0 ||
        hostResult.undoGroupOpened !== true ||
        JSON.stringify(afterApply.staticValue) !== JSON.stringify(APPLY_RGBA) ||
        afterApply.staticDimensions !== 4 ||
        JSON.stringify(afterApply.expressionValue) !== JSON.stringify(beforeApply.expressionValue) ||
        afterApply.expression !== beforeApply.expression ||
        afterApply.expressionEnabled !== true ||
        afterApply.expressionKeys !== beforeApply.expressionKeys ||
        JSON.stringify(afterApply.keyframedValue) !== JSON.stringify(beforeApply.keyframedValue) ||
        afterApply.keyCount !== beforeApply.keyCount ||
        JSON.stringify(afterApply.keyOne) !== JSON.stringify(beforeApply.keyOne) ||
        JSON.stringify(afterApply.keyTwo) !== JSON.stringify(beforeApply.keyTwo) ||
        afterApply.selectedLayerCount !== beforeApply.selectedLayerCount ||
        afterApply.selectedPropertyCount !== beforeApply.selectedPropertyCount ||
        JSON.stringify(stored) !== JSON.stringify(initialDocument)
      ) {
        throw new Error(
          `Exact apply assertion failed: ${JSON.stringify({
            rapidAccepted,
            hostResult,
            counters: appliedSnapshot.counters,
            beforeApply,
            afterApply,
            stored,
          })}`
        );
      }

      if (!undo.ok || JSON.stringify(afterUndo) !== JSON.stringify(beforeApply)) {
        throw new Error(
          `Single undo-group assertion failed: ${JSON.stringify({ undo, beforeApply, afterUndo })}`
        );
      }

      const screenshot = await client.send("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false,
      });
      await writeFile(
        resolve(outputDirectory, "main-applied.png"),
        Buffer.from(screenshot.data, "base64")
      );
      const consoleEvidence = getConsoleEvidence(client.events);
      const errors = consoleEvidence.console.filter((entry) =>
        ["error", "assert"].includes(entry.type)
      );
      const logErrors = consoleEvidence.logs.filter((entry) => entry.level === "error");
      if (errors.length || logErrors.length || consoleEvidence.exceptions.length) {
        throw new Error("Main emitted console, log, or runtime errors during apply smoke");
      }
      const report = {
        capturedAt: new Date().toISOString(),
        passed: true,
        mode,
        temporaryRoot,
        initialDocument,
        rapidAccepted,
        appliedSnapshot,
        beforeApply,
        afterApply,
        undo,
        afterUndo,
        consoleEvidence,
        screenshots: ["main-applied.png"],
      };
      successPublication = { report, summary: { passed: true, mode, outputDirectory } };
      return;
    }

    const activated = await evalHost(client, activateFixtureCompSource);
    if (!activated.activated) throw new Error("AE fixture comp was not found before collection");
    const initialRestore = await evalHost(client, restoreSource);
    if (initialRestore.selectedLayers !== 2) {
      throw new Error("AE fixture could not restore direct-property selection before collection");
    }
    const before = await evalHost(client, hostSnapshotSource);
    const collectionAction = await dispatchHostActionAndWait(
      '(api) => [api.dispatchClick("palette-add"), api.dispatchClick("palette-add")]'
    );
    const rapidAccepted = collectionAction.accepted;
    const collectedState = collectionAction.state;
    const collectedSnapshot = await client.evaluate(
      debugCall("(api) => ({ state: api.getState(), counters: api.getCounters() })")
    );
    const stored = JSON.parse(await readFile(resolve(temporaryRoot, "palette.json"), "utf8"));
    const after = await evalHost(client, hostSnapshotSource);
    const hostResult = collectedState.lastHostResult;
    const selectionColors = colorSelectionResult(hostResult);
    const storedItems = activePaletteItems(stored);
    if (
      rapidAccepted[0] !== true ||
      rapidAccepted[1] !== true ||
      collectedSnapshot.counters.hostCalls !== 1 ||
      collectedSnapshot.counters.diskWrites !== 1 ||
      selectionColors.status !== "ok" ||
      selectionColors.colors.length !== 1 ||
      selectionColors.unsupportedGradientCount !== 0 ||
      selectionColors.unmodifiedGradientCount !== 1 ||
      selectionColors.unsupportedTextCount !== 1 ||
      !Array.isArray(hostResult.gradients) ||
      hostResult.gradients.length !== 0 ||
      JSON.stringify(selectionColors.colors[0]) !== JSON.stringify(before.fillA) ||
      collectedState.palette.length !== 2 ||
      JSON.stringify(collectedState.palette[0].rgba) !== JSON.stringify(before.fillA) ||
      stored.revision !== 1 ||
      storedItems.length !== 2 ||
      JSON.stringify(storedItems[0].rgba) !== JSON.stringify(before.fillA) ||
      !storedItems[1]?.gradient ||
      JSON.stringify(before) !== JSON.stringify(after)
    ) {
      throw new Error(
        `Read-only collection assertion failed: ${JSON.stringify({
          rapidAccepted,
          counters: collectedSnapshot.counters,
          hostResult,
          palette: collectedState.palette,
          stored,
          before,
          after,
        })}`
      );
    }

    const groupSelection = await evalHost(client, selectGroupSource);
    const groupAction = await dispatchHostActionAndWait(
      '(api) => api.dispatchClick("palette-add")'
    );
    const groupState = groupAction.state;
    const groupSnapshot = await client.evaluate(
      debugCall("(api) => ({ state: api.getState(), counters: api.getCounters() })")
    );
    const groupColors = colorSelectionResult(groupState.lastHostResult);
    if (
      groupSelection.selected !== 1 ||
      groupColors.status !== "ok" ||
      groupColors.colors.length !== 1 ||
      groupColors.unsupportedGradientCount !== 0 ||
      groupSnapshot.counters.diskWrites !== 1
    ) {
      throw new Error(
        `Recursive selected-group assertion failed: ${JSON.stringify({
          groupSelection,
          hostResult: groupState.lastHostResult,
          counters: groupSnapshot.counters,
          state: groupSnapshot.state,
        })}`
      );
    }

    const wholeLayerSelection = await evalHost(client, selectWholeLayersSource);
    const wholeLayerAction = await dispatchHostActionAndWait(
      '(api) => api.dispatchClick("palette-add")'
    );
    const wholeLayerState = wholeLayerAction.state;
    const wholeLayerSnapshot = await client.evaluate(
      debugCall("(api) => ({ state: api.getState(), counters: api.getCounters() })")
    );
    const wholeLayerResult = colorSelectionResult(wholeLayerState.lastHostResult);
    const wholeLayerColors = wholeLayerResult.colors;
    if (
      wholeLayerSelection.selectedLayers !== 2 ||
      wholeLayerResult.status !== "ok" ||
      wholeLayerColors.length < 2 ||
      !wholeLayerColors.some((color) => JSON.stringify(color) === JSON.stringify(before.fillA)) ||
      !wholeLayerColors.some(
        (color) => JSON.stringify(color) === JSON.stringify(before.secondColor)
      ) ||
      wholeLayerColors.some(
        (color) => JSON.stringify(color) === JSON.stringify(before.disabledColor)
      ) ||
      wholeLayerSnapshot.counters.diskWrites !== 2
    ) {
      throw new Error(
        `Whole-layer collection failed: ${JSON.stringify({
          wholeLayerSelection,
          hostResult: wholeLayerState.lastHostResult,
          counters: wholeLayerSnapshot.counters,
        })}`
      );
    }

    const disabledSelection = await evalHost(client, selectDisabledGroupSource);
    const disabledSkippedAction = await dispatchHostActionAndWait(
      '(api) => api.dispatchClick("palette-add")'
    );
    const disabledSkippedState = disabledSkippedAction.state;
    const disabledSkippedSnapshot = await client.evaluate(
      debugCall("(api) => ({ state: api.getState(), counters: api.getCounters() })")
    );
    if (
      disabledSelection.selectedLayers !== 1 ||
      disabledSelection.selectedProperties !== 1 ||
      disabledSelection.disabledGroupEnabled !== false ||
      disabledSkippedState.lastHostResult.status !== "no-supported-colors" ||
      disabledSkippedState.lastHostResult.colors.length !== 0 ||
      disabledSkippedSnapshot.counters.diskWrites !== 2
    ) {
      throw new Error(
        `Disabled-group skip failed: ${JSON.stringify({
          disabledSelection,
          hostResult: disabledSkippedState.lastHostResult,
          counters: disabledSkippedSnapshot.counters,
        })}`
      );
    }

    await writeFile(
      resolve(temporaryRoot, "settings.json"),
      `${JSON.stringify(
        {
          schemaVersion: 2,
          revision: 1,
          layoutMode: "stretch",
          swatchSize: 32,
          includeDisabledColors: true,
        },
        null,
        2
      )}\n`
    );
    await assertFunctionalRuntime(client, "functional smoke pre-disabled-reload runtime");
    await client.send("Page.reload", { ignoreCache: true });
    await waitForStableDebug(client, runtimeEvaluationGuard);
    await assertFunctionalRuntime(client, "functional smoke post-disabled-reload runtime");
    await client.evaluate(
      debugCall(`(api) => api.setTemporaryConfigRoot(${JSON.stringify(temporaryRoot)})`)
    );
    await afterRender(client);
    const disabledIncludedSelection = await evalHost(client, selectDisabledGroupSource);
    const disabledIncludedAction = await dispatchHostActionAndWait(
      '(api) => api.dispatchClick("palette-add")'
    );
    const disabledIncludedState = disabledIncludedAction.state;
    const disabledIncludedSnapshot = await client.evaluate(
      debugCall("(api) => ({ state: api.getState(), counters: api.getCounters() })")
    );
    const disabledIncludedColors = colorSelectionResult(disabledIncludedState.lastHostResult);
    if (
      disabledIncludedSnapshot.state.settings.includeDisabledColors !== true ||
      disabledIncludedColors.status !== "ok" ||
      !disabledIncludedColors.colors.some(
        (color) => JSON.stringify(color) === JSON.stringify(disabledIncludedSelection.color)
      ) ||
      disabledIncludedSnapshot.counters.diskWrites !== 1
    ) {
      throw new Error(
        `Disabled-group inclusion failed: ${JSON.stringify({
          disabledIncludedSelection,
          hostResult: disabledIncludedState.lastHostResult,
          snapshot: disabledIncludedSnapshot,
        })}`
      );
    }
    const finalStored = JSON.parse(
      await readFile(resolve(temporaryRoot, "palette.json"), "utf8")
    );
    if (
      finalStored.revision !== 3 ||
      !activePaletteItems(finalStored).some(
        (color) => JSON.stringify(color.rgba) === JSON.stringify(before.disabledColor)
      )
    ) {
      throw new Error(`Included disabled color was not persisted: ${JSON.stringify(finalStored)}`);
    }

    const deselected = await evalHost(client, deselectSource);
    const emptyAction = await dispatchHostActionAndWait(
      '(api) => api.dispatchClick("palette-add")'
    );
    const emptyState = emptyAction.state;
    const emptySnapshot = await client.evaluate(
      debugCall("(api) => ({ state: api.getState(), counters: api.getCounters() })")
    );
    if (
      deselected.selectedLayers !== 0 ||
      emptyState.lastHostResult.status !== "no-selected-layers" ||
      emptySnapshot.counters.diskWrites !== 1 ||
      emptySnapshot.state.lastResult !== "Select layers or a JPEG/PNG in the Project panel"
    ) {
      throw new Error(
        `No-selection status changed palette state or reported incorrectly: ${JSON.stringify({
          deselected,
          lastHostResult: emptyState.lastHostResult,
          counters: emptySnapshot.counters,
          lastResult: emptySnapshot.state.lastResult,
        })}`
      );
    }
    const restored = await evalHost(client, restoreSource);
    if (restored.selectedLayers !== 2) throw new Error("AE fixture selection was not restored");

    const screenshot = await client.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    await writeFile(resolve(outputDirectory, "main-collected.png"), Buffer.from(screenshot.data, "base64"));
    const consoleEvidence = getConsoleEvidence(client.events);
    const errors = consoleEvidence.console.filter((entry) =>
      ["error", "assert"].includes(entry.type)
    );
    const logErrors = consoleEvidence.logs.filter((entry) => entry.level === "error");
    if (errors.length || logErrors.length || consoleEvidence.exceptions.length) {
      throw new Error("Main emitted console, log, or runtime errors during host smoke");
    }

    const report = {
      capturedAt: new Date().toISOString(),
      passed: true,
      temporaryRoot,
      before,
      after,
      rapidAccepted,
      collectedSnapshot,
      stored,
      groupSelection,
      groupSnapshot,
      wholeLayerSelection,
      wholeLayerSnapshot,
      disabledSelection,
      disabledSkippedSnapshot,
      disabledIncludedSelection,
      disabledIncludedSnapshot,
      finalStored,
      deselected,
      emptySnapshot,
      restored,
      consoleEvidence,
      screenshots: ["main-collected.png"],
    };
    successPublication = { report, summary: { passed: true, outputDirectory } };
  } catch (error) {
    primaryError = error;
  } finally {
    const cleanupSteps = [];
    if (client) {
      if (imageSelectionCleanupRequired && !imageSelectionProjectResetRequired) {
        cleanupSteps.push({
          phase: "image-selection-fixtures",
          run: async () => {
            if (!imageSelectionHostStateKnown || !runtimeEvaluationCompletionKnown()) {
              throw new Error("Renderer or image-selection host completion is unknown; cleanup dispatch refused");
            }
            imageSelectionHostStateKnown = false;
            const result = await evalHost(
              client,
              cleanupImageSelectionFixturesSource(
                runId,
                imageSelectionOwnedItems,
                imageSelectionOwnedTopology
              )
            );
            imageSelectionHostStateKnown = true;
            return result;
          },
        });
      }
      if (imageSelectionProjectResetRequired) {
        cleanupSteps.push({
          phase: "image-selection-project-reset",
          run: async () => {
            if (!imageSelectionHostStateKnown || !runtimeEvaluationCompletionKnown()) {
              throw new Error("Renderer or image-selection host completion is unknown; project reset refused");
            }
            imageSelectionHostStateKnown = false;
            const archivePath = resolve(outputDirectory, "preserved-functional-project.aep");
            const reset = await evalHost(
              client,
              archiveAndResetOwnedProjectSource(runId, archivePath)
            );
            imageSelectionHostStateKnown = true;
            if (
              reset.reset !== true ||
              reset.archivePath !== archivePath ||
              reset.projectPath !== null ||
              reset.dirty !== false ||
              reset.numItems !== 0
            ) {
              throw new Error(`Image-selection project reset failed: ${JSON.stringify(reset)}`);
            }
          },
        });
      }
      cleanupSteps.push(
        {
          phase: "temporary-config-root",
          run: async () => {
            if (!configMutationAttempted) return;
            if (!imageSelectionHostStateKnown || !runtimeEvaluationCompletionKnown()) {
              throw new Error("Renderer or image-selection host completion is unknown; config restoration refused");
            }
            await restoreConfigRootWithReadback({
              expectedRoot: originalConfigRoot,
              setRoot: (root) => client.evaluate(
                debugCall(`(api) => api.setTemporaryConfigRoot(${JSON.stringify(root)})`)
              ),
              settle: () => afterRender(client),
              readRoot: () => client.evaluate(debugCall("(api) => api.getIdentity().configRoot")),
              label: "functional smoke Main config root",
            });
            configRestored = true;
          },
        },
        { phase: "cdp-close", run: async () => await client.close() }
      );
    }
    if (configRun) {
      cleanupSteps.push({
        phase: "temporary-directory",
        run: () => {
          if (configMutationAttempted && !configRestored) {
            throw new Error(`Preserving ${configRun.path} because config restoration is unproven`);
          }
          return removeOwnedRunDirectory(configRun);
        },
      });
    }
    await finalizeFunctionalSmoke({
      primaryError,
      cleanupSteps,
      publishSuccess: async () => {
        if (!successPublication) throw new Error("Functional smoke completed without a success report");
        await replaceFunctionalSmokeReport({
          reportPath,
          pendingReportPath,
          report: {
            ...successPublication.report,
            status: "passed",
            runId,
          },
          beforeCommit: () => rm(failurePath, { force: true }),
        });
        try {
          console.log(JSON.stringify(successPublication.summary, null, 2));
        } catch {
          // The committed report remains authoritative if stdout closes after publication.
        }
      },
      writeFailure: async ({ primaryError: failure, cleanupErrors }) => {
        const error = failure ? String(failure?.stack || failure) : null;
        const finalCleanupErrors = [...cleanupErrors];
        try {
          await replaceFunctionalSmokeReport({
            reportPath,
            pendingReportPath,
            report: {
              capturedAt: new Date().toISOString(),
              passed: false,
              status: "failed",
              mode,
              runId,
              error,
              cleanupErrors,
            },
          });
        } catch (reportError) {
          finalCleanupErrors.push({
            phase: "failure-report",
            error: String(reportError?.stack || reportError),
          });
        }
        await writeFile(
          failurePath,
          `${JSON.stringify(
            {
              capturedAt: new Date().toISOString(),
              passed: false,
              error,
              cleanupErrors: finalCleanupErrors,
              consoleEvidence: client ? getConsoleEvidence(client.events) : null,
            },
            null,
            2
          )}\n`
        );
      },
    });
  }
};

if (isCliEntry) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : error);
    process.exitCode = 1;
  });
}
