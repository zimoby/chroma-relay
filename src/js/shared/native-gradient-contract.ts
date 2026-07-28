export type NativeGradientApplyStatus =
  | "ok"
  | "unsupported-host-version"
  | "host-version-drift"
  | "unsupported-platform"
  | "invalid-request"
  | "invalid-preset"
  | "no-project"
  | "no-active-comp"
  | "no-selected-gradient"
  | "ambiguous-selected-gradient"
  | "unsupported-selected-gradient"
  | "target-drift"
  | "selection-snapshot-failed"
  | "undo-open-failed"
  | "selection-mutation-failed"
  | "apply-unknown-completion"
  | "selection-restore-failed"
  | "undo-close-failed"
  | "finalization-failed";

export type NativeGradientTemplateFamily = "ae22-6" | "ae25-6" | "ae26-3";
export type NativeGradientPlatform = "darwin" | "win32";

export const MAX_NATIVE_GRADIENT_TARGET_COUNT = 64;
export const MAX_NATIVE_GRADIENT_DESCRIPTOR_PATH_DEPTH = 64;
export const MAX_NATIVE_GRADIENT_MATCH_NAME_LENGTH = 256;
export const MAX_NATIVE_GRADIENT_DIAGNOSTIC_COUNT = 16;
export const MAX_NATIVE_GRADIENT_DIAGNOSTIC_LENGTH = 512;

export const boundNativeGradientDiagnostic = (value: unknown): string => {
  let text = "";
  try {
    text = String(value === undefined || value === null ? "" : value);
  } catch (_error) {
    text = "";
  }
  return text.slice(0, MAX_NATIVE_GRADIENT_DIAGNOSTIC_LENGTH);
};

export const boundNativeGradientDiagnostics = (values: readonly unknown[]): string[] => {
  const bounded: string[] = [];
  for (let index = 0; index < values.length && index < MAX_NATIVE_GRADIENT_DIAGNOSTIC_COUNT; index += 1) {
    bounded.push(boundNativeGradientDiagnostic(values[index]));
  }
  return bounded;
};

const HOST_PRODUCT_VERSION_PATTERN = /^\d+\.\d+(?:\.\d+)?$/;

export const normalizeNativeGradientHostVersion = (hostVersion: unknown): string | null => {
  if (typeof hostVersion !== "string") return null;
  const normalized = hostVersion.replace(/x\d+$/, "");
  return HOST_PRODUCT_VERSION_PATTERN.test(normalized) ? normalized : null;
};

export const resolveNativeGradientTemplateFamily = (
  hostVersion: string
): NativeGradientTemplateFamily | null => {
  const normalized = normalizeNativeGradientHostVersion(hostVersion);
  if (normalized === null) return null;
  const versionParts = normalized.split(".");
  const majorVersion = Number(versionParts[0]);
  const minorVersion = Number(versionParts[1]);
  if (majorVersion < 22 || majorVersion > 26) return null;
  if (majorVersion === 26 && minorVersion >= 3) return "ae26-3";
  if (majorVersion === 26 || (majorVersion === 25 && minorVersion >= 6)) return "ae25-6";
  return "ae22-6";
};

export type NativeGradientRuntimeDecision =
  | {
      supported: true;
      platform: NativeGradientPlatform;
      hostVersion: string;
      templateFamily: NativeGradientTemplateFamily;
    }
  | {
      supported: false;
      platform: string;
      hostVersion: string;
      reason: "unsupported-platform" | "unsupported-host-version";
      templateFamily: null;
    };

export type NativeGradientCollectionRuntimeDecision =
  | {
      supported: true;
      platform: NativeGradientPlatform;
      hostVersion: string;
    }
  | {
      supported: false;
      platform: string;
      hostVersion: string;
      reason: "unsupported-platform" | "unsupported-host-version";
    };

const isNativeGradientPlatform = (platform: string): platform is NativeGradientPlatform =>
  platform === "darwin" || platform === "win32";

