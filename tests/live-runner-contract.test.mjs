import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, resolve, sep, win32 } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { CdpClient } from "../scripts/lib/cdp-client.mjs";
import {
  RunnerPolicyError,
  assertCanonicalRuntimeUrl,
  canonicalizeTemporaryDirectoryForTest,
  createOwnedRunDirectory,
  createOwnedScratchDirectory,
  createOwnedTemporaryConfigDirectory,
  guardClientEvaluations,
  isDirectCliInvocation,
  parseRunnerArgs,
  rejectSymlinkComponentsForTest,
  removeOwnedRunDirectory,
  restoreConfigRootWithReadback,
  selectCanonicalCdpTarget,
  validateRunnerOutputRoot,
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
    ["--output=C:\\tmp\\out"],
    ["--output=C:tmp\\out"],
    ["--output=\\rooted"],
    ["--output=\\\\server\\share"],
    ["--output=."],
    ["--output=./."],
    ["--output=.//"],
    ["--output=.\\."],
    ["--output=../out"],
    ["--output=a/../../out"],
    ["--output=a\\..\\out"],
    ["--output=.. /outside"],
    ["--output=.../outside"],
    ["--output=foo/.. /outside"],
    ["--output=foo./outside"],
    ["--output=CON"],
    ["--output=nul.txt"],
    ["--output=reports:stream"],
    ["--output=bad?name"],
  ]) {
    assert.throws(() => parseRunnerArgs(argv, { allowed: ["output"] }), RunnerPolicyError);
  }
  assert.deepEqual(
    parseRunnerArgs(["--output=reports", "--main-id=main"], {
      allowed: ["output", "main-id"],
    }),
    { output: "reports", "main-id": "main" }
  );
  assert.deepEqual(parseRunnerArgs(["--output=./reports"], { allowed: ["output"] }), {
    output: "./reports",
  });
  assert.deepEqual(parseRunnerArgs(["--output=.\\reports"], { allowed: ["output"] }), {
    output: ".\\reports",
  });
  assert.deepEqual(parseRunnerArgs(["--output= reports "], { allowed: ["output"] }), {
    output: "reports",
  });
});

