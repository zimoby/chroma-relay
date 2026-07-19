import {
  exactNativeGradientParent,
  findExactNativeGradientPayload,
  isExactNativeGradientPayload,
} from "./native-gradient-target";
import {
  buildSelectionPropertyPath,
  compareSelectionPropertyPaths,
  isMaterialOptionsBranch,
  isSelectionBranchDisabled,
  resolveSelectionPropertyPath,
  resolveSelectedScopeRoots,
  selectionScopeKey,
  selectionTargetKey,
} from "./selection-scope";

type ColorApplyTarget = {
  layerId: number;
  layerIndex: number;
  propertyIndexPath: number[];
  matchNamePath: string[];
};

export type ApplyRgba = [number, number, number, number];

export type ColorApplyResult = {
  status:
    | "ok"
    | "invalid-color"
    | "no-project"
    | "no-active-comp"
    | "no-selected-layers"
    | "no-supported-colors";
  appliedCount: number;
  selectedPropertyCount: number;
  unsupportedGradientCount: number;
  unsupportedTextCount: number;
  preservedStateCount: number;
  skippedDisabledCount: number;
  failedCount: number;
  undoGroupOpened: boolean;
};

const includesKey = (keys: string[], candidate: string) => {
  for (let index = 0; index < keys.length; index += 1) {
    if (keys[index] === candidate) return true;
  }
  return false;
};

const resolveLayerByIdentity = (activeItem: any, target: ColorApplyTarget) => {
  try {
    const preferred = activeItem.layer(target.layerIndex);
    if (preferred && preferred.id === target.layerId) return preferred;
  } catch (_error) {}

  try {
    const layerCount =
      typeof activeItem.numLayers === "number"
        ? activeItem.numLayers
        : activeItem.selectedLayers?.length ?? 0;
    for (let index = 1; index <= layerCount; index += 1) {
      const candidate = activeItem.layer(index);
      if (candidate && candidate.id === target.layerId) return candidate;
    }
  } catch (_error) {}

  try {
    const selectedLayers = activeItem.selectedLayers;
    for (let index = 0; index < (selectedLayers?.length ?? 0); index += 1) {
      if (selectedLayers[index]?.id === target.layerId) return selectedLayers[index];
    }
  } catch (_error) {}
  return null;
};