export const resolveNativeGradientRuntime = (
  platform: unknown,
  hostVersion: unknown,
): NativeGradientRuntimeDecision => {
  const normalizedPlatform = typeof platform === "string" ? platform : "";
  const normalizedHostVersion = typeof hostVersion === "string" ? hostVersion : "";
  if (!isNativeGradientPlatform(normalizedPlatform)) {
    return {
      supported: false,
      platform: normalizedPlatform,
      hostVersion: normalizedHostVersion,
      reason: "unsupported-platform",
      templateFamily: null,
    };
  }
  const templateFamily = resolveNativeGradientTemplateFamily(normalizedHostVersion);
  if (!templateFamily) {
    return {
      supported: false,
      platform: normalizedPlatform,
      hostVersion: normalizedHostVersion,
      reason: "unsupported-host-version",
      templateFamily: null,
    };
  }
  return {
    supported: true,
    platform: normalizedPlatform,
    hostVersion: normalizedHostVersion,
    templateFamily,
  };
};

export const resolveNativeGradientCollectionRuntime = (
  platform: unknown,
  hostVersion: unknown,
): NativeGradientCollectionRuntimeDecision => {
  const normalizedPlatform = typeof platform === "string" ? platform : "";
  const sourceHostVersion = typeof hostVersion === "string" ? hostVersion : "";
  if (!isNativeGradientPlatform(normalizedPlatform)) {
    return {
      supported: false,
      platform: normalizedPlatform,
      hostVersion: sourceHostVersion,
      reason: "unsupported-platform",
    };
  }
  const normalizedHostVersion = normalizeNativeGradientHostVersion(sourceHostVersion);
  if (
    normalizedHostVersion === null ||
    resolveNativeGradientTemplateFamily(normalizedHostVersion) === null
  ) {
    return {
      supported: false,
      platform: normalizedPlatform,
      hostVersion: sourceHostVersion,
      reason: "unsupported-host-version",
    };
  }
  return {
    supported: true,
    platform: normalizedPlatform,
    hostVersion: sourceHostVersion,
  };
};

export type NativeGradientCollectionDecision = Readonly<{
  allowed: boolean;
  parseNativeGradients: boolean;
  persistPalette: boolean;
  reason: "unsupported-platform" | "unsupported-host-version" | "invalid-selection" | null;
}>;

export const resolveNativeGradientCollectionDecision = (
  nativeSelectionStatus: "none" | "ok" | "invalid",
  nativeEntryCount: number,
  runtime: NativeGradientRuntimeDecision | NativeGradientCollectionRuntimeDecision,
  gradientEntryCount = nativeEntryCount,
): NativeGradientCollectionDecision => {
  const hasNativeEntries = nativeEntryCount > 0;
  const hasGradientEntries = gradientEntryCount > 0;
  if (nativeSelectionStatus === "invalid" && hasNativeEntries) {
    return {
      allowed: false,
      parseNativeGradients: false,
      persistPalette: false,
      reason: "invalid-selection",
    };
  }
  if (hasGradientEntries && !runtime.supported) {
    return {
      allowed: false,
      parseNativeGradients: false,
      persistPalette: false,
      reason: runtime.reason,
    };
  }
  return {
    allowed: true,
    parseNativeGradients: hasNativeEntries,
    persistPalette: true,
    reason: null,
  };
};

export type NativeGradientCollectionEntry =
  | Readonly<{ type: "solid"; colorIndex: number }>
  | Readonly<{ type: "implicit-gradient" }>
  | Readonly<{ type: "native-gradient"; gradientIndex: number }>;

export type NativeGradientCollectionExecutionResult<Gradient, Item, Document> = Readonly<{
  allowed: boolean;
  reason: NativeGradientCollectionDecision["reason"];
  parseNativeGradients: boolean;
  gradients: readonly Gradient[];
  sourceItems: readonly Item[];
  nextDocument: Document;
  paletteWritten: boolean;
}>;

export type NativeGradientCollectionOperations<Descriptor, Gradient, Item, Document> = Readonly<{
  nativeParser: (descriptors: readonly Descriptor[]) => readonly Gradient[];
  implicitGradient?: () => Gradient;
  nativeTemplateReader?: () => void;
  nativeLeaseCreator?: () => void;
  solidItem: (rgba: unknown) => Item;
  gradientItems: (gradient: Gradient) => readonly Item[];
  buildDocument: (items: readonly Item[]) => Document;
  writePalette: (document: Document) => void | Promise<void>;
}>;

