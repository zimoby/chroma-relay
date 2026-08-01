#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [repo, label, expectedVersion, outputDir, portArgument] = process.argv.slice(2);
if (!repo || !label || !expectedVersion || !outputDir) {
  throw new Error(
    "usage: diagnose-ae23-selection-restore.mjs <repo> <label> <expectedVersion> <outputDir> [cdp-port]"
  );
}
if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(label)) {
  throw new Error("AE23 diagnostic label must be a lowercase safe token");
}
const port = portArgument || "8198";
const ownershipToken = `chroma-relay-ae23-${randomBytes(16).toString("hex")}`;

const reportPath = resolve(outputDir, `${label}-report.json`);
const failurePath = resolve(outputDir, `${label}-failure.json`);
const projectArchivePath = resolve(outputDir, `${label}-${ownershipToken}.aep`);
await mkdir(outputDir, { recursive: true });
await writeFile(
  reportPath,
  `${JSON.stringify({ passed: false, status: "running", label, expectedVersion, port }, null, 2)}\n`
);
const toolkit = await import(
  pathToFileURL(resolve(repo, "node_modules/@zimoby/ae-native-gradient/dist/index.js"))
);
const { CdpClient } = await import(
  pathToFileURL(resolve(repo, "scripts/lib/cdp-client.mjs"))
);
const {
  assertCanonicalRuntimeUrl,
  createOwnedTemporaryConfigDirectory,
  guardClientEvaluations,
  removeOwnedRunDirectory,
  restoreConfigRootWithReadback,
  selectCanonicalCdpTarget,
} = await import(
  pathToFileURL(resolve(repo, "scripts/lib/live-runner-policy.mjs"))
);
const contract = JSON.parse(
  await readFile(resolve(repo, "src/shared/product-contract.json"), "utf8")
);
const packageJson = JSON.parse(await readFile(resolve(repo, "package.json"), "utf8"));
const expectedPanelPath = resolve(repo, "dist/cep/main/index.html");
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
    for (var easeIndex = 0; easeIndex < ease.length; easeIndex += 1) result.push({ speed: ease[easeIndex].speed, influence: ease[easeIndex].influence });
    return result;
  }
  function diagnosticProperty(property) {
    var result = { name: property.name, matchName: property.matchName, propertyType: property.propertyType, propertyIndex: property.propertyIndex, enabled: property.enabled, active: property.active, elided: property.elided, numProperties: property.numProperties || 0 };
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
    for (var propertyIndex = 1; propertyIndex <= result.numProperties; propertyIndex += 1) result.children.push(diagnosticProperty(property.property(propertyIndex)));
    return result;
  }
  function diagnosticProjectTopology() {
    var topology = { numItems: app.project.numItems, items: [] };
    for (var itemIndex = 1; itemIndex <= app.project.numItems; itemIndex += 1) {
      var item = app.project.item(itemIndex);
      var itemState = { id: item.id, name: item.name, typeName: item.typeName, comment: item.comment, label: item.label };
      if (item instanceof CompItem) {
        itemState.comp = { width: item.width, height: item.height, pixelAspect: item.pixelAspect, duration: item.duration, frameRate: item.frameRate, displayStartTime: item.displayStartTime, workAreaStart: item.workAreaStart, workAreaDuration: item.workAreaDuration, numLayers: item.numLayers, layers: [] };
        for (var layerIndex = 1; layerIndex <= item.numLayers; layerIndex += 1) {
          var layer = item.layer(layerIndex);
          itemState.comp.layers.push({ id: layer.id, index: layer.index, name: layer.name, matchName: layer.matchName, comment: layer.comment, label: layer.label, enabled: layer.enabled, locked: layer.locked, shy: layer.shy, solo: layer.solo, guideLayer: layer.guideLayer, adjustmentLayer: layer.adjustmentLayer, threeDLayer: layer.threeDLayer, parentId: layer.parent ? layer.parent.id : null, blendingMode: String(layer.blendingMode), trackMatteType: String(layer.trackMatteType), inPoint: layer.inPoint, outPoint: layer.outPoint, startTime: layer.startTime, stretch: layer.stretch, properties: diagnosticProperty(layer) });
        }
      }
      topology.items.push(itemState);
    }
    return topology;
  }
