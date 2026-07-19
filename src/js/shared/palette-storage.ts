import CSInterface from "../lib/cep/csinterface.js";
import { fs, path } from "../lib/cep/node.ts";
import {
  DEFAULT_PALETTE,
  type PaletteDocument,
  clonePaletteDocument,
  isPaletteDocument,
  migratePaletteDocument,
} from "./palette-domain.ts";

export type PaletteRecovery = "none" | "backup" | "temp";

export type PaletteLoadResult = {
  document: PaletteDocument;
  error: string | null;
  recovery: PaletteRecovery;
};

export type PaletteStorageFs = {
  existsSync: (filePath: string) => boolean;
  mkdirSync: (directory: string, options?: { recursive?: boolean }) => void;
  readFileSync: (filePath: string, encoding: "utf8") => string;
  writeFileSync: (filePath: string, data: string, encoding: "utf8") => void;
  renameSync: (from: string, to: string) => void;
  unlinkSync: (filePath: string) => void;
};

const csi = new CSInterface();
let writeQueue: Promise<void> = Promise.resolve();
let writeCount = 0;

const getPaletteDirectory = (temporaryRoot: string | null) => {
  if (temporaryRoot) return temporaryRoot;
  if (!window.cep) return null;
  return path.join(csi.getSystemPath("userData"), "Chroma Relay");
};

export const getPalettePaths = (temporaryRoot: string | null) => {
  const directory = getPaletteDirectory(temporaryRoot);
  if (!directory) return null;
  return {
    directory,
    final: path.join(directory, "palette.json"),
    temp: path.join(directory, "palette.json.tmp"),
    backup: path.join(directory, "palette.json.bak"),
    invalid: path.join(directory, "palette.json.invalid"),
  };
};

const readDocument = (filePath: string, io: PaletteStorageFs) => {
  try {
    const parsed = JSON.parse(io.readFileSync(filePath, "utf8")) as unknown;
    return migratePaletteDocument(parsed);
  } catch {
    return null;
  }
};

