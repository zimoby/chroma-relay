#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { CdpClient } from "./lib/cdp-client.mjs";
import {
  assertCanonicalRuntimeUrl,
  createOwnedRunDirectory,
  createOwnedTemporaryConfigDirectory,
  guardClientEvaluations,
  isDirectCliInvocation,
  parseRunnerArgs,
  removeOwnedRunDirectory,
  selectCanonicalCdpTarget,
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
const assertNativeGradientRuntime = async (client, label) => {
  const identity = await client.evaluate(debugCall("(api) => api.getIdentity()"));
  await assertCanonicalRuntimeUrl(
    identity.url,
    resolve(REPO_ROOT, "dist/cep/main/index.html"),
    { label }
  );
  if (
    identity.extensionId !== contract.product.panelIds.main ||
    identity.page !== "main" ||
    identity.buildMarker !== EXPECTED_BUILD_MARKER
  ) {
    throw new Error(`Unexpected panel identity: ${JSON.stringify(identity)}`);
  }
  return identity;
};

const waitForDebug = async (client, operationGuard) => {
  let stable = 0;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const ready = await client.evaluate(
      'document.readyState === "complete" && Boolean(window.__CHROMA_RELAY_DEBUG__)'
    );
    stable = ready ? stable + 1 : 0;
    if (stable === 3) return;
    if (attempt === 79) {
      operationGuard?.quarantine();
      throw new Error("Main debug API did not stabilize; renderer completion quarantined");
    }
    await delay(50);
  }
};

const afterRender = (client) =>
  client.evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");

