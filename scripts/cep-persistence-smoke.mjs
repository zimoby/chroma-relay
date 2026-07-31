#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
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

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const PANELS = [
  { page: "main", port: 8198, suffix: "/main/index.html" },
  { page: "settings", port: 8199, suffix: "/settings/index.html" },
];
const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
const debugCall = (callback) => `(() => {
  const api = window.__CHROMA_RELAY_DEBUG__;
  if (!api) throw new Error("Chroma Relay debug API unavailable");
  return (${callback})(api);
})()`;

const connectPanel = async (panel) => {
  const response = await fetch(`http://127.0.0.1:${panel.port}/json/list`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error(`${panel.page} CDP endpoint returned ${response.status}`);
  const targets = await response.json();
  const matches = targets.filter(
    (target) => target.type === "page" && new URL(target.url).pathname.endsWith(panel.suffix)
  );
  if (matches.length !== 1) {
    throw new Error(`${panel.page} expected one exact CDP target, found ${matches.length}`);
  }
  const client = new CdpClient(matches[0].webSocketDebuggerUrl);
  try {
    await client.connect();
    await Promise.all([
      client.send("Runtime.enable"),
      client.send("Log.enable"),
      client.send("Page.enable"),
    ]);
    await client.send("Runtime.discardConsoleEntries");
    client.events = [];
    let stableReadyFrames = 0;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const ready = await client.evaluate(
        'document.readyState === "complete" && Boolean(window.__CHROMA_RELAY_DEBUG__)'
      );
      stableReadyFrames = ready ? stableReadyFrames + 1 : 0;
      if (stableReadyFrames === 3) break;
      if (attempt === 79) throw new Error(`${panel.page} did not finish loading`);
      await delay(50);
    }
    await client.evaluate(
      "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))"
    );
    return client;
  } catch (error) {
    try {
      await client.close();
    } catch (closeError) {
      error.cleanupError = String(closeError?.stack || closeError);
    }
    throw error;
  }
};

const afterRender = async (client) => {
  await client.evaluate(
    "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))"
  );
};

const captureScreenshot = async (client, filePath) => {
  const result = await client.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
  });
  await writeFile(filePath, Buffer.from(result.data, "base64"));
};

const consoleEvidence = (events) => ({
  console: events
    .filter((event) => event.method === "Runtime.consoleAPICalled")
    .map((event) => ({
      type: event.params.type,
      text: event.params.args.map((argument) => argument.value ?? argument.description ?? "").join(" "),
    })),
  logs: events
    .filter((event) => event.method === "Log.entryAdded")
    .map((event) => ({ level: event.params.entry.level, text: event.params.entry.text })),
  exceptions: events
    .filter((event) => event.method === "Runtime.exceptionThrown")
    .map((event) => event.params.exceptionDetails.text),
});

const palette = (revision, id, rgba) => ({
  schemaVersion: 1,
  revision,
  colors: [{ id, rgba }],
});

const activePalette = (document) =>
  document.palettes.find((entry) => entry.id === document.activePaletteId);

const activeColors = (document) => activePalette(document)?.colors ?? [];

