import {
  buildExactNativeGradientPropertyPath,
  exactNativeGradientParent,
  findExactNativeGradientPayload,
  nativeGradientKind,
} from "./native-gradient-target";
import type { NativeGradientKind } from "./native-gradient-target";
import {
  normalizeNativeGradientHostVersion,
  resolveNativeGradientTemplateFamily,
  type NativeGradientApplyStatus,
} from "../../js/shared/native-gradient-contract.ts";
export type { NativeGradientApplyStatus } from "../../js/shared/native-gradient-contract.ts";

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
  expectedHostVersion: string;
  stopCount: number;
  presets: {
    fill: NativeGradientPresetRecord;
    stroke: NativeGradientPresetRecord;
  };
};

export type NativeGradientApplyTarget = {
  compId: number;
  layerId: number;
  layerIndex: number;
  kind: NativeGradientKind;
  propertyIndexPath: number[];
  matchNamePath: string[];
};

export type NativeGradientApplyResult = {
  status: NativeGradientApplyStatus;
  primaryStatus: NativeGradientApplyStatus;
  hostVersion: string;
  target: NativeGradientApplyTarget | null;
  selectedTargetCount: number;
  mutationAttempted: boolean;
  applyCompleted: boolean;
  undoGroupOpened: boolean;
  undoGroupCloseAttempted: boolean;
  undoGroupClosed: boolean;
  selectionRestoreAttempted: boolean;
  selectionRestored: boolean;
  applyError: {
    name: string;
    message: string;
    line: number | null;
    number: number | null;
  } | null;
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
const MAX_APPLY_ERROR_TEXT = 1024;

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
  status: "invalid-request",
  primaryStatus: "invalid-request",
  hostVersion,
  target: null,
  selectedTargetCount: 0,
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
      MAX_APPLY_ERROR_TEXT
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

const canonicalFolderPath = (pathValue: string) => {
  const folder = new Folder(pathValue);
  return typeof folder.fsName === "string" ? folder.fsName : "";
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
    if (
      candidate.filename !== expectedFilename ||
      presetFile.fsName !== candidate.presetPath ||
      presetFile.fsName !== expectedPresetPath ||
      presetFile.name !== expectedFilename ||
      !presetFile.parent ||
      presetFile.parent.fsName !== rootFolder.fsName ||
      presetFile.exists !== true ||
      typeof (presetFile as any).length !== "number" ||
      !isFinite((presetFile as any).length) ||
      (presetFile as any).length !== candidate.byteLength ||
      (presetFile as any).length < 1 ||
      (presetFile as any).length > MAX_PRESET_BYTES
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
    typeof request.expectedHostVersion === "string" &&
    request.expectedHostVersion.length > 0 &&
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

const resolveSelectedTargets = (activeItem: any) => {
  const targets: ResolvedTarget[] = [];
  const keys: string[] = [];
  let invalid = false;

  try {
    const selectedLayers = activeItem.selectedLayers;
    if (!selectedLayers || typeof selectedLayers.length !== "number") {
      return { invalid: true, targets };
    }
    for (let layerOffset = 0; layerOffset < selectedLayers.length; layerOffset += 1) {
      const layer = selectedLayers[layerOffset];
      if (
        !layer ||
        !isPositiveInteger(layer.id) ||
        !isPositiveInteger(layer.index) ||
        !isSameLayerSlot(activeItem.layer(layer.index), layer)
      ) {
        invalid = true;
        break;
      }
      const selectedProperties = layer.selectedProperties;
      if (!selectedProperties || typeof selectedProperties.length !== "number") {
        invalid = true;
        break;
      }
      for (let offset = 0; offset < selectedProperties.length; offset += 1) {
        const selectedProperty = selectedProperties[offset];
        const parent = exactNativeGradientParent(selectedProperty);
        if (!parent) {
          if (isNativeGradientEvidence(selectedProperty)) invalid = true;
          continue;
        }

        const kind = nativeGradientKind(parent);
        const payload = findExactNativeGradientPayload(parent);
        const path = payload ? buildExactNativeGradientPropertyPath(layer, payload) : null;
        if (!kind || !payload || !path) {
          invalid = true;
          continue;
        }
        if (
          layer.locked !== false ||
          payload.numKeys !== 0 ||
          payload.expressionEnabled !== false
        ) {
          invalid = true;
          continue;
        }

        const key = activeItem.id + ":" + layer.id + ":" + path.propertyIndexPath.join(".");
        let duplicate = false;
        for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
          if (keys[keyIndex] === key) duplicate = true;
        }
        if (duplicate) continue;
        keys.push(key);
        targets.push({
          layer,
          parent,
          payload,
          descriptor: {
            compId: activeItem.id,
            layerId: layer.id,
            layerIndex: layer.index,
            kind,
            propertyIndexPath: path.propertyIndexPath,
            matchNamePath: path.matchNamePath,
          },
        });
      }
    }
  } catch (_error) {
    invalid = true;
  }
  return { invalid, targets };
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
      if (visited.length >= 128) return null;
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

  const selected = resolveSelectedTargets(activeItem);
  result.selectedTargetCount = selected.targets.length;
  if (selected.invalid) return failBeforeMutation(result, "unsupported-selected-gradient");
  if (selected.targets.length === 0) {
    return failBeforeMutation(result, "no-selected-gradient");
  }
  if (selected.targets.length !== 1) {
    return failBeforeMutation(result, "ambiguous-selected-gradient");
  }

  result.target = selected.targets[0].descriptor;
  const snapshot = captureSelection(activeItem);
  if (!snapshot) return failBeforeMutation(result, "selection-snapshot-failed");
  if (!selectionMatchesSnapshot(activeItem, snapshot)) {
    return failBeforeMutation(result, "selection-snapshot-failed");
  }
  const target = reResolveTarget(activeItem, selected.targets[0].descriptor);
  if (!target) return failBeforeMutation(result, "target-drift");

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
    try {
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
      target.layer.applyPreset(presetFiles[target.descriptor.kind]);
      result.applyCompleted = true;
      result.primaryStatus = "ok";
    } catch (error) {
      if (result.mutationAttempted) result.applyError = captureApplyError(error);
      result.primaryStatus = result.mutationAttempted
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
