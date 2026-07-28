import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const createHostModuleLoader = (sandboxGlobals) => {
  const modulePaths = {
    "./aeft": "src/jsx/aeft/aeft.ts",
    "./color-apply": "src/jsx/aeft/color-apply.ts",
    "./native-gradient-apply": "src/jsx/aeft/native-gradient-apply.ts",
    "./native-gradient-target": "src/jsx/aeft/native-gradient-target.ts",
    "./selection-scope": "src/jsx/aeft/selection-scope.ts",
    "./collection-status": "src/js/shared/collection-status.ts",
    "../../js/shared/native-gradient-contract.ts": "src/js/shared/native-gradient-contract.ts",
  };
  const cache = {};

  const load = (specifier) => {
    const path = modulePaths[specifier];
    if (!path) throw new Error(`unexpected require: ${specifier}`);
    if (cache[path]) return cache[path].exports;

    const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    const compiled = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES5 },
    }).outputText;
    const module = { exports: {} };
    cache[path] = module;
    vm.runInNewContext(
      compiled,
      {
        ...sandboxGlobals,
        module,
        exports: module.exports,
        require: load,
      },
      { filename: `${path}.compiled.js` }
    );
    return module.exports;
  };

  return load;
};

test("selection key set deduplicates arbitrary stable path keys safely", () => {
  const selectionScope = createHostModuleLoader({})("./selection-scope");
  const keys = selectionScope.createSelectionKeySet();
  const candidates = ["normal", "__proto__", "constructor", "toString", "$already-prefixed"];

  for (const candidate of candidates) {
    assert.equal(selectionScope.addSelectionKey(keys, candidate), true, candidate);
    assert.equal(selectionScope.addSelectionKey(keys, candidate), false, candidate);
  }
  assert.equal(keys.size, candidates.length);
});

test("selection traversal root carries copied stable path and filter state", () => {
  const selectionScope = createHostModuleLoader({})("./selection-scope");
  const layer = {
    id: 2001,
    index: 3,
    property(index) {
      return index === 1 ? group : null;
    },
  };
  const property = {
    propertyIndex: 2,
    enabled: false,
    canSetEnabled: true,
    matchName: "ADBE Vector Materials Group",
    parentProperty: null,
  };
  const group = {
    propertyIndex: 1,
    matchName: "ADBE Vector Group",
    parentProperty: null,
    property(index) {
      return index === 2 ? property : null;
    },
  };
  property.parentProperty = group;
  const path = {
    propertyIndexPath: [1, 2],
    matchNamePath: ["ADBE Vector Group", "ADBE Vector Materials Group"],
  };
  const state = selectionScope.buildSelectionTraversalRoot({
    layer,
    property,
    path,
    exact: false,
    wholeLayer: false,
  });

  assert.deepEqual(JSON.parse(JSON.stringify(state)), {
    key: "2001:3:1.2:ADBE Vector Group/ADBE Vector Materials Group",
    propertyIndexPath: [1, 2],
    matchNamePath: ["ADBE Vector Group", "ADBE Vector Materials Group"],
    disabled: true,
    materialOptions: true,
  });
  path.propertyIndexPath.push(9);
  path.matchNamePath.push("drift");
  assert.deepEqual(Array.from(state.propertyIndexPath), [1, 2]);
  assert.deepEqual(Array.from(state.matchNamePath), [
    "ADBE Vector Group",
    "ADBE Vector Materials Group",
  ]);
  assert.equal(
    selectionScope.buildSelectionTraversalRoot({
      layer,
      property,
      path: {
        propertyIndexPath: [1, 9],
        matchNamePath: ["ADBE Vector Group", "ADBE Vector Materials Group"],
      },
      exact: false,
      wholeLayer: false,
    }),
    null
  );
  assert.equal(selectionScope.isSelectionTraversalChildSlot(layer, group, property, 2, 1), true);
  property.parentProperty = {
    propertyIndex: 1,
    matchName: "ADBE Vector Group",
  };
  assert.equal(selectionScope.isSelectionTraversalChildSlot(layer, group, property, 2, 1), true);
  property.parentProperty = {
    propertyIndex: 9,
    matchName: "ADBE Vector Group",
  };
  assert.equal(selectionScope.isSelectionTraversalChildSlot(layer, group, property, 2, 1), false);
  property.parentProperty = group;
  assert.equal(selectionScope.isSelectionTraversalChildSlot(layer, group, property, 2, 128), false);
  const wholeLayerState = selectionScope.buildSelectionTraversalRoot({
    layer,
    property: layer,
    path: null,
    exact: false,
    wholeLayer: true,
  });
  assert.equal(wholeLayerState.key, "layer:2001:3");
  assert.deepEqual(Array.from(wholeLayerState.propertyIndexPath), []);
  assert.deepEqual(Array.from(wholeLayerState.matchNamePath), []);
  assert.equal(
    selectionScope.buildSelectionTraversalRoot({
      layer,
      property: layer,
      path: null,
      exact: true,
      wholeLayer: true,
    }),
    null
  );
  const throwingRoot = { layer, property, exact: false, wholeLayer: false };
  Object.defineProperty(throwingRoot, "path", {
    get() {
      throw new Error("path getter failed");
    },
  });
  assert.equal(selectionScope.buildSelectionTraversalRoot(throwingRoot), null);
  const throwingChild = {};
  Object.defineProperty(throwingChild, "propertyIndex", {
    get() {
      throw new Error("propertyIndex getter failed");
    },
  });
  assert.equal(
    selectionScope.isSelectionTraversalChildSlot(layer, group, throwingChild, 2, 1),
    false
  );
  assert.equal(selectionScope.selectionTraversalContainsProperty([group, property], property), true);
  assert.equal(selectionScope.selectionTraversalContainsProperty([group, property], layer), false);
});

const loadAeftHost = async () => {
  class CompItem {}
  class FootageItem {}
  const app = {
    project: null,
    beginUndoGroup() {},
    endUndoGroup() {},
  };
  const sandbox = {
    app,
    CompItem,
    FootageItem,
    PropertyType: { PROPERTY: 1, INDEXED_GROUP: 2, NAMED_GROUP: 3 },
    PropertyValueType: { COLOR: 1, TEXT_DOCUMENT: 2, CUSTOM_VALUE: 3, NO_VALUE: 4 },
  };
  const host = createHostModuleLoader(sandbox)("./aeft");

  const leaf = (matchName, propertyValueType, value, name = "Property") => ({
    matchName,
    name,
    propertyType: sandbox.PropertyType.PROPERTY,
    propertyValueType,
    value,
    numKeys: 0,
    expressionEnabled: false,
    parentProperty: null,
    propertyIndex: 0,
    setValue(nextValue) {
      this.value = nextValue;
    },
  });
  const group = (matchName, children, name = "Group") => {
    const property = {
      matchName,
      name,
      propertyType: sandbox.PropertyType.NAMED_GROUP,
      canSetEnabled: true,
      enabled: true,
      parentProperty: null,
      propertyIndex: 0,
      numProperties: children.length,
      property(index) {
        return children[index - 1] || null;
      },
    };
    children.forEach((child, index) => {
      child.parentProperty = property;
      child.propertyIndex = index + 1;
    });
    return property;
  };
  const makeLayer = (children, id = 2001, index = 1) => {
    const layer = group("ADBE AV Layer", children, "Layer");
    layer.id = id;
    layer.index = index;
    layer.locked = false;
    layer.selectedProperties = [];
    return layer;
  };
  const makeComp = (layers, id = 1001) => {
    const comp = new CompItem();
    comp.id = id;
    comp.selectedLayers = layers;
    comp.layer = (index) => layers[index - 1] || null;
    return comp;
  };
  const setProject = (activeItem, overrides = {}) => {
    app.project = {
      activeItem,
      dirty: false,
      file: { exists: true, fsName: "/saved/exact/project.aep" },
      selection: [],
      ...overrides,
    };
  };

  return {
    host,
    app,
    values: sandbox.PropertyValueType,
    leaf,
    group,
    makeLayer,
    makeComp,
    setProject,
  };
};

const NATIVE_GRADIENT_APPLY_SOURCE = "src/jsx/aeft/native-gradient-apply.ts";
const nativeGradientApplySourceUrl = new URL(`../${NATIVE_GRADIENT_APPLY_SOURCE}`, import.meta.url);
const hasNativeGradientApplySource = existsSync(nativeGradientApplySourceUrl);
const nativeGradientBehaviorTest = (name, fn) =>
  test(name, { skip: !hasNativeGradientApplySource }, fn);

const canonicalHostPath = (input) => {
  const parts = String(input).replace(/\\/g, "/").split("/");
  const output = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") output.pop();
    else output.push(part);
  }
  return `/${output.join("/")}`;
};

