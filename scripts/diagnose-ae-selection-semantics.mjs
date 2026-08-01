#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [repoArg, labelArg, expectedVersionArg, outputDirArg, portArg = "8198"] =
  process.argv.slice(2);
if (!repoArg || !labelArg || !expectedVersionArg || !outputDirArg) {
  throw new Error(
    "Usage: diagnose-ae-selection-semantics.mjs <repo> <label> <expected-version> <output-dir> [port]"
  );
}
if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(labelArg)) {
  throw new Error("Selection-semantics label must be a lowercase safe token");
}
const repo = resolve(repoArg);
const label = labelArg;
const expectedVersion = expectedVersionArg;
const outputDir = resolve(outputDirArg);
const port = String(portArg);
const ownershipToken = `chroma-selection-semantics-${randomBytes(16).toString("hex")}`;
const reportPath = resolve(outputDir, `${label}-report.json`);
const failurePath = resolve(outputDir, `${label}-failure.json`);
const projectArchivePath = resolve(outputDir, `${label}-${ownershipToken}.aep`);
await mkdir(outputDir, { recursive: true });
await writeFile(
  reportPath,
  `${JSON.stringify({ passed: false, status: "running", label, expectedVersion, port }, null, 2)}\n`
);
const { CdpClient } = await import(
  pathToFileURL(resolve(repo, "scripts/lib/cdp-client.mjs")).href
);
const { assertCanonicalRuntimeUrl, guardClientEvaluations, selectCanonicalCdpTarget } = await import(
  pathToFileURL(resolve(repo, "scripts/lib/live-runner-policy.mjs")).href
);
const contract = JSON.parse(
  await readFile(resolve(repo, "src/shared/product-contract.json"), "utf8")
);
const packageJson = JSON.parse(await readFile(resolve(repo, "package.json"), "utf8"));
const comparablePath = (path) => (process.platform === "win32" ? path.toLowerCase() : path);
const expectedPanelPath = await realpath(resolve(repo, "dist/cep/main/index.html"));
const appData = process.env.APPDATA;
if (!appData) throw new Error("APPDATA is required for the Windows CEP identity gate");
const installedPanelPath = await realpath(
  resolve(
    appData,
    "Adobe/CEP/extensions",
    contract.product.extensionId,
    "main/index.html"
  )
);
if (comparablePath(installedPanelPath) !== comparablePath(expectedPanelPath)) {
  throw new Error(
    `Installed Chroma Relay Main does not resolve to the expected repo: ${installedPanelPath}`
  );
}
const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
const fail = (message) => {
  throw new Error(message);
};
const debugCall = (source) => `(() => {
  const api = window.__CHROMA_RELAY_DEBUG__;
  if (!api) throw new Error("Chroma Relay debug API unavailable");
  return (${source})(api);
})()`;

const diagnosticTopologySource = `
  function diagnosticValue(value) {
    if (value === null || value === undefined) return value;
    if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") return value;
    if (value instanceof Array) {
      var arrayValue = [];
      for (var valueIndex = 0; valueIndex < value.length; valueIndex += 1) arrayValue.push(diagnosticValue(value[valueIndex]));
      return arrayValue;
    }
    try { return value.toString(); } catch (error) { return "[unreadable-value]"; }
  }
  function diagnosticEase(ease) {
    var result = [];
    for (var easeIndex = 0; easeIndex < ease.length; easeIndex += 1) {
      result.push({ speed: ease[easeIndex].speed, influence: ease[easeIndex].influence });
    }
    return result;
  }
  function diagnosticProperty(property) {
    var result = {
      name: property.name,
      matchName: property.matchName,
      propertyType: property.propertyType,
      propertyIndex: property.propertyIndex,
      enabled: property.enabled,
      active: property.active,
      elided: property.elided,
      numProperties: property.numProperties || 0
    };
    if (property.propertyType === PropertyType.PROPERTY) {
      try { result.value = diagnosticValue(property.value); } catch (error) { result.valueError = String(error); }
      try { result.expression = property.canSetExpression ? property.expression : null; } catch (error) { result.expressionError = String(error); }
      result.numKeys = property.numKeys || 0;
      result.keys = [];
      for (var keyIndex = 1; keyIndex <= result.numKeys; keyIndex += 1) {
        var key = { time: property.keyTime(keyIndex), value: diagnosticValue(property.keyValue(keyIndex)) };
        try { key.inInterpolationType = property.keyInInterpolationType(keyIndex); } catch (error) {}
        try { key.outInterpolationType = property.keyOutInterpolationType(keyIndex); } catch (error) {}
        try { key.inTemporalEase = diagnosticEase(property.keyInTemporalEase(keyIndex)); } catch (error) {}
        try { key.outTemporalEase = diagnosticEase(property.keyOutTemporalEase(keyIndex)); } catch (error) {}
        try { key.temporalAutoBezier = property.keyTemporalAutoBezier(keyIndex); } catch (error) {}
        try { key.temporalContinuous = property.keyTemporalContinuous(keyIndex); } catch (error) {}
        try { key.roving = property.keyRoving(keyIndex); } catch (error) {}
        try { key.inSpatialTangent = diagnosticValue(property.keyInSpatialTangent(keyIndex)); } catch (error) {}
        try { key.outSpatialTangent = diagnosticValue(property.keyOutSpatialTangent(keyIndex)); } catch (error) {}
        try { key.spatialAutoBezier = property.keySpatialAutoBezier(keyIndex); } catch (error) {}
        try { key.spatialContinuous = property.keySpatialContinuous(keyIndex); } catch (error) {}
        result.keys.push(key);
      }
      return result;
    }
    result.children = [];
    for (var propertyIndex = 1; propertyIndex <= result.numProperties; propertyIndex += 1) {
      result.children.push(diagnosticProperty(property.property(propertyIndex)));
    }
    return result;
  }
  function diagnosticProjectTopology() {
    var topology = { numItems: app.project.numItems, items: [] };
    for (var itemIndex = 1; itemIndex <= app.project.numItems; itemIndex += 1) {
      var item = app.project.item(itemIndex);
      var itemState = { id: item.id, name: item.name, typeName: item.typeName, comment: item.comment, label: item.label };
      if (item instanceof CompItem) {
        itemState.comp = {
          width: item.width,
          height: item.height,
          pixelAspect: item.pixelAspect,
          duration: item.duration,
          frameRate: item.frameRate,
          displayStartTime: item.displayStartTime,
          workAreaStart: item.workAreaStart,
          workAreaDuration: item.workAreaDuration,
          numLayers: item.numLayers,
          layers: []
        };
        for (var layerIndex = 1; layerIndex <= item.numLayers; layerIndex += 1) {
          var layer = item.layer(layerIndex);
          itemState.comp.layers.push({
            id: layer.id,
            index: layer.index,
            name: layer.name,
            matchName: layer.matchName,
            comment: layer.comment,
            label: layer.label,
            enabled: layer.enabled,
            locked: layer.locked,
            shy: layer.shy,
            solo: layer.solo,
            guideLayer: layer.guideLayer,
            adjustmentLayer: layer.adjustmentLayer,
            threeDLayer: layer.threeDLayer,
            parentId: layer.parent ? layer.parent.id : null,
            blendingMode: String(layer.blendingMode),
            trackMatteType: String(layer.trackMatteType),
            inPoint: layer.inPoint,
            outPoint: layer.outPoint,
            startTime: layer.startTime,
            stretch: layer.stretch,
            properties: diagnosticProperty(layer)
          });
        }
      }
      topology.items.push(itemState);
    }
    return topology;
  }
`;

