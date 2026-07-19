import {
  generateGradientFfx,
  validateGeneratedGradient,
  type GradientFfxKind,
  type GradientFfxStructuralReport,
  type NativeGradient,
} from "@zimoby/ae-native-gradient";
import { crypto, fs, os, path } from "../lib/cep/node.ts";
import {
  resolveNativeGradientTemplateFamily,
  type NativeGradientApplyStatus,
} from "../shared/native-gradient-contract.ts";

export type PaletteRgba = readonly [number, number, number, number];

export type NativeGradientPresetLease = Readonly<{
  schemaVersion: 1;
  runToken: string;
  kind: GradientFfxKind;
  stopCount: number;
  tempBasePath: string;
  rootPath: string;
  presetPath: string;
  filename: string;
  byteLength: number;
  sha256: string;
  templateSha256: string;
  toolkitReport: GradientFfxStructuralReport;
}>;

export type NativeGradientCleanupResult = Readonly<{
  removed: boolean;
  alreadyAbsent: boolean;
  preserved: boolean;
  evidenceRootPath: string | null;
  evidencePresetPath: string | null;
}>;

export type NativeGradientCapabilityReport = Readonly<{
  schemaVersion: 1;
  passed: boolean;
  processVersion: string | null;
  userAgent: string;
  capabilities: Readonly<{
    fs: boolean;
    crypto: boolean;
    rename: boolean;
  }>;
  renameProbe: Readonly<{
    attempted: boolean;
    passed: boolean;
  }>;
  errors: readonly string[];
}>;

export type NativeGradientCapabilityEnvironment = Readonly<{
  processVersion?: string | null;
  fs?: typeof fs | null;
  path?: typeof path | null;
  crypto?: typeof crypto | null;
}>;

export class NativeGradientFileError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "NativeGradientFileError";
    this.code = code;
  }
}

const ROOT_PREFIX = "chroma-relay-native-gradient-";
const EVIDENCE_ROOT_PREFIX = "chroma-relay-native-gradient-evidence-";
const FILE_PREFIX = "chroma-relay-native-gradient-";
const RUN_TOKEN_BYTES = 16;
const TEMP_TOKEN_BYTES = 8;
const RUN_TOKEN_PATTERN = /^[A-F0-9]{32}$/;
const MAX_TEMPLATE_BYTES = 1024 * 1024;
const MAX_PRESET_BYTES = 2 * 1024 * 1024;
const TOOLKIT_COLOR_STOP_EXTRA = 1;
const TEMPLATE_SHA256: Readonly<Record<GradientFfxKind, string>> = {
  fill: "a0cddaf936cc337a427d3a81c4224764fd6fc1f13a9bbeb6ae863276fa28dc59",
  stroke: "cb1ffe6195604834203a950433a83dd7097e971f8477567fdc2c32e3c34ed9dd",
};

const fail = (code: string, message: string): never => {
  throw new NativeGradientFileError(code, message);
};

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const isMissingPathError = (error: unknown) =>
  Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT");

const isCollisionError = (error: unknown) =>
  Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "EEXIST");

const hashBytes = (bytes: Uint8Array, cryptoModule: typeof crypto = crypto) =>
  cryptoModule.createHash("sha256").update(bytes).digest("hex");

const randomHexToken = (byteLength: number, cryptoModule: typeof crypto = crypto) => {
  if (typeof cryptoModule.randomBytes !== "function") {
    fail("capability-unavailable", "Cryptographic random bytes are unavailable");
  }
  const bytes = cryptoModule.randomBytes(byteLength);
  if (!bytes || bytes.byteLength !== byteLength) {
    fail("capability-unavailable", "Cryptographic random bytes returned an invalid length");
  }
  let token = "";
  for (let index = 0; index < bytes.byteLength; index += 1) {
    token += bytes[index].toString(16).padStart(2, "0");
  }
  return token.toUpperCase();
};

const expectedFilename = (runToken: string, kind: GradientFfxKind, stopCount: number) =>
  `${FILE_PREFIX}${runToken}-${kind}-${stopCount}.ffx`;

const assertDirectChild = (basePath: string, childPath: string, expectedBaseName: string) => {
  if (
    path.dirname(childPath) !== basePath ||
    path.basename(childPath) !== expectedBaseName ||
    path.join(basePath, expectedBaseName) !== childPath
  ) {
    fail("path-invalid", "Generated path is not the expected direct child");
  }
};