const loadNativeGradientApplyHost = ({
  kind = "fill",
  selection = "parent",
  illustratorHierarchy = false,
} = {}) => {
  const TEMP_PATH = "/private/var/folders/cp/T";
  const FILL_TOKEN = "A".repeat(32);
  const STROKE_TOKEN = "B".repeat(32);
  const events = [];
  const files = new Map();

  function Folder(path) {
    if (!(this instanceof Folder)) return new Folder(path);
    this.fsName = canonicalHostPath(path);
    this.fullName = this.fsName;
    this.name = this.fsName.substring(this.fsName.lastIndexOf("/") + 1);
    this.exists = true;
  }
  Folder.temp = new Folder(TEMP_PATH);

  function File(path) {
    if (!(this instanceof File)) return new File(path);
    this.fsName = canonicalHostPath(path);
    this.fullName = this.fsName;
    this.name = this.fsName.substring(this.fsName.lastIndexOf("/") + 1);
    this.parent = new Folder(this.fsName.substring(0, this.fsName.lastIndexOf("/")));
    const record = files.get(this.fsName);
    this.exists = !!record && record.regular === true;
    Object.defineProperty(this, "length", {
      enumerable: true,
      get() {
        return record && record.regular === true
          ? record.staleLength === true && record.metadataRefreshed !== true
            ? -1
            : record.length
          : 0;
      },
    });
    this.open = (mode) => {
      if (!record || record.regular !== true || mode !== "r") return false;
      record.metadataRefreshed = true;
      return true;
    };
    this.read = (limit) =>
      record && record.regular === true
        ? "X".repeat(Math.min(record.length, limit))
        : "";
    this.close = () => true;
  }

  class CompItem {}
  const PropertyType = { PROPERTY: 1, INDEXED_GROUP: 2, NAMED_GROUP: 3 };
  const PropertyValueType = { COLOR: 1, TEXT_DOCUMENT: 2, CUSTOM_VALUE: 3, NO_VALUE: 4 };

  const selectable = (slot) => {
    let selected = false;
    slot.failSelectionRestore = false;
    slot.ignoreSelectionFalse = false;
    slot.ignoreSelectionTrue = false;
    Object.defineProperty(slot, "selected", {
      enumerable: true,
      get() {
        return selected;
      },
      set(next) {
        const value = next === true;
        events.push(`selection:${slot.matchName || `layer-${slot.index}`}:${value}`);
        if (value && slot.failSelectionRestore) throw new Error("selection restore failed");
        if ((value && slot.ignoreSelectionTrue) || (!value && slot.ignoreSelectionFalse)) return;
        selected = value;
      },
    });
    return slot;
  };

  const leaf = (matchName, propertyValueType = PropertyValueType.CUSTOM_VALUE) =>
    selectable({
      matchName,
      name: matchName,
      propertyType: PropertyType.PROPERTY,
      propertyValueType,
      numKeys: 0,
      expressionEnabled: false,
      parentProperty: null,
      propertyIndex: 0,
    });

  const group = (matchName, children, name = matchName) => {
    const property = selectable({
      matchName,
      name,
      propertyType: PropertyType.NAMED_GROUP,
      canSetEnabled: true,
      enabled: true,
      parentProperty: null,
      propertyIndex: 0,
      numProperties: children.length,
      property(index) {
        return children[index - 1] || null;
      },
    });
    children.forEach((child, index) => {
      child.parentProperty = property;
      child.propertyIndex = index + 1;
    });
    return property;
  };

  const descendants = (property, output = []) => {
    for (let index = 1; index <= (property.numProperties || 0); index += 1) {
      const child = property.property(index);
      output.push(child);
      descendants(child, output);
    }
    return output;
  };

  const makeGradient = (gradientKind) => {
    const payload = leaf("ADBE Vector Grad Colors");
    const parent = group(
      gradientKind === "fill"
        ? "ADBE Vector Graphic - G-Fill"
        : "ADBE Vector Graphic - G-Stroke",
      [payload]
    );
    return { parent, payload };
  };

  const fill = makeGradient("fill");
  const stroke = makeGradient("stroke");
  const path = leaf("ADBE Vector Shape");
  const pathGroup = group("ADBE Vector Shape - Group", [path]);
  const nestedPath = leaf("ADBE Vector Shape");
  const nestedPathGroup = group("ADBE Vector Shape - Group", [nestedPath]);
  const nestedVectorGroup = group("ADBE Vector Group", [nestedPathGroup]);
  const mergePaths = group("ADBE Vector Filter - Merge", []);
  const userContents = illustratorHierarchy
    ? group("ADBE Vectors Group", [pathGroup, nestedVectorGroup, mergePaths, fill.parent])
    : null;
  const userGroup = group(
    "ADBE Vector Group",
    illustratorHierarchy ? [userContents] : [fill.parent, stroke.parent, pathGroup]
  );
  const siblingGradient = makeGradient("fill");
  const siblingPath = leaf("ADBE Vector Shape");
  const siblingPathGroup = group("ADBE Vector Shape - Group", [siblingPath]);
  const siblingNestedGroup = group("ADBE Vector Group", []);
  const siblingMergePaths = group("ADBE Vector Filter - Merge", []);
  const siblingContents = illustratorHierarchy
    ? group("ADBE Vectors Group", [
        siblingPathGroup,
        siblingNestedGroup,
        siblingMergePaths,
        siblingGradient.parent,
      ])
    : null;
  const siblingUserGroup = group(
    "ADBE Vector Group",
    illustratorHierarchy ? [siblingContents] : [siblingGradient.parent]
  );
  const contents = group("ADBE Root Vectors Group", [userGroup, siblingUserGroup]);
  const unrelated = leaf("ADBE Vector Fill Color", PropertyValueType.COLOR);
  const applyCalls = [];
  const layer = group("ADBE AV Layer", [contents, unrelated], "Gradient layer");
  layer.id = 2001;
  layer.index = 1;
  layer.locked = false;
  layer.throwApply = false;
  layer.applyPreset = (presetFile) => {
    events.push(`apply:${presetFile.fsName}`);
    applyCalls.push({
      path: presetFile.fsName,
      isFile: presetFile instanceof File,
      selectedLayerIds: comp.selectedLayers.map((selectedLayer) => selectedLayer.id),
      selectedPropertyMatchNames: layer.selectedProperties.map((property) => property.matchName),
    });
    if (layer.throwApply || layer.throwOnApplyCall === applyCalls.length) {
      throw new Error("applyPreset unknown completion");
    }
  };
  layer.selectedPropertiesResolver = () =>
    descendants(layer).filter((property) => property.selected === true);
  Object.defineProperty(layer, "selectedProperties", {
    get() {
      return layer.selectedPropertiesResolver();
    },
  });

  const otherProperty = leaf("ADBE Opacity", PropertyValueType.NO_VALUE);
  const otherGradient = makeGradient("stroke");
  const otherLayer = group(
    "ADBE AV Layer",
    [otherProperty, otherGradient.parent],
    "Other layer"
  );
  otherLayer.id = 2002;
  otherLayer.index = 2;
  otherLayer.locked = false;
  otherLayer.applyPreset = (presetFile) => {
    events.push(`apply:${presetFile.fsName}`);
    applyCalls.push({
      path: presetFile.fsName,
      isFile: presetFile instanceof File,
      selectedLayerIds: comp.selectedLayers.map((selectedLayer) => selectedLayer.id),
      selectedPropertyMatchNames: otherLayer.selectedProperties.map(
        (property) => property.matchName
      ),
    });
  };
  otherLayer.selectedPropertiesResolver = () =>
    descendants(otherLayer).filter((property) => property.selected === true);
  Object.defineProperty(otherLayer, "selectedProperties", {
    get() {
      return otherLayer.selectedPropertiesResolver();
    },
  });

  const layers = [layer, otherLayer];
  const comp = new CompItem();
  comp.id = 1001;
  comp.numLayers = layers.length;
  comp.layerResolver = (index) => layers[index - 1] || null;
  comp.layer = (index) => comp.layerResolver(index);
  Object.defineProperty(comp, "selectedLayers", {
    get() {
      return layers.filter((candidate) => candidate.selected === true);
    },
  });

  const app = {
    version: "25.6.6x4",
    project: {
      activeItem: comp,
      dirty: true,
      file: null,
      save() {
        throw new Error("project.save is forbidden");
      },
    },
    throwBegin: false,
    throwEnd: false,
    beginUndoGroup(label) {
      events.push(`begin:${label}`);
      if (this.throwBegin) throw new Error("beginUndoGroup failed");
    },
    endUndoGroup() {
      events.push("end");
      if (this.throwEnd) throw new Error("endUndoGroup failed");
    },
    executeCommand() {
      throw new Error("executeCommand is forbidden");
    },
  };

  const presetRecord = (presetKind, token) => {
    const rootPath = `${TEMP_PATH}/chroma-relay-native-gradient-${token}`;
    const filename = `chroma-relay-native-gradient-${token}-${presetKind}-4.ffx`;
    const presetPath = `${rootPath}/${filename}`;
    files.set(canonicalHostPath(presetPath), { regular: true, length: 128 });
    return {
      runToken: token,
      tempBasePath: TEMP_PATH,
      rootPath,
      presetPath,
      filename,
      byteLength: 128,
    };
  };
  const request = {
    schemaVersion: 1,
    expectedHostVersion: "25.6.6",
    stopCount: 4,
    includeDisabledTargets: false,
    smartApply: false,
    presets: {
      fill: presetRecord("fill", FILL_TOKEN),
      stroke: presetRecord("stroke", STROKE_TOKEN),
    },
  };

  layer.selected = true;
  otherLayer.selected = true;
  otherProperty.selected = true;
  const target = kind === "fill" ? fill : stroke;
  if (selection === "parent" || selection === "both") target.parent.selected = true;
  if (selection === "payload" || selection === "both") target.payload.selected = true;
  if (selection === "path") {
    pathGroup.selected = true;
    path.selected = true;
  }
  events.length = 0;

  const sandbox = {
    app,
    CompItem,
    File,
    Folder,
    PropertyType,
    PropertyValueType,
    alert() {
      throw new Error("alert is forbidden");
    },
  };
  const host = createHostModuleLoader(sandbox)("./native-gradient-apply");
  const invoke = () => host.applyNativeGradientPresetToSelectedTarget(request);
  const selectionSnapshot = () =>
    layers.map((candidate) => ({
      layerId: candidate.id,
      selected: candidate.selected,
      properties: descendants(candidate).map((property) => ({
        matchName: property.matchName,
        propertyIndex: property.propertyIndex,
        selected: property.selected,
      })),
    }));

  const clonePropertyWrapper = (source, parent = null) => {
    const clone = {
      matchName: source.matchName,
      name: source.name,
      propertyType: source.propertyType,
      propertyValueType: source.propertyValueType,
      numKeys: source.numKeys,
      expressionEnabled: source.expressionEnabled,
      propertyIndex: source.propertyIndex,
      parentProperty: parent,
    };
    Object.defineProperty(clone, "selected", {
      enumerable: true,
      get() {
        return source.selected;
      },
      set(value) {
        source.selected = value;
      },
    });
    if (typeof source.numProperties === "number") {
      const children = [];
      clone.numProperties = source.numProperties;
      clone.property = (index) => children[index - 1] || null;
      for (let index = 1; index <= source.numProperties; index += 1) {
        children.push(clonePropertyWrapper(source.property(index), clone));
      }
    }
    return clone;
  };
  const freshLayerWrapper = () => {
    const wrapper = clonePropertyWrapper(layer);
    wrapper.id = layer.id;
    wrapper.index = layer.index;
    wrapper.locked = layer.locked;
    wrapper.applyPreset = layer.applyPreset;
    Object.defineProperty(wrapper, "selectedProperties", {
      get() {
        return descendants(wrapper).filter((property) => property.selected === true);
      },
    });
    return wrapper;
  };

  return {
    host,
    invoke,
    request,
    files,
    app,
    comp,
    layer,
    otherLayer,
    otherProperty,
    otherGradient,
    fill,
    stroke,
    path,
    pathGroup,
    userContents,
    nestedVectorGroup,
    mergePaths,
    siblingGradient,
    siblingPath,
    siblingPathGroup,
    siblingContents,
    siblingUserGroup,
    userGroup,
    contents,
    unrelated,
    events,
    applyCalls,
    selectionSnapshot,
    freshLayerWrapper,
    TEMP_PATH,
    FILL_TOKEN,
    STROKE_TOKEN,
  };
};

const plainHostValue = (value) => JSON.parse(JSON.stringify(value));

const assertNoNativeGradientMutation = (fixture) => {
  assert.equal(fixture.applyCalls.length, 0);
  assert.equal(fixture.events.some((event) => event.startsWith("begin:")), false);
  assert.equal(fixture.events.includes("end"), false);
};

const expectedTarget = (kind, parentIndex = kind === "fill" ? 1 : 2) => ({
  compId: 1001,
  layerId: 2001,
  layerIndex: 1,
  kind,
  propertyIndexPath: [1, 1, parentIndex, 1],
  matchNamePath: [
    "ADBE Root Vectors Group",
    "ADBE Vector Group",
    kind === "fill" ? "ADBE Vector Graphic - G-Fill" : "ADBE Vector Graphic - G-Stroke",
    "ADBE Vector Grad Colors",
  ],
});

test("B2 native-gradient apply module exposes the frozen host entry point", () => {
  assert.equal(
    hasNativeGradientApplySource,
    true,
    `${NATIVE_GRADIENT_APPLY_SOURCE} must exist before the B2 host contract can pass`
  );
  const fixture = loadNativeGradientApplyHost();
  assert.equal(typeof fixture.host.applyNativeGradientPresetToSelectedTarget, "function");
});

nativeGradientBehaviorTest(
  "B2 native-gradient Fill apply accepts dirty unsaved projects and restores exact selection",
  () => {
    const fixture = loadNativeGradientApplyHost({ kind: "fill" });
    const before = fixture.selectionSnapshot();
    const result = plainHostValue(fixture.invoke());

    assert.equal(result.status, "ok");
    assert.equal(result.primaryStatus, "ok");
    assert.equal(result.hostVersion, "25.6.6x4");
    assert.deepEqual(result.target, expectedTarget("fill"));
    assert.equal(result.selectedTargetCount, 1);
    assert.equal(result.mutationAttempted, true);
    assert.equal(result.applyCompleted, true);
    assert.equal(result.undoGroupOpened, true);
    assert.equal(result.undoGroupCloseAttempted, true);
    assert.equal(result.undoGroupClosed, true);
    assert.equal(result.selectionRestoreAttempted, true);
    assert.equal(result.selectionRestored, true);
    assert.equal(fixture.applyCalls.length, 1);
    assert.equal(fixture.applyCalls[0].path, fixture.request.presets.fill.presetPath);
    assert.equal(fixture.applyCalls[0].isFile, true);
    assert.deepEqual(fixture.applyCalls[0].selectedLayerIds, [2001]);
    assert.ok(fixture.applyCalls[0].selectedPropertyMatchNames.length >= 1);
    assert.ok(
      fixture.applyCalls[0].selectedPropertyMatchNames.every(
        (matchName) =>
          matchName === "ADBE Vector Graphic - G-Fill" || matchName === "ADBE Vector Grad Colors"
      )
    );
    assert.deepEqual(fixture.selectionSnapshot(), before);
    assert.equal(fixture.events.filter((event) => event.startsWith("begin:")).length, 1);
    assert.equal(fixture.events.filter((event) => event === "end").length, 1);
    const applyIndex = fixture.events.findIndex((event) => event.startsWith("apply:"));
    const endIndex = fixture.events.indexOf("end");
    assert.ok(applyIndex >= 0 && endIndex > applyIndex);
    assert.ok(
      fixture.events.slice(applyIndex + 1, endIndex).some((event) => event.startsWith("selection:")),
      "selection must be restored before closing Undo"
    );
  }
);

nativeGradientBehaviorTest("B2 native-gradient Stroke apply chooses only the stroke lease", () => {
  const fixture = loadNativeGradientApplyHost({ kind: "stroke", selection: "payload" });
  const result = plainHostValue(fixture.invoke());
  assert.equal(result.status, "ok");
  assert.deepEqual(result.target, expectedTarget("stroke"));
  assert.equal(fixture.applyCalls.length, 1);
  assert.equal(fixture.applyCalls[0].path, fixture.request.presets.stroke.presetPath);
  assert.equal(fixture.applyCalls[0].isFile, true);
  assert.deepEqual(fixture.applyCalls[0].selectedLayerIds, [2001]);
  assert.ok(fixture.applyCalls[0].selectedPropertyMatchNames.length >= 1);
  assert.ok(
    fixture.applyCalls[0].selectedPropertyMatchNames.every(
      (matchName) =>
        matchName === "ADBE Vector Graphic - G-Stroke" || matchName === "ADBE Vector Grad Colors"
    )
  );

  const invalidUnusedLease = loadNativeGradientApplyHost({ kind: "stroke" });
  invalidUnusedLease.files.delete(canonicalHostPath(invalidUnusedLease.request.presets.fill.presetPath));
  invalidUnusedLease.invoke();
  assertNoNativeGradientMutation(invalidUnusedLease);
});

nativeGradientBehaviorTest(
  "Smart Apply stays inside the owning Illustrator group for overlapping Path selections",
  () => {
    const fixture = loadNativeGradientApplyHost({
      selection: "path",
      illustratorHierarchy: true,
    });
    fixture.otherLayer.selected = false;
    fixture.otherProperty.selected = false;

    const disabled = plainHostValue(fixture.invoke());
    assert.equal(disabled.status, "no-selected-gradient");
    assert.equal(disabled.selectedTargetCount, 0);
    assert.equal(fixture.applyCalls.length, 0);

    fixture.request.smartApply = true;
    const enabled = plainHostValue(fixture.invoke());
    assert.equal(enabled.status, "ok");
    assert.equal(enabled.selectedTargetCount, 1);
    assert.equal(enabled.appliedTargetCount, 1);
    assert.deepEqual(enabled.targets[0].propertyIndexPath, [1, 1, 1, 4, 1]);
    assert.equal(fixture.applyCalls.length, 1);

    const twoSelectedGroups = loadNativeGradientApplyHost({
      selection: "path",
      illustratorHierarchy: true,
    });
    twoSelectedGroups.otherLayer.selected = false;
    twoSelectedGroups.otherProperty.selected = false;
    twoSelectedGroups.siblingPathGroup.selected = true;
    twoSelectedGroups.siblingPath.selected = true;
    twoSelectedGroups.events.length = 0;
    twoSelectedGroups.request.smartApply = true;
    const twoSelected = plainHostValue(twoSelectedGroups.invoke());
    assert.equal(twoSelected.status, "ok");
    assert.equal(twoSelected.selectedTargetCount, 2);
    assert.equal(twoSelected.appliedTargetCount, 2);
    assert.deepEqual(
      twoSelected.targets.map((target) => target.propertyIndexPath),
      [
        [1, 1, 1, 4, 1],
        [1, 2, 1, 4, 1],
      ]
    );
    assert.equal(twoSelectedGroups.applyCalls.length, 2);

    const sharedParent = loadNativeGradientApplyHost({
      selection: "path",
      illustratorHierarchy: true,
    });
    sharedParent.otherLayer.selected = false;
    sharedParent.otherProperty.selected = false;
    sharedParent.pathGroup.selected = false;
    sharedParent.nestedVectorGroup.property(1).property(1).selected = true;
    sharedParent.events.length = 0;
    sharedParent.request.smartApply = true;
    const sharedParentResult = plainHostValue(sharedParent.invoke());
    assert.equal(sharedParentResult.status, "ok");
    assert.equal(sharedParentResult.selectedTargetCount, 1);
    assert.equal(sharedParentResult.appliedTargetCount, 1);
    assert.deepEqual(sharedParentResult.targets[0].propertyIndexPath, [1, 1, 1, 4, 1]);
    assert.equal(sharedParent.applyCalls.length, 1);
  }
);

