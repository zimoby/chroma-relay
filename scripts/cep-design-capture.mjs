#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
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

const EXPECTED_BUILD_MARKER = `${contract.marker.current} · ${packageJson.version}`;

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const FIXTURES = [
  { width: 128, height: 32 },
  { width: 160, height: 32 },
  { width: 128, height: 160 },
  { width: 200, height: 200 },
];
const DESIGN_STATES = ["interaction", "empty", "disabled", "error"];
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
const debugCall = (source) => `
  (async () => {
    const api = window.__CHROMA_RELAY_DEBUG__;
    if (!api) throw new Error("__CHROMA_RELAY_DEBUG__ is missing");
    return (${source})(api);
  })()
`;

const getTarget = async (panel) => {
  const response = await fetch(`http://127.0.0.1:${panel.port}/json/list`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error(`CDP ${panel.port} returned HTTP ${response.status}`);
  const targets = await response.json();
  const matches = targets.filter((target) => {
    if (target.type !== "page") return false;
    try {
      return fileURLToPath(target.url).endsWith(panel.pageSuffix);
    } catch {
      return false;
    }
  });
  if (matches.length !== 1 || !matches[0].webSocketDebuggerUrl) {
    throw new Error(
      `${panel.page} expected exactly one ${panel.pageSuffix} target on port ${panel.port}; found ${matches.length}`
    );
  }
  return matches[0];
};

const waitForComplete = async (client) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await client.evaluate("document.readyState")) === "complete") return;
    await delay(100);
  }
  throw new Error("Panel document did not reach readyState=complete");
};

const afterRender = (client) =>
  client.evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");

const getPanelClip = (client, page) =>
  client.evaluate(`
    (() => {
      const element = document.querySelector('[data-page="${page}"]');
      if (!element) throw new Error('Missing ${page} panel root');
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 };
    })()
  `);

const captureScreenshot = async (client, path, page) => {
  const screenshot = await client.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
    clip: await getPanelClip(client, page),
  });
  await writeFile(path, Buffer.from(screenshot.data, "base64"));
};