const resolveExistingDirectory = (
  requestedPath: string,
  fsModule: typeof fs = fs,
  pathModule: typeof path = path,
) => {
  if (typeof requestedPath !== "string" || requestedPath.length === 0) {
    fail("temp-base-invalid", "Temporary base path must be a non-empty string");
  }
  let realPath = "";
  try {
    realPath = fsModule.realpathSync(pathModule.resolve(requestedPath));
    const status = fsModule.statSync(realPath);
    if (!status.isDirectory()) fail("temp-base-invalid", "Temporary base must be a directory");
  } catch (error) {
    if (error instanceof NativeGradientFileError) throw error;
    fail("temp-base-invalid", `Temporary base is unavailable: ${errorMessage(error)}`);
  }
  return realPath;
};

export const paletteRgbaToNativeGradient = (palette: unknown): NativeGradient => {
  if (!Array.isArray(palette) || palette.length < 2 || palette.length > 8) {
    fail("palette-invalid", "Native gradient application requires 2 to 8 RGBA colors");
  }

  const paletteEntries = palette as unknown[];
  const colors: Array<[number, number, number, number]> = Array.from(
    { length: paletteEntries.length },
    (_, colorIndex) => {
      const candidate = paletteEntries[colorIndex];
      if (!Array.isArray(candidate) || candidate.length !== 4) {
        fail("palette-invalid", `Palette color ${colorIndex} must contain exactly four components`);
      }
      const candidateComponents = candidate as unknown[];
      const components = [
        candidateComponents[0],
        candidateComponents[1],
        candidateComponents[2],
        candidateComponents[3],
      ];
      for (let componentIndex = 0; componentIndex < components.length; componentIndex += 1) {
        const component = components[componentIndex];
        if (
          typeof component !== "number" ||
          !Number.isFinite(component) ||
          component < 0 ||
          component > 1
        ) {
          fail(
            "palette-invalid",
            `Palette color ${colorIndex} component ${componentIndex} must be finite and within [0,1]`,
          );
        }
      }
      return components as [number, number, number, number];
    },
  );

  const denominator = colors.length - 1;
  return {
    schemaVersion: 1,
    colorStops: colors.map((color, index) => ({
      offset: index / denominator,
      midpoint: 0.5,
      rgb: [color[0], color[1], color[2]],
      extra: TOOLKIT_COLOR_STOP_EXTRA,
    })),
    alphaStops: colors.map((color, index) => ({
      offset: index / denominator,
      midpoint: 0.5,
      alpha: color[3],
    })),
  };
};

export const validateNativeGradientForApplication = (value: unknown): NativeGradient => {
  const gradient = (() => {
    try {
      return validateGeneratedGradient(value);
    } catch (error) {
      return fail("gradient-invalid", `Stored native gradient is invalid: ${errorMessage(error)}`);
    }
  })();
  gradient.colorStops.forEach((stop, stopIndex) => {
    stop.rgb.forEach((component, componentIndex) => {
      if (component < 0 || component > 1) {
        fail(
          "gradient-invalid",
          `Gradient color stop ${stopIndex} component ${componentIndex} must be within [0,1]`,
        );
      }
    });
  });
  return gradient;
};

type NativeGradientPresetInput =
  | Readonly<{ palette: unknown; gradient?: never }>
  | Readonly<{ gradient: unknown; palette?: never }>;

const readVerifiedTemplate = (templatePath: string, kind: GradientFfxKind) => {
  let realTemplatePath = "";
  let expectedByteLength = 0;
  try {
    realTemplatePath = fs.realpathSync(path.resolve(templatePath));
    const status = fs.statSync(realTemplatePath);
    if (!status.isFile()) fail("template-invalid", "Native gradient template must be a regular file");
    if (status.size <= 0 || status.size > MAX_TEMPLATE_BYTES) {
      fail("template-invalid", "Native gradient template size is outside the allowed bound");
    }
    expectedByteLength = status.size;
  } catch (error) {
    if (error instanceof NativeGradientFileError) throw error;
    fail("template-invalid", `Native gradient template is unavailable: ${errorMessage(error)}`);
  }

  let bytes = new Uint8Array(0);
  try {
    bytes = new Uint8Array(fs.readFileSync(realTemplatePath));
  } catch (error) {
    fail("template-invalid", `Native gradient template could not be read: ${errorMessage(error)}`);
  }
  if (bytes.byteLength !== expectedByteLength) {
    fail("template-invalid", "Native gradient template changed while it was being read");
  }
  const sha256 = hashBytes(bytes);
  if (sha256 !== TEMPLATE_SHA256[kind]) {
    fail("template-mismatch", `Native gradient ${kind} template hash does not match the owned asset`);
  }
  return { bytes, sha256 };
};

