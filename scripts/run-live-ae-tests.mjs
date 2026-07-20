#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  indexAepNativeGradientTargets,
  parseRifx,
  resolveAepNativeGradientTarget,
} from "@zimoby/ae-native-gradient";
import packageJson from "../package.json" with { type: "json" };
import productContract from "../src/shared/product-contract.json" with { type: "json" };
import { CDPClient } from "./lib/cdp-client.mjs";
import {
  createOwnedRunDirectory,
  removeOwnedRunDirectory,
  RunnerPolicyError,
} from "./lib/live-runner-policy.mjs";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const FIXTURE_SOURCE = resolve(
  REPO_ROOT,
  "tests/fixtures/native-gradient/exact-identity-ae25.aep"
);
const EXPECTED_SOURCE = resolve(
  REPO_ROOT,
  "tests/fixtures/native-gradient/exact-identity-ae25.expected.json"
);
const FILL_TEMPLATE = resolve(REPO_ROOT, "src/assets/native-gradient/ae25-6/fill-template.ffx");
const STROKE_TEMPLATE = resolve(REPO_ROOT, "src/assets/native-gradient/ae25-6/stroke-template.ffx");
const REVIEWED_INPUTS = Object.freeze({
  fixture: {
    path: FIXTURE_SOURCE,
    sha256: "9a2bfccb07eab5cfaab2ee18ad0565787ab4f6bdc70788085881b3b456d04267",
  },
  expectation: {
    path: EXPECTED_SOURCE,
    sha256: "6aea60d310c1e2a45029a58b806155eb06e7646fea3befc26dad6553ca3f0bbb",
  },
  fillTemplate: {
    path: FILL_TEMPLATE,
    sha256: "a0cddaf936cc337a427d3a81c4224764fd6fc1f13a9bbeb6ae863276fa28dc59",
  },
  strokeTemplate: {
    path: STROKE_TEMPLATE,
    sha256: "cb1ffe6195604834203a950433a83dd7097e971f8477567fdc2c32e3c34ed9dd",
  },
});
const RUN_TOKEN = `track-b-${Date.now().toString(36)}-${randomBytes(8).toString("hex")}`;
const EVIDENCE_ROOT = resolve(REPO_ROOT, "evidence/local/native-gradient/track-b-apply-ae25");
const OUTPUT_DIRECTORY = resolve(EVIDENCE_ROOT, RUN_TOKEN);
const TEMPORARY_PARENT = "/private/tmp/chroma-relay-native-gradient-apply";
const TEMPORARY_ROOT = resolve(TEMPORARY_PARENT, RUN_TOKEN);
const LOCK_PATH = "/private/tmp/chroma-relay-native-gradient-apply.lock";
const BUILD_ROOT = resolve(REPO_ROOT, "dist/cep");
const MAIN_PAGE = resolve(BUILD_ROOT, "main/index.html");
const BUILD_PROVENANCE_PATH = resolve(BUILD_ROOT, ".chroma-relay-build-provenance.json");
const ACTION_MENU_ID = "apply-active-palette-gradient";
const EXPECTED_BUILD_MARKER = `${productContract.marker.current} · ${packageJson.version}`;
const LOCK_MARKER = Object.freeze({
  kind: productContract.runner.ownershipKind,
  schema: productContract.runner.ownershipSchema,
  contractVersion: productContract.contractVersion,
  marker: productContract.marker.current,
  markerFile: productContract.runner.markerFile,
  token: RUN_TOKEN,
});
const PALETTE = [
  { id: "track-b-a", rgba: [0.125, 0.25, 0.5, 0.2] },
  { id: "track-b-b", rgba: [0.75, 0.125, 0.375, 0.6] },
  { id: "track-b-c", rgba: [0.9, 0.8, 0.1, 1] },
];
const execFileAsync = promisify(execFile);

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
const waitUntil = async (read, timeoutMs, label) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const value = await read();
    if (value) return value;
    await delay(50);
  }
  fail(`Timed out waiting for ${label}`);
};
const requireAbsent = async (path, label) => {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  fail(`${label} remains at ${path}`);
};
const sha256 = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");
const fail = (message) => {
  throw new Error(message);
};
const requireCondition = (condition, message) => {
  if (!condition) fail(message);
};
const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const isContainedPath = (root, candidate) => {
  const fromRoot = relative(root, candidate);
  return fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
};
const readExistingLock = async () => {
  let stat;
  try {
    stat = await lstat(LOCK_PATH);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  requireCondition(!stat.isSymbolicLink() && stat.isFile(), "Track B lock is not a regular file");
  let marker;
  try {
    marker = JSON.parse(await readFile(LOCK_PATH, "utf8"));
  } catch {
    throw new RunnerPolicyError("Track B lock marker is malformed or stale");
  }
  requireCondition(
    marker?.kind === productContract.runner.ownershipKind &&
      marker?.schema === productContract.runner.ownershipSchema &&
      marker?.contractVersion === productContract.contractVersion &&
      marker?.marker === productContract.marker.current &&
      marker?.markerFile === productContract.runner.markerFile,
    "Track B lock marker is foreign or stale"
  );
  return marker;
};
const sha256Bytes = (bytes) => createHash("sha256").update(bytes).digest("hex");
const describeBytes = (path, bytes) => ({
  path,
  size: bytes.byteLength,
  sha256: sha256Bytes(bytes),
});
const describeFile = async (path) => describeBytes(path, await readFile(path));

const KNOWN_HARNESS_PROPERTIES = Object.freeze([
  "__CP_TRACK_B_RUN_TOKEN__",
  "__CP_TRACK_B_INJECTION_OWNER__",
  "__CP_TRACK_B_ORIGINAL_EVAL_SCRIPT__",
  "__CP_TRACK_B_INJECTION_COUNT__",
  "__CP_TRACK_B_PENDING_CALLBACK__",
  "__CP_TRACK_B_RESULT_OWNER__",
  "__CP_TRACK_B_RESULT_CSI__",
  "__CP_TRACK_B_RESULT_HANDLER__",
  "__CP_TRACK_B_RESULT_EVENTS__",
  "__CP_TRACK_B_RESULT_TOKENS__",
  "__CP_TRACK_B_PROJECT_OWNER__",
  "injection",
  "listener",
  "project",
]);

const hasProperty = (value, property) =>
  value !== null && value !== undefined &&
  (Object.prototype.hasOwnProperty.call(Object(value), property) || property in Object(value));

export const assertNoHarnessProperties = (properties = {}) => {
  const present = KNOWN_HARNESS_PROPERTIES.filter((property) =>
    typeof properties[property] === "boolean"
      ? properties[property]
      : hasProperty(properties, property)
  );
  if (present.length > 0) {
    throw new RunnerPolicyError(`Foreign Track B harness properties are present: ${present.join(", ")}`);
  }
  return true;
};

export const validateOwnedEventTokens = (
  events,
  runToken,
  expectedCount,
  { allowNullRequestId = false } = {},
) => {
  if (typeof runToken !== "string" || runToken.length < 16) {
    throw new RunnerPolicyError("Owned event validation requires a cryptographic run token");
  }
  if (!Array.isArray(events) || events.length !== expectedCount) {
    throw new RunnerPolicyError(`Expected exactly ${expectedCount} owned events`);
  }
  const tokens = events.map((event) => {
    const token = event && event.runToken !== undefined ? event.runToken : event?.requestId;
    if (allowNullRequestId && token === null) return null;
    if (token !== runToken) throw new RunnerPolicyError(`Missing or foreign event token: ${String(token)}`);
    return token;
  });
  if (!allowNullRequestId && new Set(tokens).size !== tokens.length) {
    throw new RunnerPolicyError("Duplicate owned event token");
  }
  return { count: tokens.length, tokens };
};

export const assertReviewedInputsUnchanged = (start, end) => {
  if (!sameJson(start, end)) throw new RunnerPolicyError("Reviewed input manifest changed during Track B");
  return true;
};

export const validateBuildProvenance = (provenance, expected) => {
  if (!provenance || provenance.schemaVersion !== 1) {
    throw new RunnerPolicyError("Build provenance is missing or has an unsupported schema");
  }
  if (provenance.commit !== expected.commit) {
    throw new RunnerPolicyError("Build provenance commit is stale");
  }
  if (provenance.gitClean !== true) {
    throw new RunnerPolicyError("Build provenance was produced from a dirty worktree");
  }
  const packageValue = provenance.package?.value || provenance.package;
  const contractValue = provenance.productContract?.value || provenance.productContract;
  if (!sameJson(packageValue, expected.packageJson)) {
    throw new RunnerPolicyError("Build provenance package contract drifted");
  }
  if (!sameJson(contractValue, expected.productContract)) {
    throw new RunnerPolicyError("Build provenance product contract drifted");
  }
  if (expected.packageFile &&
      (provenance.package?.size !== expected.packageFile.size || provenance.package?.sha256 !== expected.packageFile.sha256)) {
    throw new RunnerPolicyError("Build provenance package bytes drifted");
  }
  if (expected.contractFile &&
      (provenance.productContract?.size !== expected.contractFile.size || provenance.productContract?.sha256 !== expected.contractFile.sha256)) {
    throw new RunnerPolicyError("Build provenance product-contract bytes drifted");
  }
  const actualAssets = (provenance.assets || []).map(({ path, size, sha256 }) => ({ path, size, sha256 }));
  const expectedAssets = (expected.assets || []).map(({ path, size, sha256 }) => ({ path, size, sha256 }));
  if (!sameJson(actualAssets, expectedAssets)) {
    throw new RunnerPolicyError("Build provenance asset bytes drifted");
  }
  return true;
};

export const runFinalizationStages = async (stages = []) => {
  const results = [];
  const errors = [];
  for (const stage of stages) {
    try {
      results.push({ name: stage.name, value: await stage.run() });
    } catch (error) {
      errors.push({
        stage: stage.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { results, errors };
};

export const publishFinalReport = async ({
  reportPath,
  failurePath,
  report,
  write,
  writeFailure,
  remove,
} = {}) => {
  const writeReport = write || ((path, value) => writeDurableJson(path, value));
  const writeFailureReport = writeFailure || ((path, value) => writeDurableJson(path, value, { overwrite: true }));
  const removeSuccess = remove || ((path) => rm(path, { force: false }));
  try {
    await writeReport(reportPath, report);
    return { passed: report?.passed === true, errors: [] };
  } catch (error) {
    const errors = [{ stage: "report-publication", error: error instanceof Error ? error.message : String(error) }];
    let successRemovalFailed = false;
    if (error?.code !== "EEXIST") {
      try {
        await removeSuccess(reportPath);
      } catch (removeError) {
        if (removeError?.code !== "ENOENT") {
          successRemovalFailed = true;
          errors.push({ stage: "success-report-removal", error: removeError instanceof Error ? removeError.message : String(removeError) });
        }
      }
    }
    try {
      await writeFailureReport(failurePath, {
        ...report,
        passed: false,
        failure: "Durable success publication failed",
        secondaryFailures: errors,
      });
    } catch (failureError) {
      errors.push({ stage: "failure-report-publication", error: failureError instanceof Error ? failureError.message : String(failureError) });
    }
    if (successRemovalFailed) {
      try {
        await writeFailureReport(reportPath, {
          ...report,
          passed: false,
          failure: "Durable success publication failed and removal was incomplete",
          secondaryFailures: errors,
        });
      } catch (downgradeError) {
        errors.push({ stage: "success-report-downgrade", error: downgradeError instanceof Error ? downgradeError.message : String(downgradeError) });
      }
    }
    return { passed: false, errors };
  }
};

const readGitState = async () => {
  const { stdout: head } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT });
  const { stdout: status } = await execFileAsync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: REPO_ROOT },
  );
  return { head: head.trim(), clean: status.trim() === "", status: status.trim() };
};

const readBuildProvenance = async () => {
  try {
    return JSON.parse(await readFile(BUILD_PROVENANCE_PATH, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") throw new RunnerPolicyError("Commit-bearing build provenance is missing");
    throw error;
  }
};

const syncDirectoryDurably = async (directoryPath) => {
  // Node cannot fsync directory handles on Windows; the file itself is
  // still flushed before the atomic rename on every platform.
  if (process.platform === "win32") return;
  const directoryHandle = await open(directoryPath, "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
};

const writeAtomicallyDurableJson = async (path, value) => {
  const temporaryPath = `${path}.${RUN_TOKEN}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, path);
  await syncDirectoryDurably(dirname(path));
};

export const createReviewedInputManifest = async (input = {}) => {
  if (input.assets || input.fixtures || input.templates) {
    const describeEntries = (entries = []) => entries.map((entry) =>
      describeBytes(entry.path, entry.bytes instanceof Uint8Array ? entry.bytes : Buffer.from(entry.bytes))
    );
    return {
      schemaVersion: 1,
      commit: input.commit,
      package: input.packageJson || null,
      productContract: input.productContract || null,
      assets: describeEntries(input.assets),
      fixtures: describeEntries(input.fixtures),
      templates: describeEntries(input.templates),
      ffx: describeEntries(input.templates),
    };
  }

  const gitStart = await readGitState();
  const build = await createBuildManifest("reviewed-production");
  const packageFile = await describeFile(resolve(REPO_ROOT, "package.json"));
  const contractFile = await describeFile(resolve(REPO_ROOT, "src/shared/product-contract.json"));
  const fixtures = [];
  for (const inputEntry of Object.values(REVIEWED_INPUTS).slice(0, 2)) fixtures.push(await describeFile(inputEntry.path));
  const templates = [];
  for (const inputEntry of Object.values(REVIEWED_INPUTS).slice(2)) templates.push(await describeFile(inputEntry.path));
  for (const template of templates) {
    const templateParts = template.path.split(sep);
    const templateName = templateParts[templateParts.length - 1];
    const built = build.files.find((entry) => entry.path.endsWith(`/${templateName}`));
    requireCondition(
      built?.size === template.size && built?.sha256 === template.sha256,
      `Built FFX/template asset does not match the reviewed source: ${template.path}`
    );
  }
  const provenance = await readBuildProvenance();
  validateBuildProvenance(provenance, {
    commit: gitStart.head,
    packageJson,
    productContract,
    packageFile,
    contractFile,
    assets: build.files.map(({ relativePath, size, sha256 }) => ({ path: relativePath, size, sha256 })),
  });
  const gitEnd = await readGitState();
  requireCondition(gitStart.head === gitEnd.head, "Git HEAD changed while reviewed inputs were read");
  requireCondition(
    gitStart.clean && gitEnd.clean && gitStart.status === gitEnd.status,
    "Git worktree changed while reviewed inputs were read",
  );
  const assets = [...build.files, packageFile, contractFile];
  return {
    schemaVersion: 1,
    commit: gitStart.head,
    gitClean: gitStart.clean,
    gitStatus: gitStart.status,
    gitHeadBefore: gitStart.head,
    gitHeadAfter: gitEnd.head,
    package: { ...packageFile, version: packageJson.version },
    productContract: { ...contractFile, value: productContract },
    assets,
    fixtures,
    templates,
    ffx: templates,
    build,
    buildProvenance: provenance,
  };
};

export const validateFormalPreconditions = async ({
  gitHead,
  gitClean,
  lock,
  target,
  reviewedInputs,
} = {}) => {
  const failPrecondition = (message) => {
    throw new RunnerPolicyError(`Formal precondition rejected: ${message}`);
  };
  if (!gitClean || typeof gitHead !== "string" || !gitHead) failPrecondition("worktree is not clean");
  if (lock !== null && lock !== undefined) failPrecondition("existing or stale lock");
  if (reviewedInputs?.manifest?.commit !== gitHead) failPrecondition("reviewed commit does not match HEAD");
  if (reviewedInputs?.manifest?.gitClean !== true) failPrecondition("reviewed inputs were built from a dirty worktree");
  if (
    reviewedInputs?.manifest?.gitHeadBefore !== gitHead ||
    reviewedInputs?.manifest?.gitHeadAfter !== gitHead
  ) {
    failPrecondition("reviewed input HEAD was unstable");
  }
  if (
    !target ||
    target.exact !== true ||
    target.production !== true ||
    target.panelId !== productContract.product.panelIds.main ||
    target.url !== "file:///repo/dist/cep/main/index.html" &&
    target.url !== pathToFileURL(MAIN_PAGE).href
  ) failPrecondition("target is not the exact production Main panel");
  const owners = target.harnessOwners || {};
  assertNoHarnessProperties(owners);
  assertNoHarnessProperties(target.harnessProperties || {});
  return { ok: true, readOnly: true, commit: gitHead };
};

export const inspectPreflightPaths = async ({
  evidenceRoot = EVIDENCE_ROOT,
  outputDirectory = OUTPUT_DIRECTORY,
  temporaryParent = TEMPORARY_PARENT,
  temporaryRoot = TEMPORARY_ROOT,
  lockPath = LOCK_PATH,
  fs = { lstat, realpath, readFile },
} = {}) => {
  const inspectExistingDirectory = async (path, label) => {
    try {
      const stat = await fs.lstat(path);
      if (stat.isSymbolicLink?.() || !stat.isDirectory?.()) {
        throw new RunnerPolicyError(`${label} is not a regular directory`);
      }
      return { exists: true, realpath: await fs.realpath(path) };
    } catch (error) {
      if (error?.code === "ENOENT") return { exists: false, realpath: null };
      throw error;
    }
  };
  const inspectCollision = async (path, label) => {
    try {
      const stat = await fs.lstat(path);
      throw new RunnerPolicyError(`${label} collision is present (${stat.isSymbolicLink?.() ? "symlink" : "occupied"})`);
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  };
  const output = await inspectExistingDirectory(evidenceRoot, "Evidence root");
  const temporary = await inspectExistingDirectory(temporaryParent, "Temporary parent");
  await inspectCollision(outputDirectory, "Evidence run");
  await inspectCollision(temporaryRoot, "Temporary run");
  let lock = null;
  try {
    lock = JSON.parse(await fs.readFile(lockPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw new RunnerPolicyError("Existing lock is malformed or unreadable");
  }
  return { evidenceRoot: output, temporaryParent: temporary, outputDirectory, temporaryRoot, lock };
};

const verifyReviewedInputs = async () => {
  const manifest = await createReviewedInputManifest();
  for (const [name, input] of Object.entries(REVIEWED_INPUTS)) {
    const entry = [...manifest.fixtures, ...manifest.templates].find((candidate) => candidate.path === input.path);
    requireCondition(entry?.sha256 === input.sha256, `${name} hash drifted from the reviewed runner input`);
  }
  return manifest;
};
const runCanonicalBuild = async (script) => {
  const npmCommand = process.env.npm_execpath || "npm";
  const result = await execFileAsync(npmCommand, ["run", script], {
    cwd: REPO_ROOT,
    maxBuffer: 20 * 1024 * 1024,
  });
  return {
    command: `${npmCommand} run ${script}`,
    stdout: result.stdout,
    stderr: result.stderr,
  };
};
const extractHtmlAssetPaths = async (page) => {
  const html = await readFile(page, "utf8");
  const scripts = [];
  const styles = [];
  for (const match of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/gi)) {
    scripts.push(await realpath(fileURLToPath(new URL(match[1], pathToFileURL(page)))));
  }
  for (const match of html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"[^>]*>/gi)) {
    styles.push(await realpath(fileURLToPath(new URL(match[1], pathToFileURL(page)))));
  }
  requireCondition(scripts.length > 0 && styles.length > 0, "Built Main HTML has no executable asset set");
  return {
    scripts: [...new Set(scripts)].sort(),
    styles: [...new Set(styles)].sort(),
  };
};
const extractMainAssetPaths = async () => extractHtmlAssetPaths(MAIN_PAGE);
const createBuildManifest = async (label) => {
  const buildRoot = await realpath(BUILD_ROOT);
  const page = await realpath(MAIN_PAGE);
  const runtime = await extractMainAssetPaths();
  const settingsPage = await realpath(resolve(BUILD_ROOT, "settings/index.html"));
  const settingsRuntime = await extractHtmlAssetPaths(settingsPage);
  const requiredPaths = [
    page,
    ...runtime.scripts,
    ...runtime.styles,
    settingsPage,
    ...settingsRuntime.scripts,
    ...settingsRuntime.styles,
    await realpath(resolve(BUILD_ROOT, "jsx/index.js")),
    await realpath(resolve(BUILD_ROOT, "CSXS/manifest.xml")),
    await realpath(resolve(BUILD_ROOT, "assets/native-gradient/ae22-6/fill-template.ffx")),
    await realpath(resolve(BUILD_ROOT, "assets/native-gradient/ae22-6/stroke-template.ffx")),
    await realpath(resolve(BUILD_ROOT, "assets/native-gradient/ae25-6/fill-template.ffx")),
    await realpath(resolve(BUILD_ROOT, "assets/native-gradient/ae25-6/stroke-template.ffx")),
    await realpath(resolve(BUILD_ROOT, "assets/native-gradient/ae26-3/fill-template.ffx")),
    await realpath(resolve(BUILD_ROOT, "assets/native-gradient/ae26-3/stroke-template.ffx")),
  ];
  const files = [];
  for (const path of [...new Set(requiredPaths)].sort()) {
    requireCondition(isContainedPath(buildRoot, path) || path === buildRoot, `Build manifest path escaped dist: ${path}`);
    const bytes = await readFile(path);
    files.push({
      path,
      relativePath: relative(buildRoot, path).split(sep).join("/"),
      size: bytes.byteLength,
      sha256: sha256Bytes(bytes),
    });
  }
  return { label, buildRoot, page, runtime, settingsPage, settingsRuntime, files };
};

export const writeBuildProvenance = async () => {
  const gitStart = await readGitState();
  const build = await createBuildManifest("production");
  const packageFile = await describeFile(resolve(REPO_ROOT, "package.json"));
  const contractFile = await describeFile(resolve(REPO_ROOT, "src/shared/product-contract.json"));
  const gitEnd = await readGitState();
  requireCondition(gitStart.head === gitEnd.head, "Git HEAD changed while build provenance was read");
  const assets = build.files.map(({ relativePath, size, sha256 }) => ({
    path: relativePath,
    size,
    sha256,
  }));
  const provenance = {
    schemaVersion: 1,
    commit: gitStart.head,
    gitClean: gitStart.clean,
    package: { value: packageJson, size: packageFile.size, sha256: packageFile.sha256 },
    productContract: { value: productContract, size: contractFile.size, sha256: contractFile.sha256 },
    assets,
  };
  await writeAtomicallyDurableJson(BUILD_PROVENANCE_PATH, provenance);
  return provenance;
};
const runtimeIdentity = (client) =>
  client.evaluate(`(() => ({
    url: location.href,
    readyState: document.readyState,
    title: document.title,
    extensionId: window.__adobe_cep__ && window.__adobe_cep__.getExtensionId
      ? window.__adobe_cep__.getExtensionId()
      : null,
    debugApi: typeof window.__CHROMA_RELAY_DEBUG__,
    scripts: Array.from(document.scripts).map((script) => script.src).filter(Boolean),
    styles: Array.from(document.styleSheets).map((sheet) => sheet.href).filter(Boolean),
    activeElement: document.activeElement
      ? { tagName: document.activeElement.tagName, id: document.activeElement.id || null }
      : null,
    scroll: { x: window.scrollX, y: window.scrollY }
  }))()`);
const exactMainTarget = async () => {
  const expectedPage = await realpath(MAIN_PAGE);
  const response = await fetch("http://127.0.0.1:8198/json/list");
  if (!response.ok) fail(`CDP target list failed: HTTP ${response.status}`);
  const targets = await response.json();
  const matches = [];
  for (const target of targets) {
    if (target.type !== "page") continue;
    try {
      if ((await realpath(fileURLToPath(new URL(target.url)))) === expectedPage) matches.push(target);
    } catch (_error) {
      // Foreign, malformed, or missing file-backed pages are not candidates.
    }
  }
  requireCondition(matches.length === 1, `Expected one exact Main target, found ${matches.length}`);
  return matches[0];
};
const waitForRuntime = async (client, expectedUrl, expectedDebug) =>
  waitUntil(async () => {
    const identity = await runtimeIdentity(client);
    return identity.readyState === "complete" &&
      identity.url === expectedUrl &&
      identity.extensionId === productContract.product.panelIds.main &&
      identity.debugApi === (expectedDebug ? "object" : "undefined")
      ? identity
      : false;
  }, 12_000, expectedDebug ? "instrumented Main runtime" : "production Main runtime");
const navigateMain = async (client, url, expectedDebug) => {
  const navigation = await client.send("Page.navigate", { url });
  requireCondition(!navigation.errorText, `Main navigation failed: ${navigation.errorText}`);
  return waitForRuntime(client, url, expectedDebug);
};
const writeDurableJson = async (path, value, { overwrite = false } = {}) => {
  const temporaryPath = `${path}.${RUN_TOKEN}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  let renamed = false;
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await lstat(path);
    if (!overwrite) {
      const error = new RunnerPolicyError(`Refusing to overwrite an existing evidence report: ${path}`);
      error.code = "EEXIST";
      throw error;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      await rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  }
  try {
    await rename(temporaryPath, path);
    renamed = true;
    await syncDirectoryDurably(OUTPUT_DIRECTORY);
  } catch (error) {
    if (!renamed) await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
};
const readOptionalFile = async (path) => {
  try {
    const bytes = await readFile(path);
    return {
      exists: true,
      byteLength: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      utf8: bytes.toString("utf8"),
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false };
    throw error;
  }
};
const snapshotStorage = async (root) => {
  const inventory = [];
  const walk = async (directory, relativeDirectory = "") => {
    let names;
    try {
      names = await readdir(directory);
    } catch (error) {
      if (error?.code === "ENOENT" && relativeDirectory === "") return;
      throw error;
    }
    names.sort();
    for (const name of names) {
      const absolutePath = resolve(directory, name);
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const entryStat = await lstat(absolutePath);
      requireCondition(!entryStat.isSymbolicLink(), `Storage inventory rejects symlink: ${absolutePath}`);
      if (entryStat.isDirectory()) {
        inventory.push({ path: relativePath, type: "directory" });
        await walk(absolutePath, relativePath);
      } else if (entryStat.isFile()) {
        inventory.push({
          path: relativePath,
          type: "file",
          byteLength: entryStat.size,
          sha256: await sha256(absolutePath),
        });
      } else {
        fail(`Storage inventory rejects non-file entry: ${absolutePath}`);
      }
    }
  };
  await walk(root);
  const files = {};
  for (const name of [
    "palette.json",
    "palette.json.tmp",
    "palette.json.bak",
    "settings.json",
    "settings.json.tmp",
    "settings.json.bak",
  ]) {
    files[name] = await readOptionalFile(resolve(root, name));
  }
  const palette = files["palette.json"].exists
    ? JSON.parse(files["palette.json"].utf8)
    : null;
  return { root, inventory, files, palette };
};
const paletteState = (state) => ({
  paletteRevision: state.paletteRevision,
  palette: state.palette,
  activePalette: state.activePalette,
  palettes: state.palettes,
  paletteError: state.paletteError,
  settings: state.settings,
});
const projectIdentity = (state) => ({
  projectPath: state.projectPath,
  dirty: state.dirty,
  numItems: state.numItems,
  activeItem: state.activeItem,
  items: state.items,
  selection: state.selection,
});
const canonicalSelection = (selection) =>
  selection
    .map((layer) => ({
      ...layer,
      selectedProperties: [...layer.selectedProperties].sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right))
      ),
    }))
    .sort((left, right) => left.id - right.id);
const assertExpectedFixtureSelection = (selection, descriptor, otherPositionPath, label) => {
  requireCondition(selection.length === 2, `${label}: expected exactly two fixture layers`);
  const targetLayer = selection.find((layer) => layer.id === descriptor.layerId);
  const otherLayer = selection.find((layer) => layer.id !== descriptor.layerId);
  requireCondition(targetLayer?.selected === true, `${label}: target layer is not selected`);
  requireCondition(otherLayer?.selected === true, `${label}: unrelated layer is not selected`);
  const expectedTargetProperties = [
    {
      indices: descriptor.propertyIndexPath.slice(0, 2),
      matchNames: descriptor.matchNamePath.slice(0, 2),
    },
    {
      indices: descriptor.propertyIndexPath,
      matchNames: descriptor.matchNamePath,
    },
  ].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const actualTargetProperties = [...targetLayer.selectedProperties].sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right))
  );
  requireCondition(
    sameJson(actualTargetProperties, expectedTargetProperties),
    `${label}: target property selection is not exact: ${JSON.stringify(actualTargetProperties)}`
  );
  requireCondition(
    otherLayer.selectedProperties.length === 1 &&
      sameJson(otherLayer.selectedProperties[0].indices, otherPositionPath.indices) &&
      sameJson(otherLayer.selectedProperties[0].matchNames, ["ADBE Transform Group", "ADBE Position"]),
    `${label}: unrelated Position selection is not exact`
  );
};
const assertRuntimeBuild = async (identity, manifest, expectedDebug) => {
  const identityPage = await realpath(fileURLToPath(new URL(identity.url)));
  requireCondition(identityPage === manifest.page, `Runtime page is not the exact ${manifest.label} Main build`);
  requireCondition(
    identity.extensionId === productContract.product.panelIds.main &&
      identity.debugApi === (expectedDebug ? "object" : "undefined"),
    `Runtime extension/debug identity drifted: ${JSON.stringify(identity)}`
  );
  const resolveRuntimePaths = async (urls) => {
    const paths = [];
    for (const url of urls) paths.push(await realpath(fileURLToPath(new URL(url))));
    return paths.sort();
  };
  const scripts = await resolveRuntimePaths(identity.scripts);
  const styles = await resolveRuntimePaths(identity.styles);
  requireCondition(
    sameJson(scripts, manifest.runtime.scripts) && sameJson(styles, manifest.runtime.styles),
    `Runtime asset set does not match exact ${manifest.label} HTML: ${JSON.stringify({ scripts, styles })}`
  );
  for (const file of manifest.files) {
    const bytes = await readFile(file.path);
    requireCondition(
      bytes.byteLength === file.size && sha256Bytes(bytes) === file.sha256,
      `${manifest.label} build file changed: ${file.path}`
    );
  }
  return { ...manifest, runtimeIdentity: identity };
};
const debugCall = (callback) => `(() => {
  const api = window.__CHROMA_RELAY_DEBUG__;
  if (!api) throw new Error("Chroma Relay debug API unavailable");
  return (${callback})(api);
})()`;

