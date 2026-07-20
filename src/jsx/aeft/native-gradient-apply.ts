import {
  buildExactNativeGradientPropertyPath,
  buildNativeGradientTargetKey,
  exactNativeGradientParent,
  findExactNativeGradientPayload,
  isExactNativeGradientPayload,
  nativeGradientKind,
} from "./native-gradient-target";
import type { NativeGradientKind } from "./native-gradient-target";
import {
  compareSelectionPropertyPaths,
  isSelectionBranchDisabled,
  resolveSelectedScopeRoots,
  selectionScopeKey,
} from "./selection-scope";
import {
  MAX_NATIVE_GRADIENT_DESCRIPTOR_PATH_DEPTH,
  MAX_NATIVE_GRADIENT_DIAGNOSTIC_LENGTH,
  MAX_NATIVE_GRADIENT_MATCH_NAME_LENGTH,
  MAX_NATIVE_GRADIENT_TARGET_COUNT,
  normalizeNativeGradientHostVersion,
  resolveNativeGradientTemplateFamily,
  type NativeGradientApplyStatus,
} from "../../js/shared/native-gradient-contract.ts";
import type {
  NativeGradientApplyResult,
  NativeGradientApplyTarget,
} from "../../js/shared/native-gradient-contract.ts";
export type {
  NativeGradientApplyResult,
  NativeGradientApplyStatus,
} from "../../js/shared/native-gradient-contract.ts";

export type NativeGradientPresetRecord = {
  runToken: string;
  tempBasePath: string;
  rootPath: string;
  presetPath: string;
  filename: string;
  byteLength: number;
};

export type NativeGradientApplyRequest = {
  schemaVersion: 1;
  platform?: string;
  expectedHostVersion: string;
  stopCount: number;
  includeDisabledTargets: boolean;
  presets: {
    fill: NativeGradientPresetRecord;
    stroke: NativeGradientPresetRecord;
  };
};

type ResolvedTarget = {
  layer: any;
  parent: any;
  payload: any;
  descriptor: NativeGradientApplyTarget;
};

type PropertyPath = {
  propertyIndexPath: number[];
  matchNamePath: string[];
};

type LayerSelectionSnapshot = {
  layerId: number;
  layerIndex: number;
  selected: boolean;
  properties: PropertyPath[];
};

const FILL_MATCH_NAME = "ADBE Vector Graphic - G-Fill";
const STROKE_MATCH_NAME = "ADBE Vector Graphic - G-Stroke";
const PAYLOAD_MATCH_NAME = "ADBE Vector Grad Colors";
const TOKEN_PATTERN = /^[A-F0-9]{32}$/;
const MAX_PRESET_BYTES = 2 * 1024 * 1024;
const MAX_NATIVE_GRADIENT_SCOPE_NODE_COUNT = 4096;

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

const resultFor = (hostVersion: string): NativeGradientApplyResult => ({
  schemaVersion: 1,
  status: "invalid-request",
  primaryStatus: "invalid-request",
  hostVersion,
  target: null,
  targets: [],
  selectedTargetCount: 0,
  selectedPropertyCount: 0,
  attemptedTargetCount: 0,
  attemptedPropertyCount: 0,
  appliedTargetCount: 0,
  appliedPropertyCount: 0,
  failedTargetIndex: null,
  failedPropertyIndex: null,
  unknownCompletionTargetIndex: null,
  unknownCompletionPropertyIndex: null,
  skippedDisabledCount: 0,
  skippedDisabledBranchCount: 0,
  preservedStateCount: 0,
  preservedPropertyCount: 0,
  mutationAttempted: false,
  applyCompleted: false,
  undoGroupOpened: false,
  undoGroupCloseAttempted: false,
  undoGroupClosed: false,
  selectionRestoreAttempted: false,
  selectionRestored: false,
  applyError: null,
});

const boundedErrorText = (value: any) => {
  try {
    return String(value === undefined || value === null ? "" : value).substring(
      0,
      MAX_NATIVE_GRADIENT_DIAGNOSTIC_LENGTH
    );
  } catch (_error) {
    return "";
  }
};