const removeRegularFileIfPresent = (filePath: string) => {
  try {
    const status = fs.lstatSync(filePath);
    if (status.isFile() && !status.isSymbolicLink()) fs.unlinkSync(filePath);
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
};

const cleanFailedPublication = (rootPath: string, tempPath: string, presetPath: string) => {
  try {
    removeRegularFileIfPresent(tempPath);
  } catch {
    // Preserve the primary publication error.
  }
  try {
    removeRegularFileIfPresent(presetPath);
  } catch {
    // Preserve the primary publication error.
  }
  try {
    fs.rmdirSync(rootPath);
  } catch {
    // A non-empty or substituted root is intentionally preserved.
  }
};

export const createNativeGradientPreset = (options: NativeGradientPresetInput & Readonly<{
  kind: GradientFfxKind;
  tempBasePath: string;
  templatePath: string;
}>): NativeGradientPresetLease => {
  const hasPalette = Object.prototype.hasOwnProperty.call(options, "palette");
  const hasGradient = Object.prototype.hasOwnProperty.call(options, "gradient");
  if (hasPalette === hasGradient) {
    fail("gradient-input-invalid", "Provide exactly one native gradient input");
  }
  const gradient = hasGradient
    ? validateNativeGradientForApplication(options.gradient)
    : paletteRgbaToNativeGradient(options.palette);
  if (options.kind !== "fill" && options.kind !== "stroke") {
    fail("kind-invalid", "Native gradient preset kind must be fill or stroke");
  }

  const tempBasePath = resolveExistingDirectory(options.tempBasePath);
  const template = readVerifiedTemplate(options.templatePath, options.kind);
  const generated = generateGradientFfx(template.bytes, options.kind, gradient);
  if (generated.bytes.byteLength <= 0 || generated.bytes.byteLength > MAX_PRESET_BYTES) {
    fail("generation-invalid", "Generated native gradient preset size is outside the allowed bound");
  }

  const runToken = randomHexToken(RUN_TOKEN_BYTES);
  if (!RUN_TOKEN_PATTERN.test(runToken)) {
    fail("capability-unavailable", "Cryptographic run token did not match the strict grammar");
  }
  const rootName = `${ROOT_PREFIX}${runToken}`;
  const rootPath = path.join(tempBasePath, rootName);
  assertDirectChild(tempBasePath, rootPath, rootName);

  try {
    fs.mkdirSync(rootPath, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (isCollisionError(error)) fail("path-collision", "Generated native gradient root already exists");
    fail("publication-failed", `Could not create generated preset root: ${errorMessage(error)}`);
  }

  const filename = expectedFilename(runToken, options.kind, gradient.colorStops.length);
  const presetPath = path.join(rootPath, filename);
  assertDirectChild(rootPath, presetPath, filename);
  const tempName = `.${filename}.${randomHexToken(TEMP_TOKEN_BYTES)}.tmp`;
  const tempPath = path.join(rootPath, tempName);
  assertDirectChild(rootPath, tempPath, tempName);

  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(tempPath, "wx", 0o600);
    let offset = 0;
    while (offset < generated.bytes.byteLength) {
      const written = fs.writeSync(
        descriptor,
        generated.bytes,
        offset,
        generated.bytes.byteLength - offset,
        null,
      );
      if (written <= 0) fail("publication-failed", "Generated preset write made no progress");
      offset += written;
    }
    fs.closeSync(descriptor);
    descriptor = null;

    try {
      fs.lstatSync(presetPath);
      fail("path-collision", "Generated native gradient preset already exists");
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }

    const beforeRename = fs.readdirSync(rootPath);
    if (beforeRename.length !== 1 || beforeRename[0] !== tempName) {
      fail("path-collision", "Generated preset root was modified before publication");
    }
    fs.renameSync(tempPath, presetPath);

    const entries = fs.readdirSync(rootPath);
    if (entries.length !== 1 || entries[0] !== filename) {
      fail("verification-failed", "Generated preset root shape changed after publication");
    }
    const publishedStatus = fs.lstatSync(presetPath);
    if (!publishedStatus.isFile() || publishedStatus.isSymbolicLink()) {
      fail("verification-failed", "Published native gradient preset is not a regular owned file");
    }
    const published = new Uint8Array(fs.readFileSync(presetPath));
    const sha256 = hashBytes(published);
    const generatedSha256 = hashBytes(generated.bytes);
    if (
      published.byteLength !== generated.bytes.byteLength ||
      publishedStatus.size !== generated.bytes.byteLength ||
      sha256 !== generatedSha256
    ) {
      fail("verification-failed", "Published native gradient preset failed byte/hash verification");
    }

    return {
      schemaVersion: 1,
      runToken,
      kind: options.kind,
      stopCount: gradient.colorStops.length,
      tempBasePath,
      rootPath,
      presetPath,
      filename,
      byteLength: published.byteLength,
      sha256,
      templateSha256: template.sha256,
      toolkitReport: generated.report,
    };
  } catch (error) {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Preserve the primary publication error.
      }
    }
    cleanFailedPublication(rootPath, tempPath, presetPath);
    if (error instanceof NativeGradientFileError) throw error;
    return fail(
      "publication-failed",
      `Could not publish generated native gradient preset: ${errorMessage(error)}`,
    );
  }
};

