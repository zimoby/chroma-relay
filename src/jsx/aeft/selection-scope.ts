export type SelectionPropertyPath = {
  propertyIndexPath: number[];
  matchNamePath: string[];
};

export type SelectionScopeLayerSnapshot = {
  layerId: number;
  layerIndex: number;
  selected: boolean;
  properties: SelectionPropertyPath[];
};

export type SelectionScopeIgnoredAncestor = {
  layerId: number;
  layerIndex: number;
  path: SelectionPropertyPath;
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

type SelectionScopeNormalizationRecord = {
  compId: number;
  snapshot: SelectionScopeLayerSnapshot[];
  ignoredAncestors: SelectionScopeIgnoredAncestor[];
};

const SELECTION_SCOPE_NORMALIZATION_KEY = "__chromaRelaySelectionScopeNormalizationV1";
let selectionScopeNormalizationFallback: SelectionScopeNormalizationRecord | null = null;

const selectionScopeHostGlobal = () => {
  try {
    return typeof $ !== "undefined" && $ ? ($ as any) : null;
  } catch (_error) {
    return null;
  }
};

const readSelectionScopeNormalization = (): SelectionScopeNormalizationRecord | null => {
  const hostGlobal = selectionScopeHostGlobal();
  try {
    return hostGlobal && hostGlobal[SELECTION_SCOPE_NORMALIZATION_KEY]
      ? hostGlobal[SELECTION_SCOPE_NORMALIZATION_KEY]
      : selectionScopeNormalizationFallback;
  } catch (_error) {
    return selectionScopeNormalizationFallback;
  }
};

const writeSelectionScopeNormalization = (
  value: SelectionScopeNormalizationRecord | null
) => {
  selectionScopeNormalizationFallback = value;
  const hostGlobal = selectionScopeHostGlobal();
  if (hostGlobal) {
    try {
      hostGlobal[SELECTION_SCOPE_NORMALIZATION_KEY] = value;
    } catch (_error) {}
  }
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

const isValidSelectionPath = (path: SelectionPropertyPath) => {
  if (
    !path ||
    !path.propertyIndexPath ||
    !path.matchNamePath ||
    path.propertyIndexPath.length === 0 ||
    path.propertyIndexPath.length > 128 ||
    path.propertyIndexPath.length !== path.matchNamePath.length
  ) {
    return false;
  }
  for (let index = 0; index < path.propertyIndexPath.length; index += 1) {
    if (
      !isPositiveInteger(path.propertyIndexPath[index]) ||
      typeof path.matchNamePath[index] !== "string" ||
      path.matchNamePath[index].length === 0
    ) {
      return false;
    }
  }
  return true;
};

const cloneSelectionPath = (path: SelectionPropertyPath): SelectionPropertyPath => ({
  propertyIndexPath: path.propertyIndexPath.slice(),
  matchNamePath: path.matchNamePath.slice(),
});

const normalizeSelectionSnapshot = (
  snapshot: SelectionScopeLayerSnapshot[]
): SelectionScopeLayerSnapshot[] | null => {
  if (!snapshot || snapshot.length > 128) return null;
  const normalized: SelectionScopeLayerSnapshot[] = [];
  const layerKeys: string[] = [];
  for (let index = 0; index < snapshot.length; index += 1) {
    const entry = snapshot[index];
    if (!entry || (!entry.selected && entry.properties.length === 0)) continue;
    if (
      !isPositiveInteger(entry.layerId) ||
      !isPositiveInteger(entry.layerIndex) ||
      typeof entry.selected !== "boolean" ||
      !entry.properties ||
      entry.properties.length > 128
    ) {
      return null;
    }
    const layerKey = entry.layerId + ":" + entry.layerIndex;
    for (let keyIndex = 0; keyIndex < layerKeys.length; keyIndex += 1) {
      if (layerKeys[keyIndex] === layerKey) return null;
    }
    layerKeys.push(layerKey);
    const properties: SelectionPropertyPath[] = [];
    for (let pathIndex = 0; pathIndex < entry.properties.length; pathIndex += 1) {
      const path = entry.properties[pathIndex];
      if (!isValidSelectionPath(path)) return null;
      for (let priorIndex = 0; priorIndex < properties.length; priorIndex += 1) {
        if (pathsEqual(properties[priorIndex], path)) return null;
      }
      properties.push(cloneSelectionPath(path));
    }
    properties.sort(compareSelectionPropertyPaths);
    normalized.push({
      layerId: entry.layerId,
      layerIndex: entry.layerIndex,
      selected: entry.selected,
      properties,
    });
  }
  normalized.sort((left, right) => left.layerIndex - right.layerIndex);
  return normalized;
};

const selectionScopeSnapshotsEqual = (
  left: SelectionScopeLayerSnapshot[],
  right: SelectionScopeLayerSnapshot[]
) => {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (
      left[index].layerId !== right[index].layerId ||
      left[index].layerIndex !== right[index].layerIndex ||
      left[index].selected !== right[index].selected ||
      left[index].properties.length !== right[index].properties.length
    ) {
      return false;
    }
    for (let pathIndex = 0; pathIndex < left[index].properties.length; pathIndex += 1) {
      if (!pathsEqual(left[index].properties[pathIndex], right[index].properties[pathIndex])) {
        return false;
      }
    }
  }
  return true;
};

export const clearSelectionScopeNormalization = () => {
  writeSelectionScopeNormalization(null);
};

export const hasSelectionScopeNormalization = () => readSelectionScopeNormalization() !== null;

export const reconcileSelectionScopeNormalization = (
  activeItem: any,
  snapshot: SelectionScopeLayerSnapshot[]
) => {
  const selectionScopeNormalization = readSelectionScopeNormalization();
  if (!selectionScopeNormalization) return false;
  const normalized = normalizeSelectionSnapshot(snapshot);
  if (
    !normalized ||
    !activeItem ||
    !isPositiveInteger(activeItem.id) ||
    activeItem.id !== selectionScopeNormalization.compId ||
    !selectionScopeSnapshotsEqual(normalized, selectionScopeNormalization.snapshot)
  ) {
    clearSelectionScopeNormalization();
    return false;
  }
  return true;
};

export const setSelectionScopeNormalization = (
  activeItem: any,
  snapshot: SelectionScopeLayerSnapshot[],
  ignoredAncestors: SelectionScopeIgnoredAncestor[]
) => {
  const normalized = normalizeSelectionSnapshot(snapshot);
  if (
    !activeItem ||
    !isPositiveInteger(activeItem.id) ||
    !normalized ||
    !ignoredAncestors ||
    ignoredAncestors.length === 0 ||
    ignoredAncestors.length > 128
  ) {
    clearSelectionScopeNormalization();
    return false;
  }
  const ignored: SelectionScopeIgnoredAncestor[] = [];
  for (let index = 0; index < ignoredAncestors.length; index += 1) {
    const candidate = ignoredAncestors[index];
    if (
      !candidate ||
      !isPositiveInteger(candidate.layerId) ||
      !isPositiveInteger(candidate.layerIndex) ||
      !isValidSelectionPath(candidate.path)
    ) {
      clearSelectionScopeNormalization();
      return false;
    }
    let found = false;
    for (let layerIndex = 0; layerIndex < normalized.length; layerIndex += 1) {
      const layer = normalized[layerIndex];
      if (layer.layerId !== candidate.layerId || layer.layerIndex !== candidate.layerIndex) {
        continue;
      }
      for (let pathIndex = 0; pathIndex < layer.properties.length; pathIndex += 1) {
        if (pathsEqual(layer.properties[pathIndex], candidate.path)) found = true;
      }
    }
    if (!found) {
      clearSelectionScopeNormalization();
      return false;
    }
    for (let priorIndex = 0; priorIndex < ignored.length; priorIndex += 1) {
      if (
        ignored[priorIndex].layerId === candidate.layerId &&
        ignored[priorIndex].layerIndex === candidate.layerIndex &&
        pathsEqual(ignored[priorIndex].path, candidate.path)
      ) {
        clearSelectionScopeNormalization();
        return false;
      }
    }
    ignored.push({
      layerId: candidate.layerId,
      layerIndex: candidate.layerIndex,
      path: cloneSelectionPath(candidate.path),
    });
  }
  writeSelectionScopeNormalization({
    compId: activeItem.id,
    snapshot: normalized,
    ignoredAncestors: ignored,
  });
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
  const invalidSelection = () => {
    clearSelectionScopeNormalization();
    return { invalid: true, roots: [] } as SelectedScopeResolution;
  };
  try {
    const selectedLayers = activeItem.selectedLayers;
    if (!selectedLayers || typeof selectedLayers.length !== "number") {
      return invalidSelection();
    }

    const layers: any[] = [];
    const layerKeys: string[] = [];
    for (let index = 0; index < selectedLayers.length; index += 1) {
      const layer = selectedLayers[index];
      if (!layer || !isPositiveInteger(layer.id) || !isPositiveInteger(layer.index)) {
        return invalidSelection();
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

    const candidateLayers: Array<{ layer: any; candidates: SelectedScopeRoot[] }> = [];
    const currentSnapshot: SelectionScopeLayerSnapshot[] = [];
    for (let layerOffset = 0; layerOffset < layers.length; layerOffset += 1) {
      const layer = layers[layerOffset];
      if (
        !layer ||
        !isPositiveInteger(layer.id) ||
        !isPositiveInteger(layer.index) ||
        !isSameLayerSlot(activeItem.layer(layer.index), layer)
      ) {
        return invalidSelection();
      }

      const selectedProperties = layer.selectedProperties;
      if (!selectedProperties || typeof selectedProperties.length !== "number") {
        return invalidSelection();
      }
      if (selectedProperties.length === 0) {
        candidateLayers.push({
          layer,
          candidates: [{ layer, property: layer, path: null, exact: false, wholeLayer: true }],
        });
        currentSnapshot.push({
          layerId: layer.id,
          layerIndex: layer.index,
          selected: layer.selected === true,
          properties: [],
        });
        continue;
      }

      const candidates: SelectedScopeRoot[] = [];
      for (let propertyOffset = 0; propertyOffset < selectedProperties.length; propertyOffset += 1) {
        const property = selectedProperties[propertyOffset];
        const path = buildSelectionPropertyPath(layer, property);
        if (!path) return invalidSelection();

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
      candidateLayers.push({ layer, candidates });
      const snapshotProperties: SelectionPropertyPath[] = [];
      for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
        snapshotProperties.push(cloneSelectionPath(candidates[candidateIndex].path!));
      }
      currentSnapshot.push({
        layerId: layer.id,
        layerIndex: layer.index,
        selected: layer.selected === true,
        properties: snapshotProperties,
      });
    }

    const normalizationMatches = reconcileSelectionScopeNormalization(activeItem, currentSnapshot);
    const selectionScopeNormalization = readSelectionScopeNormalization();
    const ignoredAncestors =
      normalizationMatches && selectionScopeNormalization
        ? selectionScopeNormalization.ignoredAncestors
        : [];
    const isIgnoredAncestor = (layer: any, path: SelectionPropertyPath | null) => {
      if (!path) return false;
      for (let index = 0; index < ignoredAncestors.length; index += 1) {
        const ignored = ignoredAncestors[index];
        if (
          ignored.layerId === layer.id &&
          ignored.layerIndex === layer.index &&
          pathsEqual(ignored.path, path)
        ) {
          return true;
        }
      }
      return false;
    };

    for (let layerOffset = 0; layerOffset < candidateLayers.length; layerOffset += 1) {
      const layer = candidateLayers[layerOffset].layer;
      const candidates = candidateLayers[layerOffset].candidates;
      for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
        const candidate = candidates[candidateIndex];
        if (isIgnoredAncestor(layer, candidate.path)) continue;
        let redundantNonExactDescendant = false;
        if (!candidate.exact) {
          for (let ancestorIndex = 0; ancestorIndex < candidates.length; ancestorIndex += 1) {
            const ancestor = candidates[ancestorIndex];
            if (
              ancestorIndex !== candidateIndex &&
              !isIgnoredAncestor(layer, ancestor.path) &&
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
    return invalidSelection();
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