let hostCallDispatched = false;
let harnessHostEvalCount = 0;
let harnessHostEvalAfterResultCount = 0;
const hostEval = (client, source) => {
  if (hostCallDispatched) {
    harnessHostEvalAfterResultCount += 1;
    throw new Error("Only one host eval is allowed for the selection-semantics probe");
  }
  hostCallDispatched = true;
  harnessHostEvalCount += 1;
  return client.evaluate(`new Promise((resolve, reject) => {
    window.__adobe_cep__.evalScript(${JSON.stringify(source)}, (raw) => {
      try { resolve(JSON.parse(raw)); } catch (error) { reject(new Error(raw)); }
    });
  })`);
};

const hostSource = `(function () {
  ${diagnosticTopologySource}
  var MAX_SELECTED_PROPERTIES = 32;
  var EXPECTED_VERSION = ${JSON.stringify(expectedVersion)};
  var OWNER_TOKEN = ${JSON.stringify(ownershipToken)};
  var reports = [];
  var records = [];
  var undoOpened = false;
  var undoCompletionKnown = true;
  var stage = "preflight";

  function boundedText(value) {
    var text = String(value);
    return text.length > 500 ? text.substring(0, 500) : text;
  }

  function findLayer(comp, layerId) {
    for (var index = 1; index <= comp.numLayers; index += 1) {
      var layer = comp.layer(index);
      if (layer && layer.id === layerId) return layer;
    }
    return null;
  }

  function resolveProperty(layer, path, expectedMatchNames) {
    if (!expectedMatchNames || expectedMatchNames.length !== path.length) return null;
    var current = layer;
    for (var index = 0; index < path.length; index += 1) {
      current = current.property(path[index]);
      if (
        !current ||
        current.propertyIndex !== path[index] ||
        current.matchName !== expectedMatchNames[index]
      ) return null;
    }
    return current;
  }

  function propertyPath(layer, property) {
    var indexes = [];
    var matchNames = [];
    var current = property;
    var guard = 0;
    while (current && current !== layer && guard < 32) {
      if (
        typeof current.propertyIndex !== "number" ||
        current.propertyIndex < 1 ||
        typeof current.matchName !== "string" ||
        current.matchName.length === 0 ||
        current.matchName.length > 120
      ) return null;
      indexes.unshift(current.propertyIndex);
      matchNames.unshift(current.matchName);
      current = current.parentProperty;
      guard += 1;
    }
    if (current !== layer || indexes.length === 0) return null;
    return {
      propertyIndexPath: indexes,
      matchNamePath: matchNames,
      key: indexes.join(".") + "|" + matchNames.join("/")
    };
  }

  function snapshot(comp) {
    if (comp.numLayers < 1 || comp.numLayers > 2) {
      throw new Error("snapshot-layer-count-out-of-range");
    }
    var layers = [];
    var totalSelectedProperties = 0;
    for (var layerIndex = 1; layerIndex <= comp.numLayers; layerIndex += 1) {
      var layer = comp.layer(layerIndex);
      var selected = layer.selectedProperties;
      if (!selected || typeof selected.length !== "number") {
        throw new Error("selected-properties-unavailable");
      }
      var properties = [];
      for (var propertyIndex = 0; propertyIndex < selected.length; propertyIndex += 1) {
        if (totalSelectedProperties >= MAX_SELECTED_PROPERTIES) {
          throw new Error("selected-properties-over-limit");
        }
        var path = propertyPath(layer, selected[propertyIndex]);
        if (!path) throw new Error("selected-property-path-invalid");
        properties.push({
          propertyIndexPath: path.propertyIndexPath,
          matchNamePath: path.matchNamePath,
          selected: selected[propertyIndex].selected === true
        });
        totalSelectedProperties += 1;
      }
      if (properties.length > 0 || layer.selected === true) {
        layers.push({
          layerId: layer.id,
          layerIndex: layer.index,
          layerName: boundedText(layer.name),
          selected: layer.selected === true,
          properties: properties
        });
      }
    }
    layers.sort(function (left, right) { return left.layerIndex - right.layerIndex; });
    return {
      selectedLayerCount: comp.selectedLayers.length,
      selectedPropertyCount: totalSelectedProperties,
      truncated: false,
      layers: layers
    };
  }

  function clearSelection(comp) {
    for (var pass = 0; pass < 8; pass += 1) {
      var changed = false;
      for (var layerIndex = 1; layerIndex <= comp.numLayers; layerIndex += 1) {
        var layer = comp.layer(layerIndex);
        var selected = layer.selectedProperties;
        for (var propertyIndex = selected.length - 1; propertyIndex >= 0; propertyIndex -= 1) {
          selected[propertyIndex].selected = false;
          changed = true;
        }
        layer.selected = false;
      }
      if (!changed) break;
    }
  }

  function addTarget(comp, name, kind) {
    var layer = comp.layers.addShape();
    layer.name = name;
    layer.comment = OWNER_TOKEN;
    var root = layer.property("ADBE Root Vectors Group");
    var rootIndex = root.propertyIndex;
    var group = root.addProperty("ADBE Vector Group");
    group.name = name + " Group";
    var groupIndex = group.propertyIndex;
    var contents = group.property("ADBE Vectors Group");
    var contentsIndex = contents.propertyIndex;
    var graphic = contents.addProperty(
      kind === "fill" ? "ADBE Vector Graphic - G-Fill" : "ADBE Vector Graphic - G-Stroke"
    );
    var graphicIndex = graphic.propertyIndex;
    var colors = graphic.property("ADBE Vector Grad Colors");
    if (!colors) throw new Error("gradient-colors-missing-" + kind);
    var colorsIndex = colors.propertyIndex;
    return {
      key: kind,
      kind: kind,
      layerId: layer.id,
      groupPath: [rootIndex, groupIndex],
      groupMatchNamePath: ["ADBE Root Vectors Group", "ADBE Vector Group"],
      leafPath: [rootIndex, groupIndex, contentsIndex, graphicIndex, colorsIndex],
      leafMatchNamePath: [
        "ADBE Root Vectors Group",
        "ADBE Vector Group",
        "ADBE Vectors Group",
        kind === "fill" ? "ADBE Vector Graphic - G-Fill" : "ADBE Vector Graphic - G-Stroke",
        "ADBE Vector Grad Colors"
      ]
    };
  }

  function setTargetSelection(comp, target, scope, value) {
    var layer = findLayer(comp, target.layerId);
    if (!layer) throw new Error("target-layer-missing-" + target.key);
    layer.selected = true;
    var path = scope === "parent" ? target.groupPath : target.leafPath;
    var expectedMatchNames =
      scope === "parent" ? target.groupMatchNamePath : target.leafMatchNamePath;
    var property = resolveProperty(layer, path, expectedMatchNames);
    if (!property) throw new Error("target-property-missing-" + target.key + "-" + scope);
    property.selected = value;
    return {
      target: target.key,
      scope: scope,
      requested: value,
      selectedAfterSet: property.selected === true,
      layerSelectedAfterSet: layer.selected === true,
      snapshot: snapshot(comp)
    };
  }

  function runCase(name, kinds, operations) {
    stage = "case-" + name;
    var comp = app.project.items.addComp(
      "CHROMA_SELECTION_SEMANTICS_${label}_" + name,
      640,
      360,
      1,
      2,
      24
    );
    comp.comment = ${JSON.stringify(ownershipToken)};
    if (records.length === 0) {
      $.global.__CHROMA_SELECTION_SEMANTICS_OWNER__ = ${JSON.stringify(ownershipToken)};
    }
    var targets = {};
    for (var index = 0; index < kinds.length; index += 1) {
      var kind = kinds[index];
      targets[kind] = addTarget(comp, "CHROMA_" + kind.toUpperCase(), kind);
    }
    comp.openInViewer();
    clearSelection(comp);
    var report = {
      name: name,
      baseline: snapshot(comp),
      steps: [],
      insideUndo: null,
      afterUndo: null
    };
    if (
      report.baseline.selectedLayerCount !== 0 ||
      report.baseline.selectedPropertyCount !== 0
    ) {
      throw new Error("baseline-selection-not-empty-" + name);
    }
    for (var operationIndex = 0; operationIndex < operations.length; operationIndex += 1) {
      var operation = operations[operationIndex];
      report.steps.push(
        setTargetSelection(
          comp,
          targets[operation.target],
          operation.scope,
          operation.value
        )
      );
    }
    report.insideUndo = snapshot(comp);
    reports.push(report);
    records.push({ comp: comp, report: report });
  }

  try {
    if (app.version !== EXPECTED_VERSION) {
      return JSON.stringify({
        ok: false,
        stage: "preflight",
        reason: "unexpected-ae-version",
        version: app.version,
        expectedVersion: EXPECTED_VERSION
      });
    }
    if (
      !app.project ||
      app.project.numItems !== 0 ||
      app.project.dirty !== false ||
      app.project.file !== null
    ) {
      return JSON.stringify({
        ok: false,
        stage: "preflight",
        reason: "current-project-not-empty-clean",
        version: app.version,
        items: app.project ? app.project.numItems : null,
        dirty: app.project ? app.project.dirty : null
      });
    }
    if ($.global.__CHROMA_SELECTION_SEMANTICS_OWNER__ != null) {
      return JSON.stringify({ ok: false, cleanupSafe: false, reason: "foreign-owner-present" });
    }
    app.beginUndoGroup("Chroma Relay selection semantics diagnostic");
    undoOpened = true;

    runCase("fill-leaf-only", ["fill"], [
      { target: "fill", scope: "leaf", value: true }
    ]);
    runCase("stroke-leaf-only", ["stroke"], [
      { target: "stroke", scope: "leaf", value: true }
    ]);
    runCase("fill-parent-only", ["fill"], [
      { target: "fill", scope: "parent", value: true }
    ]);
    runCase("stroke-parent-only", ["stroke"], [
      { target: "stroke", scope: "parent", value: true }
    ]);
    runCase("fill-parent-then-leaf", ["fill"], [
      { target: "fill", scope: "parent", value: true },
      { target: "fill", scope: "leaf", value: true }
    ]);
    runCase("stroke-parent-then-leaf", ["stroke"], [
      { target: "stroke", scope: "parent", value: true },
      { target: "stroke", scope: "leaf", value: true }
    ]);
    runCase("fill-leaf-then-parent-off", ["fill"], [
      { target: "fill", scope: "leaf", value: true },
      { target: "fill", scope: "parent", value: false }
    ]);
    runCase("stroke-leaf-then-parent-off", ["stroke"], [
      { target: "stroke", scope: "leaf", value: true },
      { target: "stroke", scope: "parent", value: false }
    ]);
    runCase("fill-then-stroke", ["fill", "stroke"], [
      { target: "fill", scope: "leaf", value: true },
      { target: "stroke", scope: "leaf", value: true }
    ]);
    runCase("stroke-then-fill", ["fill", "stroke"], [
      { target: "stroke", scope: "leaf", value: true },
      { target: "fill", scope: "leaf", value: true }
    ]);

    stage = "end-undo";
    undoOpened = false;
    undoCompletionKnown = false;
    app.endUndoGroup();
    undoCompletionKnown = true;

    stage = "after-undo-capture";
    for (var recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
      records[recordIndex].report.afterUndo = snapshot(records[recordIndex].comp);
    }

    $.global.__CHROMA_SELECTION_SEMANTICS_TOPOLOGY__ = JSON.stringify(diagnosticProjectTopology());
    $.global.__CHROMA_SELECTION_SEMANTICS_SETUP_COMPLETE__ = ${JSON.stringify(ownershipToken)};
    return JSON.stringify({
      ok: true,
      cleanupSafe: true,
      schemaVersion: 1,
      version: app.version,
      caseCount: reports.length,
      cases: reports,
      projectItemCount: app.project.numItems,
      projectDirty: app.project.dirty === true
    });
  } catch (error) {
    var closeError = undoCompletionKnown ? null : "undo-completion-unknown";
    if (undoOpened) {
      undoOpened = false;
      undoCompletionKnown = false;
      try {
        app.endUndoGroup();
        undoCompletionKnown = true;
      } catch (undoError) {
        closeError = boundedText(undoError && undoError.message ? undoError.message : undoError);
      }
    }
    return JSON.stringify({
      ok: false,
      schemaVersion: 1,
      version: app.version,
      stage: stage,
      error: boundedText(error && error.message ? error.message : error),
      undoCloseError: closeError,
      cleanupSafe: closeError === null && undoCompletionKnown,
      caseCount: reports.length,
      cases: reports
    });
  }
})()`;