const consoleEvidence = (events) => ({
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

const assertNoErrors = (evidence, page) => {
  const consoleErrors = evidence.console.filter((entry) =>
    ["error", "assert"].includes(entry.type)
  );
  const logErrors = evidence.logs.filter((entry) => entry.level === "error");
  if (consoleErrors.length || logErrors.length || evidence.exceptions.length) {
    throw new Error(`${page} emitted errors during design capture`);
  }
};

export const runDesignCaptureLifecycle = async ({
  capture,
  cleanupSteps,
  writeFailure,
}) => {
  let report;
  let primaryError = null;
  const cleanupErrors = [];

  try {
    report = await capture();
  } catch (error) {
    primaryError = error;
  } finally {
    for (const { phase, run } of cleanupSteps) {
      try {
        await run();
      } catch (error) {
        cleanupErrors.push({ phase, error: String(error?.stack || error) });
      }
    }
  }

  if (primaryError || cleanupErrors.length > 0) {
    await writeFailure({ primaryError, cleanupErrors, report });
    if (primaryError) throw primaryError;
    throw new AggregateError(
      cleanupErrors.map(({ error }) => new Error(error)),
      "Design cleanup failed"
    );
  }
  return report;
};

const capturePanel = async (panel, outputDirectory, parentRun) => {
  const panelDirectory = resolve(outputDirectory, panel.page);
  await mkdir(panelDirectory, { recursive: true });
  const scratch = await createOwnedScratchDirectory(parentRun);
  let target;
  let client;
  let report = null;

  const captured = await runDesignCaptureLifecycle({
    capture: async () => {
    target = await getTarget(panel);
    client = new CdpClient(target.webSocketDebuggerUrl);
    await client.connect();
    await Promise.all([
      client.send("Runtime.enable"),
      client.send("Log.enable"),
      client.send("Page.enable"),
    ]);
    await client.send("Emulation.clearDeviceMetricsOverride");
    await client.send("Runtime.discardConsoleEntries");
    client.events = [];
    await client.send("Page.reload", { ignoreCache: true });
    await waitForComplete(client);
    await afterRender(client);

    const temporaryRoot = scratch.path;
    await client.evaluate(
      debugCall(`(api) => api.setTemporaryConfigRoot(${JSON.stringify(temporaryRoot)})`)
    );
    const accepted = await client.evaluate(
      debugCall('(api) => api.setDesignPreview("default")')
    );
    if (!accepted) throw new Error(`${panel.page} rejected the approved design preview`);
    await afterRender(client);

    const identity = await client.evaluate(debugCall("(api) => api.getIdentity()"));
    if (
      identity.extensionId !== panel.extensionId ||
      identity.page !== panel.page ||
      identity.buildMarker !== EXPECTED_BUILD_MARKER
    ) {
      throw new Error(`${panel.page} identity/build marker mismatch`);
    }

    const captures = {};
    if (panel.page === "main") {
      const captureViewport = await client.evaluate(
        "({ width: window.innerWidth, height: window.innerHeight })"
      );
      if (captureViewport.width < 200 || captureViewport.height < 200) {
        throw new Error(
          `Main compositor is ${captureViewport.width}x${captureViewport.height}; resize the real panel to at least 200x200 before fixture capture`
        );
      }
      captures.captureViewport = {
        minimum: { width: 200, height: 200 },
        actual: captureViewport,
      };
      for (const fixture of FIXTURES) {
        const key = `${fixture.width}x${fixture.height}`;
        await client.send("Emulation.setDeviceMetricsOverride", {
          width: fixture.width,
          height: fixture.height,
          deviceScaleFactor: 1,
          mobile: false,
        });
        const fixtureAccepted = await client.evaluate(
          debugCall(`(api) => api.setFixtureViewport(${fixture.width}, ${fixture.height})`)
        );
        if (!fixtureAccepted) throw new Error(`main rejected fixture ${key}`);
        await client.evaluate(debugCall('(api) => api.setDesignPreview("default")'));
        await afterRender(client);
        const state = await client.evaluate(debugCall("(api) => api.getState()"));
        const geometry = await client.evaluate(debugCall("(api) => api.getGeometry()"));
        const expectedOrientation = fixture.width >= fixture.height ? "horizontal" : "vertical";
        if (state.activeOrientation !== expectedOrientation) {
          throw new Error(
            `${key} expected ${expectedOrientation}, got ${state.activeOrientation}`
          );
        }
        const add = geometry.controls["palette-add"];
        const panelRect = geometry.panel;
        if (
          !add ||
          !panelRect ||
          add.width < 24 ||
          add.height < 24 ||
          add.x < panelRect.x ||
          add.y < panelRect.y ||
          add.x + add.width > panelRect.x + panelRect.width + 0.5 ||
          add.y + add.height > panelRect.y + panelRect.height + 0.5
        ) {
          throw new Error(`${key} did not keep the Add control visible`);
        }
        const swatchRects = ["swatch-coral", "swatch-leaf", "swatch-sky"].map(
          (testId) => geometry.controls[testId]
        );
        if (swatchRects.some((rect) => !rect)) {
          throw new Error(`${key} is missing swatch geometry`);
        }
        const crossAxisValues = swatchRects.map((rect) =>
          expectedOrientation === "horizontal" ? rect.y : rect.x
        );
        if (Math.max(...crossAxisValues) - Math.min(...crossAxisValues) > 0.5) {
          throw new Error(`${key} wrapped swatches onto multiple axes`);
        }
        const file = `${key}.png`;
        await captureScreenshot(client, resolve(panelDirectory, file), panel.page);
        captures[key] = {
          file,
          expectedOrientation,
          state,
          geometry,
        };
      }

      await client.evaluate(debugCall("(api) => api.setFixtureViewport(200, 200)"));
      for (const state of DESIGN_STATES) {
        const stateAccepted = await client.evaluate(
          debugCall(`(api) => api.setDesignPreview(${JSON.stringify(state)})`)
        );
        if (!stateAccepted) throw new Error(`main rejected state ${state}`);
        await afterRender(client);
        const stateEvidence = await client.evaluate(`
          (() => ({
            swatchCount: document.querySelectorAll('.palette-swatch').length,
            previewHoverCount: document.querySelectorAll('.is-preview-hover').length,
            previewFocusCount: document.querySelectorAll('.is-preview-focus').length,
            previewSelectedCount: document.querySelectorAll('.is-preview-selected').length,
            addDisabled: document.querySelector('[data-testid="palette-add"]')?.disabled === true,
            statusText: document.querySelector('[data-testid="status-output"]')?.textContent?.trim() || ""
          }))()
        `);
        if (
          state === "interaction" &&
          (stateEvidence.previewHoverCount !== 1 ||
            stateEvidence.previewFocusCount !== 1 ||
            stateEvidence.previewSelectedCount < 1)
        ) {
          throw new Error("Interaction preview is incomplete");
        }
        if (state === "empty" && stateEvidence.swatchCount !== 0) {
          throw new Error("Empty preview still has swatches");
        }
        if (state === "disabled" && !stateEvidence.addDisabled) {
          throw new Error("Disabled preview left Add enabled");
        }
        if (state === "error" && !stateEvidence.statusText) {
          throw new Error("Error preview has no message");
        }
        const file = `state-${state}.png`;
        await captureScreenshot(client, resolve(panelDirectory, file), panel.page);
        captures[`state-${state}`] = { file, evidence: stateEvidence };
      }

      await client.send("Emulation.clearDeviceMetricsOverride");
      await client.evaluate(debugCall("(api) => api.resetTestState()"));
      await client.evaluate(debugCall('(api) => api.setDesignPreview("default")'));
      await afterRender(client);
      const file = "native.png";
      await captureScreenshot(client, resolve(panelDirectory, file), panel.page);
      captures.native = {
        file,
        state: await client.evaluate(debugCall("(api) => api.getState()")),
        geometry: await client.evaluate(debugCall("(api) => api.getGeometry()")),
      };
    } else {
      const file = "settings.png";
      await captureScreenshot(client, resolve(panelDirectory, file), panel.page);
      const bodyText = await client.evaluate("document.body.innerText.trim()");
      if (/Auto|Horizontal|Vertical/.test(bodyText)) {
        throw new Error("Settings reintroduced orientation controls");
      }
      captures.settings = {
        file,
        bodyText,
        state: await client.evaluate(debugCall("(api) => api.getState()")),
      };
    }

    const counters = await client.evaluate(debugCall("(api) => api.getCounters()"));
    if (Object.values(counters).some((count) => count !== 0)) {
      throw new Error(`${panel.page} touched disk/events/host counters`);
    }
    const errors = consoleEvidence(client.events);
    assertNoErrors(errors, panel.page);

    report = {
      capturedAt: new Date().toISOString(),
      design: "seam",
      panel,
      target,
      identity,
      captures,
      counters,
      consoleEvidence: errors,
      note: "Orientation is derived by the live ResizeObserver from panel dimensions.",
    };
    return report;
    },
    cleanupSteps: [
      {
        phase: "emulation",
        run: async () => {
          if (client) await client.send("Emulation.clearDeviceMetricsOverride");
        },
      },
      {
        phase: "close",
        run: async () => {
          if (client) await client.close();
        },
      },
      { phase: "scratch", run: () => removeOwnedRunDirectory(scratch) },
    ],
    writeFailure: async ({ primaryError, cleanupErrors }) => {
      await writeFile(
        resolve(panelDirectory, "failure.json"),
        `${JSON.stringify(
          {
            capturedAt: new Date().toISOString(),
            design: "seam",
            panel,
            target,
            error: primaryError ? primaryError.stack || primaryError.message : null,
            cleanupErrors,
            consoleEvidence: client ? consoleEvidence(client.events) : null,
          },
          null,
          2
        )}\n`
      );
    },
  });
  await writeFile(
    resolve(panelDirectory, "report.json"),
    `${JSON.stringify(captured, null, 2)}\n`
  );
  return captured;
};

const main = async () => {
  const options = parseRunnerArgs(process.argv.slice(2), { allowed: ["output"] });
  const root = options.output || "evidence/i05/responsive";
  const run = await createOwnedRunDirectory(resolve(REPO_ROOT, root));
  const reports = [];
  for (const panel of PANELS) reports.push(await capturePanel(panel, run.path, run));
  const summary = {
    capturedAt: new Date().toISOString(),
    passed: true,
    design: "seam",
    panels: reports.map((report) => ({
      page: report.panel.page,
      port: report.panel.port,
      captures: Object.keys(report.captures),
      report: `${report.panel.page}/report.json`,
    })),
  };
  await writeFile(resolve(run.path, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  });
}
