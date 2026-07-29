#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [repo, label, expectedVersion, outputDir, portArgument] = process.argv.slice(2);
if (!repo || !label || !expectedVersion || !outputDir) {
  throw new Error(
    "usage: diagnose-ae23-selection-restore.mjs <repo> <label> <expectedVersion> <outputDir> [cdp-port]"
  );
}
const port = portArgument || "8198";
const toolkit = await import(
  pathToFileURL(resolve(repo, "node_modules/@zimoby/ae-native-gradient/dist/index.js"))
);
const { CdpClient } = await import(
  pathToFileURL(resolve(repo, "scripts/lib/cdp-client.mjs"))
);
const contract = JSON.parse(
  await readFile(resolve(repo, "src/shared/product-contract.json"), "utf8")
);
const packageJson = JSON.parse(await readFile(resolve(repo, "package.json"), "utf8"));
const token = `${label}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
const scratch = resolve(tmpdir(), `chroma-relay-${token}`);
const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
const fail = (message) => {
  throw new Error(message);
};
const debugCall = (source) => `(() => {
  const api = window.__CHROMA_RELAY_DEBUG__;
  if (!api) throw new Error("Chroma Relay debug API unavailable");
  return (${source})(api);
})()`;

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
  if (!app.project) app.newProject();
  if (!app.project || app.project.numItems !== 0 || app.project.dirty !== false) {
    return JSON.stringify({
      ok: false,
      reason: "current-project-not-empty-clean",
      version: app.version,
      items: app.project ? app.project.numItems : null,
      dirty: app.project ? app.project.dirty : null
    });
  }
  app.beginUndoGroup("Chroma Relay AE23 selection diagnostic fixture");
  try {
    var comp = app.project.items.addComp("CHROMA_AE23_SELECTION_${label}", 640, 360, 1, 2, 24);
    function addTarget(layerName, kind) {
      var layer = comp.layers.addShape();
      layer.name = layerName;
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
    return JSON.stringify({
      ok: true,
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
  } finally {
    app.endUndoGroup();
  }
})()`;

let client = null;
let identity = null;
let originalConfigRoot = null;
let setup = null;
let baseline = null;
let snapshot = null;
let actionResult = null;
let screenshotPath = null;
let primaryError = null;
await mkdir(outputDir, { recursive: true });
await mkdir(scratch, { recursive: false });

try {
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
  if (!target) fail("Exact Main CDP target did not appear");

  client = new CdpClient(target.webSocketDebuggerUrl, { timeoutMs: 30_000 });
  await client.connect();
  await Promise.all([
    client.send("Runtime.enable"),
    client.send("Log.enable"),
    client.send("Page.enable"),
  ]);

  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      identity = await client.evaluate(debugCall("(api) => api.getIdentity()"));
      if (identity?.buildMarker === `${contract.marker.current} · ${packageJson.version}`) break;
    } catch {}
    identity = null;
    await delay(100);
  }
  if (!identity) fail("Exact Chroma debug identity did not stabilize");
  if (
    identity.extensionId !== contract.product.panelIds.main ||
    identity.page !== "main"
  ) {
    fail(`Panel identity mismatch: ${JSON.stringify(identity)}`);
  }

  originalConfigRoot = identity.configRoot ?? null;
  await client.evaluate(
    debugCall(`(api) => api.setTemporaryConfigRoot(${JSON.stringify(scratch)})`)
  );
  const loaded = await client.evaluate(debugCall("(api) => api.reloadPalette()"));
  if (loaded?.error) fail(`Palette load failed: ${JSON.stringify(loaded.error)}`);

  setup = await hostEval(client, setupSource);
  if (
    setup.ok !== true ||
    setup.version !== expectedVersion ||
    setup.selectedLayers !== 2 ||
    setup.fillSelected !== true ||
    setup.strokeSelected !== true
  ) {
    fail(`Version-native fixture setup failed: ${JSON.stringify(setup)}`);
  }

  baseline = await client.evaluate(debugCall("(api) => api.getCounters()"));
  actionDispatched = true;
  const accepted = await client.evaluate(
    debugCall('(api) => api.dispatchClick("swatch-diagnostic-gradient")')
  );
  if (accepted !== true) fail("Gradient swatch click was not accepted");

  for (let attempt = 0; attempt < 240; attempt += 1) {
    snapshot = await client.evaluate(
      debugCall("(api) => ({ state: api.getState(), counters: api.getCounters() })")
    );
    if (
      snapshot.state.pendingHostAction === null &&
      snapshot.counters.hostCalls === baseline.hostCalls + 1
    ) {
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
  const report = {
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
    preservedState: {
      panelTemporaryConfigRoot: scratch,
      scratchRemoved: false,
      projectCleanupAttempted: false,
      panelCleanupAttempted: false,
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
      outcome: report.outcome,
      hostVersion: hostResult.hostVersion,
      harnessHostEvalCount,
      harnessHostEvalAfterActionCount,
      outputDir,
      scratch,
    })
  );
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
  try {
    await writeFile(
      resolve(outputDir, `${label}-failure.json`),
      `${JSON.stringify(
        {
          passed: false,
          label,
          expectedVersion,
          port,
          error: String(primaryError?.stack || primaryError),
          identity,
          originalConfigRoot,
          scratch,
          setup,
          baseline,
          snapshot,
          actionResult,
          actionDispatched,
          harnessHostEvalCount,
          harnessHostEvalAfterActionCount,
          screenshotPath,
          preservedState: {
            panelTemporaryConfigRoot: scratch,
            scratchRemoved: false,
            projectCleanupAttempted: false,
            panelCleanupAttempted: false,
          },
          capturedAt: new Date().toISOString(),
        },
        null,
        2
      )}\n`
    );
  } catch (writeError) {
    if (!primaryError) primaryError = writeError;
  }
} finally {
  try {
    if (client) await client.close();
  } catch {}
}

if (primaryError) throw primaryError;