const harnessPresenceExpression = `(() => {
  const names = ${JSON.stringify(KNOWN_HARNESS_PROPERTIES)};
  return Object.fromEntries(names.map((name) => [name, name in window]));
})()`;
const installHarnessRunToken = (client) =>
  client.evaluate(`(() => {
    const names = ${JSON.stringify(KNOWN_HARNESS_PROPERTIES)};
    if (names.some((name) => name in window)) throw new Error("Track B harness property is already present");
    window.__CP_TRACK_B_RUN_TOKEN__ = ${JSON.stringify(RUN_TOKEN)};
    return true;
  })()`);
const clearHarnessRunToken = (client) =>
  client.evaluate(`(() => {
    if (!("__CP_TRACK_B_RUN_TOKEN__" in window)) return false;
    if (window.__CP_TRACK_B_RUN_TOKEN__ !== ${JSON.stringify(RUN_TOKEN)}) {
      throw new Error("Track B run token ownership drifted");
    }
    delete window.__CP_TRACK_B_RUN_TOKEN__;
    return true;
  })()`);

const waitForDebug = async (client) => {
  let stable = 0;
  let previousState = null;
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const currentState = await client.evaluate(
      `document.readyState === "complete" && window.__CHROMA_RELAY_DEBUG__
        ? JSON.stringify(window.__CHROMA_RELAY_DEBUG__.getState())
        : null`
    );
    stable = currentState && currentState === previousState ? stable + 1 : 0;
    previousState = currentState;
    if (stable === 20) return;
    if (attempt === 159) fail("Main debug API and state did not stabilize");
    await delay(50);
  }
};

