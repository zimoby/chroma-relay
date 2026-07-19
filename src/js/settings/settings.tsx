import {
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  BUILD_MARKER,
  type DesignPreviewState,
  type FixtureViewport,
  dispatchTestClick,
  getPanelIdentity,
  getTestGeometry,
  installDebugApi,
  isFixtureViewport,
  normalizeTemporaryConfigRoot,
} from "../shared/debug-api";
import {
  DEFAULT_LAYOUT_SETTINGS,
  MAX_SWATCH_SIZE,
  MIN_SWATCH_SIZE,
  type ExtractionPreset,
  type GradientCollectionMode,
  type LayoutMode,
  type LayoutSettings,
  clampSwatchSize,
  dispatchLayoutSettings,
  loadLayoutSettings,
  saveLayoutSettings,
} from "../shared/layout-settings";
import {
  type ColorEditorFormat,
  cmykToRgb,
  formatByteValue,
  formatPercentValue,
  formatRawRgba,
  isDisplayRgba,
  parseByteInput,
  parseHexInput,
  parsePercentInput,
  rgbToCmykDisplay,
  rgbaToHexDisplay,
} from "../shared/color-format";
import {
  DEFAULT_PALETTE,
  MAX_PALETTE_COLORS,
  MAX_PALETTES,
  type PaletteColor,
  type PaletteDocument,
  type PaletteDropEdge,
  type Rgba,
  clonePaletteDocument,
  getActivePalette,
  isPaletteGradient,
  rgbaEqual,
  rgbaToCss,
} from "../shared/palette-domain";
import { nativeGradientToCssPreview } from "../shared/native-gradient-preview";
import {
  type PaletteCommand,
  dispatchPaletteCommand,
  listenForPaletteResults,
} from "../shared/palette-events";
import {
  beginPaletteCommandRequest,
  combinePaletteStatus,
  inspectPalette,
  scheduleSettingsPaletteCommandTimeout,
} from "../shared/palette-storage";
import {
  MAX_PALETTE_TRANSFER_BYTES,
  ensureJsonExtension,
  parsePortablePalette,
  portablePaletteFileName,
  serializePortablePalette,
} from "../shared/palette-transfer";
import { fs, url } from "../lib/cep/node";
import "./settings.scss";

const DESIGN_STATES = new Set<DesignPreviewState>([
  "default",
  "interaction",
  "empty",
  "disabled",
  "error",
]);
const STATUS_TIMEOUT_MS = 2500;
const COMMAND_TIMEOUT_MS = 3500;
const EXTRACTION_PRESET_LABELS: Record<ExtractionPreset, string> = {
  balanced: "Balanced",
  tonal: "Tonal",
  contrast: "Contrast",
};
const GRADIENT_COLLECTION_LABELS: Record<GradientCollectionMode, string> = {
  "color-stops": "Color stops",
  "gradient-slot": "Gradient slot",
};
const EDITOR_FORMATS: ColorEditorFormat[] = ["hex", "rgb", "cmyk"];
const EDITOR_FORMAT_LABELS: Record<ColorEditorFormat, string> = {
  hex: "Hex",
  rgb: "RGB",
  cmyk: "CMYK",
};

type SettingsTab = "general" | "palettes";
type EditorFields = Record<string, string>;
type ColorDragState = {
  sourceId: string;
  targetId: string | null;
  edge: PaletteDropEdge | null;
};

const paletteSwatchBackground = (color: PaletteColor) =>
  isPaletteGradient(color) ? nativeGradientToCssPreview(color.gradient) : rgbaToCss(color.rgba);

type NativeDialogResult<T> = { err?: number; data?: T };

// CEP dialogs return either native paths or file:// URLs depending on the
// platform and API generation; both must resolve to a usable local path.
const normalizeDialogPath = (raw: unknown): string | null => {
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (raw.startsWith("file://")) {
    try {
      return url.fileURLToPath(raw);
    } catch {
      return null;
    }
  }
  return raw;
};

let requestSequence = 0;

const nextRequestId = () => {
  requestSequence += 1;
  return `settings-${Date.now().toString(36)}-${requestSequence.toString(36)}`;
};

const buildEditorFields = (rgba: Rgba, format: ColorEditorFormat): EditorFields => {
  if (format === "hex") {
    return { hex: rgbaToHexDisplay(rgba), alpha: formatPercentValue(rgba[3]) };
  }
  if (format === "rgb") {
    return {
      r: formatByteValue(rgba[0]),
      g: formatByteValue(rgba[1]),
      b: formatByteValue(rgba[2]),
      alpha: formatPercentValue(rgba[3]),
    };
  }
  const cmyk = rgbToCmykDisplay(rgba);
  return {
    c: formatPercentValue(cmyk.cyan),
    m: formatPercentValue(cmyk.magenta),
    y: formatPercentValue(cmyk.yellow),
    k: formatPercentValue(cmyk.black),
    alpha: formatPercentValue(rgba[3]),
  };
};