const cleanupSource = `(function () {
  ${diagnosticTopologySource}
  if (app.version !== ${JSON.stringify(expectedVersion)}) {
    return JSON.stringify({ ok: false, reason: "unexpected-ae-version", version: app.version });
  }
  if (!app.project) {
    return JSON.stringify({ ok: false, reason: "no-project" });
  }
  var ownsRun = $.global.__CHROMA_SELECTION_SEMANTICS_OWNER__ === ${JSON.stringify(ownershipToken)};
  var setupComplete = $.global.__CHROMA_SELECTION_SEMANTICS_SETUP_COMPLETE__ === ${JSON.stringify(ownershipToken)};
  var acceptedTopology = $.global.__CHROMA_SELECTION_SEMANTICS_TOPOLOGY__;
  var expectedNames = ${JSON.stringify([
    "fill-leaf-only",
    "stroke-leaf-only",
    "fill-parent-only",
    "stroke-parent-only",
    "fill-parent-then-leaf",
    "stroke-parent-then-leaf",
    "fill-leaf-then-parent-off",
    "stroke-leaf-then-parent-off",
    "fill-then-stroke",
    "stroke-then-fill",
  ].map((name) => `CHROMA_SELECTION_SEMANTICS_${label}_${name}`))};
  var expectedKinds = ${JSON.stringify([
    ["fill"],
    ["stroke"],
    ["fill"],
    ["stroke"],
    ["fill"],
    ["stroke"],
    ["fill"],
    ["stroke"],
    ["fill", "stroke"],
    ["fill", "stroke"],
  ])};
  function exactTarget(layer, expectedIndex, kind) {
    var expectedName = "CHROMA_" + kind.toUpperCase();
    var expectedGraphic = kind === "fill"
      ? "ADBE Vector Graphic - G-Fill"
      : "ADBE Vector Graphic - G-Stroke";
    if (
      !layer ||
      layer.index !== expectedIndex ||
      layer.name !== expectedName ||
      layer.comment !== ${JSON.stringify(ownershipToken)} ||
      layer.matchName !== "ADBE Vector Layer" ||
      layer.inPoint !== 0 ||
      layer.outPoint !== 2 ||
      layer.startTime !== 0 ||
      layer.stretch !== 100
    ) return false;
    var root = layer.property("ADBE Root Vectors Group");
    if (!root || root.numProperties !== 1) return false;
    var group = root.property(1);
    if (!group || group.matchName !== "ADBE Vector Group" || group.name !== expectedName + " Group") return false;
    var contents = group.property("ADBE Vectors Group");
    if (!contents || contents.numProperties !== 1) return false;
    var graphic = contents.property(1);
    if (!graphic || graphic.matchName !== expectedGraphic) return false;
    var colors = graphic.property("ADBE Vector Grad Colors");
    return !!colors && colors.matchName === "ADBE Vector Grad Colors";
  }

  function exactPartialTarget(layer, expectedIndex, kind) {
    var expectedName = "CHROMA_" + kind.toUpperCase();
    var expectedGraphic = kind === "fill"
      ? "ADBE Vector Graphic - G-Fill"
      : "ADBE Vector Graphic - G-Stroke";
    if (
      !layer ||
      layer.index !== expectedIndex ||
      layer.name !== expectedName ||
      layer.comment !== ${JSON.stringify(ownershipToken)} ||
      layer.matchName !== "ADBE Vector Layer" ||
      layer.inPoint !== 0 ||
      layer.outPoint !== 2 ||
      layer.startTime !== 0 ||
      layer.stretch !== 100
    ) return false;
    var root = layer.property("ADBE Root Vectors Group");
    if (!root || root.numProperties < 0 || root.numProperties > 1) return false;
    if (root.numProperties === 0) return true;
    var group = root.property(1);
    if (!group || group.matchName !== "ADBE Vector Group" || group.name !== expectedName + " Group") return false;
    var contents = group.property("ADBE Vectors Group");
    if (!contents || contents.numProperties < 0 || contents.numProperties > 1) return false;
    if (contents.numProperties === 0) return true;
    var graphic = contents.property(1);
    if (!graphic || graphic.matchName !== expectedGraphic) return false;
    var colors = graphic.property("ADBE Vector Grad Colors");
    return !colors || colors.matchName === "ADBE Vector Grad Colors";
  }

  if (
    !ownsRun ||
    app.project.file !== null ||
    app.project.numItems < 1 ||
    app.project.numItems > expectedNames.length
  ) {
    return JSON.stringify({
      ok: false,
      reason: "owned-fixture-mismatch",
      ownsRun: ownsRun,
      file: app.project.file ? app.project.file.fsName : null,
      numItems: app.project.numItems
    });
  }
  for (var itemIndex = 1; itemIndex <= app.project.numItems; itemIndex += 1) {
    var item = app.project.item(itemIndex);
    var kinds = expectedKinds[itemIndex - 1];
    var isFinalOwnedItem = itemIndex === app.project.numItems;
    var isPartialFinalItem = isFinalOwnedItem && item.numLayers < kinds.length;
    if (
      item.comment !== ${JSON.stringify(ownershipToken)} ||
      item.name !== expectedNames[itemIndex - 1] ||
      item.width !== 640 ||
      item.height !== 360 ||
      item.pixelAspect !== 1 ||
      item.duration !== 2 ||
      item.frameRate !== 24 ||
      item.numLayers > kinds.length ||
      (setupComplete && item.numLayers !== kinds.length) ||
      (!isFinalOwnedItem && item.numLayers !== kinds.length)
    ) {
      return JSON.stringify({
        ok: false,
        reason: "owned-fixture-item-mismatch",
        itemIndex: itemIndex,
        itemName: item.name
      });
    }
    var createdKinds = kinds.slice(0, item.numLayers);
    for (var layerIndex = 1; layerIndex <= item.numLayers; layerIndex += 1) {
      var expectedKind = createdKinds[createdKinds.length - layerIndex];
      var targetExact = exactTarget(item.layer(layerIndex), layerIndex, expectedKind);
      var targetPartial =
        !setupComplete &&
        isFinalOwnedItem &&
        layerIndex === 1 &&
        exactPartialTarget(item.layer(layerIndex), layerIndex, expectedKind);
      if (!targetExact && !targetPartial) {
        return JSON.stringify({
          ok: false,
          reason: "owned-fixture-layer-mismatch",
          itemIndex: itemIndex,
          layerIndex: layerIndex
        });
      }
    }
  }
  if (
    setupComplete &&
    (typeof acceptedTopology !== "string" || JSON.stringify(diagnosticProjectTopology()) !== acceptedTopology)
  ) {
    return JSON.stringify({ ok: false, reason: "owned-fixture-topology-drift" });
  }
  var archive = new File(${JSON.stringify(projectArchivePath)});
  if (archive.exists) {
    return JSON.stringify({ ok: false, reason: "project-archive-already-exists" });
  }
  app.project.save(archive);
  if (!archive.exists || !app.project.file || app.project.file.fsName !== archive.fsName) {
    return JSON.stringify({ ok: false, reason: "project-archive-not-authoritative" });
  }
  var closed = app.project.close(CloseOptions.SAVE_CHANGES);
  if (closed !== true) {
    return JSON.stringify({ ok: false, reason: "project-close-refused" });
  }
  app.newProject();
  var cleanupOk =
    app.project.numItems === 0 &&
    app.project.dirty === false &&
    app.project.file === null;
  if (cleanupOk) {
    delete $.global.__CHROMA_SELECTION_SEMANTICS_OWNER__;
    delete $.global.__CHROMA_SELECTION_SEMANTICS_SETUP_COMPLETE__;
    delete $.global.__CHROMA_SELECTION_SEMANTICS_TOPOLOGY__;
  }
  return JSON.stringify({
    ok: cleanupOk,
    archivePath: archive.fsName,
    numItems: app.project.numItems,
    dirty: app.project.dirty,
    file: app.project.file ? app.project.file.fsName : null
  });
})()`;

