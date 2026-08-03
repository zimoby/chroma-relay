import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { lstat, mkdir, mkdtemp, readlink, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";

import {
  BUILD_SCRIPT,
  IsolatedBuildSignalError,
  ISOLATION_HOME_PREFIX,
  createNpmBuildInvocation,
  deriveCepExtensionLinkPath,
  runIsolatedBuild,
  spawnNpm,
} from "../scripts/lib/isolated-build.mjs";
import { runBuildCli } from "../scripts/build-isolated.mjs";

const exists = async (path) => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
};

const makeFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "chroma-relay-isolated-test-"));
  const outputPath = join(root, "dist", "cep");
  const realLink = join(root, "installed", "com.zimoby.chroma-relay");
  await mkdir(outputPath, { recursive: true });
  await mkdir(join(root, "installed"), { recursive: true });
  await symlink(outputPath, realLink);
  return { root, outputPath, realLink };
};

const cleanupFixture = (fixture) => rm(fixture.root, { recursive: true, force: true });

const makeFixtureFs = (fixture, { cleanupError = null, onCleanup = () => {} } = {}) => {
  let ownedHome;
  return {
    lstat,
    readlink,
    realpath,
    mkdtemp: async () => {
      ownedHome = join(fixture.root, "owned-build-home");
      await mkdir(ownedHome);
      return ownedHome;
    },
    rm: async (path, options) => {
      if (path === ownedHome) {
        onCleanup();
        await rm(path, options);
        if (cleanupError) throw cleanupError;
        return;
      }
      return rm(path, options);
    },
    get ownedHome() {
      return ownedHome;
    },
  };
};