`;

let actionDispatched = false;
let harnessHostEvalCount = 0;
let harnessHostEvalAfterActionCount = 0;
const hostEval = (client, source) => {
  if (actionDispatched) {
    harnessHostEvalAfterActionCount += 1;
    throw new Error("Harness host eval is forbidden after product action dispatch");
  }
  harnessHostEvalCount += 1;
  return client.evaluate(`new Promise((resolve, reject) => {
    window.__adobe_cep__.evalScript(${JSON.stringify(source)}, (raw) => {
      try { resolve(JSON.parse(raw)); } catch (error) { reject(new Error(raw)); }
    });
  })`);
};

const setupSource = `(function () {
  ${diagnosticTopologySource}
  if (app.version !== ${JSON.stringify(expectedVersion)}) {
    return JSON.stringify({
      ok: false,
      reason: "unexpected-ae-version",
      version: app.version
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
      reason: "current-project-not-empty-clean",
      version: app.version,
      items: app.project ? app.project.numItems : null,
      dirty: app.project ? app.project.dirty : null
    });
  }
  if ($.global.__CHROMA_AE23_DIAGNOSTIC_OWNER__ != null) {
    return JSON.stringify({ ok: false, reason: "foreign-owner-present" });
  }
  app.beginUndoGroup("Chroma Relay AE23 selection diagnostic fixture");
  var undoOpened = true;
  var comp = null;
  try {
    comp = app.project.items.addComp("CHROMA_AE23_SELECTION_${label}", 640, 360, 1, 2, 24);
    comp.comment = ${JSON.stringify(ownershipToken)};
    $.global.__CHROMA_AE23_DIAGNOSTIC_OWNER__ = ${JSON.stringify(ownershipToken)};
    function addTarget(layerName, kind) {
      var layer = comp.layers.addShape();
      layer.name = layerName;
      layer.comment = ${JSON.stringify(ownershipToken)};
      var root = layer.property("ADBE Root Vectors Group");
      var group = root.addProperty("ADBE Vector Group");
      group.name = layerName + " Group";
      var contents = group.property("ADBE Vectors Group");
      var graphic = contents.addProperty(
        kind === "fill" ? "ADBE Vector Graphic - G-Fill" : "ADBE Vector Graphic - G-Stroke"
      );
      var colors = graphic.property("ADBE Vector Grad Colors");
      if (!colors) throw new Error("gradient-colors-missing-" + kind);
      return { layer: layer, colors: colors, kind: kind };
    }
    var fill = addTarget("CHROMA_AE23_FILL", "fill");
    var stroke = addTarget("CHROMA_AE23_STROKE", "stroke");
    for (var layerIndex = 1; layerIndex <= comp.numLayers; layerIndex += 1) {
      var layer = comp.layer(layerIndex);
      var selected = layer.selectedProperties;
      for (var propertyIndex = selected.length - 1; propertyIndex >= 0; propertyIndex -= 1) {
        selected[propertyIndex].selected = false;
      }
      layer.selected = false;
    }
    fill.layer.selected = true;
    stroke.layer.selected = true;
    fill.colors.selected = true;
    stroke.colors.selected = true;
    comp.openInViewer();
    $.global.__CHROMA_AE23_DIAGNOSTIC_TOPOLOGY__ = JSON.stringify(diagnosticProjectTopology());
    $.global.__CHROMA_AE23_DIAGNOSTIC_SETUP_COMPLETE__ = ${JSON.stringify(ownershipToken)};
    return JSON.stringify({
      ok: true,
      cleanupSafe: true,
      version: app.version,
      compName: comp.name,
      selectedLayers: comp.selectedLayers.length,
      fillSelected: fill.colors.selected,
      strokeSelected: stroke.colors.selected,
      fillLayerId: fill.layer.id,
      strokeLayerId: stroke.layer.id,
      fillLayerIndex: fill.layer.index,
      strokeLayerIndex: stroke.layer.index,
      fillMatchName: fill.colors.matchName,
      strokeMatchName: stroke.colors.matchName
    });
  } catch (error) {
    var undoCloseError = null;
    if (undoOpened) {
      undoOpened = false;
      try {
        app.endUndoGroup();
      } catch (closeError) {
        undoCloseError = String(closeError && closeError.message ? closeError.message : closeError);
      }
    }
    return JSON.stringify({
      ok: false,
      cleanupSafe: undoCloseError === null,
      error: String(error && error.message ? error.message : error),
      undoCloseError: undoCloseError,
      version: app.version,
      numItems: app.project.numItems,
      numLayers: comp ? comp.numLayers : null
    });
  } finally {
    if (undoOpened) app.endUndoGroup();
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
  var ownsRun = $.global.__CHROMA_AE23_DIAGNOSTIC_OWNER__ === ${JSON.stringify(ownershipToken)};
  var setupComplete = $.global.__CHROMA_AE23_DIAGNOSTIC_SETUP_COMPLETE__ === ${JSON.stringify(ownershipToken)};
  var acceptedTopology = $.global.__CHROMA_AE23_DIAGNOSTIC_TOPOLOGY__;
  var comp = app.project.item(1);
  function exactTarget(layer, expectedIndex, expectedName, expectedGraphic) {
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
  function exactPartialTarget(layer, expectedIndex, expectedName, expectedGraphic) {
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
    app.project.numItems !== 1 ||
    !comp ||
    comp.name !== "CHROMA_AE23_SELECTION_${label}" ||
    comp.comment !== ${JSON.stringify(ownershipToken)} ||
    comp.width !== 640 ||
    comp.height !== 360 ||
    comp.pixelAspect !== 1 ||
    comp.duration !== 2 ||
    comp.frameRate !== 24 ||
    comp.numLayers > 2 ||
    (setupComplete && comp.numLayers !== 2)
  ) {
    return JSON.stringify({
      ok: false,
      reason: "owned-fixture-mismatch",
      file: app.project.file ? app.project.file.fsName : null,
      numItems: app.project.numItems
    });
  }
  var createdKinds = ["fill", "stroke"].slice(0, comp.numLayers);
  for (var layerIndex = 1; layerIndex <= comp.numLayers; layerIndex += 1) {
    var kind = createdKinds[createdKinds.length - layerIndex];
    var expectedName = kind === "fill" ? "CHROMA_AE23_FILL" : "CHROMA_AE23_STROKE";
    var expectedGraphic = kind === "fill"
      ? "ADBE Vector Graphic - G-Fill"
      : "ADBE Vector Graphic - G-Stroke";
    var targetExact = exactTarget(comp.layer(layerIndex), layerIndex, expectedName, expectedGraphic);
    var targetPartial =
      !setupComplete &&
      layerIndex === 1 &&
      exactPartialTarget(comp.layer(layerIndex), layerIndex, expectedName, expectedGraphic);
    if (!targetExact && !targetPartial) {
      return JSON.stringify({
        ok: false,
        reason: "owned-fixture-layer-mismatch",
        layerIndex: layerIndex,
        kind: kind
      });
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
    delete $.global.__CHROMA_AE23_DIAGNOSTIC_OWNER__;
    delete $.global.__CHROMA_AE23_DIAGNOSTIC_SETUP_COMPLETE__;
    delete $.global.__CHROMA_AE23_DIAGNOSTIC_TOPOLOGY__;
  }
  return JSON.stringify({
    ok: cleanupOk,
    archivePath: archive.fsName,
    numItems: app.project.numItems,
    dirty: app.project.dirty,
    file: app.project.file ? app.project.file.fsName : null
  });
})()`;

let client = null;
let operationGuard = null;
let identity = null;
let originalConfigRoot = null;
let setup = null;
let projectSetupAttempted = false;
let projectCleanupAuthorized = false;
let baseline = null;
let snapshot = null;
let actionResult = null;
let screenshotPath = null;
let primaryError = null;
let successReport = null;
let scratchRun = null;
let scratch = null;
let configMutationAttempted = false;
let configRestored = false;
let projectCleanup = null;
let scratchRemoved = false;
const cleanupErrors = [];

try {
  scratchRun = await createOwnedTemporaryConfigDirectory({
    tokenPrefix: `chroma-relay-ae23-${label}`,
  });
  scratch = scratchRun.path;
  const gradient = toolkit.createImplicitDefaultNativeGradient();
  const palette = {
    schemaVersion: 3,
    revision: 1,
    activePaletteId: "palette-default",
    palettes: [
      {
        id: "palette-default",
        name: "AE23 Selection Diagnostic",
        colors: [{ id: "diagnostic-gradient", rgba: [1, 1, 1, 1], gradient }],
      },
    ],
  };
  await writeFile(resolve(scratch, "palette.json"), `${JSON.stringify(palette, null, 2)}\n`);

  let target = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) {
        const targets = await response.json();
        target = await selectCanonicalCdpTarget(targets, expectedPanelPath, {
          label: `AE23 ${label} Main diagnostic`,
        });
        break;
      }
    } catch {}
    await delay(500);
  }
  if (!target?.webSocketDebuggerUrl) fail("Exact canonical Main CDP target did not appear");

  client = new CdpClient(target.webSocketDebuggerUrl, { timeoutMs: 30_000 });
  await client.connect();
  await Promise.all([
    client.send("Runtime.enable"),
    client.send("Log.enable"),
    client.send("Page.enable"),
  ]);
  operationGuard = guardClientEvaluations(client, `AE23 ${label} Main`);

  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      identity = await client.evaluate(debugCall("(api) => api.getIdentity()"));
      if (identity?.buildMarker === `${contract.marker.current} · ${packageJson.version}`) break;
    } catch {}
    identity = null;
    await delay(100);
  }
  if (!identity) fail("Exact Chroma debug identity did not stabilize");
  await assertCanonicalRuntimeUrl(identity.url, expectedPanelPath, {
    label: `AE23 ${label} Main runtime`,
  });
  if (
    identity.extensionId !== contract.product.panelIds.main ||
    identity.page !== "main"
  ) {
    fail(`Panel identity mismatch: ${JSON.stringify(identity)}`);
  }

  originalConfigRoot = identity.configRoot ?? null;
  projectSetupAttempted = true;
  setup = await hostEval(client, setupSource);
  projectCleanupAuthorized = setup?.cleanupSafe === true;
  if (
    setup.ok !== true ||
    setup.version !== expectedVersion ||
    setup.selectedLayers !== 2 ||
    setup.fillSelected !== true ||
    setup.strokeSelected !== true
  ) {
    fail(`Version-native fixture setup failed: ${JSON.stringify(setup)}`);
  }
  projectCleanupAuthorized = true;

  configMutationAttempted = true;
  projectCleanupAuthorized = false;
  await client.evaluate(
    debugCall(`(api) => api.setTemporaryConfigRoot(${JSON.stringify(scratch)})`)
  );
  projectCleanupAuthorized = false;
  const loaded = await client.evaluate(debugCall("(api) => api.reloadPalette()"));
  projectCleanupAuthorized = true;
  if (loaded?.error) fail(`Palette load failed: ${JSON.stringify(loaded.error)}`);

  baseline = await client.evaluate(debugCall("(api) => api.getCounters()"));
  actionDispatched = true;
  projectCleanupAuthorized = false;
  const accepted = await client.evaluate(
    debugCall('(api) => api.dispatchClick("swatch-diagnostic-gradient")')
  );
  if (accepted !== true) fail("Gradient swatch click was not accepted");

  let actionTerminalConfirmed = false;
  for (let attempt = 0; attempt < 240; attempt += 1) {
    snapshot = await client.evaluate(
      debugCall("(api) => ({ state: api.getState(), counters: api.getCounters() })")
    );
    if (
      snapshot.state.pendingHostAction === null &&
      snapshot.counters.hostCalls === baseline.hostCalls + 1
    ) {
      actionTerminalConfirmed = true;
      break;
    }
    await delay(100);
  }
  actionResult = snapshot?.state?.lastHostResult ?? null;

  try {
    const screenshot = await client.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
    });
    screenshotPath = resolve(outputDir, `${label}-main.png`);
    await writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));
  } catch {}

  const hostResult = actionResult?.hostResult ?? null;
  projectCleanupAuthorized =
    actionTerminalConfirmed && hostResult?.undoGroupClosed === true;
  const returnedExpectedAction =
    actionResult &&
    actionResult.generated?.length === 2 &&
    actionResult.cleanup?.every((entry) => entry.removed === true) &&
    hostResult &&
    hostResult.primaryStatus === "ok" &&
    hostResult.hostVersion === expectedVersion &&
    hostResult.selectedTargetCount === 2 &&
    hostResult.appliedTargetCount === 2 &&
    hostResult.undoGroupClosed === true;
  const diagnostics = hostResult?.selectionDiagnostics ?? null;
  const inGroup = diagnostics?.inGroup ?? null;
  const afterUndoGroup = diagnostics?.afterUndoGroup ?? null;
  const diagnosticCaptured =
    hostResult?.selectionRestored === false &&
    hostResult?.status === "selection-restore-failed" &&
    diagnostics?.schemaVersion === 1 &&
    typeof inGroup?.stage === "string" &&
    Array.isArray(inGroup?.expected) &&
    inGroup.expected.length > 0 &&
    typeof inGroup?.expectedTruncated === "boolean" &&
    (inGroup?.actual === null || Array.isArray(inGroup?.actual)) &&
    typeof inGroup?.actualTruncated === "boolean" &&
    typeof inGroup?.exact === "boolean" &&
    Array.isArray(inGroup?.layers) &&
    inGroup.layers.length > 0 &&
    typeof inGroup?.layersTruncated === "boolean" &&
    afterUndoGroup !== null &&
    typeof afterUndoGroup?.exact === "boolean" &&
    typeof afterUndoGroup?.actualTruncated === "boolean" &&
    (afterUndoGroup?.actual === null || Array.isArray(afterUndoGroup?.actual));
  const unexpectedlyRestored =
    hostResult?.selectionRestored === true && hostResult?.status === "ok";
  if (harnessHostEvalAfterActionCount !== 0) {
    fail(
      `Harness issued ${harnessHostEvalAfterActionCount} forbidden host evaluations after product dispatch`
    );
  }
  if (!returnedExpectedAction || (!diagnosticCaptured && !unexpectedlyRestored)) {
    fail(`Diagnostic result was incomplete: ${JSON.stringify(actionResult)}`);
  }

  const consoleErrors = client.events.filter(
    (event) =>
      event.method === "Runtime.exceptionThrown" ||
      (event.method === "Log.entryAdded" && event.params?.entry?.level === "error")
  );
  successReport = {
    passed: true,
    label,
    expectedVersion,
    port,
    identity,
    originalConfigRoot,
    scratch,
    setup,
    baseline,
    snapshot,
    actionResult,
    outcome: diagnosticCaptured ? "selection-diagnostic-captured" : "selection-restored",
    harnessHostEvalCount,
    harnessHostEvalAfterActionCount,
    screenshotPath,
    consoleErrorCount: consoleErrors.length,
    consoleErrors,
    capturedAt: new Date().toISOString(),
  };
} catch (error) {
  primaryError = error;
  try {
    if (client && actionDispatched) {
      const screenshot = await client.send("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
      });
      screenshotPath = resolve(outputDir, `${label}-failure-main.png`);
      await writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));
    }
  } catch {}
} finally {
  if (client && projectCleanupAuthorized && operationGuard?.isCompletionKnown() !== false) {
    try {
      if (actionDispatched) harnessHostEvalAfterActionCount += 1;
      projectCleanupAuthorized = false;
      projectCleanup = await client.evaluate(`new Promise((resolve, reject) => {
        window.__adobe_cep__.evalScript(${JSON.stringify(cleanupSource)}, (raw) => {
          try { resolve(JSON.parse(raw)); } catch (error) { reject(new Error(raw)); }
        });
      })`);
      projectCleanupAuthorized = true;
      if (
        projectCleanup?.ok !== true ||
        projectCleanup.numItems !== 0 ||
        projectCleanup.dirty !== false ||
        projectCleanup.file !== null
      ) {
        throw new Error(`Owned diagnostic project cleanup failed: ${JSON.stringify(projectCleanup)}`);
      }
    } catch (error) {
      cleanupErrors.push({ phase: "project", error: String(error?.stack || error) });
    }
  } else if (client && projectCleanupAuthorized) {
    cleanupErrors.push({
      phase: "project-quarantine",
      error: "AE23 diagnostic CDP completion is unknown; project and config cleanup refused",
    });
  }
  if (
    client &&
    configMutationAttempted &&
    projectCleanupAuthorized &&
    operationGuard?.isCompletionKnown() !== false
  ) {
    try {
      await restoreConfigRootWithReadback({
        expectedRoot: originalConfigRoot,
        setRoot: (root) => client.evaluate(
          debugCall(`(api) => api.setTemporaryConfigRoot(${JSON.stringify(root)})`)
        ),
        settle: () => client.evaluate(
          "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))"
        ),
        readRoot: () => client.evaluate(debugCall("(api) => api.getIdentity().configRoot")),
        label: "AE23 diagnostic Main config root",
      });
      configRestored = true;
    } catch (error) {
      cleanupErrors.push({ phase: "config", error: String(error?.stack || error) });
    }
  }
  try {
    if (client) await client.close();
  } catch (closeError) {
    cleanupErrors.push({ phase: "close", error: String(closeError?.stack || closeError) });
  }
  if (scratchRun && (!configMutationAttempted || configRestored)) {
    try {
      await removeOwnedRunDirectory(scratchRun);
      scratchRemoved = true;
    } catch (error) {
      cleanupErrors.push({ phase: "scratch", error: String(error?.stack || error) });
    }
  }
}

if (!primaryError && cleanupErrors.length > 0) {
  primaryError = new AggregateError(
    cleanupErrors.map(({ error }) => new Error(error)),
    "AE23 diagnostic cleanup failed"
  );
}

if (primaryError) {
  const failure = {
    passed: false,
    status: "failed",
    label,
    expectedVersion,
    port,
    error: String(primaryError?.stack || primaryError),
    identity,
    originalConfigRoot,
    scratch,
    setup,
    projectSetupAttempted,
    projectCleanupAuthorized,
    baseline,
    snapshot,
    actionResult,
    actionDispatched,
    harnessHostEvalCount,
    harnessHostEvalAfterActionCount,
    screenshotPath,
    cleanupErrors,
    projectCleanup,
    configRestored,
    scratchRemoved,
    capturedAt: new Date().toISOString(),
  };
  const failureText = `${JSON.stringify(failure, null, 2)}\n`;
  const evidenceWriteErrors = [];
  for (const [phase, path] of [["report", reportPath], ["failure", failurePath]]) {
    try { await writeFile(path, failureText); } catch (error) {
      evidenceWriteErrors.push({ phase: `failure-evidence:${phase}`, error: String(error?.stack || error) });
    }
  }
  if (evidenceWriteErrors.length > 0) primaryError.evidenceWriteErrors = evidenceWriteErrors;
  throw primaryError;
}

successReport.harnessHostEvalAfterActionCount = harnessHostEvalAfterActionCount;
successReport.restoredState = { projectCleanup, configRestored, scratchRemoved };
try {
  await rm(failurePath, { force: true });
  await writeFile(reportPath, `${JSON.stringify(successReport, null, 2)}\n`);
} catch (publicationError) {
  const failureText = `${JSON.stringify({
    passed: false,
    status: "failed",
    label,
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
    outcome: successReport.outcome,
    hostVersion: successReport.actionResult.hostVersion,
    harnessHostEvalCount,
    harnessHostEvalAfterActionCount,
    outputDir,
    scratch,
  })
);
