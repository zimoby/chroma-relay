import { spawn } from "node:child_process";
import { homedir, platform as currentPlatform, tmpdir } from "node:os";
import {
  lstat,
  mkdtemp,
  readlink,
  realpath,
  rm,
} from "node:fs/promises";
import { join, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import contract from "../../src/shared/product-contract.json" with { type: "json" };

export const BUILD_SCRIPT = "build:compile";
export const ISOLATION_HOME_PREFIX = "chroma-relay-build-home-";

const defaultFs = Object.freeze({ lstat, mkdtemp, readlink, realpath, rm });

const pathApiFor = (platform) => (platform === "win32" ? win32 : posix);

export const deriveCepExtensionLinkPath = ({
  platform = currentPlatform(),
  homedirPath = homedir(),
  extensionId = contract.product.extensionId,
} = {}) => {
  const pathApi = pathApiFor(platform);
  const root = platform === "win32"
    ? pathApi.join(homedirPath, "AppData", "Roaming", "Adobe", "CEP", "extensions")
    : pathApi.join(homedirPath, "Library", "Application Support", "Adobe", "CEP", "extensions");
  return pathApi.join(root, extensionId);
};

const missingSnapshot = (path) => Object.freeze({
  path,
  exists: false,
});

export const snapshotInstalledTarget = async (path, { fs = defaultFs } = {}) => {
  let stat;
  try {
    stat = await fs.lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return missingSnapshot(path);
    throw error;
  }

  const symbolicLink = stat.isSymbolicLink?.() === true;
  return Object.freeze({
    path,
    exists: true,
    symbolicLink,
    linkTarget: symbolicLink ? await fs.readlink(path) : null,
    resolvedTarget: await fs.realpath(path),
    mode: stat.mode,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    birthtimeMs: stat.birthtimeMs,
    dev: stat.dev,
    ino: stat.ino,
    uid: stat.uid,
    gid: stat.gid,
  });
};

export const assertInstalledTargetUnchanged = (before, after) => {
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error(`Installed Chroma Relay link drifted: ${before.path}`);
  }
};

export const createNpmBuildInvocation = ({
  env = process.env,
  execPath = process.execPath,
  platform = currentPlatform(),
} = {}) => {
  const npmExecPath = typeof env.npm_execpath === "string" ? env.npm_execpath.trim() : "";
  if (npmExecPath) {
    return Object.freeze({
      command: execPath,
      args: [npmExecPath, "run", BUILD_SCRIPT],
    });
  }
  return Object.freeze({
    command: platform === "win32" ? "npm.cmd" : "npm",
    args: ["run", BUILD_SCRIPT],
  });
};