const caseSpecs = [
  { name: "fill-leaf-only", maximumLayerCount: 1, operations: [["fill", "leaf", true]] },
  { name: "stroke-leaf-only", maximumLayerCount: 1, operations: [["stroke", "leaf", true]] },
  { name: "fill-parent-only", maximumLayerCount: 1, operations: [["fill", "parent", true]] },
  { name: "stroke-parent-only", maximumLayerCount: 1, operations: [["stroke", "parent", true]] },
  {
    name: "fill-parent-then-leaf",
    maximumLayerCount: 1,
    operations: [["fill", "parent", true], ["fill", "leaf", true]],
  },
  {
    name: "stroke-parent-then-leaf",
    maximumLayerCount: 1,
    operations: [["stroke", "parent", true], ["stroke", "leaf", true]],
  },
  {
    name: "fill-leaf-then-parent-off",
    maximumLayerCount: 1,
    operations: [["fill", "leaf", true], ["fill", "parent", false]],
  },
  {
    name: "stroke-leaf-then-parent-off",
    maximumLayerCount: 1,
    operations: [["stroke", "leaf", true], ["stroke", "parent", false]],
  },
  {
    name: "fill-then-stroke",
    maximumLayerCount: 2,
    operations: [["fill", "leaf", true], ["stroke", "leaf", true]],
  },
  {
    name: "stroke-then-fill",
    maximumLayerCount: 2,
    operations: [["stroke", "leaf", true], ["fill", "leaf", true]],
  },
];
const isPositiveInteger = (value) => Number.isInteger(value) && value > 0;
const validateSnapshot = (snapshot, maximumLayerCount) => {
  if (!snapshot || typeof snapshot !== "object" || snapshot.truncated !== false) {
    return "snapshot-missing-or-truncated";
  }
  if (
    !Number.isInteger(snapshot.selectedLayerCount) ||
    snapshot.selectedLayerCount < 0 ||
    snapshot.selectedLayerCount > maximumLayerCount ||
    !Number.isInteger(snapshot.selectedPropertyCount) ||
    snapshot.selectedPropertyCount < 0 ||
    snapshot.selectedPropertyCount > 32 ||
    !Array.isArray(snapshot.layers) ||
    snapshot.layers.length > maximumLayerCount
  ) {
    return "snapshot-counts-invalid";
  }
  let propertyCount = 0;
  let selectedLayerRecordCount = 0;
  const layerIds = new Set();
  const layerIndexes = new Set();
  for (const layer of snapshot.layers) {
    if (
      !layer ||
      !isPositiveInteger(layer.layerId) ||
      !isPositiveInteger(layer.layerIndex) ||
      layer.layerIndex > maximumLayerCount ||
      typeof layer.layerName !== "string" ||
      layer.layerName.length > 500 ||
      typeof layer.selected !== "boolean" ||
      !Array.isArray(layer.properties) ||
      layer.properties.length > 32
    ) {
      return "snapshot-layer-invalid";
    }
    if (layerIds.has(layer.layerId) || layerIndexes.has(layer.layerIndex)) {
      return "snapshot-layer-identity-duplicate";
    }
    layerIds.add(layer.layerId);
    layerIndexes.add(layer.layerIndex);
    if (layer.selected) selectedLayerRecordCount += 1;
    const propertyKeys = new Set();
    for (const property of layer.properties) {
      if (
        !property ||
        property.selected !== true ||
        !Array.isArray(property.propertyIndexPath) ||
        !Array.isArray(property.matchNamePath) ||
        property.propertyIndexPath.length < 1 ||
        property.propertyIndexPath.length > 32 ||
        property.propertyIndexPath.length !== property.matchNamePath.length ||
        property.propertyIndexPath.some((index) => !isPositiveInteger(index)) ||
        property.matchNamePath.some(
          (matchName) =>
            typeof matchName !== "string" || matchName.length < 1 || matchName.length > 120
        )
      ) {
        return "snapshot-property-invalid";
      }
      const propertyKey = `${property.propertyIndexPath.join(".")}|${property.matchNamePath.join("/")}`;
      if (propertyKeys.has(propertyKey)) return "snapshot-property-identity-duplicate";
      propertyKeys.add(propertyKey);
      propertyCount += 1;
    }
  }
  if (propertyCount !== snapshot.selectedPropertyCount) {
    return "snapshot-property-count-mismatch";
  }
  return selectedLayerRecordCount === snapshot.selectedLayerCount
    ? null
    : "snapshot-selected-layer-count-mismatch";
};
const validateHostResult = (result) => {
  if (
    result.projectItemCount !== 10 ||
    result.projectDirty !== true ||
    result.caseCount !== caseSpecs.length ||
    !Array.isArray(result.cases) ||
    result.cases.length !== caseSpecs.length
  ) {
    return "result-summary-invalid";
  }
  for (let index = 0; index < caseSpecs.length; index += 1) {
    const spec = caseSpecs[index];
    const expectedName = spec.name;
    const maximumLayerCount = spec.maximumLayerCount;
    const report = result.cases[index];
    if (
      !report ||
      report.name !== expectedName ||
      !Array.isArray(report.steps) ||
      report.steps.length !== spec.operations.length
    ) {
      return `case-shape-invalid-${expectedName}`;
    }
    for (const [snapshotName, snapshot] of [
      ["baseline", report.baseline],
      ["insideUndo", report.insideUndo],
      ["afterUndo", report.afterUndo],
    ]) {
      const error = validateSnapshot(snapshot, maximumLayerCount);
      if (error) return `${expectedName}-${snapshotName}-${error}`;
    }
    if (
      report.baseline.selectedLayerCount !== 0 ||
      report.baseline.selectedPropertyCount !== 0
    ) {
      return `case-baseline-not-empty-${expectedName}`;
    }
    for (let stepIndex = 0; stepIndex < report.steps.length; stepIndex += 1) {
      const step = report.steps[stepIndex];
      const [expectedTarget, expectedScope, expectedRequested] = spec.operations[stepIndex];
      if (
        !step ||
        step.target !== expectedTarget ||
        step.scope !== expectedScope ||
        step.requested !== expectedRequested ||
        typeof step.selectedAfterSet !== "boolean" ||
        step.layerSelectedAfterSet !== true
      ) {
        return `case-step-invalid-${expectedName}`;
      }
      const error = validateSnapshot(step.snapshot, maximumLayerCount);
      if (error) return `${expectedName}-step-${error}`;
    }
  }
  return null;
};

