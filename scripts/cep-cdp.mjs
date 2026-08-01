#!/usr/bin/env node

import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
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
  restoreConfigRootWithReadback,
  selectCanonicalCdpTarget,
} from "./lib/live-runner-policy.mjs";
import contract from "../src/shared/product-contract.json" with { type: "json" };
import packageJson from "../package.json" with { type: "json" };

const EXPECTED_BUILD_MARKER = `${contract.marker.current} · ${packageJson.version}`;

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const BUILD_ROOT = resolve(REPO_ROOT, "dist/cep");
const FIXTURES = [
  { width: 128, height: 32 },
  { width: 160, height: 32 },
  { width: 128, height: 160 },
  { width: 200, height: 200 },
];
const PANELS = [
  {
    page: "main",
    port: 8198,
    extensionId: contract.product.panelIds.main,
    pageSuffix: "/main/index.html",
  },
  {
    page: "settings",
    port: 8199,
    extensionId: contract.product.panelIds.settings,
    pageSuffix: "/settings/index.html",
  },
];

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

const getTargets = async (port) => {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error(`CDP ${port} returned HTTP ${response.status}`);
  return response.json();
};

const targetPath = (target) => {
  try {
    return fileURLToPath(target.url).replaceAll("\\", "/");
  } catch {
    return "";
  }
};

export const pathMatchesPageSuffix = (path, pageSuffix) =>
  String(path).replaceAll("\\", "/").endsWith(pageSuffix);

const selectTarget = (targets, panel, {
  expectedPage = resolve(BUILD_ROOT, `${panel.page}/index.html`),
  realpathFn,
} = {}) =>
  selectCanonicalCdpTarget(targets, expectedPage, {
    label: `${panel.page} CDP ${panel.port}`,
    ...(realpathFn ? { realpathFn } : {}),
  });

const assertIdentity = async (
  identity,
  panel,
  {
    expectedPage = resolve(BUILD_ROOT, `${panel.page}/index.html`),
    realpathFn,
  } = {}
) => {
  if (identity.extensionId !== panel.extensionId) {
    throw new Error(
      `${panel.page} runtime ID mismatch: expected ${panel.extensionId}, got ${identity.extensionId}`
    );
  }
  if (identity.page !== panel.page) {
    throw new Error(`${panel.page} runtime page identity mismatch`);
  }
  await assertCanonicalRuntimeUrl(identity.url, expectedPage, {
    label: `${panel.page} connected runtime`,
    ...(realpathFn ? { realpathFn } : {}),
  });
  if (identity.buildMarker !== EXPECTED_BUILD_MARKER) {
    throw new Error(`${panel.page} build marker mismatch: ${identity.buildMarker}`);
  }
};

const assertAssets = async (identity) => {
  const buildRoot = await realpath(BUILD_ROOT);
  const assets = [...identity.scripts, ...identity.styles];
  if (assets.length === 0) throw new Error("No loaded assets were reported");
  const resolvedAssets = [];
  for (const asset of assets) {
    const resolvedAsset = await realpath(fileURLToPath(asset));
    const pathFromRoot = relative(buildRoot, resolvedAsset);
    if (pathFromRoot.startsWith(`..${sep}`) || pathFromRoot === ".." || isAbsolute(pathFromRoot)) {
      throw new Error(`Asset escaped expected build root: ${resolvedAsset}`);
    }
    resolvedAssets.push(resolvedAsset);
  }
  return { buildRoot, assets: resolvedAssets };
};

const debugCall = (source) => `
  (async () => {
    const api = window.__CHROMA_RELAY_DEBUG__;
    if (!api) throw new Error("__CHROMA_RELAY_DEBUG__ is missing");
    return (${source})(api);
  })()
`;

const waitForComplete = async (client, evaluationGuard) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await client.evaluate("document.readyState")) === "complete") return;
    await delay(100);
  }
  evaluationGuard?.quarantine();
  throw new Error("Panel document did not reach readyState=complete; renderer completion quarantined");
};

const waitForMainHostAction = async (client, evaluationGuard) => {
  let terminalState = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    terminalState = await client.evaluate(
      debugCall(`(api) => {
        const state = api.getState();
        return {
          pendingHostAction: state.pendingHostAction,
          pendingPaletteMutation: state.pendingPaletteMutation,
          lastHostResult: state.lastHostResult,
          hostCalls: api.getCounters().hostCalls,
        };
      }`)
    );
    if (
      terminalState.pendingHostAction === null &&
      terminalState.pendingPaletteMutation === false &&
      terminalState.hostCalls === 1 &&
      terminalState.lastHostResult !== null
    ) {
      return terminalState;
    }
    await delay(100);
  }
  evaluationGuard.quarantine();
  throw new Error(
    `Main visible-control host action completion is unknown: ${JSON.stringify(terminalState)}`
  );
};

const afterRender = async (client) => {
  await client.evaluate(
    "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))"
  );
};

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

const captureScreenshot = async (client, path) => {
  const screenshot = await client.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  await writeFile(path, Buffer.from(screenshot.data, "base64"));
};

