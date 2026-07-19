import CSInterface from "../lib/cep/csinterface";
import { fs, path } from "../lib/cep/node";
import {
  DEFAULT_PALETTE,
  type PaletteDocument,
  clonePaletteDocument,
  isPaletteDocument,
  migratePaletteDocument,
} from "./palette-domain";

export type PaletteRecovery = "none" | "backup" | "temp";

export type PaletteLoadResult = {
  document: PaletteDocument;
  error: string | null;
  recovery: PaletteRecovery;
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
  };
};

const readDocument = (filePath: string) => {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    return migratePaletteDocument(parsed);
  } catch {
    return null;
  }
};

export const loadPalette = (temporaryRoot: string | null): PaletteLoadResult => {
  const paths = getPalettePaths(temporaryRoot);
  if (!paths) {
    return {
      document: clonePaletteDocument(DEFAULT_PALETTE),
      error: "CEP user-data storage is unavailable",
      recovery: "none",
    };
  }

  if (fs.existsSync(paths.final)) {
    const document = readDocument(paths.final);
    return document
      ? { document, error: null, recovery: "none" }
      : {
          document: clonePaletteDocument(DEFAULT_PALETTE),
          error: "Saved palette is invalid; the original file was preserved",
          recovery: "none",
        };
  }

  const candidates: Array<{ path: string; recovery: Exclude<PaletteRecovery, "none"> }> = [
    { path: paths.temp, recovery: "temp" },
    { path: paths.backup, recovery: "backup" },
  ];
  const invalidCandidates: string[] = [];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate.path)) continue;
    const document = readDocument(candidate.path);
    if (!document) {
      invalidCandidates.push(candidate.recovery);
      continue;
    }
    fs.mkdirSync(paths.directory, { recursive: true });
    fs.renameSync(candidate.path, paths.final);
    return { document, error: null, recovery: candidate.recovery };
  }

  if (invalidCandidates.length > 0) {
    return {
      document: clonePaletteDocument(DEFAULT_PALETTE),
      error: `Interrupted palette ${invalidCandidates.join(" and ")} file${
        invalidCandidates.length === 1 ? " is" : "s are"
      } invalid and preserved`,
      recovery: "none",
    };
  }

  return { document: clonePaletteDocument(DEFAULT_PALETTE), error: null, recovery: "none" };
};

const writePalette = (document: PaletteDocument, temporaryRoot: string | null) => {
  if (!isPaletteDocument(document)) throw new Error("Refusing to save an invalid palette");
  const paths = getPalettePaths(temporaryRoot);
  if (!paths) throw new Error("CEP user-data storage is unavailable");

  if (fs.existsSync(paths.final) && !readDocument(paths.final)) {
    throw new Error("Refusing to replace an invalid saved palette");
  }

  fs.mkdirSync(paths.directory, { recursive: true });
  if (fs.existsSync(paths.temp)) fs.unlinkSync(paths.temp);
  fs.writeFileSync(paths.temp, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  const verified = readDocument(paths.temp);
  if (!verified) {
    throw new Error("Palette verification failed before replacement");
  }

  if (fs.existsSync(paths.backup)) fs.unlinkSync(paths.backup);
  if (fs.existsSync(paths.final)) fs.renameSync(paths.final, paths.backup);
  try {
    fs.renameSync(paths.temp, paths.final);
    const persisted = readDocument(paths.final);
    if (!persisted) throw new Error("Palette verification failed after replacement");
    if (fs.existsSync(paths.backup)) fs.unlinkSync(paths.backup);
    writeCount += 1;
  } catch (error) {
    if (fs.existsSync(paths.final)) fs.unlinkSync(paths.final);
    if (fs.existsSync(paths.backup)) fs.renameSync(paths.backup, paths.final);
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
