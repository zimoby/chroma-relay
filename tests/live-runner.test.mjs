import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

test("formal runner is import-safe and exposes only the exact no-argument CLI entry point", async () => {
  const source = await readFile(new URL("../scripts/run-live-ae-tests.mjs", import.meta.url), "utf8");
  assert.match(source, /export\s+(?:const|async function)\s+runFormalTrackB/);
  assert.match(source, /process\.argv\.length\s*===\s*2/);
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
    productContract: { marker: { current: "Palette v2" }, schemas: { palette: 3, settings: 4 } },
    assets: [{ path: "main/index.html", bytes: Buffer.from("main") }, { path: "jsx/index.js", bytes: Buffer.from("host") }],
    fixtures: [{ path: "fixture.aep", bytes: Buffer.from("fixture") }],
    templates: [{ path: "fill-template.ffx", bytes: Buffer.from("ffx") }],
  });
  assert.equal(manifest.commit, "12d32bd11129f66dd9bfd2510154eb2975a10e36");
  assert.equal(manifest.assets[0].size, 4);
  assert.match(manifest.assets[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(manifest.templates[0].size, 3);
});

test("cleanup is dry-run by default and refuses foreign, stale, symlink, and out-of-root candidates", async () => {
  const { inspectCleanupRoots } = await import("../scripts/cleanup-live-test-residue.mjs");
  const report = await inspectCleanupRoots({ roots: [], apply: false });
  assert.equal(report.mode, "dry-run");
  assert.equal(report.mutated, false);
  assert.ok(Array.isArray(report.candidates));
  assert.ok(Array.isArray(report.refusals));
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
    const dry = await inspectCleanupRoots({ roots: [root], apply: false });
    assert.equal(dry.mutated, false);
    assert.equal(dry.candidates[0].candidate, owned.path);
    assert.ok(dry.refusals.some(({ reason }) => /missing|symlink|not a directory/.test(reason)));
    const applied = await inspectCleanupRoots({ roots: [root], apply: true });
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

test("package scripts document static proof and explicit live parent gate", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.scripts["test:live-runner"], "node --test tests/live-runner.test.mjs");
  assert.equal(packageJson.scripts["cleanup:live-test-residue"], "node scripts/cleanup-live-test-residue.mjs");
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /dry-run/i);
  assert.match(readme, /--apply/);
  assert.match(readme, /parent.*gate|explicit.*live/i);
});
