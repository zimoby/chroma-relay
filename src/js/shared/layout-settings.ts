import CSInterface, { CSEvent } from "../lib/cep/csinterface.js";
import { fs, path } from "../lib/cep/node.ts";
import {
  DEFAULT_LAYOUT_SETTINGS,
  type LayoutSettings,
  isLayoutSettings,
  migrateLayoutSettings,
} from "./layout-settings-domain.ts";
import contract from "../../shared/product-contract.json" with { type: "json" };

export {
  DEFAULT_LAYOUT_SETTINGS,
  LAYOUT_SETTINGS_SCHEMA_VERSION,
  MAX_SWATCH_SIZE,
  MIN_SWATCH_SIZE,
  type ExtractionPreset,
  type GradientCollectionMode,
  type LayoutMode,
  type LayoutSettings,
  clampSwatchSize,
} from "./layout-settings-domain.ts";

export const MAIN_EXTENSION_ID = contract.product.panelIds.main;
export const SETTINGS_EXTENSION_ID = contract.product.panelIds.settings;
export const LAYOUT_SETTINGS_EVENT = contract.events.layoutSettingsChanged;

export type LayoutSettingsLoadResult = {
  settings: LayoutSettings;
  error: string | null;
};

export type LayoutSettingsFs = {
  existsSync: (filePath: string) => boolean;
  mkdirSync: (directory: string, options?: { recursive?: boolean }) => void;
  readFileSync: (filePath: string, encoding: "utf8") => string;
  writeFileSync: (filePath: string, data: string, encoding: "utf8") => void;
  renameSync: (from: string, to: string) => void;
  unlinkSync: (filePath: string) => void;
};

const csi = new CSInterface();

const cloneSettings = (settings: LayoutSettings): LayoutSettings => ({ ...settings });

const getSettingsDirectory = (temporaryRoot: string | null) => {
  if (temporaryRoot) return temporaryRoot;
  if (!window.cep) return null;
  return path.join(
    csi.getSystemPath("userData"),
    contract.compatibility.storageDirectory
  );
};

export const getLayoutSettingsPaths = (temporaryRoot: string | null) => {
  const directory = getSettingsDirectory(temporaryRoot);
  if (!directory) return null;
  return {
    directory,
    final: path.join(directory, "settings.json"),
    temp: path.join(directory, "settings.json.tmp"),
    backup: path.join(directory, "settings.json.bak"),
    invalid: path.join(directory, "settings.json.invalid"),
  };
};

const nextResiduePath = (filePath: string, io: LayoutSettingsFs) => {
  if (!io.existsSync(filePath)) return filePath;
  for (let index = 1; index < 1000; index += 1) {
    const candidate = `${filePath}.${index}`;
    if (!io.existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not allocate a residue path for ${filePath}`);
};

const readSettings = (filePath: string, io: LayoutSettingsFs) => {
  try {
    return migrateLayoutSettings(JSON.parse(io.readFileSync(filePath, "utf8")) as unknown);
  } catch {
    return null;
  }
};

export const loadLayoutSettings = (
  temporaryRoot: string | null,
  io: LayoutSettingsFs = fs as LayoutSettingsFs
): LayoutSettingsLoadResult => {
  const paths = getLayoutSettingsPaths(temporaryRoot);
  if (!paths) {
    return { settings: cloneSettings(DEFAULT_LAYOUT_SETTINGS), error: null };
  }

  const primaryExists = io.existsSync(paths.final);
  const primary = primaryExists ? readSettings(paths.final, io) : null;
  if (primary) return { settings: cloneSettings(primary), error: null };

  const invalidCandidates: string[] = [];
  for (const candidate of [
    { path: paths.temp, name: "temp" },
    { path: paths.backup, name: "backup" },
  ]) {
    if (!io.existsSync(candidate.path)) continue;
    const recovered = readSettings(candidate.path, io);
    if (!recovered) {
      invalidCandidates.push(candidate.name);
      continue;
    }
    return {
      settings: cloneSettings(recovered),
      error: primaryExists
        ? `Saved layout settings are invalid; using valid ${candidate.name} recovery content without modifying storage`
        : null,
    };
  }

  return {
    settings: cloneSettings(DEFAULT_LAYOUT_SETTINGS),
    error: primaryExists
      ? invalidCandidates.length > 0
        ? `Saved and interrupted layout settings ${invalidCandidates.join(" and ")} content are invalid and preserved`
        : "Saved layout settings are invalid and preserved"
      : invalidCandidates.length > 0
      ? `Interrupted layout settings ${invalidCandidates.join(" and ")} content are invalid and preserved`
      : null,
  };
};

export const saveLayoutSettings = (
  settings: LayoutSettings,
  temporaryRoot: string | null
) => {
  if (!isLayoutSettings(settings)) {
    throw new Error("Refusing to save invalid layout settings");
  }
  const paths = getLayoutSettingsPaths(temporaryRoot);
  if (!paths) throw new Error("CEP user-data storage is unavailable");

  fs.mkdirSync(paths.directory, { recursive: true });
  fs.writeFileSync(paths.temp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

  let backupCreated = false;
  let invalidPrimary: string | null = null;
  if (fs.existsSync(paths.final)) {
    if (readSettings(paths.final, fs as LayoutSettingsFs)) {
      if (fs.existsSync(paths.backup)) {
        fs.renameSync(paths.backup, nextResiduePath(`${paths.backup}.residue`, fs as LayoutSettingsFs));
      }
      fs.renameSync(paths.final, paths.backup);
      backupCreated = true;
    } else {
      invalidPrimary = nextResiduePath(paths.invalid, fs as LayoutSettingsFs);
      fs.renameSync(paths.final, invalidPrimary);
    }
  }
  try {
    fs.renameSync(paths.temp, paths.final);
    if (!readSettings(paths.final, fs as LayoutSettingsFs)) {
      throw new Error("Layout settings verification failed after replacement");
    }
    if (backupCreated && fs.existsSync(paths.backup)) fs.unlinkSync(paths.backup);
  } catch (error) {
    if (fs.existsSync(paths.final)) fs.unlinkSync(paths.final);
    if (backupCreated && fs.existsSync(paths.backup)) fs.renameSync(paths.backup, paths.final);
    if (invalidPrimary && fs.existsSync(invalidPrimary) && !fs.existsSync(paths.final)) {
      fs.renameSync(invalidPrimary, paths.final);
    }
    if (fs.existsSync(paths.temp)) fs.unlinkSync(paths.temp);
    throw error;
  }
};

export const dispatchLayoutSettings = (settings: LayoutSettings) => {
  const event = new CSEvent(
    LAYOUT_SETTINGS_EVENT,
    "APPLICATION",
    csi.getApplicationID(),
    csi.getExtensionID()
  );
  event.data = cloneSettings(settings);
  csi.dispatchEvent(event);
};

const parseEventSettings = (data: unknown): LayoutSettings | null => {
  try {
    const parsed = typeof data === "string" ? (JSON.parse(data) as unknown) : data;
    return isLayoutSettings(parsed) ? cloneSettings(parsed) : null;
  } catch {
    return null;
  }
};

export const listenForLayoutSettings = (
  callback: (settings: LayoutSettings) => void
) => {
  const handler = (event: { data: unknown }) => {
    const settings = parseEventSettings(event.data);
    if (settings) callback(settings);
  };
  csi.addEventListener(LAYOUT_SETTINGS_EVENT, handler);
  return () => csi.removeEventListener(LAYOUT_SETTINGS_EVENT, handler, null);
};
