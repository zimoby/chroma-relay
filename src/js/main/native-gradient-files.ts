import {
  NATIVE_GRADIENT_TEMPLATE_METADATA,
  generateGradientFfx,
  validateGeneratedGradient,
  type GradientFfxKind,
  type GradientFfxStructuralReport,
  type NativeGradient,
} from "@zimoby/ae-native-gradient";
import { crypto, fs, os, path } from "../lib/cep/node.ts";
import {
  MAX_NATIVE_GRADIENT_DESCRIPTOR_PATH_DEPTH,
  MAX_NATIVE_GRADIENT_DIAGNOSTIC_COUNT,
  MAX_NATIVE_GRADIENT_DIAGNOSTIC_LENGTH,
  MAX_NATIVE_GRADIENT_MATCH_NAME_LENGTH,
  MAX_NATIVE_GRADIENT_TARGET_COUNT,
  boundNativeGradientDiagnostic,
  normalizeNativeGradientHostVersion,
  resolveNativeGradientRuntime,
  resolveNativeGradientTemplateFamily,
  type NativeGradientApplyResult,
  type NativeGradientApplyStatus,
  type NativeGradientTemplateFamily,
} from "../shared/native-gradient-contract.ts";
export { resolveNativeGradientRuntime } from "../shared/native-gradient-contract.ts";

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
type KnownNativeGradientTemplateFamily = NativeGradientTemplateFamily;

