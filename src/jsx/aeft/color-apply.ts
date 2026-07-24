import {
  exactNativeGradientParent,
  findExactNativeGradientPayload,
  isExactNativeGradientPayload,
} from "./native-gradient-target";
import {
  addSelectionKey,
  buildSelectionTraversalRoot,
  compareSelectionPropertyPaths,
  createSelectionKeySet,
  hasSelectionKey,
  isMaterialOptionsProperty,
  isSelectionPropertyDisabled,
  isSelectionTraversalChildSlot,
  resolveParentScopeRoot,
  resolveSelectionPropertyPath,
  resolveSelectedScopeRoots,
  selectionTraversalContainsProperty,
  selectionTargetKey,
  selectionTargetKeyFromPath,
} from "./selection-scope";
import type { SelectionKeySet } from "./selection-scope";

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
  targetKeys: SelectionKeySet,
  gradientKeys: SelectionKeySet,
  result: ColorApplyResult,
  visitedKeys: SelectionKeySet,
  matchedKeys: SelectionKeySet,
  includeDisabledColors: boolean,
  ancestorProperties: any[],
  propertyIndexPath: number[],
  matchNamePath: string[],
  visitedKey: string,
  branchDisabled: boolean,
  materialOptions: boolean,
  bypassDisabledFilter = false
): boolean => {
  if (!property) return false;
  if (!bypassDisabledFilter && !includeDisabledColors && branchDisabled) {
    result.skippedDisabledCount += 1;
    return true;
  }
  if (materialOptions) return false;
  if (!addSelectionKey(visitedKeys, visitedKey)) {
    return hasSelectionKey(matchedKeys, visitedKey);
  }

  let matched = false;
  try {
    const nativeGradientParent = exactNativeGradientParent(property);
    if (nativeGradientParent) {
      const payload = findExactNativeGradientPayload(nativeGradientParent);
      const gradientKey = payload ? selectionTargetKey(layer, payload) : null;
      if (!gradientKey) {
        result.failedCount += 1;
        return false;
      }
      matched = true;
      addSelectionKey(matchedKeys, visitedKey);
      if (!addSelectionKey(gradientKeys, gradientKey)) return true;
      result.selectedPropertyCount += 1;
      result.unsupportedGradientCount += 1;
      return true;
    }

    if (property.propertyType !== PropertyType.PROPERTY) {
      const childCount = property.numProperties;
      for (let index = 1; index <= childCount; index += 1) {
        const child = property.property(index);
        if (!child) continue;
        if (
          !isSelectionTraversalChildSlot(layer, property, child, index, propertyIndexPath.length) ||
          selectionTraversalContainsProperty(ancestorProperties, child)
        ) {
          result.failedCount += 1;
          continue;
        }
        propertyIndexPath.push(index);
        matchNamePath.push(child.matchName);
        ancestorProperties.push(child);
        const childKey = selectionTargetKeyFromPath(layer, {
          propertyIndexPath,
          matchNamePath,
        });
        if (!childKey) {
          propertyIndexPath.pop();
          matchNamePath.pop();
          ancestorProperties.pop();
          result.failedCount += 1;
          continue;
        }
        try {
          if (collectWritableColorProperties(
            child,
            layer,
            targets,
            targetKeys,
            gradientKeys,
            result,
            visitedKeys,
            matchedKeys,
            includeDisabledColors,
            ancestorProperties,
            propertyIndexPath,
            matchNamePath,
            childKey,
            branchDisabled || isSelectionPropertyDisabled(child),
            materialOptions || isMaterialOptionsProperty(child),
            false
          )) {
            matched = true;
          }
        } finally {
          propertyIndexPath.pop();
          matchNamePath.pop();
          ancestorProperties.pop();
        }
      }
      if (matched) addSelectionKey(matchedKeys, visitedKey);
      return matched;
    }

    result.selectedPropertyCount += 1;
    if (property.propertyValueType === PropertyValueType.TEXT_DOCUMENT) {
      result.unsupportedTextCount += 1;
      return false;
    }
    if (property.propertyValueType !== PropertyValueType.COLOR) return false;
    matched = true;
    addSelectionKey(matchedKeys, visitedKey);
    if (!addSelectionKey(targetKeys, visitedKey)) return true;
    if (property.expressionEnabled || property.numKeys > 0) {
      result.preservedStateCount += 1;
      return true;
    }
    targets.push({
      layerId: layer.id,
      layerIndex: layer.index,
      propertyIndexPath: propertyIndexPath.slice(),
      matchNamePath: matchNamePath.slice(),
    });
    return true;
  } catch (_error) {
    result.failedCount += 1;
    if (matched) addSelectionKey(matchedKeys, visitedKey);
    return matched;
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
  includeDisabledColors = false,
  smartApply = true
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
  const targetKeys = createSelectionKeySet();
  const gradientKeys = createSelectionKeySet();
  const visitedKeys = createSelectionKeySet();
  const matchedKeys = createSelectionKeySet();
  const scopes = resolveSelectedScopeRoots(activeItem, isExactColorSelection);
  if (scopes.invalid) {
    result.failedCount += 1;
    result.status = "no-supported-colors";
    return result;
  }
  for (let rootIndex = 0; rootIndex < scopes.roots.length; rootIndex += 1) {
    const root = scopes.roots[rootIndex];
    let matched = false;
    const traversal = buildSelectionTraversalRoot(root);
    if (!traversal) {
      result.failedCount += 1;
    } else {
      matched = collectWritableColorProperties(
        root.property,
        root.layer,
        targets,
        targetKeys,
        gradientKeys,
        result,
        visitedKeys,
        matchedKeys,
        includeDisabledColors,
        [root.property],
        traversal.propertyIndexPath,
        traversal.matchNamePath,
        traversal.key,
        traversal.disabled,
        traversal.materialOptions,
        root.exact
      );
    }
    let parentRoot =
      smartApply && !matched
        ? resolveParentScopeRoot(root)
        : null;
    while (parentRoot && !matched) {
      const parentTraversal = buildSelectionTraversalRoot(parentRoot);
      if (!parentTraversal) {
        result.failedCount += 1;
      } else {
        matched = collectWritableColorProperties(
          parentRoot.property,
          parentRoot.layer,
          targets,
          targetKeys,
          gradientKeys,
          result,
          visitedKeys,
          matchedKeys,
          includeDisabledColors,
          [parentRoot.property],
          parentTraversal.propertyIndexPath,
          parentTraversal.matchNamePath,
          parentTraversal.key,
          parentTraversal.disabled,
          parentTraversal.materialOptions,
          false
        );
      }
      parentRoot = !matched ? resolveParentScopeRoot(parentRoot) : null;
    }
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
