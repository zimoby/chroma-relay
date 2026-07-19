import {
  buildExactNativeGradientPropertyPath,
  collectSelectedNativeGradientTargets,
  exactNativeGradientParent,
  findExactNativeGradientPayload,
} from "./native-gradient-target";
import type { NativeGradientTargetDescriptor } from "./native-gradient-target";

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
  | { type: "native-gradient"; gradientIndex: number };

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

const isVisited = (visited: any[], candidate: any) => {
  for (let index = 0; index < visited.length; index += 1) {
    if (visited[index] === candidate) return true;
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

const isDisabledBranch = (property: any) => {
  let current = property;
  while (current) {
    try {
      if (current.enabled === false) return true;
    } catch (_error) {}
    try {
      current = current.parentProperty;
    } catch (_error) {
      return false;
    }
  }
  return false;
};

const isMaterialOptionsBranch = (property: any) => {
  let current = property;
  while (current) {
    try {
      if (
        current.matchName === "ADBE Vector Materials Group" ||
        current.matchName === "ADBE Material Options Group"
      ) {
        return true;
      }
    } catch (_error) {}
    try {
      current = current.parentProperty;
    } catch (_error) {
      return false;
    }
  }
  return false;
};

const nativeGradientSelectionKey = (layer: any, parent: any) => {
  try {
    const payload = findExactNativeGradientPayload(parent);
    const path = payload ? buildExactNativeGradientPropertyPath(layer, payload) : null;
    if (
      !path ||
      typeof layer.id !== "number" ||
      !isFinite(layer.id) ||
      typeof layer.index !== "number" ||
      !isFinite(layer.index)
    ) {
      return null;
    }
    return layer.id + ":" + layer.index + ":" + path.propertyIndexPath.join(".");
  } catch (_error) {
    return null;
  }
};

const readColorProperty = (
  property: any,
  result: ColorCollectionResult,
  visited: any[],
  gradientKeys: string[],
  layer: any,
  includeDisabledColors: boolean
) => {
  if (!property || isVisited(visited, property)) return;
  if (!includeDisabledColors && isDisabledBranch(property)) return;
  if (isMaterialOptionsBranch(property)) return;

  try {
    const nativeGradientParent = exactNativeGradientParent(property);
    if (nativeGradientParent) {
      if (isVisited(visited, nativeGradientParent)) return;
      const gradientKey = nativeGradientSelectionKey(layer, nativeGradientParent);
      if (!gradientKey) {
        result.readErrorCount += 1;
        return;
      }
      for (let keyIndex = 0; keyIndex < gradientKeys.length; keyIndex += 1) {
        if (gradientKeys[keyIndex] === gradientKey) return;
      }
      gradientKeys.push(gradientKey);
      visited.push(nativeGradientParent);
      result.selectedPropertyCount += 1;
      result.entries.push({
        type: "native-gradient",
        gradientIndex: result.unsupportedGradientCount,
      });
      result.unsupportedGradientCount += 1;
      return;
    }

    visited.push(property);
    if (property.propertyType !== PropertyType.PROPERTY) {
      for (let index = 1; index <= property.numProperties; index += 1) {
        readColorProperty(
          property.property(index),
          result,
          visited,
          gradientKeys,
          layer,
          includeDisabledColors
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
    const colorIndex = appendUniqueColor(result.colors, rgba);
    if (colorIndex >= 0) result.entries.push({ type: "solid", colorIndex });
  } catch (_error) {
    result.readErrorCount += 1;
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
  const visited: any[] = [];
  const gradientKeys: string[] = [];
  for (let layerIndex = 0; layerIndex < selectedLayers.length; layerIndex += 1) {
    const selectedLayer = selectedLayers[layerIndex];
    const selectedProperties = selectedLayer.selectedProperties;
    if (selectedProperties.length > 0) {
      for (let propertyIndex = 0; propertyIndex < selectedProperties.length; propertyIndex += 1) {
        readColorProperty(
          selectedProperties[propertyIndex],
          result,
          visited,
          gradientKeys,
          selectedLayer,
          includeDisabledColors
        );
      }
    } else if (!skipWholeStillImageLayers || !selectedLayerHasStillImageSource(selectedLayer)) {
      readColorProperty(
        selectedLayer,
        result,
        visited,
        gradientKeys,
        selectedLayer,
        includeDisabledColors
      );
    }
  }
  if (result.colors.length > 0) result.status = "ok";
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
  const nativeGradients: NativeGradientSelectionResult =
    colors.unsupportedGradientCount === 0
      ? { status: "none", descriptors: [] }
      : descriptors.length === colors.unsupportedGradientCount
        ? { status: "ok", descriptors }
        : { status: "invalid", descriptors: [] };
  return {
    colors,
    image: resolveSelectedImage(),
    nativeGradients,
  };
};


