#!/usr/bin/env node

import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
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
const { CdpClient } = await import(
  pathToFileURL(resolve(repo, "scripts/lib/cdp-client.mjs")).href
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
  var MAX_SELECTED_PROPERTIES = 32;
  var EXPECTED_VERSION = ${JSON.stringify(expectedVersion)};
  var reports = [];
  var records = [];
  var undoOpened = false;
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
    if (!app.project || app.project.numItems !== 0 || app.project.dirty !== false) {
      return JSON.stringify({
        ok: false,
        stage: "preflight",
        reason: "current-project-not-empty-clean",
        version: app.version,
        items: app.project ? app.project.numItems : null,
        dirty: app.project ? app.project.dirty : null
      });
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
    app.endUndoGroup();

    stage = "after-undo-capture";
    for (var recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
      records[recordIndex].report.afterUndo = snapshot(records[recordIndex].comp);
    }

    return JSON.stringify({
      ok: true,
      schemaVersion: 1,
      version: app.version,
      caseCount: reports.length,
      cases: reports,
      projectItemCount: app.project.numItems,
      projectDirty: app.project.dirty === true
    });
  } catch (error) {
    var closeError = null;
    if (undoOpened) {
      undoOpened = false;
      try {
        app.endUndoGroup();
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
      caseCount: reports.length,
      cases: reports
    });
  }
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
let identity = null;
let hostResult = null;
let screenshotPath = null;
let primaryError = null;
await mkdir(outputDir, { recursive: true });
try {
  let target = null;
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) {
        const targets = await response.json();
        const matches = targets.filter(
          (entry) =>
            entry.type === "page" && new URL(entry.url).pathname.endsWith("/main/index.html")
        );
        if (matches.length === 1) {
          target = matches[0];
          break;
        }
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
  identity = await client.evaluate(debugCall("(api) => api.getIdentity()"));
  if (
    identity?.extensionId !== contract.product.panelIds.main ||
    identity?.page !== "main" ||
    identity?.buildMarker !== `${contract.marker.current} · ${packageJson.version}`
  ) {
    fail(`Panel identity mismatch: ${JSON.stringify(identity)}`);
  }

  hostResult = await hostEval(client, hostSource);
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

  const report = {
    passed: true,
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
    preservedState: {
      projectCleanupAttempted: false,
      undoCommandAttempted: false,
      panelConfigChanged: false,
    },
    capturedAt: new Date().toISOString(),
  };
  await writeFile(
    resolve(outputDir, `${label}-report.json`),
    `${JSON.stringify(report, null, 2)}\n`
  );
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
} catch (error) {
  primaryError = error;
  try {
    await writeFile(
      resolve(outputDir, `${label}-failure.json`),
      `${JSON.stringify(
        {
          passed: false,
          error: String(error?.stack || error),
          identity,
          hostResult,
          hostCallDispatched,
          harnessHostEvalCount,
          harnessHostEvalAfterResultCount,
          preservedState: {
            projectCleanupAttempted: false,
            undoCommandAttempted: false,
            panelConfigChanged: false,
          },
          capturedAt: new Date().toISOString(),
        },
        null,
        2
      )}\n`
    );
  } catch {}
} finally {
  try {
    if (client) await client.close();
  } catch {}
}
if (primaryError) throw primaryError;