const assertLeaseShape = (lease: NativeGradientPresetLease) => {
  if (!lease || typeof lease !== "object") fail("cleanup-refused", "Preset lease is missing");
  if (!RUN_TOKEN_PATTERN.test(lease.runToken)) {
    fail("cleanup-refused", "Preset lease run token has an invalid grammar");
  }
  if (lease.kind !== "fill" && lease.kind !== "stroke") {
    fail("cleanup-refused", "Preset lease kind is invalid");
  }
  if (!Number.isInteger(lease.stopCount) || lease.stopCount < 2 || lease.stopCount > 8) {
    fail("cleanup-refused", "Preset lease stop count is invalid");
  }
  if (!Number.isInteger(lease.byteLength) || lease.byteLength <= 0 || lease.byteLength > MAX_PRESET_BYTES) {
    fail("cleanup-refused", "Preset lease byte length is invalid");
  }
  if (!/^[a-f0-9]{64}$/.test(lease.sha256)) {
    fail("cleanup-refused", "Preset lease SHA-256 is invalid");
  }

  const tempBasePath = resolveExistingDirectory(lease.tempBasePath);
  if (tempBasePath !== lease.tempBasePath) {
    fail("cleanup-refused", "Preset lease temporary base is not canonical");
  }
  const rootName = `${ROOT_PREFIX}${lease.runToken}`;
  const expectedRootPath = path.join(tempBasePath, rootName);
  const filename = expectedFilename(lease.runToken, lease.kind, lease.stopCount);
  const expectedPresetPath = path.join(expectedRootPath, filename);
  if (
    lease.rootPath !== expectedRootPath ||
    lease.filename !== filename ||
    lease.presetPath !== expectedPresetPath
  ) {
    fail("cleanup-refused", "Preset lease paths do not match the exact owned shape");
  }
  assertDirectChild(tempBasePath, lease.rootPath, rootName);
  assertDirectChild(lease.rootPath, lease.presetPath, filename);
};

const assertLeasePresentAndUnchanged = (lease: NativeGradientPresetLease) => {
  try {
    assertLeaseShape(lease);
  } catch (error) {
    if (error instanceof NativeGradientFileError) {
      throw new NativeGradientFileError("cleanup-refused", error.message);
    }
    fail("cleanup-refused", `Preset lease validation failed: ${errorMessage(error)}`);
  }

  let rootStatus: ReturnType<typeof fs.lstatSync> | null = null;
  try {
    rootStatus = fs.lstatSync(lease.rootPath);
  } catch (error) {
    if (isMissingPathError(error)) return false;
    fail("cleanup-refused", `Preset root could not be inspected: ${errorMessage(error)}`);
  }
  if (!rootStatus || !rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
    fail("cleanup-refused", "Preset root is not an owned regular directory");
  }
  let realRoot = "";
  try {
    realRoot = fs.realpathSync(lease.rootPath);
  } catch (error) {
    fail("cleanup-refused", `Preset root realpath failed: ${errorMessage(error)}`);
  }
  if (realRoot !== lease.rootPath) {
    fail("cleanup-refused", "Preset root realpath does not match its owned path");
  }

  let entries: string[] = [];
  try {
    entries = fs.readdirSync(lease.rootPath);
  } catch (error) {
    fail("cleanup-refused", `Preset root could not be listed: ${errorMessage(error)}`);
  }
  if (entries.length !== 1 || entries[0] !== lease.filename) {
    fail("cleanup-refused", "Preset root contains unexpected or missing entries");
  }

  try {
    const presetStatus = fs.lstatSync(lease.presetPath);
    if (!presetStatus.isFile() || presetStatus.isSymbolicLink()) {
      fail("cleanup-refused", "Preset path is not an owned regular file");
    }
    const bytes = new Uint8Array(fs.readFileSync(lease.presetPath));
    if (
      presetStatus.size !== lease.byteLength ||
      bytes.byteLength !== lease.byteLength ||
      hashBytes(bytes) !== lease.sha256
    ) {
      fail("cleanup-refused", "Preset bytes no longer match the lease");
    }
  } catch (error) {
    if (error instanceof NativeGradientFileError) throw error;
    fail("cleanup-refused", `Preset verification failed: ${errorMessage(error)}`);
  }
  return true;
};

