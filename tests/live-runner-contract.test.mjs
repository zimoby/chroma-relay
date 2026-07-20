import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { CdpClient } from "../scripts/lib/cdp-client.mjs";
import {
  RunnerPolicyError,
  createOwnedRunDirectory,
  createOwnedScratchDirectory,
  parseRunnerArgs,
  removeOwnedRunDirectory,
} from "../scripts/lib/live-runner-policy.mjs";

const expectReject = async (promise, pattern) => {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof RunnerPolicyError || error instanceof Error);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
};

test("CLI parsing rejects empty, duplicate, unknown, absolute, root, and traversal outputs", () => {
  for (const argv of [
    ["--output="],
    ["--output=a", "--output=b"],
    ["--unknown=x"],
    ["--output=/tmp/out"],
    ["--output=."],
    ["--output=../out"],
    ["--output=a/../../out"],
  ]) {
    assert.throws(() => parseRunnerArgs(argv, { allowed: ["output"] }), RunnerPolicyError);
  }
  assert.deepEqual(
    parseRunnerArgs(["--output=reports", "--main-id=main"], {
      allowed: ["output", "main-id"],
    }),
    { output: "reports", "main-id": "main" }
  );
});

test("rejected output roots perform zero filesystem mutation", async () => {
  const calls = [];
  const fs = new Proxy({}, { get: () => (...args) => { calls.push(args); } });
  await expectReject(
    createOwnedRunDirectory("../escape", { cwd: "/workspace", fs }),
    /traversal/
  );
  assert.deepEqual(calls, []);
});

test("owned run directories are exclusive and cleanup cannot remove the caller root", async () => {
  const root = await mkdtemp(join(tmpdir(), "chroma-relay-s4-"));
  const first = await createOwnedRunDirectory(root, {
    tokenFactory: () => "fixed-token",
  });
  const second = await createOwnedRunDirectory(root, {
    tokenFactory: () => "second-token",
  });
  assert.notEqual(first.path, second.path);
  const marker = JSON.parse(await readFile(first.markerPath, "utf8"));
  assert.equal(marker.kind, "chroma-relay-run");
  await removeOwnedRunDirectory(first);
  await assert.doesNotReject(() => readFile(second.markerPath, "utf8"));
  await expectReject(removeOwnedRunDirectory(root), /owned run directory/);
  await removeOwnedRunDirectory(second);
  await rm(root, { recursive: true, force: true });
});