export const createSettingsFlyoutProbeSource = (mainPanelId) => `
  new Promise((resolve) => {
    const cep = window.__adobe_cep__;
    const original = cep.requestOpenExtension;
    let call = null;
    cep.requestOpenExtension = function (extensionId, startupParams) {
      call = { extensionId, startupParams };
      return original.call(cep, extensionId, startupParams);
    };
    cep.dispatchEvent({
      type: "com.adobe.csxs.events.flyoutMenuClicked",
      scope: "APPLICATION",
      appId: "AEFT",
      extensionId: ${JSON.stringify(mainPanelId)},
      data: JSON.stringify({ menuId: "settings" }),
    });
    setTimeout(() => {
      cep.requestOpenExtension = original;
      resolve(call);
    }, 150);
  })
`;

const inspectPanel = async (panel, outputDirectory) => {
  let scratch = null;
  let client;
  let target;
  let report = null;
  let primaryError = null;
  let originalConfigRoot = null;
  let configMutationAttempted = false;
  let configRestored = false;
  let evaluationGuard = null;
  const cleanupErrors = [];
  const reportPath = resolve(outputDirectory, `${panel.page}.json`);
  const failurePath = resolve(outputDirectory, `${panel.page}-failure.json`);
  await writeFile(
    reportPath,
    `${JSON.stringify({ passed: false, status: "running", panel, capturedAt: new Date().toISOString() }, null, 2)}\n`
  );

  try {
    scratch = await createOwnedTemporaryConfigDirectory({ tokenPrefix: `chroma-relay-${panel.page}` });
    const targets = await getTargets(panel.port);
    target = await selectTarget(targets, panel);
    client = new CdpClient(target.webSocketDebuggerUrl);
    await client.connect();
    await Promise.all([
      client.send("Runtime.enable"),
      client.send("Log.enable"),
      client.send("Page.enable"),
    ]);
    evaluationGuard = guardClientEvaluations(client, `${panel.page} inspect`);
    await waitForComplete(client, evaluationGuard);
    const baselineIdentity = await client.evaluate(debugCall("(api) => api.getIdentity()"));
    await assertIdentity(baselineIdentity, panel);
    originalConfigRoot = baselineIdentity.configRoot ?? null;
    await client.send("Runtime.discardConsoleEntries");
    client.events = [];
    await client.send("Page.reload", { ignoreCache: true });
    await waitForComplete(client, evaluationGuard);
    await afterRender(client);

    const initialIdentity = await client.evaluate(debugCall("(api) => api.getIdentity()"));
    await assertIdentity(initialIdentity, panel);
    if ((initialIdentity.configRoot ?? null) !== originalConfigRoot) {
      throw new Error(`${panel.page} config root changed during authenticated reload`);
    }

    const temporaryRoot = scratch.path;
    configMutationAttempted = true;
    await client.evaluate(
      debugCall(`(api) => api.setTemporaryConfigRoot(${JSON.stringify(temporaryRoot)})`)
    );
    await afterRender(client);

    const fixtureGeometry = {};
    for (const fixture of FIXTURES) {
      const key = `${fixture.width}x${fixture.height}`;
      const accepted = await client.evaluate(
        debugCall(`(api) => api.setFixtureViewport(${fixture.width}, ${fixture.height})`)
      );
      if (!accepted) throw new Error(`${panel.page} rejected fixture ${key}`);
      await afterRender(client);
      fixtureGeometry[key] = await client.evaluate(
        debugCall("(api) => ({ state: api.getState(), geometry: api.getGeometry() })")
      );
    }

    let paletteSeed = null;
    if (panel.page === "main") {
      const seedAccepted = await client.evaluate(
        debugCall(`(api) => api.seedPalette([
          { id: "fixture-cyan", css: "#00b7c7" },
          { id: "fixture-magenta", css: "#c23aa5" }
        ])`)
      );
      if (!seedAccepted) throw new Error("main rejected a valid debug palette seed");
      await afterRender(client);
      paletteSeed = await client.evaluate(debugCall("(api) => api.getState().palette"));
      if (
        paletteSeed.length !== 2 ||
        paletteSeed[0].id !== "fixture-cyan" ||
        paletteSeed[1].id !== "fixture-magenta"
      ) {
        throw new Error("main debug palette seed was not reflected in state");
      }
    }

    const clickResult = await client.evaluate(
      debugCall(
        panel.page === "main"
          ? '(api) => api.dispatchClick("palette-add")'
          : '(api) => api.dispatchClick("layout-stretch")'
      )
    );
    if (clickResult !== true) {
      throw new Error(`${panel.page} visible-control click contract failed`);
    }
    if (panel.page === "main") {
      await waitForMainHostAction(client, evaluationGuard);
    }

    await client.evaluate(debugCall("(api) => api.resetTestState()"));
    await afterRender(client);
    await client.evaluate(
      debugCall(`(api) => api.setTemporaryConfigRoot(${JSON.stringify(temporaryRoot)})`)
    );
    await afterRender(client);

    const snapshot = await client.evaluate(
      debugCall(`(api) => ({
        identity: api.getIdentity(),
        state: api.getState(),
        counters: api.getCounters(),
        geometry: api.getGeometry(),
        methods: Object.keys(api).sort(),
        readyState: document.readyState,
        bodyText: document.body.innerText.trim(),
      })`)
    );
    await assertIdentity(snapshot.identity, panel);
    if (snapshot.identity.configRoot !== temporaryRoot) {
      throw new Error(`${panel.page} temporary config-root seam did not hold`);
    }
    if (snapshot.readyState !== "complete") throw new Error(`${panel.page} was not ready`);
    if (Object.values(snapshot.counters).some((count) => count !== 0)) {
      throw new Error(`${panel.page} unexpectedly touched disk/events/host counters`);
    }

    const assetProof = await assertAssets(snapshot.identity);
    const consoleEvidence = getConsoleEvidence(client.events);
    const consoleErrors = consoleEvidence.console.filter((entry) =>
      ["error", "assert"].includes(entry.type)
    );
    const logErrors = consoleEvidence.logs.filter((entry) => entry.level === "error");
    if (consoleErrors.length || logErrors.length || consoleEvidence.exceptions.length) {
      throw new Error(`${panel.page} emitted console, log, or runtime errors`);
    }

    const screenshotPath = resolve(outputDirectory, `${panel.page}.png`);
    await captureScreenshot(client, screenshotPath);
    report = {
      capturedAt: new Date().toISOString(),
      panel,
      target,
      snapshot,
      fixtureGeometry,
      paletteSeed,
      interaction: {
        testId: panel.page === "main" ? "palette-add" : "layout-stretch",
        expectedToDispatch: true,
        dispatched: clickResult,
      },
      assetProof,
      consoleEvidence,
      ioPolicy: {
        evidenceDirectory: outputDirectory,
        temporaryConfigRoot: temporaryRoot,
        temporaryRootCreated: false,
        productionConfigWrites: 0,
      },
    };
  } catch (error) {
    primaryError = error;
    const failure = {
      capturedAt: new Date().toISOString(),
      panel,
      target,
      error: error instanceof Error ? error.stack || error.message : String(error),
      consoleEvidence: client ? getConsoleEvidence(client.events) : null,
    };
    try {
      await writeFile(failurePath, `${JSON.stringify(failure, null, 2)}\n`);
    } catch (writeError) {
      cleanupErrors.push({ phase: "failure-evidence", error: String(writeError?.stack || writeError) });
    }
    if (client) {
      try {
        await captureScreenshot(client, resolve(outputDirectory, `${panel.page}-failure.png`));
      } catch {
        // The JSON failure artifact remains authoritative if screenshot capture also fails.
      }
    }
  } finally {
    if (client && configMutationAttempted && evaluationGuard?.isCompletionKnown()) {
      try {
        await restoreConfigRootWithReadback({
          expectedRoot: originalConfigRoot,
          setRoot: (root) => client.evaluate(
            debugCall(`(api) => api.setTemporaryConfigRoot(${JSON.stringify(root)})`)
          ),
          settle: () => afterRender(client),
          readRoot: () => client.evaluate(debugCall("(api) => api.getIdentity().configRoot")),
          label: `${panel.page} inspect config root`,
        });
        configRestored = true;
      } catch (error) {
        cleanupErrors.push({ phase: "restore-config", error: String(error?.stack || error) });
      }
    } else if (client && configMutationAttempted) {
      cleanupErrors.push({
        phase: "restore-config",
        error: `${panel.page} renderer completion is unknown; restoration dispatch refused`,
      });
    }
    try {
      await client?.close();
    } catch (error) {
      cleanupErrors.push({ phase: "close", error: String(error?.stack || error) });
    }
    if (scratch && (!configMutationAttempted || configRestored)) {
      try {
        await removeOwnedRunDirectory(scratch);
      } catch (error) {
        cleanupErrors.push({ phase: "scratch", error: String(error?.stack || error) });
      }
    }
  }
  if (primaryError || cleanupErrors.length > 0) {
    const failureText = `${JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        passed: false,
        panel,
        target,
        error: primaryError ? primaryError.stack || primaryError.message : null,
        cleanupErrors,
        originalConfigRoot,
        temporaryRoot: scratch?.path ?? null,
        scratchPreserved: configMutationAttempted && !configRestored,
        consoleEvidence: client ? getConsoleEvidence(client.events) : null,
      },
      null,
      2
    )}\n`;
    for (const [phase, path] of [["report", reportPath], ["failure", failurePath]]) {
      try { await writeFile(path, failureText); } catch (error) {
        cleanupErrors.push({ phase: `failure-evidence:${phase}`, error: String(error?.stack || error) });
      }
    }
    if (primaryError) {
      if (cleanupErrors.length > 0) primaryError.cleanupErrors = cleanupErrors;
      throw primaryError;
    }
    throw new AggregateError(cleanupErrors.map(({ error }) => new Error(error)), "CDP inspect cleanup failed");
  }
  try {
    await rm(failurePath, { force: true });
    report.passed = true;
    report.status = "passed";
    report.ioPolicy.temporaryRootCreated = true;
    report.ioPolicy.temporaryRootRemoved = true;
    report.ioPolicy.configRestored = configRestored;
    await writeFile(
      reportPath,
      `${JSON.stringify(report, null, 2)}\n`
    );
  } catch (publicationError) {
    const failureText = `${JSON.stringify({ passed: false, panel, error: String(publicationError?.stack || publicationError) }, null, 2)}\n`;
    const evidenceWriteErrors = [];
    for (const [phase, path] of [["report", reportPath], ["failure", failurePath]]) {
      try { await writeFile(path, failureText); } catch (error) {
        evidenceWriteErrors.push({ phase: `failure-evidence:${phase}`, error: String(error?.stack || error) });
      }
    }
    if (evidenceWriteErrors.length > 0) publicationError.evidenceWriteErrors = evidenceWriteErrors;
    throw publicationError;
  }
  return report;
};