export const cleanupNativeGradientPreset = (
  lease: NativeGradientPresetLease,
): NativeGradientCleanupResult => {
  if (!assertLeasePresentAndUnchanged(lease)) {
    return {
      removed: false,
      alreadyAbsent: true,
      preserved: false,
      evidenceRootPath: null,
      evidencePresetPath: null,
    };
  }
  try {
    fs.unlinkSync(lease.presetPath);
    fs.rmdirSync(lease.rootPath);
  } catch (error) {
    fail("cleanup-refused", `Preset cleanup failed: ${errorMessage(error)}`);
  }
  return {
    removed: true,
    alreadyAbsent: false,
    preserved: false,
    evidenceRootPath: null,
    evidencePresetPath: null,
  };
};

export const preserveNativeGradientPreset = (
  lease: NativeGradientPresetLease,
): NativeGradientCleanupResult => {
  if (!assertLeasePresentAndUnchanged(lease)) {
    fail("preservation-refused", "Preset root disappeared before evidence preservation");
  }
  const evidenceRootName = `${EVIDENCE_ROOT_PREFIX}${lease.runToken}`;
  const evidenceRootPath = path.join(lease.tempBasePath, evidenceRootName);
  const evidencePresetPath = path.join(evidenceRootPath, lease.filename);
  assertDirectChild(lease.tempBasePath, evidenceRootPath, evidenceRootName);
  try {
    fs.lstatSync(evidenceRootPath);
    fail("preservation-refused", "Evidence root already exists");
  } catch (error) {
    if (error instanceof NativeGradientFileError) throw error;
    if (!isMissingPathError(error)) {
      fail("preservation-refused", `Evidence root could not be inspected: ${errorMessage(error)}`);
    }
  }
  try {
    fs.renameSync(lease.rootPath, evidenceRootPath);
    const evidenceStatus = fs.lstatSync(evidenceRootPath);
    const presetStatus = fs.lstatSync(evidencePresetPath);
    const bytes = new Uint8Array(fs.readFileSync(evidencePresetPath));
    if (
      !evidenceStatus.isDirectory() ||
      evidenceStatus.isSymbolicLink() ||
      !presetStatus.isFile() ||
      presetStatus.isSymbolicLink() ||
      presetStatus.size !== lease.byteLength ||
      bytes.byteLength !== lease.byteLength ||
      hashBytes(bytes) !== lease.sha256
    ) {
      fail("preservation-refused", "Preserved preset failed exact evidence verification");
    }
  } catch (error) {
    if (error instanceof NativeGradientFileError) throw error;
    fail("preservation-refused", `Preset evidence preservation failed: ${errorMessage(error)}`);
  }
  return {
    removed: false,
    alreadyAbsent: false,
    preserved: true,
    evidenceRootPath,
    evidencePresetPath,
  };
};

const environmentValue = <K extends keyof NativeGradientCapabilityEnvironment>(
  environment: NativeGradientCapabilityEnvironment | undefined,
  key: K,
  fallback: NativeGradientCapabilityEnvironment[K],
): NativeGradientCapabilityEnvironment[K] =>
  environment && Object.prototype.hasOwnProperty.call(environment, key)
    ? environment[key]
    : fallback;

const hasFunctions = (value: unknown, names: readonly string[]) =>
  Boolean(
    value &&
      (typeof value === "object" || typeof value === "function") &&
      names.every((name) => typeof (value as Record<string, unknown>)[name] === "function"),
  );