let client = null;
let operationGuard = null;
let identity = null;
let hostResult = null;
let hostCleanupAuthorized = false;
let screenshotPath = null;
let primaryError = null;
let successReport = null;
let projectCleanup = null;
const cleanupErrors = [];
try {
  let target = null;
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) {
        const targets = await response.json();
        target = await selectCanonicalCdpTarget(targets, expectedPanelPath, {
          label: `selection-semantics ${label} Main diagnostic`,
        });
        break;
      }
    } catch {}
    await delay(500);
  }
  if (!target?.webSocketDebuggerUrl) fail("Exact Main CDP target did not appear");
  const targetUrl = new URL(target.url);
  if (targetUrl.protocol !== "file:") fail(`Main CDP target is not a file URL: ${target.url}`);
  const targetPanelPath = await realpath(fileURLToPath(targetUrl));
  if (comparablePath(targetPanelPath) !== comparablePath(expectedPanelPath)) {
    fail(`Main CDP target resolved to the wrong panel: ${targetPanelPath}`);
  }

  client = new CdpClient(target.webSocketDebuggerUrl, { timeoutMs: 30_000 });
  await client.connect();
  await Promise.all([
    client.send("Runtime.enable"),
    client.send("Log.enable"),
    client.send("Page.enable"),
  ]);
  operationGuard = guardClientEvaluations(client, `selection-semantics ${label} Main`);
  identity = await client.evaluate(debugCall("(api) => api.getIdentity()"));
  await assertCanonicalRuntimeUrl(identity?.url, expectedPanelPath, {
    label: `selection-semantics ${label} Main runtime`,
  });
  if (
    identity?.extensionId !== contract.product.panelIds.main ||
    identity?.page !== "main" ||
    identity?.buildMarker !== `${contract.marker.current} · ${packageJson.version}`
  ) {
    fail(`Panel identity mismatch: ${JSON.stringify(identity)}`);
  }

  hostResult = await hostEval(client, hostSource);
  hostCleanupAuthorized = hostResult?.cleanupSafe === true;
  if (
    hostResult?.ok !== true ||
    hostResult?.schemaVersion !== 1 ||
    hostResult?.version !== expectedVersion ||
    hostResult?.caseCount !== 10 ||
    !Array.isArray(hostResult?.cases) ||
    hostResult.cases.length !== 10
  ) {
    fail(`Selection-semantics host result failed: ${JSON.stringify(hostResult)}`);
  }
  const hostResultValidationError = validateHostResult(hostResult);
  if (hostResultValidationError) {
    fail(`Selection-semantics evidence invalid: ${hostResultValidationError}`);
  }
  if (harnessHostEvalCount !== 1 || harnessHostEvalAfterResultCount !== 0) {
    fail("Selection-semantics host eval count invariant failed");
  }

  try {
    const screenshot = await client.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
    });
    screenshotPath = resolve(outputDir, `${label}-panel.png`);
    await writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));
  } catch {}

  successReport = {
    passed: true,
    status: "passed",
    label,
    expectedVersion,
    identity,
    panelIdentity: {
      targetUrl: target.url,
      targetPanelPath,
      installedPanelPath,
      expectedPanelPath,
    },
    hostResult,
    harnessHostEvalCount,
    harnessHostEvalAfterResultCount,
    screenshotPath,
    capturedAt: new Date().toISOString(),
  };
} catch (error) {
  primaryError = error;
} finally {
  if (client && hostCleanupAuthorized && operationGuard?.isCompletionKnown() !== false) {
    try {
      harnessHostEvalAfterResultCount += 1;
      projectCleanup = await client.evaluate(`new Promise((resolve, reject) => {
        window.__adobe_cep__.evalScript(${JSON.stringify(cleanupSource)}, (raw) => {
          try { resolve(JSON.parse(raw)); } catch (error) { reject(new Error(raw)); }
        });
      })`);
      if (
        projectCleanup?.ok !== true ||
        projectCleanup.numItems !== 0 ||
        projectCleanup.dirty !== false ||
        projectCleanup.file !== null
      ) {
        throw new Error(`Owned selection-semantics cleanup failed: ${JSON.stringify(projectCleanup)}`);
      }
    } catch (error) {
      cleanupErrors.push({ phase: "project", error: String(error?.stack || error) });
    }
  } else if (client && hostCleanupAuthorized) {
    cleanupErrors.push({
      phase: "project-quarantine",
      error: "Selection-semantics CDP completion is unknown; project cleanup refused",
    });
  }
  try {
    if (client) await client.close();
  } catch (error) {
    cleanupErrors.push({ phase: "close", error: String(error?.stack || error) });
  }
}