test("isolated build succeeds, uses an owned home, and removes it", async () => {
  const fixture = await makeFixture();
  let childHome;
  try {
    const result = await runIsolatedBuild({
      repositoryRoot: fixture.root,
      outputPath: fixture.outputPath,
      realInstalledLinkPath: fixture.realLink,
      platform: "darwin",
      env: { npm_execpath: "/owned/npm-cli.js" },
      runChild: async (invocation, { env }) => {
        childHome = env.HOME;
        assert.deepEqual(invocation.args, ["/owned/npm-cli.js", "run", BUILD_SCRIPT]);
        const linkPath = deriveCepExtensionLinkPath({ platform: "darwin", homedirPath: childHome });
        await mkdir(posix.dirname(linkPath), { recursive: true });
        await symlink(fixture.outputPath, linkPath);
        return { code: 0 };
      },
    });
    assert.equal(result.installedTarget.path, fixture.realLink);
    assert.equal(await readlink(fixture.realLink), fixture.outputPath);
    assert.equal(await exists(childHome), false);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("isolated build rejects a missing or wrong compiler-created link and cleans up", async () => {
  for (const mode of ["missing", "wrong"]) {
    const fixture = await makeFixture();
    let childHome;
    try {
      await assert.rejects(
        runIsolatedBuild({
          repositoryRoot: fixture.root,
          outputPath: fixture.outputPath,
          realInstalledLinkPath: fixture.realLink,
          platform: "darwin",
          runChild: async (_invocation, { env }) => {
            childHome = env.HOME;
            if (mode === "wrong") {
              const linkPath = deriveCepExtensionLinkPath({ platform: "darwin", homedirPath: childHome });
              const wrong = join(fixture.root, "wrong-output");
              await mkdir(wrong, { recursive: true });
              await mkdir(posix.dirname(linkPath), { recursive: true });
              await symlink(wrong, linkPath);
            }
            return { code: 0 };
          },
        }),
        /Isolated CEP link is missing|target mismatch/,
        mode,
      );
      assert.equal(await exists(childHome), false, mode);
    } finally {
      await cleanupFixture(fixture);
    }
  }
});

test("isolated build fails closed on compiler failure while preserving the real link", async () => {
  const fixture = await makeFixture();
  let childHome;
  try {
    await assert.rejects(
      runIsolatedBuild({
        repositoryRoot: fixture.root,
        outputPath: fixture.outputPath,
        realInstalledLinkPath: fixture.realLink,
        runChild: async (_invocation, { env }) => {
          childHome = env.HOME;
          return { code: 23, signal: null };
        },
      }),
      /failed with exit 23/,
    );
    assert.equal(await readlink(fixture.realLink), fixture.outputPath);
    assert.equal(await exists(childHome), false);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("isolated build rethrows cleanup-only failures after removing the owned home", async () => {
  const fixture = await makeFixture();
  const cleanupError = new Error("owned-home cleanup failed");
  const fixtureFs = makeFixtureFs(fixture, { cleanupError });
  try {
    await assert.rejects(
      runIsolatedBuild({
        repositoryRoot: fixture.root,
        outputPath: fixture.outputPath,
        realInstalledLinkPath: fixture.realLink,
        platform: "darwin",
        fs: fixtureFs,
        runChild: async (_invocation, { env }) => {
          const linkPath = deriveCepExtensionLinkPath({ platform: "darwin", homedirPath: env.HOME });
          await mkdir(posix.dirname(linkPath), { recursive: true });
          await symlink(fixture.outputPath, linkPath);
          return { code: 0 };
        },
      }),
      (error) => error === cleanupError,
    );
    assert.equal(await exists(fixtureFs.ownedHome), false);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("isolated build aggregates primary and cleanup failures with the primary first", async () => {
  const fixture = await makeFixture();
  const cleanupError = new Error("owned-home cleanup failed");
  const fixtureFs = makeFixtureFs(fixture, { cleanupError });
  try {
    await assert.rejects(
      runIsolatedBuild({
        repositoryRoot: fixture.root,
        outputPath: fixture.outputPath,
        realInstalledLinkPath: fixture.realLink,
        fs: fixtureFs,
        runChild: async () => ({ code: 23 }),
      }),
      (error) => {
        assert.equal(error instanceof AggregateError, true);
        assert.equal(error.errors.length, 2);
        assert.match(error.errors[0].message, /failed with exit 23/);
        assert.equal(error.errors[1], cleanupError);
        return true;
      },
    );
    assert.equal(await exists(fixtureFs.ownedHome), false);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("isolated build aggregates primary, drift, and cleanup failures in deterministic order", async () => {
  const fixture = await makeFixture();
  const cleanupError = new Error("owned-home cleanup failed");
  const fixtureFs = makeFixtureFs(fixture, { cleanupError });
  try {
    await assert.rejects(
      runIsolatedBuild({
        repositoryRoot: fixture.root,
        outputPath: fixture.outputPath,
        realInstalledLinkPath: fixture.realLink,
        platform: "darwin",
        fs: fixtureFs,
        runChild: async () => {
          const driftTarget = join(fixture.root, "drift-output");
          await mkdir(driftTarget, { recursive: true });
          await rm(fixture.realLink);
          await symlink(driftTarget, fixture.realLink);
          return { code: 23 };
        },
      }),
      (error) => {
        assert.equal(error instanceof AggregateError, true);
        assert.equal(error.errors.length, 3);
        assert.match(error.errors[0].message, /failed with exit 23/);
        assert.match(error.errors[1].message, /installed.*drifted/i);
        assert.equal(error.errors[2], cleanupError);
        return true;
      },
    );
    assert.equal(await exists(fixtureFs.ownedHome), false);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("isolated build preserves a child spawn error and cleans up without starting the compiler", async () => {
  const fixture = await makeFixture();
  const spawnError = new Error("npm spawn failed");
  const fixtureFs = makeFixtureFs(fixture);
  try {
    await assert.rejects(
      runIsolatedBuild({
        repositoryRoot: fixture.root,
        outputPath: fixture.outputPath,
        realInstalledLinkPath: fixture.realLink,
        fs: fixtureFs,
        spawnImpl: () => {
          const child = new EventEmitter();
          queueMicrotask(() => child.emit("error", spawnError));
          return child;
        },
      }),
      (error) => error === spawnError,
    );
    assert.equal(await exists(fixtureFs.ownedHome), false);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("isolated build aborts and awaits the child once, keeps repeated signals trapped, then reports signal exit", async () => {
  const fixture = await makeFixture();
  const processApi = new EventEmitter();
  processApi.pid = 4242;
  const lifecycle = [];
  const fixtureFs = makeFixtureFs(fixture, { onCleanup: () => lifecycle.push("cleanup") });
  try {
    await assert.rejects(
      runIsolatedBuild({
        repositoryRoot: fixture.root,
        outputPath: fixture.outputPath,
        realInstalledLinkPath: fixture.realLink,
        fs: fixtureFs,
        processApi,
        spawnImpl: (_command, _args, options) => {
          const child = new EventEmitter();
          lifecycle.push("spawn");
          options.signal.addEventListener("abort", () => {
            lifecycle.push("abort");
            queueMicrotask(() => {
              lifecycle.push("exit");
              child.emit("exit", null, "SIGTERM");
            });
          }, { once: true });
          queueMicrotask(() => {
            lifecycle.push("signal");
            processApi.emit("SIGTERM");
            processApi.emit("SIGTERM");
          });
          return child;
        },
      }),
      (error) => error instanceof IsolatedBuildSignalError && error.signal === "SIGTERM",
    );
    assert.deepEqual(lifecycle, ["spawn", "signal", "abort", "exit", "cleanup"]);
    assert.equal(processApi.listenerCount("SIGINT"), 0);
    assert.equal(processApi.listenerCount("SIGTERM"), 0);
    assert.equal(await exists(fixtureFs.ownedHome), false);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("signal during temporary-home allocation is trapped, cleaned, and never launches the compiler", async () => {
  const fixture = await makeFixture();
  const processApi = new EventEmitter();
  processApi.pid = 4242;
  const fixtureFs = makeFixtureFs(fixture);
  const allocateOwnedHome = fixtureFs.mkdtemp;
  fixtureFs.mkdtemp = async (...args) => {
    const ownedHome = await allocateOwnedHome(...args);
    processApi.emit("SIGINT");
    return ownedHome;
  };
  let childRan = false;
  try {
    await assert.rejects(
      runIsolatedBuild({
        repositoryRoot: fixture.root,
        outputPath: fixture.outputPath,
        realInstalledLinkPath: fixture.realLink,
        fs: fixtureFs,
        processApi,
        runChild: async () => {
          childRan = true;
          return { code: 0 };
        },
      }),
      (error) => error instanceof IsolatedBuildSignalError && error.signal === "SIGINT",
    );
    assert.equal(childRan, false);
    assert.equal(await exists(fixtureFs.ownedHome), false);
    assert.equal(processApi.listenerCount("SIGINT"), 0);
    assert.equal(processApi.listenerCount("SIGTERM"), 0);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("build CLI re-raises the trapped signal through the process API", async () => {
  const processApi = { pid: 4242, killed: [] };
  processApi.kill = (pid, signal) => processApi.killed.push({ pid, signal });
  await runBuildCli({
    processApi,
    runBuild: async () => {
      throw new IsolatedBuildSignalError("SIGINT");
    },
  });
  assert.deepEqual(processApi.killed, [{ pid: 4242, signal: "SIGINT" }]);
});

test("spawnNpm waits for an aborted child exit after its AbortError", async () => {
  const child = new EventEmitter();
  const abortController = new AbortController();
  const spawnError = Object.assign(new Error("aborted"), { name: "AbortError" });
  const result = spawnNpm(
    { command: "npm", args: ["run", BUILD_SCRIPT] },
    {
      cwd: "/repo",
      env: {},
      signal: abortController.signal,
      spawnImpl: () => {
        queueMicrotask(() => {
          child.emit("error", spawnError);
          child.emit("exit", null, "SIGTERM");
        });
        return child;
      },
    },
  );
  abortController.abort();
  await assert.rejects(result, (error) => error === spawnError);
});

test("isolated build detects real installed-link mutation after the child exits", async () => {
  const fixture = await makeFixture();
  try {
    await assert.rejects(
      runIsolatedBuild({
        repositoryRoot: fixture.root,
        outputPath: fixture.outputPath,
        realInstalledLinkPath: fixture.realLink,
        runChild: async (_invocation, { env }) => {
          const linkPath = deriveCepExtensionLinkPath({ platform: "darwin", homedirPath: env.HOME });
          await mkdir(posix.dirname(linkPath), { recursive: true });
          await symlink(fixture.outputPath, linkPath);
          const driftTarget = join(fixture.root, "drift-output");
          await mkdir(driftTarget, { recursive: true });
          await rm(fixture.realLink);
          await symlink(driftTarget, fixture.realLink);
          return { code: 0 };
        },
      }),
      /installed.*drifted/i,
    );
  } finally {
    await cleanupFixture(fixture);
  }
});

test("npm invocation reuses the current CLI and has Unix/Windows fallbacks", () => {
  assert.deepEqual(
    createNpmBuildInvocation({ execPath: "/node", env: { npm_execpath: "/npm-cli.js" }, platform: "darwin" }),
    { command: "/node", args: ["/npm-cli.js", "run", BUILD_SCRIPT] },
  );
  assert.deepEqual(
    createNpmBuildInvocation({ env: { npm_execpath: "" }, platform: "darwin" }),
    { command: "npm", args: ["run", BUILD_SCRIPT] },
  );
  assert.deepEqual(
    createNpmBuildInvocation({ env: { npm_execpath: "" }, platform: "win32" }),
    { command: "npm.cmd", args: ["run", BUILD_SCRIPT] },
  );
});

test("CEP link derivation matches the plugin’s macOS and Windows local folders", () => {
  assert.equal(
    deriveCepExtensionLinkPath({ platform: "darwin", homedirPath: "/Users/runner" }),
    "/Users/runner/Library/Application Support/Adobe/CEP/extensions/com.zimoby.chroma-relay",
  );
  assert.equal(
    deriveCepExtensionLinkPath({ platform: "win32", homedirPath: "C:\\Users\\runner" }),
    "C:\\Users\\runner\\AppData\\Roaming\\Adobe\\CEP\\extensions\\com.zimoby.chroma-relay",
  );
});

test("temporary build homes use the required owned prefix", () => {
  assert.match(ISOLATION_HOME_PREFIX, /^chroma-relay-build-home-$/);
});