const waitForIdle = async (client, operationGuard) => {
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
    if (attempt === 119) {
      operationGuard?.quarantine();
      throw new Error("Native-gradient collection did not become idle; renderer completion quarantined");
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

const nativeFixtureTopologyFunctions = `
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
    var result = { display: String(value) };
    try { if (typeof value.toSource === "function") result.source = value.toSource(); } catch (_) {}
    var fields = ["text", "closed", "vertices", "inTangents", "outTangents"];
    for (var fieldIndex = 0; fieldIndex < fields.length; fieldIndex += 1) {
      var field = fields[fieldIndex];
      try { if (value[field] !== undefined) result[field] = snapshotValue(value[field]); } catch (_) {}
    }
    return result;
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
  var snapshotComp = function (comp) {
    var result = {
      id: comp.id,
      name: comp.name,
      typeName: comp.typeName,
      comment: comp.comment,
      label: comp.label,
      width: comp.width,
      height: comp.height,
      pixelAspect: comp.pixelAspect,
      duration: comp.duration,
      frameRate: comp.frameRate,
      bgColor: snapshotValue(comp.bgColor),
      layers: []
    };
    for (var layerIndex = 1; layerIndex <= comp.numLayers; layerIndex += 1) {
      var layer = comp.layer(layerIndex);
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

const projectStateSource = `(function () {
  ${nativeFixtureTopologyFunctions}
  if (!app.project) return JSON.stringify({ project: null });
  var active = app.project.activeItem;
  var layers = [];
  var items = [];
  for (var itemIndex = 1; itemIndex <= app.project.numItems; itemIndex += 1) {
    var projectItem = app.project.item(itemIndex);
    items.push({
      id: projectItem.id,
      name: projectItem.name,
      typeName: projectItem.typeName,
      selected: projectItem.selected === true
    });
  }
  if (active instanceof CompItem) {
    for (var index = 1; index <= active.numLayers; index += 1) {
      var layer = active.layer(index);
      var selectedPropertyPaths = [];
      for (var selectedIndex = 0; selectedIndex < layer.selectedProperties.length; selectedIndex += 1) {
        var cursor = layer.selectedProperties[selectedIndex];
        var path = [];
        while (cursor && cursor.parentProperty) {
          path.unshift(cursor.propertyIndex);
          cursor = cursor.parentProperty;
        }
        selectedPropertyPaths.push(path);
      }
      layers.push({
        id: layer.id,
        index: layer.index,
        selected: layer.selected === true,
        selectedProperties: layer.selectedProperties.length,
        selectedPropertyPaths: selectedPropertyPaths
      });
    }
  }
  return JSON.stringify({
    version: app.version,
    projectPath: app.project.file ? app.project.file.fsName : null,
    dirty: app.project.dirty,
    numItems: app.project.numItems,
    activeItem: active ? { id: active.id, name: active.name, typeName: active.typeName } : null,
    activeCompId: active instanceof CompItem ? active.id : null,
    activeCompName: active instanceof CompItem ? active.name : null,
    fixtureTopology: active instanceof CompItem ? snapshotComp(active) : null,
    layers: layers,
    items: items
  });
})()`;

const openFixtureSource = (fixtureCopy, expectedProject, ownershipToken) => `(function () {
  ${nativeFixtureTopologyFunctions}
  function currentProjectState() {
    if (!app.project) return { project: null };
    var active = app.project.activeItem;
    var layers = [];
    var items = [];
    for (var itemIndex = 1; itemIndex <= app.project.numItems; itemIndex += 1) {
      var projectItem = app.project.item(itemIndex);
      items.push({
        id: projectItem.id,
        name: projectItem.name,
        typeName: projectItem.typeName,
        selected: projectItem.selected === true
      });
    }
    if (active instanceof CompItem) {
      for (var index = 1; index <= active.numLayers; index += 1) {
        var layer = active.layer(index);
        var selectedPropertyPaths = [];
        for (var selectedIndex = 0; selectedIndex < layer.selectedProperties.length; selectedIndex += 1) {
          var cursor = layer.selectedProperties[selectedIndex];
          var path = [];
          while (cursor && cursor.parentProperty) {
            path.unshift(cursor.propertyIndex);
            cursor = cursor.parentProperty;
          }
          selectedPropertyPaths.push(path);
        }
        layers.push({
          id: layer.id,
          index: layer.index,
          selected: layer.selected === true,
          selectedProperties: layer.selectedProperties.length,
          selectedPropertyPaths: selectedPropertyPaths
        });
      }
    }
    return {
      version: app.version,
      projectPath: app.project.file ? app.project.file.fsName : null,
      dirty: app.project.dirty,
      numItems: app.project.numItems,
      activeItem: active ? { id: active.id, name: active.name, typeName: active.typeName } : null,
      activeCompId: active instanceof CompItem ? active.id : null,
      activeCompName: active instanceof CompItem ? active.name : null,
      fixtureTopology: active instanceof CompItem ? snapshotComp(active) : null,
      layers: layers,
      items: items
    };
  }
  var currentProject = currentProjectState();
  var expectedProject = ${JSON.stringify(expectedProject)};
  if (JSON.stringify(currentProject) !== JSON.stringify(expectedProject)) {
    return JSON.stringify({
      ok: false,
      reason: "predecessor-project-drift",
      expected: expectedProject,
      actual: currentProject
    });
  }
  if (!app.project || app.project.dirty !== false) {
    return JSON.stringify({ ok: false, reason: "current-project-not-clean" });
  }
  if (app.project.activeItem &&
      !(app.project.activeItem instanceof CompItem) &&
      !(app.project.activeItem instanceof FootageItem)) {
    return JSON.stringify({ ok: false, reason: "predecessor-active-item-not-restorable" });
  }
  var fixture = new File(${JSON.stringify(fixtureCopy)});
  if (!fixture.exists) return JSON.stringify({ ok: false, reason: "fixture-missing" });
  if ($.global.__CHROMA_NATIVE_GRADIENT_OWNER__ != null) {
    return JSON.stringify({ ok: false, reason: "foreign-owner-present" });
  }
  $.global.__CHROMA_NATIVE_GRADIENT_OWNER__ = ${JSON.stringify(ownershipToken)};
  $.global.__CHROMA_NATIVE_GRADIENT_PREDECESSOR__ = app.project;
  try {
    app.open(fixture);
  } catch (openError) {
    return JSON.stringify({
      ok: false,
      reason: "fixture-open-completion-unknown",
      ownershipClaimed: true,
      fixtureOpened: false,
      error: String(openError)
    });
  }
  try {
  var comp = null;
  for (var itemIndex = 1; itemIndex <= app.project.numItems; itemIndex += 1) {
    var item = app.project.item(itemIndex);
    if (item instanceof CompItem && item.id === 1) comp = item;
    item.selected = false;
  }
  if (!comp || comp.numLayers !== 2) {
    return JSON.stringify({
      ok: false,
      reason: "target-comp-mismatch",
      ownershipClaimed: true,
      fixtureOpened: true
    });
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
      return JSON.stringify({
        ok: false,
        reason: "layer-id-mismatch",
        ownershipClaimed: true,
        fixtureOpened: true,
        index: layerIndex,
        id: layer.id
      });
    }
  }
  comp.layer(1).selected = true;
  comp.layer(2).selected = true;
  return JSON.stringify({
    ok: true,
    ownershipClaimed: true,
    fixtureOpened: true,
    version: app.version,
    projectPath: app.project.file ? app.project.file.fsName : null,
    dirty: app.project.dirty,
    compId: comp.id,
    selectedLayers: comp.selectedLayers.length,
    selectedProperties: comp.layer(1).selectedProperties.length + comp.layer(2).selectedProperties.length,
    fixtureTopology: snapshotComp(comp)
  });
  } catch (error) {
    return JSON.stringify({
      ok: false,
      reason: "fixture-post-open-validation-failed",
      ownershipClaimed: true,
      fixtureOpened: true,
      error: String(error)
    });
  }
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

export const restoreProjectSource = (
  originalProject,
  restoreEmptyProject,
  fixtureCopy,
  runtimeFixture,
  ownershipToken,
  expectedFixtureTopology
) => `(function () {
  ${nativeFixtureTopologyFunctions}
  if (
    $.global.__CHROMA_NATIVE_GRADIENT_OWNER__ !== ${JSON.stringify(ownershipToken)} ||
    $.global.__CHROMA_NATIVE_GRADIENT_PREDECESSOR__ == null
  ) {
    return JSON.stringify({ restored: false, reason: "native-gradient-owner-mismatch" });
  }
  if (!app.project) return JSON.stringify({ restored: false, reason: "fixture-project-missing" });
  var active = app.project.activeItem;
  var exactFixtureTopology = app.project.numItems === 1 &&
    active instanceof CompItem && active.id === 1 && active.name === "A3 Exact Identity Mixed AE25" &&
    active.numLayers === 2 && active.layer(1).id === 14 && active.layer(2).id === 13 &&
    JSON.stringify(snapshotComp(active)) === ${JSON.stringify(JSON.stringify(expectedFixtureTopology))};
  var ownedSavedCopy = app.project.file &&
    (app.project.file.fsName === ${JSON.stringify(fixtureCopy)} ||
      app.project.file.fsName === ${JSON.stringify(runtimeFixture)}) &&
    exactFixtureTopology;
  if (!ownedSavedCopy) {
    return JSON.stringify({
      restored: false,
      reason: "fixture-project-ownership-mismatch",
      fixtureTopology: active instanceof CompItem ? snapshotComp(active) : null
    });
  }
  var restoreEmpty = ${restoreEmptyProject === true ? "true" : "false"};
  var previous = null;
  if (!restoreEmpty) {
    previous = new File(${JSON.stringify(originalProject?.projectPath)});
    if (!previous.exists) {
      return JSON.stringify({ restored: false, reason: "previous-project-missing" });
    }
  }
  var closed = app.project.close(CloseOptions.SAVE_CHANGES);
  if (closed !== true) {
    return JSON.stringify({ restored: false, reason: "fixture-project-close-refused" });
  }
  if (restoreEmpty) {
    app.newProject();
    var emptyRestored = app.project &&
      app.project.file === null &&
      app.project.dirty === false &&
      app.project.numItems === 0;
    if (emptyRestored) {
      delete $.global.__CHROMA_NATIVE_GRADIENT_OWNER__;
      delete $.global.__CHROMA_NATIVE_GRADIENT_PREDECESSOR__;
    }
    return JSON.stringify({
      restored: emptyRestored,
      projectPath: app.project.file ? app.project.file.fsName : null,
      dirty: app.project.dirty,
      numItems: app.project.numItems
    });
  }
  app.open(previous);
  var original = ${JSON.stringify(originalProject)};
  var savedRestored = app.project &&
    app.project.file &&
    app.project.file.fsName === previous.fsName &&
    app.project.dirty === false &&
    app.project.numItems === original.numItems;
  var restoredActive = null;
  var activeRestored = original.activeItem === null && app.project.activeItem === null;
  if (savedRestored && original.activeItem) {
    for (var activeIndex = 1; activeIndex <= app.project.numItems; activeIndex += 1) {
      var activeCandidate = app.project.item(activeIndex);
      if (activeCandidate.id === original.activeItem.id) restoredActive = activeCandidate;
    }
    activeRestored = restoredActive &&
      restoredActive.name === original.activeItem.name &&
      restoredActive.typeName === original.activeItem.typeName &&
      (restoredActive instanceof CompItem || restoredActive instanceof FootageItem);
    if (activeRestored) restoredActive.openInViewer();
  }
  if (savedRestored && activeRestored && original.activeCompId !== null) {
    if (!(restoredActive instanceof CompItem) || restoredActive.numLayers !== original.layers.length) {
      activeRestored = false;
    } else {
      for (var layerIndex = 1; layerIndex <= restoredActive.numLayers; layerIndex += 1) {
        var restoredLayer = restoredActive.layer(layerIndex);
        var wantedLayer = original.layers[layerIndex - 1];
        if (restoredLayer.id !== wantedLayer.id || restoredLayer.index !== wantedLayer.index) {
          activeRestored = false;
          break;
        }
        var currentSelected = restoredLayer.selectedProperties;
        for (var clearIndex = currentSelected.length - 1; clearIndex >= 0; clearIndex -= 1) {
          currentSelected[clearIndex].selected = false;
        }
        restoredLayer.selected = wantedLayer.selected === true;
        for (var pathIndex = 0; pathIndex < wantedLayer.selectedPropertyPaths.length; pathIndex += 1) {
          var wantedPath = wantedLayer.selectedPropertyPaths[pathIndex];
          var property = restoredLayer;
          for (var propertyIndex = 0; property && propertyIndex < wantedPath.length; propertyIndex += 1) {
            property = property.property(wantedPath[propertyIndex]);
          }
          if (!property) {
            activeRestored = false;
            break;
          }
          property.selected = true;
        }
        if (!activeRestored ||
            restoredLayer.selected !== wantedLayer.selected ||
            restoredLayer.selectedProperties.length !== wantedLayer.selectedProperties) {
          activeRestored = false;
          break;
        }
      }
    }
  }
  var itemsRestored = savedRestored && original.items.length === app.project.numItems;
  for (var clearItemIndex = 1; clearItemIndex <= app.project.numItems; clearItemIndex += 1) {
    app.project.item(clearItemIndex).selected = false;
  }
  for (var itemSnapshotIndex = 0; itemsRestored && itemSnapshotIndex < original.items.length; itemSnapshotIndex += 1) {
    var wantedItem = original.items[itemSnapshotIndex];
    var foundItem = null;
    for (var findIndex = 1; findIndex <= app.project.numItems; findIndex += 1) {
      if (app.project.item(findIndex).id === wantedItem.id) foundItem = app.project.item(findIndex);
    }
    if (!foundItem || foundItem.name !== wantedItem.name || foundItem.typeName !== wantedItem.typeName) {
      itemsRestored = false;
      break;
    }
    foundItem.selected = wantedItem.selected === true;
    if (foundItem.selected !== wantedItem.selected) itemsRestored = false;
  }
  savedRestored = savedRestored && activeRestored && itemsRestored;
  if (savedRestored) {
    delete $.global.__CHROMA_NATIVE_GRADIENT_OWNER__;
    delete $.global.__CHROMA_NATIVE_GRADIENT_PREDECESSOR__;
  }
  return JSON.stringify({
    restored: savedRestored,
    projectPath: app.project.file ? app.project.file.fsName : null,
    dirty: app.project.dirty,
    activeRestored: activeRestored,
    itemsRestored: itemsRestored
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
  const panelRestored =
    cleanup.panel?.restored === true &&
    cleanup.panel?.loaded != null &&
    cleanup.panel.loaded.error == null;
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
  let cleanupDispatchAuthorized = false;
  let operationGuard = null;
  let panelMutationAttempted = false;
  let panelCleanupCompletionKnown = false;
  let acceptedFixtureHashes = null;
  let acceptedFixtureTopology = null;
  let cleanup = { panel: null, project: null, temp: null };
  let failure = null;
  let report = null;
  const ownershipToken = randomBytes(24).toString("hex");

  try {
    await copyFile(FIXTURE_SOURCE, fixtureCopy);
    const response = await fetch("http://127.0.0.1:8198/json/list");
    if (!response.ok) throw new Error(`CDP target list failed: HTTP ${response.status}`);
    const targets = await response.json();
    const target = await selectCanonicalCdpTarget(
      targets,
      resolve(REPO_ROOT, "dist/cep/main/index.html"),
      { label: "native-gradient collect Main" }
    );

    client = new CdpClient(target.webSocketDebuggerUrl);
    await client.connect();
    await Promise.all([
      client.send("Runtime.enable"),
      client.send("Log.enable"),
      client.send("Page.enable"),
    ]);
    operationGuard = guardClientEvaluations(client, "native-gradient smoke Main");
    await waitForDebug(client, operationGuard);
    const baselineIdentity = await assertNativeGradientRuntime(
      client,
      "native-gradient collect Main baseline runtime"
    );
    originalConfigRoot = baselineIdentity.configRoot ?? null;
    client.events = [];
    await client.send("Page.reload", { ignoreCache: true });
    await waitForDebug(client, operationGuard);
    await afterRender(client);

    const identity = await assertNativeGradientRuntime(client, "native-gradient collect Main runtime");
    if ((identity.configRoot ?? null) !== originalConfigRoot) {
      throw new Error("Native-gradient config root changed during authenticated reload");
    }

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
    setup = await evalHost(
      client,
      openFixtureSource(fixtureCopy, originalProject, ownershipToken)
    );
    cleanupDispatchAuthorized =
      setup?.ownershipClaimed === true && setup?.fixtureOpened === true;
    const fixtureLoad = classifyNativeGradientFixtureLoad({
      setup,
      expectedVersion: sourceExpected.afterEffectsVersion,
      fixtureCopy,
    });
    if (!fixtureLoad.accepted) {
      throw new Error(`AE fixture setup failed: ${JSON.stringify(setup)}`);
    }
    if (!setup.fixtureTopology) {
      throw new Error("AE fixture setup did not return same-dispatch topology");
    }
    acceptedFixtureTopology = setup.fixtureTopology;
    cleanupDispatchAuthorized = true;
    if (fixtureLoad.converted) {
      runtimeFixture = convertedFixtureCopy;
      cleanupDispatchAuthorized = false;
      runtimeSave = await evalHost(client, saveConvertedFixtureSource(runtimeFixture));
      cleanupDispatchAuthorized = true;
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
    if (!fixtureLoad.converted && runtimeHashBefore !== copyHashBefore) {
      throw new Error("Reviewed fixture bytes drifted after opening");
    }
    acceptedFixtureHashes = { copy: copyHashBefore, runtime: runtimeHashBefore };

    panelMutationAttempted = true;
    cleanupDispatchAuthorized = false;
    await client.evaluate(debugCall("(api) => api.resetTestState()"));
    await afterRender(client);
    cleanupDispatchAuthorized = true;
    cleanupDispatchAuthorized = false;
    await client.evaluate(
      debugCall(`(api) => api.setTemporaryConfigRoot(${JSON.stringify(temporaryRoot)})`)
    );
    await afterRender(client);
    const temporaryIdentity = await client.evaluate(debugCall("(api) => api.getIdentity()"));
    cleanupDispatchAuthorized = true;
    if (temporaryIdentity?.configRoot !== temporaryRoot) {
      throw new Error(
        `Native-gradient temporary config root readback failed: ${JSON.stringify(temporaryIdentity)}`
      );
    }
    cleanupDispatchAuthorized = false;
    await client.evaluate(debugCall("(api) => api.seedPalette([])"));
    await afterRender(client);
    cleanupDispatchAuthorized = true;

    cleanupDispatchAuthorized = false;
    const before = await evalHost(client, projectStateSource);
    cleanupDispatchAuthorized = true;
    cleanupDispatchAuthorized = false;
    const accepted = await client.evaluate(debugCall('(api) => api.dispatchClick("palette-add")'));
    const snapshot = await waitForIdle(client, operationGuard);
    cleanupDispatchAuthorized =
      snapshot?.state?.pendingHostAction === null &&
      snapshot?.counters?.hostCalls === 1 &&
      snapshot?.state?.lastHostResult != null;
    if (!cleanupDispatchAuthorized) {
      throw new Error(`Native-gradient host action completion is not authoritative: ${JSON.stringify(snapshot)}`);
    }
    cleanupDispatchAuthorized = false;
    const after = await evalHost(client, projectStateSource);
    cleanupDispatchAuthorized = true;
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

    if (JSON.stringify(after.fixtureTopology) !== JSON.stringify(acceptedFixtureTopology)) {
      throw new Error("Native-gradient fixture topology drifted after same-dispatch setup capture");
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
    if (client && cleanupDispatchAuthorized && operationGuard?.isCompletionKnown() !== false) {
      if (!panelMutationAttempted) {
        cleanup.panel = {
          restored: true,
          notMutated: true,
          originalConfigRoot,
          configRoot: originalConfigRoot,
          loaded: { error: null },
        };
        panelCleanupCompletionKnown = true;
      } else try {
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
          restored:
            restoredIdentity.configRoot === originalConfigRoot &&
            loaded != null &&
            loaded.error == null,
          originalConfigRoot,
          configRoot: restoredIdentity.configRoot,
          loaded,
        };
        panelCleanupCompletionKnown = true;
      } catch (error) {
        cleanup.panel = { restored: false, error: String(error) };
      }
      if (originalProject && panelCleanupCompletionKnown) {
        try {
          if (!acceptedFixtureHashes || !acceptedFixtureTopology) {
            throw new Error("accepted native-gradient fixture identity is unavailable");
          }
          const cleanupCopyHash = await sha256(fixtureCopy);
          const cleanupRuntimeHash = await sha256(runtimeFixture);
          if (
            cleanupCopyHash !== acceptedFixtureHashes.copy ||
            cleanupRuntimeHash !== acceptedFixtureHashes.runtime
          ) {
            throw new Error("native-gradient fixture bytes drifted before restoration");
          }
          const restoreEmptyProject =
            originalProject.projectPath === null &&
            originalProject.dirty === false &&
            originalProject.numItems === 0;
          const restoredProject = await evalHost(
            client,
            restoreProjectSource(
              originalProject,
              restoreEmptyProject,
              fixtureCopy,
              runtimeFixture,
              ownershipToken,
              acceptedFixtureTopology
            )
          );
          if (restoredProject.restored !== true) {
            cleanup.project = restoredProject;
          } else {
            const postCloseHashes = {
              copy: await sha256(fixtureCopy),
              runtime: await sha256(runtimeFixture),
            };
            const preservedWithoutDrift =
              postCloseHashes.copy === acceptedFixtureHashes.copy &&
              postCloseHashes.runtime === acceptedFixtureHashes.runtime;
            cleanup.project = preservedWithoutDrift
              ? { ...restoredProject, postCloseHashes, savedBeforeClose: true }
              : {
                  ...restoredProject,
                  restored: false,
                  originalProjectRestored: true,
                  savedBeforeClose: true,
                  reason: "saved native-gradient fixture drifted; scratch archive retained",
                  postCloseHashes,
                  acceptedFixtureHashes,
                  preservedAt: runtimeFixture,
                };
          }
        } catch (error) {
          cleanup.project = { restored: false, error: String(error) };
        }
      } else if (originalProject) {
        cleanup.project = { restored: false, reason: "panel-restoration-not-confirmed" };
      }
      try {
        await client.close();
      } catch (error) {
        cleanup.close = { closed: false, error: String(error?.stack || error) };
        failure ||= error;
      }
    } else if (client) {
      const reason = operationGuard?.isCompletionKnown() === false
        ? "renderer-operation-completion-unknown"
        : "cleanup-dispatch-not-authorized";
      cleanup.panel = { restored: false, reason };
      cleanup.project = { restored: false, reason };
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
    try {
      await writeFile(
        resolve(outputDirectory, "failure.json"),
        `${JSON.stringify(failureReport, null, 2)}\n`
      );
    } catch (evidenceError) {
      if (typeof failure === "object" || typeof failure === "function") {
        try {
          failure.evidenceWriteErrors = [String(evidenceError?.stack || evidenceError)];
        } catch {}
      }
    }
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

if (isDirectCliInvocation(import.meta.url)) {
  cli().catch((error) => {
    console.error(error?.stack || String(error));
    if (Array.isArray(error?.evidenceWriteErrors) && error.evidenceWriteErrors.length > 0) {
      console.error(`Failure evidence publication also failed:\n${JSON.stringify(error.evidenceWriteErrors, null, 2)}`);
    }
    process.exitCode = 1;
  });
}
