export type NativeGradientKind = "fill" | "stroke";

export type NativeGradientTargetDescriptor = {
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

const isDisabledNativeGradientBranch = (property: any) => {
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

export type NativeGradientPropertyPath = {
  propertyIndexPath: number[];
  matchNamePath: string[];
};

type NativeGradientCollectorState = {
  invalid: boolean;
  projectPath: string;
  compId: number;
  descriptors: NativeGradientTargetDescriptor[];
  keys: string[];
  visited: any[];
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
    const key = state.compId + ":" + layerId + ":" + propertyIndexPath.join(".");
    for (let index = 0; index < state.keys.length; index += 1) {
      if (state.keys[index] === key) return;
    }
    state.keys.push(key);
    state.descriptors.push({
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
  includeDisabledGradients: boolean
) => {
  if (state.invalid) return;
  if (!property) {
    state.invalid = true;
    return;
  }
  if (!includeDisabledGradients && isDisabledNativeGradientBranch(property)) return;
  if (isVisited(state.visited, property)) return;
  state.visited.push(property);

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
    for (let index = 1; index <= property.numProperties; index += 1) {
      collectNativeGradientTargets(
        property.property(index),
        layer,
        activeItem,
        state,
        includeDisabledGradients
      );
      if (state.invalid) return;
    }
  } catch (_error) {
    state.invalid = true;
  }
};

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
      keys: [],
      visited: [],
    };

    for (let selectedLayerIndex = 0; selectedLayerIndex < selectedLayers.length; selectedLayerIndex += 1) {
      const layer = selectedLayers[selectedLayerIndex];
      if (
        !layer ||
        !isPositiveInteger(layer.id) ||
        !isPositiveInteger(layer.index) ||
        !isSameLayerSlot(activeItem.layer(layer.index), layer)
      ) {
        return [];
      }

      const selectedProperties = layer.selectedProperties;
      if (!selectedProperties || typeof selectedProperties.length !== "number") return [];
      if (selectedProperties.length > 0) {
        for (let propertyIndex = 0; propertyIndex < selectedProperties.length; propertyIndex += 1) {
          collectNativeGradientTargets(
            selectedProperties[propertyIndex],
            layer,
            activeItem,
            state,
            includeDisabledGradients
          );
          if (state.invalid) return [];
        }
      } else {
        collectNativeGradientTargets(
          layer,
          layer,
          activeItem,
          state,
          includeDisabledGradients
        );
        if (state.invalid) return [];
      }
    }

    if (state.invalid) return [];
    const descriptors = state.descriptors;
    if (descriptors.length === 0) return [];
    return descriptors;
  } catch (_error) {
    return [];
  }
};
