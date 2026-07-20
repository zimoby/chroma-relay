import {
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { path } from "../lib/cep/node";
import { csi, evalTS } from "../lib/utils/bolt";
import { APPLY_ACTIVE_PALETTE_GRADIENT_EVENT } from "../lib/utils/init-cep";
import {
  BUILD_MARKER,
  type DebugColor,
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
  type LayoutSettings,
  listenForLayoutSettings,
  loadLayoutSettings,
} from "../shared/layout-settings";
import { extractPaletteFromImageFile } from "../shared/image-palette-file";
import {
  DEFAULT_PALETTE,
  type PaletteColor,
  type PaletteCollectionItem,
  type PaletteDocument,
  type PaletteDropEdge,
  addPaletteColorToPalette,
  addPaletteCollectionItems,
  clonePaletteDocument,
  createPalette,
  getActivePalette,
  getPaletteSolidColors,
  importPaletteItems,
  isPaletteDocument,
  isPaletteGradient,
  removePalette,
  removePaletteColor,
  removePaletteColorFromPalette,
  renamePalette,
  reorderPaletteColor,
  reorderPaletteColorInPalette,
  rgbaToCss,
  selectPalette,
  updatePaletteColorInPalette,
} from "../shared/palette-domain";
import {
  collectNativeGradientsFromProject,
  nativeGradientToPaletteColors,
} from "../shared/native-gradient-collection";
import { nativeGradientToCssPreview } from "../shared/native-gradient-preview";
import {
  orchestrateNativeGradientCollection,
  resolveNativeGradientCollectionRuntime,
} from "../shared/native-gradient-contract";
import {
  type PaletteCommand,
  dispatchPaletteResult,
  listenForPaletteCommands,
} from "../shared/palette-events";
import {
  getPaletteWriteCount,
  loadPalette,
  resetPaletteWriteCount,
  savePalette,
} from "../shared/palette-storage";
import {
  applyActivePaletteNativeGradient,
  getNativeGradientTempBasePath,
  nativeGradientResultMessage,
} from "./native-gradient-files";
import "./main.scss";


const DESIGN_STATES = new Set<DesignPreviewState>([
  "default",
  "interaction",
  "empty",
  "disabled",
  "error",
]);
const STATUS_TIMEOUT_MS = 2500;

const getNativeGradientPlatform = () => {
  try {
    return window.cep_node.process.platform;
  } catch (_error) {
    return "";
  }
};

const paletteSwatchBackground = (
  color: PaletteColor,
  orientation: "horizontal" | "vertical"
) =>
  isPaletteGradient(color)
    ? nativeGradientToCssPreview(color.gradient, orientation === "vertical" ? 180 : 90)
    : rgbaToCss(color.rgba);

const isDebugColor = (value: unknown): value is DebugColor => {
  if (!value || typeof value !== "object") return false;
  const color = value as Partial<DebugColor>;
  return (
    typeof color.id === "string" &&
    /^[a-z0-9-]+$/.test(color.id) &&
    typeof color.css === "string" &&
    /^#[0-9a-f]{6}$/i.test(color.css)
  );
};

const debugCssToRgba = (css: string): [number, number, number, number] => [
  Number.parseInt(css.slice(1, 3), 16) / 255,
  Number.parseInt(css.slice(3, 5), 16) / 255,
  Number.parseInt(css.slice(5, 7), 16) / 255,
  1,
];

type PaletteDragState = {
  sourceId: string;
  targetId: string | null;
  edge: PaletteDropEdge | null;
  pointer: { x: number; y: number };
  size: { width: number; height: number };
  css: string;
};

const applyPaletteCommand = (
  document: PaletteDocument,
  command: PaletteCommand
): PaletteDocument => {
  switch (command.type) {
    case "create":
      return createPalette(document);
    case "select":
      return selectPalette(document, command.paletteId);
    case "rename":
      return renamePalette(document, command.paletteId, command.name);
    case "delete":
      return removePalette(document, command.paletteId);
    case "import-palette":
      return importPaletteItems(document, command.name, command.items);
    case "add-color":
      return addPaletteColorToPalette(document, command.paletteId);
    case "remove-color":
      return removePaletteColorFromPalette(document, command.paletteId, command.colorId);
    case "update-color":
      return updatePaletteColorInPalette(
        document,
        command.paletteId,
        command.colorId,
        command.rgba
      );
    case "reorder-color":
      return reorderPaletteColorInPalette(
        document,
        command.paletteId,
        command.sourceId,
        command.targetId,
        command.edge
      );
  }
};

const paletteCommandMessage = (command: PaletteCommand, ok: boolean) => {
  if (!ok) {
    const errors: Record<PaletteCommand["type"], string> = {
      create: "Palette limit reached",
      select: "Palette is already active or unavailable",
      rename: "Choose a non-empty, unique palette name",
      delete: "Keep at least one palette",
      "import-palette": "Palette import is unavailable or invalid",
      "add-color": "Palette is full or unavailable",
      "remove-color": "Color is unavailable",
      "update-color": "Color is unavailable or unchanged",
      "reorder-color": "Color order is unchanged",
    };
    return errors[command.type];
  }
  const messages: Record<PaletteCommand["type"], string> = {
    create: "Palette created",
    select: "Palette selected",
    rename: "Palette renamed",
    delete: "Palette deleted",
    "import-palette": "Palette imported",
    "add-color": "Color added",
    "remove-color": "Color removed",
    "update-color": "Color updated",
    "reorder-color": "Color reordered",
  };
  return messages[command.type];
};

export const App = () => {
  const panelRef = useRef<HTMLElement>(null);
  const [paletteDocument, setPaletteDocument] = useState<PaletteDocument>(() =>
    clonePaletteDocument(DEFAULT_PALETTE)
  );
  const activePalette = getActivePalette(paletteDocument);
  const activeColors = activePalette.colors;
  const [paletteError, setPaletteError] = useState<string | null>(null);
  const [fixture, setFixture] = useState<FixtureViewport | null>(null);
  const [configRoot, setConfigRoot] = useState<string | null>(null);
  const [layoutSettings, setLayoutSettings] = useState<LayoutSettings>(
    DEFAULT_LAYOUT_SETTINGS
  );
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<string | null>(null);
  const [pendingHostAction, setPendingHostAction] = useState<
    "collect" | "extract" | "apply" | "gradient" | null
  >(null);
  const [pendingPaletteMutation, setPendingPaletteMutation] = useState(false);
  const [dragState, setDragState] = useState<PaletteDragState | null>(null);
  const [removeMode, setRemoveMode] = useState(false);
  const [designState, setDesignState] = useState<DesignPreviewState>("default");
  const [activeOrientation, setActiveOrientation] = useState<"horizontal" | "vertical">(
    "horizontal"
  );
  const paletteWriteProtected = paletteError !== null;
  const countersRef = useRef({
    diskWrites: 0,
    emittedEvents: 0,
    receivedEvents: 0,
    hostCalls: 0,
  });
  const hostActionRef = useRef(false);
  const lastHostResultRef = useRef<unknown>(null);
  const paletteMutationRef = useRef(false);
  const paletteDocumentRef = useRef(paletteDocument);
  const paletteErrorRef = useRef(paletteError);
  const configRootRef = useRef(configRoot);
  const suppressApplyRef = useRef(false);
  const transparentDragImageRef = useRef<HTMLDivElement | null>(null);
  paletteDocumentRef.current = paletteDocument;
  paletteErrorRef.current = paletteError;
  configRootRef.current = configRoot;

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return undefined;

    const updateOrientation = (width: number, height: number) => {
      setActiveOrientation(width >= height ? "horizontal" : "vertical");
    };
    const initialRect = panel.getBoundingClientRect();
    updateOrientation(initialRect.width, initialRect.height);

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) updateOrientation(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === "Alt" &&
        pendingHostAction === null &&
        !pendingPaletteMutation &&
        !paletteWriteProtected
      ) {
        setRemoveMode(true);
      }
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Alt") setRemoveMode(false);
    };
    const clearRemoveMode = () => setRemoveMode(false);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", clearRemoveMode);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", clearRemoveMode);
    };
  }, [paletteWriteProtected, pendingHostAction, pendingPaletteMutation]);

  useEffect(() => {
    if (dragState || pendingHostAction !== null || pendingPaletteMutation || paletteWriteProtected) {
      setRemoveMode(false);
    }
  }, [dragState, paletteWriteProtected, pendingHostAction, pendingPaletteMutation]);

  useEffect(
    () => () => {
      transparentDragImageRef.current?.remove();
    },
    []
  );

  useEffect(() => {
    const applyIncomingSettings = (incoming: LayoutSettings) => {
      setLayoutSettings((current) => {
        if (incoming.revision <= current.revision) return current;
        countersRef.current.receivedEvents += 1;
        setSettingsError(null);
        return incoming;
      });
    };
    const stopListening = listenForLayoutSettings(applyIncomingSettings);
    const loaded = loadLayoutSettings(configRoot);
    setLayoutSettings(loaded.settings);
    setSettingsError(loaded.error);
    return stopListening;
  }, [configRoot]);

  useEffect(() => {
    const loaded = loadPalette(configRoot);
    paletteDocumentRef.current = loaded.document;
    paletteErrorRef.current = loaded.error;
    setPaletteDocument(loaded.document);
    setPaletteError(loaded.error);
    if (loaded.recovery !== "none") {
      setLastResult(`Recovered palette from ${loaded.recovery}`);
    }
  }, [configRoot]);

  useEffect(
    () =>
      listenForPaletteCommands((request) => {
        countersRef.current.receivedEvents += 1;
        const current = paletteDocumentRef.current;
        const respond = (
          ok: boolean,
          message: string,
          document: PaletteDocument = paletteDocumentRef.current
        ) => {
          dispatchPaletteResult({
            requestId: request.requestId,
            ok,
            message,
            document,
          });
          countersRef.current.emittedEvents += 1;
        };

        if (request.baseRevision !== current.revision) {
          respond(false, "Palette changed; try again", current);
          return;
        }
        if (paletteErrorRef.current) {
          respond(false, "Resolve the saved palette error first", current);
          return;
        }
        if (hostActionRef.current || paletteMutationRef.current) {
          respond(false, "Palette is busy; try again", current);
          return;
        }

        const next = applyPaletteCommand(current, request.command);
        if (next === current) {
          respond(false, paletteCommandMessage(request.command, false), current);
          return;
        }

        paletteMutationRef.current = true;
        setPendingPaletteMutation(true);
        void savePalette(next, configRootRef.current)
          .then(() => {
            paletteDocumentRef.current = next;
            paletteErrorRef.current = null;
            setPaletteDocument(next);
            setPaletteError(null);
            setLastResult(paletteCommandMessage(request.command, true));
            respond(true, paletteCommandMessage(request.command, true), next);
          })
          .catch(() => {
            respond(false, "Palette change could not be saved", current);
          })
          .finally(() => {
            paletteMutationRef.current = false;
            setPendingPaletteMutation(false);
          });
      }),
    []
  );

  useEffect(() => {
    if (!lastResult) return undefined;
    const timeout = window.setTimeout(() => setLastResult(null), STATUS_TIMEOUT_MS);
    return () => window.clearTimeout(timeout);
  }, [lastResult]);

  const handleAddSelectedColors = async () => {
    if (paletteWriteProtected || paletteErrorRef.current) {
      setLastResult("Resolve the saved palette error before adding colors");
      return;
    }
    if (hostActionRef.current || paletteMutationRef.current) {
      setLastResult("Palette is busy; try again");
      return;
    }
    hostActionRef.current = true;
    paletteMutationRef.current = true;
    setPendingPaletteMutation(true);
    const baseDocument = paletteDocumentRef.current;
    const baseActiveColors = getActivePalette(baseDocument).colors;
    setPendingHostAction("collect");
    setLastResult("Reading selection…");
    countersRef.current.hostCalls += 1;
    let phase: "selection" | "image" | "gradient" = "selection";
    try {
      const selection = await evalTS(
        "resolvePaletteAddSelection",
        layoutSettings.includeDisabledColors
      );
      lastHostResultRef.current = selection.colors;
      const hasColors = selection.colors.entries.length > 0;
      const hasSelectedImage = selection.image.selectedImageCount > 0;
      if (hasColors && hasSelectedImage) {
        setLastResult("Choose selected colors or one image, not both");
        return;
      }

      let sourceItems: PaletteCollectionItem[];
      let collectedDocument: PaletteDocument | null = null;
      let collectionPaletteWritten = false;
      let sourceName: string | null = null;
      let skipped = 0;
      if (selection.image.status === "ok" && selection.image.path) {
        phase = "image";
        setPendingHostAction("extract");
        setLastResult(`Extracting ${layoutSettings.extractionPreset} image palette…`);
        const extraction = await extractPaletteFromImageFile(
          selection.image.path,
          layoutSettings.extractionPreset
        );
        lastHostResultRef.current = { image: selection.image, extraction };
        sourceItems = extraction.colors.map((rgba) => ({
          type: "color",
          rgba,
          preserveDuplicate: false,
        }));
        sourceName = selection.image.name || "selected image";
      } else if (hasColors) {
        const nativeRuntime = resolveNativeGradientCollectionRuntime(
          getNativeGradientPlatform(),
          csi.hostEnvironment.appVersion,
        );
        const nativeEntryCount = selection.colors.entries.filter(
          (entry) => entry.type === "native-gradient",
        ).length;
        const collection = await orchestrateNativeGradientCollection<
          Parameters<typeof collectNativeGradientsFromProject>[0][number],
          ReturnType<typeof collectNativeGradientsFromProject>[number],
          PaletteCollectionItem,
          PaletteDocument
        >({
          nativeSelectionStatus: selection.nativeGradients.status,
          nativeEntryCount,
          runtime: nativeRuntime,
          entries: selection.colors.entries,
          colors: selection.colors.colors,
          descriptors: selection.nativeGradients.descriptors,
          baseDocument,
        }, {
          nativeParser: collectNativeGradientsFromProject,
          solidItem: (rgba) => ({
            type: "color",
            rgba: rgba as PaletteColor["rgba"],
            preserveDuplicate: false,
          }),
          gradientItems: (gradient): readonly PaletteCollectionItem[] =>
            layoutSettings.gradientCollectionMode === "gradient-slot"
              ? [{ type: "gradient", gradient }]
              : nativeGradientToPaletteColors(gradient).map((rgba) => ({
                  type: "color",
                  rgba,
                  preserveDuplicate: true,
                })),
          buildDocument: (items) => addPaletteCollectionItems(baseDocument, items),
          writePalette: (document) => savePalette(document, configRootRef.current),
        });
        if (!collection.allowed) {
          setLastResult(
            collection.reason === "invalid-selection"
              ? "Native gradients require a clean saved project and static unlocked targets"
              : collection.reason === "unsupported-platform"
              ? "Native gradients are unavailable on this platform"
              : "This After Effects version is not supported",
          );
          return;
        }
        phase = collection.parseNativeGradients ? "gradient" : "selection";
        collectedDocument = collection.nextDocument;
        collectionPaletteWritten = collection.paletteWritten;
        const gradients = collection.gradients;
        lastHostResultRef.current = { selection, gradients };
        sourceItems = [...collection.sourceItems];
        skipped = selection.colors.unsupportedTextCount;
      } else {
        if (selection.image.status === "multiple-images") {
          setLastResult("Select one image at a time");
          return;
        }
        if (selection.image.status === "unsupported-image") {
          const format = selection.image.format
            ? selection.image.format.toUpperCase()
            : "This image";
          setLastResult(`${format} is not supported; choose JPEG or PNG`);
          return;
        }
        const messages = {
          "no-project": "Open an After Effects project first",
          "no-active-comp": "Open a composition or select a JPEG/PNG in the Project panel",
          "no-selected-layers": "Select layers or a JPEG/PNG in the Project panel",
          "no-supported-colors": "No colors or supported image found in selection",
        } as const;
        const colorStatus = selection.colors.status;
        if (colorStatus === "ok") {
          setLastResult("Could not read the selection exactly");
          return;
        }
        setLastResult(messages[colorStatus]);
        return;
      }

      const next = collectedDocument ?? addPaletteCollectionItems(baseDocument, sourceItems);
      const nextActiveColors = getActivePalette(next).colors;
      const addedCount = nextActiveColors.length - baseActiveColors.length;
      const addedGradientCount =
        nextActiveColors.filter(isPaletteGradient).length -
        baseActiveColors.filter(isPaletteGradient).length;
      const addedColorCount = addedCount - addedGradientCount;
      const addedParts = [
        addedColorCount > 0
          ? `${addedColorCount} color${addedColorCount === 1 ? "" : "s"}`
          : null,
        addedGradientCount > 0
          ? `${addedGradientCount} gradient${addedGradientCount === 1 ? "" : "s"}`
          : null,
      ].filter((part): part is string => part !== null);
      const addedSummary = addedParts.join(" and ");
      if (next === baseDocument) {
        setLastResult(
          sourceName
            ? `Colors from ${sourceName} are already in the palette`
            : selection.nativeGradients.status === "ok"
              ? layoutSettings.gradientCollectionMode === "gradient-slot"
                ? "Palette does not have room for all selected items"
                : "Palette does not have room for all selected gradient stops"
            : "Selected colors are already in the palette"
        );
        return;
      }
      if (!collectionPaletteWritten) await savePalette(next, configRootRef.current);
      paletteDocumentRef.current = next;
      paletteErrorRef.current = null;
      setPaletteDocument(next);
      setPaletteError(null);
      dispatchPaletteResult({
        requestId: null,
        ok: true,
        message: "Palette updated",
        document: next,
      });
      countersRef.current.emittedEvents += 1;
      setLastResult(
        sourceName
          ? `Added ${addedSummary} from ${sourceName}`
          : skipped > 0
          ? `Added ${addedSummary}; skipped ${skipped} unsupported`
          : `Added ${addedSummary}`
      );
    } catch (_error) {
      setLastResult(
        phase === "image"
          ? "Could not extract colors from the selected image"
          : phase === "gradient"
            ? "Could not resolve the selected native gradient exactly"
            : "Could not read the selection"
      );
    } finally {
      hostActionRef.current = false;
      paletteMutationRef.current = false;
      setPendingPaletteMutation(false);
      setPendingHostAction(null);
    }
  };

  const handleApplyNativeGradient = useCallback(async (
    input:
      | { palette: readonly PaletteColor["rgba"][] }
      | { gradient: NonNullable<PaletteColor["gradient"]> },
    stopCount: number,
    pendingMessage: string
  ) => {
    if (hostActionRef.current || paletteMutationRef.current) return;
    if (paletteErrorRef.current) {
      setLastResult("Resolve the saved palette error before applying its gradient");
      return;
    }

    hostActionRef.current = true;
    paletteMutationRef.current = true;
    setPendingHostAction("gradient");
    setPendingPaletteMutation(true);
    setLastResult(pendingMessage);
    try {
      const document = paletteDocumentRef.current;
      const extensionRoot = csi.getSystemPath("extension");
      const hostVersion = csi.hostEnvironment.appVersion;
      const platform = getNativeGradientPlatform();
      const report = await applyActivePaletteNativeGradient(
        {
          ...input,
          tempBasePath: getNativeGradientTempBasePath(platform),
          templateRootPath: path.join(extensionRoot, "assets", "native-gradient"),
          hostVersion,
          platform,
          includeDisabledTargets: layoutSettings.includeDisabledColors,
        },
        async (request) => {
          countersRef.current.hostCalls += 1;
          return evalTS("applyNativeGradientPresetToSelectedTarget", request);
        }
      );
      const message = nativeGradientResultMessage(report, stopCount);
      lastHostResultRef.current = report;
      setLastResult(message);
      dispatchPaletteResult({
        requestId: null,
        ok: report.status === "ok",
        message,
        document,
      });
      countersRef.current.emittedEvents += 1;
    } catch (_error) {
      setLastResult("Could not start native gradient application");
    } finally {
      hostActionRef.current = false;
      paletteMutationRef.current = false;
      setPendingHostAction(null);
      setPendingPaletteMutation(false);
    }
  }, [layoutSettings.includeDisabledColors]);

  const handleApplyActivePaletteGradient = useCallback(async () => {
    const colors = getPaletteSolidColors(getActivePalette(paletteDocumentRef.current)).map(
      (color) => color.rgba
    );
    if (colors.length < 2 || colors.length > 8) {
      setLastResult("Active palette needs 2 to 8 color slots; click a gradient slot to apply it");
      return;
    }
    await handleApplyNativeGradient(
      { palette: colors },
      colors.length,
      "Applying active palette as gradient…"
    );
  }, [handleApplyNativeGradient]);

  const handleApplyStoredGradient = (gradient: NonNullable<PaletteColor["gradient"]>) =>
    handleApplyNativeGradient(
      { gradient },
      gradient.colorStops.length,
      "Applying saved gradient…"
    );

  useEffect(() => {
    const handleFlyoutAction = () => {
      void handleApplyActivePaletteGradient();
    };
    window.addEventListener(APPLY_ACTIVE_PALETTE_GRADIENT_EVENT, handleFlyoutAction);
    return () =>
      window.removeEventListener(APPLY_ACTIVE_PALETTE_GRADIENT_EVENT, handleFlyoutAction);
  }, [handleApplyActivePaletteGradient]);

  const handleApplyColor = async (rgba: PaletteColor["rgba"]) => {
    if (hostActionRef.current) return;
    hostActionRef.current = true;
    setPendingHostAction("apply");
    setLastResult("Applying selected color…");
    countersRef.current.hostCalls += 1;
    try {
      const result = await evalTS(
        "applyColorToSelectedProperties",
        rgba,
        layoutSettings.includeDisabledColors
      );
      lastHostResultRef.current = result;
      if (result.status !== "ok") {
        const messages = {
          "invalid-color": "This palette color is invalid",
          "no-project": "Open an After Effects project first",
          "no-active-comp": "Open a composition first",
          "no-selected-layers": "Select a layer and a color property",
          "no-supported-colors": "No writable static color properties selected",
        } as const;
        setLastResult(messages[result.status]);
        return;
      }

      const skipped =
        result.unsupportedGradientCount +
        result.unsupportedTextCount +
        result.preservedStateCount +
        result.skippedDisabledCount +
        result.failedCount;
      const propertyLabel = result.appliedCount === 1 ? "property" : "properties";
      setLastResult(
        skipped > 0
          ? `Applied to ${result.appliedCount} ${propertyLabel}; skipped ${skipped}`
          : `Applied to ${result.appliedCount} ${propertyLabel}`
      );
    } catch (_error) {
      setLastResult("Could not apply the selected color");
    } finally {
      hostActionRef.current = false;
      setPendingHostAction(null);
    }
  };

  const commitPaletteMutation = async (next: PaletteDocument, message: string) => {
    if (paletteWriteProtected) {
      setLastResult("Resolve the saved palette error before changing the palette");
      return false;
    }
    if (next === paletteDocument || paletteMutationRef.current) return false;
    paletteMutationRef.current = true;
    setPendingPaletteMutation(true);
    try {
      await savePalette(next, configRoot);
      paletteDocumentRef.current = next;
      paletteErrorRef.current = null;
      setPaletteDocument(next);
      setPaletteError(null);
      setLastResult(message);
      dispatchPaletteResult({ requestId: null, ok: true, message, document: next });
      countersRef.current.emittedEvents += 1;
      return true;
    } catch (_error) {
      setLastResult("Could not save the palette change");
      return false;
    } finally {
      paletteMutationRef.current = false;
      setPendingPaletteMutation(false);
    }
  };

  const handleRemoveColor = async (colorId: string) => {
    if (paletteMutationRef.current) return;
    const next = removePaletteColor(paletteDocument, colorId);
    const sourceIndex = activeColors.findIndex((color) => color.id === colorId);
    const focusId =
      activeColors[sourceIndex + 1]?.id ??
      activeColors[sourceIndex - 1]?.id ??
      null;
    const saved = await commitPaletteMutation(next, "Color removed");
    if (saved && focusId) {
      window.requestAnimationFrame(() => {
        document.querySelector<HTMLElement>(`[data-testid="swatch-${focusId}"]`)?.focus();
      });
    }
  };

  const handleReorderColor = async (
    sourceId: string,
    targetId: string,
    edge?: PaletteDropEdge
  ) => {
    const next = reorderPaletteColor(paletteDocument, sourceId, targetId, edge);
    await commitPaletteMutation(next, "Palette reordered");
  };

  const handleSwatchKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    colorId: string,
    index: number
  ) => {
    if (event.altKey && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      void handleRemoveColor(colorId);
      return;
    }
    if (!event.altKey) return;
    const backwards = event.key === "ArrowLeft" || event.key === "ArrowUp";
    const forwards = event.key === "ArrowRight" || event.key === "ArrowDown";
    if (!backwards && !forwards) return;
    const targetIndex = index + (backwards ? -1 : 1);
    const target = activeColors[targetIndex];
    if (!target) return;
    event.preventDefault();
    void handleReorderColor(colorId, target.id, backwards ? "before" : "after");
  };

  const handleDragStart = (
    event: ReactDragEvent<HTMLButtonElement>,
    color: PaletteColor
  ) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    let transparentDragImage = transparentDragImageRef.current;
    if (!transparentDragImage) {
      transparentDragImage = document.createElement("div");
      transparentDragImage.style.cssText =
        "position:fixed;left:-100px;top:-100px;width:1px;height:1px;opacity:0;pointer-events:none";
      document.body.appendChild(transparentDragImage);
      transparentDragImageRef.current = transparentDragImage;
    }
    suppressApplyRef.current = true;
    setRemoveMode(false);
    setDragState({
      sourceId: color.id,
      targetId: null,
      edge: null,
      pointer: {
        x: event.clientX || bounds.left + bounds.width / 2,
        y: event.clientY || bounds.top + bounds.height / 2,
      },
      size: { width: bounds.width, height: bounds.height },
      css: paletteSwatchBackground(color, activeOrientation),
    });
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", color.id);
    event.dataTransfer.setDragImage(transparentDragImage, 0, 0);
  };

  const handleDrag = (event: ReactDragEvent<HTMLButtonElement>) => {
    if (!event.clientX && !event.clientY) return;
    setDragState((current) =>
      current
        ? { ...current, pointer: { x: event.clientX, y: event.clientY } }
        : current
    );
  };

  const handleDragOver = (event: ReactDragEvent<HTMLButtonElement>, targetId: string) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const bounds = event.currentTarget.getBoundingClientRect();
    const edge: PaletteDropEdge =
      activeOrientation === "horizontal"
        ? event.clientX < bounds.left + bounds.width / 2
          ? "before"
          : "after"
        : event.clientY < bounds.top + bounds.height / 2
          ? "before"
          : "after";
    setDragState((current) => {
      if (!current) return current;
      if (current.sourceId === targetId) {
        return { ...current, targetId: null, edge: null };
      }
      return {
        ...current,
        targetId,
        edge,
        pointer:
          event.clientX || event.clientY
            ? { x: event.clientX, y: event.clientY }
            : current.pointer,
      };
    });
  };

  const handleDrop = (event: ReactDragEvent<HTMLButtonElement>, targetId: string) => {
    event.preventDefault();
    const sourceId = dragState?.sourceId || event.dataTransfer.getData("text/plain");
    const edge = dragState?.targetId === targetId ? dragState.edge : null;
    setDragState(null);
    if (sourceId && sourceId !== targetId && edge) {
      void handleReorderColor(sourceId, targetId, edge);
    }
  };

  const handleDragEnd = () => {
    setDragState(null);
    window.setTimeout(() => {
      suppressApplyRef.current = false;
    }, 0);
  };

  useEffect(() => {
    return installDebugApi({
      getIdentity: () => getPanelIdentity("main", configRoot),
      getState: () => ({
        paletteRevision: paletteDocument.revision,
        palette: activeColors.map((color) => ({
          id: color.id,
          rgba: [...color.rgba],
          css: rgbaToCss(color.rgba),
        })),
        activePalette: {
          id: activePalette.id,
          name: activePalette.name,
        },
        palettes: paletteDocument.palettes.map((palette) => ({
          id: palette.id,
          name: palette.name,
          colorCount: palette.colors.length,
        })),
        paletteError,
        settings: {
          available: true,
          ...layoutSettings,
          error: settingsError,
        },
        activeOrientation,
        pendingHostAction,
        pendingPaletteMutation,
        drag: dragState
          ? {
              sourceId: dragState.sourceId,
              targetId: dragState.targetId,
              edge: dragState.edge,
            }
          : null,
        removeMode,
        lastHostResult: lastHostResultRef.current,
        lastResult,
        fixtureViewport: fixture,
        designState,
      }),
      seedPalette: (colors) => {
        if (!Array.isArray(colors) || colors.length > 64 || !colors.every(isDebugColor)) {
          throw new Error("seedPalette expects up to 64 { id, css } debug colors");
        }
        const next = clonePaletteDocument(paletteDocument);
        getActivePalette(next).colors = colors.map((color) => ({
          id: color.id,
          rgba: debugCssToRgba(color.css),
        }));
        paletteDocumentRef.current = next;
        paletteErrorRef.current = null;
        setPaletteDocument(next);
        setPaletteError(null);
        return true;
      },
      persistPalette: async (colors) => {
        if (paletteWriteProtected) {
          throw new Error("Refusing to overwrite a palette with an unresolved load error");
        }
        const next = clonePaletteDocument(paletteDocument);
        next.revision += 1;
        getActivePalette(next).colors = colors.map((color) => ({
          id: color.id,
          rgba: [...color.rgba],
        }));
        if (!isPaletteDocument(next)) {
          throw new Error("persistPalette expects a valid exact-RGBA debug palette");
        }
        await savePalette(next, configRoot);
        paletteDocumentRef.current = next;
        paletteErrorRef.current = null;
        setPaletteDocument(next);
        setPaletteError(null);
        setLastResult("Palette saved");
        dispatchPaletteResult({
          requestId: null,
          ok: true,
          message: "Palette saved",
          document: next,
        });
        countersRef.current.emittedEvents += 1;
        return true;
      },
      reloadPalette: () => {
        const loaded = loadPalette(configRoot);
        paletteDocumentRef.current = loaded.document;
        paletteErrorRef.current = loaded.error;
        setPaletteDocument(loaded.document);
        setPaletteError(loaded.error);
        setLastResult(
          loaded.recovery === "none"
            ? "Palette reloaded"
            : `Recovered palette from ${loaded.recovery}`
        );
        return loaded;
      },
      setTemporaryConfigRoot: (root) => {
        const normalized = normalizeTemporaryConfigRoot(root);
        configRootRef.current = normalized;
        setConfigRoot(normalized);
        return normalized;
      },
      setFixtureViewport: (width, height) => {
        if (!isFixtureViewport(width, height)) return false;
        setFixture({ width, height });
        return true;
      },
      setDesignPreview: (state) => {
        if (!DESIGN_STATES.has(state)) return false;
        setDesignState(state);
        return true;
      },
      getGeometry: () => getTestGeometry("main"),
      getCounters: () => ({
        ...countersRef.current,
        diskWrites: getPaletteWriteCount(),
      }),
      dispatchClick: dispatchTestClick,
      resetTestState: () => {
        const defaultPalette = clonePaletteDocument(DEFAULT_PALETTE);
        paletteDocumentRef.current = defaultPalette;
        paletteErrorRef.current = null;
        setPaletteDocument(defaultPalette);
        setPaletteError(null);
        setFixture(null);
        configRootRef.current = null;
        setConfigRoot(null);
        setLayoutSettings(DEFAULT_LAYOUT_SETTINGS);
        setSettingsError(null);
        setLastResult(null);
        setPendingHostAction(null);
        setPendingPaletteMutation(false);
        setDragState(null);
        setRemoveMode(false);
        hostActionRef.current = false;
        lastHostResultRef.current = null;
        paletteMutationRef.current = false;
        suppressApplyRef.current = false;
        setDesignState("default");
        countersRef.current = {
          diskWrites: 0,
          emittedEvents: 0,
          receivedEvents: 0,
          hostCalls: 0,
        };
        resetPaletteWriteCount();
      },
      reload: () => window.location.reload(),
    });
  }, [
    activeOrientation,
    configRoot,
    designState,
    dragState,
    fixture,
    lastResult,
    layoutSettings,
    paletteDocument,
    paletteError,
    pendingHostAction,
    pendingPaletteMutation,
    removeMode,
    settingsError,
  ]);

  const fixtureStyle = fixture
    ? { width: fixture.width, height: fixture.height, minHeight: fixture.height }
    : undefined;
  const fixtureName = fixture ? `${fixture.width}x${fixture.height}` : "live";
  const panelStyle = {
    ...fixtureStyle,
    "--cp-swatch-size": `${layoutSettings.swatchSize}px`,
  } as CSSProperties;
  const visibleSwatches = designState === "empty" ? [] : activeColors;
  const statusMessage =
    designState === "error"
      ? "No supported colors selected"
      : designState === "empty"
        ? "Select colors, layers, or an image, then add"
        : paletteError
          ? paletteError
          : lastResult || "";

  return (
    <main
      className="chroma-relay-panel"
      data-design-state={designState}
      data-fixture={fixtureName}
      data-layout-mode={layoutSettings.layoutMode}
      data-orientation={activeOrientation}
      data-page="main"
      data-remove-mode={removeMode}
      onPointerMove={(event) => {
        if (
          pendingHostAction === null &&
          !pendingPaletteMutation &&
          !paletteWriteProtected &&
          !dragState
        ) {
          setRemoveMode(event.altKey);
        }
      }}
      ref={panelRef}
      style={panelStyle}
    >
      <span className="visually-hidden">Chroma Relay · {BUILD_MARKER}</span>

      <section className="palette-stage" aria-label="Color palette">
        <div className="palette-strip" data-testid="palette-strip">
          {visibleSwatches.length ? (
            visibleSwatches.map((swatch, index) => {
              const previewClass =
                designState === "interaction"
                  ? index === 0
                    ? " is-preview-hover"
                    : index === 1
                      ? " is-preview-focus"
                      : " is-preview-selected"
                  : "";
              const dragClass =
                dragState?.sourceId === swatch.id
                  ? " is-dragging"
                  : dragState?.targetId === swatch.id && dragState.edge
                    ? ` is-drop-${dragState.edge}`
                    : "";
              return (
                <span
                  className={`palette-swatch-shell${previewClass}${dragClass}`}
                  key={swatch.id}
                >
                  <button
                    aria-keyshortcuts="Alt+Enter Alt+Space"
                    aria-label={`${removeMode ? "Remove" : "Apply"} ${swatch.id} ${
                      isPaletteGradient(swatch) ? "gradient" : "color"
                    }`}
                    aria-pressed={designState === "interaction" && index === 2}
                    className="palette-swatch"
                    data-testid={`swatch-${swatch.id}`}
                    disabled={pendingHostAction !== null || pendingPaletteMutation}
                    draggable={
                      !paletteWriteProtected &&
                      !pendingPaletteMutation &&
                      pendingHostAction === null
                    }
                    onClick={(event) => {
                      if (suppressApplyRef.current) return;
                      if (event.altKey || removeMode) {
                        void handleRemoveColor(swatch.id);
                        return;
                      }
                      if (isPaletteGradient(swatch)) {
                        void handleApplyStoredGradient(swatch.gradient);
                      } else {
                        void handleApplyColor(swatch.rgba);
                      }
                    }}
                    onDrag={handleDrag}
                    onDragEnd={handleDragEnd}
                    onDragOver={(event) => handleDragOver(event, swatch.id)}
                    onDragStart={(event) => handleDragStart(event, swatch)}
                    onDrop={(event) => handleDrop(event, swatch.id)}
                    onKeyDown={(event) => handleSwatchKeyDown(event, swatch.id, index)}
                    style={{ background: paletteSwatchBackground(swatch, activeOrientation) }}
                    type="button"
                  >
                    <span aria-hidden="true" className="drag-indicator" />
                  </button>
                </span>
              );
            })
          ) : (
            <span className="palette-empty">Add a color or gradient</span>
          )}
        </div>
        <button
          aria-label="Add selected colors or extract a selected image"
          className="palette-add"
          data-testid="palette-add"
          disabled={
            paletteWriteProtected ||
            designState === "disabled" ||
            pendingHostAction !== null ||
            pendingPaletteMutation
          }
          onClick={handleAddSelectedColors}
          type="button"
        >
          <span aria-hidden="true" className="add-glyph" />
        </button>
      </section>

      {dragState ? (
        <span
          aria-hidden="true"
          className="palette-drag-preview"
          style={{
            background: dragState.css,
            height: dragState.size.height,
            left: dragState.pointer.x,
            top: dragState.pointer.y,
            width: dragState.size.width,
          }}
        />
      ) : null}

      <output
        className={`palette-status${
          designState === "error" || paletteError ? " is-error" : ""
        }`}
        data-testid="status-output"
      >
        {statusMessage}
      </output>
    </main>
  );
};
