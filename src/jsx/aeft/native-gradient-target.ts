import {
  addSelectionKey,
  buildSelectionTraversalRoot,
  compareSelectionPropertyPaths,
  createSelectionKeySet,
  isSelectionPropertyDisabled,
  isSelectionTraversalChildSlot,
  resolveSelectedScopeRoots,
  selectionTraversalContainsProperty,
  selectionTargetKey,
  selectionTargetKeyFromPath,
} from "./selection-scope";
import type { SelectionKeySet } from "./selection-scope";

export type NativeGradientKind = "fill" | "stroke";

export type NativeGradientTargetDescriptor = {
  readonly targetKey: string;
  readonly projectPath: string;
  readonly projectDirty: false;
  readonly compId: number;
  readonly layerId: number;
  readonly layerIndex: number;
  readonly kind: NativeGradientKind;
  readonly propertyIndexPath: number[];
  readonly matchNamePath: string[];
};

const NATIVE_GRADIENT_FILL_MATCH_NAME = "ADBE Vector Graphic - G-Fill";
const NATIVE_GRADIENT_STROKE_MATCH_NAME = "ADBE Vector Graphic - G-Stroke";
const NATIVE_GRADIENT_PAYLOAD_MATCH_NAME = "ADBE Vector Grad Colors";

export const nativeGradientKind = (property: any): NativeGradientKind | null => {
  if (!property) return null;
  try {
    if (property.matchName === NATIVE_GRADIENT_FILL_MATCH_NAME) return "fill";
    if (property.matchName === NATIVE_GRADIENT_STROKE_MATCH_NAME) return "stroke";
  } catch (_error) {}
  return null;
};

const isPositiveInteger = (value: any) =>
  typeof value === "number" && isFinite(value) && value > 0 && Math.floor(value) === value;

const isSamePropertySlot = (left: any, right: any) => {
  if (!left || !right) return false;
  try {
    return (
      isPositiveInteger(left.propertyIndex) &&
      left.propertyIndex === right.propertyIndex &&
      typeof left.matchName === "string" &&
      left.matchName.length > 0 &&
      left.matchName === right.matchName
    );
  } catch (_error) {
    return false;
  }
};

const isSameLayerSlot = (left: any, right: any) => {
  if (!left || !right) return false;
  try {
    return (
      isPositiveInteger(left.id) &&
      left.id === right.id &&
      isPositiveInteger(left.index) &&
      left.index === right.index
    );
  } catch (_error) {
    return false;
  }
};

const isVisited = (visited: any[], candidate: any) => {
  for (let index = 0; index < visited.length; index += 1) {
    if (visited[index] === candidate) return true;
  }
  return false;
};

export const findExactNativeGradientPayload = (parent: any) => {
  if (!nativeGradientKind(parent)) return null;
  try {
    if (!isPositiveInteger(parent.numProperties)) return null;
    let payload: any = null;
    let payloadCount = 0;
    for (let index = 1; index <= parent.numProperties; index += 1) {
      const child = parent.property(index);
      if (child && child.matchName === NATIVE_GRADIENT_PAYLOAD_MATCH_NAME) {
        payload = child;
        payloadCount += 1;
      }
    }
    if (payloadCount !== 1 || !payload || !isSamePropertySlot(payload.parentProperty, parent)) {
      return null;
    }
    if (!isPositiveInteger(payload.propertyIndex)) return null;
    if (!isSamePropertySlot(parent.property(payload.propertyIndex), payload)) return null;
    return payload;
  } catch (_error) {
    return null;
  }
};

export const exactNativeGradientParent = (property: any) => {
  if (!property) return null;
  try {
    if (nativeGradientKind(property)) {
      return findExactNativeGradientPayload(property) ? property : null;
    }
    if (property.matchName !== NATIVE_GRADIENT_PAYLOAD_MATCH_NAME) return null;
    const parent = property.parentProperty;
    return isSamePropertySlot(findExactNativeGradientPayload(parent), property) ? parent : null;
  } catch (_error) {
    return null;
  }
};

export const isExactNativeGradientPayload = (property: any) => {
  try {
    if (!property || property.matchName !== NATIVE_GRADIENT_PAYLOAD_MATCH_NAME) return false;
    const parent = exactNativeGradientParent(property);
    return !!parent && isSamePropertySlot(findExactNativeGradientPayload(parent), property);
  } catch (_error) {
    return false;
  }
};

export type NativeGradientPropertyPath = {
  propertyIndexPath: number[];
  matchNamePath: string[];
};