test("owned cleanup recomputes the marker path and rejects forged, swapped, and stale identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "chroma-relay-s4-identity-"));
  const outside = await mkdtemp(join(tmpdir(), "chroma-relay-s4-outside-"));
  const run = await createOwnedRunDirectory(root, { tokenFactory: () => "identity-token" });
  await writeFile(join(outside, "sentinel"), "preserve\n");

  await assert.rejects(
    removeOwnedRunDirectory({ ...run, markerPath: join(outside, "sentinel") }),
    RunnerPolicyError
  );
  assert.equal(await readFile(run.markerPath, "utf8") !== "", true);

  const marker = JSON.parse(await readFile(run.markerPath, "utf8"));
  marker.child = `${run.path}-stale`;
  await writeFile(run.markerPath, `${JSON.stringify(marker)}\n`);
  await expectReject(removeOwnedRunDirectory(run), /marker/);
  marker.child = run.path;
  await writeFile(run.markerPath, `${JSON.stringify(marker)}\n`);

  await rm(run.path, { recursive: true, force: true });
  await symlink(outside, run.path);
  await expectReject(removeOwnedRunDirectory(run), /symlink|owned/);
  assert.equal(await readFile(join(outside, "sentinel"), "utf8"), "preserve\n");

  await rm(run.path, { force: true });
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

test("marker-write failure leaves residue and never calls recursive rm", async () => {
  const calls = [];
  const outputRoot = resolve(sep, "workspace", "out");
  const residuePath = join(outputRoot, "residue-token");
  const fs = {
    lstat: async (path) => {
      if (path === outputRoot) return { isDirectory: () => true, isSymbolicLink: () => false };
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    realpath: async (path) => path,
    mkdir: async (path, options) => calls.push(["mkdir", path, options]),
    writeFile: async () => { throw new Error("marker write failed"); },
    rm: async (...args) => calls.push(["rm", ...args]),
  };
  await assert.rejects(
    createOwnedRunDirectory(outputRoot, {
      fs,
      tokenFactory: () => "residue-token",
    }),
    (error) => {
      assert.equal(error.residuePath, residuePath);
      return true;
    }
  );
  assert.equal(calls.some(([name]) => name === "rm"), false);
});

test("owned cleanup rejects marker symlink swaps and root replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "chroma-relay-s4-replacement-"));
  const movedRoot = `${root}-moved`;
  const outside = await mkdtemp(join(tmpdir(), "chroma-relay-s4-marker-outside-"));
  const run = await createOwnedRunDirectory(root, { tokenFactory: () => "replacement-token" });
  const markerText = await readFile(run.markerPath, "utf8");
  const markerTarget = join(outside, "marker-target");
  await writeFile(markerTarget, "foreign\n");
  await rm(run.markerPath);
  await symlink(markerTarget, run.markerPath);
  await expectReject(removeOwnedRunDirectory(run), /marker/);
  await rm(run.markerPath);
  await writeFile(run.markerPath, markerText);

  await rename(root, movedRoot);
  await symlink(movedRoot, root);
  await expectReject(removeOwnedRunDirectory(run), /root|symlink/);

  await rm(root, { force: true });
  await rm(movedRoot, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

test("scratch children are marked, exclusive, and removable without removing the caller root", async () => {
  const root = await mkdtemp(join(tmpdir(), "chroma-relay-s4-scratch-"));
  const run = await createOwnedRunDirectory(root, { tokenFactory: () => "parent-token" });
  const scratch = await createOwnedScratchDirectory(run, { tokenFactory: () => "scratch-token" });
  const marker = JSON.parse(await readFile(scratch.markerPath, "utf8"));
  assert.equal(marker.root, await realpath(run.path));
  assert.equal(marker.child, await realpath(scratch.path));
  await removeOwnedRunDirectory(scratch);
  await assert.doesNotReject(() => readFile(run.markerPath, "utf8"));
  await removeOwnedRunDirectory(run);
  await rm(root, { recursive: true, force: true });
});

test("foreign, stale, fixed, and symlink-escaping roots are rejected before mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "chroma-relay-s4-"));
  await writeFile(join(root, ".chroma-relay-run.json"), JSON.stringify({ kind: "foreign" }));
  await expectReject(createOwnedRunDirectory(root), /foreign/);

  const stale = await mkdtemp(join(tmpdir(), "chroma-relay-stale-"));
  await writeFile(
    join(stale, ".chroma-relay-run.json"),
    JSON.stringify({ kind: "chroma-relay-run", schema: 999 })
  );
  await expectReject(createOwnedRunDirectory(stale), /stale/);

  const fixed = await mkdtemp(join(tmpdir(), "chroma-relay-fixed-"));
  await expectReject(createOwnedRunDirectory(fixed, { fixedRoots: [fixed] }), /fixed/);

  const outside = await mkdtemp(join(tmpdir(), "chroma-relay-outside-"));
  const parent = await mkdtemp(join(tmpdir(), "chroma-relay-parent-"));
  await symlink(outside, join(parent, "escape"));
  await expectReject(createOwnedRunDirectory(join(parent, "escape", "child")), /symlink/);
  await rm(root, { recursive: true, force: true });
  await rm(stale, { recursive: true, force: true });
  await rm(fixed, { recursive: true, force: true });
  await rm(parent, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

class FakeSocket {
  static instances = [];
  constructor({ closeMode = "event" } = {}) {
    this.listeners = new Map();
    this.sent = [];
    this.readyState = 0;
    this.closeMode = closeMode;
    this.onceOptions = [];
    this.closeCalls = 0;
    this.terminateCalls = 0;
    FakeSocket.instances.push(this);
  }
  addEventListener(name, fn, options) {
    const list = this.listeners.get(name) || [];
    list.push({ fn, once: options?.once === true });
    this.listeners.set(name, list);
    if (options?.once === true) this.onceOptions.push(name);
  }
  removeEventListener(name, fn) {
    this.listeners.set(name, (this.listeners.get(name) || []).filter((entry) => entry.fn !== fn));
  }
  listenerCount(name) { return (this.listeners.get(name) || []).length; }
  emit(name, value = {}) {
    const list = [...(this.listeners.get(name) || [])];
    for (const entry of list) {
      if (entry.once) this.removeEventListener(name, entry.fn);
      entry.fn(value);
    }
  }
  send(value) { this.sent.push(JSON.parse(value)); }
  close() {
    this.closeCalls += 1;
    if (this.closeMode === "event") {
      this.readyState = 3;
      this.emit("close", {});
    }
  }
  terminate() {
    this.terminateCalls += 1;
    this.readyState = 3;
    this.emit("close", {});
  }
}

const connectedClient = async (timeoutMs = 30) => {
  const client = new CdpClient("ws://fake", { WebSocket: FakeSocket, timeoutMs });
  const connecting = client.connect();
  const socket = FakeSocket.instances.at(-1);
  socket.readyState = 1;
  socket.emit("open", {});
  await connecting;
  return { client, socket };
};

test("CDP malformed, close/error, timeout, duplicate/late results, and cleanup settle pending calls", async () => {
  const { client, socket } = await connectedClient();
  const malformed = client.send("One");
  const second = client.send("Two");
  socket.emit("message", { data: "{" });
  await expectReject(malformed, /Malformed CDP message/);
  await expectReject(second, /Malformed CDP message/);
  assert.equal(client.pending.size, 0);

  const response = client.send("Three");
  const id = socket.sent.at(-1).id;
  socket.emit("message", { data: JSON.stringify({ id, result: { ok: true } }) });
  assert.deepEqual(await response, { ok: true });
  socket.emit("message", { data: JSON.stringify({ id, result: { late: true } }) });
  assert.equal(client.pending.size, 0);

  const errorPending = client.send("Error");
  socket.emit("error", {});
  await expectReject(errorPending, /socket error/);
  assert.equal(client.pending.size, 0);

  const closePending = client.send("Four");
  socket.emit("close", {});
  await expectReject(closePending, /closed/);
  assert.equal(client.pending.size, 0);

  const timeoutClient = await connectedClient(5);
  const timeout = timeoutClient.client.send("Timeout");
  await expectReject(timeout, /timed out/);
  assert.equal(timeoutClient.client.pending.size, 0);
  await timeoutClient.client.close();
});

test("CDP connect rejects exactly once and removes listeners when it closes or errors before open", async () => {
  for (const event of ["close", "error"]) {
    const client = new CdpClient("ws://fake", { WebSocket: FakeSocket, timeoutMs: 30 });
    const connecting = client.connect();
    const socket = FakeSocket.instances.at(-1);
    socket.emit(event, {});
    await assert.rejects(connecting, /Unable to connect|closed|error/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(socket.listenerCount("open"), 0);
    assert.equal(socket.listenerCount("close"), 0);
    assert.equal(socket.listenerCount("error"), 0);
    assert.equal(socket.listenerCount("message"), 0);
  }
});

test("CDP refuses an active ID before mutating pending state and ignores late responses", async () => {
  const { client, socket } = await connectedClient();
  const first = client.send("First");
  const activeId = socket.sent.at(-1).id;
  client.nextId = activeId;
  await assert.rejects(client.send("Duplicate"), /duplicate.*id/i);
  assert.equal(client.pending.size, 1);
  socket.emit("message", { data: JSON.stringify({ id: activeId, result: "first" }) });
  assert.equal(await first, "first");
  const second = client.send("Second");
  const secondId = socket.sent.at(-1).id;
  socket.emit("message", { data: JSON.stringify({ id: activeId, result: "late" }) });
  assert.equal(client.pending.size, 1);
  socket.emit("message", { data: JSON.stringify({ id: secondId, result: "second" }) });
  assert.equal(await second, "second");
  await client.close();
});

test("CDP close timeout/error rejects, terminates, removes listeners, and is idempotent", async () => {
  const timeoutConnected = await connectedClient();
  timeoutConnected.socket.closeMode = "silent";
  const pending = timeoutConnected.client.send("Pending");
  const close = timeoutConnected.client.close(5);
  assert.strictEqual(close, timeoutConnected.client.close(5));
  await assert.rejects(pending, /closed/);
  await assert.rejects(close, /timed out/);
  assert.equal(timeoutConnected.client.pending.size, 0);
  assert.equal(timeoutConnected.socket.terminateCalls, 1);
  assert.equal(timeoutConnected.socket.listenerCount("message"), 0);
  assert.equal(timeoutConnected.socket.listenerCount("close"), 0);
  assert.equal(timeoutConnected.socket.listenerCount("error"), 0);

  const errorConnected = await connectedClient();
  errorConnected.socket.closeMode = "silent";
  const errorClose = errorConnected.client.close(30);
  errorConnected.socket.emit("error", new Error("close boom"));
  await assert.rejects(errorClose, /close boom|failed during close/);
  assert.equal(errorConnected.client.pending.size, 0);
  assert.equal(errorConnected.socket.listenerCount("message"), 0);
  assert.equal(errorConnected.socket.listenerCount("close"), 0);
});

test("CDP clears every injected request and close timer on settlement", async () => {
  const activeTimers = new Set();
  const timerClient = new CdpClient("ws://fake", {
    WebSocket: FakeSocket,
    timeoutMs: 5,
    setTimeoutFn: (handler, milliseconds) => {
      const timer = setTimeout(() => {
        activeTimers.delete(timer);
        handler();
      }, milliseconds);
      activeTimers.add(timer);
      return timer;
    },
    clearTimeoutFn: (timer) => {
      activeTimers.delete(timer);
      clearTimeout(timer);
    },
  });
  const connecting = timerClient.connect();
  const socket = FakeSocket.instances.at(-1);
  socket.readyState = 1;
  socket.emit("open", {});
  await connecting;
  const request = timerClient.send("Settled");
  const requestId = socket.sent.at(-1).id;
  assert.equal(activeTimers.size, 1);
  socket.emit("message", { data: JSON.stringify({ id: requestId, result: true }) });
  assert.equal(await request, true);
  assert.equal(activeTimers.size, 0);
  const close = timerClient.close(30);
  assert.equal(activeTimers.size, 0);
  await close;
  assert.equal(activeTimers.size, 0);
});

test("owned runners do not recursively remove fixed scratch roots and await async close", async () => {
  for (const file of [
    "cep-native-gradient-collect-smoke.mjs",
    "cep-cdp.mjs",
    "cep-design-capture.mjs",
    "cep-persistence-smoke.mjs",
    "cep-palette-management-smoke.mjs",
  ]) {
    const source = await readFile(new URL(`../scripts/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /rm\([^\n]*\{\s*recursive:\s*true/);
    assert.doesNotMatch(source, /(?<!await\s)\bclient\.close\(\)/);
    if (file === "cep-design-capture.mjs") {
      assert.match(source, /const TEMPORARY_CONFIG_PARENT = "\/private\/tmp"/);
      assert.match(source, /createOwnedRunDirectory\(TEMPORARY_CONFIG_PARENT/);
      assert.match(source, /chroma-relay-design-/);
      assert.doesNotMatch(source, /createOwnedScratchDirectory\(parentRun\)/);
    } else {
      assert.match(source, /createOwnedScratchDirectory/);
    }
    assert.match(source, /removeOwnedRunDirectory/);
  }
});

test("all five runners are importable without invoking their CLI", async () => {
  for (const file of [
    "cep-native-gradient-collect-smoke.mjs",
    "cep-cdp.mjs",
    "cep-design-capture.mjs",
    "cep-persistence-smoke.mjs",
    "cep-palette-management-smoke.mjs",
  ]) {
    await assert.doesNotReject(import(`../scripts/${file}?s4=${Date.now()}-${file}`));
  }
});

test("design capture can target Settings without weakening the Main compositor gate", async () => {
  const source = await readFile(
    new URL("../scripts/cep-design-capture.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /allowed: \["output", "panel"\]/);
  assert.match(source, /options\.panel !== "main" && options\.panel !== "settings"/);
  assert.match(source, /const selectedPanels = options\.panel/);
  assert.match(source, /Main compositor is \$\{captureViewport\.width\}x\$\{captureViewport\.height\}/);
});

test("design capture lifecycle returns only after successful cleanup", async () => {
  const design = await import("../scripts/cep-design-capture.mjs?s4-lifecycle-success");
  const events = [];
  const result = await design.runDesignCaptureLifecycle({
    capture: async () => {
      events.push("capture");
      return { passed: true };
    },
    cleanupSteps: [
      { phase: "close", run: async () => events.push("close") },
      { phase: "scratch", run: async () => events.push("scratch") },
    ],
    writeFailure: async () => assert.fail("successful capture must not write failure evidence"),
  });
  assert.deepEqual(events, ["capture", "close", "scratch"]);
  assert.deepEqual(result, { passed: true });
});

test("design capture lifecycle preserves primary failure and reports cleanup failures", async () => {
  const design = await import("../scripts/cep-design-capture.mjs?s4-lifecycle-primary");
  const primary = new Error("capture failed");
  const failureWrites = [];
  await assert.rejects(
    design.runDesignCaptureLifecycle({
      capture: async () => { throw primary; },
      cleanupSteps: [
        { phase: "close", run: async () => { throw new Error("close failed"); } },
        { phase: "scratch", run: async () => undefined },
      ],
      writeFailure: async (failure) => failureWrites.push(failure),
    }),
    (error) => error === primary
  );
  assert.equal(failureWrites.length, 1);
  assert.equal(failureWrites[0].primaryError, primary);
  assert.deepEqual(failureWrites[0].cleanupErrors.map((entry) => entry.phase), ["close"]);
});

test("design capture lifecycle fails when cleanup alone fails", async () => {
  const design = await import("../scripts/cep-design-capture.mjs?s4-lifecycle-cleanup");
  const failureWrites = [];
  await assert.rejects(
    design.runDesignCaptureLifecycle({
      capture: async () => ({ passed: true }),
      cleanupSteps: [
        { phase: "close", run: async () => { throw new Error("close failed"); } },
      ],
      writeFailure: async (failure) => failureWrites.push(failure),
    }),
    (error) => error instanceof AggregateError && /cleanup failed/i.test(error.message)
  );
  assert.equal(failureWrites.length, 1);
  assert.equal(failureWrites[0].primaryError, null);
  assert.equal(failureWrites[0].cleanupErrors[0].phase, "close");
});

test("palette lifecycle closes acquired clients and scratch after a partial second connect", async () => {
  const palette = await import("../scripts/cep-palette-management-smoke.mjs?s4-lifecycle-partial");
  const closed = [];
  const failureWrites = [];
  const primary = new Error("settings connect failed");
  const makeClient = (page) => ({ page, close: async () => closed.push(page) });
  await assert.rejects(
    palette.runPaletteManagementLifecycle({
      acquireClient: async (page, register) => {
        const client = makeClient(page);
        register(client);
        if (page === "settings") throw primary;
        return client;
      },
      execute: async () => assert.fail("the work phase must not run after partial connect"),
      cleanupClient: async (client) => client.close(),
      cleanupScratch: async () => closed.push("scratch"),
      writeFailure: async (failure) => failureWrites.push(failure),
    }),
    (error) => error === primary
  );
  assert.deepEqual(closed, ["settings", "main", "scratch"]);
  assert.equal(failureWrites[0].primaryError, primary);
});

test("palette lifecycle preserves nested cleanup diagnostics and primary precedence when evidence writing fails", async () => {
  const palette = await import("../scripts/cep-palette-management-smoke.mjs?s4-lifecycle-structured-failure");
  const primary = new Error("settings connect failed");
  const nested = new AggregateError(
    [new Error("settings close failed"), new AggregateError([new Error("deep close failed")], "nested close")],
    "settings cleanup"
  );
  const failureWrites = [];
  const makeClient = () => ({ close: async () => undefined });

  await assert.rejects(
    palette.runPaletteManagementLifecycle({
      acquireClient: async (page, register) => {
        const client = makeClient();
        register(client);
        if (page === "settings") throw primary;
        return client;
      },
      execute: async () => assert.fail("the work phase must not run after partial connect"),
      cleanupClient: async (client) => {
        if (client.page === "settings") throw nested;
      },
      cleanupScratch: async () => { throw new Error("scratch cleanup failed"); },
      writeFailure: async (failure) => {
        failureWrites.push(failure);
        throw new Error("failure writer failed");
      },
    }),
    (error) => error === primary
  );

  assert.equal(failureWrites.length, 1);
  const failure = failureWrites[0];
  assert.deepEqual(failure.clients.map((client) => client.page), ["main", "settings"]);
  assert.deepEqual(failure.cleanupErrors.map((entry) => entry.phase), [
    "close:settings",
    "scratch",
    "failure-evidence",
  ]);
  assert.equal(failure.cleanupErrors[0].error.name, "AggregateError");
  assert.equal(failure.cleanupErrors[0].error.errors[0].message, "settings close failed");
  assert.equal(failure.cleanupErrors[0].error.errors[1].errors[0].message, "deep close failed");
  assert.equal(failure.cleanupErrors[2].error.message, "failure writer failed");
});

test("palette lifecycle fails clearly when cleanup and failure evidence both fail without a primary", async () => {
  const palette = await import("../scripts/cep-palette-management-smoke.mjs?s4-lifecycle-cleanup-evidence");
  const failureWrites = [];
  await assert.rejects(
    palette.runPaletteManagementLifecycle({
      acquireClient: async (page, register) => {
        const client = { close: async () => undefined };
        register(client);
        return client;
      },
      execute: async () => ({ passed: true }),
      cleanupClient: async () => {
        throw new AggregateError([new Error("close failed")], "cleanup");
      },
      cleanupScratch: async () => { throw new Error("scratch failed"); },
      writeFailure: async (failure) => {
        failureWrites.push(failure);
        throw new Error("failure writer failed");
      },
    }),
    (error) =>
      error instanceof AggregateError &&
      /cleanup failed/i.test(error.message) &&
      error.errors.some((cause) => cause.message === "failure writer failed")
  );
  assert.deepEqual(failureWrites[0].cleanupErrors.map((entry) => entry.phase), [
    "close:settings",
    "close:main",
    "scratch",
    "failure-evidence",
  ]);
});

test("native-gradient cleanup requires panel restoration and retains scratch evidence", async () => {
  const gradient = await import("../scripts/cep-native-gradient-collect-smoke.mjs?s4-lifecycle-panel");
  const valid = gradient.assessNativeGradientCleanup({
    report: { passed: true },
    failure: null,
    setup: { ok: true },
    cleanup: {
      panel: { restored: true },
      project: { restored: true },
      temp: { removed: true },
    },
  });
  assert.deepEqual(valid, {
    report: { passed: true },
    failure: null,
    retainScratch: false,
  });

  const primary = new Error("collection failed");
  const unrestored = gradient.assessNativeGradientCleanup({
    report: { passed: true },
    failure: primary,
    setup: { ok: true },
    cleanup: {
      panel: { restored: false, error: "reload failed" },
      project: { restored: true },
      temp: { removed: false, reason: "panel-state-unrestored" },
    },
  });
  assert.equal(unrestored.report, null);
  assert.equal(unrestored.failure, primary);
  assert.equal(unrestored.retainScratch, true);

  const cleanupOnly = gradient.assessNativeGradientCleanup({
    report: { passed: true },
    failure: null,
    setup: { ok: true },
    cleanup: {
      panel: { restored: false, error: "reload failed" },
      project: { restored: true },
      temp: { removed: false, reason: "panel-state-unrestored" },
    },
  });
  assert.equal(cleanupOnly.report, null);
  assert.match(cleanupOnly.failure.message, /cleanup failed/i);
  assert.equal(cleanupOnly.retainScratch, true);
});

test("native-gradient cleanup retains scratch when host setup completion is unknown", async () => {
  const gradient = await import("../scripts/cep-native-gradient-collect-smoke.mjs?s4-lifecycle-unknown-setup");
  const primary = new Error("app.open completion unknown");
  const unknown = gradient.assessNativeGradientCleanup({
    report: { passed: true },
    failure: primary,
    setup: null,
    setupAttempted: true,
    cleanup: {
      panel: { restored: false, error: "reload failed" },
      project: { restored: false, error: "project restore failed" },
      temp: { removed: false, reason: "host-state-unknown" },
    },
  });
  assert.equal(unknown.report, null);
  assert.equal(unknown.failure, primary);
  assert.equal(unknown.retainScratch, true);

  const unknownCleanupOnly = gradient.assessNativeGradientCleanup({
    report: null,
    failure: null,
    setup: null,
    setupAttempted: true,
    cleanup: {
      panel: { restored: false },
      project: { restored: false },
      temp: { removed: false },
    },
  });
  assert.equal(unknownCleanupOnly.report, null);
  assert.match(unknownCleanupOnly.failure.message, /cleanup failed/i);
  assert.equal(unknownCleanupOnly.retainScratch, true);

  const preMutation = gradient.assessNativeGradientCleanup({
    report: { passed: true },
    failure: null,
    setup: null,
    setupAttempted: false,
    cleanup: {
      panel: { restored: true },
      project: { restored: true },
      temp: { removed: true },
    },
  });
  assert.deepEqual(preMutation, {
    report: { passed: true },
    failure: null,
    retainScratch: false,
  });
});