export const spawnNpm = (invocation, { cwd, env, signal, spawnImpl = spawn }) => new Promise((resolve, reject) => {
  let child;
  try {
    child = spawnImpl(invocation.command, invocation.args, {
      cwd,
      env,
      stdio: "inherit",
      windowsHide: true,
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    reject(error);
    return;
  }

  let spawnError = null;
  let settled = false;
  const settle = (callback, value) => {
    if (settled) return;
    settled = true;
    callback(value);
  };

  child.once("error", (error) => {
    spawnError = error;
    if (!signal?.aborted) settle(reject, error);
  });
  child.once("exit", (code, childSignal) => {
    if (spawnError) settle(reject, spawnError);
    else settle(resolve, { code, signal: childSignal });
  });
});

const BUILD_SIGNALS = Object.freeze(["SIGINT", "SIGTERM"]);

export const createBuildSignalController = ({ processApi = process } = {}) => {
  const abortController = new AbortController();
  let receivedSignal = null;
  let installed = false;
  const onSignal = (signal) => {
    if (receivedSignal) return;
    receivedSignal = signal;
    abortController.abort();
  };
  const handlers = new Map(BUILD_SIGNALS.map((signal) => [signal, () => onSignal(signal)]));

  return Object.freeze({
    childSignal: abortController.signal,
    get receivedSignal() {
      return receivedSignal;
    },
    install() {
      if (installed) return;
      installed = true;
      for (const signal of BUILD_SIGNALS) processApi.on(signal, handlers.get(signal));
    },
    remove() {
      if (!installed) return;
      installed = false;
      for (const signal of BUILD_SIGNALS) processApi.removeListener(signal, handlers.get(signal));
    },
  });
};

export class IsolatedBuildSignalError extends Error {
  constructor(signal, cause) {
    super(`Isolated build interrupted by ${signal}`, cause ? { cause } : undefined);
    this.name = "IsolatedBuildSignalError";
    this.code = "ERR_ISOLATED_BUILD_SIGNAL";
    this.signal = signal;
  }
}

const assertTemporaryCompilerLink = async ({
  linkPath,
  outputPath,
  platform,
  fs,
}) => {
  const link = await fs.lstat(linkPath).catch((error) => {
    throw new Error(`Isolated CEP link is missing: ${linkPath}`, { cause: error });
  });
  if (platform !== "win32" && link.isSymbolicLink?.() !== true) {
    throw new Error(`Isolated CEP link is not a symbolic link: ${linkPath}`);
  }
  const expected = await fs.realpath(outputPath);
  const actual = await fs.realpath(linkPath);
  if (actual !== expected) {
    throw new Error(`Isolated CEP link target mismatch: expected ${expected}, got ${actual}`);
  }
};

const childFailure = (result) => {
  if (!result || result.code === 0 || result.status === 0) return null;
  const code = result.code ?? result.status ?? "unknown";
  const signal = result.signal ? ` (${result.signal})` : "";
  return new Error(`Isolated ${BUILD_SCRIPT} failed with exit ${code}${signal}`);
};

export async function runIsolatedBuild({
  repositoryRoot = fileURLToPath(new URL("../../", import.meta.url)),
  outputPath = join(repositoryRoot, "dist", "cep"),
  realInstalledLinkPath = deriveCepExtensionLinkPath(),
  platform = currentPlatform(),
  homedirPath = homedir(),
  env = process.env,
  fs = defaultFs,
  runChild = null,
  spawnImpl = spawn,
  processApi = process,
} = {}) {
  const signalController = createBuildSignalController({ processApi });
  let before = null;
  let ownedHome = null;
  let invocation = null;
  let result;
  let primaryError = null;
  let driftError = null;
  let cleanupError = null;

  signalController.install();
  try {
    before = await snapshotInstalledTarget(realInstalledLinkPath, { fs });
    if (signalController.receivedSignal) {
      throw new Error("Isolated build interrupted before temporary-home allocation");
    }

    ownedHome = await fs.mkdtemp(join(tmpdir(), ISOLATION_HOME_PREFIX));
    if (signalController.receivedSignal) {
      throw new Error("Isolated build interrupted before compiler launch");
    }

    const childEnv = {
      ...env,
      HOME: ownedHome,
      USERPROFILE: ownedHome,
      APPDATA: ownedHome,
    };
    const linkPath = deriveCepExtensionLinkPath({ platform, homedirPath: ownedHome });
    invocation = createNpmBuildInvocation({ env: childEnv, platform });
    const childRunner = runChild ?? ((childInvocation, options) => spawnNpm(childInvocation, { ...options, spawnImpl }));
    result = await childRunner(invocation, {
      cwd: repositoryRoot,
      env: childEnv,
      signal: signalController.childSignal,
    });
    primaryError = childFailure(result);
    if (!primaryError) {
      await assertTemporaryCompilerLink({ linkPath, outputPath, platform, fs });
    }
  } catch (error) {
    primaryError = error;
  } finally {
    if (before) {
      try {
        const after = await snapshotInstalledTarget(realInstalledLinkPath, { fs });
        assertInstalledTargetUnchanged(before, after);
      } catch (error) {
        driftError = error;
      }
    }
    if (ownedHome) {
      try {
        await fs.rm(ownedHome, { recursive: true, force: true });
      } catch (error) {
        cleanupError = error;
      }
    }
    signalController.remove();
  }

  const failures = [primaryError, driftError, cleanupError].filter(Boolean);
  let failure = null;
  if (failures.length === 1) failure = failures[0];
  else if (failures.length > 1) {
    const message = primaryError && driftError && !cleanupError
      ? "Isolated build failed and installed state drifted"
      : "Isolated build failed with multiple errors";
    failure = new AggregateError(failures, message);
  }

  if (signalController.receivedSignal) {
    throw new IsolatedBuildSignalError(signalController.receivedSignal, failure);
  }
  if (failure) throw failure;
  return Object.freeze({ result, invocation, installedTarget: before });
}
