export type SelectionPropertyPath = {
  propertyIndexPath: number[];
  matchNamePath: string[];
};

export type SelectedScopeRoot = {
  layer: any;
  property: any;
  path: SelectionPropertyPath | null;
  exact: boolean;
  wholeLayer: boolean;
};

export type SelectedScopeResolution = {
  invalid: boolean;
  roots: SelectedScopeRoot[];
};

export type SelectionKeySet = {
  size: number;
  values: { [bucket: string]: boolean };
};

export type SelectionTraversalRoot = {
  key: string;
  propertyIndexPath: number[];
  matchNamePath: string[];
  disabled: boolean;
  materialOptions: boolean;
};

export const createSelectionKeySet = (): SelectionKeySet => ({ size: 0, values: {} });

export const hasSelectionKey = (keys: SelectionKeySet, candidate: string) =>
  keys.values["key:" + candidate] === true;

export const addSelectionKey = (keys: SelectionKeySet, candidate: string) => {
  const bucket = "key:" + candidate;
  if (keys.values[bucket] === true) return false;
  keys.values[bucket] = true;
  keys.size += 1;
  return true;
};

export const selectionTraversalContainsProperty = (
  ancestors: any[],
  property: any
) => {
  for (let index = 0; index < ancestors.length; index += 1) {
    if (ancestors[index] === property) return true;
  }
  return false;
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

export const buildSelectionPropertyPath = (
  layer: any,
  property: any
): SelectionPropertyPath | null => {
  const propertyIndexPath: number[] = [];
  const matchNamePath: string[] = [];
  const visited: any[] = [];
  let current = property;

  try {
    while (!isSameLayerSlot(current, layer)) {
      if (!current || visited.length >= 128 || isVisited(visited, current)) return null;
      visited.push(current);

      if (!isPositiveInteger(current.propertyIndex) || typeof current.matchName !== "string") {
        return null;
      }
      propertyIndexPath.unshift(current.propertyIndex);
      matchNamePath.unshift(current.matchName);

      const parent = current.parentProperty;
      if (parent) {
        if (!isSamePropertySlot(parent.property(current.propertyIndex), current)) return null;
        current = parent;
      } else {
        if (!isSamePropertySlot(layer.property(current.propertyIndex), current)) return null;
        current = layer;
      }
    }
  } catch (_error) {
    return null;
  }

  return propertyIndexPath.length > 0 && propertyIndexPath.length === matchNamePath.length
    ? { propertyIndexPath, matchNamePath }
    : null;
};

const pathsEqual = (left: SelectionPropertyPath, right: SelectionPropertyPath) => {
  if (left.propertyIndexPath.length !== right.propertyIndexPath.length) return false;
  for (let index = 0; index < left.propertyIndexPath.length; index += 1) {
    if (
      left.propertyIndexPath[index] !== right.propertyIndexPath[index] ||
      left.matchNamePath[index] !== right.matchNamePath[index]
    ) {
      return false;
    }
  }
  return true;
};

const isStrictDescendantPath = (
  candidate: SelectionPropertyPath,
  ancestor: SelectionPropertyPath
) => {
  if (candidate.propertyIndexPath.length <= ancestor.propertyIndexPath.length) return false;
  for (let index = 0; index < ancestor.propertyIndexPath.length; index += 1) {
    if (
      candidate.propertyIndexPath[index] !== ancestor.propertyIndexPath[index] ||
      candidate.matchNamePath[index] !== ancestor.matchNamePath[index]
    ) {
      return false;
    }
  }
  return true;
};

export const compareSelectionPropertyPaths = (
  left: SelectionPropertyPath,
  right: SelectionPropertyPath
) => {
  const length = Math.min(left.propertyIndexPath.length, right.propertyIndexPath.length);
  for (let index = 0; index < length; index += 1) {
    if (left.propertyIndexPath[index] !== right.propertyIndexPath[index]) {
      return left.propertyIndexPath[index] - right.propertyIndexPath[index];
    }
  }
  return left.propertyIndexPath.length - right.propertyIndexPath.length;
};

export const resolveSelectionPropertyPath = (
  layer: any,
  path: SelectionPropertyPath
) => {
  let current = layer;
  try {
    for (let index = 0; index < path.propertyIndexPath.length; index += 1) {
      current = current.property(path.propertyIndexPath[index]);
      if (!current || current.matchName !== path.matchNamePath[index]) return null;
    }
    return current;
  } catch (_error) {
    return null;
  }
};

export const selectionTargetKeyFromPath = (layer: any, path: SelectionPropertyPath) => {
  try {
    if (!path || !isPositiveInteger(layer.id) || !isPositiveInteger(layer.index)) return null;
    return (
      layer.id +
      ":" +
      layer.index +
      ":" +
      path.propertyIndexPath.join(".") +
      ":" +
      path.matchNamePath.join("/")
    );
  } catch (_error) {
    return null;
  }
};

export const selectionTargetKey = (layer: any, property: any) => {
  const path = buildSelectionPropertyPath(layer, property);
  return path ? selectionTargetKeyFromPath(layer, path) : null;
};

export const selectionScopeKey = (layer: any, property: any) => {
  const targetKey = selectionTargetKey(layer, property);
  if (targetKey) return targetKey;
  try {
    if (
      property &&
      layer &&
      property.id === layer.id &&
      property.index === layer.index &&
      isPositiveInteger(layer.id) &&
      isPositiveInteger(layer.index)
    ) {
      return "layer:" + layer.id + ":" + layer.index;
    }
  } catch (_error) {
    return null;
  }
  return null;
};

export const isSelectionPropertyDisabled = (property: any) => {
  try {
    const isLayer =
      property.parentProperty == null &&
      typeof property.index === "number" &&
      typeof property.property === "function" &&
      typeof property.propertyType === "undefined";
    const isPropertyGroup =
      typeof property.propertyType === "number" &&
      typeof property.numProperties === "number" &&
      typeof property.property === "function";
    return (
      property.enabled === false &&
      (property.canSetEnabled === true || isLayer || isPropertyGroup)
    );
  } catch (_error) {
    return false;
  }
};

export const isSelectionBranchDisabled = (property: any) => {
  let current = property;
  while (current) {
    if (isSelectionPropertyDisabled(current)) return true;
    try {
      current = current.parentProperty;
    } catch (_error) {
      return false;
    }
  }
  return false;
};

export const isMaterialOptionsProperty = (property: any) => {
  try {
    return (
      property.matchName === "ADBE Vector Materials Group" ||
      property.matchName === "ADBE Material Options Group"
    );
  } catch (_error) {
    return false;
  }
};

export const isMaterialOptionsBranch = (property: any) => {
  let current = property;
  while (current) {
    if (isMaterialOptionsProperty(current)) return true;
    try {
      current = current.parentProperty;
    } catch (_error) {
      return false;
    }
  }
  return false;
};

export const buildSelectionTraversalRoot = (
  root: SelectedScopeRoot
): SelectionTraversalRoot | null => {
  try {
    let path: SelectionPropertyPath | null = null;
    if (root.path) {
      if (root.wholeLayer) return null;
      path = buildSelectionPropertyPath(root.layer, root.property);
      if (!path || !pathsEqual(path, root.path)) return null;
    } else if (
      !root.wholeLayer ||
      root.exact ||
      !isSameLayerSlot(root.property, root.layer)
    ) {
      return null;
    }
    const propertyIndexPath = path ? path.propertyIndexPath.slice() : [];
    const matchNamePath = path ? path.matchNamePath.slice() : [];
    const key = path
      ? selectionTargetKeyFromPath(root.layer, path)
      : selectionScopeKey(root.layer, root.property);
    if (!key) return null;
    return {
      key,
      propertyIndexPath,
      matchNamePath,
      disabled: isSelectionBranchDisabled(root.property),
      materialOptions: isMaterialOptionsBranch(root.property),
    };
  } catch (_error) {
    return null;
  }
};

export const isSelectionTraversalChildSlot = (
  layer: any,
  parent: any,
  child: any,
  expectedIndex: number,
  parentDepth: number
) => {
  if (
    parentDepth >= 128 ||
    !isPositiveInteger(expectedIndex)
  ) {
    return false;
  }
  try {
    if (
      !child ||
      child.propertyIndex !== expectedIndex ||
      typeof child.matchName !== "string" ||
      child.matchName.length === 0
    ) {
      return false;
    }
    const backlink = child.parentProperty;
    if (isSameLayerSlot(parent, layer)) {
      return backlink == null || isSameLayerSlot(backlink, layer);
    }
    return !!backlink && isSamePropertySlot(backlink, parent);
  } catch (_error) {
    return false;
  }
};

export const resolveSelectedScopeRoots = (
  activeItem: any,
  isExactTarget: (property: any) => boolean
): SelectedScopeResolution => {
  const roots: SelectedScopeRoot[] = [];
  try {
    const selectedLayers = activeItem.selectedLayers;
    if (!selectedLayers || typeof selectedLayers.length !== "number") {
      return { invalid: true, roots: [] };
    }

    const layers: any[] = [];
    const layerKeys: string[] = [];
    for (let index = 0; index < selectedLayers.length; index += 1) {
      const layer = selectedLayers[index];
      if (!layer || !isPositiveInteger(layer.id) || !isPositiveInteger(layer.index)) {
        return { invalid: true, roots: [] };
      }
      const key = layer.id + ":" + layer.index;
      let duplicate = false;
      for (let keyIndex = 0; keyIndex < layerKeys.length; keyIndex += 1) {
        if (layerKeys[keyIndex] === key) duplicate = true;
      }
      if (!duplicate) {
        layerKeys.push(key);
        layers.push(layer);
      }
    }
    layers.sort((left, right) => left.index - right.index);

    for (let layerOffset = 0; layerOffset < layers.length; layerOffset += 1) {
      const layer = layers[layerOffset];
      if (
        !layer ||
        !isPositiveInteger(layer.id) ||
        !isPositiveInteger(layer.index) ||
        !isSameLayerSlot(activeItem.layer(layer.index), layer)
      ) {
        return { invalid: true, roots: [] };
      }

      const selectedProperties = layer.selectedProperties;
      if (!selectedProperties || typeof selectedProperties.length !== "number") {
        return { invalid: true, roots: [] };
      }
      if (selectedProperties.length === 0) {
        roots.push({ layer, property: layer, path: null, exact: false, wholeLayer: true });
        continue;
      }

      const candidates: SelectedScopeRoot[] = [];
      for (let propertyOffset = 0; propertyOffset < selectedProperties.length; propertyOffset += 1) {
        const property = selectedProperties[propertyOffset];
        const path = buildSelectionPropertyPath(layer, property);
        if (!path) return { invalid: true, roots: [] };

        let duplicateIndex = -1;
        for (let index = 0; index < candidates.length; index += 1) {
          if (candidates[index].path && pathsEqual(candidates[index].path!, path)) {
            duplicateIndex = index;
            break;
          }
        }
        const exact = isExactTarget(property);
        if (duplicateIndex >= 0) {
          if (exact) candidates[duplicateIndex].exact = true;
          continue;
        }
        candidates.push({ layer, property, path, exact, wholeLayer: false });
      }

      candidates.sort((left, right) =>
        compareSelectionPropertyPaths(left.path!, right.path!)
      );
      for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
        const candidate = candidates[candidateIndex];
        let redundantNonExactDescendant = false;
        if (!candidate.exact) {
          for (let ancestorIndex = 0; ancestorIndex < candidates.length; ancestorIndex += 1) {
            const ancestor = candidates[ancestorIndex];
            if (
              ancestorIndex !== candidateIndex &&
              ancestor.path &&
              candidate.path &&
              isStrictDescendantPath(candidate.path, ancestor.path)
            ) {
              redundantNonExactDescendant = true;
              break;
            }
          }
        }
        if (!redundantNonExactDescendant) roots.push(candidate);
      }
    }
    return { invalid: false, roots };
  } catch (_error) {
    return { invalid: true, roots: [] };
  }
};

export const resolveParentScopeRoot = (
  root: SelectedScopeRoot
): SelectedScopeRoot | null => {
  if (root.exact || root.wholeLayer) return null;
  try {
    const parent = root.property?.parentProperty;
    if (!parent || isSameLayerSlot(parent, root.layer)) return null;
    const path = buildSelectionPropertyPath(root.layer, parent);
    if (!path) return null;
    return {
      layer: root.layer,
      property: parent,
      path,
      exact: false,
      wholeLayer: false,
    };
  } catch (_error) {
    return null;
  }
};
