import CSInterface, { CSEvent } from "../lib/cep/csinterface";
import { fs, path } from "../lib/cep/node";
import {
  DEFAULT_LAYOUT_SETTINGS,
  type LayoutSettings,
  isLayoutSettings,
  migrateLayoutSettings,
} from "./layout-settings-domain";

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
} from "./layout-settings-domain";

export const MAIN_EXTENSION_ID = "com.zimoby.chroma-relay.main";
export const SETTINGS_EXTENSION_ID = "com.zimoby.chroma-relay.settings";
export const LAYOUT_SETTINGS_EVENT = "com.zimoby.chroma-relay.settings.changed";

export type LayoutSettingsLoadResult = {
  settings: LayoutSettings;
  error: string | null;
};

const csi = new CSInterface();

const cloneSettings = (settings: LayoutSettings): LayoutSettings => ({ ...settings });

const getSettingsDirectory = (temporaryRoot: string | null) => {
  if (temporaryRoot) return temporaryRoot;
  if (!window.cep) return null;
  return path.join(csi.getSystemPath("userData"), "Chroma Relay");
};

const getSettingsPath = (temporaryRoot: string | null) => {
  const directory = getSettingsDirectory(temporaryRoot);
  return directory ? path.join(directory, "settings.json") : null;
};

export const loadLayoutSettings = (
  temporaryRoot: string | null
): LayoutSettingsLoadResult => {
  const settingsPath = getSettingsPath(temporaryRoot);
  if (!settingsPath || !fs.existsSync(settingsPath)) {
    return { settings: cloneSettings(DEFAULT_LAYOUT_SETTINGS), error: null };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as unknown;
    const migrated = migrateLayoutSettings(parsed);
    if (!migrated) {
      return {
        settings: cloneSettings(DEFAULT_LAYOUT_SETTINGS),
        error: "Saved layout settings are invalid",
      };
    }
    return { settings: cloneSettings(migrated), error: null };
  } catch {
    return {
      settings: cloneSettings(DEFAULT_LAYOUT_SETTINGS),
      error: "Saved layout settings could not be read",
    };
  }
};

export const saveLayoutSettings = (
  settings: LayoutSettings,
  temporaryRoot: string | null
) => {
  if (!isLayoutSettings(settings)) {
    throw new Error("Refusing to save invalid layout settings");
  }
  const settingsPath = getSettingsPath(temporaryRoot);
  if (!settingsPath) throw new Error("CEP user-data storage is unavailable");

  const directory = path.dirname(settingsPath);
  fs.mkdirSync(directory, { recursive: true });
  const tempPath = `${settingsPath}.tmp`;
  const backupPath = `${settingsPath}.bak`;
  fs.writeFileSync(tempPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

  if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
  if (fs.existsSync(settingsPath)) fs.renameSync(settingsPath, backupPath);
  try {
    fs.renameSync(tempPath, settingsPath);
    if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
  } catch (error) {
    if (fs.existsSync(settingsPath)) fs.unlinkSync(settingsPath);
    if (fs.existsSync(backupPath)) fs.renameSync(backupPath, settingsPath);
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
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
