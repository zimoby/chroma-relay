import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import contract from "../../src/shared/product-contract.json" with { type: "json" };

export class RunnerPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = "RunnerPolicyError";
  }
}

const defaultFs = { lstat, mkdir, readFile, realpath, rm, writeFile };
const markerName = contract.runner.markerFile;

export const parseRunnerArgs = (argv, { allowed = [] } = {}) => {
  const accepted = new Set(allowed);
  const result = {};
  for (const argument of argv) {
    if (!argument.startsWith("--") || !argument.includes("=")) {
      throw new RunnerPolicyError(`Malformed runner argument: ${argument}`);
    }
    const [key, ...parts] = argument.slice(2).split("=");
    const value = parts.join("=");
    if (!accepted.has(key)) throw new RunnerPolicyError(`Unknown runner option: ${key}`);
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      throw new RunnerPolicyError(`Duplicate runner option: ${key}`);
    }
    if (!value.trim()) throw new RunnerPolicyError(`Empty runner option: ${key}`);
    if (key === "output" && [".", "./", "..", "../"].includes(value.trim())) {
      throw new RunnerPolicyError("Root output directory is rejected");
    }
    if (key === "output") {
      if (isAbsolute(value)) throw new RunnerPolicyError("Absolute output roots are rejected");
      if (value.replaceAll("\\", "/").split("/").includes("..")) {
        throw new RunnerPolicyError("Output root contains traversal");
      }
    }
    result[key] = value;
  }
  return result;
};

const exists = async (fs, path) => {
  try {
    await fs.lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
};

const isInside = (root, candidate) => {
  const fromRoot = relative(root, candidate);
  return fromRoot !== "" && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
};

const isDirectChild = (root, candidate) => {
  if (!isInside(root, candidate)) return false;
  return relative(root, candidate).split(sep).length === 1;
};

const rejectSymlinkComponents = async (path, fs) => {
  const parts = path.split(sep).filter(Boolean);
  let current = path.startsWith(sep) ? sep : "";
  for (let index = 0; index < parts.length; index += 1) {
    current = current === sep ? `${current}${parts[index]}` : `${current}${sep}${parts[index]}`;
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink?.() && index > 0 && current !== "/tmp" && current !== "/private/tmp") {
        throw new RunnerPolicyError("Output root escapes through a symlink");
      }
    } catch (error) {
      if (error instanceof RunnerPolicyError) throw error;
      if (error?.code !== "ENOENT") throw error;
      break;
    }
  }
};

const validateOutputRoot = async (
  value,
  { cwd = process.cwd(), fs = defaultFs, fixedRoots = [], allowAbsolute = false } = {}
) => {
  if (typeof value !== "string" || !value.trim()) throw new RunnerPolicyError("Empty output root");
  if (value.includes("\0")) throw new RunnerPolicyError("Output root contains NUL");
  if (isAbsolute(value) && !allowAbsolute) throw new RunnerPolicyError("Absolute output roots are rejected");
  const segments = value.replaceAll("\\", "/").split("/");
  if (segments.includes("..")) throw new RunnerPolicyError("Output root contains traversal");
  const root = resolve(cwd, value);
  if (root === resolve(cwd)) throw new RunnerPolicyError("Root output directory is rejected");
  const fixed = fixedRoots.map((path) => resolve(cwd, path));
  if (fixed.includes(root)) throw new RunnerPolicyError("fixed output root is rejected");
  const rootExists = await exists(fs, root);
  const parent = rootExists ? root : resolve(root, "..");
  let realParent;
  try {
    realParent = await fs.realpath(parent);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    realParent = resolve(cwd, parent);
  }
  if (!allowAbsolute && !isInside(resolve(cwd), realParent) && realParent !== resolve(cwd)) {
    throw new RunnerPolicyError("Output root escapes through a symlink");
  }
  if (allowAbsolute) await rejectSymlinkComponents(root, fs);
  if (rootExists) {
    const stat = await fs.lstat(root);
    if (stat.isSymbolicLink?.()) throw new RunnerPolicyError("Output root is a symlink");
    if (!stat.isDirectory?.()) throw new RunnerPolicyError("Output root is not a directory");
    const resolvedRoot = await fs.realpath(root);
    if (!allowAbsolute && !isInside(resolve(cwd), resolvedRoot) && resolvedRoot !== resolve(cwd)) {
      throw new RunnerPolicyError("Output root escapes through a symlink");
    }
    const markerPath = resolve(root, markerName);
    if (await exists(fs, markerPath)) {
      let marker;
      try {
        marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
      } catch {
        throw new RunnerPolicyError("foreign output ownership marker");
      }
      if (marker?.kind !== contract.runner.ownershipKind || marker?.schema !== contract.runner.ownershipSchema) {
        throw new RunnerPolicyError("foreign or stale output ownership marker");
      }
      throw new RunnerPolicyError("Output root is an existing owned run directory");
    }
  }
  return root;
};

