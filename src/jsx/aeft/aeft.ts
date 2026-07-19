import {
  buildExactNativeGradientPropertyPath,
  buildNativeGradientTargetKey,
  collectSelectedNativeGradientTargets,
  exactNativeGradientParent,
  findExactNativeGradientPayload,
  isExactNativeGradientPayload,
} from "./native-gradient-target";
import type { NativeGradientTargetDescriptor } from "./native-gradient-target";
import {
  buildSelectionPropertyPath,
  compareSelectionPropertyPaths,
  isMaterialOptionsBranch,
  isSelectionBranchDisabled,
  resolveSelectedScopeRoots,
  selectionScopeKey,
} from "./selection-scope";

export { applyColorToSelectedProperties } from "./color-apply";
export { applyNativeGradientPresetToSelectedTarget } from "./native-gradient-apply";
export { collectSelectedNativeGradientTargets } from "./native-gradient-target";
export type {
  NativeGradientApplyRequest,
  NativeGradientApplyResult,
} from "./native-gradient-apply";
export type { NativeGradientKind, NativeGradientTargetDescriptor } from "./native-gradient-target";

export type HostRgba = [number, number, number, number];

export type ColorCollectionStatus =
  | "ok"
  | "no-project"
  | "no-active-comp"
  | "no-selected-layers"
  | "no-supported-colors";

export type ColorCollectionResult = {
  status: ColorCollectionStatus;
  colors: HostRgba[];
  entries: ColorCollectionEntry[];
  selectedPropertyCount: number;
  unsupportedGradientCount: number;
  unsupportedTextCount: number;
  readErrorCount: number;
};

export type ColorCollectionEntry =
  | { type: "solid"; colorIndex: number }
  | { type: "native-gradient"; gradientIndex: number; targetKey: string };

type OrderedColorCollectionEntry = {
  entry: ColorCollectionEntry;
  layerIndex: number;
  propertyIndexPath: number[];
  matchNamePath: string[];
};

export type NativeGradientSelectionResult =
  | { status: "none"; descriptors: [] }
  | { status: "ok"; descriptors: NativeGradientTargetDescriptor[] }
  | { status: "invalid"; descriptors: [] };

export type ImageSelectionStatus = "ok" | "none" | "multiple-images" | "unsupported-image";

export type ImageSelectionResult = {
  status: ImageSelectionStatus;
  path: string | null;
  name: string | null;
  format: string | null;
  selectedImageCount: number;
};

export type PaletteAddSelectionResult = {
  colors: ColorCollectionResult;
  image: ImageSelectionResult;
  nativeGradients: NativeGradientSelectionResult;
};

const emptyCollection = (status: ColorCollectionStatus): ColorCollectionResult => ({
  status,
  colors: [],
  entries: [],
  selectedPropertyCount: 0,
  unsupportedGradientCount: 0,
  unsupportedTextCount: 0,
  readErrorCount: 0,
});

const includesKey = (keys: string[], candidate: string) => {
  for (let index = 0; index < keys.length; index += 1) {
    if (keys[index] === candidate) return true;
  }
  return false;
};

const isSameColor = (left: HostRgba, right: HostRgba) => {
  for (let index = 0; index < 4; index += 1) {
    if (Math.abs(left[index] - right[index]) > 0.000001) return false;
  }
  return true;
};

const appendUniqueColor = (colors: HostRgba[], rgba: HostRgba) => {
  for (let index = 0; index < colors.length; index += 1) {
    if (isSameColor(colors[index], rgba)) return -1;
  }
  colors.push(rgba);
  return colors.length - 1;
};

