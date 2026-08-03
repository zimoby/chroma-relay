import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { lstat, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

const require = createRequire(import.meta.url);
const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));
const DIST_ROOT = join(REPOSITORY_ROOT, "dist");
const CEP_DIST_ROOT = join(DIST_ROOT, "cep");
const MAIN_DIST_ROOT = join(CEP_DIST_ROOT, "main");
const CANONICAL_MAIN_ENTRY = join(MAIN_DIST_ROOT, "index.html");

const snapshotPath = async (path) => {
  try {
    const stat = await lstat(path);
    return Object.freeze({ exists: true, symbolicLink: stat.isSymbolicLink() });
  } catch (error) {
    if (error?.code === "ENOENT") return Object.freeze({ exists: false, symbolicLink: false });
    throw error;
  }
};

const throwCleanupErrors = (errors, message) => {
  if (errors.length === 0) return;
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, message);
};

const runCleanupSteps = async (steps, message) => {
  const errors = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      errors.push(error);
    }
  }
  throwCleanupErrors(errors, message);
};

const materializeCanonicalMainEntry = async () => {
  const paths = [DIST_ROOT, CEP_DIST_ROOT, MAIN_DIST_ROOT, CANONICAL_MAIN_ENTRY];
  const snapshots = new Map();
  for (const path of paths) snapshots.set(path, await snapshotPath(path));

  if (snapshots.get(CANONICAL_MAIN_ENTRY).exists) return async () => {};
  for (const path of [DIST_ROOT, CEP_DIST_ROOT, MAIN_DIST_ROOT]) {
    if (snapshots.get(path).symbolicLink) throw new Error(`Cannot materialize through a symlink: ${path}`);
  }

  const restoreCanonicalEntry = async () => {
    const errors = [];
    for (const path of [CANONICAL_MAIN_ENTRY, MAIN_DIST_ROOT, CEP_DIST_ROOT, DIST_ROOT]) {
      if (snapshots.get(path).exists) continue;
      try {
        await rm(path, { recursive: path !== CANONICAL_MAIN_ENTRY, force: true });
      } catch (error) {
        errors.push(error);
      }
    }
    throwCleanupErrors(errors, "Canonical entry cleanup failed");
  };

  try {
    await mkdir(MAIN_DIST_ROOT, { recursive: true });
    await writeFile(CANONICAL_MAIN_ENTRY, "test-owned canonical entry\n", { flag: "wx" });
  } catch (error) {
    try {
      await restoreCanonicalEntry();
    } catch (restoreError) {
      throw new AggregateError([error, restoreError], "Canonical entry setup and cleanup failed");
    }
    throw error;
  }

  return restoreCanonicalEntry;
};

test("consumer can load the exact published CEP testkit release", async () => {
  const entry = require.resolve("@zimoby/cep-testkit/cdp");
  const packageRoot = dirname(dirname(dirname(dirname(entry))));
  const packageJson = require(join(packageRoot, "package.json"));
  assert.deepEqual(
    {
      name: packageJson.name,
      version: packageJson.version,
      private: packageJson.private,
      license: packageJson.license,
      engines: packageJson.engines,
      dependencies: packageJson.dependencies,
    },
    {
      name: "@zimoby/cep-testkit",
      version: "0.1.0",
      private: false,
      license: "MIT",
      engines: { node: ">=22.0.0 <23" },
      dependencies: { ws: "8.21.1" },
    },
  );
  assert.equal(Number(process.versions.node.split(".")[0]), 22);
  const cdp = await import("@zimoby/cep-testkit/cdp");
  assert.equal(typeof cdp.discoverCdpTargets, "function");
  assert.equal(typeof cdp.selectCanonicalTarget, "function");
  assert.equal(typeof cdp.CdpClient, "function");
  assert.equal(typeof cdp.authenticateRuntime, "function");
});

test("Chroma exposes a bounded opt-in adoption adapter", async () => {
  const adapter = await import("../scripts/lib/chroma-cep-testkit.mjs");
  assert.equal(typeof adapter.connectChromaPanel, "function");
  assert.deepEqual(Object.keys(adapter.CHROMA_PANELS).sort(), ["main", "settings"]);
  assert.equal(adapter.CHROMA_PANELS.main.extensionId, "com.zimoby.chroma-relay.main");
  assert.equal(adapter.CHROMA_PANELS.settings.extensionId, "com.zimoby.chroma-relay.settings");
});