export const App = () => {
  const [fixture, setFixture] = useState<FixtureViewport | null>(null);
  const [configRoot, setConfigRoot] = useState<string | null>(null);
  const [settings, setSettings] = useState<LayoutSettings>(DEFAULT_LAYOUT_SETTINGS);
  const [draftSize, setDraftSize] = useState(DEFAULT_LAYOUT_SETTINGS.swatchSize);
  const [paletteDocument, setPaletteDocument] = useState<PaletteDocument>(() =>
    clonePaletteDocument(DEFAULT_PALETTE)
  );
  const [paletteError, setPaletteError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState(getActivePalette(DEFAULT_PALETTE).name);
  const [armedDeleteId, setArmedDeleteId] = useState<string | null>(null);
  const [expandedColorId, setExpandedColorId] = useState<string | null>(null);
  const [editorFormat, setEditorFormat] = useState<ColorEditorFormat>("hex");
  const [editorFields, setEditorFields] = useState<EditorFields>({});
  const [editorInvalid, setEditorInvalid] = useState<Record<string, boolean>>({});
  const [editorError, setEditorError] = useState<string | null>(null);
  const [colorDrag, setColorDrag] = useState<ColorDragState | null>(null);
  const [status, setStatus] = useState<string | null>("Stretch layout is active");
  const pendingRequestRef = useRef<string | null>(null);
  const pendingAddedColorRef = useRef<{
    paletteId: string;
    existingColorIds: string[];
  } | null>(null);
  const editorInitialRef = useRef<EditorFields>({});
  const countersRef = useRef({
    diskWrites: 0,
    emittedEvents: 0,
    receivedEvents: 0,
    hostCalls: 0,
  });

  const activePalette = getActivePalette(paletteDocument);
  const paletteBusy = pendingRequestId !== null;
  const expandedColor = expandedColorId
    ? activePalette.colors.find((color) => color.id === expandedColorId) ?? null
    : null;
  const expandedColorKey = expandedColor ? expandedColor.rgba.join(",") : null;

  useEffect(() => {
    const loaded = loadLayoutSettings(configRoot);
    setSettings(loaded.settings);
    setDraftSize(loaded.settings.swatchSize);
    setStatus(
      loaded.error ||
        (loaded.settings.layoutMode === "stretch"
          ? "Stretch layout is active"
          : `Fixed layout · ${loaded.settings.swatchSize} px`)
    );
  }, [configRoot]);

  useEffect(() => {
    const loaded = inspectPalette(configRoot);
    setPaletteDocument(loaded.document);
    setPaletteError(loaded.error);
    setNameDraft(getActivePalette(loaded.document).name);
  }, [configRoot]);

  useEffect(() => {
    setNameDraft(activePalette.name);
    setArmedDeleteId(null);
  }, [activePalette.id, activePalette.name]);

  useEffect(() => {
    if (!expandedColor) {
      if (expandedColorId !== null) setExpandedColorId(null);
      return;
    }
    const fields = buildEditorFields(expandedColor.rgba, editorFormat);
    editorInitialRef.current = fields;
    setEditorFields(fields);
    setEditorError(null);
    setEditorInvalid({});
    // Rebuild drafts only when the target color, its stored value, or the format changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedColorId, editorFormat, expandedColorKey]);

  useEffect(
    () =>
      listenForPaletteResults((result) => {
        countersRef.current.receivedEvents += 1;
        setPaletteDocument(result.document);
        setPaletteError(null);
        if (result.requestId === null || result.requestId === pendingRequestRef.current) {
          if (result.requestId !== null) {
            pendingRequestRef.current = null;
            setPendingRequestId(null);
            const pendingAdd = pendingAddedColorRef.current;
            pendingAddedColorRef.current = null;
            if (result.ok && pendingAdd) {
              const palette = result.document.palettes.find(
                (candidate) => candidate.id === pendingAdd.paletteId
              );
              const addedColor = palette?.colors.find(
                (color) => !pendingAdd.existingColorIds.includes(color.id)
              );
              if (addedColor) {
                setEditorFormat("hex");
                setExpandedColorId(addedColor.id);
              }
            }
          }
          setStatus(result.message);
        }
      }),
    []
  );

  useEffect(() => {
    if (!pendingRequestId) return undefined;
    const timeout = scheduleSettingsPaletteCommandTimeout({
      requestId: pendingRequestId,
      isCurrentRequest: (requestId) => pendingRequestRef.current === requestId,
      temporaryRoot: configRoot,
      clearPending: () => {
        pendingRequestRef.current = null;
        pendingAddedColorRef.current = null;
        setPendingRequestId(null);
      },
      setDocument: setPaletteDocument,
      setError: setPaletteError,
      setStatus,
      schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
      delayMs: COMMAND_TIMEOUT_MS,
    });
    return () => window.clearTimeout(timeout);
  }, [pendingRequestId, configRoot]);

  useEffect(() => {
    if (!status) return undefined;
    const timeout = window.setTimeout(() => setStatus(null), STATUS_TIMEOUT_MS);
    return () => window.clearTimeout(timeout);
  }, [status]);

  const commitSettings = (
    patch: Partial<
      Pick<
        LayoutSettings,
        | "layoutMode"
        | "swatchSize"
        | "includeDisabledColors"
        | "extractionPreset"
        | "gradientCollectionMode"
      >
    >
  ) => {
    const next: LayoutSettings = {
      ...settings,
      ...patch,
      revision: settings.revision + 1,
    };
    try {
      saveLayoutSettings(next, configRoot);
      countersRef.current.diskWrites += 1;
      dispatchLayoutSettings(next);
      countersRef.current.emittedEvents += 1;
      setSettings(next);
      setDraftSize(next.swatchSize);
      setStatus(
        patch.extractionPreset !== undefined
          ? `${EXTRACTION_PRESET_LABELS[next.extractionPreset]} image extraction saved`
          : patch.includeDisabledColors !== undefined
          ? next.includeDisabledColors
            ? "Disabled colors included"
            : "Disabled colors skipped"
          : next.layoutMode === "stretch"
          ? "Stretch layout saved"
          : `Fixed layout saved · ${next.swatchSize} px`
      );
    } catch {
      setStatus("Layout setting could not be saved");
    }
  };

  const sendPaletteCommand = (command: PaletteCommand) => {
    if (pendingRequestRef.current || paletteError) return false;
    const requestId = nextRequestId();
    const started = beginPaletteCommandRequest(
      requestId,
      () => pendingRequestRef.current,
      (nextRequestId) => {
        pendingRequestRef.current = nextRequestId;
        setPendingRequestId(nextRequestId);
      },
      () =>
        dispatchPaletteCommand({
          requestId,
          baseRevision: paletteDocument.revision,
          command,
        })
    );
    if (!started) return false;
    setArmedDeleteId(null);
    setStatus("Saving palette…");
    countersRef.current.emittedEvents += 1;
    return true;
  };

  const selectLayoutMode = (layoutMode: LayoutMode) => {
    if (layoutMode !== settings.layoutMode) commitSettings({ layoutMode });
  };

  const selectExtractionPreset = (extractionPreset: ExtractionPreset) => {
    if (extractionPreset !== settings.extractionPreset) commitSettings({ extractionPreset });
  };

  const commitSwatchSize = (value: number) => {
    const normalized = Number.isFinite(value)
      ? clampSwatchSize(value)
      : settings.swatchSize;
    setDraftSize(normalized);
    if (normalized !== settings.swatchSize) commitSettings({ swatchSize: normalized });
  };

  const commitPaletteName = () => {
    const normalized = nameDraft.trim();
    if (!normalized) {
      setNameDraft(activePalette.name);
      setStatus("Palette name cannot be empty");
      return;
    }
    if (normalized === activePalette.name) {
      setNameDraft(normalized);
      return;
    }
    sendPaletteCommand({ type: "rename", paletteId: activePalette.id, name: normalized });
  };

  const requestDeletePalette = () => {
    if (paletteDocument.palettes.length === 1 || paletteBusy) return;
    if (armedDeleteId === activePalette.id) {
      setArmedDeleteId(null);
      return;
    }
    setArmedDeleteId(activePalette.id);
    setStatus("Confirm to delete this palette");
  };

  const confirmDeletePalette = () => {
    if (armedDeleteId !== activePalette.id || paletteBusy) return;
    sendPaletteCommand({ type: "delete", paletteId: activePalette.id });
  };

  const paletteLimitReached = paletteDocument.palettes.length >= MAX_PALETTES;

  const addBlackColor = () => {
    if (
      paletteBusy ||
      paletteError !== null ||
      activePalette.colors.length >= MAX_PALETTE_COLORS
    ) {
      return;
    }
    pendingAddedColorRef.current = {
      paletteId: activePalette.id,
      existingColorIds: activePalette.colors.map((color) => color.id),
    };
    if (!sendPaletteCommand({ type: "add-color", paletteId: activePalette.id })) {
      pendingAddedColorRef.current = null;
    }
  };

  const importPaletteFromFile = () => {
    if (paletteBusy || paletteError !== null || paletteLimitReached) return;
    const cepFs = typeof window.cep !== "undefined" ? window.cep.fs : undefined;
    if (!cepFs || (!cepFs.showOpenDialogEx && !cepFs.showOpenDialog)) {
      setStatus("Native file dialogs are unavailable");
      return;
    }
    const result = (
      cepFs.showOpenDialogEx
        ? cepFs.showOpenDialogEx(false, false, "Import palette", null, ["json"])
        : cepFs.showOpenDialog(false, false, "Import palette", null)
    ) as NativeDialogResult<string[]>;
    if (typeof result?.err === "number" && result.err !== 0) {
      setStatus("The import dialog reported an error");
      return;
    }
    const selected = Array.isArray(result?.data) ? result.data[0] : undefined;
    if (selected === undefined || selected === "") return; // cancelled: no-op
    const filePath = normalizeDialogPath(selected);
    if (!filePath) {
      setStatus("The selected file path is unsupported");
      return;
    }
    let text: string;
    try {
      if (fs.statSync(filePath).size > MAX_PALETTE_TRANSFER_BYTES) {
        setStatus("Palette files are limited to 1 MB");
        return;
      }
      text = fs.readFileSync(filePath, "utf8");
    } catch {
      setStatus("Could not read the selected palette file");
      return;
    }
    const parsed = parsePortablePalette(text);
    if (!parsed.ok) {
      setStatus(parsed.error);
      return;
    }
    sendPaletteCommand({ type: "import-palette", name: parsed.name, items: parsed.items });
  };

  const exportActivePalette = () => {
    if (paletteBusy || paletteError !== null) return;
    const cepFs = typeof window.cep !== "undefined" ? window.cep.fs : undefined;
    if (!cepFs || !cepFs.showSaveDialogEx) {
      setStatus("Native file dialogs are unavailable");
      return;
    }
    const result = cepFs.showSaveDialogEx(
      "Export palette",
      null,
      ["json"],
      portablePaletteFileName(activePalette.name)
    ) as NativeDialogResult<string>;
    if (typeof result?.err === "number" && result.err !== 0) {
      setStatus("The export dialog reported an error");
      return;
    }
    const target = typeof result?.data === "string" ? result.data : "";
    if (target === "") return; // cancelled: no-op
    const normalized = normalizeDialogPath(target);
    if (!normalized) {
      setStatus("The chosen save location is unsupported");
      return;
    }
    const filePath = ensureJsonExtension(normalized);
    // Appending .json changes the path returned by the native Save dialog. Do
    // not silently overwrite a file the user was never asked to confirm.
    if (filePath !== normalized && fs.existsSync(filePath)) {
      setStatus("A .json file with that name already exists; choose it in Save");
      return;
    }
    const payload = serializePortablePalette(activePalette.name, activePalette.colors);
    try {
      fs.writeFileSync(filePath, payload, "utf8");
      const persisted = fs.readFileSync(filePath, "utf8");
      if (persisted !== payload || !parsePortablePalette(persisted).ok) {
        setStatus("Exported palette failed verification");
        return;
      }
    } catch {
      setStatus("Could not write the palette file");
      return;
    }
    setStatus(`Exported ${activePalette.name}`);
  };

  const toggleColorEditor = (colorId: string) => {
    setArmedDeleteId(null);
    setExpandedColorId((current) => (current === colorId ? null : colorId));
  };

  const closeColorEditor = (colorId: string) => {
    setExpandedColorId(null);
    setEditorError(null);
    setEditorInvalid({});
    window.requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(`[data-testid="color-summary-${colorId}"]`)
        ?.focus();
    });
  };

  const updateEditorField = (key: string, value: string) => {
    setEditorFields((fields) => ({ ...fields, [key]: value }));
    setEditorError(null);
    setEditorInvalid({});
  };

  const failCommit = (message: string, keys: string[]) => {
    const invalid: Record<string, boolean> = {};
    keys.forEach((key) => {
      invalid[key] = true;
    });
    setEditorError(message);
    setEditorInvalid(invalid);
  };

  const commitColorEditor = (color: PaletteColor) => {
    if (paletteBusy || paletteError) return;
    const initial = editorInitialRef.current;
    const changed = (key: string) => (editorFields[key] ?? "") !== (initial[key] ?? "");
    if (!Object.keys(initial).some(changed)) {
      setEditorError(null);
      setEditorInvalid({});
      return;
    }
    const next: Rgba = [color.rgba[0], color.rgba[1], color.rgba[2], color.rgba[3]];
    if (editorFormat === "hex") {
      if (changed("hex")) {
        const parsed = parseHexInput(editorFields.hex ?? "", next[3]);
        if (!parsed) {
          failCommit("Hex uses #RRGGBB or #RRGGBBAA", ["hex"]);
          return;
        }
        next[0] = parsed[0];
        next[1] = parsed[1];
        next[2] = parsed[2];
        next[3] = parsed[3];
      }
    } else if (editorFormat === "rgb") {
      const channels: Array<[string, number]> = [
        ["r", 0],
        ["g", 1],
        ["b", 2],
      ];
      const invalidKeys: string[] = [];
      channels.forEach(([key, index]) => {
        if (!changed(key)) return;
        const parsed = parseByteInput(editorFields[key] ?? "");
        if (parsed === null) invalidKeys.push(key);
        else next[index] = parsed;
      });
      if (invalidKeys.length > 0) {
        failCommit("R, G, and B use 0–255", invalidKeys);
        return;
      }
    } else {
      const keys = ["c", "m", "y", "k"];
      if (keys.some(changed)) {
        const parsedChannels = keys.map((key) => parsePercentInput(editorFields[key] ?? ""));
        const invalidKeys = keys.filter((_, index) => parsedChannels[index] === null);
        if (invalidKeys.length > 0) {
          failCommit("C, M, Y, and K use 0–100", invalidKeys);
          return;
        }
        const rgb = cmykToRgb(
          parsedChannels[0] as number,
          parsedChannels[1] as number,
          parsedChannels[2] as number,
          parsedChannels[3] as number
        );
        next[0] = rgb[0];
        next[1] = rgb[1];
        next[2] = rgb[2];
      }
    }
    if (changed("alpha")) {
      const parsedAlpha = parsePercentInput(editorFields.alpha ?? "");
      if (parsedAlpha === null) {
        failCommit("Alpha uses 0–100", ["alpha"]);
        return;
      }
      next[3] = parsedAlpha;
    }
    setEditorError(null);
    setEditorInvalid({});
    if (rgbaEqual(next, color.rgba, 0)) return;
    sendPaletteCommand({
      type: "update-color",
      paletteId: activePalette.id,
      colorId: color.id,
      rgba: next,
    });
  };

  const handleEditorKeyDown = (
    event: ReactKeyboardEvent<HTMLInputElement>,
    color: PaletteColor
  ) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitColorEditor(color);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeColorEditor(color.id);
    }
  };

  const handleGripDragStart = (
    event: ReactDragEvent<HTMLButtonElement>,
    color: PaletteColor
  ) => {
    if (paletteBusy || paletteError) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", color.id);
    setColorDrag({ sourceId: color.id, targetId: null, edge: null });
  };

  const handleRowDragOver = (event: ReactDragEvent<HTMLDivElement>, targetId: string) => {
    if (!colorDrag) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const bounds = event.currentTarget.getBoundingClientRect();
    const edge: PaletteDropEdge =
      event.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
    setColorDrag((current) => {
      if (!current) return current;
      if (current.sourceId === targetId) {
        if (current.targetId === null && current.edge === null) return current;
        return { ...current, targetId: null, edge: null };
      }
      if (current.targetId === targetId && current.edge === edge) return current;
      return { ...current, targetId, edge };
    });
  };

  const handleRowDrop = (event: ReactDragEvent<HTMLDivElement>, targetId: string) => {
    event.preventDefault();
    const sourceId = colorDrag?.sourceId || event.dataTransfer.getData("text/plain");
    const edge = colorDrag?.targetId === targetId ? colorDrag.edge : null;
    setColorDrag(null);
    if (sourceId && edge && sourceId !== targetId) {
      sendPaletteCommand({
        type: "reorder-color",
        paletteId: activePalette.id,
        sourceId,
        targetId,
        edge,
      });
    }
  };

  const handleGripDragEnd = () => setColorDrag(null);

  const handleGripKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    color: PaletteColor,
    index: number
  ) => {
    if (!event.altKey || paletteBusy) return;
    const backwards = event.key === "ArrowUp";
    const forwards = event.key === "ArrowDown";
    if (!backwards && !forwards) return;
    const target = activePalette.colors[index + (backwards ? -1 : 1)];
    if (!target) return;
    event.preventDefault();
    sendPaletteCommand({
      type: "reorder-color",
      paletteId: activePalette.id,
      sourceId: color.id,
      targetId: target.id,
      edge: backwards ? "before" : "after",
    });
  };

  useEffect(() => {
    return installDebugApi({
      getIdentity: () => getPanelIdentity("settings", configRoot),
      getState: () => ({
        paletteRevision: paletteDocument.revision,
        palette: activePalette.colors.map((color) => ({
          id: color.id,
          css: rgbaToCss(color.rgba),
        })),
        palettes: paletteDocument.palettes.map((palette) => ({
          id: palette.id,
          name: palette.name,
          colorCount: palette.colors.length,
          active: palette.id === paletteDocument.activePaletteId,
        })),
        activePalette: { id: activePalette.id, name: activePalette.name },
        paletteError,
        settings: { available: true, ...settings },
        activeTab,
        pendingRequestId,
        expandedColorId,
        editorFormat,
        editorError,
        armedDeleteId,
        colorDrag,
        activeOrientation: null,
        pendingHostAction: null,
        lastResult: status,
        fixtureViewport: fixture,
      }),
      seedPalette: () => {
        throw new Error("seedPalette is only available on the Main panel");
      },
      persistPalette: async () => {
        throw new Error("persistPalette is only available on the Main panel");
      },
      reloadPalette: () => {
        const loaded = inspectPalette(configRoot);
        setPaletteDocument(loaded.document);
        setPaletteError(loaded.error);
        return loaded;
      },
      setTemporaryConfigRoot: (root) => {
        const normalized = normalizeTemporaryConfigRoot(root);
        setConfigRoot(normalized);
        return normalized;
      },
      setFixtureViewport: (width, height) => {
        if (!isFixtureViewport(width, height)) return false;
        setFixture({ width, height });
        return true;
      },
      setDesignPreview: (state) => DESIGN_STATES.has(state),
      getGeometry: () => getTestGeometry("settings"),
      getCounters: () => ({ ...countersRef.current }),
      dispatchClick: dispatchTestClick,
      resetTestState: () => {
        const defaultPalette = clonePaletteDocument(DEFAULT_PALETTE);
        pendingRequestRef.current = null;
        editorInitialRef.current = {};
        setFixture(null);
        setConfigRoot(null);
        setSettings(DEFAULT_LAYOUT_SETTINGS);
        setDraftSize(DEFAULT_LAYOUT_SETTINGS.swatchSize);
        setPaletteDocument(defaultPalette);
        setPaletteError(null);
        setActiveTab("general");
        setPendingRequestId(null);
        setNameDraft(getActivePalette(defaultPalette).name);
        setArmedDeleteId(null);
        setExpandedColorId(null);
        setEditorFormat("hex");
        setEditorFields({});
        setEditorInvalid({});
        setEditorError(null);
        setColorDrag(null);
        setStatus("Stretch layout is active");
        countersRef.current = {
          diskWrites: 0,
          emittedEvents: 0,
          receivedEvents: 0,
          hostCalls: 0,
        };
      },
      reload: () => window.location.reload(),
    });
  }, [
    activePalette,
    activeTab,
    armedDeleteId,
    colorDrag,
    configRoot,
    editorError,
    editorFormat,
    expandedColorId,
    fixture,
    paletteDocument,
    paletteError,
    pendingRequestId,
    settings,
    status,
  ]);

  const fixtureStyle = fixture
    ? { width: fixture.width, height: fixture.height, minHeight: fixture.height }
    : undefined;

  const renderEditorField = (
    color: PaletteColor,
    key: string,
    label: string,
    className: string,
    suffix?: string
  ) => (
    <label className={`editor-field ${className}`} key={key}>
      <span className="editor-field-label">{label}</span>
      <input
        aria-invalid={editorInvalid[key] ? true : undefined}
        aria-label={`${label} value`}
        data-testid={`color-field-${key}`}
        disabled={paletteBusy}
        onChange={(event) => updateEditorField(key, event.currentTarget.value)}
        onKeyDown={(event) => handleEditorKeyDown(event, color)}
        spellCheck={false}
        type="text"
        value={editorFields[key] ?? ""}
      />
      {suffix ? <span className="editor-field-suffix">{suffix}</span> : null}
    </label>
  );

  const renderColorEditor = (color: PaletteColor) => {
    if (!isDisplayRgba(color.rgba)) {
      return (
        <div className="color-editor-hdr">
          <span>Out of display range — stored values are kept exact:</span>
          <code>{formatRawRgba(color.rgba)}</code>
        </div>
      );
    }
    return (
      <>
        <div
          className="segmented editor-format-switch"
          role="radiogroup"
          aria-label="Color value format"
        >
          {EDITOR_FORMATS.map((format) => (
            <label key={format}>
              <input
                checked={editorFormat === format}
                data-testid={`color-format-${format}`}
                name={`color-format-${color.id}`}
                onChange={() => setEditorFormat(format)}
                type="radio"
              />
              <span>{EDITOR_FORMAT_LABELS[format]}</span>
            </label>
          ))}
        </div>
        <div className="editor-fields">
          {editorFormat === "hex"
            ? renderEditorField(color, "hex", "Hex", "is-hex")
            : editorFormat === "rgb"
            ? ["r", "g", "b"].map((key) =>
                renderEditorField(color, key, key.toUpperCase(), "is-channel")
              )
            : ["c", "m", "y", "k"].map((key) =>
                renderEditorField(color, key, key.toUpperCase(), "is-channel")
              )}
          {renderEditorField(color, "alpha", "A", "is-channel", "%")}
          <button
            aria-label="Apply color value"
            className="icon-action editor-commit"
            data-testid="color-commit"
            disabled={paletteBusy}
            onClick={() => commitColorEditor(color)}
            title="Apply (Enter)"
            type="button"
          >
            <svg aria-hidden="true" height="10" viewBox="0 0 10 10" width="10">
              <path
                d="M1.5 5.5 4 8l4.5-6"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              />
            </svg>
          </button>
        </div>
        {editorError ? (
          <span className="color-editor-error" role="alert">
            {editorError}
          </span>
        ) : null}
      </>
    );
  };

  return (
    <main className="chroma-relay-panel" data-page="settings" style={fixtureStyle}>
      <header className="settings-header">
        <span className="settings-index" aria-hidden="true" />
        <span>
          <strong>Chroma Relay</strong>
          <small>Settings · {BUILD_MARKER}</small>
        </span>
      </header>

      <nav className="settings-tabs" aria-label="Settings sections" role="tablist">
        <button
          aria-controls="general-settings"
          aria-selected={activeTab === "general"}
          data-testid="settings-tab-general"
          onClick={() => setActiveTab("general")}
          role="tab"
          type="button"
        >
          General
        </button>
        <button
          aria-controls="palette-settings"
          aria-selected={activeTab === "palettes"}
          data-testid="settings-tab-palettes"
          onClick={() => {
            setActiveTab("palettes");
            setStatus(`${activePalette.name} is active`);
          }}
          role="tab"
          type="button"
        >
          Palettes
        </button>
      </nav>

      <div className="settings-content">
        {activeTab === "general" ? (
          <div id="general-settings" role="tabpanel">
            <section className="settings-section" data-testid="layout-settings">
              <h3 className="settings-section-title">Swatches</h3>
              <div className="setting-row">
                <span className="setting-label" id="swatch-sizing-label">
                  Sizing
                </span>
                <div className="segmented" role="radiogroup" aria-labelledby="swatch-sizing-label">
                  <label>
                    <input
                      checked={settings.layoutMode === "stretch"}
                      data-testid="layout-stretch"
                      name="layout-mode"
                      onChange={() => selectLayoutMode("stretch")}
                      type="radio"
                    />
                    <span>Stretch</span>
                  </label>
                  <label>
                    <input
                      checked={settings.layoutMode === "fixed"}
                      data-testid="layout-fixed"
                      name="layout-mode"
                      onChange={() => selectLayoutMode("fixed")}
                      type="radio"
                    />
                    <span>Fixed</span>
                  </label>
                </div>
              </div>

              <div className="setting-row" data-disabled={settings.layoutMode !== "fixed"}>
                <span className="setting-label">Size</span>
                <div className="size-controls">
                  <input
                    aria-label="Fixed color size"
                    data-testid="swatch-size-slider"
                    disabled={settings.layoutMode !== "fixed"}
                    max={MAX_SWATCH_SIZE}
                    min={MIN_SWATCH_SIZE}
                    onBlur={(event) => commitSwatchSize(Number(event.currentTarget.value))}
                    onChange={(event) => setDraftSize(Number(event.currentTarget.value))}
                    onKeyUp={(event) => commitSwatchSize(Number(event.currentTarget.value))}
                    onMouseUp={(event) => commitSwatchSize(Number(event.currentTarget.value))}
                    step="1"
                    type="range"
                    value={draftSize}
                  />
                  <span className="number-control">
                    <input
                      aria-label="Fixed color size in pixels"
                      data-testid="swatch-size-input"
                      disabled={settings.layoutMode !== "fixed"}
                      max={MAX_SWATCH_SIZE}
                      min={MIN_SWATCH_SIZE}
                      onBlur={(event) => commitSwatchSize(Number(event.currentTarget.value))}
                      onChange={(event) => setDraftSize(Number(event.currentTarget.value))}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                      }}
                      step="1"
                      type="number"
                      value={draftSize}
                    />
                    <span>px</span>
                  </span>
                </div>
              </div>
            </section>

            <section className="settings-section">
              <h3 className="settings-section-title">Collection</h3>
              <div className="setting-row">
                <span className="setting-label" id="gradient-collection-label">
                  Selected gradients
                </span>
                <div
                  className="segmented"
                  role="radiogroup"
                  aria-labelledby="gradient-collection-label"
                >
                  {(["color-stops", "gradient-slot"] as GradientCollectionMode[]).map((mode) => (
                    <label key={mode}>
                      <input
                        checked={settings.gradientCollectionMode === mode}
                        data-testid={`gradient-collection-${mode}`}
                        name="gradient-collection-mode"
                        onChange={() => commitSettings({ gradientCollectionMode: mode })}
                        type="radio"
                      />
                      <span>{GRADIENT_COLLECTION_LABELS[mode]}</span>
                    </label>
                  ))}
                </div>
              </div>
              <label className="checkbox-setting">
                <input
                  checked={settings.includeDisabledColors}
                  data-testid="include-disabled-colors"
                  onChange={(event) =>
                    commitSettings({ includeDisabledColors: event.currentTarget.checked })
                  }
                  type="checkbox"
                />
                <span>Include disabled layers and groups</span>
              </label>
            </section>

            <section className="settings-section" data-testid="image-extraction-settings">
              <h3 className="settings-section-title">Image extraction</h3>
              <div
                className="segmented segmented-three"
                role="radiogroup"
                aria-label="Image extraction method"
              >
                {(["balanced", "tonal", "contrast"] as ExtractionPreset[]).map((preset) => (
                  <label key={preset}>
                    <input
                      checked={settings.extractionPreset === preset}
                      data-testid={`extraction-${preset}`}
                      name="extraction-preset"
                      onChange={() => selectExtractionPreset(preset)}
                      type="radio"
                    />
                    <span>{EXTRACTION_PRESET_LABELS[preset]}</span>
                  </label>
                ))}
              </div>
              <span className="settings-help">
                Tonal merges nearby shades; Contrast favors separation.
              </span>
            </section>
          </div>
        ) : (
          <section className="palette-manager" id="palette-settings" role="tabpanel">
            <div className="palette-picker-row">
              <span className="palette-select-wrap">
                <select
                  aria-label="Active palette"
                  data-testid="palette-select"
                  disabled={paletteBusy || paletteError !== null}
                  onChange={(event) => {
                    const paletteId = event.currentTarget.value;
                    if (paletteId !== activePalette.id) {
                      sendPaletteCommand({ type: "select", paletteId });
                    }
                  }}
                  value={activePalette.id}
                >
                  {paletteDocument.palettes.map((palette) => (
                    <option key={palette.id} value={palette.id}>
                      {palette.name}
                    </option>
                  ))}
                </select>
              </span>
              <button
                aria-label="New palette"
                className="icon-action"
                data-testid="palette-create"
                disabled={paletteBusy || paletteError !== null}
                onClick={() => sendPaletteCommand({ type: "create" })}
                title="New palette"
                type="button"
              >
                <svg aria-hidden="true" height="9" viewBox="0 0 9 9" width="9">
                  <path d="M4 0h1v9H4z M0 4h9v1H0z" fill="currentColor" />
                </svg>
              </button>
              <button
                aria-label="Import palette"
                className="icon-action"
                data-testid="palette-import"
                disabled={paletteBusy || paletteError !== null || paletteLimitReached}
                onClick={importPaletteFromFile}
                title="Import palette"
                type="button"
              >
                <svg aria-hidden="true" height="11" viewBox="0 0 11 11" width="11">
                  <path
                    d="M5 0h1v3.5h2L5.5 7 3 3.5h2V0z M1 7h1v3h7V7h1v4H1V7z"
                    fill="currentColor"
                  />
                </svg>
              </button>
              <button
                aria-label="Export palette"
                className="icon-action"
                data-testid="palette-export"
                disabled={paletteBusy || paletteError !== null}
                onClick={exportActivePalette}
                title="Export palette"
                type="button"
              >
                <svg aria-hidden="true" height="11" viewBox="0 0 11 11" width="11">
                  <path
                    d="M5.5 0 8 3.5H6V7H5V3.5H3L5.5 0z M1 7h1v3h7V7h1v4H1V7z"
                    fill="currentColor"
                  />
                </svg>
              </button>
              <button
                aria-controls="palette-delete-confirm-strip"
                aria-expanded={armedDeleteId === activePalette.id}
                aria-label="Delete palette"
                className="icon-action is-danger"
                data-armed={armedDeleteId === activePalette.id}
                data-testid="palette-delete"
                disabled={paletteDocument.palettes.length === 1 || paletteBusy}
                onClick={requestDeletePalette}
                title="Delete palette"
                type="button"
              >
                <svg aria-hidden="true" height="11" viewBox="0 0 10 11" width="10">
                  <path
                    d="M3.5 0h3v1H10v1H0V1h3.5V0zM1 3h8l-.5 8h-7L1 3zm2.3 1.5.2 5h.9l-.2-5h-.9zm2.5 0-.2 5h.9l.2-5h-.9z"
                    fill="currentColor"
                  />
                </svg>
              </button>
            </div>

            {armedDeleteId === activePalette.id ? (
              <div className="delete-confirm" id="palette-delete-confirm-strip">
                <span className="delete-confirm-text">Delete “{activePalette.name}”?</span>
                <button
                  className="delete-confirm-action"
                  data-testid="palette-delete-confirm"
                  disabled={paletteBusy}
                  onClick={confirmDeletePalette}
                  type="button"
                >
                  Delete
                </button>
                <button
                  className="delete-cancel-action"
                  data-testid="palette-delete-cancel"
                  onClick={() => setArmedDeleteId(null)}
                  type="button"
                >
                  Cancel
                </button>
              </div>
            ) : null}

            {activePalette.colors.length > 0 ? (
              <div className="palette-strip-preview" aria-hidden="true">
                {activePalette.colors.map((color) => (
                  <i key={color.id} style={{ background: paletteSwatchBackground(color) }} />
                ))}
              </div>
            ) : null}

            <label className="palette-name-setting">
              <span>Name</span>
              <input
                data-testid="palette-name"
                disabled={paletteBusy || paletteError !== null}
                maxLength={48}
                onBlur={commitPaletteName}
                onChange={(event) => setNameDraft(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                  if (event.key === "Escape") {
                    setNameDraft(activePalette.name);
                    event.currentTarget.blur();
                  }
                }}
                value={nameDraft}
              />
            </label>

            <div className="section-heading color-list-heading">
              <strong id="color-list-label">Slots</strong>
              <span className="color-list-actions">
                <small>{activePalette.colors.length}</small>
                <button
                  aria-label="Add color"
                  className="color-add"
                  data-testid="color-add"
                  disabled={
                    paletteBusy ||
                    paletteError !== null ||
                    activePalette.colors.length >= MAX_PALETTE_COLORS
                  }
                  onClick={addBlackColor}
                  title="Add color"
                  type="button"
                >
                  <svg aria-hidden="true" height="9" viewBox="0 0 9 9" width="9">
                    <path d="M4 0h1v9H4z M0 4h9v1H0z" fill="currentColor" />
                  </svg>
                </button>
              </span>
            </div>
            {activePalette.colors.length === 0 ? (
              <p className="palette-empty">Add a color here or collect colors and gradients from Main.</p>
            ) : (
              <div
                aria-labelledby="color-list-label"
                className="managed-color-list"
                role="list"
              >
                {activePalette.colors.map((color, index) => {
                  const gradient = isPaletteGradient(color);
                  const expanded = !gradient && expandedColorId === color.id;
                  const displayable = isDisplayRgba(color.rgba);
                  const dragClass =
                    colorDrag?.sourceId === color.id
                      ? " is-dragging"
                      : colorDrag?.targetId === color.id && colorDrag.edge
                      ? ` is-drop-${colorDrag.edge}`
                      : "";
                  return (
                    <div
                      className={`managed-color-row${expanded ? " is-expanded" : ""}${dragClass}`}
                      data-testid={`color-row-${color.id}`}
                      key={color.id}
                      role="listitem"
                    >
                      <div
                        className="managed-color-line"
                        onDragOver={(event) => handleRowDragOver(event, color.id)}
                        onDrop={(event) => handleRowDrop(event, color.id)}
                      >
                        <button
                          aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                          aria-label={`Reorder color ${index + 1} of ${
                            activePalette.colors.length
                          }`}
                          className="color-grip"
                          data-testid={`color-grip-${color.id}`}
                          disabled={paletteBusy}
                          draggable={!paletteBusy && paletteError === null}
                          onDragEnd={handleGripDragEnd}
                          onDragStart={(event) => handleGripDragStart(event, color)}
                          onKeyDown={(event) => handleGripKeyDown(event, color, index)}
                          title="Drag to reorder (Alt+Arrow keys)"
                          type="button"
                        >
                          <span aria-hidden="true" className="grip-glyph" />
                        </button>
                        <button
                          aria-controls={!gradient && expanded ? `color-editor-${color.id}` : undefined}
                          aria-expanded={gradient ? undefined : expanded}
                          className="color-summary"
                          data-testid={`color-summary-${color.id}`}
                          onClick={() => {
                            if (!gradient) toggleColorEditor(color.id);
                          }}
                          type="button"
                        >
                          <span
                            className="managed-color-swatch"
                            style={{ background: paletteSwatchBackground(color) }}
                          />
                          <span className="managed-color-name">
                            {gradient ? "Gradient" : "Color"} {index + 1}
                          </span>
                          <span className="managed-color-value">
                            {gradient
                              ? `${color.gradient.colorStops.length} stops`
                              : displayable
                                ? rgbaToHexDisplay(color.rgba)
                                : "HDR"}
                          </span>
                        </button>
                        <button
                          aria-label={`Remove color ${index + 1}`}
                          className="color-remove"
                          data-testid={`color-remove-${color.id}`}
                          disabled={paletteBusy}
                          onClick={() =>
                            sendPaletteCommand({
                              type: "remove-color",
                              paletteId: activePalette.id,
                              colorId: color.id,
                            })
                          }
                          type="button"
                        >
                          ×
                        </button>
                      </div>
                      {expanded && !gradient ? (
                        <div className="color-editor" id={`color-editor-${color.id}`}>
                          {renderColorEditor(color)}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}
      </div>

      <output
        className="settings-status"
        aria-live="polite"
        data-error={paletteError ? "true" : undefined}
      >
        {combinePaletteStatus(status, paletteError)}
      </output>
    </main>
  );
};