const readColorProperty = (
  property: any,
  result: ColorCollectionResult,
  visitedKeys: string[],
  gradientKeys: string[],
  orderedEntries: OrderedColorCollectionEntry[],
  compId: number,
  layer: any,
  includeDisabledColors: boolean,
  bypassDisabledFilter = false
) => {
  if (!property) return;
  if (!bypassDisabledFilter && !includeDisabledColors && isSelectionBranchDisabled(property)) return;
  if (isMaterialOptionsBranch(property)) return;

  try {
    const visitedKey = selectionScopeKey(layer, property);
    if (!visitedKey) {
      result.readErrorCount += 1;
      return;
    }
    if (includesKey(visitedKeys, visitedKey)) return;
    visitedKeys.push(visitedKey);

    const nativeGradientParent = exactNativeGradientParent(property);
    if (nativeGradientParent) {
      const payload = findExactNativeGradientPayload(nativeGradientParent);
      const path = payload ? buildExactNativeGradientPropertyPath(layer, payload) : null;
      const gradientKey = payload ? buildNativeGradientTargetKey(compId, layer, payload) : null;
      if (!path || !gradientKey) {
        result.readErrorCount += 1;
        return;
      }
      if (includesKey(gradientKeys, gradientKey)) return;
      gradientKeys.push(gradientKey);
      result.selectedPropertyCount += 1;
      orderedEntries.push({
        entry: {
          type: "native-gradient",
          gradientIndex: result.unsupportedGradientCount,
          targetKey: gradientKey,
        },
        layerIndex: layer.index,
        propertyIndexPath: path.propertyIndexPath,
        matchNamePath: path.matchNamePath,
      });
      result.unsupportedGradientCount += 1;
      return;
    }

    if (property.propertyType !== PropertyType.PROPERTY) {
      for (let index = 1; index <= property.numProperties; index += 1) {
        readColorProperty(
          property.property(index),
          result,
          visitedKeys,
          gradientKeys,
          orderedEntries,
          compId,
          layer,
          includeDisabledColors,
          false
        );
      }
      return;
    }

    result.selectedPropertyCount += 1;
    if (property.propertyValueType === PropertyValueType.TEXT_DOCUMENT) {
      result.unsupportedTextCount += 1;
      return;
    }
    if (property.propertyValueType !== PropertyValueType.COLOR) return;

    const value = property.value;
    if (!value || (value.length !== 3 && value.length !== 4)) {
      result.readErrorCount += 1;
      return;
    }
    const rgba: HostRgba = [value[0], value[1], value[2], value.length === 4 ? value[3] : 1];
    for (let index = 0; index < rgba.length; index += 1) {
      if (typeof rgba[index] !== "number" || !isFinite(rgba[index])) {
        result.readErrorCount += 1;
        return;
      }
    }
    const path = buildSelectionPropertyPath(layer, property);
    if (!path) {
      result.readErrorCount += 1;
      return;
    }
    const colorIndex = appendUniqueColor(result.colors, rgba);
    if (colorIndex >= 0) {
      orderedEntries.push({
        entry: { type: "solid", colorIndex },
        layerIndex: layer.index,
        propertyIndexPath: path.propertyIndexPath,
        matchNamePath: path.matchNamePath,
      });
    }
  } catch (_error) {
    result.readErrorCount += 1;
  }
};

const isExactColorSelection = (property: any) => {
  if (isExactNativeGradientPayload(property)) return true;
  try {
    return (
      property.propertyType === PropertyType.PROPERTY &&
      property.propertyValueType === PropertyValueType.COLOR
    );
  } catch (_error) {
    return false;
  }
};

const selectedLayerHasStillImageSource = (layer: any) => {
  try {
    const source = layer.source;
    return (
      !!source &&
      source instanceof FootageItem &&
      !!source.mainSource &&
      source.mainSource.isStill === true
    );
  } catch (_error) {
    return false;
  }
};

export const collectSelectedColors = (
  includeDisabledColors: boolean,
  skipWholeStillImageLayers = false
): ColorCollectionResult => {
  if (!app.project) return emptyCollection("no-project");
  const activeItem = app.project.activeItem;
  if (!activeItem || !(activeItem instanceof CompItem)) {
    return emptyCollection("no-active-comp");
  }

  const selectedLayers = activeItem.selectedLayers;
  if (!selectedLayers || selectedLayers.length === 0) {
    return emptyCollection("no-selected-layers");
  }

  const result = emptyCollection("no-supported-colors");
  const visitedKeys: string[] = [];
  const gradientKeys: string[] = [];
  const orderedEntries: OrderedColorCollectionEntry[] = [];
  const scopes = resolveSelectedScopeRoots(activeItem, isExactColorSelection);
  if (scopes.invalid) {
    result.readErrorCount += 1;
    return result;
  }
  for (let rootIndex = 0; rootIndex < scopes.roots.length; rootIndex += 1) {
    const root = scopes.roots[rootIndex];
    if (
      root.wholeLayer &&
      skipWholeStillImageLayers &&
      selectedLayerHasStillImageSource(root.layer)
    ) {
      continue;
    }
    readColorProperty(
      root.property,
      result,
      visitedKeys,
      gradientKeys,
      orderedEntries,
      activeItem.id,
      root.layer,
      includeDisabledColors,
      root.exact
    );
  }
  orderedEntries.sort((left, right) => {
    if (left.layerIndex !== right.layerIndex) return left.layerIndex - right.layerIndex;
    return compareSelectionPropertyPaths(left, right);
  });
  const canonicalColors: HostRgba[] = [];
  let canonicalGradientIndex = 0;
  for (let index = 0; index < orderedEntries.length; index += 1) {
    const entry = orderedEntries[index].entry;
    if (entry.type === "native-gradient") {
      result.entries.push({
        type: "native-gradient",
        gradientIndex: canonicalGradientIndex,
        targetKey: entry.targetKey,
      });
      canonicalGradientIndex += 1;
    } else {
      const rgba = result.colors[entry.colorIndex];
      const colorIndex = rgba ? appendUniqueColor(canonicalColors, rgba) : -1;
      if (colorIndex >= 0) result.entries.push({ type: "solid", colorIndex });
    }
  }
  result.colors = canonicalColors;
  if (result.colors.length > 0 || result.unsupportedGradientCount > 0) result.status = "ok";
  return result;
};