export const probeNativeGradientNodeCapabilities = (
  options: Readonly<{ testTempBasePath: string; userAgent?: string }>,
  environment?: NativeGradientCapabilityEnvironment,
): NativeGradientCapabilityReport => {
  const defaultProcessVersion =
    typeof process !== "undefined" && typeof process.version === "string" ? process.version : null;
  const processVersion = environmentValue(environment, "processVersion", defaultProcessVersion);
  const fsModule = environmentValue(environment, "fs", fs);
  const pathModule = environmentValue(environment, "path", path);
  const cryptoModule = environmentValue(environment, "crypto", crypto);
  const userAgent =
    typeof options.userAgent === "string"
      ? options.userAgent
      : typeof navigator !== "undefined" && typeof navigator.userAgent === "string"
        ? navigator.userAgent
        : "";
  const errors: string[] = [];
  const fsAvailable = hasFunctions(fsModule, [
    "realpathSync",
    "statSync",
    "lstatSync",
    "mkdirSync",
    "openSync",
    "writeSync",
    "closeSync",
    "renameSync",
    "readFileSync",
    "readdirSync",
    "unlinkSync",
    "rmdirSync",
  ]);
  const pathAvailable = hasFunctions(pathModule, ["resolve", "join", "dirname", "basename"]);
  const cryptoAvailable = hasFunctions(cryptoModule, ["randomBytes", "createHash"]);
  const renameAvailable = Boolean(
    fsModule && typeof (fsModule as { renameSync?: unknown }).renameSync === "function",
  );
  let renameAttempted = false;
  let renamePassed = false;

  if (!processVersion) errors.push("process.version is unavailable");
  if (!fsAvailable) errors.push("required fs capabilities are unavailable");
  if (!pathAvailable) errors.push("required path capabilities are unavailable");
  if (!cryptoAvailable) errors.push("required crypto capabilities are unavailable");
  if (!renameAvailable) errors.push("fs.renameSync is unavailable");

  if (errors.length === 0) {
    const activeFs = fsModule as typeof fs;
    const activePath = pathModule as typeof path;
    const activeCrypto = cryptoModule as typeof crypto;
    let rootPath = "";
    let rootOwned = false;
    let sourcePath = "";
    let destinationPath = "";
    let descriptor: number | null = null;
    try {
      const basePath = resolveExistingDirectory(options.testTempBasePath, activeFs, activePath);
      const token = randomHexToken(RUN_TOKEN_BYTES, activeCrypto);
      const rootName = `${ROOT_PREFIX}PROBE-${token}`;
      rootPath = activePath.join(basePath, rootName);
      if (
        activePath.dirname(rootPath) !== basePath ||
        activePath.basename(rootPath) !== rootName
      ) {
        throw new Error("capability root is not a direct child");
      }
      activeFs.mkdirSync(rootPath, { recursive: false, mode: 0o700 });
      rootOwned = true;
      sourcePath = activePath.join(rootPath, "rename-source.tmp");
      destinationPath = activePath.join(rootPath, "rename-destination.tmp");
      const marker = activeCrypto.randomBytes(32);
      const markerHash = hashBytes(marker, activeCrypto);
      descriptor = activeFs.openSync(sourcePath, "wx", 0o600);
      let offset = 0;
      while (offset < marker.byteLength) {
        const written = activeFs.writeSync(
          descriptor,
          marker,
          offset,
          marker.byteLength - offset,
          null,
        );
        if (written <= 0) throw new Error("rename probe write made no progress");
        offset += written;
      }
      activeFs.closeSync(descriptor);
      descriptor = null;
      renameAttempted = true;
      activeFs.renameSync(sourcePath, destinationPath);
      const renamed = new Uint8Array(activeFs.readFileSync(destinationPath));
      if (renamed.byteLength !== marker.byteLength || hashBytes(renamed, activeCrypto) !== markerHash) {
        throw new Error("renamed probe file failed hash verification");
      }
      try {
        activeFs.lstatSync(sourcePath);
        throw new Error("rename source still exists after rename");
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
      }
      renamePassed = true;
    } catch (error) {
      errors.push(`rename probe failed: ${errorMessage(error)}`);
    } finally {
      if (descriptor !== null) {
        try {
          activeFs.closeSync(descriptor);
        } catch (error) {
          errors.push(`rename probe descriptor cleanup failed: ${errorMessage(error)}`);
        }
      }
      for (const filePath of [sourcePath, destinationPath]) {
        if (!filePath) continue;
        try {
          const status = activeFs.lstatSync(filePath);
          if (!status.isFile() || status.isSymbolicLink()) {
            errors.push("rename probe cleanup refused a substituted file");
          } else {
            activeFs.unlinkSync(filePath);
          }
        } catch (error) {
          if (!isMissingPathError(error)) {
            errors.push(`rename probe file cleanup failed: ${errorMessage(error)}`);
          }
        }
      }
      if (rootOwned && rootPath) {
        try {
          activeFs.rmdirSync(rootPath);
        } catch (error) {
          errors.push(`rename probe root cleanup failed: ${errorMessage(error)}`);
        }
      }
    }
  }

  return {
    schemaVersion: 1,
    passed: errors.length === 0 && renamePassed,
    processVersion: typeof processVersion === "string" ? processVersion : null,
    userAgent,
    capabilities: {
      fs: fsAvailable,
      crypto: cryptoAvailable,
      rename: renameAvailable,
    },
    renameProbe: {
      attempted: renameAttempted,
      passed: renamePassed,
    },
    errors,
  };
};

export type NativeGradientHostPresetRecord = Readonly<{
  runToken: string;
  tempBasePath: string;
  rootPath: string;
  presetPath: string;
  filename: string;
  byteLength: number;
}>;

export type NativeGradientHostApplyRequest = Readonly<{
  schemaVersion: 1;
  expectedHostVersion: string;
  stopCount: number;
  presets: Readonly<Record<GradientFfxKind, NativeGradientHostPresetRecord>>;
}>;

export type NativeGradientRendererStatus =
  | "ok"
  | "preset-generation-failed"
  | "host-rejected"
  | "host-unknown-completion"
  | "host-call-unknown-completion"
  | "host-finalization-failed"
  | "cleanup-failed";

