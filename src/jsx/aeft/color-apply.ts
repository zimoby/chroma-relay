import { exactNativeGradientParent } from "./native-gradient-target";

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
  failedCount: number;
  undoGroupOpened: boolean;
};

const isVisited = (visited: any[], property: any) => {
  for (let index = 0; index < visited.length; index += 1) {
    if (visited[index] === property) return true;
  }
  return false;
};

const collectWritableColorProperties = (
  property: any,
  targets: any[],
  result: ColorApplyResult,
  visited: any[]
) => {
  if (!property || isVisited(visited, property)) return;
  visited.push(property);

  try {
    const nativeGradientParent = exactNativeGradientParent(property);
    if (nativeGradientParent) {
      if (nativeGradientParent !== property) {
        if (isVisited(visited, nativeGradientParent)) return;
        visited.push(nativeGradientParent);
      }
      result.selectedPropertyCount += 1;
      result.unsupportedGradientCount += 1;
      return;
    }

    if (property.propertyType !== PropertyType.PROPERTY) {
      for (let index = 1; index <= property.numProperties; index += 1) {
        collectWritableColorProperties(property.property(index), targets, result, visited);
      }
      return;
    }

    result.selectedPropertyCount += 1;
    if (property.propertyValueType === PropertyValueType.TEXT_DOCUMENT) {
      result.unsupportedTextCount += 1;
      return;
    }
    if (property.propertyValueType !== PropertyValueType.COLOR) return;
    if (property.expressionEnabled || property.numKeys > 0) {
      result.preservedStateCount += 1;
      return;
    }
    targets.push(property);
  } catch (_error) {
    result.failedCount += 1;
  }
};

export const applyColorToSelectedProperties = (rgba: ApplyRgba): ColorApplyResult => {
  const result: ColorApplyResult = {
    status: "no-project",
    appliedCount: 0,
    selectedPropertyCount: 0,
    unsupportedGradientCount: 0,
    unsupportedTextCount: 0,
    preservedStateCount: 0,
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

  const targets: any[] = [];
  const visited: any[] = [];
  for (let layerIndex = 0; layerIndex < selectedLayers.length; layerIndex += 1) {
    const selectedProperties = selectedLayers[layerIndex].selectedProperties;
    for (let propertyIndex = 0; propertyIndex < selectedProperties.length; propertyIndex += 1) {
      collectWritableColorProperties(
        selectedProperties[propertyIndex],
        targets,
        result,
        visited
      );
    }
  }

  if (targets.length === 0) {
    result.status = "no-supported-colors";
    return result;
  }

  app.beginUndoGroup("Apply Chroma Relay Color");
  result.undoGroupOpened = true;
  try {
    for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
      try {
        const target = targets[targetIndex];
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