const run = async (outputDirectory) => {
  const clients = new Map();
  let scratch = await createOwnedTemporaryConfigDirectory({ tokenPrefix: "chroma-relay-persistence" });
  let temporaryRoot = scratch.path;
  let primaryError = null;
  const cleanupErrors = [];
  await mkdir(outputDirectory, { recursive: true });
  const resetRoot = async () => {
    await removeOwnedRunDirectory(scratch);
    scratch = await createOwnedTemporaryConfigDirectory({ tokenPrefix: "chroma-relay-persistence" });
    temporaryRoot = scratch.path;
    await Promise.all(
      [...clients.values()].map(async (client) => {
        await client.evaluate(
          debugCall(`(api) => api.setTemporaryConfigRoot(${JSON.stringify(temporaryRoot)})`)
        );
        await afterRender(client);
      })
    );
  };
  const snapshot = (client) =>
    client.evaluate(debugCall("(api) => ({ state: api.getState(), counters: api.getCounters() })"));

  try {
    for (const panel of PANELS) {
      const client = await connectPanel(panel);
      clients.set(panel.page, client);
      await client.evaluate(debugCall("(api) => api.resetTestState()"));
      await afterRender(client);
      await client.evaluate(
        debugCall(`(api) => api.setTemporaryConfigRoot(${JSON.stringify(temporaryRoot)})`)
      );
      await afterRender(client);
    }
    const main = clients.get("main");
    const settings = clients.get("settings");
    const cases = {};

    await resetRoot();
    cases.missing = await main.evaluate(debugCall("(api) => api.reloadPalette()"));
    if (cases.missing.error || activeColors(cases.missing.document).length !== 5) {
      throw new Error("Missing palette did not load the non-destructive default");
    }

    await resetRoot();
    const exact = palette(7, "exact-hdr", [1.25, -0.1, 0.5000004, 0.875]);
    const exactRaw = `${JSON.stringify(exact, null, 2)}\n`;
    await writeFile(resolve(temporaryRoot, "palette.json"), exactRaw);
    cases.valid = await main.evaluate(debugCall("(api) => api.reloadPalette()"));
    await afterRender(main);
    const unchangedLegacyRaw = await readFile(resolve(temporaryRoot, "palette.json"), "utf8");
    if (
      cases.valid.document.schemaVersion !== contract.schemas.palette ||
      cases.valid.document.revision !== exact.revision ||
      cases.valid.document.activePaletteId !== "palette-default" ||
      activePalette(cases.valid.document)?.name !== "Palette 1" ||
      JSON.stringify(activeColors(cases.valid.document)) !== JSON.stringify(exact.colors) ||
      unchangedLegacyRaw !== exactRaw
    ) {
      throw new Error("Valid v1 palette did not migrate in memory without an eager rewrite");
    }
    await main.evaluate(
      debugCall(
        `(api) => api.persistPalette(${JSON.stringify(exact.colors)})`
      )
    );
    const migratedFile = JSON.parse(await readFile(resolve(temporaryRoot, "palette.json"), "utf8"));
    cases.validMutation = migratedFile;
    if (
      migratedFile.schemaVersion !== contract.schemas.palette ||
      migratedFile.revision !== exact.revision + 1 ||
      JSON.stringify(activeColors(migratedFile)) !== JSON.stringify(exact.colors)
    ) {
      throw new Error("First mutation after v1 load did not persist the current contract schema");
    }

    await resetRoot();
    const malformedRaw = '{"schemaVersion":1,"revision":';
    await writeFile(resolve(temporaryRoot, "palette.json"), malformedRaw);
    cases.malformed = await main.evaluate(debugCall("(api) => api.reloadPalette()"));
    await afterRender(main);
    await main.evaluate(
      debugCall('(api) => api.seedPalette([{ id: "guard-bypass", css: "#ff0000" }])')
    );
    await afterRender(main);
    cases.malformedWriteAttempt = await main.evaluate(
      debugCall(
        '(async (api) => { try { await api.persistPalette([{ id: "must-not-write", rgba: [1, 0, 0, 1] }]); return "unexpected"; } catch (error) { return error.message; } })'
      )
    );
    const preservedMalformed = await readFile(resolve(temporaryRoot, "palette.json"), "utf8");
    if (
      !cases.malformed.error ||
      !cases.malformedWriteAttempt.includes("Refusing to replace an invalid saved palette") ||
      preservedMalformed !== malformedRaw
    ) {
      throw new Error("Malformed palette evidence was not preserved exactly");
    }
    await writeFile(resolve(outputDirectory, "malformed-palette.json"), preservedMalformed);

    await resetRoot();
    const temporary = palette(8, "temp-recovery", [0.1, 0.2, 0.3, 1]);
    await writeFile(resolve(temporaryRoot, "palette.json.tmp"), `${JSON.stringify(temporary)}\n`);
    cases.temp = await main.evaluate(debugCall("(api) => api.reloadPalette()"));
    if (cases.temp.recovery !== "temp") throw new Error("Valid temp recovery did not run");

    await resetRoot();
    const backup = palette(9, "backup-recovery", [0.4, 0.5, 0.6, 1]);
    await writeFile(resolve(temporaryRoot, "palette.json.bak"), `${JSON.stringify(backup)}\n`);
    cases.backup = await main.evaluate(debugCall("(api) => api.reloadPalette()"));
    if (cases.backup.recovery !== "backup") throw new Error("Valid backup recovery did not run");

    await resetRoot();
    const interruptedBackup = palette(10, "stale-backup", [0.6, 0.5, 0.4, 1]);
    const interruptedTemp = palette(11, "verified-temp-wins", [0.3, 0.2, 0.1, 1]);
    await writeFile(resolve(temporaryRoot, "palette.json.bak"), `${JSON.stringify(interruptedBackup)}\n`);
    await writeFile(resolve(temporaryRoot, "palette.json.tmp"), `${JSON.stringify(interruptedTemp)}\n`);
    cases.interrupted = await main.evaluate(debugCall("(api) => api.reloadPalette()"));
    if (
      cases.interrupted.recovery !== "temp" ||
      activeColors(cases.interrupted.document)[0].id !== "verified-temp-wins"
    ) {
      throw new Error("Interrupted state did not prefer the newer verified temp palette");
    }

    await resetRoot();
    const fallbackBackup = palette(12, "valid-backup-fallback", [0.2, 0.4, 0.6, 1]);
    const invalidTempRaw = '{"schemaVersion":1,"revision":';
    await writeFile(resolve(temporaryRoot, "palette.json.tmp"), invalidTempRaw);
    await writeFile(resolve(temporaryRoot, "palette.json.bak"), `${JSON.stringify(fallbackBackup)}\n`);
    cases.invalidTemp = await main.evaluate(debugCall("(api) => api.reloadPalette()"));
    const preservedInvalidTemp = await readFile(resolve(temporaryRoot, "palette.json.tmp"), "utf8");
    if (
      cases.invalidTemp.recovery !== "backup" ||
      activeColors(cases.invalidTemp.document)[0].id !== "valid-backup-fallback" ||
      preservedInvalidTemp !== invalidTempRaw
    ) {
      throw new Error("Invalid temp masked a valid backup or was not preserved");
    }

    await resetRoot();
    await main.evaluate(debugCall("(api) => api.resetTestState()"));
    await afterRender(main);
    await main.evaluate(
      debugCall(`(api) => api.setTemporaryConfigRoot(${JSON.stringify(temporaryRoot)})`)
    );
    await afterRender(main);
    const firstColors = [{ id: "queued-first", rgba: [0.11, 0.22, 0.33, 1] }];
    const secondColors = [{ id: "queued-second", rgba: [0.44, 0.55, 0.66, 0.77] }];
    await main.evaluate(
      debugCall(
        `(api) => Promise.all([api.persistPalette(${JSON.stringify(firstColors)}), api.persistPalette(${JSON.stringify(secondColors)})])`
      )
    );
    await afterRender(main);
    const queuedFile = JSON.parse(await readFile(resolve(temporaryRoot, "palette.json"), "utf8"));
    const queuedSnapshot = await snapshot(main);
    if (
      queuedSnapshot.counters.diskWrites !== 2 ||
      activeColors(queuedFile)[0].id !== "queued-second" ||
      JSON.stringify(activeColors(queuedFile)[0].rgba) !== JSON.stringify(secondColors[0].rgba)
    ) {
      throw new Error("Serialized writes did not complete twice with last-write-wins data");
    }

    await main.evaluate(
      debugCall(
        '(api) => api.seedPalette([{ id: "transient-memory", css: "#e6ccb3" }])'
      )
    );
    await afterRender(main);
    await main.evaluate(debugCall("(api) => api.reloadPalette()"));
    await afterRender(main);
    const reloaded = await snapshot(main);
    if (
      reloaded.state.palette[0].id !== "queued-second" ||
      JSON.stringify(reloaded.state.palette[0].rgba) !== JSON.stringify(secondColors[0].rgba)
    ) {
      throw new Error("Exact palette values did not survive Main reload");
    }

    const settingsWriteBoundary = await settings.evaluate(
      debugCall(
        `(async (api) => { try { await api.persistPalette(${JSON.stringify(firstColors)}); return "unexpected"; } catch (error) { return error.message; } })`
      )
    );
    const settingsSnapshot = await snapshot(settings);
    if (
      !settingsWriteBoundary.includes("only available on the Main panel") ||
      settingsSnapshot.counters.diskWrites !== 0 ||
      settingsSnapshot.counters.hostCalls !== 0
    ) {
      throw new Error("Settings crossed the palette ownership boundary");
    }

    await captureScreenshot(main, resolve(outputDirectory, "main-reloaded.png"));
    const consoles = Object.fromEntries(
      [...clients.entries()].map(([page, client]) => [page, consoleEvidence(client.events)])
    );
    for (const [page, evidence] of Object.entries(consoles)) {
      const errors = evidence.console.filter((entry) => ["error", "assert"].includes(entry.type));
      const logErrors = evidence.logs.filter((entry) => entry.level === "error");
      if (errors.length || logErrors.length || evidence.exceptions.length) {
        throw new Error(`${page} emitted errors during persistence smoke`);
      }
    }

    const report = {
      capturedAt: new Date().toISOString(),
      passed: true,
      temporaryRoot,
      cases,
      queuedFile,
      queuedSnapshot,
      reloaded,
      settingsWriteBoundary,
      settingsSnapshot,
      consoleEvidence: consoles,
      screenshots: ["main-reloaded.png"],
      preservedEvidence: ["malformed-palette.json"],
    };
    await writeFile(resolve(outputDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ passed: true, outputDirectory }, null, 2));
  } catch (error) {
    primaryError = error;
  } finally {
    for (const client of clients.values()) {
      try {
        await client.evaluate(debugCall("(api) => api.setTemporaryConfigRoot(null)"));
      } catch {
        // Cleanup continues even if a panel closed during the run.
      }
      try {
        await client.close();
      } catch (error) {
        cleanupErrors.push({ phase: `close:${client.page || "panel"}`, error: String(error?.stack || error) });
      }
    }
    try {
      await removeOwnedRunDirectory(scratch);
    } catch (error) {
      cleanupErrors.push({ phase: "scratch", error: String(error?.stack || error) });
    }
  }
  if (primaryError || cleanupErrors.length > 0) {
    await writeFile(
      resolve(outputDirectory, "failure.json"),
      `${JSON.stringify(
        {
          capturedAt: new Date().toISOString(),
          passed: false,
          error: primaryError ? primaryError.stack || primaryError.message : null,
          cleanupErrors,
          consoleEvidence: Object.fromEntries(
            [...clients.entries()].map(([page, client]) => [page, consoleEvidence(client.events)])
          ),
        },
        null,
        2
      )}\n`
    );
    if (primaryError) throw primaryError;
    throw new AggregateError(cleanupErrors.map(({ error }) => new Error(error)), "Persistence cleanup failed");
  }
};

const cli = async () => {
  const options = parseRunnerArgs(process.argv.slice(2), { allowed: ["output"] });
  const root = options.output || "evidence/i06/persistence-smoke";
  const owned = await createOwnedRunDirectory(resolve(REPO_ROOT, root));
  return run(owned.path);
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  cli().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : error);
    process.exitCode = 1;
  });
}