const expectFailure = async (label, action) => {
  try {
    await action();
  } catch {
    return label;
  }
  throw new Error(`${label} did not fail closed`);
};

const runSelfTest = async () => {
  const panel = PANELS[0];
  const exact = {
    type: "page",
    url: pathToFileURL(resolve(tmpdir(), "example", ...panel.pageSuffix.split("/").filter(Boolean))).href,
    webSocketDebuggerUrl: "ws://example",
  };
  const expectedPage = fileURLToPath(exact.url);
  const selectionOptions = { expectedPage, realpathFn: async (path) => path };
  const passed = [
    await selectTarget([exact], panel, selectionOptions) === exact ? "single exact target" : null,
    await expectFailure("wrong page", () =>
      selectTarget([{ ...exact, url: "file:///tmp/stale.html" }], panel, selectionOptions)
    ),
    await expectFailure("duplicate exact pages", () =>
      selectTarget([exact, { ...exact }], panel, selectionOptions)
    ),
    await expectFailure("wrong runtime ID", () =>
      assertIdentity(
        {
          extensionId: "com.zimoby.chroma-relay.stale",
          page: panel.page,
          url: exact.url,
          buildMarker: EXPECTED_BUILD_MARKER,
        },
        panel
      )
    ),
  ].filter(Boolean);
  console.log(JSON.stringify({ passed }, null, 2));
};