nativeGradientBehaviorTest(
  "B2 native-gradient selection is exact, deduped, ambiguity-safe, and malformed-native fail-closed",
  () => {
    const deduped = loadNativeGradientApplyHost({ selection: "both" });
    const dedupedResult = plainHostValue(deduped.invoke());
    assert.equal(dedupedResult.status, "ok");
    assert.equal(dedupedResult.selectedTargetCount, 1);
    assert.equal(deduped.applyCalls.length, 1);

    const disabledParent = loadNativeGradientApplyHost({ kind: "fill", selection: "parent" });
    disabledParent.fill.parent.enabled = false;
    disabledParent.fill.parent.canSetEnabled = true;
    const disabledParentResult = plainHostValue(disabledParent.invoke());
    assert.equal(disabledParentResult.status, "no-selected-gradient");
    assert.equal(disabledParentResult.skippedDisabledCount, 1);
    assertNoNativeGradientMutation(disabledParent);

    const disabledPayload = loadNativeGradientApplyHost({ kind: "fill", selection: "payload" });
    disabledPayload.fill.parent.enabled = false;
    disabledPayload.fill.parent.canSetEnabled = true;
    const disabledPayloadResult = plainHostValue(disabledPayload.invoke());
    assert.equal(disabledPayloadResult.status, "ok");
    assert.equal(disabledPayloadResult.appliedTargetCount, 1);
    assert.equal(disabledPayload.applyCalls.length, 1);

    const zero = loadNativeGradientApplyHost({ selection: "none" });
    zero.layer.selected = false;
    const zeroResult = plainHostValue(zero.invoke());
    assert.equal(zeroResult.status, "no-selected-gradient");
    assertNoNativeGradientMutation(zero);

    const noProject = loadNativeGradientApplyHost();
    noProject.app.project = null;
    const noProjectResult = plainHostValue(noProject.invoke());
    assert.notEqual(noProjectResult.status, "ok");
    assertNoNativeGradientMutation(noProject);

    const noActiveComp = loadNativeGradientApplyHost();
    noActiveComp.app.project.activeItem = {};
    const noActiveCompResult = plainHostValue(noActiveComp.invoke());
    assert.notEqual(noActiveCompResult.status, "ok");
    assertNoNativeGradientMutation(noActiveComp);

    const ancestorOnly = loadNativeGradientApplyHost({ selection: "none" });
    ancestorOnly.contents.selected = true;
    ancestorOnly.events.length = 0;
    const ancestorResult = plainHostValue(ancestorOnly.invoke());
    assert.equal(ancestorResult.status, "ok");
    assert.equal(ancestorResult.selectedTargetCount, 3);
    assert.equal(ancestorOnly.applyCalls.length, 3);

    const broadAncestor = loadNativeGradientApplyHost({ kind: "fill", selection: "payload" });
    broadAncestor.otherLayer.selected = false;
    broadAncestor.otherProperty.selected = false;
    broadAncestor.userGroup.selected = true;
    broadAncestor.stroke.parent.enabled = false;
    broadAncestor.stroke.parent.canSetEnabled = true;
    const originalUserGroupProperty = broadAncestor.userGroup.property.bind(
      broadAncestor.userGroup
    );
    const broadSiblings = Array.from({ length: 1800 }, (_, index) => ({
      matchName: `ADBE Broad Sibling ${index + 1}`,
      name: `Broad Sibling ${index + 1}`,
      propertyType: 1,
      propertyValueType: 1,
      numKeys: 0,
      expressionEnabled: false,
      parentProperty: broadAncestor.userGroup,
      propertyIndex: index + 3,
      selected: false,
    }));
    broadAncestor.userGroup.numProperties = broadSiblings.length + 2;
    broadAncestor.userGroup.property = (index) =>
      index <= 2 ? originalUserGroupProperty(index) : broadSiblings[index - 3] || null;
    broadAncestor.events.length = 0;
    const broadAncestorResult = plainHostValue(broadAncestor.invoke());
    assert.equal(broadAncestorResult.status, "ok");
    assert.equal(broadAncestorResult.selectedTargetCount, 1);
    assert.equal(broadAncestor.applyCalls.length, 1);

    const multiple = loadNativeGradientApplyHost({ kind: "fill" });
    multiple.stroke.parent.selected = true;
    multiple.events.length = 0;
    const multipleResult = plainHostValue(multiple.invoke());
    assert.equal(multipleResult.status, "ok");
    assert.equal(multipleResult.selectedTargetCount, 2);
    assert.equal(multipleResult.attemptedTargetCount, 2);
    assert.equal(multipleResult.appliedTargetCount, 2);
    assert.equal(multiple.applyCalls.length, 2);

    const multipleLayers = loadNativeGradientApplyHost({ kind: "fill" });
    multipleLayers.otherProperty.selected = false;
    multipleLayers.otherGradient.parent.selected = true;
    multipleLayers.events.length = 0;
    const multipleLayerResult = plainHostValue(multipleLayers.invoke());
    assert.equal(multipleLayerResult.status, "ok");
    assert.equal(multipleLayerResult.selectedTargetCount, 2);
    assert.deepEqual(
      multipleLayerResult.targets.map((target) => target.layerId),
      [2001, 2002]
    );
    assert.equal(multipleLayers.applyCalls.length, 2);

    const malformed = loadNativeGradientApplyHost({ kind: "fill" });
    const malformedNative = {
      matchName: "ADBE Vector Graphic - G-Stroke",
      name: "Malformed native gradient",
      propertyType: 3,
      propertyIndex: 3,
      parentProperty: malformed.userGroup,
      numProperties: 0,
      property() {
        return null;
      },
      selected: true,
    };
    const originalProperty = malformed.userGroup.property.bind(malformed.userGroup);
    malformed.userGroup.numProperties = 3;
    malformed.userGroup.property = (index) =>
      index === 3 ? malformedNative : originalProperty(index);
    malformed.events.length = 0;
    const malformedResult = plainHostValue(malformed.invoke());
    assert.equal(malformedResult.status, "unsupported-selected-gradient");
    assertNoNativeGradientMutation(malformed);
  }
);

nativeGradientBehaviorTest("B2 native-gradient rejects locked, keyed, and expression targets before Undo", () => {
  const cases = [
    ["locked", (fixture) => (fixture.layer.locked = true)],
    ["keyed", (fixture) => (fixture.fill.payload.numKeys = 1)],
    ["expression", (fixture) => (fixture.fill.payload.expressionEnabled = true)],
  ];
  for (const [label, mutate] of cases) {
    const fixture = loadNativeGradientApplyHost();
    mutate(fixture);
    const result = plainHostValue(fixture.invoke());
    assert.notEqual(result.status, "ok", label);
    assert.equal(result.mutationAttempted, false, label);
    assertNoNativeGradientMutation(fixture);
  }
});

nativeGradientBehaviorTest(
  "B2 native-gradient verifies exact target selection before applyPreset",
  () => {
    const fixture = loadNativeGradientApplyHost();
    fixture.otherProperty.ignoreSelectionFalse = true;
    const result = plainHostValue(fixture.invoke());
    assert.equal(result.status, "selection-mutation-failed");
    assert.equal(result.primaryStatus, "selection-mutation-failed");
    assert.equal(result.mutationAttempted, false);
    assert.equal(fixture.applyCalls.length, 0);
  }
);

nativeGradientBehaviorTest(
  "B2 native-gradient validates schema, both leases, canonical files, sizes, and exact AE versions before Undo",
  () => {
    const invalidCases = [
      ["schema", (f) => (f.request.schemaVersion = 2)],
      ["schema-type", (f) => (f.request.schemaVersion = "1")],
      ["count-low", (f) => (f.request.stopCount = 1)],
      ["count-high", (f) => (f.request.stopCount = 9)],
      ["count-fraction", (f) => (f.request.stopCount = 2.5)],
      ["count-type", (f) => (f.request.stopCount = "4")],
      ["count-filename-mismatch", (f) => (f.request.stopCount = 2)],
      ["preset-record", (f) => (f.request.presets.fill = null)],
      ["token-case", (f) => (f.request.presets.fill.runToken = "a".repeat(32))],
      ["token-length", (f) => (f.request.presets.stroke.runToken = "B".repeat(31))],
      ["token-type", (f) => (f.request.presets.stroke.runToken = 123)],
      ["temp-base", (f) => (f.request.presets.fill.tempBasePath = "/tmp")],
      ["temp-base-type", (f) => (f.request.presets.fill.tempBasePath = null)],
      ["root-basename", (f) => (f.request.presets.fill.rootPath = `${f.TEMP_PATH}/wrong`)],
      [
        "root-traversal",
        (f) =>
          (f.request.presets.fill.rootPath =
            `${f.TEMP_PATH}/staging/../chroma-relay-native-gradient-${f.FILL_TOKEN}`),
      ],
      ["preset-traversal", (f) => (f.request.presets.fill.presetPath += "/../ignored.ffx")],
      ["filename", (f) => (f.request.presets.stroke.filename = "renamed.ffx")],
      [
        "wrong-preset-basename",
        (f) => (f.request.presets.stroke.presetPath = `${f.request.presets.stroke.rootPath}/renamed.ffx`),
      ],
      ["missing", (f) => f.files.delete(canonicalHostPath(f.request.presets.fill.presetPath))],
      [
        "not-regular-file",
        (f) => (f.files.get(canonicalHostPath(f.request.presets.fill.presetPath)).regular = false),
      ],
      ["zero-size", (f) => (f.files.get(canonicalHostPath(f.request.presets.fill.presetPath)).length = 0)],
      [
        "oversize",
        (f) => {
          f.request.presets.stroke.byteLength = 2097153;
          f.files.get(canonicalHostPath(f.request.presets.stroke.presetPath)).length = 2097153;
        },
      ],
      ["size-mismatch", (f) => (f.request.presets.fill.byteLength = 127)],
      ["size-type", (f) => (f.request.presets.fill.byteLength = "128")],
      ["version-25.60", (f) => (f.app.version = "25.60")],
      ["version-25.5", (f) => (f.app.version = "25.5")],
      ["version-26", (f) => (f.app.version = "26.0.0x1")],
      ["version-malformed", (f) => (f.app.version = "AE 25.6.6x4 beta")],
      ["version-drift", (f) => (f.request.expectedHostVersion = "25.6.5x1")],
    ];

    for (const [label, mutate] of invalidCases) {
      const fixture = loadNativeGradientApplyHost();
      mutate(fixture);
      const result = plainHostValue(fixture.invoke());
      assert.notEqual(result.status, "ok", label);
      assert.equal(result.mutationAttempted, false, label);
      assertNoNativeGradientMutation(fixture);
    }

    const staleMetadata = loadNativeGradientApplyHost();
    for (const preset of [
      staleMetadata.request.presets.fill,
      staleMetadata.request.presets.stroke,
    ]) {
      staleMetadata.files.get(canonicalHostPath(preset.presetPath)).staleLength = true;
    }
    const refreshedResult = plainHostValue(staleMetadata.invoke());
    assert.equal(refreshedResult.status, "ok");
    assert.equal(staleMetadata.applyCalls.length, 1);
  }
);

nativeGradientBehaviorTest(
  "B2 native-gradient re-resolves exact slots, rejects drift, and accepts fresh stable wrappers",
  () => {
    const drift = loadNativeGradientApplyHost();
    drift.comp.layerResolver = () => ({ ...drift.layer, id: 9999 });
    const driftResult = plainHostValue(drift.invoke());
    assert.notEqual(driftResult.status, "ok");
    assert.equal(driftResult.mutationAttempted, false);
    assertNoNativeGradientMutation(drift);

    const fresh = loadNativeGradientApplyHost();
    fresh.comp.layerResolver = (index) =>
      index === 1 ? fresh.freshLayerWrapper() : fresh.otherLayer;
    const freshResult = plainHostValue(fresh.invoke());
    assert.equal(freshResult.status, "ok");
    assert.equal(fresh.applyCalls.length, 1);
  }
);

nativeGradientBehaviorTest(
  "B2 native-gradient accepts fresh selected-property parent wrappers by stable slots",
  () => {
    const fixture = loadNativeGradientApplyHost();
    let selectedPropertyReads = 0;
    const originalResolver = fixture.layer.selectedPropertiesResolver;
    fixture.layer.selectedPropertiesResolver = () => {
      selectedPropertyReads += 1;
      return selectedPropertyReads === 1
        ? fixture.freshLayerWrapper().selectedProperties
        : originalResolver();
    };
    const result = plainHostValue(fixture.invoke());
    assert.equal(result.status, "ok");
    assert.equal(fixture.applyCalls.length, 1);
  }
);

nativeGradientBehaviorTest(
  "B2 native-gradient compares selected-property snapshots independently of read order",
  () => {
    const fixture = loadNativeGradientApplyHost();
    fixture.fill.payload.selected = true;
    let selectedPropertyReads = 0;
    const originalResolver = fixture.layer.selectedPropertiesResolver;
    fixture.layer.selectedPropertiesResolver = () => {
      selectedPropertyReads += 1;
      const selectedProperties = originalResolver();
      return selectedPropertyReads % 2 === 0
        ? selectedProperties.slice().reverse()
        : selectedProperties;
    };
    const before = fixture.selectionSnapshot();
    const result = plainHostValue(fixture.invoke());
    assert.equal(result.status, "ok");
    assert.equal(result.selectionRestored, true);
    assert.deepEqual(fixture.selectionSnapshot(), before);
    assert.equal(fixture.applyCalls.length, 1);
  }
);