const nextResiduePath = (filePath: string, io: PaletteStorageFs) => {
  if (!io.existsSync(filePath)) return filePath;
  for (let index = 1; index < 1000; index += 1) {
    const candidate = `${filePath}.${index}`;
    if (!io.existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not allocate a residue path for ${filePath}`);
};

const paletteInspection = (
  temporaryRoot: string | null,
  io: PaletteStorageFs
): PaletteLoadResult => {
  const paths = getPalettePaths(temporaryRoot);
  if (!paths) {
    return {
      document: clonePaletteDocument(DEFAULT_PALETTE),
      error: "CEP user-data storage is unavailable",
      recovery: "none",
    };
  }

  const primaryExists = io.existsSync(paths.final);
  const primary = primaryExists ? readDocument(paths.final, io) : null;
  if (primary) return { document: primary, error: null, recovery: "none" };

  const candidates: Array<{ path: string; recovery: Exclude<PaletteRecovery, "none"> }> = [
    { path: paths.temp, recovery: "temp" },
    { path: paths.backup, recovery: "backup" },
  ];
  const invalidCandidates: string[] = [];
  for (const candidate of candidates) {
    if (!io.existsSync(candidate.path)) continue;
    const document = readDocument(candidate.path, io);
    if (!document) {
      invalidCandidates.push(candidate.recovery);
      continue;
    }
    return {
      document,
      error: primaryExists ? "Saved palette is invalid; a valid recovery candidate is available" : null,
      recovery: candidate.recovery,
    };
  }

  if (primaryExists || invalidCandidates.length > 0) {
    return {
      document: clonePaletteDocument(DEFAULT_PALETTE),
      error: primaryExists
        ? invalidCandidates.length > 0
          ? `Saved palette and interrupted palette ${invalidCandidates.join(" and ")} files are invalid and preserved`
          : "Saved palette is invalid; the original file was preserved"
        : `Interrupted palette ${invalidCandidates.join(" and ")} file${
            invalidCandidates.length === 1 ? " is" : "s are"
          } invalid and preserved`,
      recovery: "none",
    };
  }

  return { document: clonePaletteDocument(DEFAULT_PALETTE), error: null, recovery: "none" };
};

export const inspectPalette = (
  temporaryRoot: string | null,
  io: PaletteStorageFs = fs as PaletteStorageFs
) => paletteInspection(temporaryRoot, io);

export const promotePaletteRecovery = (
  temporaryRoot: string | null,
  inspected: PaletteLoadResult,
  io: PaletteStorageFs = fs as PaletteStorageFs
): PaletteLoadResult => {
  if (inspected.recovery === "none") return inspected;
  const paths = getPalettePaths(temporaryRoot);
  if (!paths) return inspected;
  const candidatePath = inspected.recovery === "temp" ? paths.temp : paths.backup;
  const currentFinal = io.existsSync(paths.final) ? readDocument(paths.final, io) : null;
  if (currentFinal) {
    return { document: currentFinal, error: null, recovery: "none" };
  }
  const candidateDocument = io.existsSync(candidatePath)
    ? readDocument(candidatePath, io)
    : null;
  if (!candidateDocument) {
    return {
      ...inspected,
      error: "Palette recovery candidate disappeared or became invalid before promotion",
    };
  }
  const finalAfterCandidateRead = io.existsSync(paths.final)
    ? readDocument(paths.final, io)
    : null;
  if (finalAfterCandidateRead) {
    return { document: finalAfterCandidateRead, error: null, recovery: "none" };
  }

  let quarantinedPath: string | null = null;
  let candidateMoved = false;
  try {
    io.mkdirSync(paths.directory, { recursive: true });
    const finalBeforePromotion = io.existsSync(paths.final)
      ? readDocument(paths.final, io)
      : null;
    if (finalBeforePromotion) {
      return { document: finalBeforePromotion, error: null, recovery: "none" };
    }
    if (io.existsSync(paths.final)) {
      quarantinedPath = nextResiduePath(paths.invalid, io);
      io.renameSync(paths.final, quarantinedPath);
    }
    io.renameSync(candidatePath, paths.final);
    candidateMoved = true;
    const verified = readDocument(paths.final, io);
    if (!verified) throw new Error("promoted palette verification failed");
    return { document: verified, error: null, recovery: inspected.recovery };
  } catch (error) {
    const rollbackErrors: string[] = [];
    if (candidateMoved && io.existsSync(paths.final)) {
      try {
        io.renameSync(paths.final, candidatePath);
        candidateMoved = false;
      } catch (rollbackError) {
        rollbackErrors.push(`could not preserve replacement candidate: ${String(rollbackError)}`);
      }
    }
    if (quarantinedPath && io.existsSync(quarantinedPath) && !io.existsSync(paths.final)) {
      try {
        io.renameSync(quarantinedPath, paths.final);
      } catch (rollbackError) {
        rollbackErrors.push(`could not restore primary: ${String(rollbackError)}`);
      }
    }
    return {
      ...inspected,
      error: `Palette recovery promotion failed: ${String(error)}${
        rollbackErrors.length > 0 ? `; ${rollbackErrors.join("; ")}` : ""
      }`,
    };
  }
};

export const loadPalette = (
  temporaryRoot: string | null,
  io: PaletteStorageFs = fs as PaletteStorageFs
): PaletteLoadResult => {
  const inspected = inspectPalette(temporaryRoot, io);
  return inspected.recovery === "none"
    ? inspected
    : promotePaletteRecovery(temporaryRoot, inspected, io);
};

export type UnknownPaletteCommandResult = PaletteLoadResult & { message: string };

export const inspectPaletteAfterUnknownCommand = (
  temporaryRoot: string | null,
  io: PaletteStorageFs = fs as PaletteStorageFs
): UnknownPaletteCommandResult => ({
  ...inspectPalette(temporaryRoot, io),
  message: "Palette command completion is unknown; authoritative state was inspected and no retry was sent",
});

export const combinePaletteStatus = (status: string | null, error: string | null) =>
  [status, error].filter((value): value is string => Boolean(value)).join(" · ");

export type PaletteTimeoutScheduler = (callback: () => void, delayMs: number) => number;

export type SettingsPaletteTimeoutTransition = {
  requestId: string;
  isCurrentRequest: (requestId: string) => boolean;
  temporaryRoot: string | null;
  clearPending: () => void;
  setDocument: (document: PaletteDocument) => void;
  setError: (error: string | null) => void;
  setStatus: (status: string) => void;
  schedule: PaletteTimeoutScheduler;
  delayMs: number;
};

export const scheduleSettingsPaletteCommandTimeout = ({
  requestId,
  isCurrentRequest,
  temporaryRoot,
  clearPending,
  setDocument,
  setError,
  setStatus,
  schedule,
  delayMs,
}: SettingsPaletteTimeoutTransition) =>
  schedule(() => {
    if (!isCurrentRequest(requestId)) return;
    const settled = inspectPaletteAfterUnknownCommand(temporaryRoot);
    setDocument(settled.document);
    setError(settled.error);
    clearPending();
    setStatus(settled.message);
  }, delayMs);

export const beginPaletteCommandRequest = (
  requestId: string,
  getPendingRequestId: () => string | null,
  setPendingRequestId: (requestId: string) => void,
  dispatch: () => void
) => {
  if (getPendingRequestId() !== null) return false;
  setPendingRequestId(requestId);
  dispatch();
  return true;
};

const writePalette = (document: PaletteDocument, temporaryRoot: string | null) => {
  if (!isPaletteDocument(document)) throw new Error("Refusing to save an invalid palette");
  const paths = getPalettePaths(temporaryRoot);
  if (!paths) throw new Error("CEP user-data storage is unavailable");

  if (fs.existsSync(paths.final) && !readDocument(paths.final, fs as PaletteStorageFs)) {
    throw new Error("Refusing to replace an invalid saved palette");
  }

  fs.mkdirSync(paths.directory, { recursive: true });
  if (fs.existsSync(paths.temp)) fs.unlinkSync(paths.temp);
  fs.writeFileSync(paths.temp, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  const verified = readDocument(paths.temp, fs as PaletteStorageFs);
  if (!verified) {
    throw new Error("Palette verification failed before replacement");
  }

  let primaryBackup: string | null = null;
  if (fs.existsSync(paths.final)) {
    primaryBackup = paths.backup;
    if (fs.existsSync(primaryBackup)) {
      const preservedBackup = nextResiduePath(`${paths.backup}.residue`, fs as PaletteStorageFs);
      fs.renameSync(primaryBackup, preservedBackup);
    }
    fs.renameSync(paths.final, primaryBackup);
  }
  try {
    fs.renameSync(paths.temp, paths.final);
    const persisted = readDocument(paths.final, fs as PaletteStorageFs);
    if (!persisted) throw new Error("Palette verification failed after replacement");
    if (fs.existsSync(paths.backup)) fs.unlinkSync(paths.backup);
    writeCount += 1;
  } catch (error) {
    if (fs.existsSync(paths.final)) fs.unlinkSync(paths.final);
    if (primaryBackup && fs.existsSync(primaryBackup)) fs.renameSync(primaryBackup, paths.final);
    if (fs.existsSync(paths.temp)) fs.unlinkSync(paths.temp);
    throw error;
  }
};

export const savePalette = (
  document: PaletteDocument,
  temporaryRoot: string | null
): Promise<void> => {
  const operation = writeQueue.then(() => writePalette(clonePaletteDocument(document), temporaryRoot));
  writeQueue = operation.then(
    () => undefined,
    () => undefined
  );
  return operation;
};

export const waitForPaletteWrites = () => writeQueue;
export const getPaletteWriteCount = () => writeCount;
export const resetPaletteWriteCount = () => {
  writeCount = 0;
};