if (!primaryError && cleanupErrors.length > 0) {
  primaryError = new AggregateError(
    cleanupErrors.map(({ error }) => new Error(error)),
    "Selection-semantics cleanup failed"
  );
}

if (primaryError) {
  const failureText = `${JSON.stringify({
    passed: false,
    status: "failed",
    label,
    expectedVersion,
    error: String(primaryError?.stack || primaryError),
    identity,
    hostResult,
    hostCallDispatched,
    hostCleanupAuthorized,
    harnessHostEvalCount,
    harnessHostEvalAfterResultCount,
    screenshotPath,
    cleanupErrors,
    projectCleanup,
    capturedAt: new Date().toISOString(),
  }, null, 2)}\n`;
  const evidenceWriteErrors = [];
  for (const [phase, path] of [["report", reportPath], ["failure", failurePath]]) {
    try { await writeFile(path, failureText); } catch (error) {
      evidenceWriteErrors.push({ phase: `failure-evidence:${phase}`, error: String(error?.stack || error) });
    }
  }
  if (evidenceWriteErrors.length > 0) primaryError.evidenceWriteErrors = evidenceWriteErrors;
  throw primaryError;
}

successReport.harnessHostEvalAfterResultCount = harnessHostEvalAfterResultCount;
successReport.restoredState = {
  projectCleanup,
  panelConfigChanged: false,
};
try {
  await rm(failurePath, { force: true });
  await writeFile(reportPath, `${JSON.stringify(successReport, null, 2)}\n`);
} catch (publicationError) {
  const failureText = `${JSON.stringify({
    passed: false,
    status: "failed",
    label,
    expectedVersion,
    error: String(publicationError?.stack || publicationError),
    capturedAt: new Date().toISOString(),
  }, null, 2)}\n`;
  const evidenceWriteErrors = [];
  for (const [phase, path] of [["report", reportPath], ["failure", failurePath]]) {
    try { await writeFile(path, failureText); } catch (error) {
      evidenceWriteErrors.push({ phase: `failure-evidence:${phase}`, error: String(error?.stack || error) });
    }
  }
  if (evidenceWriteErrors.length > 0) publicationError.evidenceWriteErrors = evidenceWriteErrors;
  throw publicationError;
}
console.log(
  JSON.stringify({
    passed: true,
    version: hostResult.version,
    caseCount: hostResult.caseCount,
    harnessHostEvalCount,
    harnessHostEvalAfterResultCount,
    outputDir,
  })
);