const afterRender = (client) =>
  client.evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");

const waitForIdle = async (client) => {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const snapshot = await client.evaluate(
      debugCall("(api) => ({ state: api.getState(), counters: api.getCounters() })")
    );
    if (
      snapshot.state.pendingHostAction === null &&
      snapshot.state.pendingPaletteMutation === false
    ) {
      await afterRender(client);
      return client.evaluate(
        debugCall("(api) => ({ state: api.getState(), counters: api.getCounters() })")
      );
    }
    if (attempt === 159) fail("Native-gradient application did not become idle");
    await delay(50);
  }
};

const waitForActionCompletion = async (client, priorHostCalls, observeCompletion) => {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const snapshot = await client.evaluate(
      debugCall("(api) => ({ state: api.getState(), counters: api.getCounters() })")
    );
    if (snapshot.counters.hostCalls > priorHostCalls + 1) {
      fail("Native-gradient application made more than one host call");
    }
    if (
      snapshot.counters.hostCalls === priorHostCalls + 1 &&
      snapshot.state.pendingHostAction === null &&
      snapshot.state.pendingPaletteMutation === false &&
      snapshot.state.lastHostResult != null
    ) {
      observeCompletion(snapshot);
      await afterRender(client);
      const settled = await client.evaluate(
        debugCall("(api) => ({ state: api.getState(), counters: api.getCounters() })")
      );
      observeCompletion(settled);
      for (let stableAttempt = 0; stableAttempt < 20; stableAttempt += 1) {
        await delay(50);
        const stableSnapshot = await client.evaluate(
          debugCall("(api) => ({ state: api.getState(), counters: api.getCounters() })")
        );
        observeCompletion(stableSnapshot);
        requireCondition(
          sameJson(stableSnapshot, settled),
          "Terminal native-gradient completion changed during the monotonic stabilization window"
        );
      }
      return settled;
    }
    if (attempt === 159) fail("Native-gradient application did not complete exactly one host call");
    await delay(50);
  }
};

const waitForActionPending = async (client, priorHostCalls) => {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const snapshot = await client.evaluate(
      debugCall("(api) => ({ state: api.getState(), counters: api.getCounters() })")
    );
    if (
      snapshot.counters.hostCalls === priorHostCalls + 1 &&
      snapshot.state.pendingHostAction === "gradient" &&
      snapshot.state.pendingPaletteMutation === true
    ) {
      return snapshot;
    }
    if (attempt === 159) fail("Native-gradient application did not hold both operation locks");
    await delay(50);
  }
};

const waitForBusyCommandResult = async (client, baseline) => {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const snapshot = await client.evaluate(
      debugCall("(api) => ({ state: api.getState(), counters: api.getCounters() })")
    );
    if (
      snapshot.counters.emittedEvents === baseline.counters.emittedEvents + 1 &&
      snapshot.state.pendingHostAction === "gradient" &&
      snapshot.state.pendingPaletteMutation === true
    ) {
      return snapshot;
    }
    if (attempt === 159) fail("Overlapping palette command did not receive a bounded result");
    await delay(50);
  }
};

const evalHost = (client, source) =>
  client.evaluate(`new Promise((resolve, reject) => {
    window.__adobe_cep__.evalScript(${JSON.stringify(source)}, (result) => {
      try { resolve(JSON.parse(result)); } catch (error) { reject(new Error(result)); }
    });
  })`);

const selectionHelpers = `
  function containsExact(values, expected) {
    for (var valueIndex = 0; valueIndex < values.length; valueIndex += 1) {
      if (values[valueIndex] === expected) return true;
    }
    return false;
  }
  function pathFromLayer(property) {
    var indices = [];
    var matchNames = [];
    var current = property;
    while (current != null && current.propertyIndex != null) {
      indices.unshift(current.propertyIndex);
      matchNames.unshift(current.matchName);
      current = current.parentProperty;
    }
    return { indices: indices, matchNames: matchNames };
  }
  function selectionSnapshot(comp) {
    var result = [];
    if (!(comp instanceof CompItem)) return result;
    for (var layerIndex = 1; layerIndex <= comp.numLayers; layerIndex += 1) {
      var layer = comp.layer(layerIndex);
      var properties = [];
      var selected = layer.selectedProperties;
      for (var selectedIndex = 0; selectedIndex < selected.length; selectedIndex += 1) {
        properties.push(pathFromLayer(selected[selectedIndex]));
      }
      result.push({
        id: layer.id,
        index: layerIndex,
        selected: layer.selected === true,
        selectedProperties: properties
      });
    }
    return result;
  }
  function projectSnapshot() {
    var active = app.project ? app.project.activeItem : null;
    var items = [];
    if (app.project) {
      for (var itemIndex = 1; itemIndex <= app.project.numItems; itemIndex += 1) {
        var item = app.project.item(itemIndex);
        items.push({ id: item.id, selected: item.selected === true });
      }
    }
    return {
      projectPath: app.project && app.project.file ? app.project.file.fsName : null,
      dirty: app.project ? app.project.dirty : null,
      numItems: app.project ? app.project.numItems : 0,
      activeItem: active ? {
        id: active.id,
        name: active.name,
        typeName: active.typeName,
        kind: active instanceof CompItem ? "comp" : active instanceof FootageItem ? "footage" : "unsupported"
      } : null,
      items: items,
      selection: active instanceof CompItem ? selectionSnapshot(active) : []
    };
  }
  function resolvePropertyPath(layer, path) {
    var current = layer;
    for (var pathIndex = 0; pathIndex < path.indices.length; pathIndex += 1) {
      current = current.property(path.indices[pathIndex]);
      if (!current || current.matchName !== path.matchNames[pathIndex]) return null;
    }
    return current;
  }
  function restoreCompSelection(comp, snapshot) {
    for (var clearIndex = 1; clearIndex <= comp.numLayers; clearIndex += 1) {
      var clearLayer = comp.layer(clearIndex);
      var selected = clearLayer.selectedProperties;
      for (var propertyIndex = selected.length - 1; propertyIndex >= 0; propertyIndex -= 1) {
        selected[propertyIndex].selected = false;
      }
      clearLayer.selected = false;
    }
    for (var layerSnapshotIndex = 0; layerSnapshotIndex < snapshot.length; layerSnapshotIndex += 1) {
      var layerSnapshot = snapshot[layerSnapshotIndex];
      var layer = comp.layer(layerSnapshot.index);
      if (!layer || layer.id !== layerSnapshot.id) return false;
      for (var selectedIndex = 0; selectedIndex < layerSnapshot.selectedProperties.length; selectedIndex += 1) {
        var property = resolvePropertyPath(layer, layerSnapshot.selectedProperties[selectedIndex]);
        if (!property) return false;
        property.selected = true;
      }
      layer.selected = layerSnapshot.selected === true;
    }
    return JSON.stringify(selectionSnapshot(comp)) === JSON.stringify(snapshot);
  }
`;

const projectStateSource = `(function () {
  ${selectionHelpers}
  if (!app.project) return JSON.stringify({ project: null });
  var snapshot = projectSnapshot();
  snapshot.version = app.version;
  return JSON.stringify(snapshot);
})()`;

const registerOriginalProjectSource = (originalIdentity) => `(function () {
  ${selectionHelpers}
  if (!app.project) return JSON.stringify({ ok: false, reason: "no-project" });
  if (Object.prototype.hasOwnProperty.call($.global, "__CP_TRACK_B_PROJECT_OWNER__")) {
    return JSON.stringify({ ok: false, reason: "project-owner-already-registered" });
  }
  var expected = ${JSON.stringify(originalIdentity)};
  var actual = projectSnapshot();
  if (actual.dirty !== false || JSON.stringify(actual) !== JSON.stringify(expected)) {
    return JSON.stringify({ ok: false, reason: "original-project-drift", expected: expected, actual: actual });
  }
  $.global.__CP_TRACK_B_PROJECT_OWNER__ = ${JSON.stringify(RUN_TOKEN)};
  return JSON.stringify({ ok: true, state: actual });
})()`;

const releaseOriginalProjectRegistrationSource = `(function () {
  var present = Object.prototype.hasOwnProperty.call($.global, "__CP_TRACK_B_PROJECT_OWNER__");
  var owner = present ? $.global.__CP_TRACK_B_PROJECT_OWNER__ : null;
  if (!present) {
    return JSON.stringify({ released: false, owner: null, foreign: false, reason: "confirmed-owner-missing" });
  }
  if (owner !== ${JSON.stringify(RUN_TOKEN)}) {
    return JSON.stringify({ released: false, owner: owner, foreign: true });
  }
  delete $.global.__CP_TRACK_B_PROJECT_OWNER__;
  return JSON.stringify({ released: true, owner: owner, foreign: false });
})()`;

const probeOriginalProjectRegistrationSource = `(function () {
  var present = Object.prototype.hasOwnProperty.call($.global, "__CP_TRACK_B_PROJECT_OWNER__");
  var owner = present ? $.global.__CP_TRACK_B_PROJECT_OWNER__ : null;
  return JSON.stringify({
    present: present,
    owner: owner,
    foreign: present && owner !== ${JSON.stringify(RUN_TOKEN)}
  });
})()`;