nativeGradientBehaviorTest(
  "B2 native-gradient rejects scoped ancestor drift inside a fresh selected-property wrapper",
  () => {
    const fixture = loadNativeGradientApplyHost();
    const originalResolver = fixture.layer.selectedPropertiesResolver;
    let selectedPropertyReads = 0;
    fixture.layer.selectedPropertiesResolver = () => {
      selectedPropertyReads += 1;
      if (selectedPropertyReads !== 1) return originalResolver();
      const wrapper = fixture.freshLayerWrapper();
      wrapper.property(1).matchName = "ADBE Drifted Vector Group";
      return wrapper.selectedProperties;
    };
    const result = plainHostValue(fixture.invoke());
    assert.equal(result.status, "target-drift");
    assert.equal(result.mutationAttempted, false);
    assertNoNativeGradientMutation(fixture);
  }
);

nativeGradientBehaviorTest(
  "B2 native-gradient validates the complete selection snapshot before Undo",
  () => {
    const fixture = loadNativeGradientApplyHost();
    let nonTargetReads = 0;
    fixture.otherLayer.selectedPropertiesResolver = () => {
      nonTargetReads += 1;
      if (nonTargetReads === 3) fixture.otherProperty.matchName = "ADBE Drifted Opacity";
      return fixture.otherProperty.selected ? [fixture.otherProperty] : [];
    };
    const result = plainHostValue(fixture.invoke());
    assert.equal(result.status, "selection-snapshot-failed");
    assert.equal(result.mutationAttempted, false);
    assertNoNativeGradientMutation(fixture);
  }
);

nativeGradientBehaviorTest(
  "B2 native-gradient treats applyPreset throws as unknown completion without retry and still finalizes",
  () => {
    const fixture = loadNativeGradientApplyHost();
    const before = fixture.selectionSnapshot();
    fixture.layer.throwApply = true;
    const result = plainHostValue(fixture.invoke());
    assert.equal(result.status, "apply-unknown-completion");
    assert.equal(result.primaryStatus, "apply-unknown-completion");
    assert.equal(result.mutationAttempted, true);
    assert.equal(result.applyCompleted, false);
    assert.deepEqual(result.applyError, {
      name: "Error",
      message: "applyPreset unknown completion",
      line: null,
      number: null,
    });
    assert.equal(result.selectionRestoreAttempted, true);
    assert.equal(result.selectionRestored, true);
    assert.equal(result.undoGroupCloseAttempted, true);
    assert.equal(result.undoGroupClosed, true);
    assert.equal(fixture.applyCalls.length, 1);
    assert.deepEqual(fixture.selectionSnapshot(), before);
    assert.equal(fixture.events.filter((event) => event === "end").length, 1);
  }
);

nativeGradientBehaviorTest(
  "B2 multi-target gradient apply stops after an unknown second completion",
  () => {
    const fixture = loadNativeGradientApplyHost({ selection: "multiple" });
    const before = fixture.selectionSnapshot();
    fixture.layer.throwOnApplyCall = 2;
    const result = plainHostValue(fixture.invoke());
    assert.equal(result.status, "apply-unknown-completion");
    assert.equal(result.attemptedTargetCount, 2);
    assert.equal(result.appliedTargetCount, 1);
    assert.equal(result.unknownCompletionTargetIndex, 1);
    assert.equal(result.failedTargetIndex, null);
    assert.equal(result.applyCompleted, false);
    assert.equal(fixture.applyCalls.length, 2);
    assert.deepEqual(fixture.selectionSnapshot(), before);
    assert.equal(fixture.events.filter((event) => event === "end").length, 1);
  }
);

nativeGradientBehaviorTest(
  "B2 multi-target gradient re-resolves each target after prior mutation",
  () => {
    const fixture = loadNativeGradientApplyHost({ selection: "multiple" });
    const originalApplyPreset = fixture.layer.applyPreset;
    fixture.layer.applyPreset = function (file) {
      originalApplyPreset.call(this, file);
      if (fixture.applyCalls.length === 1) {
        fixture.stroke.parent.matchName = "ADBE Vector Graphic - G-Fill";
      }
    };

    const result = plainHostValue(fixture.invoke());
    assert.equal(result.primaryStatus, "target-drift");
    assert.equal(result.appliedTargetCount, 1);
    assert.equal(result.attemptedTargetCount, 1);
    assert.equal(result.failedTargetIndex, 1);
    assert.equal(result.unknownCompletionTargetIndex, null);
    assert.equal(fixture.applyCalls.length, 1);
  }
);

nativeGradientBehaviorTest(
  "B2 native-gradient verifies restoration instead of trusting silent setters",
  () => {
    const fixture = loadNativeGradientApplyHost();
    fixture.otherProperty.ignoreSelectionTrue = true;
    const result = plainHostValue(fixture.invoke());
    assert.equal(result.primaryStatus, "ok");
    assert.equal(result.status, "selection-restore-failed");
    assert.equal(result.selectionRestoreAttempted, true);
    assert.equal(result.selectionRestored, false);
    assert.equal(fixture.applyCalls.length, 1);
  }
);

nativeGradientBehaviorTest(
  "B2 native-gradient begin/finalizer failures preserve primary status and exact Undo ownership",
  () => {
    const beginFailure = loadNativeGradientApplyHost();
    beginFailure.app.throwBegin = true;
    const beginResult = plainHostValue(beginFailure.invoke());
    assert.equal(beginResult.undoGroupOpened, false);
    assert.equal(beginResult.undoGroupCloseAttempted, false);
    assert.equal(beginResult.undoGroupClosed, false);
    assert.equal(beginResult.mutationAttempted, false);
    assert.equal(beginFailure.events.filter((event) => event === "end").length, 0);
    assert.equal(beginFailure.events.filter((event) => event.startsWith("selection:")).length, 0);
    assert.equal(beginFailure.applyCalls.length, 0);

    const finalizerFailure = loadNativeGradientApplyHost();
    finalizerFailure.otherProperty.failSelectionRestore = true;
    finalizerFailure.app.throwEnd = true;
    const finalizerResult = plainHostValue(finalizerFailure.invoke());
    assert.equal(finalizerResult.primaryStatus, "ok");
    assert.notEqual(finalizerResult.status, finalizerResult.primaryStatus);
    assert.equal(finalizerResult.mutationAttempted, true);
    assert.equal(finalizerResult.applyCompleted, true);
    assert.equal(finalizerResult.selectionRestoreAttempted, true);
    assert.equal(finalizerResult.selectionRestored, false);
    assert.equal(finalizerResult.undoGroupCloseAttempted, true);
    assert.equal(finalizerResult.undoGroupClosed, false);
    assert.equal(finalizerFailure.applyCalls.length, 1);
    assert.equal(finalizerFailure.events.filter((event) => event === "end").length, 1);
  }
);

nativeGradientBehaviorTest("B2 native-gradient classifies request envelopes separately from presets", () => {
  const invalidRequest = loadNativeGradientApplyHost();
  invalidRequest.request.schemaVersion = 2;
  assert.equal(plainHostValue(invalidRequest.invoke()).status, "invalid-request");
  assertNoNativeGradientMutation(invalidRequest);

  const invalidPreset = loadNativeGradientApplyHost();
  invalidPreset.files.delete(canonicalHostPath(invalidPreset.request.presets.fill.presetPath));
  assert.equal(plainHostValue(invalidPreset.invoke()).status, "invalid-preset");
  assertNoNativeGradientMutation(invalidPreset);
});

nativeGradientBehaviorTest("B2 native-gradient accepts Windows and rejects unknown request platforms", () => {
  const windows = loadNativeGradientApplyHost();
  windows.request.platform = "win32";
  assert.equal(plainHostValue(windows.invoke()).status, "ok");
  assert.equal(windows.applyCalls.length, 1);

  const unsupported = loadNativeGradientApplyHost();
  unsupported.request.platform = "linux";
  assert.equal(plainHostValue(unsupported.invoke()).status, "unsupported-platform");
  assertNoNativeGradientMutation(unsupported);
});