const closeLoopback = async ({ server, webSocketServer }) => {
  const errors = [];
  for (const socket of webSocketServer.clients) {
    try {
      socket.close();
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await new Promise((resolve, reject) => webSocketServer.close((error) => {
      if (error) reject(error);
      else resolve();
    }));
  } catch (error) {
    errors.push(error);
  }
  try {
    if (server.listening) {
      await new Promise((resolve, reject) => server.close((error) => {
        if (error) reject(error);
        else resolve();
      }));
    }
  } catch (error) {
    errors.push(error);
  }
  throwCleanupErrors(errors, "Loopback cleanup failed");
};

const createLoopback = async ({ entryPath, extensionId, version, buildMarker, targets }) => {
  const state = { targets, events: [] };
  const server = createServer((request, response) => {
    if (request.url !== "/json") {
      response.writeHead(404).end();
      return;
    }
    const body = JSON.stringify(state.targets);
    response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    response.end(body);
  });
  const webSocketServer = new WebSocketServer({ server, path: "/devtools/page/1" });
  webSocketServer.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      let value = null;
      if (message.method === "Runtime.evaluate") {
        const expression = String(message.params?.expression ?? "");
        if (expression.includes("window.location.href") && expression.includes("__adobe_cep__")) {
          state.events.push("runtime-proof");
          value = { href: pathToFileURL(entryPath).href, extensionId };
        } else if (expression.includes("document.readyState") && expression.includes("__CHROMA_RELAY_DEBUG__")) {
          state.events.push("ready");
          value = true;
        } else if (expression.includes("api.getIdentity()")) {
          state.events.push("chroma-identity");
          value = {
            extensionId,
            page: "main",
            version,
            buildMarker,
            url: pathToFileURL(entryPath).href,
            scripts: [pathToFileURL(join(entryPath, "../../assets/loopback.js")).href],
            styles: [],
          };
        } else {
          state.events.push("dispatch");
          value = "dispatched";
        }
      } else {
        state.events.push(message.method);
      }
      socket.send(JSON.stringify({ id: message.id, result: message.method === "Runtime.evaluate" ? { result: { value } } : {} }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
    server.listen(0, "127.0.0.1");
  });
  return { state, server, webSocketServer, port: server.address().port };
};

test("offline loopback adoption proves exact target, Chroma identity/readiness, authenticated dispatch, and cleanup", async () => {
  const adapter = await import("../scripts/lib/chroma-cep-testkit.mjs?loopback");
  const cdp = await import("@zimoby/cep-testkit/cdp");
  const root = await mkdtemp(join(tmpdir(), "chroma-relay-cep-testkit-loopback-"));
  const legacyPath = join(root, "legacy", "dist", "cep", "main", "index.html");
  const foreignPath = join(root, "foreign", "dist", "cep", "main", "index.html");
  const entryPath = CANONICAL_MAIN_ENTRY;
  const extensionId = "com.zimoby.chroma-relay.main";
  const version = "0.0.1";
  const buildMarker = "Palette v2 · 0.0.1";
  let loopback;
  let connection;
  let restoreCanonicalEntry;
  try {
    restoreCanonicalEntry = await materializeCanonicalMainEntry();
    await mkdir(join(legacyPath, ".."), { recursive: true });
    await writeFile(legacyPath, "legacy\n");
    await mkdir(join(foreignPath, ".."), { recursive: true });
    await writeFile(foreignPath, "foreign\n");
    const canonicalUrl = pathToFileURL(entryPath).href;
    const legacyUrl = pathToFileURL(legacyPath).href;
    const foreignUrl = pathToFileURL(foreignPath).href;
    const target = (url, index) => ({
      type: "page",
      url,
      webSocketDebuggerUrl: `ws://127.0.0.1:1/unused-${index}`,
    });
    loopback = await createLoopback({
      entryPath,
      extensionId,
      version,
      buildMarker,
      targets: [
        target(legacyUrl, 0),
        { ...target(canonicalUrl, 1), webSocketDebuggerUrl: "ws://127.0.0.1:0/devtools/page/1" },
        target(foreignUrl, 2),
      ],
    });
    loopback.state.targets[1].webSocketDebuggerUrl = `ws://127.0.0.1:${loopback.port}/devtools/page/1`;

    connection = await adapter.connectChromaPanel({
      page: "main",
      host: "127.0.0.1",
      port: loopback.port,
    });
    assert.equal(connection.target.url, canonicalUrl);
    assert.equal(connection.identity.extensionId, extensionId);
    assert.equal(connection.identity.canonicalEntryPath, await realpath(entryPath));
    assert.equal(connection.identity.surfaceId, extensionId);
    assert.equal("client" in connection, false);
    assert.equal("socket" in connection, false);
    assert.equal("send" in connection, false);

    const dispatched = await connection.dispatch("loopback-dispatch", 1_000, async (operation) => (
      operation.evaluate("(() => 'dispatch')()").wait()
    ));
    assert.equal(dispatched, "dispatched");
    assert.deepEqual(loopback.state.events.slice(-4), ["runtime-proof", "ready", "chroma-identity", "dispatch"]);

    const firstClose = connection.close();
    const concurrentClose = connection.close();
    assert.equal(concurrentClose, firstClose);
    await Promise.all([firstClose, concurrentClose]);
    assert.throws(
      () => connection.dispatch("after-close", 1_000, async (operation) => operation.evaluate("'late'")),
      /closed/,
    );
    connection = null;

    loopback.state.targets = [target(legacyUrl, 0)];
    await assert.rejects(
      adapter.connectChromaPanel({ page: "main", host: "127.0.0.1", port: loopback.port }),
      (error) => error?.code === cdp.CdpErrorCode.TARGET_NOT_EXACT,
    );
  } finally {
    const cleanupSteps = [
      () => connection?.close(),
      () => loopback ? closeLoopback(loopback) : undefined,
      () => {
        if (!loopback) return undefined;
        assert.equal(loopback.server.listening, false);
        assert.equal(loopback.webSocketServer.clients.size, 0);
        return undefined;
      },
      () => restoreCanonicalEntry?.(),
      () => rm(root, { recursive: true, force: true }),
      () => assert.rejects(lstat(root), { code: "ENOENT" }),
    ];
    await runCleanupSteps(cleanupSteps, "Offline loopback cleanup failed");
  }
});