type NativeGradientCollectorState = {
  invalid: boolean;
  projectPath: string;
  compId: number;
  descriptors: NativeGradientTargetDescriptor[];
  keys: SelectionKeySet;
  visitedKeys: SelectionKeySet;
};

export const buildNativeGradientTargetKey = (
  compId: number,
  layer: any,
  payload: any
) => {
  const propertyKey = selectionTargetKey(layer, payload);
  return isPositiveInteger(compId) && propertyKey ? compId + ":" + propertyKey : null;
};

export const buildExactNativeGradientPropertyPath = (
  layer: any,
  payload: any
): NativeGradientPropertyPath | null => {
  const propertyIndexPath: number[] = [];
  const matchNamePath: string[] = [];
  const chain: any[] = [];
  let current = payload;

  try {
    while (!isSameLayerSlot(current, layer)) {
      if (!current || chain.length >= 128 || isVisited(chain, current)) return null;
      chain.push(current);

      const propertyIndex = current.propertyIndex;
      const matchName = current.matchName;
      if (!isPositiveInteger(propertyIndex) || typeof matchName !== "string" || !matchName) {
        return null;
      }
      propertyIndexPath.unshift(propertyIndex);
      matchNamePath.unshift(matchName);

      const currentParent = current.parentProperty;
      if (currentParent) {
        if (!isSamePropertySlot(currentParent.property(propertyIndex), current)) return null;
        current = currentParent;
      } else {
        if (!isSamePropertySlot(layer.property(propertyIndex), current)) return null;
        current = layer;
      }
    }
  } catch (_error) {
    return null;
  }

  if (
    propertyIndexPath.length === 0 ||
    propertyIndexPath.length !== matchNamePath.length ||
    matchNamePath[matchNamePath.length - 1] !== NATIVE_GRADIENT_PAYLOAD_MATCH_NAME
  ) {
    return null;
  }
  return { propertyIndexPath, matchNamePath };
};

const appendNativeGradientTarget = (
  parent: any,
  payload: any,
  kind: NativeGradientKind,
  layer: any,
  activeItem: any,
  state: NativeGradientCollectorState
) => {
  try {
    if (
      nativeGradientKind(parent) !== kind ||
      !isSamePropertySlot(findExactNativeGradientPayload(parent), payload)
    ) {
      state.invalid = true;
      return;
    }
    if (!isSamePropertySlot(payload.parentProperty, parent)) {
      state.invalid = true;
      return;
    }
    if (
      layer.locked !== false ||
      payload.numKeys !== 0 ||
      payload.expressionEnabled !== false
    ) {
      state.invalid = true;
      return;
    }

    const layerId = layer.id;
    const layerIndex = layer.index;
    if (!isPositiveInteger(layerId) || !isPositiveInteger(layerIndex)) {
      state.invalid = true;
      return;
    }
    if (!isSameLayerSlot(activeItem.layer(layerIndex), layer)) {
      state.invalid = true;
      return;
    }

    const path = buildExactNativeGradientPropertyPath(layer, payload);
    if (!path || path.matchNamePath.length < 2) {
      state.invalid = true;
      return;
    }
    if (path.matchNamePath[path.matchNamePath.length - 2] !== parent.matchName) {
      state.invalid = true;
      return;
    }

    const propertyIndexPath = path.propertyIndexPath;
    const key = buildNativeGradientTargetKey(state.compId, layer, payload);
    if (!key) {
      state.invalid = true;
      return;
    }
    if (!addSelectionKey(state.keys, key)) return;
    state.descriptors.push({
      targetKey: key,
      projectPath: state.projectPath,
      projectDirty: false,
      compId: state.compId,
      layerId,
      layerIndex,
      kind,
      propertyIndexPath,
      matchNamePath: path.matchNamePath,
    });
  } catch (_error) {
    state.invalid = true;
  }
};