export type NativeGradientRendererReport = Readonly<{
  status: NativeGradientRendererStatus;
  primaryStatus: NativeGradientRendererStatus;
  hostCallAttempted: boolean;
  hostResult: unknown;
  generated: readonly NativeGradientPresetLease[];
  cleanup: readonly (NativeGradientCleanupResult & {
    kind: GradientFfxKind;
    error: string | null;
  })[];
  errors: readonly string[];
}>;

export const nativeGradientResultMessage = (
  report: NativeGradientRendererReport,
  stopCount: number,
) => {
  let message: string;
  if (report.primaryStatus === "preset-generation-failed") {
    message = "Could not prepare the active palette gradient";
  } else if (
    report.primaryStatus === "host-call-unknown-completion" ||
    report.primaryStatus === "host-unknown-completion"
  ) {
    message = "Gradient apply may have completed; verify the selected gradient";
  } else if (report.primaryStatus === "ok") {
    message = `Applied ${stopCount}-color native gradient`;
  } else {
    const hostRecord =
      report.hostResult && typeof report.hostResult === "object"
        ? (report.hostResult as { status?: unknown; primaryStatus?: unknown })
        : null;
    const hostStatus = hostRecord?.status;
    const hostPrimaryStatus =
      typeof hostRecord?.primaryStatus === "string" ? hostRecord.primaryStatus : hostStatus;
    const messages: Partial<Record<NativeGradientApplyStatus, string>> = {
      "unsupported-host-version": "This After Effects version is not supported",
      "host-version-drift": "After Effects changed version before the gradient could be applied",
      "invalid-request": "Could not prepare the native gradient request",
      "invalid-preset": "Could not validate the temporary gradient preset",
      "no-project": "Open an After Effects project first",
      "no-active-comp": "Open a composition first",
      "no-selected-gradient": "Select one native Fill or Stroke gradient",
      "ambiguous-selected-gradient": "Select only one native Fill or Stroke gradient",
      "unsupported-selected-gradient": "Select a static, unlocked native gradient",
      "target-drift": "The selected gradient changed before apply",
      "selection-snapshot-failed": "The property selection changed before apply",
      "apply-unknown-completion": "Gradient apply may have completed; verify the selected gradient",
    };
    message = hostPrimaryStatus === "ok"
      ? `Applied ${stopCount}-color native gradient`
      : typeof hostPrimaryStatus === "string" &&
          messages[hostPrimaryStatus as NativeGradientApplyStatus]
        ? messages[hostPrimaryStatus as NativeGradientApplyStatus]!
        : "Could not apply the active palette gradient";

    const finalizationMessages: Partial<Record<NativeGradientApplyStatus, string>> = {
      "selection-restore-failed": "After Effects selection restoration also failed",
      "undo-close-failed": "After Effects Undo finalization also failed",
      "finalization-failed": "After Effects selection and Undo finalization also failed",
    };
    if (
      typeof hostStatus === "string" &&
      hostStatus !== hostPrimaryStatus &&
      finalizationMessages[hostStatus as NativeGradientApplyStatus]
    ) {
      message = `${message}; ${finalizationMessages[hostStatus as NativeGradientApplyStatus]}`;
    }
  }

  if (report.status === "host-finalization-failed") {
    const hostRecord =
      report.hostResult && typeof report.hostResult === "object"
        ? (report.hostResult as { status?: unknown })
        : null;
    const finalizationMessages: Partial<Record<NativeGradientApplyStatus, string>> = {
      "selection-restore-failed": "After Effects selection restoration also failed",
      "undo-close-failed": "After Effects Undo finalization also failed",
      "finalization-failed": "After Effects selection and Undo finalization also failed",
    };
    const hostStatus = hostRecord?.status;
    if (
      typeof hostStatus === "string" &&
      finalizationMessages[hostStatus as NativeGradientApplyStatus]
    ) {
      return `${message}; ${finalizationMessages[hostStatus as NativeGradientApplyStatus]}`;
    }
  }
  if (
    report.status !== "cleanup-failed" &&
    report.cleanup.length > 0 &&
    report.cleanup.every((entry) => entry.preserved && entry.error === null)
  ) {
    return `${message}; temporary presets preserved for diagnosis`;
  }
  if (report.status !== "cleanup-failed") return message;
  if (report.primaryStatus === "ok") {
    return "Gradient apply finished, but temporary preset cleanup failed";
  }
  return `${message}; temporary preset cleanup also failed`;
};

const hostPresetRecord = (lease: NativeGradientPresetLease): NativeGradientHostPresetRecord => ({
  runToken: lease.runToken,
  tempBasePath: lease.tempBasePath,
  rootPath: lease.rootPath,
  presetPath: lease.presetPath,
  filename: lease.filename,
  byteLength: lease.byteLength,
});