nativeGradientBehaviorTest("B2 native-gradient apply source has one bounded mutation site", async () => {
  const source = await read(NATIVE_GRADIENT_APPLY_SOURCE);
  assert.equal((source.match(/\.applyPreset\s*\(/g) || []).length, 1);
  assert.doesNotMatch(source, /\.save\s*\(/);
  assert.doesNotMatch(source, /executeCommand\s*\(/);
  assert.doesNotMatch(source, /\balert\s*\(/);
  assert.doesNotMatch(source, /\.(?:delete|remove)\s*\(/);
  assert.doesNotMatch(source, /\.setValue(?:AtTime)?\s*\(/);
  assert.doesNotMatch(source, /\.activeItem\s*=/);
});

test("collector is read-only and has explicit unsupported-property branches", async () => {
  const source = await read("src/jsx/aeft/aeft.ts");
  assert.match(source, /PropertyValueType\.COLOR/);
  assert.match(source, /PropertyValueType\.TEXT_DOCUMENT/);
  assert.match(source, /unsupportedGradientCount/);
  assert.doesNotMatch(source, /\.setValue(?:AtTime)?\s*\(/);
  assert.doesNotMatch(source, /beginUndoGroup\s*\(/);
  assert.doesNotMatch(source, /\balert\s*\(/);
});

test("collector keeps renamed and effect colors while counting one exact native parent", async () => {
  const { host, values, leaf, group, makeLayer, makeComp, setProject } = await loadAeftHost();
  const renamedColor = leaf("ADBE Vector Fill Color", values.COLOR, [0.1, 0.2, 0.3, 1]);
  const renamedGroup = group("ADBE Vector Group", [renamedColor], "My Gradient Group");
  const rampColor = leaf("ADBE Ramp-0001", values.COLOR, [0.4, 0.5, 0.6, 1]);
  const ramp = group("ADBE Ramp", [rampColor], "Gradient Ramp");
  const fourColor = leaf("ADBE 4ColorGradient-0001", values.COLOR, [0.7, 0.8, 0.9, 1]);
  const fourColorGroup = group("ADBE 4ColorGradient", [fourColor], "4-Color Gradient");
  const malformedColor = leaf("ADBE Vector Fill Color", values.COLOR, [0.9, 0.1, 0.2, 1]);
  const malformedNative = group("ADBE Vector Graphic - G-Fill", [malformedColor]);
  const payload = leaf("ADBE Vector Grad Colors", values.CUSTOM_VALUE, null);
  const nativeGeometryColor = leaf("ADBE Vector Grad Start Pt", values.COLOR, [1, 1, 1, 1]);
  const nativeFill = group("ADBE Vector Graphic - G-Fill", [payload, nativeGeometryColor]);
  const namedUnsupported = leaf("ADBE Custom Value", values.NO_VALUE, null, "Gradient Colors");
  const layer = makeLayer([
    renamedGroup,
    ramp,
    fourColorGroup,
    malformedNative,
    nativeFill,
    namedUnsupported,
  ]);
  layer.selectedProperties = [
    renamedGroup,
    ramp,
    fourColorGroup,
    malformedNative,
    nativeFill,
    namedUnsupported,
  ];
  setProject(makeComp([layer]));

  const result = JSON.parse(JSON.stringify(host.collectSelectedColors(true)));
  assert.equal(result.unsupportedGradientCount, 1);
  assert.equal(result.selectedPropertyCount, 6);
  assert.deepEqual(result.colors, [
    [0.1, 0.2, 0.3, 1],
    [0.4, 0.5, 0.6, 1],
    [0.7, 0.8, 0.9, 1],
    [0.9, 0.1, 0.2, 1],
  ]);
});

test("solid collection and apply preserve null-child ignore policy", async () => {
  const { host, values, leaf, group, makeLayer, makeComp, setProject } = await loadAeftHost();
  const hiddenColor = leaf("ADBE Vector Fill Color", values.COLOR, [0.2, 0.3, 0.4, 1]);
  const malformedGroup = group("ADBE Vectors Group", [hiddenColor], "Contents");
  malformedGroup.property = () => null;
  const layer = makeLayer([malformedGroup], 4951, 1);
  setProject(makeComp([layer], 4950));

  const collected = JSON.parse(JSON.stringify(host.collectSelectedColors(false)));
  assert.equal(collected.status, "no-supported-colors");
  assert.equal(collected.selectedPropertyCount, 0);
  assert.equal(collected.readErrorCount, 0);
  assert.deepEqual(collected.colors, []);

  const applied = JSON.parse(
    JSON.stringify(host.applyColorToSelectedProperties([0.8, 0.7, 0.6, 1], false, false))
  );
  assert.equal(applied.status, "no-supported-colors");
  assert.equal(applied.failedCount, 0);
  assert.equal(applied.appliedCount, 0);
});

test("collector excludes material defaults and a disabled Stroke beside a native gradient", async () => {
  const { host, values, leaf, group, makeLayer, makeComp, setProject } = await loadAeftHost();
  const payload = leaf("ADBE Vector Grad Colors", values.CUSTOM_VALUE, null, "Colors");
  const nativeFill = group("ADBE Vector Graphic - G-Fill", [payload], "Gradient Fill 1");
  const disabledStrokeColor = leaf(
    "ADBE Vector Stroke Color",
    values.COLOR,
    [1, 1, 1, 1],
    "Color"
  );
  const disabledStroke = group(
    "ADBE Vector Graphic - Stroke",
    [disabledStrokeColor],
    "Stroke 1"
  );
  disabledStroke.enabled = false;
  const vectorMaterials = group(
    "ADBE Vector Materials Group",
    [
      leaf("ADBE Vec3D Front RGB", values.COLOR, [1, 0, 0, 1], "Front Color"),
      leaf("ADBE Vec3D Bevel RGB", values.COLOR, [1, 0, 0, 1], "Bevel Color"),
      leaf("ADBE Vec3D Side RGB", values.COLOR, [1, 0, 0, 1], "Side Color"),
      leaf("ADBE Vec3D Back RGB", values.COLOR, [1, 0, 0, 1], "Back Color"),
    ],
    "Material Options"
  );
  const contents = group("ADBE Vectors Group", [disabledStroke, nativeFill], "Contents");
  const rectangle = group(
    "ADBE Vector Group",
    [contents, vectorMaterials],
    "Rectangle 1"
  );
  const layerMaterials = group(
    "ADBE Material Options Group",
    [leaf("ADBE Shadow Color", values.COLOR, [0, 0, 0, 1], "Shadow Color")],
    "Material Options"
  );
  const rootContents = group("ADBE Root Vectors Group", [rectangle], "Contents");
  const layer = makeLayer([rootContents, layerMaterials]);
  layer.selectedProperties = [rectangle, payload];
  setProject(makeComp([layer]));

  const result = JSON.parse(JSON.stringify(host.resolvePaletteAddSelection(false)));
  assert.equal(result.colors.status, "ok");
  assert.deepEqual(result.colors.colors, []);
  assert.equal(result.colors.entries.length, 1);
  assert.equal(result.colors.entries[0].type, "native-gradient");
  assert.equal(result.colors.entries[0].gradientIndex, 0);
  assert.equal(result.colors.unsupportedGradientCount, 1);
  assert.equal(result.nativeGradients.status, "ok");
  assert.equal(result.nativeGradients.descriptors.length, 1);
  assert.equal(
    result.colors.entries[0].targetKey,
    result.nativeGradients.descriptors[0].targetKey
  );
});

test("palette add selection preserves mixed traversal order and fails closed on descriptor drift", async () => {
  const { host, values, leaf, group, makeLayer, makeComp, setProject } = await loadAeftHost();
  const firstColor = leaf("ADBE Vector Fill Color", values.COLOR, [0.1, 0.2, 0.3, 1]);
  const payload = leaf("ADBE Vector Grad Colors", values.CUSTOM_VALUE, null);
  const nativeFill = group("ADBE Vector Graphic - G-Fill", [payload]);
  const lastColor = leaf("ADBE Vector Stroke Color", values.COLOR, [0.7, 0.8, 0.9, 1]);
  const layer = makeLayer([firstColor, nativeFill, lastColor], 2002, 1);
  layer.selectedProperties = [firstColor, nativeFill, lastColor];
  const comp = makeComp([layer], 1002);
  setProject(comp);

  const clean = JSON.parse(JSON.stringify(host.resolvePaletteAddSelection(true)));
  assert.deepEqual(clean.colors.colors, [
    [0.1, 0.2, 0.3, 1],
    [0.7, 0.8, 0.9, 1],
  ]);
  assert.deepEqual(
    clean.colors.entries.map(({ targetKey: _targetKey, ...entry }) => entry),
    [
      { type: "solid", colorIndex: 0 },
      { type: "native-gradient", gradientIndex: 0 },
      { type: "solid", colorIndex: 1 },
    ]
  );
  assert.equal(clean.nativeGradients.status, "ok");
  assert.equal(clean.nativeGradients.descriptors.length, 1);
  assert.equal(clean.colors.entries[1].targetKey, clean.nativeGradients.descriptors[0].targetKey);

  layer.selectedProperties = [lastColor, nativeFill, firstColor];
  const reversed = JSON.parse(JSON.stringify(host.resolvePaletteAddSelection(true)));
  assert.deepEqual(reversed.colors, clean.colors);
  assert.deepEqual(reversed.nativeGradients, clean.nativeGradients);
  layer.selectedProperties = [firstColor, nativeFill, lastColor];

  nativeFill.enabled = false;
  const disabledParent = JSON.parse(JSON.stringify(host.resolvePaletteAddSelection(false)));
  assert.deepEqual(disabledParent.colors.entries, [
    { type: "solid", colorIndex: 0 },
    { type: "solid", colorIndex: 1 },
  ]);
  assert.equal(disabledParent.nativeGradients.status, "none");

  layer.selectedProperties = [firstColor, payload, lastColor];
  const disabledExactPayload = JSON.parse(JSON.stringify(host.resolvePaletteAddSelection(false)));
  assert.deepEqual(disabledExactPayload.colors.entries, clean.colors.entries);
  assert.equal(disabledExactPayload.nativeGradients.status, "ok");

  layer.selectedProperties = [];
  const disabledRecursive = JSON.parse(JSON.stringify(host.resolvePaletteAddSelection(false)));
  assert.deepEqual(disabledRecursive.colors.entries, [
    { type: "solid", colorIndex: 0 },
    { type: "solid", colorIndex: 1 },
  ]);
  assert.deepEqual(disabledRecursive.nativeGradients, { status: "none", descriptors: [] });

  nativeFill.enabled = true;
  layer.selectedProperties = [firstColor, nativeFill, lastColor];
  setProject(comp, { dirty: true, file: { exists: true, fsName: "/saved/exact/project.aep" } });
  const dirty = JSON.parse(JSON.stringify(host.resolvePaletteAddSelection(true)));
  assert.deepEqual(dirty.colors.entries, clean.colors.entries);
  assert.deepEqual(dirty.nativeGradients, { status: "invalid", descriptors: [] });
});

test("palette add keeps duplicate solid occurrences in ordered entries while sharing one value", async () => {
  const { host, values, leaf, makeLayer, makeComp, setProject } = await loadAeftHost();
  const rgba = [0.2, 0.4, 0.6, 1];
  const fill = leaf("ADBE Vector Fill Color", values.COLOR, rgba);
  const stroke = leaf("ADBE Vector Stroke Color", values.COLOR, rgba.slice());
  const layer = makeLayer([fill, stroke], 2004, 1);
  layer.selectedProperties = [];
  setProject(makeComp([layer], 1004));

  const result = JSON.parse(JSON.stringify(host.resolvePaletteAddSelection(true)));
  assert.deepEqual(result.colors.colors, [rgba]);
  assert.deepEqual(result.colors.entries, [
    { type: "solid", colorIndex: 0 },
    { type: "solid", colorIndex: 0 },
  ]);
});

test("palette add materializes implicit default gradients without blocking serialized gradients or solids", async () => {
  const { host, values, leaf, group, makeLayer, makeComp, setProject } = await loadAeftHost();
  const firstColor = leaf("ADBE Vector Fill Color", values.COLOR, [0.1, 0.2, 0.3, 1]);
  const defaultPayload = leaf("ADBE Vector Grad Colors", values.CUSTOM_VALUE, null);
  defaultPayload.isModified = false;
  const defaultFill = group("ADBE Vector Graphic - G-Fill", [defaultPayload]);
  const serializedPayload = leaf("ADBE Vector Grad Colors", values.CUSTOM_VALUE, null);
  serializedPayload.isModified = true;
  const serializedFill = group("ADBE Vector Graphic - G-Fill", [serializedPayload]);
  const lastColor = leaf("ADBE Vector Stroke Color", values.COLOR, [0.7, 0.8, 0.9, 1]);
  const layer = makeLayer([firstColor, defaultFill, serializedFill, lastColor], 2002, 1);
  layer.selectedProperties = [];
  setProject(makeComp([layer], 1002));

  const mixed = JSON.parse(JSON.stringify(host.resolvePaletteAddSelection(true)));
  assert.deepEqual(mixed.colors.colors, [
    [0.1, 0.2, 0.3, 1],
    [0.7, 0.8, 0.9, 1],
  ]);
  assert.deepEqual(
    mixed.colors.entries.map(({ targetKey: _targetKey, ...entry }) => entry),
    [
      { type: "solid", colorIndex: 0 },
      { type: "implicit-gradient" },
      { type: "native-gradient", gradientIndex: 0 },
      { type: "solid", colorIndex: 1 },
    ]
  );
  assert.equal(mixed.colors.unsupportedGradientCount, 1);
  assert.equal(mixed.colors.unmodifiedGradientCount, 1);
  assert.equal(mixed.nativeGradients.status, "ok");
  assert.equal(mixed.nativeGradients.descriptors.length, 1);
  assert.equal(mixed.colors.entries[2].targetKey, mixed.nativeGradients.descriptors[0].targetKey);
  assert.deepEqual(Array.from(mixed.nativeGradients.descriptors[0].propertyIndexPath), [3, 1]);

  layer.selectedProperties = [defaultPayload];
  const exactDefault = JSON.parse(JSON.stringify(host.resolvePaletteAddSelection(true)));
  assert.equal(exactDefault.colors.status, "ok");
  assert.deepEqual(exactDefault.colors.colors, []);
  assert.deepEqual(exactDefault.colors.entries, [{ type: "implicit-gradient" }]);
  assert.equal(exactDefault.colors.unsupportedGradientCount, 0);
  assert.equal(exactDefault.colors.unmodifiedGradientCount, 1);
  assert.deepEqual(exactDefault.nativeGradients, { status: "none", descriptors: [] });
});

test("palette add preserves four distinct implicit Fill and Stroke defaults as ordered gradient entries", async () => {
  const { host, values, leaf, group, makeLayer, makeComp, setProject } = await loadAeftHost();
  const implicitParents = Array.from({ length: 4 }, (_, index) => {
    const payload = leaf("ADBE Vector Grad Colors", values.CUSTOM_VALUE, null);
    payload.isModified = false;
    return group(
      index % 2 === 0 ? "ADBE Vector Graphic - G-Fill" : "ADBE Vector Graphic - G-Stroke",
      [payload],
    );
  });
  const layer = makeLayer(implicitParents, 2003, 1);
  layer.selectedProperties = [];
  setProject(makeComp([layer], 1003));

  const selection = JSON.parse(JSON.stringify(host.resolvePaletteAddSelection(true)));
  assert.equal(selection.colors.status, "ok");
  assert.equal(selection.colors.unmodifiedGradientCount, 4);
  assert.equal(selection.colors.unsupportedGradientCount, 0);
  assert.deepEqual(selection.colors.entries, Array.from(
    { length: 4 },
    () => ({ type: "implicit-gradient" }),
  ));
  assert.deepEqual(selection.nativeGradients, { status: "none", descriptors: [] });
});

test("palette add retains throwing and unknown isModified states as serialized candidates", async () => {
  const { host, values, leaf, group, makeLayer, makeComp, setProject } = await loadAeftHost();
  const firstColor = leaf("ADBE Vector Fill Color", values.COLOR, [0.2, 0.3, 0.4, 1]);
  const throwingPayload = leaf("ADBE Vector Grad Colors", values.CUSTOM_VALUE, null);
  Object.defineProperty(throwingPayload, "isModified", {
    configurable: true,
    get: () => { throw new Error("unreadable isModified"); },
  });
  const unknownPayload = leaf("ADBE Vector Grad Colors", values.CUSTOM_VALUE, null);
  const layer = makeLayer([
    firstColor,
    group("ADBE Vector Graphic - G-Fill", [throwingPayload]),
    group("ADBE Vector Graphic - G-Stroke", [unknownPayload]),
  ], 2004, 1);
  layer.selectedProperties = [];
  setProject(makeComp([layer], 1004));

  const selection = JSON.parse(JSON.stringify(host.resolvePaletteAddSelection(true)));
  assert.equal(selection.colors.status, "ok");
  assert.equal(selection.colors.readErrorCount, 0);
  assert.equal(selection.colors.unmodifiedGradientCount, 0);
  assert.equal(selection.colors.unsupportedGradientCount, 2);
  assert.deepEqual(
    selection.colors.entries.map(({ targetKey: _targetKey, ...entry }) => entry),
    [
      { type: "solid", colorIndex: 0 },
      { type: "native-gradient", gradientIndex: 0 },
      { type: "native-gradient", gradientIndex: 1 },
    ],
  );
  assert.equal(selection.nativeGradients.status, "ok");
  assert.equal(selection.nativeGradients.descriptors.length, 2);
});

test("collection status distinguishes disabled capacity from enabled duplicate-or-capacity no-ops", () => {
  const status = createHostModuleLoader({})("./collection-status");
  const baseMessage = "Selected colors are already in the palette";

  assert.equal(
    status.appendCollectionSkipMessage(baseMessage, 2),
    "Selected colors are already in the palette; Skipped 2 unsupported"
  );
  assert.equal(status.appendCollectionSkipMessage(baseMessage, 0), baseMessage);
  assert.equal(
    status.collectionUnchangedMessage(null, true, true),
    "Palette does not have room for all selected items",
  );
  assert.equal(
    status.collectionUnchangedMessage(null, true, false),
    "Palette does not have room for all selected gradient stops",
  );
  assert.equal(
    status.collectionUnchangedMessage(null, false, true),
    "Palette does not have room for all selected colors",
  );
  assert.equal(
    status.collectionUnchangedMessage("selected.png", false, true),
    "Palette does not have room for all colors from selected.png",
  );
  assert.equal(
    status.collectionUnchangedMessage(null, true, true, true),
    "No items added; matching items may already exist or the palette may not have enough room",
  );
});

test("selected native gradient descriptors execute exact path and fail-closed contracts", async () => {
  const { host, values, leaf, group, makeLayer, makeComp, setProject } = await loadAeftHost();
  const payload = leaf("ADBE Vector Grad Colors", values.CUSTOM_VALUE, null);
  const nativeFill = group("ADBE Vector Graphic - G-Fill", [payload], "Renamed Fill");
  const userGroup = group("ADBE Vector Group", [nativeFill], "Duplicate Display Name");
  const contents = group("ADBE Root Vectors Group", [userGroup]);
  const layer = makeLayer([contents], 987654, 1);
  layer.selectedProperties = [nativeFill, payload];
  const comp = makeComp([layer], 123456);
  setProject(comp);

  const descriptors = JSON.parse(JSON.stringify(host.collectSelectedNativeGradientTargets()));
  assert.equal(
    descriptors[0].targetKey,
    "123456:987654:1:1.1.1.1:ADBE Root Vectors Group/ADBE Vector Group/ADBE Vector Graphic - G-Fill/ADBE Vector Grad Colors"
  );
  const { targetKey: _targetKey, ...descriptor } = descriptors[0];
  assert.deepEqual([descriptor], [
    {
      projectPath: "/saved/exact/project.aep",
      projectDirty: false,
      compId: 123456,
      layerId: 987654,
      layerIndex: 1,
      kind: "fill",
      propertyIndexPath: [1, 1, 1, 1],
      matchNamePath: [
        "ADBE Root Vectors Group",
        "ADBE Vector Group",
        "ADBE Vector Graphic - G-Fill",
        "ADBE Vector Grad Colors",
      ],
    },
  ]);

  payload.numKeys = 1;
  assert.deepEqual(JSON.parse(JSON.stringify(host.collectSelectedNativeGradientTargets())), []);
  payload.numKeys = 0;
  payload.expressionEnabled = true;
  assert.deepEqual(JSON.parse(JSON.stringify(host.collectSelectedNativeGradientTargets())), []);
  payload.expressionEnabled = false;
  layer.locked = true;
  assert.deepEqual(JSON.parse(JSON.stringify(host.collectSelectedNativeGradientTargets())), []);
  layer.locked = false;

  setProject(comp, { dirty: true, file: { exists: true, fsName: "/saved/exact/project.aep" } });
  assert.deepEqual(JSON.parse(JSON.stringify(host.collectSelectedNativeGradientTargets())), []);
  setProject(comp, { dirty: false, file: null });
  assert.deepEqual(JSON.parse(JSON.stringify(host.collectSelectedNativeGradientTargets())), []);

  layer.selectedProperties = [];
  setProject(comp);
  assert.equal(host.collectSelectedNativeGradientTargets().length, 1);

  const orphanPayload = leaf("ADBE Vector Grad Colors", values.CUSTOM_VALUE, null);
  const ordinaryGroup = group("ADBE Vector Group", [orphanPayload]);
  const invalidLayer = makeLayer([ordinaryGroup], 987655, 1);
  invalidLayer.selectedProperties = [orphanPayload];
  setProject(makeComp([invalidLayer], 123456));
  assert.deepEqual(JSON.parse(JSON.stringify(host.collectSelectedNativeGradientTargets())), []);
});

test("selected native gradient descriptors validate scoped slots across fresh AE wrappers", async () => {
  const { host, values, leaf, group, makeLayer, makeComp, setProject } = await loadAeftHost();
  const payload = leaf("ADBE Vector Grad Colors", values.CUSTOM_VALUE, null);
  const nativeFill = group("ADBE Vector Graphic - G-Fill", [payload]);
  const userGroup = group("ADBE Vector Group", [nativeFill]);
  const contents = group("ADBE Root Vectors Group", [userGroup]);
  const layer = makeLayer([contents], 987654, 1);
  layer.selectedProperties = [nativeFill, payload];
  const comp = makeComp([layer], 123456);

  const returnFreshWrappers = (parent) => {
    const stableProperty = parent.property;
    parent.property = function (index) {
      const child = stableProperty.call(this, index);
      return child ? { ...child } : child;
    };
  };
  returnFreshWrappers(nativeFill);
  returnFreshWrappers(userGroup);
  returnFreshWrappers(contents);
  returnFreshWrappers(layer);
  comp.layer = (index) => (index === 1 ? { ...layer } : null);
  setProject(comp);

  assert.deepEqual(JSON.parse(JSON.stringify(host.collectSelectedNativeGradientTargets())), [
    {
      targetKey:
        "123456:987654:1:1.1.1.1:ADBE Root Vectors Group/ADBE Vector Group/ADBE Vector Graphic - G-Fill/ADBE Vector Grad Colors",
      projectPath: "/saved/exact/project.aep",
      projectDirty: false,
      compId: 123456,
      layerId: 987654,
      layerIndex: 1,
      kind: "fill",
      propertyIndexPath: [1, 1, 1, 1],
      matchNamePath: [
        "ADBE Root Vectors Group",
        "ADBE Vector Group",
        "ADBE Vector Graphic - G-Fill",
        "ADBE Vector Grad Colors",
      ],
    },
  ]);
  const selection = JSON.parse(JSON.stringify(host.resolvePaletteAddSelection(true)));
  assert.equal(selection.colors.entries.length, 1);
  assert.equal(selection.colors.entries[0].type, "native-gradient");
  assert.equal(selection.colors.entries[0].gradientIndex, 0);
  assert.equal(selection.colors.unsupportedGradientCount, 1);
  assert.equal(selection.nativeGradients.status, "ok");
  assert.equal(selection.nativeGradients.descriptors.length, 1);
  assert.equal(
    selection.colors.entries[0].targetKey,
    selection.nativeGradients.descriptors[0].targetKey
  );
});

test("selected native gradient descriptors require clean saved stable exact identity", async () => {
  const [source, aeftSource] = await Promise.all([
    read("src/jsx/aeft/native-gradient-target.ts"),
    read("src/jsx/aeft/aeft.ts"),
  ]);

  assert.match(source, /export const collectSelectedNativeGradientTargets/);
  assert.match(source, /project\.file/);
  assert.match(source, /Project\s*&\s*\{\s*readonly dirty: boolean;?\s*\}/);
  assert.match(source, /project\.dirty !== false/);
  assert.doesNotMatch(source, /\(project as any\)\.dirty/);
  assert.match(source, /projectFile\.fsName/);
  assert.match(source, /activeItem\.id/);
  assert.match(source, /layer\.id/);
  assert.match(source, /layer\.index/);
  assert.match(source, /propertyIndexPath/);
  assert.match(source, /matchNamePath/);
  assert.match(source, /kind: NativeGradientKind/);
  assert.match(source, /resolveSelectedScopeRoots\(activeItem, isExactNativeGradientSelection\)/);
  assert.match(source, /root\.exact/);
  assert.match(source, /payload\.parentProperty/);
  assert.match(source, /isSamePropertySlot/);
  assert.match(source, /isSameLayerSlot/);
  assert.doesNotMatch(source, /parent\.property\(payload\.propertyIndex\) !== payload/);
  assert.doesNotMatch(source, /currentParent\.property\(propertyIndex\) !== current/);
  assert.doesNotMatch(source, /activeItem\.layer\(layerIndex\) !== layer/);
  assert.match(source, /layer\.locked !== false/);
  assert.match(source, /payload\.numKeys !== 0/);
  assert.match(source, /payload\.expressionEnabled !== false/);
  assert.match(source, /buildNativeGradientTargetKey\(state\.compId, layer, payload\)/);
  assert.match(source, /targetKey: key/);
  assert.doesNotMatch(source, /\.name\s*===/);
  assert.doesNotMatch(source, /nearest|offset|firstCandidate/i);
  assert.match(
    aeftSource,
    /export \{ collectSelectedNativeGradientTargets \} from "\.\/native-gradient-target";/
  );
  assert.match(
    aeftSource,
    /export type \{ NativeGradientKind, NativeGradientTargetDescriptor \} from "\.\/native-gradient-target";/
  );
  assert.doesNotMatch(aeftSource, /type NativeGradientTargetDescriptor\s*=/);
  assert.doesNotMatch(aeftSource, /const collectNativeGradientTargets/);
});

test("native gradient descriptor collection is read-only and fail-closed", async () => {
  const source = await read("src/jsx/aeft/native-gradient-target.ts");

  assert.match(source, /typeof app === "undefined"/);
  assert.match(source, /if \(state\.invalid\) return \[\];/);
  assert.match(source, /if \(descriptors\.length === 0\) return \[\];/);
  assert.doesNotMatch(source, /\.save\s*\(/);
  assert.doesNotMatch(source, /\.setValue(?:AtTime)?\s*\(/);
  assert.doesNotMatch(source, /\.applyPreset\s*\(/);
  assert.doesNotMatch(source, /beginUndoGroup\s*\(/);
  assert.doesNotMatch(source, /endUndoGroup\s*\(/);
  assert.doesNotMatch(source, /\balert\s*\(/);
  assert.doesNotMatch(source, /\.selected\s*=/);
  assert.doesNotMatch(source, /new File\s*\(/);
});

test("normal apply uses exact native Shape gradient identity and keeps effect colors solid", async () => {
  const { host, values, leaf, group, makeLayer, makeComp, setProject } = await loadAeftHost();
  const renamedColor = leaf("ADBE Vector Fill Color", values.COLOR, [0.1, 0.2, 0.3, 1]);
  const renamedGroup = group("ADBE Vector Group", [renamedColor], "My Gradient Group");
  const rampColor = leaf("ADBE Ramp-0001", values.COLOR, [0.4, 0.5, 0.6, 1]);
  const ramp = group("ADBE Ramp", [rampColor], "Gradient Ramp");
  const fourColor = leaf("ADBE 4ColorGradient-0001", values.COLOR, [0.7, 0.8, 0.9, 1]);
  const fourColorGroup = group("ADBE 4ColorGradient", [fourColor], "4-Color Gradient");
  const malformedColor = leaf("ADBE Vector Fill Color", values.COLOR, [0.9, 0.1, 0.2, 1]);
  const malformedNative = group("ADBE Vector Graphic - G-Fill", [malformedColor]);
  const payload = leaf("ADBE Vector Grad Colors", values.CUSTOM_VALUE, null);
  const nativeGeometryColor = leaf("ADBE Vector Grad Start Pt", values.COLOR, [1, 1, 1, 1]);
  const nativeFill = group("ADBE Vector Graphic - G-Fill", [payload, nativeGeometryColor]);
  const namedColor = leaf("ADBE Custom Color", values.COLOR, [0.2, 0.3, 0.4, 1], "Gradient Colors");
  const layer = makeLayer([
    renamedGroup,
    ramp,
    fourColorGroup,
    malformedNative,
    nativeFill,
    namedColor,
  ]);
  layer.selectedProperties = [
    renamedGroup,
    ramp,
    fourColorGroup,
    malformedNative,
    nativeFill,
    payload,
    namedColor,
  ];
  setProject(makeComp([layer]));

  const applied = [0.12, 0.34, 0.56, 0.78];
  const result = JSON.parse(JSON.stringify(host.applyColorToSelectedProperties(applied)));
  assert.equal(result.status, "ok");
  assert.equal(result.appliedCount, 5);
  assert.equal(result.unsupportedGradientCount, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(renamedColor.value)), applied);
  assert.deepEqual(JSON.parse(JSON.stringify(rampColor.value)), applied);
  assert.deepEqual(JSON.parse(JSON.stringify(fourColor.value)), applied);
  assert.deepEqual(JSON.parse(JSON.stringify(malformedColor.value)), applied);
  assert.deepEqual(JSON.parse(JSON.stringify(namedColor.value)), applied);
  assert.deepEqual(JSON.parse(JSON.stringify(nativeGeometryColor.value)), [1, 1, 1, 1]);
});

test("color collection and apply share exact, group, layer, multi-layer, and disabled scopes", async () => {
  const { host, values, leaf, group, makeLayer, makeComp, setProject } = await loadAeftHost();
  const exactDisabled = leaf("ADBE Vector Fill Color", values.COLOR, [0.1, 0.1, 0.1, 1]);
  const exactDisabledGroup = group("ADBE Vector Group", [exactDisabled]);
  exactDisabledGroup.enabled = false;
  exactDisabledGroup.canSetEnabled = false;
  const nestedDisabledColor = leaf(
    "ADBE Vector Stroke Color",
    values.COLOR,
    [0.2, 0.2, 0.2, 1]
  );
  const nestedDisabledGroup = group("ADBE Vector Group", [nestedDisabledColor]);
  nestedDisabledGroup.enabled = false;
  nestedDisabledGroup.canSetEnabled = false;
  const enabledColor = leaf("ADBE Vector Fill Color", values.COLOR, [0.3, 0.3, 0.3, 1]);
  const selectedGroup = group("ADBE Vector Group", [
    exactDisabledGroup,
    nestedDisabledGroup,
    enabledColor,
  ]);
  const outsideColor = leaf("ADBE Effect Color", values.COLOR, [0.4, 0.4, 0.4, 1]);
  const firstLayer = makeLayer([selectedGroup, outsideColor], 3001, 1);
  const secondLayerColor = leaf("ADBE Effect Color", values.COLOR, [0.5, 0.5, 0.5, 1]);
  const secondLayer = makeLayer([secondLayerColor], 3002, 2);

  firstLayer.selectedProperties = [exactDisabledGroup, exactDisabled];
  setProject(makeComp([firstLayer], 4001));
  const exactCollection = JSON.parse(JSON.stringify(host.collectSelectedColors(false)));
  assert.deepEqual(exactCollection.colors, [[0.1, 0.1, 0.1, 1]]);
  const exactApply = JSON.parse(
    JSON.stringify(host.applyColorToSelectedProperties([0.9, 0.1, 0.1, 1], false))
  );
  assert.equal(exactApply.appliedCount, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(exactDisabled.value)), [0.9, 0.1, 0.1, 1]);
  assert.deepEqual(JSON.parse(JSON.stringify(enabledColor.value)), [0.3, 0.3, 0.3, 1]);

  firstLayer.selectedProperties = [selectedGroup, exactDisabled];
  const unionCollection = JSON.parse(JSON.stringify(host.collectSelectedColors(false)));
  assert.deepEqual(unionCollection.colors, [
    [0.9, 0.1, 0.1, 1],
    [0.3, 0.3, 0.3, 1],
  ]);
  const unionApply = JSON.parse(
    JSON.stringify(host.applyColorToSelectedProperties([0.7, 0.2, 0.6, 1], false))
  );
  assert.equal(unionApply.appliedCount, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(exactDisabled.value)), [0.7, 0.2, 0.6, 1]);
  assert.deepEqual(JSON.parse(JSON.stringify(enabledColor.value)), [0.7, 0.2, 0.6, 1]);
  assert.deepEqual(JSON.parse(JSON.stringify(nestedDisabledColor.value)), [0.2, 0.2, 0.2, 1]);

  const duplicateLayerWrapper = { ...firstLayer, selectedProperties: [outsideColor] };
  firstLayer.selectedProperties = [outsideColor];
  const duplicateLayerComp = makeComp([firstLayer], 4003);
  duplicateLayerComp.selectedLayers = [duplicateLayerWrapper, firstLayer];
  setProject(duplicateLayerComp);
  const duplicateLayerCollection = JSON.parse(JSON.stringify(host.collectSelectedColors(false)));
  assert.deepEqual(duplicateLayerCollection.colors, [[0.4, 0.4, 0.4, 1]]);

  firstLayer.selectedProperties = [selectedGroup];
  setProject(makeComp([firstLayer], 4001));
  const groupCollection = JSON.parse(JSON.stringify(host.collectSelectedColors(false)));
  assert.deepEqual(groupCollection.colors, [[0.7, 0.2, 0.6, 1]]);
  const groupApply = JSON.parse(
    JSON.stringify(host.applyColorToSelectedProperties([0.1, 0.9, 0.1, 1], false))
  );
  assert.equal(groupApply.appliedCount, 1);
  assert.equal(groupApply.skippedDisabledCount, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(enabledColor.value)), [0.1, 0.9, 0.1, 1]);
  assert.deepEqual(JSON.parse(JSON.stringify(nestedDisabledColor.value)), [0.2, 0.2, 0.2, 1]);

  const includeDisabledApply = JSON.parse(
    JSON.stringify(host.applyColorToSelectedProperties([0.1, 0.1, 0.9, 1], true))
  );
  assert.equal(includeDisabledApply.appliedCount, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(nestedDisabledColor.value)), [0.1, 0.1, 0.9, 1]);

  firstLayer.selectedProperties = [];
  secondLayer.selectedProperties = [];
  setProject(makeComp([firstLayer, secondLayer], 4002));
  const layerCollection = JSON.parse(JSON.stringify(host.collectSelectedColors(false)));
  assert.deepEqual(layerCollection.colors, [
    [0.1, 0.1, 0.9, 1],
    [0.4, 0.4, 0.4, 1],
    [0.5, 0.5, 0.5, 1],
  ]);
  const multiLayerApply = JSON.parse(
    JSON.stringify(host.applyColorToSelectedProperties([0.8, 0.8, 0.2, 1], false))
  );
  assert.equal(multiLayerApply.appliedCount, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(outsideColor.value)), [0.8, 0.8, 0.2, 1]);
  assert.deepEqual(JSON.parse(JSON.stringify(secondLayerColor.value)), [0.8, 0.8, 0.2, 1]);
});

test("Smart Apply uses the nearest parent scope only when direct color scope is empty", async () => {
  const { host, values, leaf, group, makeLayer, makeComp, setProject } = await loadAeftHost();
  const path = leaf("ADBE Vector Shape", values.NO_VALUE, null, "Path");
  const pathGroup = group("ADBE Vector Shape - Group", [path], "Path 1");
  const fill = leaf("ADBE Vector Fill Color", values.COLOR, [0.2, 0.3, 0.4, 1]);
  const nestedPath = leaf("ADBE Vector Shape", values.NO_VALUE, null, "Nested Path");
  const nestedPathGroup = group("ADBE Vector Shape - Group", [nestedPath], "Path 2");
  const nestedVectorGroup = group("ADBE Vector Group", [nestedPathGroup], "Group 1");
  const mergePaths = group("ADBE Vector Filter - Merge", [], "Merge Paths 1");
  const contents = group(
    "ADBE Vectors Group",
    [pathGroup, nestedVectorGroup, mergePaths, fill],
    "Contents"
  );
  const userGroup = group("ADBE Vector Group", [contents], "Group A");
  const siblingColor = leaf("ADBE Vector Fill Color", values.COLOR, [0.4, 0.5, 0.6, 1]);
  const siblingContents = group("ADBE Vectors Group", [siblingColor], "Contents");
  const siblingGroup = group("ADBE Vector Group", [siblingContents], "Group B");
  const rootContents = group("ADBE Root Vectors Group", [userGroup, siblingGroup], "Contents");
  const layer = makeLayer([rootContents], 5201, 1);
  layer.selectedProperties = [pathGroup, path];
  setProject(makeComp([layer], 5200));

  const disabled = JSON.parse(
    JSON.stringify(host.applyColorToSelectedProperties([0.8, 0.1, 0.2, 1], false, false))
  );
  assert.equal(disabled.status, "no-supported-colors");
  assert.equal(disabled.appliedCount, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(fill.value)), [0.2, 0.3, 0.4, 1]);

  layer.selectedProperties = [path, pathGroup];
  const enabled = JSON.parse(
    JSON.stringify(host.applyColorToSelectedProperties([0.8, 0.1, 0.2, 1], false, true))
  );
  assert.equal(enabled.status, "ok");
  assert.equal(enabled.appliedCount, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(fill.value)), [0.8, 0.1, 0.2, 1]);
  assert.deepEqual(JSON.parse(JSON.stringify(siblingColor.value)), [0.4, 0.5, 0.6, 1]);

  layer.selectedProperties = [path, nestedPath];
  const sharedParent = JSON.parse(
    JSON.stringify(host.applyColorToSelectedProperties([0.1, 0.7, 0.9, 1], false, true))
  );
  assert.equal(sharedParent.status, "ok");
  assert.equal(sharedParent.appliedCount, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(fill.value)), [0.1, 0.7, 0.9, 1]);
  assert.deepEqual(JSON.parse(JSON.stringify(siblingColor.value)), [0.4, 0.5, 0.6, 1]);
});

test("solid apply re-resolves replaced wrappers, continues after a failed fresh target, and closes one Undo", async () => {
  const { host, values, leaf, makeLayer, makeComp, setProject, app } = await loadAeftHost();
  const first = leaf("ADBE Effect Color", values.COLOR, [0.1, 0.1, 0.1, 1]);
  const second = leaf("ADBE Effect Color", values.COLOR, [0.2, 0.2, 0.2, 1]);
  const third = leaf("ADBE Effect Color", values.COLOR, [0.3, 0.3, 0.3, 1]);
  const firstLayer = makeLayer([first], 5101, 1);
  const secondLayer = makeLayer([second], 5102, 2);
  const thirdLayer = makeLayer([third], 5103, 3);
  firstLayer.selectedProperties = [first];
  secondLayer.selectedProperties = [second];
  thirdLayer.selectedProperties = [third];
  const comp = makeComp([firstLayer, secondLayer, thirdLayer], 5100);
  let undoBegins = 0;
  let undoEnds = 0;
  let throwingFreshSetterAttempts = 0;
  const originalBeginUndoGroup = app.beginUndoGroup;
  app.beginUndoGroup = (label) => {
    undoBegins += 1;
    return originalBeginUndoGroup.call(app, label);
  };
  app.endUndoGroup = () => {
    undoEnds += 1;
  };
  let reindexed = false;
  const freshSecondColor = leaf("ADBE Effect Color", values.COLOR, [0.2, 0.2, 0.2, 1]);
  const freshThirdColor = leaf("ADBE Effect Color", values.COLOR, [0.3, 0.3, 0.3, 1]);
  freshSecondColor.setValue = () => {
    throwingFreshSetterAttempts += 1;
    throw new Error("deterministic fresh-wrapper write failure");
  };
  const freshSecondLayer = makeLayer([freshSecondColor], 5102, 3);
  const freshThirdLayer = makeLayer([freshThirdColor], 5103, 1);
  freshSecondLayer.selectedProperties = [freshSecondColor];
  freshThirdLayer.selectedProperties = [freshThirdColor];
  const originalFirstSetValue = first.setValue;
  first.setValue = (nextValue) => {
    originalFirstSetValue.call(first, nextValue);
    firstLayer.index = 2;
    secondLayer.index = 3;
    thirdLayer.index = 1;
    comp.selectedLayers = [freshThirdLayer, firstLayer, freshSecondLayer];
    reindexed = true;
  };
  comp.layer = (index) => {
    if (!reindexed) {
      return index === 1 ? firstLayer : index === 2 ? secondLayer : index === 3 ? thirdLayer : null;
    }
    return index === 1 ? freshThirdLayer : index === 2 ? firstLayer : index === 3 ? freshSecondLayer : null;
  };
  comp.selectedLayers = [firstLayer, secondLayer, thirdLayer];
  setProject(comp);

  const result = JSON.parse(
    JSON.stringify(host.applyColorToSelectedProperties([0.9, 0.8, 0.7, 1], false))
  );
  assert.equal(result.status, "ok");
  assert.equal(result.appliedCount, 2);
  assert.equal(result.failedCount, 1);
  assert.equal(throwingFreshSetterAttempts, 1);
  assert.equal(undoBegins, 1);
  assert.equal(undoEnds, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(first.value)), [0.9, 0.8, 0.7, 1]);
  assert.deepEqual(JSON.parse(JSON.stringify(second.value)), [0.2, 0.2, 0.2, 1]);
  assert.deepEqual(JSON.parse(JSON.stringify(freshThirdColor.value)), [0.9, 0.8, 0.7, 1]);
});

test("image resolver is read-only, file-identity based, and gates still JPEG or PNG", async () => {
  const source = await read("src/jsx/aeft/aeft.ts");
  assert.match(source, /resolveSelectedImage/);
  assert.match(source, /app\.project\.selection/);
  assert.match(source, /activeItem\.selectedLayers/);
  assert.match(source, /item instanceof FootageItem/);
  assert.match(source, /item\.mainSource\.isStill/);
  assert.match(source, /file\.fsName/);
  assert.match(source, /format === "jpg" \|\| format === "jpeg" \|\| format === "png"/);
  assert.match(source, /"multiple-images"/);
  assert.match(source, /"unsupported-image"/);
  assert.match(source, /resolvePaletteAddSelection/);
  assert.match(source, /selectedLayerHasStillImageSource/);
  assert.match(source, /collectSelectedColors\(includeDisabledColors, true\)/);
  assert.doesNotMatch(source, /return\s*\{\s*\.\.\.empty/);
  assert.doesNotMatch(source, /\.setValue(?:AtTime)?\s*\(/);
  assert.doesNotMatch(source, /beginUndoGroup\s*\(/);
});

test("apply owns one balanced undo group and preserves keyed or expression state", async () => {
  const source = await read("src/jsx/aeft/color-apply.ts");
  assert.equal((source.match(/beginUndoGroup\s*\(/g) || []).length, 1);
  assert.equal((source.match(/endUndoGroup\s*\(/g) || []).length, 1);
  assert.match(source, /property\.expressionEnabled/);
  assert.match(source, /property\.numKeys > 0/);
  assert.match(source, /target\.setValue\s*\(/);
  assert.doesNotMatch(source, /\.setValueAtTime\s*\(/);
  assert.doesNotMatch(source, /\balert\s*\(/);
});

test("Settings reads palette state but has no palette writer or AE host bridge", async () => {
  const [source, main, events] = await Promise.all([
    read("src/js/settings/settings.tsx"),
    read("src/js/main/main.tsx"),
    read("src/js/shared/palette-events.ts"),
  ]);
  assert.match(source, /inspectPalette/);
  assert.doesNotMatch(source, /\bsavePalette\b/);
  assert.doesNotMatch(source, /\bloadPalette\b/);
  assert.doesNotMatch(source, /promotePaletteRecovery/);
  assert.doesNotMatch(source, /\bevalTS\b/);
  assert.match(source, /scheduleSettingsPaletteCommandTimeout/);
  assert.match(source, /scheduleSettingsPaletteCommandTimeout\([\s\S]*?setStatus,/);
  assert.match(source, /beginPaletteCommandRequest/);
  assert.match(source, /persistPalette is only available on the Main panel/);
  assert.match(source, /data-testid="settings-tab-palettes"/);
  assert.match(source, /dispatchPaletteCommand/);
  assert.match(main, /listenForPaletteCommands/);
  assert.match(main, /dispatchPaletteResult/);
  assert.match(events, /PALETTE_COMMAND_EVENT/);
  assert.match(events, /PALETTE_RESULT_EVENT/);
});

test("Settings palette manager uses grip drag, expandable editors, and update-color", async () => {
  const [settings, events, main] = await Promise.all([
    read("src/js/settings/settings.tsx"),
    read("src/js/shared/palette-events.ts"),
    read("src/js/main/main.tsx"),
  ]);
  assert.doesNotMatch(settings, /color-up-/);
  assert.doesNotMatch(settings, /color-down-/);
  assert.match(settings, /color-grip-\$\{color\.id\}/);
  assert.match(settings, /aria-expanded=\{gradient \? undefined : expanded\}/);
  assert.match(settings, /aria-keyshortcuts="Alt\+ArrowUp Alt\+ArrowDown"/);
  assert.match(settings, /data-testid="palette-delete-confirm"/);
  assert.match(settings, /data-testid="palette-delete-cancel"/);
  assert.match(settings, /type: "update-color"/);
  assert.match(settings, /isDisplayRgba/);
  assert.match(settings, /formatRawRgba/);
  assert.match(events, /"update-color"/);
  assert.match(events, /isRgba\(command\.rgba\)/);
  assert.match(main, /updatePaletteColorInPalette\(/);
  assert.match(main, /"update-color": "Color updated"/);
});

test("Settings palette selector uses an in-panel listbox instead of the CEP native popup", async () => {
  const [settings, styles] = await Promise.all([
    read("src/js/settings/settings.tsx"),
    read("src/js/settings/settings.scss"),
  ]);
  assert.match(settings, /data-testid="palette-select"/);
  assert.match(settings, /aria-haspopup="listbox"/);
  assert.match(settings, /data-testid="palette-select-menu"/);
  assert.match(settings, /data-palette-option="true"/);
  assert.match(settings, /role="listbox"/);
  assert.match(settings, /role="option"/);
  assert.match(settings, /event\.key === "Escape"/);
  assert.match(settings, /"ArrowDown", "ArrowUp", "Home", "End"/);
  assert.match(settings, /document\.addEventListener\("mousedown", handleOutsideMouseDown, true\)/);
  assert.match(settings, /paletteMenuRef\.current\?\.contains\(event\.target\)/);
  assert.match(
    settings,
    /className=\{`palette-select-wrap\$\{paletteMenuOpen \? " is-open" : ""\}`\}\s+ref=\{paletteMenuRef\}/
  );
  assert.doesNotMatch(settings, /<select[\s\S]*?data-testid="palette-select"/);
  assert.match(styles, /\.palette-select-menu[\s\S]*?max-height: 144px/);
  assert.match(styles, /\.palette-select-option/);
});

test("Main rotates stored gradient previews with the responsive panel orientation", async () => {
  const main = await read("src/js/main/main.tsx");
  assert.match(
    main,
    /nativeGradientToCssPreview\(color\.gradient, orientation === "vertical" \? 180 : 90\)/
  );
  assert.match(main, /paletteSwatchBackground\(swatch, activeOrientation\)/);
  assert.match(main, /paletteSwatchBackground\(color, activeOrientation\)/);
});

test("General settings use compact grouped rows with descriptions and an iOS-style switch", async () => {
  const [settings, styles] = await Promise.all([
    read("src/js/settings/settings.tsx"),
    read("src/js/settings/settings.scss"),
  ]);
  for (const group of [
    "swatch-settings-group",
    "application-settings-group",
    "collection-settings-group",
    "image-settings-group",
  ]) {
    assert.match(settings, new RegExp(`data-testid="${group}"`));
  }
  assert.match(settings, /className="setting-copy"/);
  assert.match(settings, /className="setting-description"/);
  assert.match(settings, /className="toggle-track"/);
  assert.match(settings, /data-testid="include-disabled-colors"/);
  assert.match(settings, /data-testid="unite-duplicates"/);
  assert.match(settings, /data-testid="smart-apply"/);
  assert.match(settings, /data-testid=\{`gradient-collection-\$\{mode\}`\}/);
  assert.match(settings, /data-testid=\{`extraction-\$\{preset\}`\}/);
  assert.match(styles, /\.settings-group/);
  assert.match(styles, /\.settings-item[\s\S]*?grid-template-columns: minmax\(0, 1fr\) auto/);
  assert.match(styles, /\.toggle-track/);
  assert.match(styles, /input:checked \+ \.toggle-track/);
});

test("Palettes toolbar orders selector, New, Import, Export, Remove and Main owns import", async () => {
  const [settings, main, events, transfer] = await Promise.all([
    read("src/js/settings/settings.tsx"),
    read("src/js/main/main.tsx"),
    read("src/js/shared/palette-events.ts"),
    read("src/js/shared/palette-transfer.ts"),
  ]);

  const toolbar = [
    'data-testid="palette-select"',
    'data-testid="palette-create"',
    'data-testid="palette-import"',
    'data-testid="palette-export"',
    'data-testid="palette-delete"',
  ].map((marker) => settings.indexOf(marker));
  for (let index = 0; index < toolbar.length; index += 1) {
    assert.notEqual(toolbar[index], -1, `toolbar control ${index} must exist exactly in order`);
    if (index > 0) {
      assert.ok(
        toolbar[index] > toolbar[index - 1],
        `toolbar control ${index} must come after control ${index - 1}`
      );
    }
  }

  // Settings gathers the file and dispatches one revisioned command; Main owns
  // the import mutation and the single palette.json write.
  assert.match(settings, /type: "import-palette"/);
  assert.match(settings, /parsePortablePalette/);
  assert.match(settings, /serializePortablePalette/);
  assert.match(settings, /showOpenDialogEx/);
  assert.match(settings, /showSaveDialogEx/);
  assert.match(settings, /fileURLToPath/);
  assert.match(settings, /MAX_PALETTE_TRANSFER_BYTES/);
  assert.match(settings, /filePath !== normalized && fs\.existsSync\(filePath\)/);
  assert.doesNotMatch(settings, /\bimportPalette\b/);
  assert.match(main, /case "import-palette":\s*return importPaletteItems\(/);
  assert.match(main, /"import-palette": "Palette imported"/);
  assert.match(events, /case "import-palette":/);
  assert.match(events, /command\.name === command\.name\.trim\(\)/);
  assert.match(events, /command\.name\.length <= MAX_PALETTE_NAME_LENGTH/);
  assert.match(events, /command\.items\.every\(isPaletteImportItem\)/);
  assert.doesNotMatch(transfer, /lib\/cep|window\.|require\(/);
});

test("Settings hides an empty strip and Main owns direct default color creation", async () => {
  const [settings, styles, main, events, domain] = await Promise.all([
    read("src/js/settings/settings.tsx"),
    read("src/js/settings/settings.scss"),
    read("src/js/main/main.tsx"),
    read("src/js/shared/palette-events.ts"),
    read("src/js/shared/palette-domain.ts"),
  ]);

  assert.match(
    settings,
    /activePalette\.colors\.length > 0 \? \(\s*<div className="palette-strip-preview"/
  );
  assert.doesNotMatch(settings, /className="is-empty"/);
  assert.doesNotMatch(styles, /i\.is-empty/);
  assert.match(settings, /data-testid="color-add"/);
  assert.match(settings, /type: "add-color", paletteId: activePalette\.id/);
  assert.match(settings, /setExpandedColorId\(addedColor\.id\)/);
  assert.match(events, /\| \{ type: "add-color"; paletteId: string \}/);
  assert.match(events, /case "add-color":\s*return isEntityId\(command\.paletteId\)/);
  assert.match(main, /case "add-color":\s*return addPaletteColorToPalette\(/);
  assert.match(main, /"add-color": "Color added"/);
  assert.match(domain, /DEFAULT_NEW_PALETTE_COLOR: Rgba = \[0, 0, 0, 1\]/);
});

test("Main and Settings expose the requested compact interaction contracts", async () => {
  const [main, mainStyles, settings, layoutSettings, layoutDomain, imageDomain, packageJson] =
    await Promise.all([
    read("src/js/main/main.tsx"),
    read("src/js/main/main.scss"),
    read("src/js/settings/settings.tsx"),
    read("src/js/shared/layout-settings.ts"),
    read("src/js/shared/layout-settings-domain.ts"),
    read("src/js/shared/image-palette-domain.ts"),
    read("package.json"),
  ]);
  assert.doesNotMatch(main, /armedRemovalId/);
  assert.doesNotMatch(main, /swatch-remove/);
  assert.match(main, /data-remove-mode/);
  assert.match(main, /palette-drag-preview/);
  assert.match(main, /STATUS_TIMEOUT_MS/);
  assert.match(main, /resolvePaletteAddSelection",\s*layoutSettings\.includeDisabledColors/);
  assert.match(main, /hostActionRef\.current \|\| paletteMutationRef\.current/);
  assert.match(main, /paletteMutationRef\.current = true/);
  assert.match(main, /const baseDocument = paletteDocumentRef\.current/);
  assert.match(main, /addPaletteCollectionItems\(collectionBaseDocument, sourceItems\)/);
  assert.match(main, /paletteMutationRef\.current = false/);
  assert.match(main, /extractPaletteFromImageFile/);
  assert.match(main, /Choose selected colors or one image, not both/);
  assert.match(mainStyles, /\[data-layout-mode="fixed"\] \.palette-actions/);
  assert.match(mainStyles, /width:\s*var\(--cp-swatch-size\)/);
  assert.match(layoutSettings, /migrateLayoutSettings/);
  assert.match(layoutDomain, /includeDisabledColors:\s*boolean/);
  assert.match(layoutDomain, /LAYOUT_SETTINGS_SCHEMA_VERSION = 6/);
  assert.match(layoutDomain, /gradientCollectionMode:\s*GradientCollectionMode/);
  assert.match(layoutDomain, /smartApply:\s*boolean/);
  assert.match(layoutDomain, /uniteDuplicates:\s*boolean/);
  assert.match(layoutDomain, /extractionPreset:\s*ExtractionPreset/);
  assert.equal(
    main.match(/preserveDuplicate:\s*!layoutSettings\.uniteDuplicates/g)?.length,
    4,
  );
  assert.match(
    main,
    /extraction\.colors\.map[\s\S]*preserveDuplicate:\s*!layoutSettings\.uniteDuplicates/,
  );
  assert.match(
    main,
    /solidItem:[\s\S]*preserveDuplicate:\s*!layoutSettings\.uniteDuplicates/,
  );
  assert.match(
    main,
    /type: "gradient",[\s\S]*preserveDuplicate:\s*!layoutSettings\.uniteDuplicates/,
  );
  assert.match(
    main,
    /nativeGradientToPaletteColors[\s\S]*preserveDuplicate:\s*!layoutSettings\.uniteDuplicates/,
  );
  assert.match(
    settings,
    /checked=\{settings\.uniteDuplicates\}[\s\S]*commitSettings\(\{ uniteDuplicates: event\.currentTarget\.checked \}\)/,
  );
  assert.match(
    settings,
    /saveLayoutSettings\(next, configRoot\)[\s\S]*dispatchLayoutSettings\(next\)[\s\S]*setSettings\(next\)/,
  );
  assert.match(layoutSettings, /csi\.dispatchEvent\(event\)/);
  assert.match(main, /incoming\.revision <= current\.revision/);
  assert.match(main, /listenForLayoutSettings\(applyIncomingSettings\)/);
  assert.match(imageDomain, /neuquant-float/);
  assert.match(imageDomain, /rgbquant/);
  assert.match(imageDomain, /fallbackUsed/);
  assert.match(packageJson, /"image-q": "4\.0\.0"/);
});

test("Main splits Add and Palettes actions and swaps the color strip for inline palette selection", async () => {
  const [main, styles, designCapture] = await Promise.all([
    read("src/js/main/main.tsx"),
    read("src/js/main/main.scss"),
    read("scripts/cep-design-capture.mjs"),
  ]);

  assert.match(main, /const \[palettePickerOpen, setPalettePickerOpen\] = useState\(false\)/);
  assert.match(main, /className="palette-actions"/);
  assert.match(
    main,
    /const addActionDescription = palettePickerOpen[\s\S]*Create a palette from the current selection, or create an empty palette[\s\S]*Add colors or gradients from the current selection, or extract colors from one selected image/,
  );
  assert.match(
    main,
    /const paletteToggleDescription = palettePickerOpen[\s\S]*Show active palette colors[\s\S]*Show palettes/,
  );
  assert.match(main, /aria-label=\{addActionDescription\}[\s\S]*title=\{addActionDescription\}/);
  assert.match(
    main,
    /aria-label=\{paletteToggleDescription\}[\s\S]*title=\{paletteToggleDescription\}/,
  );
  assert.match(main, /const createPaletteMode = palettePickerOpen/);
  assert.match(main, /createPaletteMode \? createPalette\(baseDocument\) : baseDocument/);
  assert.match(main, /createPaletteMode[\s\S]*sourceItems = \[\]/);
  assert.match(main, /aria-pressed=\{palettePickerOpen\}/);
  assert.match(main, /index === 2[\s\S]*?" is-preview-selected"[\s\S]*?: ""/);
  assert.match(designCapture, /stateEvidence\.previewSelectedCount !== 1/);
  assert.match(main, /palettePickerOpen \? \([\s\S]*?className="palette-list"/);
  assert.match(main, /paletteDocument\.palettes\.map\(\(palette\) =>/);
  assert.match(main, /data-testid=\{`palette-select-\$\{palette\.id\}`\}/);
  assert.match(main, /aria-label=\{`\$\{removeMode \? "Remove" : "Select"\} \$\{palette\.name\}`\}/);
  assert.match(main, /event\.altKey \|\| removeMode[\s\S]*handleRemovePalette\(palette\.id\)/);
  assert.match(main, /removePalette\(current, paletteId\)/);
  assert.match(main, /className="palette-select-colors"/);
  assert.match(main, /palette\.colors\.map\(\(color\) =>/);
  assert.doesNotMatch(main, /palette-select-name/);
  assert.doesNotMatch(main, /palette\.colors\.slice/);
  assert.match(main, /const current = paletteDocumentRef\.current;[\s\S]*selectPalette\(current, paletteId\)/);
  assert.match(main, /setPalettePickerOpen\(false\)/);
  assert.match(styles, /\.palette-actions\s*\{/);
  assert.match(styles, /\.palette-select\s*\{/);
  assert.match(styles, /\.palette-select \+ \.palette-select/);
  assert.match(styles, /\.palette-select-colors > span/);
  assert.match(styles, /\.palette-glyph\s*\{[\s\S]*top:\s*50%[\s\S]*left:\s*50%[\s\S]*translate\(-50%, -50%\)/);
  assert.match(styles, /\[data-remove-mode="true"\] \.palette-select:not\(:disabled\)/);
  assert.match(styles, /\[data-orientation="vertical"\] \.palette-actions/);
});

test("CEP menus expose only Settings and Refresh and route context-click to Settings", async () => {
  const initCep = await read("src/js/lib/utils/init-cep.ts");

  assert.doesNotMatch(initCep, /Id="info"|Id="website"/);
  assert.doesNotMatch(initCep, /Label="Apply Active Palette as Gradient"/);
  assert.match(initCep, /Id="settings" Label="Settings…"/);
  assert.match(initCep, /Id="refresh" Label="Refresh"/);
  assert.match(initCep, /label:\s*"Settings"/);
  assert.match(initCep, /requestOpenExtension\(SETTINGS_EXTENSION_ID, ""\)/);
  assert.doesNotMatch(initCep, /label:\s*"Reload"/);
});

test("Main and Settings show status notifications only for negative outcomes", async () => {
  const [main, settings] = await Promise.all([
    read("src/js/main/main.tsx"),
    read("src/js/settings/settings.tsx"),
  ]);

  assert.doesNotMatch(main, /setLastResult\("Reading selection…"\)/);
  assert.doesNotMatch(main, /setLastResult\(`Extracting .* image palette…`\)/);
  assert.doesNotMatch(main, /setLastResult\("Applying selected color…"\)/);
  assert.doesNotMatch(main, /setLastResult\(paletteCommandMessage\(request\.command, true\)\)/);
  assert.doesNotMatch(main, /setLastResult\("Palette saved"\)/);
  assert.match(
    main,
    /setLastResult\(nativeGradientReportNeedsAttention\(report\) \? message : null\)/
  );
  assert.match(
    main,
    /setLastResult\(collectionSkipMessage\(skipped\)\)/
  );
  assert.match(main, /implicitGradient: createImplicitDefaultNativeGradient/);
  assert.match(
    main,
    /const hasGradientSelection = selection\.colors\.entries\.some\([\s\S]*entry\.type === "implicit-gradient"/,
  );
  assert.match(main, /const unchangedMessage = collectionUnchangedMessage\(/);
  assert.match(
    main,
    /appendCollectionSkipMessage\(\s*unchangedMessage,\s*skipped/
  );

  assert.match(settings, /setStatus\(result\.ok \? null : result\.message\)/);
  assert.match(settings, /setStatus\(loaded\.error\)/);
  assert.doesNotMatch(settings, /setStatus\("Saving palette…"\)/);
  assert.doesNotMatch(settings, /setStatus\("Confirm to delete this palette"\)/);
  assert.doesNotMatch(settings, /setStatus\(`Exported \$\{activePalette\.name\}`\)/);
  assert.doesNotMatch(settings, /setStatus\(`\$\{activePalette\.name\} is active`\)/);
});