const validateToken = (token) => {
  if (typeof token !== "string" || !token || token === "." || token === ".." || token.includes("/") || token.includes("\\")) {
    throw new RunnerPolicyError("Invalid run token");
  }
};

const markerFor = ({ root, child, token }) => ({
  kind: contract.runner.ownershipKind,
  schema: contract.runner.ownershipSchema,
  contractVersion: contract.contractVersion,
  marker: contract.marker.current,
  token,
  root,
  child,
});

const createMarkedChild = async (root, { fs = defaultFs, tokenFactory, ...options } = {}) => {
  const rootReal = await fs.realpath(root);
  const makeToken = tokenFactory || (() => `run-${Date.now().toString(36)}-${randomBytes(8).toString("hex")}`);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const token = makeToken();
    validateToken(token);
    const path = resolve(root, token);
    try {
      await fs.mkdir(path, { recursive: false, ...options.mkdirOptions });
    } catch (error) {
      if (error?.code === "EEXIST") continue;
      throw error;
    }
    const childReal = await fs.realpath(path);
    const markerPath = resolve(path, markerName);
    const marker = markerFor({ root: rootReal, child: childReal, token });
    try {
      await fs.writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
    } catch (error) {
      error.residuePath = path;
      error.residueMarkerPath = markerPath;
      error.message = `${error.message}; owned residue preserved at ${path}`;
      throw error;
    }
    return { root, path, token, markerPath };
  }
  throw new RunnerPolicyError("Could not allocate an exclusive run-token directory");
};

export const createOwnedRunDirectory = async (outputRoot, options = {}) => {
  const fs = options.fs || defaultFs;
  const root = await validateOutputRoot(outputRoot, { ...options, fs, allowAbsolute: true });
  if (!(await exists(fs, root))) await fs.mkdir(root, { recursive: true });
  const rootStat = await fs.lstat(root);
  if (rootStat.isSymbolicLink?.() || !rootStat.isDirectory?.()) {
    throw new RunnerPolicyError("Output root was replaced before allocation");
  }
  return createMarkedChild(root, options);
};

const readJsonMarker = async (markerPath, fs) => {
  try {
    return JSON.parse(await fs.readFile(markerPath, "utf8"));
  } catch {
    throw new RunnerPolicyError("Owned run directory marker is missing or malformed");
  }
};

const assertOwnedRun = async (run, fs) => {
  if (!run || typeof run.path !== "string" || typeof run.root !== "string") {
    throw new RunnerPolicyError("Refusing to remove an unknown owned run directory");
  }
  const rootPath = resolve(run.root);
  const childPath = resolve(run.path);
  if (!isDirectChild(rootPath, childPath)) throw new RunnerPolicyError("Run directory is not a direct child");

  const rootStat = await fs.lstat(rootPath);
  const childStat = await fs.lstat(childPath);
  if (rootStat.isSymbolicLink?.() || !rootStat.isDirectory?.()) {
    throw new RunnerPolicyError("Run root is not owned");
  }
  if (childStat.isSymbolicLink?.() || !childStat.isDirectory?.()) {
    throw new RunnerPolicyError("Run directory is not owned");
  }
  const rootReal = await fs.realpath(rootPath);
  const childReal = await fs.realpath(childPath);
  if (!isDirectChild(rootReal, childReal)) throw new RunnerPolicyError("Run directory escaped its root");

  const markerPath = resolve(childPath, markerName);
  if (run.markerPath !== undefined && resolve(run.markerPath) !== markerPath) {
    throw new RunnerPolicyError("Forged ownership marker path");
  }
  const markerStat = await fs.lstat(markerPath);
  if (markerStat.isSymbolicLink?.() || markerStat.isDirectory?.() || markerStat.isFile?.() === false) {
    throw new RunnerPolicyError("Owned run directory marker is not a regular file");
  }
  const markerReal = await fs.realpath(markerPath);
  if (resolve(markerReal) !== resolve(childReal, markerName)) {
    throw new RunnerPolicyError("Owned run directory marker escaped its child");
  }
  const marker = await readJsonMarker(markerPath, fs);
  if (
    marker?.kind !== contract.runner.ownershipKind ||
    marker?.schema !== contract.runner.ownershipSchema ||
    marker?.contractVersion !== contract.contractVersion ||
    marker?.marker !== contract.marker.current ||
    marker?.token !== run.token ||
    marker?.root !== rootReal ||
    marker?.child !== childReal
  ) {
    throw new RunnerPolicyError("Owned run directory marker does not match current contract");
  }
  return { rootPath, childPath, rootReal, childReal, markerPath, marker };
};

export const createOwnedScratchDirectory = async (parentRun, options = {}) => {
  const fs = options.fs || defaultFs;
  const parent = await assertOwnedRun(parentRun, fs);
  return createMarkedChild(parent.childPath, { ...options, fs });
};

export const removeOwnedRunDirectory = async (run, { fs = defaultFs } = {}) => {
  const verified = await assertOwnedRun(run, fs);
  await fs.rm(verified.childPath, { recursive: true, force: false });
};

export const validateOutputRootForTest = validateOutputRoot;