const finiteErrorNumber = (value: any) =>
  typeof value === "number" && isFinite(value) ? value : null;

const captureApplyError = (error: any) => {
  try {
    return {
      name: boundedErrorText(error && error.name),
      message: boundedErrorText(error && error.message ? error.message : error),
      line: finiteErrorNumber(error && error.line),
      number: finiteErrorNumber(error && error.number),
    };
  } catch (_error) {
    return { name: "", message: "", line: null, number: null };
  }
};

const failBeforeMutation = (
  result: NativeGradientApplyResult,
  status: NativeGradientApplyStatus
) => {
  result.status = status;
  result.primaryStatus = status;
  return result;
};

const clearSelectionEvidence = (result: NativeGradientApplyResult) => {
  result.target = null;
  result.targets.length = 0;
  result.selectedTargetCount = 0;
  result.selectedPropertyCount = 0;
  result.attemptedTargetCount = 0;
  result.attemptedPropertyCount = 0;
  result.appliedTargetCount = 0;
  result.appliedPropertyCount = 0;
  result.failedTargetIndex = null;
  result.failedPropertyIndex = null;
  result.unknownCompletionTargetIndex = null;
  result.unknownCompletionPropertyIndex = null;
  result.skippedDisabledCount = 0;
  result.skippedDisabledBranchCount = 0;
  result.preservedStateCount = 0;
  result.preservedPropertyCount = 0;
};

const canonicalFolderPath = (pathValue: string) => {
  const folder = new Folder(pathValue);
  return typeof folder.fsName === "string" ? folder.fsName : "";
};

const validatedFileLength = (file: any): number | null => {
  const readLength = () => {
    const value = file.length;
    return typeof value === "number" && isFinite(value) && value > 0 ? value : null;
  };
  try {
    const immediate = readLength();
    if (immediate !== null) return immediate;
    file.encoding = "BINARY";
    if (
      typeof file.open !== "function" ||
      typeof file.close !== "function" ||
      typeof file.read !== "function" ||
      file.open("r") !== true
    ) {
      return null;
    }
    let refreshed: number | null = null;
    try {
      const contents = file.read(MAX_PRESET_BYTES + 1);
      refreshed = typeof contents === "string" ? contents.length : null;
    } finally {
      file.close();
    }
    return refreshed;
  } catch (_error) {
    try {
      if (typeof file.close === "function") file.close();
    } catch (_closeError) {}
    return null;
  }
};

const validatePresetRecord = (
  candidate: any,
  kind: NativeGradientKind,
  stopCount: number
): File | null => {
  if (
    !candidate ||
    typeof candidate !== "object" ||
    typeof candidate.runToken !== "string" ||
    !TOKEN_PATTERN.test(candidate.runToken) ||
    typeof candidate.tempBasePath !== "string" ||
    typeof candidate.rootPath !== "string" ||
    typeof candidate.presetPath !== "string" ||
    typeof candidate.filename !== "string" ||
    !isPositiveInteger(candidate.byteLength) ||
    candidate.byteLength > MAX_PRESET_BYTES
  ) {
    return null;
  }

  try {
    const tempPath = canonicalFolderPath(candidate.tempBasePath);
    const hostTempPath = canonicalFolderPath(Folder.temp.fsName);
    if (
      !tempPath ||
      tempPath !== candidate.tempBasePath ||
      tempPath !== hostTempPath
    ) {
      return null;
    }

    const rootName = "chroma-relay-native-gradient-" + candidate.runToken;
    const expectedRootPath = canonicalFolderPath(tempPath + "/" + rootName);
    const rootFolder = new Folder(candidate.rootPath);
    if (
      rootFolder.fsName !== candidate.rootPath ||
      rootFolder.fsName !== expectedRootPath ||
      rootFolder.name !== rootName ||
      rootFolder.exists !== true
    ) {
      return null;
    }

    const expectedFilename =
      "chroma-relay-native-gradient-" +
      candidate.runToken +
      "-" +
      kind +
      "-" +
      stopCount +
      ".ffx";
    const expectedPresetPath = new File(expectedRootPath + "/" + expectedFilename).fsName;
    const presetFile = new File(candidate.presetPath);
    const presetByteLength = validatedFileLength(presetFile);
    if (
      candidate.filename !== expectedFilename ||
      presetFile.fsName !== candidate.presetPath ||
      presetFile.fsName !== expectedPresetPath ||
      presetFile.name !== expectedFilename ||
      !presetFile.parent ||
      presetFile.parent.fsName !== rootFolder.fsName ||
      presetFile.exists !== true ||
      presetByteLength === null ||
      presetByteLength !== candidate.byteLength ||
      presetByteLength > MAX_PRESET_BYTES
    ) {
      return null;
    }
    return presetFile;
  } catch (_error) {
    return null;
  }
};