const collectWritableColorProperties = (
  property: any,
  layer: any,
  targets: ColorApplyTarget[],
  targetKeys: string[],
  gradientKeys: string[],
  result: ColorApplyResult,
  visitedKeys: string[],
  includeDisabledColors: boolean,
  bypassDisabledFilter = false
) => {
  if (!property) return;
  if (!bypassDisabledFilter && !includeDisabledColors && isSelectionBranchDisabled(property)) {
    result.skippedDisabledCount += 1;
    return;
  }
  if (isMaterialOptionsBranch(property)) return;
  const visitedKey = selectionScopeKey(layer, property);
  if (!visitedKey) {
    result.failedCount += 1;
    return;
  }
  if (includesKey(visitedKeys, visitedKey)) return;
  visitedKeys.push(visitedKey);

  try {
    const nativeGradientParent = exactNativeGradientParent(property);
    if (nativeGradientParent) {
      const payload = findExactNativeGradientPayload(nativeGradientParent);
      const gradientKey = payload ? selectionTargetKey(layer, payload) : null;
      if (!gradientKey) {
        result.failedCount += 1;
        return;
      }
      if (includesKey(gradientKeys, gradientKey)) return;
      gradientKeys.push(gradientKey);
      result.selectedPropertyCount += 1;
      result.unsupportedGradientCount += 1;
      return;
    }

    if (property.propertyType !== PropertyType.PROPERTY) {
      for (let index = 1; index <= property.numProperties; index += 1) {
        collectWritableColorProperties(
          property.property(index),
          layer,
          targets,
          targetKeys,
          gradientKeys,
          result,
          visitedKeys,
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
    const path = buildSelectionPropertyPath(layer, property);
    const targetKey = selectionTargetKey(layer, property);
    if (!path || !targetKey) {
      result.failedCount += 1;
      return;
    }
    if (includesKey(targetKeys, targetKey)) return;
    targetKeys.push(targetKey);
    if (property.expressionEnabled || property.numKeys > 0) {
      result.preservedStateCount += 1;
      return;
    }
    targets.push({
      layerId: layer.id,
      layerIndex: layer.index,
      propertyIndexPath: path.propertyIndexPath,
      matchNamePath: path.matchNamePath,
    });
  } catch (_error) {
    result.failedCount += 1;
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

export const applyColorToSelectedProperties = (
  rgba: ApplyRgba,
  includeDisabledColors = false
): ColorApplyResult => {
  const result: ColorApplyResult = {
    status: "no-project",
    appliedCount: 0,
    selectedPropertyCount: 0,
    unsupportedGradientCount: 0,
    unsupportedTextCount: 0,
    preservedStateCount: 0,
    skippedDisabledCount: 0,
    failedCount: 0,
    undoGroupOpened: false,
  };

  if (
    !rgba ||
    rgba.length !== 4 ||
    typeof rgba[0] !== "number" ||
    typeof rgba[1] !== "number" ||
    typeof rgba[2] !== "number" ||
    typeof rgba[3] !== "number" ||
    !isFinite(rgba[0]) ||
    !isFinite(rgba[1]) ||
    !isFinite(rgba[2]) ||
    !isFinite(rgba[3])
  ) {
    result.status = "invalid-color";
    return result;
  }
  if (!app.project) return result;

  const activeItem = app.project.activeItem;
  if (!activeItem || !(activeItem instanceof CompItem)) {
    result.status = "no-active-comp";
    return result;
  }
  const selectedLayers = activeItem.selectedLayers;
  if (!selectedLayers || selectedLayers.length === 0) {
    result.status = "no-selected-layers";
    return result;
  }

  const targets: ColorApplyTarget[] = [];
  const targetKeys: string[] = [];
  const gradientKeys: string[] = [];
  const visitedKeys: string[] = [];
  const scopes = resolveSelectedScopeRoots(activeItem, isExactColorSelection);
  if (scopes.invalid) {
    result.failedCount += 1;
    result.status = "no-supported-colors";
    return result;
  }
  for (let rootIndex = 0; rootIndex < scopes.roots.length; rootIndex += 1) {
    const root = scopes.roots[rootIndex];
    collectWritableColorProperties(
      root.property,
      root.layer,
      targets,
      targetKeys,
      gradientKeys,
      result,
      visitedKeys,
      includeDisabledColors,
      root.exact
    );
  }

  targets.sort((left, right) => {
    if (left.layerIndex !== right.layerIndex) return left.layerIndex - right.layerIndex;
    return compareSelectionPropertyPaths(left, right);
  });

  if (targets.length === 0) {
    result.status = "no-supported-colors";
    return result;
  }

  app.beginUndoGroup("Apply Chroma Relay Color");
  result.undoGroupOpened = true;
  try {
    for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
      try {
        const descriptor = targets[targetIndex];
        const layer = resolveLayerByIdentity(activeItem, descriptor);
        if (!layer) {
          result.failedCount += 1;
          continue;
        }
        if (layer.locked === true) {
          result.preservedStateCount += 1;
          continue;
        }
        const target = resolveSelectionPropertyPath(layer, descriptor);
        if (
          !target ||
          target.propertyType !== PropertyType.PROPERTY ||
          target.propertyValueType !== PropertyValueType.COLOR
        ) {
          result.failedCount += 1;
          continue;
        }
        if (target.expressionEnabled || target.numKeys > 0) {
          result.preservedStateCount += 1;
          continue;
        }
        const currentValue = target.value;
        target.setValue(
          currentValue && currentValue.length === 3
            ? [rgba[0], rgba[1], rgba[2]]
            : [rgba[0], rgba[1], rgba[2], rgba[3]]
        );
        result.appliedCount += 1;
      } catch (_error) {
        result.failedCount += 1;
      }
    }
  } finally {
    app.endUndoGroup();
  }

  result.status = result.appliedCount > 0 ? "ok" : "no-supported-colors";
  return result;
};
