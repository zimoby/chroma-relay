#!/usr/bin/env node

import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const EXPECTED_BUILD_MARKER = "I11 · 0.0.1";

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
    extensionId: "com.zimoby.chroma-relay.main",
    pageSuffix: "/main/index.html",
  },
  {
    page: "settings",
    port: 8199,
    extensionId: "com.zimoby.chroma-relay.settings",
    pageSuffix: "/settings/index.html",
  },
];

const [, , command = "inspect", ...rawArgs] = process.argv;
const options = Object.fromEntries(
  rawArgs
    .filter((argument) => argument.startsWith("--") && argument.includes("="))
    .map((argument) => {
      const [key, ...value] = argument.slice(2).split("=");
      return [key, value.join("=")];
    })
);
const allowedOptions = new Set(["output", "main-id", "settings-id"]);
const malformedArguments = rawArgs.filter(
  (argument) => !argument.startsWith("--") || !argument.includes("=")
);
const unknownOptions = Object.keys(options).filter((key) => !allowedOptions.has(key));
if (malformedArguments.length || unknownOptions.length) {
  const details = [
    malformedArguments.length ? `malformed: ${malformedArguments.join(", ")}` : null,
    unknownOptions.length ? `unknown: ${unknownOptions.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join("; ");
  console.error(`Invalid CDP runner arguments (${details})`);
  process.exit(2);
}

class CDPClient {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.socket = null;
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    this.socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data);
      if (!message.id) {
        this.events.push(message);
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || "CDP error"));
      else pending.resolve(message.result);
    });
    await new Promise((resolveOpen, rejectOpen) => {
      this.socket.addEventListener("open", resolveOpen, { once: true });
      this.socket.addEventListener(
        "error",
        () => rejectOpen(new Error(`Unable to connect to ${this.url}`)),
        { once: true }
      );
    });
  }

  send(method, params = {}) {
    return new Promise((resolveResult, rejectResult) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectResult(new Error(`${method} timed out`));
      }, 8000);
      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolveResult(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          rejectResult(error);
        },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ||
          result.exceptionDetails.text ||
          "Runtime.evaluate failed"
      );
    }
    return result.result?.value;
  }

  async close() {
    if (!this.socket) return;
    this.socket.close();
    await new Promise((resolveClose) => {
      this.socket.addEventListener("close", resolveClose, { once: true });
      setTimeout(resolveClose, 250);
    });
  }
}

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
    return fileURLToPath(target.url);
  } catch {
    return "";
  }
};

const selectTarget = (targets, panel) => {
  const matches = targets.filter(
    (target) => target.type === "page" && targetPath(target).endsWith(panel.pageSuffix)
  );
  if (matches.length !== 1) {
    throw new Error(
      `${panel.page} expected exactly one ${panel.pageSuffix} target on port ${panel.port}; found ${matches.length}`
    );
  }
  if (!matches[0].webSocketDebuggerUrl) {
    throw new Error(`${panel.page} target has no WebSocket debugger URL`);
  }
  return matches[0];
};

const assertIdentity = (identity, panel) => {
  if (identity.extensionId !== panel.extensionId) {
    throw new Error(
      `${panel.page} runtime ID mismatch: expected ${panel.extensionId}, got ${identity.extensionId}`
    );
  }
  if (identity.page !== panel.page || !targetPath({ url: identity.url }).endsWith(panel.pageSuffix)) {
    throw new Error(`${panel.page} runtime page identity mismatch`);
  }
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

const waitForComplete = async (client) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await client.evaluate("document.readyState")) === "complete") return;
    await delay(100);
  }
  throw new Error("Panel document did not reach readyState=complete");
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

const inspectPanel = async (panel, outputDirectory) => {
  let client;
  let target;
  const failurePath = resolve(outputDirectory, `${panel.page}-failure.json`);

  try {
    const targets = await getTargets(panel.port);
    target = selectTarget(targets, panel);
    client = new CDPClient(target.webSocketDebuggerUrl);
    await client.connect();
    await Promise.all([
      client.send("Runtime.enable"),
      client.send("Log.enable"),
      client.send("Page.enable"),
    ]);
    await client.send("Runtime.discardConsoleEntries");
    client.events = [];
    await client.send("Page.reload", { ignoreCache: true });
    await waitForComplete(client);
    await afterRender(client);

    const temporaryRoot = `/private/tmp/chroma-relay-i05-${panel.page}`;
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
    assertIdentity(snapshot.identity, panel);
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
    const report = {
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
    await writeFile(
      resolve(outputDirectory, `${panel.page}.json`),
      `${JSON.stringify(report, null, 2)}\n`
    );
    return report;
  } catch (error) {
    const failure = {
      capturedAt: new Date().toISOString(),
      panel,
      target,
      error: error instanceof Error ? error.stack || error.message : String(error),
      consoleEvidence: client ? getConsoleEvidence(client.events) : null,
    };
    await writeFile(failurePath, `${JSON.stringify(failure, null, 2)}\n`);
    if (client) {
      try {
        await captureScreenshot(client, resolve(outputDirectory, `${panel.page}-failure.png`));
      } catch {
        // The JSON failure artifact remains authoritative if screenshot capture also fails.
      }
    }
    throw error;
  } finally {
    await client?.close();
  }
};

const expectFailure = (label, action) => {
  try {
    action();
  } catch {
    return label;
  }
  throw new Error(`${label} did not fail closed`);
};

const runSelfTest = () => {
  const panel = PANELS[0];
  const exact = {
    type: "page",
    url: `file:///tmp/example${panel.pageSuffix}`,
    webSocketDebuggerUrl: "ws://example",
  };
  const passed = [
    selectTarget([exact], panel) === exact ? "single exact target" : null,
    expectFailure("wrong page", () => selectTarget([{ ...exact, url: "file:///tmp/stale.html" }], panel)),
    expectFailure("duplicate exact pages", () => selectTarget([exact, { ...exact }], panel)),
    expectFailure("wrong runtime ID", () =>
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

const runInspect = async () => {
  const requestedOutput = options.output || "evidence/i05/inspect";
  const outputDirectory = isAbsolute(requestedOutput)
    ? requestedOutput
    : resolve(REPO_ROOT, requestedOutput);
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

const runSettingsSmoke = async () => {
  const requestedOutput = options.output || "evidence/i05/settings-smoke";
  const outputDirectory = isAbsolute(requestedOutput)
    ? requestedOutput
    : resolve(REPO_ROOT, requestedOutput);
  const temporaryRoot = `/private/tmp/chroma-relay-i05-settings-smoke-${process.pid}`;
  const clients = new Map();
  await mkdir(outputDirectory, { recursive: true });
  await rm(temporaryRoot, { recursive: true, force: true });
  await mkdir(temporaryRoot, { recursive: true });
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
      const target = selectTarget(await getTargets(panel.port), panel);
      const client = new CDPClient(target.webSocketDebuggerUrl);
      clients.set(panel.page, client);
      await client.connect();
      await Promise.all([
        client.send("Runtime.enable"),
        client.send("Log.enable"),
        client.send("Page.enable"),
      ]);
      client.events = [];
      await client.send("Page.reload", { ignoreCache: true });
      await waitForComplete(client);
      await afterRender(client);
      const identity = await client.evaluate(debugCall("(api) => api.getIdentity()"));
      assertIdentity(identity, panel);
    }

    const main = clients.get("main");
    const settings = clients.get("settings");
    const flyoutLaunch = await main.evaluate(`
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
          extensionId: "com.zimoby.chroma-relay.main",
          data: JSON.stringify({ menuId: "settings" }),
        });
        setTimeout(() => {
          cep.requestOpenExtension = original;
          resolve(call);
        }, 150);
      })
    `);
    if (
      flyoutLaunch?.extensionId !== "com.zimoby.chroma-relay.settings" ||
      flyoutLaunch?.startupParams !== ""
    ) {
      throw new Error(`flyout launch targeted the wrong extension: ${JSON.stringify(flyoutLaunch)}`);
    }
    for (const client of [main, settings]) {
      await client.evaluate(
        debugCall(`(api) => api.setTemporaryConfigRoot(${JSON.stringify(temporaryRoot)})`)
      );
      await afterRender(client);
    }

    const before = { main: await snapshot(main), settings: await snapshot(settings) };
    if (
      before.main.state.settings.layoutMode !== "stretch" ||
      before.settings.state.settings.layoutMode !== "stretch" ||
      before.main.state.settings.schemaVersion !== 3 ||
      before.settings.state.settings.schemaVersion !== 3 ||
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
    const getAddGeometry = (client) =>
      client.evaluate(`(() => {
        const swatches = Array.from(document.querySelectorAll(".palette-swatch-shell"));
        const last = swatches[swatches.length - 1].getBoundingClientRect();
        const add = document.querySelector(".palette-add").getBoundingClientRect();
        return {
          orientation: document.querySelector(".chroma-relay-panel").dataset.orientation,
          width: add.width,
          height: add.height,
          horizontalGap: add.left - last.right,
          verticalGap: add.top - last.bottom
        };
      })()`);
    const fixed = {
      main: await snapshot(main),
      settings: await snapshot(settings),
      swatches: await getSwatches(main),
      add: await getAddGeometry(main),
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
      fixed.swatches.length !== 3 ||
      fixed.swatches.some((rect) => rect.width !== 32 || rect.height !== 32) ||
      fixed.add.width !== 32 ||
      fixed.add.height !== 32 ||
      Math.abs(
        (fixed.add.orientation === "vertical" ? fixed.add.verticalGap : fixed.add.horizontalGap) - 2
      ) > 0.5
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
      add: await getAddGeometry(main),
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
      resized.add.width !== 40 ||
      resized.add.height !== 40 ||
      Math.abs(
        (resized.add.orientation === "vertical" ? resized.add.verticalGap : resized.add.horizontalGap) - 2
      ) > 0.5
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
      stored.schemaVersion !== 3 ||
      stored.revision !== 4
    ) {
      throw new Error("settings.json did not contain the expected revision-4 Fixed/Tonal snapshot");
    }

    for (const client of [main, settings]) {
      await client.send("Page.reload", { ignoreCache: true });
      await waitForComplete(client);
      await afterRender(client);
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
      stretch.swatches.length !== 3 ||
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

    const report = {
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
    await writeFile(resolve(outputDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ passed: true, outputDirectory, stored }, null, 2));
  } catch (error) {
    const failure = {
      capturedAt: new Date().toISOString(),
      passed: false,
      temporaryRoot,
      error: error instanceof Error ? error.stack || error.message : String(error),
      consoleEvidence: Object.fromEntries(
        [...clients.entries()].map(([page, client]) => [page, getConsoleEvidence(client.events)])
      ),
    };
    await writeFile(resolve(outputDirectory, "failure.json"), `${JSON.stringify(failure, null, 2)}\n`);
    throw error;
  } finally {
    for (const client of clients.values()) {
      try {
        await client.evaluate(debugCall("(api) => api.setTemporaryConfigRoot(null)"));
      } catch {
        // Cleanup continues even if a panel closed during the run.
      }
      await client.close();
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }
};

if (command === "self-test") {
  runSelfTest();
} else if (command === "inspect") {
  runInspect().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
} else if (command === "settings-smoke") {
  runSettingsSmoke().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
} else {
  console.error(
    "Usage: node scripts/cep-cdp.mjs <inspect|settings-smoke|self-test> [--output=path]"
  );
  process.exitCode = 1;
}