const isValidRequestEnvelope = (request: any) =>
  !!(
    request &&
    typeof request === "object" &&
    request.schemaVersion === 1 &&
    (request.platform === undefined || typeof request.platform === "string") &&
    typeof request.expectedHostVersion === "string" &&
    request.expectedHostVersion.length > 0 &&
    typeof request.includeDisabledTargets === "boolean" &&
    isPositiveInteger(request.stopCount) &&
    request.stopCount >= 2 &&
    request.stopCount <= 8 &&
    request.presets &&
    typeof request.presets === "object"
  );

const validateRequestPresets = (request: any) => {
  const fill = validatePresetRecord(request.presets.fill, "fill", request.stopCount);
  const stroke = validatePresetRecord(request.presets.stroke, "stroke", request.stopCount);
  return fill && stroke ? { fill, stroke } : null;
};

const isNativeGradientEvidence = (property: any) => {
  try {
    return (
      property &&
      (property.matchName === FILL_MATCH_NAME ||
        property.matchName === STROKE_MATCH_NAME ||
        property.matchName === PAYLOAD_MATCH_NAME)
    );
  } catch (_error) {
    return true;
  }
};

type ResolvedTargetState = {
  invalid: boolean;
  targets: ResolvedTarget[];
  keys: string[];
  visitedKeys: string[];
  skippedDisabledCount: number;
  preservedStateCount: number;
};

const descriptorWithinLimits = (descriptor: NativeGradientApplyTarget) => {
  if (
    descriptor.propertyIndexPath.length === 0 ||
    descriptor.propertyIndexPath.length > MAX_NATIVE_GRADIENT_DESCRIPTOR_PATH_DEPTH ||
    descriptor.propertyIndexPath.length !== descriptor.matchNamePath.length
  ) {
    return false;
  }
  for (let index = 0; index < descriptor.matchNamePath.length; index += 1) {
    const matchName = descriptor.matchNamePath[index];
    if (matchName.length === 0 || matchName.length > MAX_NATIVE_GRADIENT_MATCH_NAME_LENGTH) {
      return false;
    }
  }
  return true;
};

const appendResolvedTarget = (
  parent: any,
  payload: any,
  layer: any,
  activeItem: any,
  state: ResolvedTargetState
) => {
  try {
    const kind = nativeGradientKind(parent);
    const path = payload ? buildExactNativeGradientPropertyPath(layer, payload) : null;
    if (
      !kind ||
      !payload ||
      !path ||
      !isSamePropertySlot(payload.parentProperty, parent) ||
      !isSamePropertySlot(findExactNativeGradientPayload(parent), payload)
    ) {
      state.invalid = true;
      return;
    }

    const key = buildNativeGradientTargetKey(activeItem.id, layer, payload);
    if (!key) {
      state.invalid = true;
      return;
    }
    for (let keyIndex = 0; keyIndex < state.keys.length; keyIndex += 1) {
      if (state.keys[keyIndex] === key) return;
    }
    if (state.keys.length >= MAX_NATIVE_GRADIENT_TARGET_COUNT) {
      state.invalid = true;
      return;
    }
    state.keys.push(key);

    if (
      layer.locked !== false ||
      payload.numKeys !== 0 ||
      payload.expressionEnabled !== false
    ) {
      if (state.preservedStateCount >= MAX_NATIVE_GRADIENT_TARGET_COUNT) {
        state.invalid = true;
        return;
      }
      state.preservedStateCount += 1;
      return;
    }

    const descriptor = {
      compId: activeItem.id,
      layerId: layer.id,
      layerIndex: layer.index,
      kind,
      propertyIndexPath: path.propertyIndexPath,
      matchNamePath: path.matchNamePath,
    } satisfies NativeGradientApplyTarget;
    if (
      state.targets.length >= MAX_NATIVE_GRADIENT_TARGET_COUNT ||
      !descriptorWithinLimits(descriptor)
    ) {
      state.invalid = true;
      return;
    }
    state.targets.push({
      layer,
      parent,
      payload,
      descriptor,
    });
  } catch (_error) {
    state.invalid = true;
  }
};