const openFixtureSource = (fixturePath, descriptor, expectedCurrent, allowedProjectPaths) => `(function () {
  ${selectionHelpers}
  if ($.global.__CP_TRACK_B_PROJECT_OWNER__ !== ${JSON.stringify(RUN_TOKEN)}) {
    return JSON.stringify({ ok: false, reason: "project-owner-not-confirmed" });
  }
  var descriptor = ${JSON.stringify(descriptor)};
  var expectedCurrent = ${JSON.stringify(expectedCurrent)};
  var allowedProjectPaths = ${JSON.stringify(allowedProjectPaths)};
  var actualCurrent = app.project ? projectSnapshot() : null;
  var savedPathAllowed =
    typeof expectedCurrent.projectPath === "string" &&
    containsExact(allowedProjectPaths, expectedCurrent.projectPath);
  if (
    !app.project ||
    actualCurrent.dirty !== false ||
    JSON.stringify(actualCurrent) !== JSON.stringify(expectedCurrent) ||
    !savedPathAllowed
  ) {
    return JSON.stringify({
      ok: false,
      reason: "current-project-not-clean-owned-predecessor",
      expected: expectedCurrent,
      actual: actualCurrent
    });
  }
  var fixture = new File(${JSON.stringify(fixturePath)});
  if (!fixture.exists) return JSON.stringify({ ok: false, reason: "fixture-missing" });
  app.open(fixture);
  var comp = null;
  for (var itemIndex = 1; itemIndex <= app.project.numItems; itemIndex += 1) {
    var item = app.project.item(itemIndex);
    if (item instanceof CompItem && item.id === descriptor.compId) comp = item;
    item.selected = false;
  }
  if (!comp || comp.numLayers !== 2) {
    return JSON.stringify({ ok: false, reason: "target-comp-mismatch" });
  }
  comp.openInViewer();
  for (var layerIndex = 1; layerIndex <= comp.numLayers; layerIndex += 1) {
    var clearLayer = comp.layer(layerIndex);
    var prior = clearLayer.selectedProperties;
    for (var priorIndex = prior.length - 1; priorIndex >= 0; priorIndex -= 1) {
      prior[priorIndex].selected = false;
    }
    clearLayer.selected = false;
  }
  var layer = comp.layer(descriptor.layerIndex);
  if (!layer || layer.id !== descriptor.layerId) {
    return JSON.stringify({ ok: false, reason: "target-layer-mismatch" });
  }
  var target = layer;
  for (var pathIndex = 0; pathIndex < descriptor.propertyIndexPath.length; pathIndex += 1) {
    target = target.property(descriptor.propertyIndexPath[pathIndex]);
    if (!target || target.matchName !== descriptor.matchNamePath[pathIndex]) {
      return JSON.stringify({ ok: false, reason: "target-property-drift", pathIndex: pathIndex });
    }
  }
  var expectedParent = descriptor.kind === "fill"
    ? "ADBE Vector Graphic - G-Fill"
    : "ADBE Vector Graphic - G-Stroke";
  if (
    target.matchName !== "ADBE Vector Grad Colors" ||
    !target.parentProperty ||
    target.parentProperty.matchName !== expectedParent ||
    target.numKeys !== 0 ||
    (target.canSetExpression === true && target.expressionEnabled === true) ||
    layer.locked === true
  ) {
    return JSON.stringify({ ok: false, reason: "target-state-unsupported" });
  }
  layer.selected = true;
  target.selected = true;
  var otherLayer = comp.layer(descriptor.layerIndex === 1 ? 2 : 1);
  if (!otherLayer) return JSON.stringify({ ok: false, reason: "unrelated-layer-missing" });
  var otherTransform = otherLayer.property("ADBE Transform Group");
  var otherPosition = otherTransform ? otherTransform.property("ADBE Position") : null;
  if (!otherPosition) return JSON.stringify({ ok: false, reason: "unrelated-position-missing" });
  otherLayer.selected = true;
  otherPosition.selected = true;
  return JSON.stringify({
    ok: true,
    version: app.version,
    projectPath: app.project.file ? app.project.file.fsName : null,
    dirty: app.project.dirty,
    compId: comp.id,
    targetLayerId: layer.id,
    targetKind: descriptor.kind,
    otherPositionPath: pathFromLayer(otherPosition),
    selection: selectionSnapshot(comp)
  });
})()`;

const saveProjectSource = (fixturePath) => `(function () {
  ${selectionHelpers}
  if (!app.project || !app.project.file || app.project.file.fsName !== ${JSON.stringify(fixturePath)}) {
    return JSON.stringify({ ok: false, reason: "project-path-mismatch" });
  }
  app.project.save();
  var active = app.project.activeItem;
  return JSON.stringify({
    ok: app.project.dirty === false,
    projectPath: app.project.file.fsName,
    dirty: app.project.dirty,
    activeCompId: active instanceof CompItem ? active.id : null,
    selection: selectionSnapshot(active)
  });
})()`;

const undoProjectSource = (fixturePath) => `(function () {
  ${selectionHelpers}
  if (!app.project || !app.project.file || app.project.file.fsName !== ${JSON.stringify(fixturePath)}) {
    return JSON.stringify({ ok: false, reason: "project-path-mismatch" });
  }
  if (app.project.dirty !== false) {
    return JSON.stringify({ ok: false, reason: "undo-requires-saved-applied-project" });
  }
  app.executeCommand(16);
  var active = app.project.activeItem;
  return JSON.stringify({
    ok: true,
    projectPath: app.project.file.fsName,
    dirty: app.project.dirty,
    activeCompId: active instanceof CompItem ? active.id : null,
    selection: selectionSnapshot(active)
  });
})()`;

const restoreProjectSource = (originalProject, ownedFixturePaths) => `(function () {
  ${selectionHelpers}
  if ($.global.__CP_TRACK_B_PROJECT_OWNER__ !== ${JSON.stringify(RUN_TOKEN)}) {
    return JSON.stringify({ restored: false, reason: "project-owner-not-confirmed" });
  }
  var original = ${JSON.stringify(originalProject)};
  var ownedPaths = ${JSON.stringify(ownedFixturePaths)};
  var originalIdentity = ${JSON.stringify(projectIdentity(originalProject))};
  if (typeof original.projectPath !== "string" || original.projectPath.length === 0) {
    return JSON.stringify({ restored: false, reason: "unsaved-original-project-unsupported" });
  }
  if (!app.project) return JSON.stringify({ restored: false, reason: "no-current-project" });
  var current = projectSnapshot();
  if (JSON.stringify(current) === JSON.stringify(originalIdentity)) {
    return JSON.stringify({ restored: true, alreadyRestored: true, state: current });
  }
  if (
    current.dirty !== false ||
    current.projectPath === null ||
    !containsExact(ownedPaths, current.projectPath)
  ) {
    return JSON.stringify({
      restored: false,
      reason: "refusing-to-replace-foreign-or-dirty-project",
      state: current
    });
  }

  var previous = new File(original.projectPath);
  if (!previous.exists) {
    return JSON.stringify({ restored: false, reason: "previous-project-missing" });
  }
  app.open(previous);

  var active = null;
  if (original.activeItem) {
    for (var activeIndex = 1; activeIndex <= app.project.numItems; activeIndex += 1) {
      if (app.project.item(activeIndex).id === original.activeItem.id) {
        active = app.project.item(activeIndex);
        break;
      }
    }
    if (!active || (active.typeName !== original.activeItem.typeName)) {
      return JSON.stringify({ restored: false, reason: "original-active-item-drift" });
    }
    if (active instanceof CompItem || active instanceof FootageItem) {
      active.openInViewer();
    } else {
      return JSON.stringify({ restored: false, reason: "original-active-item-unsupported" });
    }
    if (active instanceof CompItem && !restoreCompSelection(active, original.selection)) {
      return JSON.stringify({ restored: false, reason: "original-property-selection-restore-failed" });
    }
  }

  for (var clearItemIndex = 1; clearItemIndex <= app.project.numItems; clearItemIndex += 1) {
    app.project.item(clearItemIndex).selected = false;
  }
  for (var itemSnapshotIndex = 0; itemSnapshotIndex < original.items.length; itemSnapshotIndex += 1) {
    var wantedItem = original.items[itemSnapshotIndex];
    var foundItem = null;
    for (var findIndex = 1; findIndex <= app.project.numItems; findIndex += 1) {
      if (app.project.item(findIndex).id === wantedItem.id) foundItem = app.project.item(findIndex);
    }
    if (!foundItem) return JSON.stringify({ restored: false, reason: "original-item-drift" });
    foundItem.selected = wantedItem.selected === true;
  }

  var restored = projectSnapshot();
  return JSON.stringify({
    restored: JSON.stringify(restored) === JSON.stringify(originalIdentity),
    reason: JSON.stringify(restored) === JSON.stringify(originalIdentity) ? null : "original-project-postcondition-failed",
    state: restored
  });
})()`;

const installUnknownCompletionInjection = (client) =>
  client.evaluate(`(() => {
    const bridge = window.__adobe_cep__;
    if (!bridge || typeof bridge.evalScript !== "function") {
      throw new Error("CEP evalScript bridge unavailable");
    }
    const names = ${JSON.stringify(KNOWN_HARNESS_PROPERTIES)};
    if (names.some((name) => name in window && name !== "__CP_TRACK_B_RUN_TOKEN__")) {
      throw new Error("Track B injection/listener property already installed");
    }
    if (window.__CP_TRACK_B_RUN_TOKEN__ !== ${JSON.stringify(RUN_TOKEN)}) {
      throw new Error("Track B run token is not installed");
    }
    const original = bridge.evalScript;
    window.__CP_TRACK_B_INJECTION_OWNER__ = ${JSON.stringify(RUN_TOKEN)};
    window.__CP_TRACK_B_ORIGINAL_EVAL_SCRIPT__ = original;
    window.__CP_TRACK_B_INJECTION_COUNT__ = 0;
    window.__CP_TRACK_B_PENDING_CALLBACK__ = null;
    bridge.evalScript = function (source, callback) {
      if (String(source).includes(".applyNativeGradientPresetToSelectedTarget(")) {
        window.__CP_TRACK_B_INJECTION_COUNT__ += 1;
        window.__CP_TRACK_B_PENDING_CALLBACK__ = callback;
        return;
      }
      return original.call(this, source, callback);
    };
    return true;
  })()`);

const releaseUnknownCompletionInjection = (client, target, hostVersion) =>
  client.evaluate(`(() => {
    if (window.__CP_TRACK_B_INJECTION_OWNER__ !== ${JSON.stringify(RUN_TOKEN)}) {
      throw new Error("Track B injection ownership drifted");
    }
    const callback = window.__CP_TRACK_B_PENDING_CALLBACK__;
    if (typeof callback !== "function") {
      throw new Error("Track B pending host callback unavailable");
    }
    window.__CP_TRACK_B_PENDING_CALLBACK__ = null;
    callback(JSON.stringify({
      runToken: ${JSON.stringify(RUN_TOKEN)},
      requestId: ${JSON.stringify(RUN_TOKEN)},
      status: "apply-unknown-completion",
      primaryStatus: "apply-unknown-completion",
      hostVersion: ${JSON.stringify(hostVersion)},
      target: ${JSON.stringify(target)},
      selectedTargetCount: 1,
      mutationAttempted: true,
      applyCompleted: false,
      undoGroupOpened: true,
      undoGroupCloseAttempted: true,
      undoGroupClosed: true,
      selectionRestoreAttempted: true,
      selectionRestored: true,
      applyError: {
        name: "Error",
        message: "Injected B4 applyPreset unknown completion",
        line: null,
        number: null
      }
    }));
    return true;
  })()`);

const installPaletteResultListener = (client) =>
  client.evaluate(`(() => {
    const bridge = window.__adobe_cep__;
    if (!bridge || typeof bridge.addEventListener !== "function") {
      throw new Error("CEP application event API unavailable");
    }
    const names = ${JSON.stringify(KNOWN_HARNESS_PROPERTIES)};
    if (names.some((name) => name in window && name !== "__CP_TRACK_B_RUN_TOKEN__")) {
      throw new Error("Track B result listener already installed");
    }
    if (window.__CP_TRACK_B_RUN_TOKEN__ !== ${JSON.stringify(RUN_TOKEN)}) {
      throw new Error("Track B run token is not installed");
    }
    const results = [];
    const tokens = [];
    const handler = (event) => {
      try {
        const result = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
        const token = result?.runToken !== undefined ? result.runToken : result?.requestId;
        if (token === ${JSON.stringify(RUN_TOKEN)}) tokens.push(token);
        results.push(result);
      } catch (error) {
        results.push({ parseError: String(error) });
      }
    };
    window.__CP_TRACK_B_RESULT_OWNER__ = ${JSON.stringify(RUN_TOKEN)};
    window.__CP_TRACK_B_RESULT_CSI__ = bridge;
    window.__CP_TRACK_B_RESULT_HANDLER__ = handler;
    window.__CP_TRACK_B_RESULT_EVENTS__ = results;
    window.__CP_TRACK_B_RESULT_TOKENS__ = tokens;
    bridge.addEventListener("com.zimoby.chroma-relay.result", handler);
    return true;
  })()`);

const dispatchBusyPaletteCommand = (client, baseRevision) =>
  client.evaluate(`(() => {
    if (
      window.__CP_TRACK_B_RESULT_OWNER__ !== ${JSON.stringify(RUN_TOKEN)} ||
      !window.__CP_TRACK_B_RESULT_CSI__
    ) {
      throw new Error("Owned Track B result listener is not installed");
    }
    const bridge = window.__CP_TRACK_B_RESULT_CSI__;
    bridge.dispatchEvent({
      type: "com.zimoby.chroma-relay.command",
      scope: "APPLICATION",
      appId: JSON.parse(bridge.getHostEnvironment()).appId,
      extensionId: bridge.getExtensionId(),
      data: JSON.stringify({
        runToken: ${JSON.stringify(RUN_TOKEN)},
        requestId: ${JSON.stringify(RUN_TOKEN)},
        baseRevision: ${JSON.stringify(baseRevision)},
        command: { type: "create" }
      })
    });
    return true;
  })()`);

const readPaletteResultEvents = (client) =>
  client.evaluate(`(() => {
    const names = ${JSON.stringify(KNOWN_HARNESS_PROPERTIES)};
    const owner = window.__CP_TRACK_B_RESULT_OWNER__;
    const csi = window.__CP_TRACK_B_RESULT_CSI__;
    const handler = window.__CP_TRACK_B_RESULT_HANDLER__;
    const results = window.__CP_TRACK_B_RESULT_EVENTS__ || [];
    const tokens = window.__CP_TRACK_B_RESULT_TOKENS__ || [];
    if (names.some((name) => name in window && name !== "__CP_TRACK_B_RUN_TOKEN__") && owner !== ${JSON.stringify(RUN_TOKEN)}) {
      throw new Error("Refusing to remove a foreign Track B result listener");
    }
    if (owner !== ${JSON.stringify(RUN_TOKEN)} || !csi || typeof handler !== "function") {
      throw new Error("Owned Track B result listener is incomplete");
    }
    csi.removeEventListener("com.zimoby.chroma-relay.result", handler, null);
    delete window.__CP_TRACK_B_RESULT_OWNER__;
    delete window.__CP_TRACK_B_RESULT_CSI__;
    delete window.__CP_TRACK_B_RESULT_HANDLER__;
    delete window.__CP_TRACK_B_RESULT_EVENTS__;
    delete window.__CP_TRACK_B_RESULT_TOKENS__;
    return { results, tokens };
  })()`);