export const orchestrateNativeGradientCollection = async <Descriptor, Gradient, Item, Document>(
  input: Readonly<{
    nativeSelectionStatus: "none" | "ok" | "invalid";
    nativeEntryCount: number;
    runtime: NativeGradientRuntimeDecision | NativeGradientCollectionRuntimeDecision;
    entries: readonly NativeGradientCollectionEntry[];
    colors: readonly unknown[];
    descriptors: readonly Descriptor[];
    baseDocument: Document;
  }>,
  operations: NativeGradientCollectionOperations<Descriptor, Gradient, Item, Document>,
): Promise<NativeGradientCollectionExecutionResult<Gradient, Item, Document>> => {
  let implicitEntryCount = 0;
  for (let index = 0; index < input.entries.length; index += 1) {
    if (input.entries[index].type === "implicit-gradient") implicitEntryCount += 1;
  }
  const decision = resolveNativeGradientCollectionDecision(
    input.nativeSelectionStatus,
    input.nativeEntryCount,
    input.runtime,
    input.nativeEntryCount + implicitEntryCount,
  );
  if (!decision.allowed) {
    return {
      allowed: false,
      reason: decision.reason,
      parseNativeGradients: false,
      gradients: [],
      sourceItems: [],
      nextDocument: input.baseDocument,
      paletteWritten: false,
    };
  }

  const gradients = decision.parseNativeGradients
    ? operations.nativeParser(input.descriptors)
    : [];
  const sourceItems: Item[] = [];
  for (let index = 0; index < input.entries.length; index += 1) {
    const entry = input.entries[index];
    if (entry.type === "solid") {
      const rgba = input.colors[entry.colorIndex];
      if (rgba === undefined) throw new Error("Solid color traversal index drifted");
      sourceItems.push(operations.solidItem(rgba));
      continue;
    }
    if (entry.type === "implicit-gradient") {
      if (!operations.implicitGradient) throw new Error("Implicit gradient materializer is unavailable");
      const implicitItems = operations.gradientItems(operations.implicitGradient());
      for (let itemIndex = 0; itemIndex < implicitItems.length; itemIndex += 1) {
        sourceItems.push(implicitItems[itemIndex]);
      }
      continue;
    }
    const gradient = gradients[entry.gradientIndex];
    if (gradient === undefined) throw new Error("Native gradient traversal index drifted");
    const gradientItems = operations.gradientItems(gradient);
    for (let itemIndex = 0; itemIndex < gradientItems.length; itemIndex += 1) {
      sourceItems.push(gradientItems[itemIndex]);
    }
  }

  const nextDocument = operations.buildDocument(sourceItems);
  const paletteWritten = nextDocument !== input.baseDocument;
  if (paletteWritten) await operations.writePalette(nextDocument);
  return {
    allowed: true,
    reason: null,
    parseNativeGradients: decision.parseNativeGradients,
    gradients,
    sourceItems,
    nextDocument,
    paletteWritten,
  };
};

export type NativeGradientApplyTarget = {
  compId: number;
  layerId: number;
  layerIndex: number;
  kind: "fill" | "stroke";
  propertyIndexPath: number[];
  matchNamePath: string[];
};

export type NativeGradientApplyError = {
  name: string;
  message: string;
  line: number | null;
  number: number | null;
};

export type NativeGradientApplyResult = {
  schemaVersion: 1;
  status: NativeGradientApplyStatus;
  primaryStatus: NativeGradientApplyStatus;
  hostVersion: string;
  target: NativeGradientApplyTarget | null;
  targets: NativeGradientApplyTarget[];
  selectedTargetCount: number;
  selectedPropertyCount?: number;
  attemptedTargetCount: number;
  attemptedPropertyCount?: number;
  appliedTargetCount: number;
  appliedPropertyCount?: number;
  failedTargetIndex: number | null;
  failedPropertyIndex?: number | null;
  unknownCompletionTargetIndex: number | null;
  unknownCompletionPropertyIndex?: number | null;
  skippedDisabledCount: number;
  skippedDisabledBranchCount?: number;
  preservedStateCount: number;
  preservedPropertyCount?: number;
  mutationAttempted: boolean;
  applyCompleted: boolean;
  undoGroupOpened: boolean;
  undoGroupCloseAttempted: boolean;
  undoGroupClosed: boolean;
  selectionRestoreAttempted: boolean;
  selectionRestored: boolean;
  applyError: NativeGradientApplyError | null;
};