const collectResolvedTargets = (
  property: any,
  layer: any,
  activeItem: any,
  state: ResolvedTargetState,
  includeDisabledTargets: boolean,
  bypassDisabledFilter = false
) => {
  if (state.invalid) return;
  if (!property) {
    state.invalid = true;
    return;
  }
  if (
    !bypassDisabledFilter &&
    !includeDisabledTargets &&
    isSelectionBranchDisabled(property)
  ) {
    if (state.skippedDisabledCount >= MAX_NATIVE_GRADIENT_TARGET_COUNT) {
      state.invalid = true;
      return;
    }
    state.skippedDisabledCount += 1;
    return;
  }

  const visitedKey = selectionScopeKey(layer, property);
  if (!visitedKey) {
    state.invalid = true;
    return;
  }
  for (let index = 0; index < state.visitedKeys.length; index += 1) {
    if (state.visitedKeys[index] === visitedKey) return;
  }
  if (state.visitedKeys.length >= MAX_NATIVE_GRADIENT_SCOPE_NODE_COUNT) {
    state.invalid = true;
    return;
  }
  state.visitedKeys.push(visitedKey);

  try {
    const parent = exactNativeGradientParent(property);
    if (parent) {
      const payload = findExactNativeGradientPayload(parent);
      appendResolvedTarget(parent, payload, layer, activeItem, state);
      return;
    }
    if (isNativeGradientEvidence(property)) {
      state.invalid = true;
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
      collectResolvedTargets(
        property.property(index),
        layer,
        activeItem,
        state,
        includeDisabledTargets,
        false
      );
      if (state.invalid) return;
    }
  } catch (_error) {
    state.invalid = true;
  }
};

const isExactNativeGradientSelection = (property: any) =>
  isExactNativeGradientPayload(property);

const resolveSelectedTargets = (activeItem: any, includeDisabledTargets: boolean) => {
  const state: ResolvedTargetState = {
    invalid: false,
    targets: [],
    keys: [],
    visitedKeys: [],
    skippedDisabledCount: 0,
    preservedStateCount: 0,
  };
  const scopes = resolveSelectedScopeRoots(activeItem, isExactNativeGradientSelection);
  if (scopes.invalid) {
    state.invalid = true;
    return state;
  }
  for (let rootIndex = 0; rootIndex < scopes.roots.length; rootIndex += 1) {
    const root = scopes.roots[rootIndex];
    collectResolvedTargets(
      root.property,
      root.layer,
      activeItem,
      state,
      includeDisabledTargets,
      root.exact
    );
    if (state.invalid) return state;
  }
  state.targets.sort((left, right) => {
    if (left.descriptor.layerIndex !== right.descriptor.layerIndex) {
      return left.descriptor.layerIndex - right.descriptor.layerIndex;
    }
    return compareSelectionPropertyPaths(left.descriptor, right.descriptor);
  });
  return state;
};