const removeUnknownCompletionInjection = (client) =>
  client.evaluate(`(() => {
    const names = ${JSON.stringify(KNOWN_HARNESS_PROPERTIES)};
    const owner = window.__CP_TRACK_B_INJECTION_OWNER__;
    if (owner !== ${JSON.stringify(RUN_TOKEN)}) {
      if (names.some((name) => name in window && name !== "__CP_TRACK_B_RUN_TOKEN__")) {
        throw new Error("Refusing to remove a foreign or incomplete Track B injection");
      }
      return { installed: false, owner: null, count: 0, pendingSettled: false };
    }
    const original = window.__CP_TRACK_B_ORIGINAL_EVAL_SCRIPT__;
    const count = window.__CP_TRACK_B_INJECTION_COUNT__ || 0;
    const pending = window.__CP_TRACK_B_PENDING_CALLBACK__;
    var pendingSettled = false;
    if (typeof pending === "function") {
      window.__CP_TRACK_B_PENDING_CALLBACK__ = null;
      pending(JSON.stringify({
        runToken: ${JSON.stringify(RUN_TOKEN)},
        requestId: ${JSON.stringify(RUN_TOKEN)},
        status: "invalid-request",
        primaryStatus: "invalid-request",
        error: "Track B harness removed a pending test injection"
      }));
      pendingSettled = true;
    }
    if (original && window.__adobe_cep__) window.__adobe_cep__.evalScript = original;
    delete window.__CP_TRACK_B_INJECTION_OWNER__;
    delete window.__CP_TRACK_B_ORIGINAL_EVAL_SCRIPT__;
    delete window.__CP_TRACK_B_INJECTION_COUNT__;
    delete window.__CP_TRACK_B_PENDING_CALLBACK__;
    return { installed: true, owner, count, pendingSettled, runToken: ${JSON.stringify(RUN_TOKEN)} };
  })()`);

const consoleEvidence = (events) => ({
  console: events
    .filter((event) => event.method === "Runtime.consoleAPICalled")
    .map((event) => ({
      type: event.params.type,
      values: event.params.args.map((argument) => argument.value ?? argument.description ?? null),
    })),
  exceptions: events
    .filter((event) => event.method === "Runtime.exceptionThrown")
    .map((event) => event.params.exceptionDetails),
});

const descriptorProjection = (descriptor) => ({
  compId: descriptor.compId,
  layerId: descriptor.layerId,
  layerIndex: descriptor.layerIndex,
  kind: descriptor.kind,
  propertyIndexPath: descriptor.propertyIndexPath,
  matchNamePath: descriptor.matchNamePath,
});

const readResolvedGradient = async (projectPath, descriptor) => {
  const document = parseRifx(await readFile(projectPath));
  const targets = indexAepNativeGradientTargets(document);
  const resolution = resolveAepNativeGradientTarget(targets, descriptor);
  requireCondition(resolution.status === "resolved", `Saved target did not resolve: ${resolution.status}`);
  requireCondition(
    resolution.target.candidate.status === "valid",
    `Saved target candidate is ${resolution.target.candidate.status}`
  );
  const resolvedDescriptor = descriptorProjection(resolution.target);
  requireCondition(
    sameJson(resolvedDescriptor, descriptor),
    `Saved target descriptor drifted: ${JSON.stringify(resolvedDescriptor)}`
  );
  return {
    candidateCount: targets.length,
    descriptor: resolvedDescriptor,
    gradient: resolution.target.candidate.gradient,
  };
};

const expectedAppliedGradient = () => ({
  schemaVersion: 1,
  colorStops: PALETTE.map((color, index) => ({
    offset: index / (PALETTE.length - 1),
    midpoint: 0.5,
    rgb: color.rgba.slice(0, 3).map(Math.fround),
    extra: 1,
  })),
  alphaStops: PALETTE.map((color, index) => ({
    offset: index / (PALETTE.length - 1),
    midpoint: 0.5,
    alpha: Math.fround(color.rgba[3]),
  })),
});

const assertNear = (actual, expected, label) => {
  requireCondition(
    typeof actual === "number" && actual === expected,
    `${label}: expected ${expected}, received ${actual}`
  );
};

const assertGradient = (actual, expected, label) => {
  requireCondition(actual.schemaVersion === 1, `${label}: wrong schema`);
  requireCondition(
    actual.colorStops.length === expected.colorStops.length &&
      actual.alphaStops.length === expected.alphaStops.length,
    `${label}: stop-count mismatch`
  );
  actual.colorStops.forEach((stop, index) => {
    const wanted = expected.colorStops[index];
    assertNear(stop.offset, wanted.offset, `${label} color ${index} offset`);
    assertNear(stop.midpoint, wanted.midpoint, `${label} color ${index} midpoint`);
    requireCondition(stop.extra === wanted.extra, `${label} color ${index} extra mismatch`);
    stop.rgb.forEach((component, componentIndex) =>
      assertNear(component, wanted.rgb[componentIndex], `${label} color ${index} rgb ${componentIndex}`)
    );
  });
  actual.alphaStops.forEach((stop, index) => {
    const wanted = expected.alphaStops[index];
    assertNear(stop.offset, wanted.offset, `${label} alpha ${index} offset`);
    assertNear(stop.midpoint, wanted.midpoint, `${label} alpha ${index} midpoint`);
    assertNear(stop.alpha, wanted.alpha, `${label} alpha ${index} value`);
  });
};

const observeRendererLeaseRoots = (rendererReport, observedLeaseRoots, observedEvidenceRoots) => {
  if (Array.isArray(rendererReport?.generated)) {
    for (const lease of rendererReport.generated) {
      if (typeof lease?.rootPath === "string") observedLeaseRoots.add(lease.rootPath);
    }
  }
  if (Array.isArray(rendererReport?.cleanup)) {
    for (const disposition of rendererReport.cleanup) {
      if (typeof disposition?.evidenceRootPath === "string") {
        observedEvidenceRoots.add(disposition.evidenceRootPath);
      }
    }
  }
};

const assertOwnedDisposition = async (rendererReport, expectedDisposition) => {
  requireCondition(rendererReport.generated.length === 2, "Renderer did not report two generated leases");
  requireCondition(rendererReport.cleanup.length === 2, "Renderer did not report two cleanup results");
  for (const lease of rendererReport.generated) {
    await requireAbsent(lease.rootPath, "renderer-owned temporary root");
  }
  if (expectedDisposition === "removed") {
    requireCondition(
      rendererReport.cleanup.every(
        (entry) =>
          entry.removed === true &&
          entry.preserved === false &&
          entry.evidenceRootPath === null &&
          entry.evidencePresetPath === null &&
          entry.error === null
      ),
      `Renderer cleanup evidence failed: ${JSON.stringify(rendererReport.cleanup)}`
    );
    return [];
  }

  requireCondition(expectedDisposition === "preserved", "Unknown renderer disposition expectation");
  const expectedTempBasePath = await realpath(resolve(tmpdir(), "TemporaryItems"));
  requireCondition(
    rendererReport.cleanup.every(
      (entry) =>
        entry.removed === false &&
        entry.preserved === true &&
        typeof entry.evidenceRootPath === "string" &&
        typeof entry.evidencePresetPath === "string" &&
        entry.error === null
    ),
    `Renderer preservation evidence failed: ${JSON.stringify(rendererReport.cleanup)}`
  );
  const archiveRoot = resolve(OUTPUT_DIRECTORY, "preserved-presets");
  await mkdir(archiveRoot, { recursive: true });
  const archived = [];
  for (const entry of rendererReport.cleanup) {
    const lease = rendererReport.generated.find((candidate) => candidate.kind === entry.kind);
    requireCondition(Boolean(lease), `Missing ${entry.kind} lease for preserved evidence`);
    requireCondition(/^[A-F0-9]{32}$/.test(lease.runToken), `${entry.kind} run token is invalid`);
    requireCondition(
      lease.tempBasePath === expectedTempBasePath,
      `${entry.kind} temp base is outside the canonical macOS TemporaryItems directory`
    );
    const expectedEvidenceRootPath = resolve(
      expectedTempBasePath,
      `chroma-relay-native-gradient-evidence-${lease.runToken}`
    );
    requireCondition(
      entry.evidenceRootPath === expectedEvidenceRootPath,
      `${entry.kind} evidence root does not match its owned token path`
    );
    requireCondition(
      resolve(entry.evidenceRootPath, lease.filename) === entry.evidencePresetPath,
      `${entry.kind} evidence path drifted`
    );
    requireCondition(
      (await realpath(entry.evidenceRootPath)) === entry.evidenceRootPath,
      `${entry.kind} evidence root is not canonical`
    );
    requireCondition(
      sameJson(await readdir(entry.evidenceRootPath), [lease.filename]),
      `${entry.kind} evidence root contains unexpected entries`
    );
    const sourceStat = await lstat(entry.evidencePresetPath);
    requireCondition(
      sourceStat.isFile() && !sourceStat.isSymbolicLink(),
      `${entry.kind} evidence is not a regular file`
    );
    requireCondition(sourceStat.size === lease.byteLength, `${entry.kind} evidence size drifted`);
    requireCondition(
      (await sha256(entry.evidencePresetPath)) === lease.sha256,
      `${entry.kind} evidence hash drifted`
    );
    const archivePath = resolve(archiveRoot, `${lease.runToken}-${lease.filename}`);
    await copyFile(entry.evidencePresetPath, archivePath);
    requireCondition((await sha256(archivePath)) === lease.sha256, `${entry.kind} archive hash drifted`);
    await rm(entry.evidencePresetPath, { force: false });
    await rmdir(entry.evidenceRootPath);
    await requireAbsent(entry.evidenceRootPath, `${entry.kind} renderer evidence root`);
    archived.push({
      kind: entry.kind,
      path: archivePath,
      byteLength: lease.byteLength,
      sha256: lease.sha256,
    });
  }
  return archived;
};

const assertActionDeltas = (baseline, snapshot) => {
  requireCondition(
    snapshot.counters.hostCalls === baseline.counters.hostCalls + 1,
    "Gradient action did not make exactly one host call"
  );
  requireCondition(
    snapshot.counters.emittedEvents === baseline.counters.emittedEvents + 1,
    "Gradient action did not emit exactly one palette-result event"
  );
  requireCondition(
    snapshot.counters.diskWrites === baseline.counters.diskWrites,
    "Gradient action wrote palette storage"
  );
  requireCondition(
    snapshot.state.paletteRevision === baseline.state.paletteRevision,
    "Gradient action changed palette revision"
  );
  requireCondition(snapshot.state.pendingHostAction === null, "Gradient action remained pending");
  requireCondition(snapshot.state.pendingPaletteMutation === false, "Palette mutation remained pending");
};

const triggerGradientAction = (client) =>
  client.evaluate(`(() => {
    const bridge = window.__adobe_cep__;
    if (!bridge || typeof bridge.dispatchEvent !== "function") {
      throw new Error("CEP flyout event API unavailable");
    }
    bridge.dispatchEvent({
      type: "com.adobe.csxs.events.flyoutMenuClicked",
      scope: "APPLICATION",
      appId: JSON.parse(bridge.getHostEnvironment()).appId,
      extensionId: bridge.getExtensionId(),
      data: JSON.stringify({ menuId: ${JSON.stringify(ACTION_MENU_ID)}, runToken: ${JSON.stringify(RUN_TOKEN)} })
    });
    return true;
  })()`);