test("direct CLI detection canonicalizes symlinked entry paths", () => {
  const modulePath = resolve("scripts/cep-functional-smoke.mjs");
  const moduleUrl = pathToFileURL(modulePath).href;
  assert.equal(
    isDirectCliInvocation(moduleUrl, "/alias/scripts/cep-functional-smoke.mjs", {
      realpathFn: (path) => path.startsWith("/alias/")
        ? path.replace("/alias", process.cwd())
        : path,
    }),
    true
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

test("runner output validation rejects direct and nested symlink escapes before mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "chroma-relay-output-validation-"));
  const repo = join(root, "repo");
  const outside = join(root, "outside");
  await mkdir(repo);
  await mkdir(outside);
  await symlink(outside, join(repo, "escape"));

  try {
    await expectReject(
      validateRunnerOutputRoot("escape", { cwd: repo }),
      /escapes through a symlink|symlink/
    );
    await expectReject(
      validateRunnerOutputRoot("escape/missing/nested", { cwd: repo }),
      /symlink/
    );
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("canonical CDP selection rejects foreign same-suffix pages before client mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "chroma-relay-canonical-cdp-"));
  const canonical = join(root, "repo", "dist", "cep", "main", "index.html");
  const foreign = join(root, "foreign", "main", "index.html");
  const alias = join(root, "installed", "main", "index.html");
  const target = (path, suffix = "") => ({
    type: "page",
    url: `${pathToFileURL(path).href}${suffix}`,
    webSocketDebuggerUrl: "ws://canonical",
  });

  try {
    await mkdir(dirname(canonical), { recursive: true });
    await mkdir(dirname(foreign), { recursive: true });
    await mkdir(dirname(alias), { recursive: true });
    await writeFile(canonical, "canonical\n");
    await writeFile(foreign, "foreign\n");
    await rm(alias, { force: true });
    await symlink(canonical, alias);

    const canonicalTarget = target(canonical);
    const aliasTarget = target(alias);
    assert.equal(
      await selectCanonicalCdpTarget([canonicalTarget], canonical, { label: "Main" }),
      canonicalTarget
    );
    assert.equal(
      await selectCanonicalCdpTarget([aliasTarget], canonical, { label: "Main" }),
      aliasTarget
    );
    await assert.doesNotReject(
      assertCanonicalRuntimeUrl(aliasTarget.url, canonical, { label: "connected Main" })
    );
    await assert.rejects(
      assertCanonicalRuntimeUrl(target(foreign).url, canonical, { label: "connected Main" }),
      /does not resolve to the canonical runtime/
    );
    await assert.rejects(
      assertCanonicalRuntimeUrl(target(canonical, "?debug=1").url, canonical),
      /does not resolve to the canonical runtime/
    );
    await assert.rejects(
      selectCanonicalCdpTarget([target(foreign)], canonical, { label: "Main" }),
      /exactly one canonical target; found 0/
    );
    await assert.rejects(
      selectCanonicalCdpTarget([target(canonical, "?debug=1")], canonical, { label: "Main" }),
      /found 0/
    );
    await assert.rejects(
      selectCanonicalCdpTarget([target(canonical, "#")], canonical, { label: "Main" }),
      /found 0/
    );
    await assert.rejects(
      selectCanonicalCdpTarget([canonicalTarget, aliasTarget], canonical, { label: "Main" }),
      /found 2/
    );
    await assert.rejects(
      selectCanonicalCdpTarget(
        [{ ...canonicalTarget, webSocketDebuggerUrl: "" }],
        canonical,
        { label: "Main" }
      ),
      /no WebSocket debugger URL/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("config restoration requires settled authoritative readback", async () => {
  const calls = [];
  let renderedRoot = "/scratch";
  let pendingRoot = renderedRoot;
  const setRoot = async (root) => {
    calls.push(["set", root]);
    pendingRoot = root;
  };
  const settle = async () => {
    calls.push(["settle"]);
    renderedRoot = pendingRoot;
  };
  const readRoot = async () => {
    calls.push(["read", renderedRoot]);
    return renderedRoot;
  };
  assert.equal(
    await restoreConfigRootWithReadback({
      expectedRoot: null,
      setRoot,
      settle,
      readRoot,
      label: "test config",
    }),
    null
  );
  assert.deepEqual(calls, [["set", null], ["settle"], ["read", null]]);
  await assert.rejects(
    restoreConfigRootWithReadback({
      expectedRoot: "/baseline",
      setRoot: async () => undefined,
      settle: async () => undefined,
      readRoot: async () => "/scratch",
      label: "drifted config",
    }),
    /restoration readback mismatch/
  );
});

test("evaluation guard permanently quarantines a client after unknown completion", async () => {
  let calls = 0;
  const client = {
    send: async () => true,
    evaluate: async () => {
      calls += 1;
      if (calls === 2) throw new Error("request completion unknown");
      return calls;
    },
  };
  const guard = guardClientEvaluations(client, "contract client");
  assert.equal(await client.evaluate("first"), 1);
  assert.equal(guard.isCompletionKnown(), true);
  await assert.rejects(client.evaluate("second"), /completion unknown/);
  assert.equal(guard.status(), "unknown");
  await assert.rejects(client.evaluate("third"), /reentry refused/);
  assert.equal(calls, 2);
});

test("evaluation guard supports semantic quarantine after a renderer operation outlives CDP", async () => {
  const client = {
    evaluate: async () => true,
    send: async () => true,
  };
  const guard = guardClientEvaluations(client, "semantic fixture");
  assert.equal(await client.evaluate("1 + 1"), true);
  guard.quarantine();
  assert.equal(guard.isCompletionKnown(), false);
  assert.equal(guard.status(), "unknown");
  await assert.rejects(client.send("Page.reload"), /reentry refused while completion is unknown/);
});

test("operation guard quarantines direct CDP sends and refuses later restoration", async () => {
  let sendCalls = 0;
  const client = {
    send: async () => {
      sendCalls += 1;
      throw new Error("Page.reload timed out after dispatch");
    },
    evaluate: async () => true,
  };
  const guard = guardClientEvaluations(client, "send contract");
  await assert.rejects(client.send("Page.reload"), /timed out after dispatch/);
  assert.equal(guard.status(), "unknown");
  await assert.rejects(client.evaluate("restore config"), /reentry refused/);
  assert.equal(sendCalls, 1);
});

test("operation guard rejects a concurrent top-level send without breaking nested evaluation transport", async () => {
  let releaseEvaluation;
  const evaluationResult = new Promise((resolve) => { releaseEvaluation = resolve; });
  let sends = 0;
  const client = {
    send: async () => { sends += 1; return true; },
    evaluate: async () => evaluationResult,
  };
  const guard = guardClientEvaluations(client, "concurrency contract");
  const pendingEvaluation = client.evaluate("hold");
  await assert.rejects(client.send("Page.reload"), /reentry refused while completion is pending/);
  assert.equal(sends, 0);
  releaseEvaluation("done");
  assert.equal(await pendingEvaluation, "done");
  assert.equal(guard.status(), "ready");
  assert.equal(await client.send("Page.captureScreenshot"), true);
  assert.equal(sends, 1);

  const cdp = Object.create(CdpClient.prototype);
  const calls = [];
  cdp.sendForEvaluate = async (...args) => {
    calls.push(args);
    return { result: { value: 42 } };
  };
  assert.equal(await cdp.evaluate("6 * 7"), 42);
  assert.equal(calls[0][0], "Runtime.evaluate");
});

test("formal and diagnostic runners quarantine every post-enable CDP operation", async () => {
  for (const script of [
    "run-live-ae-tests.mjs",
    "diagnose-ae-selection-semantics.mjs",
    "diagnose-ae23-selection-restore.mjs",
  ]) {
    const source = await readFile(resolve("scripts", script), "utf8");
    assert.match(source, /guardClientEvaluations/);
    assert.match(source, /operationGuard\?\.isCompletionKnown\(\) !== false/);
  }
});

test("formal and functional runners quarantine semantic host-action timeouts", async () => {
  const [formal, functional] = await Promise.all([
    readFile(resolve("scripts/run-live-ae-tests.mjs"), "utf8"),
    readFile(resolve("scripts/cep-functional-smoke.mjs"), "utf8"),
  ]);
  assert.match(formal, /let hostActionCompletionKnown = true/);
  assert.equal(
    (formal.match(/hostActionCompletionKnown = false;\s*await triggerGradientAction\(client\)/g) || []).length,
    2
  );
  assert.equal(
    (formal.match(/hostActionCompletionKnown = true;\s*const (?:rendererReport|failureReport)/g) || []).length,
    2
  );
  assert.equal(
    (formal.match(/operationGuard\?\.isCompletionKnown\(\) !== false &&\s*hostActionCompletionKnown/g) || []).length,
    3
  );
  assert.match(formal, /productionRestoreRequired && finalizationCompletionKnown\(\)/);
  assert.match(formal, /completion became unknown before production rebuild; canonical build left untouched/);
  assert.match(formal, /host action completion is unknown; compensating cleanup refused/);
  assert.match(formal, /const waitForIdle = async \(client, operationGuard\)/);
  assert.match(formal, /operationGuard\?\.quarantine\(\);\s*fail\("Native-gradient application did not become idle/);
  assert.match(formal, /waitForIdle\(client, operationGuard\)/);
  assert.match(formal, /const waitForRuntime = async \(client, expectedUrl, expectedDebug, operationGuard\)/);
  assert.match(formal, /catch \(error\) \{\s*operationGuard\?\.quarantine\(\);\s*throw error;/);
  assert.match(formal, /FINALIZATION_DIAGNOSTICS/);
  assert.match(formal, /throwable\.cleanupErrors = \[\.\.\.existing, \.\.\.cleanupErrors\]/);
  assert.match(functional, /const dispatchHostActionAndWait = async/);
  assert.match(
    functional,
    /imageSelectionHostStateKnown = false;\s*const accepted = await client\.evaluate[^]*const state = await waitForHostIdle\(client, runtimeEvaluationGuard\);\s*imageSelectionHostStateKnown = true;/
  );
  assert.match(functional, /evaluationGuard\?\.quarantine\(\)/);
  assert.match(functional, /waitForStableDebug\(client, runtimeEvaluationGuard\)/);
});

test("every maintained reload readiness wait quarantines semantic timeout", async () => {
  const sources = await Promise.all(
    [
      "cep-cdp.mjs",
      "cep-design-capture.mjs",
      "cep-palette-management-smoke.mjs",
      "cep-native-gradient-collect-smoke.mjs",
    ].map((script) => readFile(resolve("scripts", script), "utf8")),
  );
  for (const source of sources) {
    assert.match(source, /completion quarantined/);
    assert.match(source, /(?:evaluationGuard|operationGuard)\?\.quarantine\(\)/);
  }
  assert.match(sources[0], /waitForComplete\(client, evaluationGuards\.get\(panel\.page\)\)/);
  assert.match(sources[1], /waitForComplete\(client, evaluationGuard\)/);
  assert.match(sources[2], /waitForDebug\(client, client\.evaluationGuard\)/);
  assert.match(sources[3], /waitForDebug\(client, operationGuard\)/);
});

test("absolute roots reject first-component POSIX symlinks and Windows junctions", async () => {
  for (const { pathApi, root, redirect } of [
    { pathApi: posix, root: "/redirect/owned", redirect: "/redirect" },
    { pathApi: win32, root: "C:\\redirect\\owned", redirect: "C:\\redirect" },
  ]) {
    const fs = {
      lstat: async (path) => {
        if (path === redirect) return { isSymbolicLink: () => true };
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
      realpath: async (path) => path,
    };
    await expectReject(
      rejectSymlinkComponentsForTest(root, fs, pathApi),
      /symlink/
    );
  }
});

test("absolute roots allow only verified macOS system temp aliases", async () => {
  const fs = {
    lstat: async (path) => {
      if (path === "/tmp") return { isSymbolicLink: () => true };
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    realpath: async (path) => path === "/tmp" ? "/private/tmp" : path,
  };
  await assert.doesNotReject(
    rejectSymlinkComponentsForTest("/tmp/chroma-relay", fs, posix)
  );
  await expectReject(
    rejectSymlinkComponentsForTest("/tmp/chroma-relay", {
      ...fs,
      realpath: async () => "/attacker-controlled-temp",
    }, posix),
    /symlink/
  );
});

test("temporary allocation canonicalizes only verified exact macOS temp aliases", async () => {
  const trustedFs = {
    lstat: async () => ({ isSymbolicLink: () => true }),
    realpath: async (path) => path === "/tmp" ? "/private/tmp" : path,
  };
  assert.equal(
    await canonicalizeTemporaryDirectoryForTest("/tmp", trustedFs, posix),
    "/private/tmp"
  );
  assert.equal(
    await canonicalizeTemporaryDirectoryForTest(
      "/private/tmp/chroma-relay-parent",
      trustedFs,
      posix
    ),
    "/private/tmp/chroma-relay-parent"
  );
  await expectReject(
    canonicalizeTemporaryDirectoryForTest(
      "/tmp",
      {
        ...trustedFs,
        realpath: async () => "/attacker-controlled-temp",
      },
      posix
    ),
    /symlink/
  );
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

test("owned cleanup gives transient Windows locks bounded native retries", async () => {
  const root = await mkdtemp(join(tmpdir(), "chroma-relay-s4-rm-retry-"));
  const run = await createOwnedRunDirectory(root, { tokenFactory: () => "rm-retry-token" });
  const calls = [];
  await removeOwnedRunDirectory(run, {
    fs: {
      lstat,
      realpath,
      readFile,
      rm: async (path, options) => {
        calls.push({ path, options });
        return rm(path, options);
      },
    },
  });
  assert.deepEqual(calls, [
    {
      path: run.path,
      options: { recursive: true, force: false, maxRetries: 10, retryDelay: 100 },
    },
  ]);
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
    "cep-functional-smoke.mjs",
    "cep-persistence-smoke.mjs",
    "cep-palette-management-smoke.mjs",
  ]) {
    const source = await readFile(new URL(`../scripts/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /rm\([^\n]*\{\s*recursive:\s*true/);
    assert.doesNotMatch(source, /(?<!await\s)\bclient\.close\(\)/);
    if (file === "cep-design-capture.mjs") {
      assert.match(source, /tmpdir\(\)/);
      assert.match(source, /resolveTemporaryConfigParent/);
      assert.match(source, /createOwnedRunDirectory\(temporaryConfigParent/);
      assert.doesNotMatch(source, /"\/private\/tmp"/);
      assert.match(source, /chroma-relay-design-/);
      assert.doesNotMatch(source, /createOwnedScratchDirectory\(parentRun\)/);
    } else {
      assert.match(source, /createOwnedTemporaryConfigDirectory/);
      assert.doesNotMatch(source, /createOwnedScratchDirectory\(parentRun\)/);
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

test("design capture canonicalizes an OS-provided temporary directory", async () => {
  const design = await import("../scripts/cep-design-capture.mjs?s4-portable-temp");
  const windowsTemp = "C:\\Users\\runner\\AppData\\Local\\Temp";
  const canonical = "C:\\Users\\runner\\AppData\\Local\\Temp\\canonical";
  assert.equal(
    await design.resolveTemporaryConfigParent({
      temporaryDirectory: windowsTemp,
      fs: { realpath: async (path) => path === windowsTemp ? canonical : path },
    }),
    canonical
  );
});

test("debug config roots accept direct children of canonical macOS temp only", async () => {
  const { normalizeTemporaryConfigRoot } = await import("../src/js/shared/debug-api.ts");
  const root = "/private/var/folders/qj/session-hash/T/chroma-relay-design-main-run";
  assert.equal(normalizeTemporaryConfigRoot(root), root);
  assert.throws(
    () => normalizeTemporaryConfigRoot(
      "/private/var/folders/qj/session-hash/T/nested/chroma-relay-design-main-run",
    ),
    /supported macOS or Windows temp directory/,
  );
  for (const traversal of [
    "/private/var/folders/../../T/chroma-relay-design-main-run",
    "/private/var/folders/qj/./T/chroma-relay-design-main-run",
  ]) {
    assert.throws(
      () => normalizeTemporaryConfigRoot(traversal),
      /supported macOS or Windows temp directory/,
    );
  }
});

test("owned temporary config directories are direct chroma-relay children of the OS temp root", async () => {
  const run = await createOwnedTemporaryConfigDirectory();
  try {
    const canonicalRoot = await realpath(tmpdir());
    const canonicalChild = await realpath(run.path);
    assert.equal(dirname(canonicalChild), canonicalRoot);
    assert.match(canonicalChild.split(sep).at(-1), /^chroma-relay-/);
    const { normalizeTemporaryConfigRoot } = await import("../src/js/shared/debug-api.ts");
    assert.equal(normalizeTemporaryConfigRoot(canonicalChild), canonicalChild);
  } finally {
    await removeOwnedRunDirectory(run);
  }
});

test("CDP selectors normalize Windows paths and inject flyout IDs into browser source", async () => {
  const { createSettingsFlyoutProbeSource, pathMatchesPageSuffix } = await import(
    "../scripts/cep-cdp.mjs?s4-windows-targets"
  );
  assert.equal(
    pathMatchesPageSuffix("C:\\Build\\dist\\cep\\main\\index.html", "/main/index.html"),
    true,
  );
  assert.equal(
    pathMatchesPageSuffix("C:\\Build\\dist\\cep\\settings\\index.html", "/main/index.html"),
    false,
  );
  const source = createSettingsFlyoutProbeSource("com.example.settings");
  assert.match(source, /extensionId:\s*"com\.example\.settings"/);
  assert.doesNotMatch(source, /contract\./);
});

test("functional smoke reads current palette documents and wrapped color-selection results", async () => {
  const functional = await import("../scripts/cep-functional-smoke.mjs?s4-current-contracts");
  const colors = [{ id: "current", rgba: [1, 0, 0, 1] }];
  assert.equal(
    functional.activePaletteItems({
      activePaletteId: "active",
      palettes: [
        { id: "other", colors: [] },
        { id: "active", colors },
      ],
    }),
    colors,
  );
  assert.deepEqual(functional.activePaletteItems({ colors }), colors);
  const selection = { status: "ok", colors: [[1, 0, 0, 1]] };
  assert.equal(functional.colorSelectionResult({ selection: { colors: selection }, gradients: [] }), selection);
  assert.equal(functional.colorSelectionResult(selection), selection);

  const source = await readFile(
    new URL("../scripts/cep-functional-smoke.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /data-testid=remove-[a-z]/);
  assert.doesNotMatch(source, /new CDPClient\(/);
  assert.match(source, /new CdpClient\(/);
  assert.match(source, /new MouseEvent\("click", \{ altKey: true/);
  assert.match(source, /key: "Enter"[\s\S]*altKey: true/);
  assert.match(source, /mode === "image-selection" \|\| mode === "image"/);
  assert.match(source, /requires an empty clean unsaved project/);
  assert.match(source, /evalImageHost\(importSelectedImageSource\(fixture\)\)/);
  assert.doesNotMatch(source, /evalImageHost\(removeProjectItemSource\(imported\.id\)\)/);
  assert.match(source, /app\.project\.save\(archive\)/);
  assert.match(source, /var closed = app\.project\.close\(CloseOptions\.SAVE_CHANGES\)/);
  assert.match(source, /if \(closed !== true\)/);
  assert.match(source, /__CHROMA_FUNCTIONAL_PROJECT__ !== app\.project/);
  assert.match(source, /foreign-project-claim-present/);
  assert.match(source, /cleanupImageSelectionFixturesSource\(\s*runId,\s*imageSelectionOwnedItems,\s*imageSelectionOwnedTopology/);
  assert.match(source, /deferredToProjectArchive: true/);
  assert.match(source, /imageSelectionCleanupRequired && !imageSelectionProjectResetRequired/);
  assert.doesNotMatch(source, /\n\s*imageSelectionCleanupRequired = false;/);
  assert.match(source, /owned-item-topology-mismatch/);
  assert.match(source, /captureNewOwnedTopology/);
  assert.match(source, /snapshotProperty\(property\.property\(childIndex\)\)/);
  assert.match(source, /item\.id === owned\[ownedIndex\]\.id/);
  assert.doesNotMatch(source, /owned\[item\.name\]/);
  assert.match(source, /fixture-setup-failed/);
  assert.doesNotMatch(source, /_compCleanupError|_itemCleanupError/);
  assert.doesNotMatch(source, /try \{ if \(imported\) imported\.remove\(\); \}/);
  assert.match(source, /residualItems: residualItems/);
  assert.match(source, /recordResidualItems\(colorFixture\)/);
  assert.match(source, /recordResidualItems\(layerFixture\)/);
  assert.match(source, /imageSelectionHostStateKnown = false;\s*const result = await evalHost/);
  assert.match(
    source,
    /configMutationAttempted = true;\s*imageSelectionHostStateKnown = false;[^]*temporaryIdentity\.configRoot !== temporaryRoot[^]*imageSelectionHostStateKnown = true;/
  );
  assert.match(source, /runtimeEvaluationGuard = guardClientEvaluations\(client, "functional smoke Main"\)/);
  assert.match(source, /imageSelectionHostStateKnown = false;\s*const accepted = await client\.evaluate/);
  assert.match(source, /const state = await waitForHostIdle\(client, runtimeEvaluationGuard\);\s*imageSelectionHostStateKnown = true/);
  assert.match(source, /waitForMutationRevision\(client, 1, runtimeEvaluationGuard\)/);
  assert.match(source, /evaluationGuard\?\.quarantine\(\)/);
  assert.match(source, /const applyAction = await dispatchHostActionAndWait/);
  assert.match(source, /const collectionAction = await dispatchHostActionAndWait/);
  assert.match(source, /!imageSelectionHostStateKnown \|\| !runtimeEvaluationCompletionKnown\(\)/);
  assert.doesNotMatch(source, /if \(imported\?\.id && imageSelectionHostStateKnown/);
  assert.doesNotMatch(source, /imageOperationError/);
  assert.match(source, /host completion is unknown; project reset refused/);
  assert.doesNotMatch(source, /if \(imageSelectionProjectResetError\) throw imageSelectionProjectResetError/);
  assert.match(source, /finalizeFunctionalSmoke\(\{/);
  const setupSource = await readFile(
    new URL("../scripts/ae-i07-i08-setup.jsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(setupSource, /comp\.remove\(\)/);
  const paletteManagementSource = await readFile(
    new URL("../scripts/cep-palette-management-smoke.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    paletteManagementSource,
    /for \(const client of clients\) client\.evaluationGuard\?\.quarantine\(\)/,
  );
  assert.match(
    paletteManagementSource,
    /const waitFor = async \(predicate, label, evaluationGuard\)[^]*evaluationGuard\?\.quarantine\(\)/,
  );
  assert.match(
    paletteManagementSource,
    /"export file",\s*settings\.evaluationGuard/,
  );
});

test("functional image cleanup cannot remove an ID-matching item from a foreign project", async () => {
  const functional = await import("../scripts/cep-functional-smoke.mjs?foreign-image-project");
  const ownedProject = {};
  let removed = false;
  const foreignProject = {
    numItems: 1,
    item: () => ({ id: 37, remove: () => { removed = true; } }),
  };
  const dollar = {
    global: {
      __CHROMA_FUNCTIONAL_PROJECT_OWNER__: "run-token",
      __CHROMA_FUNCTIONAL_PROJECT__: ownedProject,
    },
  };
  const source = functional.guardImageSelectionProjectSource(
    "run-token",
    functional.removeProjectItemSource(37)
  );
  const raw = Function("$", "app", `return ${source}`)(dollar, { project: foreignProject });
  assert.deepEqual(JSON.parse(raw), {
    ok: false,
    reason: "image-selection-project-owner-mismatch",
  });
  assert.equal(removed, false);
});

test("functional smoke finalization withholds success and continues after restoration failures", async () => {
  const functional = await import("../scripts/cep-functional-smoke.mjs?s4-finalization-cleanup");
  const events = [];
  const failureWrites = [];

  await assert.rejects(
    functional.finalizeFunctionalSmoke({
      cleanupSteps: [
        {
          phase: "image-selection-project-reset",
          run: async () => {
            events.push("reset");
            throw new Error("reset failed");
          },
        },
        {
          phase: "cdp-close",
          run: async () => {
            events.push("close");
            throw new Error("close failed");
          },
        },
        { phase: "temporary-directory", run: async () => events.push("temporary-directory") },
      ],
      publishSuccess: async () => assert.fail("cleanup failure must not publish success"),
      writeFailure: async (failure) => {
        events.push("write-failure");
        failureWrites.push(failure);
      },
    }),
    (error) => error instanceof AggregateError && /cleanup failed/i.test(error.message)
  );

  assert.deepEqual(events, [
    "reset",
    "close",
    "temporary-directory",
    "write-failure",
  ]);
  assert.deepEqual(
    failureWrites[0].cleanupErrors.map(({ phase }) => phase),
    ["image-selection-project-reset", "cdp-close"]
  );
});

test("functional smoke finalization preserves the primary error with cleanup diagnostics", async () => {
  const functional = await import("../scripts/cep-functional-smoke.mjs?s4-finalization-primary");
  const primary = new Error("body failed");
  const failureWrites = [];

  await assert.rejects(
    functional.finalizeFunctionalSmoke({
      primaryError: primary,
      cleanupSteps: [
        { phase: "cdp-close", run: async () => { throw new Error("close failed"); } },
        { phase: "temporary-directory", run: async () => undefined },
      ],
      publishSuccess: async () => assert.fail("primary failure must not publish success"),
      writeFailure: async (failure) => failureWrites.push(failure),
    }),
    (error) => error === primary
  );

  assert.equal(failureWrites[0].primaryError, primary);
  assert.deepEqual(failureWrites[0].cleanupErrors.map(({ phase }) => phase), ["cdp-close"]);

  await assert.rejects(
    functional.finalizeFunctionalSmoke({
      primaryError: primary,
      cleanupSteps: [],
      publishSuccess: async () => assert.fail("primary failure must not publish success"),
      writeFailure: async () => { throw new Error("evidence disk full"); },
    }),
    (error) => error === primary
  );
  assert.deepEqual(primary.cleanupErrors.map(({ phase }) => phase), ["write-failure"]);
});

test("functional smoke publishes success only after every cleanup stage", async () => {
  const functional = await import("../scripts/cep-functional-smoke.mjs?s4-finalization-success");
  const events = [];

  await functional.finalizeFunctionalSmoke({
    cleanupSteps: [
      { phase: "project-reset", run: async () => events.push("project-reset") },
      { phase: "cdp-close", run: async () => events.push("cdp-close") },
      { phase: "temporary-directory", run: async () => events.push("temporary-directory") },
    ],
    publishSuccess: async () => events.push("publish-success"),
    writeFailure: async () => assert.fail("successful finalization must not write failure evidence"),
  });

  assert.deepEqual(events, [
    "project-reset",
    "cdp-close",
    "temporary-directory",
    "publish-success",
  ]);
});

test("functional smoke treats success publication failure as the primary failure", async () => {
  const functional = await import("../scripts/cep-functional-smoke.mjs?s4-finalization-publication");
  const publicationError = new Error("publish failed");
  const failureWrites = [];

  await assert.rejects(
    functional.finalizeFunctionalSmoke({
      cleanupSteps: [{ phase: "temporary-directory", run: async () => undefined }],
      publishSuccess: async () => { throw publicationError; },
      writeFailure: async (failure) => failureWrites.push(failure),
    }),
    (error) => error === publicationError
  );

  assert.equal(failureWrites[0].primaryError, publicationError);
  assert.deepEqual(failureWrites[0].cleanupErrors, []);
});

test("functional smoke atomically replaces stale success before work and preserves non-success on promotion failure", async () => {
  const functional = await import("../scripts/cep-functional-smoke.mjs?s4-report-publication");
  const root = await mkdtemp(join(tmpdir(), "chroma-relay-functional-report-"));
  const reportPath = join(root, "report.json");
  const pendingReportPath = join(root, ".report-current.pending.json");

  try {
    await writeFile(reportPath, '{"capturedAt":"prior-run","passed":true}\n');
    await functional.replaceFunctionalSmokeReport({
      reportPath,
      pendingReportPath,
      report: { capturedAt: "current-run", passed: false, status: "running" },
    });
    assert.deepEqual(JSON.parse(await readFile(reportPath, "utf8")), {
      capturedAt: "current-run",
      passed: false,
      status: "running",
    });

    const publicationError = new Error("failure evidence could not be removed");
    await assert.rejects(
      functional.replaceFunctionalSmokeReport({
        reportPath,
        pendingReportPath,
        report: { capturedAt: "current-run", passed: true, status: "passed" },
        beforeCommit: async () => { throw publicationError; },
      }),
      (error) => error === publicationError
    );
    assert.deepEqual(JSON.parse(await readFile(reportPath, "utf8")), {
      capturedAt: "current-run",
      passed: false,
      status: "running",
    });
    await assert.rejects(lstat(pendingReportPath), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const functionalRunChildren = async (root) => {
  const children = [];
  for (const name of await readdir(root)) {
    if ((await lstat(join(root, name))).isDirectory()) children.push(join(root, name));
  }
  return children;
};

test("functional smoke invalid mode preserves existing output files and publishes in an owned child", async () => {
  const root = await mkdtemp(join(process.cwd(), ".chroma-relay-functional-invalid-mode-"));
  const reportPath = join(root, "report.json");

  try {
    await writeFile(reportPath, '{"capturedAt":"prior-run","passed":true,"status":"passed"}\n');
    const result = spawnSync(
      process.execPath,
      [
        resolve("scripts/cep-functional-smoke.mjs"),
        "--mode=unsupported",
        `--output=${relative(process.cwd(), root)}`,
      ],
      { cwd: process.cwd(), encoding: "utf8" }
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unsupported functional smoke mode: unsupported/);
    const [runDirectory] = await functionalRunChildren(root);
    assert.ok(runDirectory);
    const report = JSON.parse(await readFile(join(runDirectory, "report.json"), "utf8"));
    const failure = JSON.parse(await readFile(join(runDirectory, "failure.json"), "utf8"));
    assert.equal(JSON.parse(await readFile(reportPath, "utf8")).passed, true);
    assert.equal(report.passed, false);
    assert.equal(report.status, "failed");
    assert.equal(report.mode, "unsupported");
    assert.equal(failure.passed, false);
    assert.equal(
      (await readdir(runDirectory)).filter((name) => name.endsWith(".pending.json")).length,
      0
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("functional smoke parser failure preserves parent files and publishes in an owned child", async () => {
  const root = await mkdtemp(join(process.cwd(), ".chroma-relay-functional-invalid-cli-"));
  const reportPath = join(root, "report.json");

  try {
    await writeFile(reportPath, '{"capturedAt":"prior-run","passed":true,"status":"passed"}\n');
    const result = spawnSync(
      process.execPath,
      [
        resolve("scripts/cep-functional-smoke.mjs"),
        `--output=${relative(process.cwd(), root)}`,
        "--unknown=x",
      ],
      { cwd: process.cwd(), encoding: "utf8" }
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown runner option: unknown/);
    const [runDirectory] = await functionalRunChildren(root);
    assert.ok(runDirectory);
    const report = JSON.parse(await readFile(join(runDirectory, "report.json"), "utf8"));
    const failure = JSON.parse(await readFile(join(runDirectory, "failure.json"), "utf8"));
    assert.equal(JSON.parse(await readFile(reportPath, "utf8")).passed, true);
    assert.equal(report.passed, false);
    assert.equal(report.status, "failed");
    assert.equal(report.mode, "invalid-cli");
    assert.equal(failure.passed, false);
    assert.equal(
      (await readdir(runDirectory)).filter((name) => name.endsWith(".pending.json")).length,
      0
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("functional smoke normalized-equivalent duplicate outputs preserve parent files", async () => {
  const root = await mkdtemp(join(process.cwd(), ".chroma-relay-functional-duplicate-output-"));
  const reportPath = join(root, "report.json");
  const outputArgument = `--output=${relative(process.cwd(), root)}`;
  const equivalentOutputArgument = `--output=./${relative(process.cwd(), root)}`;

  try {
    await writeFile(reportPath, '{"capturedAt":"prior-run","passed":true,"status":"passed"}\n');
    const result = spawnSync(
      process.execPath,
      [resolve("scripts/cep-functional-smoke.mjs"), outputArgument, equivalentOutputArgument],
      { cwd: process.cwd(), encoding: "utf8" }
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Duplicate runner option: output/);
    const [runDirectory] = await functionalRunChildren(root);
    assert.ok(runDirectory);
    const report = JSON.parse(await readFile(join(runDirectory, "report.json"), "utf8"));
    const failure = JSON.parse(await readFile(join(runDirectory, "failure.json"), "utf8"));
    assert.equal(JSON.parse(await readFile(reportPath, "utf8")).passed, true);
    assert.equal(report.passed, false);
    assert.equal(report.status, "failed");
    assert.equal(report.mode, "invalid-cli");
    assert.equal(failure.passed, false);
    assert.equal(
      (await readdir(runDirectory)).filter((name) => name.endsWith(".pending.json")).length,
      0
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("functional smoke symlink-equivalent duplicate outputs preserve parent files", async () => {
  const root = await mkdtemp(join(process.cwd(), ".chroma-relay-functional-symlink-output-"));
  const aliasParent = await mkdtemp(join(process.cwd(), ".chroma-relay-functional-output-alias-"));
  const alias = join(aliasParent, "output-link");
  const secondAlias = join(aliasParent, "second-output-link");
  try {
    await symlink(root, alias, "dir");
    await symlink(root, secondAlias, "dir");
    const outputPairs = [
      [
        `--output=${relative(process.cwd(), root)}`,
        `--output=${relative(process.cwd(), alias)}`,
      ],
      [
        `--output=${relative(process.cwd(), alias)}`,
        `--output=${relative(process.cwd(), secondAlias)}`,
      ],
    ];
    for (const outputArgs of outputPairs) {
      for (const args of [outputArgs, [...outputArgs].reverse()]) {
        await writeFile(join(root, "report.json"), '{"passed":true,"status":"passed"}\n');
        await rm(join(root, "failure.json"), { force: true });
        const priorChildren = new Set(await functionalRunChildren(root));
        const result = spawnSync(
          process.execPath,
          [resolve("scripts/cep-functional-smoke.mjs"), ...args],
          { cwd: process.cwd(), encoding: "utf8" }
        );
        assert.equal(result.status, 1);
        assert.equal(JSON.parse(await readFile(join(root, "report.json"), "utf8")).passed, true);
        const [runDirectory] = (await functionalRunChildren(root)).filter((path) => !priorChildren.has(path));
        assert.ok(runDirectory);
        assert.equal(JSON.parse(await readFile(join(runDirectory, "failure.json"), "utf8")).passed, false);
      }
    }
  } finally {
    await rm(aliasParent, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("functional smoke invoked through a symlinked ancestor preserves parent files", async () => {
  const aliasRoot = await mkdtemp(join(tmpdir(), "chroma-relay-functional-entry-alias-"));
  const outputRoot = await mkdtemp(join(process.cwd(), ".chroma-relay-functional-alias-output-"));
  const repoAlias = join(aliasRoot, "repo-alias");
  const reportPath = join(outputRoot, "report.json");

  try {
    await symlink(process.cwd(), repoAlias, "dir");
    await writeFile(reportPath, '{"capturedAt":"prior-run","passed":true,"status":"passed"}\n');
    const result = spawnSync(
      process.execPath,
      [
        join(repoAlias, "scripts", "cep-functional-smoke.mjs"),
        `--output=${relative(process.cwd(), outputRoot)}`,
        "--unknown=x",
      ],
      { cwd: process.cwd(), encoding: "utf8" }
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown runner option: unknown/);
    assert.equal(JSON.parse(await readFile(reportPath, "utf8")).passed, true);
    const [runDirectory] = await functionalRunChildren(outputRoot);
    assert.ok(runDirectory);
    assert.equal(JSON.parse(await readFile(join(runDirectory, "failure.json"), "utf8")).passed, false);
  } finally {
    await rm(aliasRoot, { recursive: true, force: true });
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test("CDP self-test awaits canonical target selection and Settings does too", async () => {
  const result = spawnSync(
    process.execPath,
    [resolve("scripts/cep-cdp.mjs"), "self-test"],
    { cwd: process.cwd(), encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).passed, [
    "single exact target",
    "wrong page",
    "duplicate exact pages",
    "wrong runtime ID",
  ]);
  const source = await readFile(resolve("scripts/cep-cdp.mjs"), "utf8");
  assert.match(source, /const target = await selectTarget\(await getTargets\(panel\.port\), panel\)/);
  assert.match(source, /await waitForMainHostAction\(client, evaluationGuard\)/);
  assert.match(source, /terminalState\.pendingHostAction === null/);
  assert.match(source, /terminalState\.pendingPaletteMutation === false/);
  assert.match(source, /evaluationGuard\.quarantine\(\)/);
  assert.ok(
    source.indexOf("await waitForMainHostAction(client, evaluationGuard)") <
      source.indexOf('api.resetTestState()')
  );
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

test("design capture selects only the canonical reviewed panel before reload", async () => {
  const design = await import("../scripts/cep-design-capture.mjs?s4-canonical-target");
  const canonical = resolve(tmpdir(), "reviewed", "main", "index.html");
  const foreign = resolve(tmpdir(), "foreign", "main", "index.html");
  const panel = { page: "main", port: 8198 };
  const target = (path) => ({
    type: "page",
    url: pathToFileURL(path).href,
    webSocketDebuggerUrl: "ws://canonical",
  });
  const realpathFn = async (path) => path;

  assert.equal(
    await design.selectDesignCaptureTarget([target(canonical)], panel, {
      expectedPage: canonical,
      realpathFn,
    }).then(({ url }) => url),
    pathToFileURL(canonical).href
  );
  await assert.rejects(
    design.selectDesignCaptureTarget([target(foreign)], panel, {
      expectedPage: canonical,
      realpathFn,
    }),
    /exactly one canonical target; found 0/
  );
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

  await assert.rejects(
    design.runDesignCaptureLifecycle({
      capture: async () => { throw primary; },
      cleanupSteps: [],
      writeFailure: async () => { throw new Error("evidence disk full"); },
    }),
    (error) => error === primary
  );
  assert.deepEqual(primary.cleanupErrors.map(({ phase }) => phase), ["write-failure"]);
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

test("Settings and persistence publish success only after exact restoration and cleanup", async () => {
  for (const script of ["cep-cdp.mjs", "cep-persistence-smoke.mjs"]) {
    const source = await readFile(resolve("scripts", script), "utf8");
    const pendingIndex = source.indexOf("pendingReport = {");
    const baselineIndex = source.indexOf("originalConfigRoots.set(");
    const restorationIndex = source.indexOf("originalConfigRoots.get(page)");
    const scratchCleanupIndex = source.indexOf(
      script === "cep-persistence-smoke.mjs"
        ? "for (const ownedScratch of [scratch, ...inactiveScratches])"
        : "await removeOwnedRunDirectory(scratch)",
      restorationIndex
    );
    const publicationIndex = source.lastIndexOf("JSON.stringify(pendingReport, null, 2)");
    assert.ok(baselineIndex > 0 && baselineIndex < pendingIndex, `${script} must capture baseline first`);
    assert.ok(pendingIndex < restorationIndex, `${script} must hold success pending before restoration`);
    assert.ok(restorationIndex < scratchCleanupIndex, `${script} must restore before deleting scratch`);
    assert.ok(scratchCleanupIndex < publicationIndex, `${script} must publish only after cleanup`);
    assert.match(source, /phase: `restore-config:\$\{page\}`/);
    assert.match(source, /failure-evidence/);
    assert.match(source, /writeFile\([^\n]*failureText\)/);
    if (script === "cep-persistence-smoke.mjs") {
      const identityIndex = source.indexOf('api.getIdentity()');
      const extensionCheckIndex = source.indexOf("identity.extensionId !== contract.product.panelIds[panel.page]", identityIndex);
      const buildCheckIndex = source.indexOf("identity.buildMarker !== EXPECTED_BUILD_MARKER", identityIndex);
      const resetIndex = source.indexOf("api.resetTestState()", identityIndex);
      assert.ok(identityIndex > 0 && identityIndex < extensionCheckIndex);
      assert.ok(extensionCheckIndex < buildCheckIndex && buildCheckIndex < resetIndex);
    }
  }
});

test("CDP inspect authenticates before mutation and publishes only after exact cleanup", async () => {
  const source = await readFile(resolve("scripts/cep-cdp.mjs"), "utf8");
  const inspectStart = source.indexOf("const inspectPanel = async");
  const runningIndex = source.indexOf('status: "running"', inspectStart);
  const allocationIndex = source.indexOf("scratch = await createOwnedTemporaryConfigDirectory", inspectStart);
  const identityIndex = source.indexOf("assertIdentity(initialIdentity, panel)", inspectStart);
  const latchIndex = source.indexOf("configMutationAttempted = true", identityIndex);
  const mutateIndex = source.indexOf("api.setTemporaryConfigRoot", latchIndex);
  const restoreIndex = source.indexOf("configRestored = true", mutateIndex);
  const closeIndex = source.indexOf("await client?.close()", restoreIndex);
  const removeIndex = source.indexOf("await removeOwnedRunDirectory(scratch)", closeIndex);
  const passIndex = source.indexOf("report.passed = true", removeIndex);
  const publishIndex = source.indexOf("await writeFile(\n      reportPath", passIndex);
  assert.ok(runningIndex < allocationIndex);
  assert.ok(allocationIndex < identityIndex && identityIndex < latchIndex && latchIndex < mutateIndex);
  assert.ok(mutateIndex < restoreIndex && restoreIndex < closeIndex && closeIndex < removeIndex);
  assert.ok(removeIndex < passIndex && passIndex < publishIndex);
});

test("temporary-config ownership is latched before mutating requests across maintained runners", async () => {
  const checks = [
    ["cep-functional-smoke.mjs", "configMutationAttempted = true", "api.setTemporaryConfigRoot"],
    ["cep-design-capture.mjs", "temporaryConfigInstalled = true", "api.setTemporaryConfigRoot"],
    ["cep-persistence-smoke.mjs", "configuredPanels.add(panel.page)", "api.setTemporaryConfigRoot"],
    ["cep-palette-management-smoke.mjs", "configMutationAttempted.add(client.page)", "api.setTemporaryConfigRoot"],
    ["diagnose-ae23-selection-restore.mjs", "configMutationAttempted = true", "api.setTemporaryConfigRoot"],
  ];
  for (const [script, latch, mutation] of checks) {
    const source = await readFile(resolve("scripts", script), "utf8");
    const latchIndex = source.indexOf(latch);
    const mutationIndex = source.indexOf(mutation, latchIndex);
    assert.ok(latchIndex > 0 && latchIndex < mutationIndex, `${script} must latch before mutation`);
  }
  for (const [script, latch, reset] of [
    ["cep-persistence-smoke.mjs", "configuredPanels.add(panel.page)", "api.resetTestState()"],
    ["cep-palette-management-smoke.mjs", "configMutationAttempted.add(client.page)", "api.resetTestState()"],
  ]) {
    const source = await readFile(resolve("scripts", script), "utf8");
    assert.ok(source.indexOf(latch) < source.indexOf(reset), `${script} must latch before reset`);
  }
});

test("maintained mutation runners reauthenticate the connected canonical runtime", async () => {
  const checks = [
    ["cep-cdp.mjs", "configMutationAttempted = true"],
    ["cep-functional-smoke.mjs", "configMutationAttempted = true"],
    ["cep-design-capture.mjs", "temporaryConfigInstalled = true"],
    ["cep-persistence-smoke.mjs", "configuredPanels.add(panel.page)"],
    ["cep-palette-management-smoke.mjs", "configMutationAttempted.add(client.page)"],
    ["cep-native-gradient-collect-smoke.mjs", "setupAttempted = true"],
    ["diagnose-ae23-selection-restore.mjs", "projectSetupAttempted = true"],
    ["diagnose-ae-selection-semantics.mjs", "hostResult = await hostEval(client, hostSource)"],
  ];
  for (const [script, firstMutation] of checks) {
    const source = await readFile(resolve("scripts", script), "utf8");
    const runtimeProof = source.indexOf("await assertCanonicalRuntimeUrl(");
    const mutation = source.indexOf(firstMutation);
    assert.ok(runtimeProof > 0, `${script} must authenticate the connected runtime URL`);
    assert.ok(runtimeProof < mutation, `${script} must authenticate runtime before mutation`);
  }
});

test("every maintained page reload is bounded by fresh pre- and post-reload identity proofs", async () => {
  const checks = [
    ["cep-cdp.mjs", "await assertIdentity(", "setTemporaryConfigRoot("],
    ["cep-functional-smoke.mjs", "await assertFunctionalRuntime(", "setTemporaryConfigRoot("],
    ["cep-design-capture.mjs", "await assertCanonicalRuntimeUrl(", "setTemporaryConfigRoot("],
    ["cep-palette-management-smoke.mjs", "await assertCanonicalRuntimeUrl(", "api.resetTestState()"],
    ["cep-native-gradient-collect-smoke.mjs", "await assertNativeGradientRuntime(", "evalHost(client"],
  ];
  for (const [script, identityProof, mutation] of checks) {
    const source = await readFile(resolve("scripts", script), "utf8");
    let previousReload = -1;
    let reload = source.indexOf('client.send("Page.reload"');
    assert.ok(reload > 0, `${script} must contain a reload to exercise this contract`);
    while (reload >= 0) {
      const preReloadProof = source.lastIndexOf(identityProof, reload);
      const postReloadProof = source.indexOf(identityProof, reload);
      const firstMutation = source.indexOf(mutation, reload);
      assert.ok(preReloadProof > previousReload, `${script} reload must follow fresh identity proof`);
      assert.ok(postReloadProof > reload, `${script} reload must be followed by identity proof`);
      assert.ok(
        firstMutation < 0 || postReloadProof < firstMutation,
        `${script} must reauthenticate after reload before mutation`
      );
      previousReload = reload;
      reload = source.indexOf('client.send("Page.reload"', reload + 1);
    }
  }
  const settingsSource = await readFile(resolve("scripts/cep-cdp.mjs"), "utf8");
  assert.match(settingsSource, /preReloadIdentity\.configRoot !== temporaryRoot/);
});

test("maintained config restoration uses authoritative readback before latching", async () => {
  for (const [script, minimumCalls] of [
    ["cep-cdp.mjs", 2],
    ["cep-functional-smoke.mjs", 1],
    ["cep-design-capture.mjs", 1],
    ["cep-persistence-smoke.mjs", 1],
    ["cep-palette-management-smoke.mjs", 1],
    ["diagnose-ae23-selection-restore.mjs", 1],
  ]) {
    const source = await readFile(resolve("scripts", script), "utf8");
    assert.ok(
      source.split("await restoreConfigRootWithReadback({").length - 1 >= minimumCalls,
      `${script} must restore through authoritative readback`
    );
    assert.match(source, /getIdentity\(\)\.configRoot/);
  }
  const nativeSource = await readFile(
    resolve("scripts/cep-native-gradient-collect-smoke.mjs"),
    "utf8"
  );
  assert.match(nativeSource, /restoredIdentity\.configRoot === originalConfigRoot/);
  assert.ok(
    nativeSource.indexOf("restoredIdentity.configRoot === originalConfigRoot") <
      nativeSource.indexOf("await removeOwnedRunDirectory(scratch)")
  );
});

test("maintained config runners quarantine unknown renderer completion before cleanup", async () => {
  for (const script of [
    "cep-cdp.mjs",
    "cep-design-capture.mjs",
    "cep-palette-management-smoke.mjs",
  ]) {
    const source = await readFile(resolve("scripts", script), "utf8");
    assert.match(source, /guardClientEvaluations/);
    assert.match(source, /isCompletionKnown\(\)/);
    assert.match(source, /completion is unknown;[^\n]*dispatch refused/);
  }
});

test("diagnostic failure evidence preserves primary errors with write diagnostics", async () => {
  for (const script of [
    "diagnose-ae23-selection-restore.mjs",
    "diagnose-ae-selection-semantics.mjs",
  ]) {
    const source = await readFile(resolve("scripts", script), "utf8");
    assert.match(source, /const evidenceWriteErrors = \[\]/);
    assert.match(source, /primaryError\.evidenceWriteErrors = evidenceWriteErrors/);
    assert.match(source, /throw primaryError/);
  }
  const cdpSource = await readFile(resolve("scripts/cep-cdp.mjs"), "utf8");
  assert.match(cdpSource, /phase: `failure-evidence:\$\{phase\}`/);
  assert.match(cdpSource, /primaryError\.cleanupErrors = cleanupErrors/);
  assert.match(cdpSource, /publicationError\.evidenceWriteErrors = evidenceWriteErrors/);
  for (const script of ["cep-persistence-smoke.mjs", "cep-palette-management-smoke.mjs"]) {
    const source = await readFile(resolve("scripts", script), "utf8");
    assert.match(source, /const evidenceWriteErrors = \[\]/);
    assert.match(source, /publicationError\.evidenceWriteErrors = evidenceWriteErrors/);
  }
});

test("palette smoke authenticates extension identity and restores exact roots before publication", async () => {
  const source = await readFile(resolve("scripts/cep-palette-management-smoke.mjs"), "utf8");
  const identityIndex = source.indexOf("baselineIdentity.extensionId, contract.product.panelIds[client.page]");
  const baselineIndex = source.indexOf("originalConfigRoots.set(client.page", identityIndex);
  const mutationIndex = source.indexOf("configMutationAttempted.add(client.page)", baselineIndex);
  const restoreIndex = source.indexOf("originalConfigRoots.get(client.page)", mutationIndex);
  const removeIndex = source.indexOf("await removeOwnedRunDirectory(scratch)", restoreIndex);
  const publishIndex = source.lastIndexOf("JSON.stringify(lifecycleResult.report, null, 2)");
  assert.ok(identityIndex > 0 && identityIndex < baselineIndex && baselineIndex < mutationIndex);
  assert.ok(mutationIndex < restoreIndex && restoreIndex < removeIndex && removeIndex < publishIndex);
});

test("persistence rotates temporary roots before retiring the active root and can roll back partial switches", async () => {
  const source = await readFile(resolve("scripts/cep-persistence-smoke.mjs"), "utf8");
  const createIndex = source.indexOf("const nextScratch = await createOwnedTemporaryConfigDirectory");
  const switchIndex = source.indexOf("setVerifiedConfigRoot(", createIndex);
  const switchReadbackIndex = source.indexOf('"persistence rotated config root"', switchIndex);
  const rollbackIndex = source.indexOf('"persistence rolled-back config root"', switchReadbackIndex);
  const retireIndex = source.indexOf("await removeOwnedRunDirectory(previousScratch)", switchIndex);
  assert.ok(
    createIndex > 0 &&
      createIndex < switchIndex &&
      switchIndex < switchReadbackIndex &&
      switchReadbackIndex < rollbackIndex &&
      rollbackIndex < retireIndex
  );
  assert.match(source, /const setVerifiedConfigRoot =[^]*restoreConfigRootWithReadback/);
  assert.match(source, /for \(const client of switchedClients\.reverse\(\)\)/);
  assert.match(source, /setVerifiedConfigRoot\([^]*previousScratch\.path/);
  assert.match(source, /inactiveScratches\.push\(nextScratch\)/);
  assert.match(source, /await setVerifiedConfigRoot\([^]*nextScratch\.path[^]*switchedClients\.push\(client\)/);
  assert.match(source, /const uncertainClients = new Set\(\)/);
  assert.match(source, /guardClientEvaluations\(client, `\$\{panel\.page\} persistence smoke`\)/);
  assert.match(source, /!evaluationGuards\.get\(client\)\?\.isCompletionKnown\(\)/);
  assert.match(source, /uncertainClients\.has\(client\)[^]*restoration dispatch refused/);
  assert.doesNotMatch(source, /rollbackErrors\.length === 0[^]*removeOwnedRunDirectory\(nextScratch\)/);
  assert.match(source, /ownedTemporaryRoots: \[scratch, \.\.\.inactiveScratches\]/);
});

test("design capture restores the accepted baseline before deleting temporary config", async () => {
  const source = await readFile(resolve("scripts/cep-design-capture.mjs"), "utf8");
  const reloadIndex = source.indexOf('client.send("Page.reload"');
  const baselineIndex = source.indexOf("originalConfigRoot = baselineIdentity.configRoot ?? null;");
  const installIndex = source.indexOf("temporaryConfigInstalled = true;");
  const restoreIndex = source.indexOf('phase: "restore-config"');
  const scratchIndex = source.indexOf('phase: "scratch"');
  assert.ok(baselineIndex > 0 && baselineIndex < reloadIndex && reloadIndex < installIndex);
  assert.ok(installIndex < restoreIndex && restoreIndex < scratchIndex);
  assert.match(source, /restoreConfigRootWithReadback\(\{/);
  assert.match(source, /getIdentity\(\)\.configRoot/);
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

test("native-gradient fixture loading accepts exact hosts and owned newer-host conversions only", async () => {
  const { canLoadReviewedNativeGradientFixture, classifyNativeGradientFixtureLoad } = await import(
    "../scripts/cep-native-gradient-collect-smoke.mjs?fixture-load"
  );
  const fixtureCopy = "/tmp/chroma-relay-native/exact-identity-ae25.aep";
  const expectedVersion = "25.6.6x4";
  assert.equal(canLoadReviewedNativeGradientFixture(expectedVersion, expectedVersion), true);
  assert.equal(canLoadReviewedNativeGradientFixture("26.3x87", expectedVersion), true);
  assert.equal(canLoadReviewedNativeGradientFixture("25.5x4", expectedVersion), false);
  assert.equal(canLoadReviewedNativeGradientFixture("25.7x1", expectedVersion), false);
  assert.equal(canLoadReviewedNativeGradientFixture("27.0", expectedVersion), false);
  assert.equal(canLoadReviewedNativeGradientFixture("21.0", expectedVersion), false);
  assert.equal(canLoadReviewedNativeGradientFixture("invalid", "invalid"), false);
  const identity = { ok: true, compId: 1, selectedLayers: 2, selectedProperties: 0 };
  assert.deepEqual(
    classifyNativeGradientFixtureLoad({
      setup: {
        ...identity,
        version: expectedVersion,
        projectPath: fixtureCopy,
        dirty: false,
      },
      expectedVersion,
      fixtureCopy,
    }),
    { accepted: true, exact: true, converted: false, runtimeMajor: 25, expectedMajor: 25 },
  );
  assert.equal(
    classifyNativeGradientFixtureLoad({
      setup: { ...identity, version: "26.3x87", projectPath: null, dirty: true },
      expectedVersion,
      fixtureCopy,
    }).converted,
    true,
  );
  for (const setup of [
    { ...identity, version: "27.0", projectPath: null, dirty: true },
    { ...identity, version: "26.3x87", projectPath: fixtureCopy, dirty: true },
    { ...identity, version: "26.3x87", projectPath: null, dirty: true, compId: 99 },
  ]) {
    assert.equal(
      classifyNativeGradientFixtureLoad({ setup, expectedVersion, fixtureCopy }).accepted,
      false,
    );
  }
});

test("native-gradient cleanup requires panel restoration and retains scratch evidence", async () => {
  const gradient = await import("../scripts/cep-native-gradient-collect-smoke.mjs?s4-lifecycle-panel");
  const valid = gradient.assessNativeGradientCleanup({
    report: { passed: true },
    failure: null,
    setup: { ok: true },
    cleanup: {
      panel: { restored: true, loaded: { paletteRevision: 1 } },
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

  const reloadError = gradient.assessNativeGradientCleanup({
    report: { passed: true },
    failure: null,
    setup: { ok: true },
    cleanup: {
      panel: { restored: true, loaded: { error: "palette reload failed" } },
      project: { restored: true },
      temp: { removed: true },
    },
  });
  assert.equal(reloadError.report, null);
  assert.match(reloadError.failure.message, /cleanup failed/i);
  assert.equal(reloadError.retainScratch, true);
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

test("native-gradient setup reauthenticates its predecessor and cleanup honors close refusal", async () => {
  const source = await readFile(
    resolve("scripts/cep-native-gradient-collect-smoke.mjs"),
    "utf8"
  );
  const openStart = source.indexOf("const openFixtureSource =");
  const restoreStart = source.indexOf("const restoreProjectSource =");
  const openBody = source.slice(openStart, restoreStart);
  const restoreBody = source.slice(restoreStart, source.indexOf("const aeMajor", restoreStart));
  assert.match(openBody, /predecessor-project-drift/);
  assert.ok(openBody.indexOf("currentProjectState()") < openBody.indexOf("app.open(fixture)"));
  assert.match(source, /openFixtureSource\(fixtureCopy, originalProject, ownershipToken\)/);
  assert.match(source, /restoreProjectSource\(\s*originalProject,/);
  assert.match(source, /let cleanupDispatchAuthorized = false/);
  assert.match(openBody, /foreign-owner-present/);
  assert.match(openBody, /__CHROMA_NATIVE_GRADIENT_OWNER__/);
  assert.match(openBody, /fixtureOpened: true/);
  assert.match(
    source,
    /cleanupDispatchAuthorized =\s*setup\?\.ownershipClaimed === true && setup\?\.fixtureOpened === true/
  );
  assert.match(restoreBody, /native-gradient-owner-mismatch/);
  assert.match(restoreBody, /delete \$\.global\.__CHROMA_NATIVE_GRADIENT_OWNER__/);
  assert.match(source, /if \(!panelMutationAttempted\)[^]*panelCleanupCompletionKnown = true/);
  assert.match(
    source,
    /runtimeSave = await evalHost\([^]*cleanupDispatchAuthorized = true;\s*if \(\s*runtimeSave\.ok/
  );
  assert.match(
    source,
    /temporaryIdentity = await client\.evaluate[^]*cleanupDispatchAuthorized = true;\s*if \(temporaryIdentity\?\.configRoot !== temporaryRoot\)/
  );
  assert.match(source, /cleanupDispatchAuthorized = false;\s*const before = await evalHost/);
  assert.match(source, /cleanupDispatchAuthorized = false;\s*const after = await evalHost/);
  assert.match(source, /failure\.evidenceWriteErrors =/);
  assert.match(source, /if \(client && cleanupDispatchAuthorized && operationGuard\?\.isCompletionKnown\(\) !== false\)/);
  assert.match(source, /cleanup-dispatch-not-authorized/);
  assert.match(source, /snapshot\?\.state\?\.lastHostResult != null/);
  assert.match(source, /originalProject && panelCleanupCompletionKnown/);
  assert.match(source, /selectedPropertyPaths/);
  assert.match(restoreBody, /restoredLayer\.selectedProperties\.length !== wantedLayer\.selectedProperties/);
  assert.match(restoreBody, /foundItem\.selected = wantedItem\.selected === true/);
  assert.match(restoreBody, /var closed = app\.project\.close/);
  assert.match(restoreBody, /if \(closed !== true\)/);
  assert.ok(restoreBody.indexOf("previous.exists") < restoreBody.indexOf("app.project.close"));
  assert.match(restoreBody, /restored: emptyRestored/);
  assert.match(restoreBody, /restored: savedRestored/);
  assert.match(restoreBody, /exactFixtureTopology = app\.project\.numItems === 1/);
  assert.match(restoreBody, /JSON\.stringify\(snapshotComp\(active\)\)/);
  assert.match(restoreBody, /var ownedSavedCopy = app\.project\.file[^]*exactFixtureTopology/);
  assert.match(restoreBody, /app\.project\.close\(CloseOptions\.SAVE_CHANGES\)/);
  assert.match(source, /native-gradient fixture bytes drifted before restoration/);
  assert.match(source, /acceptedFixtureTopology = setup\.fixtureTopology/);
  assert.match(source, /fixture topology drifted after same-dispatch setup capture/);
  assert.match(source, /operationGuard = guardClientEvaluations\(client, "native-gradient smoke Main"\)/);
});

test("destructive fixture cleanup authenticates completed topology and exposes publication failures", async () => {
  const [formal, functional, nativeGradient, selection, ae23, cdp, palette, persistence] = await Promise.all([
    readFile(resolve("scripts/run-live-ae-tests.mjs"), "utf8"),
    readFile(resolve("scripts/cep-functional-smoke.mjs"), "utf8"),
    readFile(resolve("scripts/cep-native-gradient-collect-smoke.mjs"), "utf8"),
    readFile(resolve("scripts/diagnose-ae-selection-semantics.mjs"), "utf8"),
    readFile(resolve("scripts/diagnose-ae23-selection-restore.mjs"), "utf8"),
    readFile(resolve("scripts/cep-cdp.mjs"), "utf8"),
    readFile(resolve("scripts/cep-palette-management-smoke.mjs"), "utf8"),
    readFile(resolve("scripts/cep-persistence-smoke.mjs"), "utf8"),
  ]);

  assert.match(formal, /current\.dirty !== false[\s\S]*owned-project-topology-drift/);
  assert.match(formal, /expectedFinalOwnedProject = projectIdentity\(failureAfter\)/);
  assert.match(formal, /owned project bytes drifted before restoration/);
  assert.match(formal, /keyInTemporalEase/);
  assert.match(formal, /keySpatialContinuous/);
  assert.match(formal, /app\.project\.close\(CloseOptions\.SAVE_CHANGES\)/);
  assert.match(formal, /postCloseOwnedProjectHash/);
  assert.match(formal, /saved owned project drifted; temporary archive retained/);

  assert.match(functional, /captureSetupTopologySource/);
  assert.doesNotMatch(functional, /captureImageSelectionTopologySource/);
  assert.match(functional, /same-dispatch topology capture failed/);
  assert.match(functional, /keyInInterpolationType/);
  assert.match(functional, /keyOutTemporalEase/);
  assert.match(functional, /keyRoving/);

  assert.match(nativeGradient, /acceptedFixtureTopology = setup\.fixtureTopology/);
  assert.match(nativeGradient, /app\.project\.close\(CloseOptions\.SAVE_CHANGES\)/);
  assert.match(nativeGradient, /postCloseHashes/);
  assert.match(nativeGradient, /saved native-gradient fixture drifted; scratch archive retained/);
  assert.ok(
    nativeGradient.indexOf("runtimeSave = await evalHost") <
      nativeGradient.indexOf('dispatchClick("palette-add")'),
    "converted fixture must be saved before production descriptor collection"
  );
  assert.match(nativeGradient, /comment: layer\.comment/);
  assert.match(nativeGradient, /keyInTemporalEase/);
  assert.match(selection, /__CHROMA_SELECTION_SEMANTICS_SETUP_COMPLETE__/);
  assert.match(selection, /!setupComplete &&\s*isFinalOwnedItem/);
  assert.match(ae23, /__CHROMA_AE23_DIAGNOSTIC_SETUP_COMPLETE__/);
  assert.match(ae23, /!setupComplete &&\s*layerIndex === 1/);

  assert.match(nativeGradient, /Failure evidence publication also failed/);
  assert.match(nativeGradient, /JSON\.stringify\(error\.evidenceWriteErrors, null, 2\)/);
  for (const source of [cdp, palette, persistence]) {
    assert.match(source, /Failure evidence publication also failed/);
    assert.match(source, /error\?\.cleanupErrors/);
    assert.match(source, /startsWith\("failure-evidence/);
    assert.match(source, /JSON\.stringify\(evidenceDiagnostics, null, 2\)/);
  }
  for (const source of [selection, ae23]) {
    assert.match(source, /diagnosticProjectTopology/);
    assert.match(source, /owned-fixture-topology-drift/);
    assert.match(source, /keyInTemporalEase/);
  }
});

test("native-gradient restoration refuses a structurally substituted fixture before close", async () => {
  const gradient = await import("../scripts/cep-native-gradient-collect-smoke.mjs?foreign-fixture-topology");
  class CompItem {}
  let closeCount = 0;
  const project = {
    file: { fsName: "/owned/fixture.aep" },
    dirty: true,
    numItems: 99,
    activeItem: {},
    close: () => { closeCount += 1; return true; },
  };
  const source = gradient.restoreProjectSource(
    { projectPath: null },
    true,
    "/owned/fixture.aep",
    "/owned/runtime.aep",
    "run-token"
  );
  const raw = Function("$", "app", "CompItem", `return ${source}`)(
    {
      global: {
        __CHROMA_NATIVE_GRADIENT_OWNER__: "run-token",
        __CHROMA_NATIVE_GRADIENT_PREDECESSOR__: {},
      },
    },
    { project },
    CompItem
  );
  const result = JSON.parse(raw);
  assert.equal(result.restored, false);
  assert.equal(result.reason, "fixture-project-ownership-mismatch");
  assert.equal(closeCount, 0);
});

test("native-gradient restoration refuses topology drift and saves opaque edits before close", async () => {
  const gradient = await import("../scripts/cep-native-gradient-collect-smoke.mjs?nested-fixture-topology");
  class CompItem {
    constructor() {
      this.id = 1;
      this.name = "A3 Exact Identity Mixed AE25";
      this.width = 1920;
      this.height = 1080;
      this.pixelAspect = 1;
      this.duration = 1;
      this.frameRate = 24;
      this.bgColor = [0, 0, 0];
      this.layers = [
        { id: 14, name: "one", matchName: "ADBE AV Layer" },
        { id: 13, name: "two", matchName: "ADBE AV Layer" },
      ].map((layer, index) => ({
        ...layer,
        index: index + 1,
        source: null,
        enabled: true,
        locked: false,
        shy: false,
        solo: false,
        adjustmentLayer: false,
        guideLayer: false,
        threeDLayer: false,
        startTime: 0,
        inPoint: 0,
        outPoint: 1,
        stretch: 100,
        numProperties: 0,
      }));
      this.numLayers = this.layers.length;
    }
    layer(index) { return this.layers[index - 1]; }
  }
  let closeCount = 0;
  let closeOption = null;
  let persistedOpaquePayload = null;
  const comp = new CompItem();
  const project = {
    file: { fsName: "/owned/fixture.aep" },
    dirty: false,
    numItems: 1,
    activeItem: comp,
    opaquePayload: "baseline",
    close: (option) => {
      closeCount += 1;
      closeOption = option;
      persistedOpaquePayload = project.opaquePayload;
      return true;
    },
  };
  const app = {
    project,
    newProject() {
      this.project = { file: null, dirty: false, numItems: 0 };
    },
  };
  const dollar = {
    global: {
      __CHROMA_NATIVE_GRADIENT_OWNER__: "run-token",
      __CHROMA_NATIVE_GRADIENT_PREDECESSOR__: {},
    },
  };
  const closeOptions = { SAVE_CHANGES: "save", DO_NOT_SAVE_CHANGES: "discard" };
  const source = gradient.restoreProjectSource(
    { projectPath: null },
    true,
    "/owned/fixture.aep",
    "/owned/runtime.aep",
    "run-token",
    { nested: "different" }
  );
  const raw = Function("$", "app", "CompItem", "CloseOptions", `return ${source}`)(
    dollar,
    app,
    CompItem,
    closeOptions
  );
  const topologyResult = JSON.parse(raw);
  assert.equal(topologyResult.restored, false);
  assert.equal(topologyResult.reason, "fixture-project-ownership-mismatch");
  assert.equal(closeCount, 0);

  project.dirty = true;
  project.opaquePayload = "mutated";
  const opaqueCollisionSource = gradient.restoreProjectSource(
    { projectPath: null },
    true,
    "/owned/fixture.aep",
    "/owned/runtime.aep",
    "run-token",
    topologyResult.fixtureTopology
  );
  const opaqueCollisionRaw = Function(
    "$",
    "app",
    "CompItem",
    "CloseOptions",
    `return ${opaqueCollisionSource}`
  )(dollar, app, CompItem, closeOptions);
  const opaqueCollision = JSON.parse(opaqueCollisionRaw);
  assert.equal(opaqueCollision.restored, true);
  assert.equal(closeCount, 1);
  assert.equal(closeOption, closeOptions.SAVE_CHANGES);
  assert.equal(persistedOpaquePayload, "mutated");
});

test("AE23 selection diagnostic performs one bounded owned cleanup before success publication", async () => {
  const source = await readFile(
    resolve("scripts/diagnose-ae23-selection-restore.mjs"),
    "utf8"
  );
  const dispatchMarker = "actionDispatched = true;";
  const dispatchIndex = source.indexOf(dispatchMarker);
  assert.ok(dispatchIndex > 0, "diagnostic must latch before product dispatch");
  const targetSelectionIndex = source.indexOf("target = await selectCanonicalCdpTarget(");
  const connectIndex = source.indexOf("client = new CdpClient(");
  assert.ok(targetSelectionIndex > 0 && targetSelectionIndex < connectIndex);
  assert.equal(source.includes('pathname.endsWith("/main/index.html")'), false);
  assert.match(
    source.slice(dispatchIndex),
    /actionDispatched = true;\s*projectCleanupAuthorized = false;\s*const accepted = await client\.evaluate/
  );
  assert.match(source, /actionTerminalConfirmed && hostResult\?\.undoGroupClosed === true/);
  assert.match(source, /if \(client && projectCleanupAuthorized\)/);
  assert.match(source, /projectCleanupAuthorized = false;\s*projectCleanup = await client\.evaluate/);
  assert.match(source, /comp\.name !== "CHROMA_AE23_SELECTION_/);
  assert.match(source, /__CHROMA_AE23_DIAGNOSTIC_OWNER__/);
  assert.match(source, /comp\.comment !==/);
  const setupStart = source.indexOf("const setupSource =");
  const cleanupStart = source.indexOf("const cleanupSource =");
  const setupBody = source.slice(setupStart, cleanupStart);
  const cleanupBody = source.slice(cleanupStart, source.indexOf("let client = null", cleanupStart));
  assert.match(setupBody, /foreign-owner-present/);
  assert.match(setupBody, /cleanupSafe: undoCloseError === null/);
  assert.match(source, /setup = await hostEval\(client, setupSource\);\s*projectCleanupAuthorized = setup\?\.cleanupSafe === true/);
  assert.match(cleanupBody, /function exactPartialTarget/);
  assert.match(cleanupBody, /createdKinds = \["fill", "stroke"\]\.slice\(0, comp\.numLayers\)/);
  assert.ok(setupBody.indexOf("comp.comment =") < setupBody.indexOf("$.global.__CHROMA_AE23_DIAGNOSTIC_OWNER__ ="));
  assert.equal(cleanupBody.includes("alreadyClean"), false);
  assert.ok(cleanupBody.indexOf("app.version !==") < cleanupBody.indexOf("if (!app.project)"));
  assert.match(cleanupBody, /if \(!app\.project\) \{\s*return JSON\.stringify\(\{ ok: false, reason: "no-project" \}\)/);
  assert.match(cleanupBody, /app\.project\.file !== null/);
  assert.ok(
    cleanupBody.indexOf("app.project.save(archive)") <
      cleanupBody.indexOf("app.project.close(CloseOptions.SAVE_CHANGES)") &&
      cleanupBody.indexOf("app.project.close(CloseOptions.SAVE_CHANGES)") <
      cleanupBody.indexOf("delete $.global.__CHROMA_AE23_DIAGNOSTIC_OWNER__")
  );
  assert.match(source, /AE23 diagnostic label must be a lowercase safe token/);
  assert.equal(setupBody.includes("app.newProject()"), false);
  assert.ok(setupBody.indexOf("app.version !==") < setupBody.indexOf("!app.project"));
  const setupDispatchIndex = source.indexOf("setup = await hostEval(client, setupSource)");
  const configMutationIndex = source.indexOf("configMutationAttempted = true");
  assert.ok(setupDispatchIndex > 0 && setupDispatchIndex < configMutationIndex);
  assert.match(source, /projectSetupAttempted = true;\s*setup = await hostEval/);
  assert.match(source, /app\.project\.save\(archive\)/);
  assert.match(source, /app\.project\.close\(CloseOptions\.SAVE_CHANGES\)/);
  assert.match(source, /projectCleanup = await client\.evaluate/);
  assert.match(source, /restoreConfigRootWithReadback\(\{/);
  assert.match(source, /getIdentity\(\)\.configRoot/);
  assert.match(cleanupBody, /var closed = app\.project\.close/);
  assert.match(cleanupBody, /if \(closed !== true\)/);
  assert.match(cleanupBody, /layer\.comment !==/);
  assert.match(cleanupBody, /root\.numProperties !== 1/);
  assert.match(source, /await removeOwnedRunDirectory\(scratchRun\)/);
  assert.match(source, /harnessHostEvalAfterActionCount !== 0/);
  const cleanupIndex = source.indexOf("projectCleanup = await client.evaluate");
  const restoreIndex = source.indexOf("configRestored = true", cleanupIndex);
  const removeIndex = source.indexOf("scratchRemoved = true", restoreIndex);
  const publishIndex = source.lastIndexOf("await writeFile(reportPath");
  assert.ok(dispatchIndex < cleanupIndex && cleanupIndex < restoreIndex);
  assert.ok(restoreIndex < removeIndex && removeIndex < publishIndex);
  assert.match(source, /expectedTruncated/);
  assert.match(source, /layersTruncated/);
  assert.match(source, /actualTruncated/);
  assert.match(source, /cleanupErrors\.push\(\{ phase: "close"/);
});

test("AE23 diagnostic invalidates stale success before setup and defers success until close", async () => {
  const parent = await mkdtemp(join(tmpdir(), "chroma-relay-ae23-invalid-"));
  const output = join(parent, "evidence");
  const label = "transaction-probe";
  const reportPath = join(output, `${label}-report.json`);
  try {
    await mkdir(output, { recursive: true });
    await writeFile(reportPath, '{"passed":true,"capturedAt":"stale"}\n');
    const result = spawnSync(
      process.execPath,
      [resolve("scripts/diagnose-ae23-selection-restore.mjs"), join(output, "missing-repo"), label, "23.0", output],
      { cwd: process.cwd(), encoding: "utf8" }
    );
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(await readFile(reportPath, "utf8")), {
      passed: false,
      status: "running",
      label,
      expectedVersion: "23.0",
      port: "8198",
    });

    const source = await readFile(resolve("scripts/diagnose-ae23-selection-restore.mjs"), "utf8");
    const closeIndex = source.indexOf("if (client) await client.close()");
    const publishIndex = source.lastIndexOf("await writeFile(reportPath");
    assert.ok(closeIndex > 0 && closeIndex < publishIndex);
    assert.match(source, /for \(const \[phase, path\] of \[\["report", reportPath\], \["failure", failurePath\]\]\)/);
    assert.match(source, /try \{ await writeFile\(path, failureText\); \} catch \(error\)/);

    const escapedPath = join(parent, "escaped-report.json");
    const unsafe = spawnSync(
      process.execPath,
      [
        resolve("scripts/diagnose-ae23-selection-restore.mjs"),
        join(output, "missing-repo"),
        "../escaped",
        "23.0",
        output,
      ],
      { cwd: process.cwd(), encoding: "utf8" }
    );
    assert.equal(unsafe.status, 1);
    await assert.rejects(readFile(escapedPath, "utf8"), /ENOENT/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("raw AE selection-semantics diagnostic uses one evidence call and one token-owned cleanup", async () => {
  const staleOutput = await mkdtemp(join(process.cwd(), "selection-semantics-stale-"));
  const staleLabel = "stale-evidence";
  try {
    const staleReport = join(staleOutput, `${staleLabel}-report.json`);
    await writeFile(staleReport, '{"passed":true,"status":"passed"}\n');
    const failed = spawnSync(
      process.execPath,
      [
        resolve("scripts/diagnose-ae-selection-semantics.mjs"),
        join(staleOutput, "missing-repo"),
        staleLabel,
        "23.0",
        staleOutput,
      ],
      { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, APPDATA: staleOutput } }
    );
    assert.equal(failed.status, 1);
    assert.deepEqual(JSON.parse(await readFile(staleReport, "utf8")), {
      passed: false,
      status: "running",
      label: staleLabel,
      expectedVersion: "23.0",
      port: "8198",
    });
  } finally {
    await rm(staleOutput, { recursive: true, force: true });
  }
  const source = (
    await readFile(resolve("scripts/diagnose-ae-selection-semantics.mjs"), "utf8")
  ).replace(/\r\n/g, "\n");
  const targetSelectionIndex = source.indexOf("target = await selectCanonicalCdpTarget(");
  const connectIndex = source.indexOf("client = new CdpClient(");
  assert.ok(targetSelectionIndex > 0 && targetSelectionIndex < connectIndex);
  assert.equal(source.includes('pathname.endsWith("/main/index.html")'), false);
  assert.equal((source.match(/\.evalScript\(/g) || []).length, 2);
  assert.equal((source.match(/hostEval\(client, hostSource\)/g) || []).length, 1);
  const dispatchIndex = source.indexOf("hostResult = await hostEval(client, hostSource);");
  const cleanupIndex = source.indexOf("projectCleanup = await client.evaluate", dispatchIndex);
  const closeIndex = source.indexOf("if (client) await client.close()", cleanupIndex);
  const publishIndex = source.lastIndexOf("await writeFile(reportPath");
  assert.ok(dispatchIndex > 0, "probe must dispatch its one evidence host call");
  assert.ok(cleanupIndex > dispatchIndex && closeIndex > cleanupIndex && publishIndex > closeIndex);
  for (const forbidden of [
    "applyPreset(",
    "executeCommand(",
    "app.open(",
    "setTemporaryConfigRoot(",
    "removeOwnedRunDirectory(",
    "rm(scratch",
  ]) {
    assert.equal(
      source.includes(forbidden),
      false,
      `selection-semantics diagnostic contains forbidden operation: ${forbidden}`
    );
  }
  assert.match(source, /MAX_SELECTED_PROPERTIES = 32/);
  assert.match(source, /Selection-semantics label must be a lowercase safe token/);
  assert.match(source, /current-project-not-empty-clean/);
  assert.match(source, /app\.project\.file !== null/);
  assert.match(source, /unexpected-ae-version/);
  assert.ok(
    source.indexOf("app.version !== EXPECTED_VERSION") < source.indexOf("app.beginUndoGroup("),
    "exact AE version must be checked before fixture mutation"
  );
  assert.match(source, /__CHROMA_SELECTION_SEMANTICS_OWNER__/);
  assert.match(source, /comp\.comment =/);
  assert.match(source, /layer\.comment = OWNER_TOKEN/);
  assert.match(source, /var OWNER_TOKEN = \$\{JSON\.stringify\(ownershipToken\)\}/);
  assert.match(source, /item\.comment !==/);
  assert.match(source, /item\.name !== expectedNames\[itemIndex - 1\]/);
  assert.match(source, /root\.numProperties !== 1/);
  assert.match(source, /app\.project\.save\(archive\)/);
  assert.match(source, /app\.project\.close\(CloseOptions\.SAVE_CHANGES\)/);
  const rawCleanupStart = source.indexOf("const cleanupSource =");
  const rawCleanupBody = source.slice(rawCleanupStart, source.indexOf("const caseSpecs =", rawCleanupStart));
  assert.ok(rawCleanupBody.indexOf("app.version !==") < rawCleanupBody.indexOf("if (!app.project)"));
  assert.match(rawCleanupBody, /if \(!app\.project\) \{\s*return JSON\.stringify\(\{ ok: false, reason: "no-project" \}\)/);
  assert.ok(
    rawCleanupBody.indexOf("app.project.save(archive)") <
      rawCleanupBody.indexOf("app.project.close(CloseOptions.SAVE_CHANGES)") &&
      rawCleanupBody.indexOf("app.project.close(CloseOptions.SAVE_CHANGES)") <
      rawCleanupBody.indexOf("delete $.global.__CHROMA_SELECTION_SEMANTICS_OWNER__")
  );
  assert.match(rawCleanupBody, /var closed = app\.project\.close/);
  assert.match(rawCleanupBody, /if \(closed !== true\)/);
  assert.match(source, /stage = "end-undo";\s*undoOpened = false;\s*undoCompletionKnown = false;\s*app\.endUndoGroup\(\);\s*undoCompletionKnown = true;/);
  assert.match(
    source,
    /if \(undoOpened\) \{\s*undoOpened = false;\s*undoCompletionKnown = false;\s*try \{\s*app\.endUndoGroup\(\);\s*undoCompletionKnown = true;/
  );
  assert.match(source, /cleanupSafe: closeError === null && undoCompletionKnown/);
  assert.match(source, /hostCleanupAuthorized = hostResult\?\.cleanupSafe === true/);
  assert.match(source, /if \(client && hostCleanupAuthorized && operationGuard\?\.isCompletionKnown\(\) !== false\)/);
  assert.match(source, /foreign-owner-present/);
  assert.match(rawCleanupBody, /function exactPartialTarget/);
  assert.match(rawCleanupBody, /layerIndex <= item\.numLayers/);
  assert.match(rawCleanupBody, /isFinalOwnedItem &&\s*layerIndex === 1 &&\s*exactPartialTarget/);
  assert.match(rawCleanupBody, /createdKinds = kinds\.slice\(0, item\.numLayers\)/);
  assert.match(source, /throw new Error\("selected-properties-over-limit"\)/);
  assert.match(source, /throw new Error\("selected-property-path-invalid"\)/);
  assert.match(source, /validateHostResult\(hostResult\)/);
  assert.match(source, /installedPanelPath = await realpath/);
  assert.match(source, /targetPanelPath = await realpath\(fileURLToPath\(targetUrl\)\)/);
  assert.match(source, /Main CDP target resolved to the wrong panel/);
  assert.match(source, /groupMatchNamePath/);
  assert.match(source, /leafMatchNamePath/);
  assert.match(source, /current\.matchName !== expectedMatchNames\[index\]/);
  assert.match(source, /harnessHostEvalCount !== 1/);
  assert.match(source, /harnessHostEvalAfterResultCount !== 0/);
  assert.match(source, /for \(const \[phase, path\] of \[\["report", reportPath\], \["failure", failurePath\]\]\)/);
  assert.match(source, /try \{ await writeFile\(path, failureText\); \} catch \(error\)/);
  assert.match(source, /panelConfigChanged: false/);
  for (const caseName of [
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
  ]) {
    assert.match(source, new RegExp(`runCase\\(\"${caseName}\"`));
  }

  const validatorStart = source.indexOf("const caseSpecs = [");
  const validatorEnd = source.indexOf("\n\nlet client = null;", validatorStart);
  assert.ok(validatorStart > 0 && validatorEnd > validatorStart);
  const { caseSpecs, validateHostResult } = new Function(
    `${source.slice(validatorStart, validatorEnd)}\nreturn { caseSpecs, validateHostResult };`
  )();
  const emptySnapshot = () => ({
    selectedLayerCount: 0,
    selectedPropertyCount: 0,
    truncated: false,
    layers: [],
  });
  const selectedSnapshot = (layerCount) => ({
    selectedLayerCount: layerCount,
    selectedPropertyCount: 0,
    truncated: false,
    layers: Array.from({ length: layerCount }, (_, index) => ({
      layerId: 1000 + index,
      layerIndex: index + 1,
      layerName: `Layer ${index + 1}`,
      selected: true,
      properties: [],
    })),
  });
  const validResult = {
    projectItemCount: 10,
    projectDirty: true,
    caseCount: caseSpecs.length,
    cases: caseSpecs.map((spec) => ({
      name: spec.name,
      baseline: emptySnapshot(),
      steps: spec.operations.map(([target, scope, requested]) => ({
        target,
        scope,
        requested,
        selectedAfterSet: requested,
        layerSelectedAfterSet: true,
        snapshot: selectedSnapshot(spec.maximumLayerCount),
      })),
      insideUndo: selectedSnapshot(spec.maximumLayerCount),
      afterUndo: selectedSnapshot(spec.maximumLayerCount),
    })),
  };
  assert.equal(validateHostResult(validResult), null);

  const mutate = (callback) => {
    const candidate = structuredClone(validResult);
    callback(candidate);
    return validateHostResult(candidate);
  };
  assert.match(
    mutate((candidate) => {
      candidate.cases[0].steps[0].target = "stroke";
    }),
    /case-step-invalid-fill-leaf-only/
  );
  assert.match(
    mutate((candidate) => {
      candidate.cases[0].insideUndo.selectedLayerCount = 0;
    }),
    /snapshot-selected-layer-count-mismatch/
  );
  assert.match(
    mutate((candidate) => {
      candidate.cases[8].insideUndo.layers[1].layerId =
        candidate.cases[8].insideUndo.layers[0].layerId;
    }),
    /snapshot-layer-identity-duplicate/
  );
  assert.match(
    mutate((candidate) => {
      candidate.cases[0].afterUndo.truncated = true;
    }),
    /snapshot-missing-or-truncated/
  );
});