const buildSelectionPath = (layer: any, property: any): PropertyPath | null => {
  const propertyIndexPath: number[] = [];
  const matchNamePath: string[] = [];
  const visited: any[] = [];
  let current = property;

  try {
    while (current && !isSameLayerSlot(current, layer)) {
      for (let index = 0; index < visited.length; index += 1) {
        if (visited[index] === current) return null;
      }
      if (visited.length >= MAX_NATIVE_GRADIENT_DESCRIPTOR_PATH_DEPTH) return null;
      visited.push(current);

      if (
        !isPositiveInteger(current.propertyIndex) ||
        typeof current.matchName !== "string" ||
        current.matchName.length === 0 ||
        current.matchName.length > MAX_NATIVE_GRADIENT_MATCH_NAME_LENGTH
      ) {
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

const captureSelection = (activeItem: any): LayerSelectionSnapshot[] | null => {
  const snapshot: LayerSelectionSnapshot[] = [];
  try {
    if (!isPositiveInteger(activeItem.numLayers)) return null;
    for (let layerIndex = 1; layerIndex <= activeItem.numLayers; layerIndex += 1) {
      const layer = activeItem.layer(layerIndex);
      if (
        !layer ||
        !isPositiveInteger(layer.id) ||
        layer.index !== layerIndex
      ) {
        return null;
      }
      const selectedProperties = layer.selectedProperties;
      if (!selectedProperties || typeof selectedProperties.length !== "number") return null;
      if (selectedProperties.length > MAX_NATIVE_GRADIENT_TARGET_COUNT) return null;
      const properties: PropertyPath[] = [];
      for (let offset = 0; offset < selectedProperties.length; offset += 1) {
        const path = buildSelectionPath(layer, selectedProperties[offset]);
        if (!path) return null;
        properties.push(path);
      }
      snapshot.push({
        layerId: layer.id,
        layerIndex,
        selected: layer.selected === true,
        properties,
      });
    }
  } catch (_error) {
    return null;
  }
  return snapshot;
};

const resolvePropertyPath = (layer: any, path: PropertyPath) => {
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

const propertyPathsEqual = (left: PropertyPath, right: PropertyPath) => {
  if (
    left.propertyIndexPath.length !== right.propertyIndexPath.length ||
    left.matchNamePath.length !== right.matchNamePath.length
  ) {
    return false;
  }
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

const propertyPathSetsEqual = (left: PropertyPath[], right: PropertyPath[]) => {
  if (left.length !== right.length) return false;
  const matched: boolean[] = [];
  for (let index = 0; index < right.length; index += 1) matched.push(false);
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    let found = false;
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      if (!matched[rightIndex] && propertyPathsEqual(left[leftIndex], right[rightIndex])) {
        matched[rightIndex] = true;
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
};

const selectionSnapshotsEqual = (
  left: LayerSelectionSnapshot[],
  right: LayerSelectionSnapshot[]
) => {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (
      left[index].layerId !== right[index].layerId ||
      left[index].layerIndex !== right[index].layerIndex ||
      left[index].selected !== right[index].selected ||
      !propertyPathSetsEqual(left[index].properties, right[index].properties)
    ) {
      return false;
    }
  }
  return true;
};

const selectionMatchesSnapshot = (
  activeItem: any,
  expected: LayerSelectionSnapshot[]
) => {
  const actual = captureSelection(activeItem);
  return actual !== null && selectionSnapshotsEqual(actual, expected);
};

const targetSelectionSnapshot = (
  snapshot: LayerSelectionSnapshot[],
  descriptor: NativeGradientApplyTarget
) => {
  const expected: LayerSelectionSnapshot[] = [];
  let foundTargetLayer = false;
  for (let index = 0; index < snapshot.length; index += 1) {
    const entry = snapshot[index];
    const isTargetLayer =
      entry.layerId === descriptor.layerId && entry.layerIndex === descriptor.layerIndex;
    if (isTargetLayer) foundTargetLayer = true;
    expected.push({
      layerId: entry.layerId,
      layerIndex: entry.layerIndex,
      selected: isTargetLayer,
      properties: isTargetLayer
        ? [
            {
              propertyIndexPath: descriptor.propertyIndexPath,
              matchNamePath: descriptor.matchNamePath,
            },
          ]
        : [],
    });
  }
  return foundTargetLayer ? expected : null;
};

const clearSelection = (activeItem: any) => {
  for (let layerIndex = 1; layerIndex <= activeItem.numLayers; layerIndex += 1) {
    const layer = activeItem.layer(layerIndex);
    const selectedProperties = layer.selectedProperties;
    for (let offset = selectedProperties.length - 1; offset >= 0; offset -= 1) {
      selectedProperties[offset].selected = false;
    }
    layer.selected = false;
  }
};

const restoreSelection = (activeItem: any, snapshot: LayerSelectionSnapshot[]) => {
  clearSelection(activeItem);
  for (let index = 0; index < snapshot.length; index += 1) {
    const entry = snapshot[index];
    const layer = activeItem.layer(entry.layerIndex);
    if (!layer || layer.id !== entry.layerId || layer.index !== entry.layerIndex) {
      throw new Error("Selection layer drifted");
    }
    layer.selected = entry.selected;
    for (let pathIndex = 0; pathIndex < entry.properties.length; pathIndex += 1) {
      const property = resolvePropertyPath(layer, entry.properties[pathIndex]);
      if (!property) throw new Error("Selection property drifted");
      property.selected = true;
    }
  }
  if (!selectionMatchesSnapshot(activeItem, snapshot)) {
    throw new Error("Selection restoration was not exact");
  }
};

const reResolveTarget = (activeItem: any, descriptor: NativeGradientApplyTarget) => {
  try {
    if (activeItem.id !== descriptor.compId) return null;
    const layer = activeItem.layer(descriptor.layerIndex);
    if (
      !layer ||
      layer.id !== descriptor.layerId ||
      layer.index !== descriptor.layerIndex ||
      layer.locked !== false
    ) {
      return null;
    }
    const payload = resolvePropertyPath(layer, descriptor);
    const parent = payload ? exactNativeGradientParent(payload) : null;
    if (
      !payload ||
      !parent ||
      nativeGradientKind(parent) !== descriptor.kind ||
      findExactNativeGradientPayload(parent) === null ||
      payload.numKeys !== 0 ||
      payload.expressionEnabled !== false
    ) {
      return null;
    }
    return { layer, parent, payload, descriptor } as ResolvedTarget;
  } catch (_error) {
    return null;
  }
};

export const applyNativeGradientPresetToSelectedTarget = (
  request: NativeGradientApplyRequest
): NativeGradientApplyResult => {
  const hostVersion =
    typeof app !== "undefined" && app && typeof app.version === "string" ? app.version : "";
  const result = resultFor(hostVersion);
  if (!resolveNativeGradientTemplateFamily(hostVersion)) {
    return failBeforeMutation(result, "unsupported-host-version");
  }

  if (!isValidRequestEnvelope(request)) {
    return failBeforeMutation(result, "invalid-request");
  }
  if (
    request.platform !== undefined &&
    request.platform !== "darwin" &&
    request.platform !== "win32"
  ) {
    return failBeforeMutation(result, "unsupported-platform");
  }
  if (
    normalizeNativeGradientHostVersion(request.expectedHostVersion) !==
    normalizeNativeGradientHostVersion(hostVersion)
  ) {
    return failBeforeMutation(result, "host-version-drift");
  }
  const presetFiles = validateRequestPresets(request);
  if (!presetFiles) return failBeforeMutation(result, "invalid-preset");
  if (typeof app === "undefined" || !app || !app.project) {
    return failBeforeMutation(result, "no-project");
  }

  const activeItem = app.project.activeItem;
  if (
    typeof CompItem === "undefined" ||
    !activeItem ||
    !(activeItem instanceof CompItem) ||
    !isPositiveInteger(activeItem.id)
  ) {
    return failBeforeMutation(result, "no-active-comp");
  }

  const selected = resolveSelectedTargets(activeItem, request.includeDisabledTargets);
  result.selectedTargetCount = selected.targets.length;
  result.selectedPropertyCount = selected.targets.length;
  result.skippedDisabledCount = selected.skippedDisabledCount;
  result.skippedDisabledBranchCount = selected.skippedDisabledCount;
  result.preservedStateCount = selected.preservedStateCount;
  result.preservedPropertyCount = selected.preservedStateCount;
  if (selected.invalid) {
    clearSelectionEvidence(result);
    return failBeforeMutation(result, "unsupported-selected-gradient");
  }
  if (selected.targets.length === 0) {
    return failBeforeMutation(
      result,
      selected.preservedStateCount > 0
        ? "unsupported-selected-gradient"
        : "no-selected-gradient"
    );
  }

  result.target = selected.targets[0].descriptor;
  for (let index = 0; index < selected.targets.length; index += 1) {
    result.targets.push(selected.targets[index].descriptor);
  }
  const snapshot = captureSelection(activeItem);
  if (!snapshot) {
    clearSelectionEvidence(result);
    return failBeforeMutation(result, "selection-snapshot-failed");
  }
  if (!selectionMatchesSnapshot(activeItem, snapshot)) {
    clearSelectionEvidence(result);
    return failBeforeMutation(result, "selection-snapshot-failed");
  }
  for (let index = 0; index < selected.targets.length; index += 1) {
    const target = reResolveTarget(activeItem, selected.targets[index].descriptor);
    if (!target) {
      result.failedTargetIndex = index;
      result.failedPropertyIndex = index;
      return failBeforeMutation(result, "target-drift");
    }
  }

  let selectionMutationEntered = false;

  try {
    app.beginUndoGroup("Apply Chroma Relay Native Gradient");
    result.undoGroupOpened = true;
  } catch (_error) {
    result.primaryStatus = "undo-open-failed";
    result.status = result.primaryStatus;
  }

  if (result.undoGroupOpened) {
    selectionMutationEntered = true;
    let currentApplyAttempted = false;
    let currentTargetDrifted = false;
    let currentTargetIndex = -1;
    try {
      for (let targetIndex = 0; targetIndex < selected.targets.length; targetIndex += 1) {
        currentTargetIndex = targetIndex;
        const target = reResolveTarget(
          activeItem,
          selected.targets[targetIndex].descriptor
        );
        currentApplyAttempted = false;
        currentTargetDrifted = target === null;
        if (!target) throw new Error("Target drifted before apply");
        clearSelection(activeItem);
        target.layer.selected = true;
        target.payload.selected = true;
        const expectedTargetSelection = targetSelectionSnapshot(snapshot, target.descriptor);
        if (
          !expectedTargetSelection ||
          !selectionMatchesSnapshot(activeItem, expectedTargetSelection)
        ) {
          throw new Error("Target selection was not exact");
        }
        result.mutationAttempted = true;
        currentApplyAttempted = true;
        result.attemptedTargetCount += 1;
        result.attemptedPropertyCount = result.attemptedTargetCount;
        target.layer.applyPreset(presetFiles[target.descriptor.kind]);
        currentApplyAttempted = false;
        result.appliedTargetCount += 1;
        result.appliedPropertyCount = result.appliedTargetCount;
      }
      result.applyCompleted = true;
      result.primaryStatus = "ok";
    } catch (error) {
      if (currentApplyAttempted) {
        result.applyError = captureApplyError(error);
        result.unknownCompletionTargetIndex = currentTargetIndex;
        result.unknownCompletionPropertyIndex = currentTargetIndex;
      } else {
        result.failedTargetIndex = currentTargetIndex;
        result.failedPropertyIndex = currentTargetIndex;
      }
      result.primaryStatus = currentTargetDrifted
        ? "target-drift"
        : currentApplyAttempted
          ? "apply-unknown-completion"
          : "selection-mutation-failed";
    }
    result.status = result.primaryStatus;
  }

  if (selectionMutationEntered) {
    result.selectionRestoreAttempted = true;
    try {
      restoreSelection(activeItem, snapshot);
      result.selectionRestored = true;
    } catch (_error) {
      result.selectionRestored = false;
    }
  }

  if (result.undoGroupOpened) {
    result.undoGroupCloseAttempted = true;
    try {
      app.endUndoGroup();
      result.undoGroupClosed = true;
    } catch (_error) {
      result.undoGroupClosed = false;
    }
  }

  if (
    result.selectionRestoreAttempted &&
    !result.selectionRestored &&
    result.undoGroupCloseAttempted &&
    !result.undoGroupClosed
  ) {
    result.status = "finalization-failed";
  } else if (result.selectionRestoreAttempted && !result.selectionRestored) {
    result.status = "selection-restore-failed";
  } else if (result.undoGroupCloseAttempted && !result.undoGroupClosed) {
    result.status = "undo-close-failed";
  }
  return result;
};