type ImageCandidate = {
  key: string;
  path: string | null;
  name: string;
  format: string | null;
  supported: boolean;
};

const imageExtension = (fileName: string) => {
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex >= 0 ? fileName.substring(dotIndex + 1).toLowerCase() : "";
};

const appendImageCandidate = (candidates: ImageCandidate[], item: any) => {
  if (!item || !(item instanceof FootageItem)) return;
  try {
    if (!item.mainSource || item.mainSource.isStill !== true) return;
    const file = item.file;
    const filePath = file ? file.fsName : null;
    const format = file ? imageExtension(file.name) : null;
    const key = filePath || `missing:${item.id}`;
    for (let index = 0; index < candidates.length; index += 1) {
      if (candidates[index].key === key) return;
    }
    candidates.push({
      key,
      path: filePath,
      name: String(item.name || (file ? file.name : "Selected image")),
      format,
      supported:
        !!file && file.exists === true && (format === "jpg" || format === "jpeg" || format === "png"),
    });
  } catch (_error) {}
};

export const resolveSelectedImage = (): ImageSelectionResult => {
  const empty: ImageSelectionResult = {
    status: "none",
    path: null,
    name: null,
    format: null,
    selectedImageCount: 0,
  };
  if (!app.project) return empty;

  const candidates: ImageCandidate[] = [];
  const projectSelection = app.project.selection;
  for (let index = 0; index < projectSelection.length; index += 1) {
    appendImageCandidate(candidates, projectSelection[index]);
  }

  const activeItem = app.project.activeItem;
  if (activeItem && activeItem instanceof CompItem) {
    const selectedLayers = activeItem.selectedLayers;
    for (let index = 0; index < selectedLayers.length; index += 1) {
      try {
        appendImageCandidate(candidates, (selectedLayers[index] as any).source);
      } catch (_error) {}
    }
  }

  if (candidates.length === 0) return empty;
  if (candidates.length > 1) {
    return {
      status: "multiple-images",
      path: null,
      name: null,
      format: null,
      selectedImageCount: candidates.length,
    };
  }

  const candidate = candidates[0];
  if (!candidate.supported || !candidate.path) {
    return {
      status: "unsupported-image",
      path: null,
      name: candidate.name,
      format: candidate.format,
      selectedImageCount: 1,
    };
  }
  return {
    status: "ok",
    path: candidate.path,
    name: candidate.name,
    format: candidate.format,
    selectedImageCount: 1,
  };
};

export const resolvePaletteAddSelection = (
  includeDisabledColors: boolean
): PaletteAddSelectionResult => {
  const colors = collectSelectedColors(includeDisabledColors, true);
  const descriptors =
    colors.unsupportedGradientCount > 0
      ? collectSelectedNativeGradientTargets(includeDisabledColors)
      : [];
  let descriptorsMatchEntries = descriptors.length === colors.unsupportedGradientCount;
  let descriptorIndex = 0;
  for (let entryIndex = 0; entryIndex < colors.entries.length; entryIndex += 1) {
    const entry = colors.entries[entryIndex];
    if (entry.type !== "native-gradient") continue;
    if (
      descriptorIndex >= descriptors.length ||
      descriptors[descriptorIndex].targetKey !== entry.targetKey
    ) {
      descriptorsMatchEntries = false;
      break;
    }
    descriptorIndex += 1;
  }
  if (descriptorIndex !== descriptors.length) descriptorsMatchEntries = false;
  const nativeGradients: NativeGradientSelectionResult =
    colors.unsupportedGradientCount === 0
      ? { status: "none", descriptors: [] }
      : descriptorsMatchEntries
        ? { status: "ok", descriptors }
        : { status: "invalid", descriptors: [] };
  return {
    colors,
    image: resolveSelectedImage(),
    nativeGradients,
  };
};