const main = async () => {
  let client = null;
  let lockHandle = null;
  let evidenceRun = null;
  let temporaryRun = null;
  let temporaryRootCreated = false;
  let originalProject = null;
  let originalPanel = null;
  let realConfigRoot = null;
  let realStorageBefore = null;
  let expectedProjectPredecessor = null;
  let projectRegistrationAttempted = false;
  let projectRegistrationConfirmed = false;
  let rendererCleanupVerified = true;
  let injectionAttempted = false;
  let productionRestoreRequired = false;
  let productionBaseline = null;
  let devBuildEvidence = null;
  let productionBuildEvidence = null;
  let reviewedInputsStart = null;
  let reviewedInputsEnd = null;
  let lastRendererReport = null;
  const buildOutputs = [];
  const ownedFixturePaths = [];
  const observedLeaseRoots = new Set();
  const observedEvidenceRoots = new Set();
  const observedResultRequestIds = [];
  const reloadCounts = { debug: 0, production: 0 };
  let failure = null;
  let report = null;
  let bodyPassed = false;
  const cleanup = {
    client: null,
    panel: null,
    project: null,
    projectRegistration: null,
    rendererLeases: null,
    temp: null,
    injection: null,
    lock: null,
    harnessAbsent: null,
  };

  try {
    // Everything through the production snapshot is read-only. No run root, lock, temp
    // child, fixture, build, or evidence mutation is allowed before these gates pass.
    reviewedInputsStart = await verifyReviewedInputs();
    requireCondition(reviewedInputsStart.gitClean === true, "Formal Track B requires a clean Git worktree");
    const target = await exactMainTarget();
    const productionUrl = pathToFileURL(await realpath(MAIN_PAGE)).href;
    requireCondition(target.type === "page", "Exact Main target is not a page");
    requireCondition(target.url === productionUrl, `Main target was not at the canonical production URL: ${target.url}`);
    requireCondition(target.webSocketDebuggerUrl, "Exact Main target has no debugger endpoint");
    await inspectPreflightPaths();

    client = new CDPClient(target.webSocketDebuggerUrl);
    await client.connect();
    await Promise.all([
      client.send("Runtime.enable"),
      client.send("Log.enable"),
      client.send("Page.enable"),
    ]);
    client.events = [];
    const productionManifestBefore = await createBuildManifest("production-pre-run");
    const productionRuntimeBefore = await waitForRuntime(client, productionUrl, false);
    await assertRuntimeBuild(productionRuntimeBefore, productionManifestBefore, false);
    requireCondition(
      sameJson(productionManifestBefore.files, reviewedInputsStart.build.files),
      "Production bytes differ from the reviewed-input manifest"
    );
    const staleHarnessState = await client.evaluate(harnessPresenceExpression);
    assertNoHarnessProperties(staleHarnessState);
    const preflightProjectOwner = await evalHost(client, probeOriginalProjectRegistrationSource);
    requireCondition(
      preflightProjectOwner.owner === null && preflightProjectOwner.foreign === false,
      `Refusing pre-existing foreign project ownership: ${JSON.stringify(preflightProjectOwner)}`
    );
    const userData = await client.evaluate(
      `window.__adobe_cep__.getSystemPath("userData")`
    );
    realConfigRoot = resolve(
      String(userData).startsWith("file:") ? fileURLToPath(String(userData)) : String(userData),
      contract.compatibility.storageDirectory
    );
    realStorageBefore = await snapshotStorage(realConfigRoot);
    const sourceExpected = JSON.parse(await readFile(EXPECTED_SOURCE, "utf8"));
    const sourceHash = await sha256(FIXTURE_SOURCE);
    requireCondition(sourceHash === sourceExpected.file.sha256, "Fixture hash does not match its reviewed expectation");
    const fixtureStat = await lstat(FIXTURE_SOURCE);
    requireCondition(fixtureStat.isFile() && !fixtureStat.isSymbolicLink(), "Reviewed fixture is not a regular file");
    originalProject = await evalHost(client, projectStateSource);
    requireCondition(
      originalProject.dirty === false &&
        typeof originalProject.projectPath === "string" &&
        originalProject.projectPath.length > 0 &&
        (!originalProject.activeItem || originalProject.activeItem.kind === "comp" || originalProject.activeItem.kind === "footage"),
      `Refusing to replace an unsaved, dirty, or unsupported current project: ${JSON.stringify(originalProject)}`
    );
    requireCondition(
      sourceExpected.afterEffectsVersion === originalProject.version,
      `AE version mismatch: expected ${sourceExpected.afterEffectsVersion}, received ${originalProject.version}`
    );
    productionBaseline = {
      runtime: productionRuntimeBefore,
      build: productionManifestBefore,
      storage: realStorageBefore,
    };

    const existingLock = await readExistingLock();
    await validateFormalPreconditions({
      gitHead: reviewedInputsStart.commit,
      gitClean: reviewedInputsStart.gitClean,
      lock: existingLock,
      target: {
        exact: true,
        production: true,
        panelId: productContract.product.panelIds.main,
        url: productionUrl,
        harnessProperties: staleHarnessState,
      },
      reviewedInputs: { manifest: reviewedInputsStart },
    });
    lockHandle = await open(LOCK_PATH, "wx", 0o600);
    await lockHandle.writeFile(`${JSON.stringify(LOCK_MARKER)}\n`);
    evidenceRun = await createOwnedRunDirectory(EVIDENCE_ROOT, {
      tokenFactory: () => RUN_TOKEN,
    });
    requireCondition(resolve(evidenceRun.path) === OUTPUT_DIRECTORY, "Evidence run path drifted from its cryptographic token");
    temporaryRun = await createOwnedRunDirectory(TEMPORARY_PARENT, {
      tokenFactory: () => RUN_TOKEN,
    });
    requireCondition(resolve(temporaryRun.path) === TEMPORARY_ROOT, "Temporary run path drifted from its cryptographic token");
    temporaryRootCreated = true;

    productionRestoreRequired = true;
    buildOutputs.push(await runCanonicalBuild("build:dev"));
    const devManifest = await createBuildManifest("instrumented-dev");
    const devUrl = `${productionUrl}?track-b=${encodeURIComponent(RUN_TOKEN)}`;
    const devRuntime = await navigateMain(client, devUrl, true);
    reloadCounts.debug += 1;
    await waitForDebug(client);
    await installHarnessRunToken(client);
    await afterRender(client);
    devBuildEvidence = await assertRuntimeBuild(devRuntime, devManifest, true);
    const identity = await client.evaluate(debugCall("(api) => api.getIdentity()"));
    requireCondition(
      identity.extensionId === productContract.product.panelIds.main &&
        identity.page === "main" &&
        identity.url === devUrl &&
        identity.buildMarker === EXPECTED_BUILD_MARKER,
      `Unexpected panel identity: ${JSON.stringify(identity)}`
    );
    originalPanel = await client.evaluate(
      debugCall("(api) => ({ identity: api.getIdentity(), state: api.getState() })")
    );
    requireCondition(
      originalPanel.identity.configRoot === null &&
        originalPanel.state.pendingHostAction === null &&
        originalPanel.state.pendingPaletteMutation === false,
      "Instrumented Main began with temporary config or active operation"
    );
    const realStorageAfterDevLoad = await snapshotStorage(realConfigRoot);
    requireCondition(
      sameJson(realStorageAfterDevLoad, realStorageBefore),
      "Instrumented Main load changed authoritative production storage"
    );

    expectedProjectPredecessor = projectIdentity(originalProject);
    projectRegistrationAttempted = true;
    const projectRegistration = await evalHost(
      client,
      registerOriginalProjectSource(expectedProjectPredecessor)
    );
    requireCondition(
      projectRegistration.ok === true &&
        sameJson(projectRegistration.state, expectedProjectPredecessor),
      `Could not register exact original project: ${JSON.stringify(projectRegistration)}`
    );
    projectRegistrationConfirmed = true;

    await client.evaluate(debugCall("(api) => api.resetTestState()"));
    await afterRender(client);
    await client.evaluate(
      debugCall(`(api) => api.setTemporaryConfigRoot(${JSON.stringify(TEMPORARY_ROOT)})`)
    );
    await afterRender(client);
    await waitUntil(async () => {
      const temporaryIdentity = await client.evaluate(debugCall("(api) => api.getIdentity()"));
      return temporaryIdentity.configRoot === TEMPORARY_ROOT ? temporaryIdentity : false;
    }, 8_000, "fresh temporary-config debug closure");
    const temporaryStorageBeforeSeed = await snapshotStorage(TEMPORARY_ROOT);
    requireCondition(
      temporaryStorageBeforeSeed.palette === null,
      "run-owned temporary root unexpectedly contained a palette before seeding"
    );
    await client.evaluate(
      debugCall(`(api) => api.persistPalette(${JSON.stringify(PALETTE)})`)
    );
    await waitForIdle(client);
    const temporaryStorageBaseline = await snapshotStorage(TEMPORARY_ROOT);
    requireCondition(
      temporaryStorageBaseline.palette !== null,
      "Temporary authoritative palette document was not written"
    );

    const successCases = [];
    for (const kind of ["fill", "stroke"]) {
      const descriptor = sourceExpected.targets.find(
        (candidate) => candidate.kind === kind && candidate.layerIndex === 1
      );
      requireCondition(descriptor, `Missing reviewed ${kind} descriptor`);
      const projected = descriptorProjection(descriptor);
      const fixtureCopy = resolve(TEMPORARY_ROOT, `track-b-${kind}.aep`);
      const allowedProjectPaths = [originalProject.projectPath, ...ownedFixturePaths].filter(Boolean);
      ownedFixturePaths.push(fixtureCopy);
      await copyFile(FIXTURE_SOURCE, fixtureCopy);
      const fixtureHashBefore = await sha256(fixtureCopy);
      requireCondition(
        fixtureHashBefore === REVIEWED_INPUTS.fixture.sha256,
        `${kind} fixture copy did not match the reviewed immutable fixture`
      );
      const preOpen = await evalHost(client, projectStateSource);
      requireCondition(
        preOpen.dirty === false &&
          sameJson(projectIdentity(preOpen), expectedProjectPredecessor),
        `${kind} predecessor drifted before fixture open: ${JSON.stringify(preOpen)}`
      );
      const setup = await evalHost(
        client,
        openFixtureSource(
          fixtureCopy,
          projected,
          expectedProjectPredecessor,
          allowedProjectPaths
        )
      );
      requireCondition(
        setup.ok === true &&
          setup.version === sourceExpected.afterEffectsVersion &&
          setup.projectPath === fixtureCopy &&
          setup.dirty === false &&
          setup.compId === projected.compId &&
          setup.targetLayerId === projected.layerId &&
          setup.targetKind === kind,
        `${kind} setup failed: ${JSON.stringify(setup)}`
      );
      assertExpectedFixtureSelection(
        setup.selection,
        projected,
        setup.otherPositionPath,
        `${kind} setup`
      );

      const before = await evalHost(client, projectStateSource);
      const baseline = await client.evaluate(
        debugCall("(api) => ({ state: api.getState(), counters: api.getCounters() })")
      );
      const storageBefore = await snapshotStorage(TEMPORARY_ROOT);
      await installPaletteResultListener(client);
      rendererCleanupVerified = false;
      await triggerGradientAction(client);
      const snapshot = await waitForActionCompletion(
        client,
        baseline.counters.hostCalls,
        (completed) =>
          observeRendererLeaseRoots(
            completed.state.lastHostResult,
            observedLeaseRoots,
            observedEvidenceRoots
          )
      );
      const rendererReport = snapshot.state.lastHostResult;
      lastRendererReport = rendererReport;
      const resultEventBatch = await readPaletteResultEvents(client);
      const resultEvents = resultEventBatch.results;
      const resultTokens = validateOwnedEventTokens(
        resultEvents,
        RUN_TOKEN,
        1,
        { allowNullRequestId: true },
      );
      observedResultRequestIds.push(...resultTokens.tokens);
      const afterAction = await evalHost(client, projectStateSource);
      const storageAfter = await snapshotStorage(TEMPORARY_ROOT);
      const fixtureHashAfterAction = await sha256(fixtureCopy);

      assertActionDeltas(baseline, snapshot);
      requireCondition(
        resultEvents.length === 1 &&
          resultEvents[0].requestId === null &&
          resultEvents[0].ok === true &&
          resultEvents[0].message === snapshot.state.lastResult &&
          sameJson(resultEvents[0].document, storageBefore.palette),
        `${kind} delivered result event drifted: ${JSON.stringify(resultEvents)}`
      );
      requireCondition(
        sameJson(paletteState(snapshot.state), paletteState(baseline.state)) &&
          sameJson(storageAfter, storageBefore),
        `${kind} action changed palette state or authoritative storage`
      );
      requireCondition(rendererReport?.status === "ok", `${kind} renderer failed: ${JSON.stringify(rendererReport)}`);
      requireCondition(rendererReport.primaryStatus === "ok", `${kind} primary renderer status was not ok`);
      requireCondition(rendererReport.hostCallAttempted === true, `${kind} host call was not attempted`);
      requireCondition(rendererReport.hostResult?.status === "ok", `${kind} host result was not ok`);
      requireCondition(rendererReport.hostResult.primaryStatus === "ok", `${kind} host primary status was not ok`);
      requireCondition(
        rendererReport.hostResult.hostVersion === sourceExpected.afterEffectsVersion,
        `${kind} host version drifted`
      );
      requireCondition(sameJson(rendererReport.hostResult.target, projected), `${kind} host resolved wrong target`);
      requireCondition(rendererReport.hostResult.selectedTargetCount === 1, `${kind} target count drifted`);
      requireCondition(
        rendererReport.generated.every((lease) => lease.stopCount === PALETTE.length),
        `${kind} generated stop count drifted`
      );
      requireCondition(rendererReport.hostResult.undoGroupOpened === true, `${kind} Undo group did not open`);
      requireCondition(
        rendererReport.hostResult.undoGroupCloseAttempted === true,
        `${kind} Undo close was not attempted`
      );
      requireCondition(rendererReport.hostResult.undoGroupClosed === true, `${kind} Undo group did not close`);
      requireCondition(
        rendererReport.hostResult.selectionRestoreAttempted === true,
        `${kind} selection restoration was not attempted`
      );
      requireCondition(rendererReport.hostResult.selectionRestored === true, `${kind} selection was not restored`);
      requireCondition(rendererReport.hostResult.mutationAttempted === true, `${kind} mutation was not attempted`);
      requireCondition(rendererReport.hostResult.applyCompleted === true, `${kind} apply did not complete`);
      requireCondition(rendererReport.hostResult.applyError === null, `${kind} successful apply reported an error`);
      requireCondition(afterAction.projectPath === fixtureCopy, `${kind} action changed project path`);
      requireCondition(afterAction.dirty === true, `${kind} action did not dirty the project`);
      requireCondition(sameJson(afterAction.activeItem, before.activeItem), `${kind} action changed active item`);
      requireCondition(afterAction.numItems === before.numItems, `${kind} action changed project item count`);
      requireCondition(
        sameJson(canonicalSelection(afterAction.selection), canonicalSelection(before.selection)),
        `${kind} action changed selection`
      );
      assertExpectedFixtureSelection(
        afterAction.selection,
        projected,
        setup.otherPositionPath,
        `${kind} restored action`
      );
      requireCondition(
        fixtureHashAfterAction === fixtureHashBefore,
        `${kind} product action saved or rewrote the project`
      );
      await assertOwnedDisposition(rendererReport, "removed");
      rendererCleanupVerified = true;

      const savedApplied = await evalHost(client, saveProjectSource(fixtureCopy));
      requireCondition(savedApplied.ok === true, `${kind} applied save failed: ${JSON.stringify(savedApplied)}`);
      const appliedReadback = await readResolvedGradient(fixtureCopy, projected);
      assertGradient(appliedReadback.gradient, expectedAppliedGradient(), `${kind} applied readback`);

      const undo = await evalHost(client, undoProjectSource(fixtureCopy));
      requireCondition(undo.ok === true && undo.dirty === true, `${kind} Undo failed: ${JSON.stringify(undo)}`);
      requireCondition(undo.activeCompId === before.activeItem?.id, `${kind} Undo changed active item`);
      requireCondition(
        sameJson(canonicalSelection(undo.selection), canonicalSelection(before.selection)),
        `${kind} Undo changed restored selection`
      );
      const savedRestored = await evalHost(client, saveProjectSource(fixtureCopy));
      requireCondition(savedRestored.ok === true, `${kind} restored save failed: ${JSON.stringify(savedRestored)}`);
      const restoredReadback = await readResolvedGradient(fixtureCopy, projected);
      assertGradient(restoredReadback.gradient, descriptor.gradient, `${kind} restored readback`);
      const cleanRestoredProject = await evalHost(client, projectStateSource);
      requireCondition(
        cleanRestoredProject.dirty === false &&
          cleanRestoredProject.projectPath === fixtureCopy,
        `${kind} restored fixture was not a clean owned predecessor`
      );
      expectedProjectPredecessor = projectIdentity(cleanRestoredProject);

      successCases.push({
        kind,
        descriptor: projected,
        setup,
        baseline,
        snapshot,
        before,
        afterAction,
        fixtureHashBefore,
        fixtureHashAfterAction,
        storageBefore,
        storageAfter,
        resultEvents,
        rendererReport,
        savedApplied,
        appliedReadback,
        undo,
        savedRestored,
        restoredReadback,
      });
    }

    const failureDescriptor = descriptorProjection(
      sourceExpected.targets.find((candidate) => candidate.kind === "fill" && candidate.layerIndex === 1)
    );
    const failureFixture = resolve(TEMPORARY_ROOT, "track-b-injected-failure.aep");
    const failureAllowedProjectPaths = [originalProject.projectPath, ...ownedFixturePaths].filter(Boolean);
    ownedFixturePaths.push(failureFixture);
    await copyFile(FIXTURE_SOURCE, failureFixture);
    requireCondition(
      (await sha256(failureFixture)) === REVIEWED_INPUTS.fixture.sha256,
      "Injected-failure fixture copy did not match the reviewed immutable fixture"
    );
    const failurePreOpen = await evalHost(client, projectStateSource);
    requireCondition(
      failurePreOpen.dirty === false &&
        sameJson(projectIdentity(failurePreOpen), expectedProjectPredecessor),
      `Failure predecessor drifted before fixture open: ${JSON.stringify(failurePreOpen)}`
    );
    const failureSetup = await evalHost(
      client,
      openFixtureSource(
        failureFixture,
        failureDescriptor,
        expectedProjectPredecessor,
        failureAllowedProjectPaths
      )
    );
    requireCondition(failureSetup.ok === true, `Failure setup failed: ${JSON.stringify(failureSetup)}`);
    assertExpectedFixtureSelection(
      failureSetup.selection,
      failureDescriptor,
      failureSetup.otherPositionPath,
      "failure setup"
    );
    const failureBefore = await evalHost(client, projectStateSource);
    const failureHashBefore = await sha256(failureFixture);
    const failureStorageBefore = await snapshotStorage(TEMPORARY_ROOT);
    const failureBaseline = await client.evaluate(
      debugCall("(api) => ({ state: api.getState(), counters: api.getCounters() })")
    );

    injectionAttempted = true;
    await installUnknownCompletionInjection(client);
    rendererCleanupVerified = false;
    await triggerGradientAction(client);
    const pendingSnapshot = await waitForActionPending(
      client,
      failureBaseline.counters.hostCalls
    );
    const pendingStorage = await snapshotStorage(TEMPORARY_ROOT);
    requireCondition(
      pendingSnapshot.counters.emittedEvents === failureBaseline.counters.emittedEvents &&
        pendingSnapshot.counters.diskWrites === failureBaseline.counters.diskWrites &&
        sameJson(paletteState(pendingSnapshot.state), paletteState(failureBaseline.state)) &&
        sameJson(pendingStorage, failureStorageBefore),
      "Pending gradient action changed palette state before host completion"
    );
    await installPaletteResultListener(client);
    await dispatchBusyPaletteCommand(client, failureBaseline.state.paletteRevision);
    const busySnapshot = await waitForBusyCommandResult(client, failureBaseline);
    const busyStorage = await snapshotStorage(TEMPORARY_ROOT);
    const busyResultBatch = await readPaletteResultEvents(client);
    const busyResults = busyResultBatch.results;
    const busyTokens = validateOwnedEventTokens(busyResults, RUN_TOKEN, 1);
    observedResultRequestIds.push(...busyTokens.tokens);
    requireCondition(busyResults.length === 1, `Expected one busy result, found ${busyResults.length}`);
    const busyResult = busyResults[0];
    requireCondition(
      busyResult.requestId === RUN_TOKEN &&
        busyResult.ok === false &&
        busyResult.message === "Palette is busy; try again" &&
        sameJson(busyResult.document, failureStorageBefore.palette),
      `Overlapping palette command was not rejected exactly: ${JSON.stringify(busyResult)}`
    );
    requireCondition(
      busySnapshot.counters.hostCalls === failureBaseline.counters.hostCalls + 1 &&
        busySnapshot.counters.emittedEvents === failureBaseline.counters.emittedEvents + 1 &&
        busySnapshot.counters.receivedEvents === failureBaseline.counters.receivedEvents + 1 &&
        busySnapshot.counters.diskWrites === failureBaseline.counters.diskWrites &&
        sameJson(paletteState(busySnapshot.state), paletteState(failureBaseline.state)) &&
        sameJson(busyStorage, failureStorageBefore),
      "Overlapping palette command changed counters, storage, or revision unexpectedly"
    );
    await installPaletteResultListener(client);
    await releaseUnknownCompletionInjection(
      client,
      failureDescriptor,
      sourceExpected.afterEffectsVersion
    );
    const failureSnapshot = await waitForActionCompletion(
      client,
      failureBaseline.counters.hostCalls,
      (completed) =>
        observeRendererLeaseRoots(
          completed.state.lastHostResult,
          observedLeaseRoots,
          observedEvidenceRoots
        )
    );
    const failureReport = failureSnapshot.state.lastHostResult;
    lastRendererReport = failureReport;
    await writeDurableJson(resolve(OUTPUT_DIRECTORY, "unknown-completion-provisional.json"), {
      runToken: RUN_TOKEN,
      capturedAt: new Date().toISOString(),
      reviewedInputs: reviewedInputsStart,
      rendererReport: failureReport,
    });
    const failureResultBatch = await readPaletteResultEvents(client);
    const failureResultEvents = failureResultBatch.results;
    const failureTokens = validateOwnedEventTokens(
      failureResultEvents,
      RUN_TOKEN,
      1,
      { allowNullRequestId: true },
    );
    observedResultRequestIds.push(...failureTokens.tokens);
    const injectionCleanup = await removeUnknownCompletionInjection(client);
    injectionAttempted = false;
    cleanup.injection = injectionCleanup;
    const failureAfter = await evalHost(client, projectStateSource);
    const failureHashAfter = await sha256(failureFixture);
    const failureStorageAfter = await snapshotStorage(TEMPORARY_ROOT);

    requireCondition(
      failureSnapshot.counters.hostCalls === failureBaseline.counters.hostCalls + 1 &&
        failureSnapshot.counters.emittedEvents === failureBaseline.counters.emittedEvents + 2 &&
        failureSnapshot.counters.receivedEvents === failureBaseline.counters.receivedEvents + 1 &&
        failureSnapshot.counters.diskWrites === failureBaseline.counters.diskWrites &&
        failureSnapshot.state.paletteRevision === failureBaseline.state.paletteRevision &&
        failureSnapshot.state.pendingHostAction === null &&
        failureSnapshot.state.pendingPaletteMutation === false,
      "Injected failure or overlapping command changed bounded action deltas"
    );
    requireCondition(
      injectionCleanup.installed === true &&
        injectionCleanup.count === 1 &&
        injectionCleanup.pendingSettled === false,
      `Unknown completion injection cleanup drifted: ${JSON.stringify(injectionCleanup)}`
    );
    requireCondition(
      failureReport?.status === "host-unknown-completion",
      "Injected host failure was not classified as unknown completion"
    );
    requireCondition(
      failureReport.primaryStatus === "host-unknown-completion",
      "Injected primary status drifted"
    );
    requireCondition(
      failureReport.hostResult?.status === "apply-unknown-completion",
      "Injected unknown-completion host result was not preserved"
    );
    requireCondition(
      failureReport.hostResult?.primaryStatus === "apply-unknown-completion" &&
        failureReport.hostResult?.hostVersion === sourceExpected.afterEffectsVersion &&
        sameJson(failureReport.hostResult?.target, failureDescriptor) &&
        failureReport.hostResult?.selectedTargetCount === 1 &&
        failureReport.hostResult?.mutationAttempted === true &&
        failureReport.hostResult?.applyCompleted === false &&
        failureReport.hostResult?.undoGroupOpened === true &&
        failureReport.hostResult?.undoGroupCloseAttempted === true &&
        failureReport.hostResult?.undoGroupClosed === true &&
        failureReport.hostResult?.selectionRestoreAttempted === true &&
        failureReport.hostResult?.selectionRestored === true,
      `Injected exact host result schema drifted: ${JSON.stringify(failureReport.hostResult)}`
    );
    requireCondition(
      sameJson(failureReport.hostResult?.applyError, {
        name: "Error",
        message: "Injected B4 applyPreset unknown completion",
        line: null,
        number: null,
      }),
      "Injected apply error evidence drifted"
    );
    requireCondition(
      String(failureSnapshot.state.lastResult || "").includes("may have completed"),
      "Injected unknown completion did not produce the bounded Main notice"
    );
    requireCondition(
      failureResultEvents.length === 1 &&
        failureResultEvents[0].requestId === null &&
        failureResultEvents[0].ok === false &&
        failureResultEvents[0].message === failureSnapshot.state.lastResult &&
        sameJson(failureResultEvents[0].document, failureStorageBefore.palette),
      `Injected failure delivered result event drifted: ${JSON.stringify(failureResultEvents)}`
    );
    requireCondition(
      sameJson({ ...failureAfter, selection: undefined }, { ...failureBefore, selection: undefined }) &&
        sameJson(canonicalSelection(failureAfter.selection), canonicalSelection(failureBefore.selection)),
      "Injected host failure changed AE state"
    );
    requireCondition(
      sameJson(paletteState(failureSnapshot.state), paletteState(failureBaseline.state)) &&
        sameJson(failureStorageAfter, failureStorageBefore),
      "Injected failure changed palette state or authoritative storage"
    );
    requireCondition(failureHashAfter === failureHashBefore, "Injected host failure rewrote the project");
    const preservedPresetEvidence = await assertOwnedDisposition(failureReport, "preserved");
    requireCondition(preservedPresetEvidence.length === 2, "Preserved preset archive was incomplete");
    rendererCleanupVerified = true;

    const screenshot = await client.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    await writeFile(resolve(OUTPUT_DIRECTORY, "main-after-injected-failure.png"), screenshot.data, "base64");

    report = {
      passed: null,
      track: "B",
      runToken: RUN_TOKEN,
      action: "Apply Active Palette as Gradient",
      panelIdentity: identity,
      reviewedCommit: reviewedInputsStart.commit,
      productionBaseline,
      devBuildEvidence,
      buildOutputs,
      reviewedInputsStart,
      sourceFixture: {
        path: FIXTURE_SOURCE,
        sha256: sourceHash,
        expectedAeVersion: sourceExpected.afterEffectsVersion,
      },
      palette: PALETTE,
      temporaryStorageBaseline,
      expectedAppliedGradient: expectedAppliedGradient(),
      originalProject,
      successCases,
      injectedFailure: {
        descriptor: failureDescriptor,
        setup: failureSetup,
        baseline: failureBaseline,
        pendingSnapshot,
        busySnapshot,
        busyResult,
        resultEvents: failureResultEvents,
        snapshot: failureSnapshot,
        before: failureBefore,
        after: failureAfter,
        hashBefore: failureHashBefore,
        hashAfter: failureHashAfter,
        injectionCleanup,
        preservedPresetEvidence,
        rendererReport: failureReport,
      },
      screenshot: resolve(OUTPUT_DIRECTORY, "main-after-injected-failure.png"),
      harnessEvidence: {
        runToken: RUN_TOKEN,
        commandCounts: successCases.map(({ kind, baseline, snapshot }) => ({
          kind,
          hostCalls: snapshot.counters.hostCalls - baseline.counters.hostCalls,
          emittedEvents: snapshot.counters.emittedEvents - baseline.counters.emittedEvents,
          receivedEvents: snapshot.counters.receivedEvents - baseline.counters.receivedEvents,
          diskWrites: snapshot.counters.diskWrites - baseline.counters.diskWrites,
        })),
        injectionCounts: { unknownCompletion: injectionCleanup.count },
        reloadCounts,
        resultRequestIds: [...observedResultRequestIds],
        APP_VERSION: sourceExpected.afterEffectsVersion,
        panelUrls: { production: productionUrl, debug: devUrl },
        loadedAssets: { production: productionManifestBefore, debug: devManifest },
      },
      consoleEvidence: consoleEvidence(client.events),
    };
    bodyPassed = true;
  } catch (error) {
    failure = error;
    let failureScreenshot = null;
    let failureScreenshotError = null;
    if (client && evidenceRun && productionRestoreRequired) {
      try {
        const screenshot = await client.send("Page.captureScreenshot", {
          format: "png",
          fromSurface: true,
          captureBeyondViewport: false,
        });
        failureScreenshot = resolve(OUTPUT_DIRECTORY, "main-on-failure.png");
        await writeFile(failureScreenshot, screenshot.data, "base64");
      } catch (screenshotError) {
        failureScreenshotError =
          screenshotError instanceof Error ? screenshotError.message : String(screenshotError);
      }
    }
    report = {
      passed: false,
      track: "B",
      runToken: RUN_TOKEN,
      reviewedCommit: reviewedInputsStart?.commit || null,
      failure: error instanceof Error ? error.stack || error.message : String(error),
      originalProject,
      productionBaseline,
      devBuildEvidence,
      buildOutputs,
      reviewedInputsStart,
      lastRendererReport,
      failureScreenshot,
      failureScreenshotError,
      consoleEvidence: client ? consoleEvidence(client.events) : null,
    };
  } finally {
    const cleanupErrors = [];
    if (client) {
      if (originalPanel) {
      try {
      const orphanedResultBatch = await readPaletteResultEvents(client);
      if (orphanedResultBatch.results.length > 0) {
        const orphanedTokens = validateOwnedEventTokens(orphanedResultBatch.results, RUN_TOKEN, orphanedResultBatch.results.length);
        observedResultRequestIds.push(...orphanedTokens.tokens);
        cleanup.orphanedResultEvents = orphanedResultBatch.results;
      }
        cleanup.busyListener = true;
      } catch (error) {
        cleanup.busyListener = error instanceof Error ? error.message : String(error);
        cleanupErrors.push(`busy listener cleanup: ${cleanup.busyListener}`);
      }
      try {
        const injectionProbe = await removeUnknownCompletionInjection(client);
        if (injectionAttempted || cleanup.injection === null) cleanup.injection = injectionProbe;
        injectionAttempted = false;
        if (injectionProbe.owner !== null && injectionProbe.owner !== RUN_TOKEN) {
          throw new Error(`foreign injection owner: ${injectionProbe.owner}`);
        }
        await waitForIdle(client);
        const lockState = await client.evaluate(
          debugCall("(api) => ({ pendingHostAction: api.getState().pendingHostAction, pendingPaletteMutation: api.getState().pendingPaletteMutation })")
        );
        requireCondition(
          lockState.pendingHostAction === null && lockState.pendingPaletteMutation === false,
          `operation locks remained active: ${JSON.stringify(lockState)}`
        );
        cleanup.injectionAbsent = true;
      } catch (error) {
        cleanup.injection = error instanceof Error ? error.message : String(error);
        cleanupErrors.push(`injection cleanup: ${cleanup.injection}`);
      }
      } else {
        cleanup.busyListener = true;
        cleanup.injectionAbsent = true;
        cleanup.injection = { notRequired: true };
      }

      if (originalPanel && realStorageBefore && realConfigRoot) {
        try {
          await client.evaluate(debugCall("(api) => { api.resetTestState(); return true; }"));
          await afterRender(client);
          await waitUntil(async () => {
            const currentIdentity = await client.evaluate(debugCall("(api) => api.getIdentity()"));
            return currentIdentity.configRoot === null ? currentIdentity : false;
          }, 8_000, "fresh real-config debug closure");
          await client.evaluate(debugCall("(api) => api.reloadPalette()"));
          await afterRender(client);
          const restoredPanel = await waitUntil(async () => {
            const snapshot = await client.evaluate(
              debugCall("(api) => ({ identity: api.getIdentity(), state: api.getState() })")
            );
            return snapshot.identity.configRoot === null &&
              sameJson(paletteState(snapshot.state), paletteState(originalPanel.state))
              ? snapshot
              : false;
          }, 8_000, "exact original panel state");
          const realStorageAfter = await snapshotStorage(realConfigRoot);
          requireCondition(
            sameJson(realStorageAfter, realStorageBefore),
            "real palette/settings storage bytes changed"
          );
          cleanup.panel = {
            debugStateRestored: true,
            restoredPanel,
            realStorageBefore,
            realStorageAfter,
          };
        } catch (error) {
          cleanup.panel = error instanceof Error ? error.message : String(error);
          cleanupErrors.push(`panel cleanup: ${cleanup.panel}`);
        }
      } else {
        cleanup.panel = { debugStateRestored: true, notRequired: true };
      }

      if (originalProject && projectRegistrationConfirmed) {
        try {
          cleanup.project = await evalHost(
            client,
            restoreProjectSource(originalProject, ownedFixturePaths)
          );
          requireCondition(
            cleanup.project.restored === true,
            `project restoration failed: ${JSON.stringify(cleanup.project)}`
          );
        } catch (error) {
          cleanup.project = error instanceof Error ? error.message : String(error);
          cleanupErrors.push(`project cleanup: ${cleanup.project}`);
        }
      } else if (originalProject) {
        try {
          const currentProject = await evalHost(client, projectStateSource);
          requireCondition(
            sameJson(projectIdentity(currentProject), projectIdentity(originalProject)),
            "Unregistered original project drifted despite no authorized replacement"
          );
          cleanup.project = { restored: true, replacementNotAuthorized: true, state: currentProject };
        } catch (error) {
          cleanup.project = error instanceof Error ? error.message : String(error);
          cleanupErrors.push(`project cleanup: ${cleanup.project}`);
        }
      } else {
        cleanup.project = { restored: true, notRequired: true };
      }
      if (projectRegistrationAttempted) {
        try {
          const registrationProbe = await evalHost(client, probeOriginalProjectRegistrationSource);
          requireCondition(registrationProbe.foreign === false, "project registration owner became foreign");
          if (registrationProbe.owner === RUN_TOKEN) {
            const registrationRelease = await evalHost(
              client,
              releaseOriginalProjectRegistrationSource
            );
            requireCondition(
              registrationRelease.released === true && registrationRelease.foreign === false,
              `project registration release failed: ${JSON.stringify(registrationRelease)}`
            );
            cleanup.projectRegistration = registrationRelease;
          } else {
            requireCondition(
              projectRegistrationConfirmed === false && registrationProbe.owner === null,
              "confirmed project registration disappeared before release"
            );
            cleanup.projectRegistration = { released: true, notInstalled: true };
          }
          projectRegistrationConfirmed = false;
        } catch (error) {
          cleanup.projectRegistration = error instanceof Error ? error.message : String(error);
          cleanupErrors.push(`project registration cleanup: ${cleanup.projectRegistration}`);
        }
      } else {
        cleanup.projectRegistration = { released: true, notRequired: true };
      }

      const debugPanelCleanup = cleanup.panel;
      if (productionRestoreRequired) {
        try {
          buildOutputs.push(await runCanonicalBuild("build"));
          const productionManifestAfter = await createBuildManifest("production-restored");
          const productionUrl = pathToFileURL(await realpath(MAIN_PAGE)).href;
          const productionRuntimeAfter = await navigateMain(client, productionUrl, false);
          reloadCounts.production += 1;
          productionBuildEvidence = await assertRuntimeBuild(
            productionRuntimeAfter,
            productionManifestAfter,
            false
          );
          requireCondition(
            sameJson(productionManifestAfter.files, productionBaseline.build.files),
            "Canonical production rebuild did not reproduce the pre-run production bytes"
          );
          const realStorageAfterProduction = await snapshotStorage(realConfigRoot);
          requireCondition(
            sameJson(realStorageAfterProduction, realStorageBefore),
            "production restoration changed palette/settings storage bytes"
          );
          const debugStateRestored =
            typeof debugPanelCleanup === "object" && debugPanelCleanup?.debugStateRestored === true;
          cleanup.panel = {
            restored: debugStateRestored,
            debugCleanup: debugPanelCleanup,
            productionRuntime: productionRuntimeAfter,
            productionBuild: productionBuildEvidence,
            realStorageAfterProduction,
          };
          requireCondition(debugStateRestored, "debug panel state cleanup did not succeed before production restoration");
          productionRestoreRequired = false;
        } catch (error) {
          cleanup.panel = {
            restored: false,
            debugCleanup: debugPanelCleanup,
            productionError: error instanceof Error ? error.message : String(error),
          };
          cleanupErrors.push(`production panel restoration: ${cleanup.panel.productionError}`);
        }
      } else {
        cleanup.panel = {
          restored: typeof debugPanelCleanup === "object",
          productionNotChanged: true,
          debugCleanup: debugPanelCleanup,
        };
      }
    } else {
      cleanup.busyListener = true;
      cleanup.injectionAbsent = true;
      cleanup.panel = { restored: true, notRequired: true };
      cleanup.project = { restored: true, notRequired: true };
      cleanup.projectRegistration = projectRegistrationAttempted
        ? { released: false, reason: "CDP unavailable" }
        : { released: true, notRequired: true };
      if (projectRegistrationAttempted) {
        cleanupErrors.push("project registration cleanup: CDP unavailable");
      }
    }

    if (client) {
      try {
        await clearHarnessRunToken(client);
        const finalHarnessState = await client.evaluate(harnessPresenceExpression);
        assertNoHarnessProperties(finalHarnessState);
        const finalProjectOwner = await evalHost(client, probeOriginalProjectRegistrationSource);
        requireCondition(
          finalProjectOwner.owner === null && finalProjectOwner.foreign === false,
          `Final project harness owner remained present: ${JSON.stringify(finalProjectOwner)}`
        );
        cleanup.harnessAbsent = true;
      } catch (error) {
        cleanup.harnessAbsent = error instanceof Error ? error.message : String(error);
        cleanupErrors.push(`final harness absence: ${cleanup.harnessAbsent}`);
      }
    } else {
      cleanup.harnessAbsent = originalPanel ? "CDP client unavailable" : true;
      if (originalPanel) cleanupErrors.push("final harness absence: CDP client unavailable");
    }

    try {
      reviewedInputsEnd = await verifyReviewedInputs();
      assertReviewedInputsUnchanged(reviewedInputsStart, reviewedInputsEnd);
    } catch (error) {
      reviewedInputsEnd = { error: error instanceof Error ? error.message : String(error) };
      cleanupErrors.push(`reviewed input finalization: ${reviewedInputsEnd.error}`);
    }

    const rendererLeaseRoots = [...observedLeaseRoots].sort();
    const rendererEvidenceRoots = [...observedEvidenceRoots].sort();
    const rendererLeaseErrors = [];
    for (const leaseRoot of rendererLeaseRoots) {
      try {
        await requireAbsent(leaseRoot, "renderer-owned temporary root");
      } catch (error) {
        rendererLeaseErrors.push({
          root: leaseRoot,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    for (const evidenceRoot of rendererEvidenceRoots) {
      try {
        await requireAbsent(evidenceRoot, "renderer-owned evidence root after archival");
      } catch (error) {
        rendererLeaseErrors.push({
          root: evidenceRoot,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (!rendererCleanupVerified) {
      rendererLeaseErrors.push({
        root: null,
        error: "renderer operation completion or lease cleanup remained unverified",
      });
    }
    cleanup.rendererLeases = {
      verified: rendererLeaseErrors.length === 0,
      operationCleanupVerified: rendererCleanupVerified,
      roots: rendererLeaseRoots,
      evidenceRoots: rendererEvidenceRoots,
      errors: rendererLeaseErrors,
    };
    if (rendererLeaseErrors.length > 0) {
      cleanupErrors.push(`renderer lease cleanup: ${JSON.stringify(rendererLeaseErrors)}`);
    }

    if (client) {
      try {
        await client.close();
        client = null;
        cleanup.client = true;
      } catch (error) {
        cleanup.client = error instanceof Error ? error.message : String(error);
        cleanupErrors.push(`CDP client cleanup: ${cleanup.client}`);
      }
    } else {
      cleanup.client = true;
    }

    if (
      temporaryRootCreated &&
      cleanup.busyListener === true &&
      cleanup.panel?.restored === true &&
      cleanup.project?.restored === true &&
      cleanup.injectionAbsent === true &&
      cleanup.harnessAbsent === true
    ) {
      try {
        requireCondition(temporaryRun, "temporary run ownership was never acquired");
        await removeOwnedRunDirectory(temporaryRun);
        await requireAbsent(TEMPORARY_ROOT, "temporary run directory");
        cleanup.temp = true;
      } catch (error) {
        cleanup.temp = error instanceof Error ? error.message : String(error);
        cleanupErrors.push(`temporary cleanup: ${cleanup.temp}`);
      }
    } else if (!temporaryRootCreated) {
      cleanup.temp = true;
    } else {
      cleanup.temp = `preserved at ${TEMPORARY_ROOT}`;
      cleanupErrors.push(`temporary cleanup: ${cleanup.temp}`);
    }

    if (lockHandle) {
      try {
        await lockHandle.close();
        lockHandle = null;
        const lockStat = await lstat(LOCK_PATH);
        requireCondition(lockStat.isFile() && !lockStat.isSymbolicLink(), "run lock was replaced");
        const lockOwner = JSON.parse(await readFile(LOCK_PATH, "utf8"));
        requireCondition(
          lockOwner.kind === LOCK_MARKER.kind &&
            lockOwner.schema === LOCK_MARKER.schema &&
            lockOwner.contractVersion === LOCK_MARKER.contractVersion &&
            lockOwner.marker === LOCK_MARKER.marker &&
            lockOwner.markerFile === LOCK_MARKER.markerFile &&
            lockOwner.token === RUN_TOKEN,
          `lock ownership drifted to ${JSON.stringify(lockOwner)}`
        );
        await rm(LOCK_PATH, { force: false });
        await requireAbsent(LOCK_PATH, "run lock");
        cleanup.lock = true;
      } catch (error) {
        cleanup.lock = error instanceof Error ? error.message : String(error);
        cleanupErrors.push(`lock cleanup: ${cleanup.lock}`);
      }
    } else {
      cleanup.lock = true;
    }

    const passed = bodyPassed &&
      cleanupErrors.length === 0 &&
      cleanup.client === true &&
      cleanup.temp === true &&
      cleanup.lock === true &&
      cleanup.harnessAbsent === true &&
      reviewedInputsEnd !== null &&
      sameJson(reviewedInputsStart, reviewedInputsEnd);
    report = {
      ...report,
      passed,
      productionBuildEvidence,
      reviewedInputsEnd,
      buildOutputs,
      lastRendererReport,
      cleanup,
      cleanupErrors,
      secondaryFailures: cleanupErrors.map((error) => ({ stage: "finalization", error })),
      harnessEvidence: report?.harnessEvidence
        ? {
            ...report.harnessEvidence,
            reloadCounts: { ...reloadCounts },
            resultRequestIds: [...observedResultRequestIds],
          }
        : null,
    };
    if (evidenceRun) {
      try {
        const publication = await publishFinalReport({
          reportPath: resolve(OUTPUT_DIRECTORY, "report.json"),
          failurePath: resolve(OUTPUT_DIRECTORY, "failure-report.json"),
          report,
        });
        if (publication.errors.length > 0) {
          for (const publicationError of publication.errors) {
            cleanupErrors.push(`finalization ${publicationError.stage}: ${publicationError.error}`);
          }
          report = {
            ...report,
            passed: false,
            cleanupErrors,
            secondaryFailures: cleanupErrors.map((error) => ({ stage: "finalization", error })),
          };
          if (!failure) failure = new Error("Track B finalization evidence publication failed");
        }
      } catch (error) {
        cleanupErrors.push(`finalization publication: ${error instanceof Error ? error.message : String(error)}`);
        if (!failure) failure = error instanceof Error ? error : new Error(String(error));
      }
    }
    if (!passed && !failure) failure = new Error(`Track B cleanup failed: ${cleanupErrors.join("; ")}`);
  }

  if (failure) throw failure;
  process.stdout.write(
    `${JSON.stringify({ passed: true, report: resolve(OUTPUT_DIRECTORY, "report.json") }, null, 2)}\n`
  );
};

export const runFormalTrackB = main;
const isDirectCliInvocation = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectCliInvocation) {
  if (process.argv.length === 2) {
    runFormalTrackB().catch((error) => {
      console.error(error instanceof Error ? error.stack || error.message : String(error));
      process.exitCode = 1;
    });
  } else {
    console.error("This safety-bounded runner accepts no command-line options");
    process.exitCode = 2;
  }
}