export const getNativeGradientTempBasePath = (
  platform = typeof process !== "undefined" ? process.platform : "",
  tempBasePath = os.tmpdir(),
) => (platform === "darwin" ? path.join(tempBasePath, "TemporaryItems") : tempBasePath);

type NativeGradientApplicationInput =
  | Readonly<{ palette: readonly PaletteRgba[]; gradient?: never }>
  | Readonly<{ gradient: unknown; palette?: never }>;

export const applyActivePaletteNativeGradient = async (
  options: NativeGradientApplicationInput & Readonly<{
    tempBasePath: string;
    templateRootPath: string;
    hostVersion: string;
  }>,
  invokeHost: (request: NativeGradientHostApplyRequest) => Promise<unknown>,
): Promise<NativeGradientRendererReport> => {
  const generated: NativeGradientPresetLease[] = [];
  const cleanup: Array<
    NativeGradientCleanupResult & { kind: GradientFfxKind; error: string | null }
  > = [];
  const errors: string[] = [];
  let primaryStatus: NativeGradientRendererStatus = "preset-generation-failed";
  let status: NativeGradientRendererStatus = "preset-generation-failed";
  let hostCallAttempted = false;
  let hostResult: unknown = null;

  const templateFamily = resolveNativeGradientTemplateFamily(options.hostVersion);
  if (!templateFamily) {
    hostResult = {
      status: "unsupported-host-version",
      primaryStatus: "unsupported-host-version",
      hostVersion: options.hostVersion,
    };
    return {
      status: "host-rejected",
      primaryStatus: "host-rejected",
      hostCallAttempted: false,
      hostResult,
      generated,
      cleanup,
      errors,
    };
  }
  const templatePaths: Readonly<Record<GradientFfxKind, string>> = {
    fill: path.join(options.templateRootPath, templateFamily, "fill-template.ffx"),
    stroke: path.join(options.templateRootPath, templateFamily, "stroke-template.ffx"),
  };

  try {
    const gradient = Object.prototype.hasOwnProperty.call(options, "gradient")
      ? validateNativeGradientForApplication(options.gradient)
      : paletteRgbaToNativeGradient(options.palette);
    for (const kind of ["fill", "stroke"] as const) {
      generated.push(
        createNativeGradientPreset({
          gradient,
          kind,
          tempBasePath: options.tempBasePath,
          templatePath: templatePaths[kind],
        }),
      );
    }
    const request: NativeGradientHostApplyRequest = {
      schemaVersion: 1,
      expectedHostVersion: options.hostVersion,
      stopCount: gradient.colorStops.length,
      presets: {
        fill: hostPresetRecord(generated[0]),
        stroke: hostPresetRecord(generated[1]),
      },
    };
    hostCallAttempted = true;
    try {
      hostResult = await invokeHost(request);
      const hostRecord =
        hostResult && typeof hostResult === "object"
          ? (hostResult as { status?: unknown; primaryStatus?: unknown })
          : null;
      const hostStatus = hostRecord?.status;
      const hostPrimaryStatus =
        typeof hostRecord?.primaryStatus === "string" ? hostRecord.primaryStatus : hostStatus;
      if (hostStatus === "ok") {
        primaryStatus = "ok";
        status = "ok";
      } else if (hostPrimaryStatus === "ok") {
        primaryStatus = "ok";
        status = "host-finalization-failed";
      } else if (hostPrimaryStatus === "apply-unknown-completion") {
        primaryStatus = "host-unknown-completion";
        status = "host-unknown-completion";
      } else {
        primaryStatus = "host-rejected";
        status = "host-rejected";
      }
    } catch (error) {
      primaryStatus = "host-call-unknown-completion";
      status = "host-call-unknown-completion";
      errors.push(errorMessage(error));
    }
  } catch (error) {
    errors.push(errorMessage(error));
  } finally {
    for (let index = 0; index < generated.length; index += 1) {
      const lease = generated[index];
      try {
        const shouldPreserve =
          primaryStatus === "host-call-unknown-completion" ||
          primaryStatus === "host-unknown-completion";
        const result = shouldPreserve
          ? preserveNativeGradientPreset(lease)
          : cleanupNativeGradientPreset(lease);
        cleanup.push({ kind: lease.kind, ...result, error: null });
      } catch (error) {
        const message = errorMessage(error);
        errors.push(message);
        cleanup.push({
          kind: lease.kind,
          removed: false,
          alreadyAbsent: false,
          preserved: false,
          evidenceRootPath: null,
          evidencePresetPath: null,
          error: message,
        });
      }
    }
  }

  const cleanupFailed = cleanup.some((entry) => entry.error !== null);
  return {
    status: cleanupFailed ? "cleanup-failed" : status,
    primaryStatus,
    hostCallAttempted,
    hostResult,
    generated,
    cleanup,
    errors,
  };
};