const runInspect = async (outputDirectory, parentRun, options = {}) => {
  await mkdir(outputDirectory, { recursive: true });

  const configuredPanels = PANELS.map((panel) => ({
    ...panel,
    extensionId: options[`${panel.page}-id`] || panel.extensionId,
  }));
  const reports = [];
  for (const panel of configuredPanels) reports.push(await inspectPanel(panel, outputDirectory));
  const summary = {
    capturedAt: new Date().toISOString(),
    passed: true,
    panels: reports.map((report) => ({
      page: report.panel.page,
      port: report.panel.port,
      extensionId: report.snapshot.identity.extensionId,
      screenshot: `${report.panel.page}.png`,
      report: `${report.panel.page}.json`,
    })),
  };
  await writeFile(resolve(outputDirectory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
};

const runSettingsSmoke = async (outputDirectory) => {
  const scratch = await createOwnedTemporaryConfigDirectory({ tokenPrefix: "chroma-relay-settings-smoke" });
  const temporaryRoot = scratch.path;
  const clients = new Map();
  const originalConfigRoots = new Map();
  const configuredPanels = new Set();
  const evaluationGuards = new Map();
  let primaryError = null;
  let pendingReport = null;
  let restorationFailed = false;
  const cleanupErrors = [];
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    resolve(temporaryRoot, "settings.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        revision: 0,
        layoutMode: "stretch",
        swatchSize: 32,
      },
      null,
      2
    )}\n`
  );

  const snapshot = (client) =>
    client.evaluate(
      debugCall(
        "(api) => ({ identity: api.getIdentity(), state: api.getState(), counters: api.getCounters(), geometry: api.getGeometry() })"
      )
    );

  try {
    for (const panel of PANELS) {
      const target = await selectTarget(await getTargets(panel.port), panel);
      const client = new CdpClient(target.webSocketDebuggerUrl);
      clients.set(panel.page, client);
      await client.connect();
      await Promise.all([
        client.send("Runtime.enable"),
        client.send("Log.enable"),
        client.send("Page.enable"),
      ]);
      evaluationGuards.set(
        panel.page,
        guardClientEvaluations(client, `${panel.page} Settings smoke`)
      );
      await waitForComplete(client, evaluationGuards.get(panel.page));
      const baselineIdentity = await client.evaluate(debugCall("(api) => api.getIdentity()"));
      await assertIdentity(baselineIdentity, panel);
      originalConfigRoots.set(panel.page, baselineIdentity.configRoot ?? null);
      client.events = [];
      await client.send("Page.reload", { ignoreCache: true });
      await waitForComplete(client, evaluationGuards.get(panel.page));
      await afterRender(client);
      const identity = await client.evaluate(debugCall("(api) => api.getIdentity()"));
      await assertIdentity(identity, panel);
      if ((identity.configRoot ?? null) !== originalConfigRoots.get(panel.page)) {
        throw new Error(`${panel.page} config root changed during authenticated reload`);
      }
    }

    const main = clients.get("main");
    const settings = clients.get("settings");
    const flyoutLaunch = await main.evaluate(
      createSettingsFlyoutProbeSource(contract.product.panelIds.main)
    );
    if (
      flyoutLaunch?.extensionId !== contract.product.panelIds.settings ||
      flyoutLaunch?.startupParams !== ""
    ) {
      throw new Error(`flyout launch targeted the wrong extension: ${JSON.stringify(flyoutLaunch)}`);
    }
    for (const [page, client] of [["main", main], ["settings", settings]]) {
      configuredPanels.add(page);
      await client.evaluate(
        debugCall(`(api) => api.setTemporaryConfigRoot(${JSON.stringify(temporaryRoot)})`)
      );
      await afterRender(client);
    }

    const before = { main: await snapshot(main), settings: await snapshot(settings) };
    if (
      before.main.state.settings.layoutMode !== "stretch" ||
      before.settings.state.settings.layoutMode !== "stretch" ||
      before.main.state.settings.schemaVersion !== contract.schemas.settings ||
      before.settings.state.settings.schemaVersion !== contract.schemas.settings ||
      before.main.state.settings.includeDisabledColors !== false ||
      before.settings.state.settings.includeDisabledColors !== false ||
      before.main.state.settings.extractionPreset !== "balanced" ||
      before.settings.state.settings.extractionPreset !== "balanced"
    ) {
      throw new Error("temporary-root default was not Stretch in both panels");
    }

    const fixedClicked = await settings.evaluate(
      debugCall('(api) => api.dispatchClick("layout-fixed")')
    );
    if (!fixedClicked) throw new Error("Fixed control did not accept a real click");
    await afterRender(settings);
    await delay(150);
    await afterRender(main);

    const getSwatches = (client) =>
      client.evaluate(`Array.from(document.querySelectorAll(".palette-swatch-shell")).map((element) => {
        const rect = element.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      })`);
    const getActionGeometry = (client) =>
      client.evaluate(`(() => {
        const swatches = Array.from(document.querySelectorAll(".palette-swatch-shell"));
        const last = swatches[swatches.length - 1].getBoundingClientRect();
        const add = document.querySelector(".palette-add").getBoundingClientRect();
        const toggle = document.querySelector(".palette-picker-toggle").getBoundingClientRect();
        const actions = document.querySelector(".palette-actions").getBoundingClientRect();
        return {
          orientation: document.querySelector(".chroma-relay-panel").dataset.orientation,
          actions: { width: actions.width, height: actions.height },
          add: { width: add.width, height: add.height },
          toggle: { width: toggle.width, height: toggle.height },
          stageGap: actions.left - last.right,
          buttonGap: toggle.top - add.bottom
        };
      })()`);
    const fixed = {
      main: await snapshot(main),
      settings: await snapshot(settings),
      swatches: await getSwatches(main),
      actions: await getActionGeometry(main),
    };
    if (
      fixed.main.state.settings.layoutMode !== "fixed" ||
      fixed.settings.state.settings.layoutMode !== "fixed"
    ) {
      throw new Error("Fixed layout did not synchronize to Main");
    }
    if (fixed.settings.counters.diskWrites !== 1 || fixed.settings.counters.emittedEvents !== 1) {
      throw new Error("Fixed change did not produce exactly one Settings write/event");
    }
    if (
      fixed.main.counters.diskWrites !== 0 ||
      fixed.main.counters.emittedEvents !== 0 ||
      fixed.main.counters.receivedEvents !== 1
    ) {
      throw new Error("Main did not receive Fixed exactly once without writing");
    }
    if (
      fixed.swatches.length !== 5 ||
      fixed.swatches.some((rect) => rect.width !== 32 || rect.height !== 32) ||
      fixed.actions.actions.width !== 32 ||
      fixed.actions.actions.height !== 32 ||
      fixed.actions.add.width !== 32 ||
      fixed.actions.toggle.width !== 32 ||
      Math.abs(
        fixed.actions.add.height + fixed.actions.toggle.height + fixed.actions.buttonGap - 32
      ) > 0.5 ||
      Math.abs(fixed.actions.stageGap - 2) > 0.5
    ) {
      throw new Error(`Fixed 32 px rail geometry was wrong: ${JSON.stringify(fixed)}`);
    }

    const sizeCommitted = await settings.evaluate(`
      (async () => {
        const input = document.querySelector('[data-testid="swatch-size-slider"]');
        if (!(input instanceof HTMLInputElement) || input.disabled) return false;
        input.focus();
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setter.call(input, "40");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
        input.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        return true;
      })()
    `);
    if (!sizeCommitted) throw new Error("40 px slider change was not dispatched");
    await afterRender(settings);
    await delay(150);
    await afterRender(main);

    const resized = {
      main: await snapshot(main),
      settings: await snapshot(settings),
      swatches: await getSwatches(main),
      actions: await getActionGeometry(main),
    };
    if (
      resized.main.state.settings.swatchSize !== 40 ||
      resized.settings.state.settings.swatchSize !== 40
    ) {
      throw new Error("40 px size did not synchronize to Main");
    }
    if (resized.settings.counters.diskWrites !== 2 || resized.settings.counters.emittedEvents !== 2) {
      throw new Error("Two setting changes did not produce exactly two Settings writes/events");
    }
    if (
      resized.main.counters.diskWrites !== 0 ||
      resized.main.counters.emittedEvents !== 0 ||
      resized.main.counters.receivedEvents !== 2
    ) {
      throw new Error("Main did not receive both changes exactly once without writing");
    }
    if (
      resized.swatches.some((rect) => rect.width !== 40 || rect.height !== 40) ||
      resized.actions.actions.width !== 40 ||
      resized.actions.actions.height !== 40 ||
      resized.actions.add.width !== 40 ||
      resized.actions.toggle.width !== 40 ||
      Math.abs(
        resized.actions.add.height + resized.actions.toggle.height + resized.actions.buttonGap - 40
      ) > 0.5 ||
      Math.abs(resized.actions.stageGap - 2) > 0.5
    ) {
      throw new Error(`Fixed 40 px rail geometry was wrong: ${JSON.stringify(resized)}`);
    }

    const disabledColorsClicked = await settings.evaluate(
      debugCall('(api) => api.dispatchClick("include-disabled-colors")')
    );
    if (!disabledColorsClicked) {
      throw new Error("Disabled-colors checkbox did not accept a real click");
    }
    await afterRender(settings);
    await delay(150);
    await afterRender(main);
    const disabledColors = { main: await snapshot(main), settings: await snapshot(settings) };
    if (
      disabledColors.main.state.settings.includeDisabledColors !== true ||
      disabledColors.settings.state.settings.includeDisabledColors !== true ||
      disabledColors.settings.counters.diskWrites !== 3 ||
      disabledColors.settings.counters.emittedEvents !== 3 ||
      disabledColors.main.counters.receivedEvents !== 3 ||
      disabledColors.main.counters.diskWrites !== 0
    ) {
      throw new Error(
        `Disabled-colors setting did not synchronize exactly once: ${JSON.stringify(disabledColors)}`
      );
    }

    const tonalClicked = await settings.evaluate(
      debugCall('(api) => api.dispatchClick("extraction-tonal")')
    );
    if (!tonalClicked) throw new Error("Tonal extraction control did not accept a real click");
    await afterRender(settings);
    await delay(150);
    await afterRender(main);
    const tonal = { main: await snapshot(main), settings: await snapshot(settings) };
    if (
      tonal.main.state.settings.extractionPreset !== "tonal" ||
      tonal.settings.state.settings.extractionPreset !== "tonal" ||
      tonal.settings.counters.diskWrites !== 4 ||
      tonal.settings.counters.emittedEvents !== 4 ||
      tonal.main.counters.receivedEvents !== 4 ||
      tonal.main.counters.diskWrites !== 0
    ) {
      throw new Error(
        `Tonal extraction setting did not synchronize exactly once: ${JSON.stringify(tonal)}`
      );
    }

    const originalViewport = await main.evaluate("({ width: window.innerWidth, height: window.innerHeight })");
    const alignmentFixtures = {};
    for (const fixture of [
      { key: "wide", width: 160, height: 32, orientation: "horizontal" },
      { key: "tall", width: 128, height: 160, orientation: "vertical" },
    ]) {
      const accepted = await main.evaluate(
        debugCall(`(api) => api.setFixtureViewport(${fixture.width}, ${fixture.height})`)
      );
      if (!accepted) throw new Error(`Main rejected the ${fixture.key} alignment fixture`);
      await afterRender(main);
      alignmentFixtures[fixture.key] = await main.evaluate(`(() => {
        const root = document.querySelector('.chroma-relay-panel');
        const strip = document.querySelector('.palette-strip');
        const first = document.querySelector('.palette-swatch-shell');
        const stripRect = strip.getBoundingClientRect();
        const firstRect = first.getBoundingClientRect();
        return {
          orientation: root.dataset.orientation,
          alignItems: getComputedStyle(strip).alignItems,
          leftOffset: firstRect.left - stripRect.left,
          topOffset: firstRect.top - stripRect.top,
        };
      })()`);
      const result = alignmentFixtures[fixture.key];
      if (
        result.orientation !== fixture.orientation ||
        result.alignItems !== "flex-start" ||
        Math.abs(result.leftOffset) > 0.5 ||
        Math.abs(result.topOffset) > 0.5
      ) {
        throw new Error(`${fixture.key} Fixed palette was not top-left pinned: ${JSON.stringify(result)}`);
      }
    }
    await main.evaluate(
      debugCall(
        `(api) => api.setFixtureViewport(${originalViewport.width}, ${originalViewport.height})`
      )
    );
    await afterRender(main);

    const stored = JSON.parse(await readFile(resolve(temporaryRoot, "settings.json"), "utf8"));
    if (
      stored.layoutMode !== "fixed" ||
      stored.swatchSize !== 40 ||
      stored.includeDisabledColors !== true ||
      stored.extractionPreset !== "tonal" ||
      stored.schemaVersion !== contract.schemas.settings ||
      stored.revision !== 4
    ) {
      throw new Error("settings.json did not contain the expected revision-4 Fixed/Tonal snapshot");
    }

    for (const panel of PANELS) {
      const client = clients.get(panel.page);
      const preReloadIdentity = await client.evaluate(debugCall("(api) => api.getIdentity()"));
      await assertIdentity(preReloadIdentity, panel);
      if (preReloadIdentity.configRoot !== temporaryRoot) {
        throw new Error(
          `${panel.page} pre-reload config root drift: ${JSON.stringify(preReloadIdentity.configRoot)}`
        );
      }
      await client.send("Page.reload", { ignoreCache: true });
      await waitForComplete(client, evaluationGuards.get(panel.page));
      await afterRender(client);
      const identity = await client.evaluate(debugCall("(api) => api.getIdentity()"));
      await assertIdentity(identity, panel);
      await client.evaluate(
        debugCall(`(api) => api.setTemporaryConfigRoot(${JSON.stringify(temporaryRoot)})`)
      );
      await afterRender(client);
    }
    const reloaded = { main: await snapshot(main), settings: await snapshot(settings) };
    if (
      reloaded.main.state.settings.layoutMode !== "fixed" ||
      reloaded.main.state.settings.swatchSize !== 40 ||
      reloaded.main.state.settings.includeDisabledColors !== true ||
      reloaded.main.state.settings.extractionPreset !== "tonal" ||
      reloaded.settings.state.settings.layoutMode !== "fixed" ||
      reloaded.settings.state.settings.swatchSize !== 40 ||
      reloaded.settings.state.settings.includeDisabledColors !== true ||
      reloaded.settings.state.settings.extractionPreset !== "tonal"
    ) {
      throw new Error("Fixed 40 px snapshot did not survive both panel reloads");
    }

    await captureScreenshot(main, resolve(outputDirectory, "main-fixed-40.png"));
    await captureScreenshot(settings, resolve(outputDirectory, "settings-fixed-40.png"));
    const stretchClicked = await settings.evaluate(
      debugCall('(api) => api.dispatchClick("layout-stretch")')
    );
    if (!stretchClicked) throw new Error("Stretch control did not accept a real click");
    await afterRender(settings);
    await delay(150);
    await afterRender(main);
    const stretch = {
      main: await snapshot(main),
      settings: await snapshot(settings),
      swatches: await getSwatches(main),
    };
    if (
      stretch.main.state.settings.layoutMode !== "stretch" ||
      stretch.settings.state.settings.layoutMode !== "stretch" ||
      stretch.main.state.settings.includeDisabledColors !== true ||
      stretch.settings.state.settings.includeDisabledColors !== true
    ) {
      throw new Error("Stretch layout did not synchronize back to Main");
    }
    if (stretch.settings.counters.diskWrites !== 1 || stretch.settings.counters.emittedEvents !== 1) {
      throw new Error("Stretch return did not produce exactly one Settings write/event");
    }
    if (
      stretch.main.counters.diskWrites !== 0 ||
      stretch.main.counters.emittedEvents !== 0 ||
      stretch.main.counters.receivedEvents !== 1
    ) {
      throw new Error("Main did not receive Stretch exactly once without writing");
    }
    if (
      stretch.swatches.length !== 5 ||
      new Set(stretch.swatches.map((rect) => rect.width)).size !== 1 ||
      stretch.swatches.every((rect) => rect.width === rect.height)
    ) {
      throw new Error(`Stretch swatches did not return to equal-fill geometry: ${JSON.stringify(stretch.swatches)}`);
    }
    const consoleEvidence = Object.fromEntries(
      [...clients.entries()].map(([page, client]) => [page, getConsoleEvidence(client.events)])
    );
    for (const [page, evidence] of Object.entries(consoleEvidence)) {
      const errors = evidence.console.filter((entry) => ["error", "assert"].includes(entry.type));
      const logErrors = evidence.logs.filter((entry) => entry.level === "error");
      if (errors.length || logErrors.length || evidence.exceptions.length) {
        throw new Error(`${page} emitted console, log, or runtime errors during settings smoke`);
      }
    }

    pendingReport = {
      capturedAt: new Date().toISOString(),
      passed: true,
      temporaryRoot,
      flyoutLaunch,
      before,
      fixed,
      resized,
      disabledColors,
      tonal,
      alignmentFixtures,
      stored,
      reloaded,
      stretch,
      consoleEvidence,
      screenshots: ["main-fixed-40.png", "settings-fixed-40.png"],
    };
  } catch (error) {
    primaryError = error;
  } finally {
    for (const [page, client] of clients.entries()) {
      try {
        if (configuredPanels.has(page) && evaluationGuards.get(page)?.isCompletionKnown()) {
          await restoreConfigRootWithReadback({
            expectedRoot: originalConfigRoots.get(page) ?? null,
            setRoot: (root) => client.evaluate(
              debugCall(`(api) => api.setTemporaryConfigRoot(${JSON.stringify(root)})`)
            ),
            settle: () => afterRender(client),
            readRoot: () => client.evaluate(debugCall("(api) => api.getIdentity().configRoot")),
            label: `${page} Settings smoke config root`,
          });
        } else if (configuredPanels.has(page)) {
          restorationFailed = true;
          cleanupErrors.push({
            phase: `restore-config:${page}`,
            error: `${page} renderer completion is unknown; restoration dispatch refused`,
          });
        }
      } catch (error) {
        restorationFailed = true;
        cleanupErrors.push({
          phase: `restore-config:${page}`,
          error: String(error?.stack || error),
        });
      }
      try {
        await client.close();
      } catch (error) {
        cleanupErrors.push({ phase: `close:${page}`, error: String(error?.stack || error) });
      }
    }
    if (!restorationFailed) {
      try {
        await removeOwnedRunDirectory(scratch);
      } catch (error) {
        cleanupErrors.push({ phase: "scratch", error: String(error?.stack || error) });
      }
    }
  }
  if (primaryError || cleanupErrors.length > 0) {
    const failure = {
      capturedAt: new Date().toISOString(),
      passed: false,
      temporaryRoot,
      scratchPreserved: restorationFailed,
      error: primaryError ? primaryError.stack || primaryError.message : null,
      cleanupErrors,
      consoleEvidence: Object.fromEntries(
        [...clients.entries()].map(([page, client]) => [page, getConsoleEvidence(client.events)])
      ),
    };
    const failureText = `${JSON.stringify(failure, null, 2)}\n`;
    for (const file of ["report.json", "failure.json"]) {
      try {
        await writeFile(resolve(outputDirectory, file), failureText);
      } catch (error) {
        cleanupErrors.push({ phase: `failure-evidence:${file}`, error: String(error?.stack || error) });
      }
    }
    if (primaryError) {
      if (cleanupErrors.length > 0) primaryError.cleanupErrors = cleanupErrors;
      throw primaryError;
    }
    throw new AggregateError(cleanupErrors.map(({ error }) => new Error(error)), "CDP settings cleanup failed");
  }
  try {
    await writeFile(
      resolve(outputDirectory, "report.json"),
      `${JSON.stringify(pendingReport, null, 2)}\n`
    );
  } catch (publicationError) {
    const failure = {
      capturedAt: new Date().toISOString(),
      passed: false,
      temporaryRoot,
      error: publicationError.stack || publicationError.message,
      cleanupErrors: [],
    };
    const failureText = `${JSON.stringify(failure, null, 2)}\n`;
    const evidenceWriteErrors = [];
    for (const file of ["report.json", "failure.json"]) {
      try { await writeFile(resolve(outputDirectory, file), failureText); } catch (error) {
        evidenceWriteErrors.push({ phase: `failure-evidence:${file}`, error: String(error?.stack || error) });
      }
    }
    if (evidenceWriteErrors.length > 0) publicationError.evidenceWriteErrors = evidenceWriteErrors;
    throw publicationError;
  }
  console.log(JSON.stringify({ passed: true, outputDirectory, stored: pendingReport.stored }, null, 2));
};

const main = async () => {
  const [, , command = "inspect", ...argv] = process.argv;
  if (!["inspect", "settings-smoke", "self-test"].includes(command)) {
    throw new Error("Usage: node scripts/cep-cdp.mjs <inspect|settings-smoke|self-test> [--output=path]");
  }
  const options = parseRunnerArgs(argv, { allowed: ["output", "main-id", "settings-id"] });
  if (command === "self-test") return runSelfTest();
  const root = options.output || (command === "inspect" ? "evidence/i05/inspect" : "evidence/i05/settings-smoke");
  const run = await createOwnedRunDirectory(resolve(REPO_ROOT, root));
  if (command === "inspect") return runInspect(run.path, run, options);
  return runSettingsSmoke(run.path);
};

if (isDirectCliInvocation(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : error);
    const evidenceDiagnostics = [
      ...(Array.isArray(error?.evidenceWriteErrors) ? error.evidenceWriteErrors : []),
      ...(Array.isArray(error?.cleanupErrors)
        ? error.cleanupErrors.filter(({ phase }) => String(phase).startsWith("failure-evidence:"))
        : []),
    ];
    if (evidenceDiagnostics.length > 0) {
      console.error(`Failure evidence publication also failed:\n${JSON.stringify(evidenceDiagnostics, null, 2)}`);
    }
    process.exitCode = 1;
  });
}