const collectNativeGradientTargets = (
  property: any,
  layer: any,
  activeItem: any,
  state: NativeGradientCollectorState,
  includeDisabledGradients: boolean,
  ancestorProperties: any[],
  propertyIndexPath: number[],
  matchNamePath: string[],
  visitedKey: string,
  branchDisabled: boolean,
  bypassDisabledFilter = false
) => {
  if (state.invalid) return;
  if (!property) {
    state.invalid = true;
    return;
  }
  if (
    !bypassDisabledFilter &&
    !includeDisabledGradients &&
    branchDisabled
  ) {
    return;
  }
  if (!addSelectionKey(state.visitedKeys, visitedKey)) return;

  try {
    const kind = nativeGradientKind(property);
    if (kind) {
      const payload = findExactNativeGradientPayload(property);
      if (!payload) {
        state.invalid = true;
        return;
      }
      appendNativeGradientTarget(property, payload, kind, layer, activeItem, state);
      return;
    }

    if (property.matchName === NATIVE_GRADIENT_PAYLOAD_MATCH_NAME) {
      const payload = property;
      const parent = payload.parentProperty;
      const parentKind = nativeGradientKind(parent);
      if (
        !parentKind ||
        !isPositiveInteger(payload.propertyIndex) ||
        !isSamePropertySlot(parent.property(payload.propertyIndex), payload) ||
        !isSamePropertySlot(findExactNativeGradientPayload(parent), payload)
      ) {
        state.invalid = true;
        return;
      }
      appendNativeGradientTarget(parent, payload, parentKind, layer, activeItem, state);
      return;
    }

    if (property.propertyType === PropertyType.PROPERTY) return;
    if (
      typeof property.numProperties !== "number" ||
      !isFinite(property.numProperties) ||
      property.numProperties < 0 ||
      Math.floor(property.numProperties) !== property.numProperties
    ) {
      state.invalid = true;
      return;
    }
    const childCount = property.numProperties;
    for (let index = 1; index <= childCount; index += 1) {
      const child = property.property(index);
      if (
        !isSelectionTraversalChildSlot(layer, property, child, index, propertyIndexPath.length) ||
        selectionTraversalContainsProperty(ancestorProperties, child)
      ) {
        state.invalid = true;
        return;
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
        state.invalid = true;
        return;
      }
      try {
        collectNativeGradientTargets(
          child,
          layer,
          activeItem,
          state,
          includeDisabledGradients,
          ancestorProperties,
          propertyIndexPath,
          matchNamePath,
          childKey,
          branchDisabled || isSelectionPropertyDisabled(child),
          false
        );
      } finally {
        propertyIndexPath.pop();
        matchNamePath.pop();
        ancestorProperties.pop();
      }
      if (state.invalid) return;
    }
  } catch (_error) {
    state.invalid = true;
  }
};

const isExactNativeGradientSelection = (property: any) =>
  isExactNativeGradientPayload(property);

export const collectSelectedNativeGradientTargets = (
  includeDisabledGradients = true
): NativeGradientTargetDescriptor[] => {
  if (typeof app === "undefined" || !app || !app.project) return [];

  try {
    const project = app.project as Project & { readonly dirty: boolean };
    const projectFile = project.file;
    if (!projectFile || project.dirty !== false) return [];
    if (
      projectFile.exists !== true ||
      typeof projectFile.fsName !== "string" ||
      projectFile.fsName.length === 0
    ) {
      return [];
    }

    const activeItem = project.activeItem;
    if (
      typeof CompItem === "undefined" ||
      !activeItem ||
      !(activeItem instanceof CompItem) ||
      !isPositiveInteger(activeItem.id)
    ) {
      return [];
    }

    const selectedLayers = activeItem.selectedLayers;
    if (!selectedLayers || selectedLayers.length === 0) return [];

    const state: NativeGradientCollectorState = {
      invalid: false,
      projectPath: projectFile.fsName,
      compId: activeItem.id,
      descriptors: [],
      keys: createSelectionKeySet(),
      visitedKeys: createSelectionKeySet(),
    };

    const scopes = resolveSelectedScopeRoots(activeItem, isExactNativeGradientSelection);
    if (scopes.invalid) return [];
    for (let rootIndex = 0; rootIndex < scopes.roots.length; rootIndex += 1) {
      const root = scopes.roots[rootIndex];
      const traversal = buildSelectionTraversalRoot(root);
      if (!traversal) return [];
      collectNativeGradientTargets(
        root.property,
        root.layer,
        activeItem,
        state,
        includeDisabledGradients,
        [root.property],
        traversal.propertyIndexPath,
        traversal.matchNamePath,
        traversal.key,
        traversal.disabled,
        root.exact
      );
      if (state.invalid) return [];
    }

    if (state.invalid) return [];
    const descriptors = state.descriptors;
    descriptors.sort((left, right) => {
      if (left.layerIndex !== right.layerIndex) return left.layerIndex - right.layerIndex;
      return compareSelectionPropertyPaths(left, right);
    });
    if (descriptors.length === 0) return [];
    return descriptors;
  } catch (_error) {
    return [];
  }
};
