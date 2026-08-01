import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

test("formal runner is import-safe and exposes only the exact no-argument CLI entry point", async () => {
  const source = await readFile(new URL("../scripts/run-live-ae-tests.mjs", import.meta.url), "utf8");
  assert.match(source, /export\s+(?:const|async function)\s+runFormalTrackB/);
  assert.match(source, /process\.argv\.length\s*===\s*2/);
  assert.doesNotMatch(source, /\bcontract\.compatibility\b/);
  assert.match(source, /productContract\.compatibility\.storageDirectory/);
  assert.match(source, /const RUN_TOKEN = `chroma-relay-track-b-/);
  assert.match(source, /const TEMPORARY_PARENT = "\/private\/tmp"/);
  assert.doesNotMatch(source, /resultEvents\[0\]\.message === snapshot\.state\.lastResult/);
  assert.match(source, /`Applied \$\{PALETTE\.length\}-color native gradient`/);
  assert.doesNotMatch(source, /current\.dirty !== false \|\|\s*current\.projectPath/);
  assert.match(source, /var closed = app\.project\.close\(CloseOptions\.SAVE_CHANGES\)/);
  assert.match(source, /if \(closed !== true\)[^]*owned-project-close-refused/);
  assert.match(source, /const postCloseOwnedProjectHash = await sha256/);
  assert.match(source, /saved owned project drifted; temporary archive retained/);
  assert.match(source, /const RESULT_HARNESS_PROPERTIES = Object\.freeze/);
  assert.match(source, /JSON\.stringify\(RESULT_HARNESS_PROPERTIES\)/);
  assert.match(source, /readPaletteResultEvents\(client, \{ allowAbsent: true \}\)/);
  assert.match(source, /import\.meta\.url/);
  assert.doesNotMatch(source, /main\(\)\.catch\(/);
});

test("formal preconditions are read-only and reject stale ownership, non-production state, and target drift", async () => {
  const { validateFormalPreconditions } = await import("../scripts/run-live-ae-tests.mjs");
  const calls = [];
  const result = await validateFormalPreconditions({
    gitHead: "12d32bd11129f66dd9bfd2510154eb2975a10e36",
    gitClean: true,
    lock: null,
    target: {
      url: "file:///repo/dist/cep/main/index.html",
      exact: true,
      panelId: "com.zimoby.chroma-relay.main",
      production: true,
      canonicalUrlVerified: true,
      harnessOwners: {},
    },
    reviewedInputs: {
      manifest: {
        commit: "12d32bd11129f66dd9bfd2510154eb2975a10e36",
        gitClean: true,
        gitHeadBefore: "12d32bd11129f66dd9bfd2510154eb2975a10e36",
        gitHeadAfter: "12d32bd11129f66dd9bfd2510154eb2975a10e36",
      },
    },
    fs: { mkdir: async (...args) => calls.push(["mkdir", ...args]) },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, []);

  await assert.rejects(
    validateFormalPreconditions({
      gitHead: "12d32bd11129f66dd9bfd2510154eb2975a10e36",
      gitClean: true,
      lock: { kind: "foreign", schema: 999 },
      target: { url: "file:///wrong", exact: false, production: false },
      reviewedInputs: { manifest: { commit: "other" } },
      fs: { mkdir: async () => { throw new Error("mutation"); } },
    }),
    /precondition|foreign|production|target/i,
  );
});

test("formal preconditions reject falsy presence of every foreign harness owner", async () => {
  const { validateFormalPreconditions } = await import("../scripts/run-live-ae-tests.mjs");
  await assert.rejects(
    validateFormalPreconditions({
      gitHead: "good",
      gitClean: true,
      lock: null,
      target: {
        url: "file:///repo/dist/cep/main/index.html",
        exact: true,
        production: true,
        canonicalUrlVerified: true,
        panelId: "com.zimoby.chroma-relay.main",
        harnessOwners: { __CP_TRACK_B_RESULT_OWNER__: null },
      },
      reviewedInputs: {
        manifest: {
          commit: "good",
          gitClean: true,
          gitHeadBefore: "good",
          gitHeadAfter: "good",
        },
      },
    }),
    /harness|foreign/i,
  );
});

test("owned event policy accepts product null request IDs only when explicitly expected", async () => {
  const { validateOwnedEventTokens } = await import("../scripts/run-live-ae-tests.mjs");
  assert.deepEqual(
    validateOwnedEventTokens([{ runToken: "run-token-1234567890" }], "run-token-1234567890", 1),
    { count: 1, tokens: ["run-token-1234567890"] },
  );
  assert.deepEqual(
    validateOwnedEventTokens(
      [{ requestId: null }],
      "run-token-1234567890",
      1,
      { allowNullRequestId: true },
    ),
    { count: 1, tokens: [null] },
  );
  for (const events of [
    [{ runToken: null }],
    [{ requestId: "fixed" }],
    [{}],
    [{ runToken: "run-token-1234567890" }, { runToken: "run-token-1234567890" }],
    [{ runToken: "foreign" }],
  ]) {
    assert.throws(() => validateOwnedEventTokens(events, "run-token-1234567890", 1), /token|event/i);
  }
});

test("formal target preflight accepts only file URLs resolving to the canonical production page", async () => {
  const { createTrackBPanelNavigation, verifyCanonicalTargetUrl } = await import(
    "../scripts/run-live-ae-tests.mjs"
  );
  const canonical = join(tmpdir(), "repo", "dist", "cep", "main", "index.html");
  const installed = join(
    tmpdir(),
    "installed",
    "com.zimoby.chroma-relay",
    "main",
    "index.html",
  );
  const installedUrl = pathToFileURL(installed).href;
  const realpathFn = async (path) => (path === installed ? canonical : path);
  assert.equal(
    await verifyCanonicalTargetUrl(installedUrl, canonical, { realpathFn }),
    installedUrl,
  );
  const navigation = createTrackBPanelNavigation(installedUrl, "run-token");
  assert.equal(navigation.productionUrl, installedUrl);
  assert.equal(new URL(navigation.developmentUrl).searchParams.get("track-b"), "run-token");
  assert.equal(new URL(navigation.developmentUrl).pathname, new URL(installedUrl).pathname);
  const encodedInstalled = join(tmpdir(), "installed", "with?#mark", "index.html");
  const encodedCanonical = join(tmpdir(), "repo", "with?#mark", "index.html");
  const encodedUrl = pathToFileURL(encodedInstalled).href;
  assert.equal(
    await verifyCanonicalTargetUrl(encodedUrl, encodedCanonical, {
      realpathFn: async (path) => (path === encodedInstalled ? encodedCanonical : path),
    }),
    encodedUrl,
  );
  for (const suffix of ["?", "#", "?#", "?baseline=1", "#kept-state", "?baseline=1#kept-state"]) {
    await assert.rejects(
      verifyCanonicalTargetUrl(`${installedUrl}${suffix}`, canonical, { realpathFn }),
      /query or fragment/i,
    );
  }
  await assert.rejects(
    verifyCanonicalTargetUrl(
      pathToFileURL(join(tmpdir(), "other", "main", "index.html")).href,
      canonical,
      { realpathFn },
    ),
    /canonical production page/i,
  );
  await assert.rejects(
    verifyCanonicalTargetUrl("https://example.com/main/index.html", canonical, { realpathFn }),
    /file URL|invalid/i,
  );
});

test("formal gradient readback accepts AE eight-decimal serialization but rejects wider drift", async () => {
  const { assertNear } = await import("../scripts/run-live-ae-tests.mjs");
  assert.doesNotThrow(() => assertNear(0.89999998, Math.fround(0.9), "AE readback"));
  assert.throws(() => assertNear(Math.fround(0.9) + 2e-8, Math.fround(0.9), "drift"), /drift/);
});

test("build provenance and reviewed input equality reject stale or changed bytes", async () => {
  const {
    validateBuildProvenance,
    assertReviewedInputsUnchanged,
  } = await import("../scripts/run-live-ae-tests.mjs");
  const assets = [{ path: "main/index.js", size: 1, sha256: "a".repeat(64) }];
  const expected = {
    commit: "good",
    packageJson: { name: "pkg", version: "1.0.0" },
    productContract: { contractVersion: 1 },
    assets,
  };
  const provenance = {
    schemaVersion: 1,
    commit: "good",
    gitClean: true,
    package: expected.packageJson,
    productContract: expected.productContract,
    assets,
  };
  assert.equal(validateBuildProvenance(provenance, expected), true);
  assert.throws(
    () => validateBuildProvenance({ ...provenance, gitClean: false }, expected),
    /provenance|clean|dirty/i,
  );
  assert.throws(
    () => validateBuildProvenance({ ...provenance, commit: "stale" }, expected),
    /provenance|commit/i,
  );
  assert.throws(
    () => assertReviewedInputsUnchanged({ commit: "good", assets }, { commit: "good", assets: [{ ...assets[0], size: 2 }] }),
    /reviewed|manifest|changed/i,
  );
  assert.throws(
    () => validateBuildProvenance({ ...provenance, assets: [{ ...assets[0], sha256: "b".repeat(64) }] }, expected),
    /asset|bytes|provenance/i,
  );
});

test("production preparation binds provenance to a fresh canonical build", async () => {
  const { prepareProductionBuild } = await import("../scripts/run-live-ae-tests.mjs");
  const order = [];
  const result = await prepareProductionBuild({
    build: async () => {
      order.push("build");
      return { command: "npm run build" };
    },
    writeProvenance: async () => {
      order.push("provenance");
      return { schemaVersion: 1, commit: "fresh" };
    },
  });

  assert.deepEqual(order, ["build", "provenance"]);
  assert.deepEqual(result, {
    buildOutput: { command: "npm run build" },
    provenance: { schemaVersion: 1, commit: "fresh" },
  });
});

test("canonical npm builds launch npm-cli through the active Node executable", async () => {
  const { npmRunInvocation } = await import("../scripts/run-live-ae-tests.mjs");
  assert.deepEqual(
    npmRunInvocation("build", {
      nodeExecPath: "C:\\PortableNode\\node.exe",
      npmExecPath: "C:\\PortableNode\\node_modules\\npm\\bin\\npm-cli.js",
    }),
    {
      command: "C:\\PortableNode\\node.exe",
      args: [
        "C:\\PortableNode\\node_modules\\npm\\bin\\npm-cli.js",
        "run",
        "build",
      ],
    },
  );
  assert.deepEqual(
    npmRunInvocation("build", {
      nodeExecPath: "/opt/node/bin/node",
      npmExecPath: "",
    }),
    {
      command: "npm",
      args: ["run", "build"],
    },
  );
});

test("formal Track B restores production through the provenance-bound build helper", async () => {
  const source = await readFile(new URL("../scripts/run-live-ae-tests.mjs", import.meta.url), "utf8");
  const restoreIndex = source.indexOf("const productionPreparation = await prepareProductionBuild();");
  const manifestIndex = source.indexOf(
    'const productionManifestAfter = await createBuildManifest("production-restored");',
    restoreIndex,
  );
  assert.ok(restoreIndex >= 0, "Track B must restore through prepareProductionBuild");
  assert.ok(manifestIndex > restoreIndex, "restored manifest must follow bound provenance generation");
  assert.match(
    source.slice(restoreIndex, manifestIndex),
    /buildOutputs\.push\(productionPreparation\.buildOutput\)/,
  );
});

test("preflight path rejection is read-only and performs zero mutation calls", async () => {
  const { inspectPreflightPaths } = await import("../scripts/run-live-ae-tests.mjs");
  const mutations = [];
  const outputDirectory = "/tmp/s5-output-collision";
  await assert.rejects(
    inspectPreflightPaths({
      evidenceRoot: "/tmp/s5-evidence-root",
      outputDirectory,
      temporaryParent: "/tmp/s5-temporary-parent",
      temporaryRoot: "/tmp/s5-temporary-root",
      lockPath: "/tmp/s5-lock",
      fs: {
        lstat: async (path) => {
          if (path === outputDirectory) return { isSymbolicLink: () => true, isDirectory: () => false };
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        },
        realpath: async (path) => path,
        readFile: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
        mkdir: async (...args) => mutations.push(["mkdir", args]),
        open: async (...args) => mutations.push(["open", args]),
        writeFile: async (...args) => mutations.push(["writeFile", args]),
        rm: async (...args) => mutations.push(["rm", args]),
      },
    }),
    /collision|symlink/i,
  );
  assert.deepEqual(mutations, []);
});

test("finalization stages continue after failures and never publish success after a durability failure", async () => {
  const { runFinalizationStages, publishFinalReport } = await import("../scripts/run-live-ae-tests.mjs");
  const attempts = [];
  const stages = await runFinalizationStages([
    { name: "restore", run: async () => { attempts.push("restore"); throw new Error("restore failed"); } },
    { name: "absence", run: async () => { attempts.push("absence"); } },
    { name: "close", run: async () => { attempts.push("close"); throw new Error("close failed"); } },
  ]);
  assert.deepEqual(attempts, ["restore", "absence", "close"]);
  assert.equal(stages.errors.length, 2);
  const published = await publishFinalReport({
    reportPath: "/tmp/report.json",
    failurePath: "/tmp/failure-report.json",
    report: { passed: true },
    write: async (_path, value) => {
      assert.equal(value.passed, true);
      throw new Error("post-rename directory sync failed");
    },
    remove: async () => { attempts.push("remove-success"); },
    writeFailure: async (_path, value) => {
      attempts.push("failure-evidence");
      assert.equal(value.passed, false);
    },
  });
  assert.equal(published.passed, false);
  assert.ok(attempts.includes("remove-success"));
  assert.ok(attempts.includes("failure-evidence"));
  const removalFailed = await publishFinalReport({
    reportPath: "/tmp/report-2.json",
    failurePath: "/tmp/failure-report-2.json",
    report: { passed: true },
    write: async () => { throw new Error("post-rename sync failed"); },
    remove: async () => { throw new Error("removal failed"); },
    writeFailure: async (path, value) => {
      attempts.push(path);
      assert.equal(value.passed, false);
    },
  });
  assert.equal(removalFailed.passed, false);
  assert.ok(attempts.includes("/tmp/report-2.json"));
});

test("reviewed manifest binds commit, contract, assets, fixture bytes, and exact size/hash", async () => {
  const { createReviewedInputManifest } = await import("../scripts/run-live-ae-tests.mjs");
  const manifest = await createReviewedInputManifest({
    commit: "12d32bd11129f66dd9bfd2510154eb2975a10e36",
    packageJson: { version: "0.0.1" },
    productContract: { marker: { current: "Palette v2" }, schemas: { palette: 3, settings: 5 } },
    assets: [{ path: "main/index.html", bytes: Buffer.from("main") }, { path: "jsx/index.js", bytes: Buffer.from("host") }],
    fixtures: [{ path: "fixture.aep", bytes: Buffer.from("fixture") }],
    templates: [{ path: "fill-template.ffx", bytes: Buffer.from("ffx") }],
  });
  assert.equal(manifest.commit, "12d32bd11129f66dd9bfd2510154eb2975a10e36");
  assert.equal(manifest.assets[0].size, 4);
  assert.match(manifest.assets[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(manifest.templates[0].size, 3);
});

test("reviewed FFX inputs bind to the exact built AE family instead of the first basename", async () => {
  const { findBuiltTemplateForReviewedSource } = await import("../scripts/run-live-ae-tests.mjs");
  const files = [
    {
      relativePath: "assets/native-gradient/ae22-6/fill-template.ffx",
      size: 22,
      sha256: "2".repeat(64),
    },
    {
      relativePath: "assets/native-gradient/ae25-6/fill-template.ffx",
      size: 25,
      sha256: "5".repeat(64),
    },
  ];

  assert.equal(
    findBuiltTemplateForReviewedSource(
      files,
      "C:\\workspace\\node_modules\\@zimoby\\ae-native-gradient\\templates\\ae25-6\\fill.ffx",
    ),
    files[1],
  );
  assert.equal(
    findBuiltTemplateForReviewedSource(
      files,
      "C:\\workspace\\node_modules\\@zimoby\\ae-native-gradient\\fixtures\\native-gradient\\ae25-6\\fill-template.ffx",
    ),
    files[1],
  );
  assert.throws(
    () => findBuiltTemplateForReviewedSource(files, "/package/templates/ae26-3/fill.ffx"),
    /exactly one|ae26-3/i,
  );
});

test("cleanup only applies current owned children and never removes the caller root", async () => {
  const { inspectCleanupRoots } = await import("../scripts/cleanup-live-test-residue.mjs");
  const { createOwnedRunDirectory } = await import("../scripts/lib/live-runner-policy.mjs");
  const root = await mkdtemp(join(tmpdir(), "chroma-relay-s5-cleanup-"));
  const owned = await createOwnedRunDirectory(root, { tokenFactory: () => "owned-child" });
  await writeFile(join(root, "foreign-child"), "foreign\n");
  const outside = await mkdtemp(join(tmpdir(), "chroma-relay-s5-outside-"));
  await writeFile(join(outside, "sentinel"), "preserve\n");
  await symlink(outside, join(root, "symlink-child"));
  try {
    const dry = await inspectCleanupRoots({
      roots: [root],
      apply: false,
      processAlive: () => false,
    });
    assert.equal(dry.mutated, false);
    assert.equal(dry.candidates[0].candidate, owned.path);
    assert.ok(dry.refusals.some(({ reason }) => /missing|symlink|not a directory/.test(reason)));
    const applied = await inspectCleanupRoots({
      roots: [root],
      apply: true,
      processAlive: () => false,
    });
    assert.deepEqual(applied.removed, [owned.path]);
    assert.equal(applied.mutated, true);
    await assert.rejects(readFile(owned.markerPath));
    await assert.doesNotReject(readFile(join(root, "foreign-child")));
    assert.equal(await readFile(join(outside, "sentinel"), "utf8"), "preserve\n");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("cleanup apply refuses active owned runs until the age lease expires", async () => {
  const { inspectCleanupRoots } = await import("../scripts/cleanup-live-test-residue.mjs");
  const { createOwnedRunDirectory } = await import("../scripts/lib/live-runner-policy.mjs");
  const root = await mkdtemp(join(tmpdir(), "chroma-relay-s5-active-cleanup-"));
  const owned = await createOwnedRunDirectory(root, { tokenFactory: () => "active-owned-child" });
  const marker = JSON.parse(await readFile(owned.markerPath, "utf8"));
  const createdAt = Date.parse(marker.createdAt);
  try {
    const active = await inspectCleanupRoots({
      roots: [root],
      apply: true,
      now: createdAt + 1_000,
      minimumAgeMs: 60_000,
      processAlive: () => true,
    });
    assert.deepEqual(active.removed, []);
    assert.equal(active.mutated, false);
    assert.match(active.refusals[0].reason, /active|grace period/);
    await assert.doesNotReject(readFile(owned.markerPath));

    const stale = await inspectCleanupRoots({
      roots: [root],
      apply: true,
      now: createdAt + 60_001,
      minimumAgeMs: 60_000,
      processAlive: () => false,
    });
    assert.deepEqual(stale.removed, [owned.path]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cleanup root filters discover current Track B topology without inspecting foreign temp children", async () => {
  const { inspectCleanupRoots } = await import("../scripts/cleanup-live-test-residue.mjs");
  const { createOwnedRunDirectory } = await import("../scripts/lib/live-runner-policy.mjs");
  const root = await mkdtemp(join(tmpdir(), "chroma-relay-s5-topology-"));
  const current = await createOwnedRunDirectory(root, {
    tokenFactory: () => "chroma-relay-track-b-current",
  });
  const otherOwned = await createOwnedRunDirectory(root, {
    tokenFactory: () => "other-owned-child",
  });

  try {
    const roots = [{ path: root, prefix: "chroma-relay-track-b-" }];
    const dry = await inspectCleanupRoots({ roots, apply: false, processAlive: () => false });
    assert.deepEqual(dry.candidates.map(({ candidate }) => candidate), [current.path]);
    assert.deepEqual(dry.refusals, []);
    assert.deepEqual(dry.rootFilters, roots);

    const applied = await inspectCleanupRoots({ roots, apply: true, processAlive: () => false });
    assert.deepEqual(applied.removed, [current.path]);
    await assert.rejects(readFile(current.markerPath));
    await assert.doesNotReject(readFile(otherOwned.markerPath));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("default cleanup roots keep distinct private tmp scope Track-B-only", async () => {
  const { buildDefaultCleanupRootSpecifications } = await import(
    "../scripts/cleanup-live-test-residue.mjs"
  );
  const distinct = buildDefaultCleanupRootSpecifications({
    canonicalTemporaryRoot: "/canonical/os/tmp",
    evidenceRoot: "/evidence",
    trackBTemporaryRoot: "/private/tmp",
  });
  assert.deepEqual(distinct, [
    { path: "/evidence", prefix: "chroma-relay-track-b-" },
    { path: "/private/tmp", prefix: "chroma-relay-track-b-" },
    { path: "/canonical/os/tmp", prefix: "chroma-relay-" },
  ]);

  const shared = buildDefaultCleanupRootSpecifications({
    canonicalTemporaryRoot: "/private/tmp",
    evidenceRoot: "/evidence",
    trackBTemporaryRoot: "/private/tmp",
  });
  assert.deepEqual(shared, [
    { path: "/evidence", prefix: "chroma-relay-track-b-" },
    { path: "/private/tmp", prefix: "chroma-relay-" },
  ]);
});