const isKnownTemplateFamily = (value: string): value is KnownNativeGradientTemplateFamily =>
  Object.prototype.hasOwnProperty.call(NATIVE_GRADIENT_TEMPLATE_METADATA, value);

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
  const templateFamily = path.basename(path.dirname(realTemplatePath));
  if (
    !isKnownTemplateFamily(templateFamily) ||
    sha256 !== NATIVE_GRADIENT_TEMPLATE_METADATA[templateFamily][kind].sha256
  ) {
    fail("template-mismatch", `Native gradient ${kind} template hash does not match the toolkit asset`);
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
  if (tempPath) {
    try {
      removeRegularFileIfPresent(tempPath);
    } catch {
      // Preserve the primary publication error.
    }
  }
  if (presetPath) {
    try {
      removeRegularFileIfPresent(presetPath);
    } catch {
      // Preserve the primary publication error.
    }
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

  let filename = "";
  let presetPath = "";
  let tempPath = "";
  let descriptor: number | null = null;
  try {
    filename = expectedFilename(runToken, options.kind, gradient.colorStops.length);
    presetPath = path.join(rootPath, filename);
    assertDirectChild(rootPath, presetPath, filename);
    const tempName = `.${filename}.${randomHexToken(TEMP_TOKEN_BYTES)}.tmp`;
    tempPath = path.join(rootPath, tempName);
    assertDirectChild(rootPath, tempPath, tempName);
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
  const addCapabilityDiagnostic = (value: unknown) => {
    if (errors.length >= MAX_NATIVE_GRADIENT_DIAGNOSTIC_COUNT) return;
    errors.push(boundNativeGradientDiagnostic(value));
  };
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

  if (!processVersion) addCapabilityDiagnostic("process.version is unavailable");
  if (!fsAvailable) addCapabilityDiagnostic("required fs capabilities are unavailable");
  if (!pathAvailable) addCapabilityDiagnostic("required path capabilities are unavailable");
  if (!cryptoAvailable) addCapabilityDiagnostic("required crypto capabilities are unavailable");
  if (!renameAvailable) addCapabilityDiagnostic("fs.renameSync is unavailable");

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
      addCapabilityDiagnostic(`rename probe failed: ${errorMessage(error)}`);
    } finally {
      if (descriptor !== null) {
        try {
          activeFs.closeSync(descriptor);
        } catch (error) {
          addCapabilityDiagnostic(`rename probe descriptor cleanup failed: ${errorMessage(error)}`);
        }
      }
      for (const filePath of [sourcePath, destinationPath]) {
        if (!filePath) continue;
        try {
          const status = activeFs.lstatSync(filePath);
          if (!status.isFile() || status.isSymbolicLink()) {
            addCapabilityDiagnostic("rename probe cleanup refused a substituted file");
          } else {
            activeFs.unlinkSync(filePath);
          }
        } catch (error) {
          if (!isMissingPathError(error)) {
            addCapabilityDiagnostic(`rename probe file cleanup failed: ${errorMessage(error)}`);
          }
        }
      }
      if (rootOwned && rootPath) {
        try {
          activeFs.rmdirSync(rootPath);
        } catch (error) {
          addCapabilityDiagnostic(`rename probe root cleanup failed: ${errorMessage(error)}`);
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
  platform?: string;
  expectedHostVersion: string;
  stopCount: number;
  includeDisabledTargets: boolean;
  smartApply: boolean;
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

const isFiniteNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const NATIVE_GRADIENT_FILL_MATCH_NAME = "ADBE Vector Graphic - G-Fill";
const NATIVE_GRADIENT_STROKE_MATCH_NAME = "ADBE Vector Graphic - G-Stroke";
const NATIVE_GRADIENT_PAYLOAD_MATCH_NAME = "ADBE Vector Grad Colors";

type NativeGradientWireState =
  | "pre-undo-rejection"
  | "post-undo-deterministic"
  | "unknown-apply"
  | "success"
  | "finalization-only";

const NATIVE_GRADIENT_WIRE_STATE: Readonly<
  Record<NativeGradientApplyStatus, NativeGradientWireState>
> = {
  ok: "success",
  "unsupported-platform": "pre-undo-rejection",
  "unsupported-host-version": "pre-undo-rejection",
  "host-version-drift": "pre-undo-rejection",
  "invalid-request": "pre-undo-rejection",
  "invalid-preset": "pre-undo-rejection",
  "no-project": "pre-undo-rejection",
  "no-active-comp": "pre-undo-rejection",
  "no-selected-gradient": "pre-undo-rejection",
  "ambiguous-selected-gradient": "pre-undo-rejection",
  "unsupported-selected-gradient": "pre-undo-rejection",
  "target-drift": "post-undo-deterministic",
  "selection-snapshot-failed": "pre-undo-rejection",
  "undo-open-failed": "post-undo-deterministic",
  "selection-mutation-failed": "post-undo-deterministic",
  "apply-unknown-completion": "unknown-apply",
  "selection-restore-failed": "finalization-only",
  "undo-close-failed": "finalization-only",
  "finalization-failed": "finalization-only",
};

const isValidTarget = (
  value: unknown,
): value is NonNullable<NativeGradientApplyResult["target"]> => {
  if (!value || typeof value !== "object") return false;
  const target = value as Record<string, unknown>;
  if (
    !Array.isArray(target.propertyIndexPath) ||
    !Array.isArray(target.matchNamePath) ||
    target.propertyIndexPath.length === 0 ||
    target.propertyIndexPath.length < 2 ||
    target.propertyIndexPath.length > MAX_NATIVE_GRADIENT_DESCRIPTOR_PATH_DEPTH ||
    target.propertyIndexPath.length !== target.matchNamePath.length
  ) {
    return false;
  }
  const expectedParentMatchName =
    target.kind === "fill"
      ? NATIVE_GRADIENT_FILL_MATCH_NAME
      : target.kind === "stroke"
        ? NATIVE_GRADIENT_STROKE_MATCH_NAME
        : null;
  return (
    typeof target.compId === "number" && Number.isInteger(target.compId) && target.compId > 0 &&
    typeof target.layerId === "number" && Number.isInteger(target.layerId) && target.layerId > 0 &&
    typeof target.layerIndex === "number" && Number.isInteger(target.layerIndex) && target.layerIndex > 0 &&
    (target.kind === "fill" || target.kind === "stroke") &&
    target.propertyIndexPath.every((entry) => isFiniteNonNegativeInteger(entry) && entry > 0) &&
    target.matchNamePath.every(
      (entry) =>
        typeof entry === "string" &&
        entry.length > 0 &&
        entry.length <= MAX_NATIVE_GRADIENT_MATCH_NAME_LENGTH,
    ) &&
    target.matchNamePath[target.matchNamePath.length - 2] === expectedParentMatchName &&
    target.matchNamePath[target.matchNamePath.length - 1] === NATIVE_GRADIENT_PAYLOAD_MATCH_NAME
  );
};

const hasConsistentTargetIdentity = (
  targets: NativeGradientApplyResult["targets"],
) => {
  if (targets.length === 0) return true;
  const expectedCompId = targets[0].compId;
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    if (target.compId !== expectedCompId) return false;
    for (let previousIndex = 0; previousIndex < index; previousIndex += 1) {
      const previous = targets[previousIndex];
      if (
        (previous.layerId === target.layerId && previous.layerIndex !== target.layerIndex) ||
        (previous.layerIndex === target.layerIndex && previous.layerId !== target.layerId)
      ) {
        return false;
      }
    }
  }
  return true;
};

const sameTarget = (left: unknown, right: unknown) => {
  if (!isValidTarget(left) || !isValidTarget(right)) return false;
  if (
    left.compId !== right.compId ||
    left.layerId !== right.layerId ||
    left.layerIndex !== right.layerIndex ||
    left.kind !== right.kind ||
    left.propertyIndexPath.length !== right.propertyIndexPath.length
  ) {
    return false;
  }
  for (let index = 0; index < left.propertyIndexPath.length; index += 1) {
    if (
      left.propertyIndexPath[index] !== right.propertyIndexPath[index] ||
      left.matchNamePath[index] !== right.matchNamePath[index]
    ) {
      return false;
    }
  }
  return true;
};

const readWireCount = (
  record: Record<string, unknown>,
  primaryName: string,
  aliasName: string,
) => {
  if (
    !Object.prototype.hasOwnProperty.call(record, primaryName) ||
    !Object.prototype.hasOwnProperty.call(record, aliasName)
  ) {
    return null;
  }
  const primary = record[primaryName];
  const alias = record[aliasName];
  if (!isFiniteNonNegativeInteger(primary)) return null;
  if (!isFiniteNonNegativeInteger(alias) || alias !== primary) return null;
  return primary;
};

const readWireIndex = (
  record: Record<string, unknown>,
  primaryName: string,
  aliasName: string,
  selectedCount: number,
) => {
  if (
    !Object.prototype.hasOwnProperty.call(record, primaryName) ||
    !Object.prototype.hasOwnProperty.call(record, aliasName)
  ) {
    return undefined;
  }
  const value = record[primaryName];
  if (
    value !== null &&
    (!isFiniteNonNegativeInteger(value) || value >= selectedCount)
  ) {
    return undefined;
  }
  const alias = record[aliasName];
  if (alias !== value) return undefined;
  return value as number | null;
};

const hasPositiveSelectionEvidence = (
  record: Record<string, unknown>,
  targets: NativeGradientApplyResult["targets"],
  selectedTargetCount: number,
) =>
  selectedTargetCount > 0 &&
  targets.length === selectedTargetCount &&
  record.target !== null &&
  sameTarget(record.target, targets[0]);

const hasNoSelectionEvidence = (
  record: Record<string, unknown>,
  targets: NativeGradientApplyResult["targets"],
  selectedTargetCount: number,
  skippedDisabledCount: number,
  preservedStateCount: number,
  failedTargetIndex: number | null,
  unknownCompletionTargetIndex: number | null,
  primaryStatus: NativeGradientApplyStatus,
) =>
  selectedTargetCount === 0 &&
  targets.length === 0 &&
  record.target === null &&
  failedTargetIndex === null &&
  unknownCompletionTargetIndex === null &&
  (primaryStatus === "no-selected-gradient"
    ? preservedStateCount === 0
    : primaryStatus === "unsupported-selected-gradient"
      ? preservedStateCount > 0 || skippedDisabledCount === 0
      : skippedDisabledCount === 0 && preservedStateCount === 0);

export const decodeNativeGradientApplyResult = (
  value: unknown,
  expectedHostVersion: unknown,
): NativeGradientApplyResult | null => {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const status = record.status;
  const primaryStatus = record.primaryStatus;
  if (
    record.schemaVersion !== 1 ||
    typeof status !== "string" ||
    !Object.prototype.hasOwnProperty.call(NATIVE_GRADIENT_WIRE_STATE, status) ||
    typeof primaryStatus !== "string" ||
    !Object.prototype.hasOwnProperty.call(NATIVE_GRADIENT_WIRE_STATE, primaryStatus) ||
    typeof record.hostVersion !== "string" ||
    !Array.isArray(record.targets) ||
    record.targets.length > MAX_NATIVE_GRADIENT_TARGET_COUNT ||
    !record.targets.every(isValidTarget)
  ) return null;
  const normalizedExpectedHostVersion = normalizeNativeGradientHostVersion(expectedHostVersion);
  const normalizedResultHostVersion = normalizeNativeGradientHostVersion(record.hostVersion);
  if (
    normalizedExpectedHostVersion === null ||
    normalizedResultHostVersion === null ||
    normalizedExpectedHostVersion !== normalizedResultHostVersion
  ) return null;
  const targets = record.targets as NativeGradientApplyResult["targets"];
  const selectedTargetCount = readWireCount(record, "selectedTargetCount", "selectedPropertyCount");
  const attemptedTargetCount = readWireCount(record, "attemptedTargetCount", "attemptedPropertyCount");
  const appliedTargetCount = readWireCount(record, "appliedTargetCount", "appliedPropertyCount");
  const skippedDisabledCount = readWireCount(record, "skippedDisabledCount", "skippedDisabledBranchCount");
  const preservedStateCount = readWireCount(record, "preservedStateCount", "preservedPropertyCount");
  if (
    selectedTargetCount === null ||
    attemptedTargetCount === null ||
    appliedTargetCount === null ||
    skippedDisabledCount === null ||
    preservedStateCount === null ||
    selectedTargetCount > MAX_NATIVE_GRADIENT_TARGET_COUNT ||
    attemptedTargetCount > MAX_NATIVE_GRADIENT_TARGET_COUNT ||
    appliedTargetCount > MAX_NATIVE_GRADIENT_TARGET_COUNT ||
    skippedDisabledCount > MAX_NATIVE_GRADIENT_TARGET_COUNT ||
    preservedStateCount > MAX_NATIVE_GRADIENT_TARGET_COUNT ||
    targets.length !== selectedTargetCount ||
    attemptedTargetCount > selectedTargetCount ||
    appliedTargetCount > attemptedTargetCount
  ) return null;
  if (!hasConsistentTargetIdentity(targets)) return null;
  const failedTargetIndex = readWireIndex(
    record,
    "failedTargetIndex",
    "failedPropertyIndex",
    selectedTargetCount,
  );
  const unknownCompletionTargetIndex = readWireIndex(
    record,
    "unknownCompletionTargetIndex",
    "unknownCompletionPropertyIndex",
    selectedTargetCount,
  );
  if (failedTargetIndex === undefined || unknownCompletionTargetIndex === undefined) return null;
  if (failedTargetIndex !== null && unknownCompletionTargetIndex !== null) return null;
  if (
    (record.target === null && targets.length !== 0) ||
    (record.target !== null &&
      (targets.length === 0 || !sameTarget(record.target, targets[0])))
  ) return null;
  for (let leftIndex = 0; leftIndex < targets.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < targets.length; rightIndex += 1) {
      if (sameTarget(targets[leftIndex], targets[rightIndex])) return null;
    }
  }
  const booleans = [
    "mutationAttempted",
    "applyCompleted",
    "undoGroupOpened",
    "undoGroupCloseAttempted",
    "undoGroupClosed",
    "selectionRestoreAttempted",
    "selectionRestored",
  ];
  if (!booleans.every((name) => typeof record[name] === "boolean")) return null;
  if (record.undoGroupClosed && (!record.undoGroupOpened || !record.undoGroupCloseAttempted)) return null;
  if (record.undoGroupCloseAttempted && !record.undoGroupOpened) return null;
  if (record.selectionRestored && !record.selectionRestoreAttempted) return null;
  if (record.selectionRestoreAttempted && !record.undoGroupOpened) return null;
  if (record.undoGroupOpened && (!record.selectionRestoreAttempted || !record.undoGroupCloseAttempted)) return null;

  const applyError = record.applyError;
  if (
    applyError !== null &&
    (!applyError ||
      typeof applyError !== "object" ||
      !Object.prototype.hasOwnProperty.call(applyError, "line") ||
      !Object.prototype.hasOwnProperty.call(applyError, "number") ||
      typeof (applyError as any).name !== "string" ||
      typeof (applyError as any).message !== "string" ||
      (applyError as any).name.length > MAX_NATIVE_GRADIENT_DIAGNOSTIC_LENGTH ||
      (applyError as any).message.length > MAX_NATIVE_GRADIENT_DIAGNOSTIC_LENGTH ||
      ((applyError as any).line !== null &&
        (typeof (applyError as any).line !== "number" || !Number.isFinite((applyError as any).line))) ||
      ((applyError as any).number !== null &&
        (typeof (applyError as any).number !== "number" || !Number.isFinite((applyError as any).number))))
  ) return null;

  const primaryState = NATIVE_GRADIENT_WIRE_STATE[primaryStatus as NativeGradientApplyStatus];
  if (primaryState === "finalization-only") return null;
  const hostVersionIsSupported = resolveNativeGradientTemplateFamily(normalizedResultHostVersion) !== null;
  if (
    primaryStatus === "host-version-drift" ||
    (primaryStatus === "unsupported-host-version" ? hostVersionIsSupported : !hostVersionIsSupported)
  ) return null;
  const hasUndo = record.undoGroupOpened;
  const hasPositiveSelection = hasPositiveSelectionEvidence(record, targets, selectedTargetCount);
  const hasNoSelection = hasNoSelectionEvidence(
    record,
    targets,
    selectedTargetCount,
    skippedDisabledCount,
    preservedStateCount,
    failedTargetIndex,
    unknownCompletionTargetIndex,
    primaryStatus as NativeGradientApplyStatus,
  );
  if (primaryState === "pre-undo-rejection") {
    if (
      !hasNoSelection ||
      hasUndo ||
      record.mutationAttempted ||
      record.applyCompleted ||
      attemptedTargetCount !== 0 ||
      appliedTargetCount !== 0 ||
      record.applyError !== null
    ) return null;
  } else if (primaryState === "post-undo-deterministic") {
    if (!hasPositiveSelection) return null;
    if (primaryStatus === "undo-open-failed") {
      if (
        hasUndo ||
        record.mutationAttempted ||
        record.applyCompleted ||
        attemptedTargetCount !== 0 ||
        appliedTargetCount !== 0 ||
        failedTargetIndex !== null ||
        unknownCompletionTargetIndex !== null ||
        record.applyError !== null
      ) return null;
    } else if (!hasUndo) {
      if (
        primaryStatus !== "target-drift" ||
        record.mutationAttempted ||
        record.applyCompleted ||
        attemptedTargetCount !== 0 ||
        appliedTargetCount !== 0 ||
        failedTargetIndex === null ||
        unknownCompletionTargetIndex !== null ||
        record.applyError !== null
      ) return null;
    } else if (
      record.applyCompleted ||
      attemptedTargetCount !== appliedTargetCount ||
      failedTargetIndex === null ||
      failedTargetIndex !== attemptedTargetCount ||
      attemptedTargetCount >= selectedTargetCount ||
      record.mutationAttempted !== (attemptedTargetCount > 0) ||
      unknownCompletionTargetIndex !== null ||
      record.applyError !== null
    ) return null;
  } else if (primaryState === "unknown-apply") {
    if (
      !hasUndo ||
      !hasPositiveSelection ||
      !record.mutationAttempted ||
      record.applyCompleted ||
      attemptedTargetCount < 1 ||
      appliedTargetCount !== attemptedTargetCount - 1 ||
      unknownCompletionTargetIndex !== attemptedTargetCount - 1 ||
      failedTargetIndex !== null ||
      applyError === null ||
      typeof applyError !== "object"
    ) return null;
  } else if (
    primaryState === "success" &&
    (!hasUndo ||
      !hasPositiveSelection ||
      !record.mutationAttempted ||
      !record.applyCompleted ||
      attemptedTargetCount !== selectedTargetCount ||
      appliedTargetCount !== selectedTargetCount ||
      failedTargetIndex !== null ||
      unknownCompletionTargetIndex !== null ||
      applyError !== null)
  ) return null;

  const expectedStatus =
    !hasUndo
      ? primaryStatus
      : !record.selectionRestored && !record.undoGroupClosed
        ? "finalization-failed"
        : !record.selectionRestored
          ? "selection-restore-failed"
          : !record.undoGroupClosed
            ? "undo-close-failed"
            : primaryStatus;
  if (status !== expectedStatus) return null;
  return record as NativeGradientApplyResult;
};

export const nativeGradientResultMessage = (
  report: NativeGradientRendererReport,
  stopCount: number,
) => {
  const hostRecord =
    report.hostResult && typeof report.hostResult === "object"
      ? (report.hostResult as {
          status?: unknown;
          primaryStatus?: unknown;
          appliedTargetCount?: unknown;
          selectedTargetCount?: unknown;
          unknownCompletionTargetIndex?: unknown;
          skippedDisabledCount?: unknown;
          preservedStateCount?: unknown;
          skippedDisabledBranchCount?: unknown;
          preservedPropertyCount?: unknown;
        })
      : null;
  const appliedTargetCount =
    typeof hostRecord?.appliedTargetCount === "number" ? hostRecord.appliedTargetCount : 0;
  const skippedDisabledBranchCount =
    typeof hostRecord?.skippedDisabledBranchCount === "number"
      ? hostRecord.skippedDisabledBranchCount
      : typeof hostRecord?.skippedDisabledCount === "number"
        ? hostRecord.skippedDisabledCount
        : 0;
  const preservedPropertyCount =
    typeof hostRecord?.preservedPropertyCount === "number"
      ? hostRecord.preservedPropertyCount
      : typeof hostRecord?.preservedStateCount === "number"
        ? hostRecord.preservedStateCount
        : 0;
  const unknownCompletionMessage =
    typeof hostRecord?.unknownCompletionTargetIndex === "number" &&
    typeof hostRecord?.selectedTargetCount === "number"
      ? `Gradient apply may have completed on target ${
          hostRecord.unknownCompletionTargetIndex + 1
        } of ${hostRecord.selectedTargetCount}; ${appliedTargetCount} earlier confirmed`
      : "Gradient apply may have completed; verify the selected gradient";
  const successMessage =
    appliedTargetCount > 1
      ? `Applied ${stopCount}-color native gradient to ${appliedTargetCount} properties`
      : `Applied ${stopCount}-color native gradient`;
  let message: string;
  if (report.primaryStatus === "preset-generation-failed") {
    message = "Could not prepare the active palette gradient";
  } else if (
    report.primaryStatus === "host-call-unknown-completion" ||
    report.primaryStatus === "host-unknown-completion"
  ) {
    message = unknownCompletionMessage;
  } else if (report.primaryStatus === "ok") {
    message = successMessage;
  } else {
    const hostStatus = hostRecord?.status;
    const hostPrimaryStatus =
      typeof hostRecord?.primaryStatus === "string" ? hostRecord.primaryStatus : hostStatus;
    const messages: Partial<Record<NativeGradientApplyStatus, string>> = {
      "unsupported-host-version": "This After Effects version is not supported",
      "unsupported-platform": "Native gradients are unavailable on this platform",
      "host-version-drift": "After Effects changed version before the gradient could be applied",
      "invalid-request": "Could not prepare the native gradient request",
      "invalid-preset": "Could not validate the temporary gradient preset",
      "no-project": "Open an After Effects project first",
      "no-active-comp": "Open a composition first",
      "no-selected-gradient": "Select a native Fill or Stroke gradient, group, or layer",
      "ambiguous-selected-gradient": "Could not resolve the selected native gradients",
      "unsupported-selected-gradient": "Select a static, unlocked native gradient",
      "target-drift": "The selected gradient changed before apply",
      "selection-snapshot-failed": "The property selection changed before apply",
      "apply-unknown-completion": unknownCompletionMessage,
    };
    message = hostPrimaryStatus === "ok"
      ? successMessage
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

  if (report.primaryStatus === "ok" || hostRecord?.primaryStatus === "ok") {
    if (skippedDisabledBranchCount > 0) {
      message = `${message}; skipped ${skippedDisabledBranchCount} disabled branches`;
    }
    if (preservedPropertyCount > 0) {
      message = `${message}; preserved ${preservedPropertyCount} properties`;
    }
  }

  const finalizationMessages: Partial<Record<NativeGradientApplyStatus, string>> = {
    "selection-restore-failed": "After Effects selection restoration also failed",
    "undo-close-failed": "After Effects Undo finalization also failed",
    "finalization-failed": "After Effects selection and Undo finalization also failed",
  };
  const finalizationMessage =
    typeof hostRecord?.status === "string"
      ? finalizationMessages[hostRecord.status as NativeGradientApplyStatus]
      : undefined;
  if (finalizationMessage && message.indexOf(finalizationMessage) < 0) {
    message = `${message}; ${finalizationMessage}`;
  }
  if (
    report.status !== "cleanup-failed" &&
    report.cleanup.length > 0 &&
    report.cleanup.every((entry) => entry.preserved && entry.error === null)
  ) {
    return `${message}; temporary presets preserved for diagnosis`;
  }
  if (report.status !== "cleanup-failed") return message;
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
) => (platform === "darwin" ? path.posix.join(tempBasePath, "TemporaryItems") : tempBasePath);

type NativeGradientApplicationInput =
  | Readonly<{ palette: readonly PaletteRgba[]; gradient?: never }>
  | Readonly<{ gradient: unknown; palette?: never }>;

export const applyActivePaletteNativeGradient = async (
  options: NativeGradientApplicationInput & Readonly<{
    tempBasePath: string;
    templateRootPath: string;
    hostVersion: string;
    platform?: string;
    includeDisabledTargets: boolean;
    smartApply: boolean;
  }>,
  invokeHost: (request: NativeGradientHostApplyRequest) => Promise<unknown>,
): Promise<NativeGradientRendererReport> => {
  const generated: NativeGradientPresetLease[] = [];
  const cleanup: Array<
    NativeGradientCleanupResult & { kind: GradientFfxKind; error: string | null }
  > = [];
  const errors: string[] = [];
  const addDiagnostic = (error: unknown) => {
    if (errors.length >= MAX_NATIVE_GRADIENT_DIAGNOSTIC_COUNT) return;
    errors.push(boundNativeGradientDiagnostic(errorMessage(error)));
  };
  let primaryStatus: NativeGradientRendererStatus = "preset-generation-failed";
  let status: NativeGradientRendererStatus = "preset-generation-failed";
  let hostCallAttempted = false;
  let hostResult: unknown = null;

  const runtime = resolveNativeGradientRuntime(options.platform, options.hostVersion);
  if (!runtime.supported) {
    hostResult = {
      schemaVersion: 1,
      status: runtime.reason,
      primaryStatus: runtime.reason,
      platform: runtime.platform,
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
  const templateFamily = runtime.templateFamily;
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
      platform: runtime.platform,
      expectedHostVersion: options.hostVersion,
      stopCount: gradient.colorStops.length,
      includeDisabledTargets: options.includeDisabledTargets,
      smartApply: options.smartApply,
      presets: {
        fill: hostPresetRecord(generated[0]),
        stroke: hostPresetRecord(generated[1]),
      },
    };
    hostCallAttempted = true;
    try {
      hostResult = await invokeHost(request);
      const decoded = decodeNativeGradientApplyResult(hostResult, options.hostVersion);
      if (!decoded) {
        primaryStatus = "host-unknown-completion";
        status = "host-unknown-completion";
      } else if (decoded.status === "ok") {
        primaryStatus = "ok";
        status = "ok";
      } else if (decoded.primaryStatus === "ok") {
        primaryStatus = "ok";
        status = "host-finalization-failed";
      } else if (decoded.primaryStatus === "apply-unknown-completion") {
        primaryStatus = "host-unknown-completion";
        status = "host-unknown-completion";
      } else {
        primaryStatus = "host-rejected";
        status = "host-rejected";
      }
    } catch (error) {
      primaryStatus = "host-call-unknown-completion";
      status = "host-call-unknown-completion";
      addDiagnostic(error);
    }
  } catch (error) {
    addDiagnostic(error);
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
        const message = boundNativeGradientDiagnostic(errorMessage(error));
        addDiagnostic(message);
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
