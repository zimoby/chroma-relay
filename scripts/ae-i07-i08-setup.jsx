(function () {
  if (!app.project) app.newProject();
  for (var existingIndex = 1; existingIndex <= app.project.numItems; existingIndex += 1) {
    if (app.project.item(existingIndex).name === "CP_I07_I08_FIXTURE") {
      return JSON.stringify({ ok: false, reason: "fixture-already-exists" });
    }
  }

  var comp = app.project.items.addComp("CP_I07_I08_FIXTURE", 640, 360, 1, 2, 24);
  var shape = comp.layers.addShape();
  shape.name = "CP_COLOR_FIXTURE";
  var root = shape.property("ADBE Root Vectors Group");
  var vectorGroup = root.addProperty("ADBE Vector Group");
  vectorGroup.name = "Selected Color Group";
  var contents = vectorGroup.property("ADBE Vectors Group");
  var fill = contents.addProperty("ADBE Vector Graphic - Fill");
  fill.name = "CP Fill A";
  var fillColor = fill.property("ADBE Vector Fill Color");

  var duplicateFill = contents.addProperty("ADBE Vector Graphic - Fill");
  duplicateFill.name = "CP Fill B";
  var duplicateColor = duplicateFill.property("ADBE Vector Fill Color");

  var keyframedFill = contents.addProperty("ADBE Vector Graphic - Fill");
  keyframedFill.name = "CP Fill C";
  var keyframedColor = keyframedFill.property("ADBE Vector Fill Color");

  var gradientCreated = false;
  var gradientColor = null;
  try {
    var gradient = contents.addProperty("ADBE Vector Graphic - G-Fill");
    gradientColor = gradient.property("ADBE Vector Grad Colors");
    gradientCreated = gradientColor !== null;
  } catch (_gradientError) {
    gradientCreated = false;
  }

  vectorGroup = root.property(1);
  contents = vectorGroup.property("ADBE Vectors Group");
  fillColor = contents.property(1).property("ADBE Vector Fill Color");
  duplicateColor = contents.property(2).property("ADBE Vector Fill Color");
  keyframedColor = contents.property(3).property("ADBE Vector Fill Color");
  gradientColor = gradientCreated
    ? contents.property(4).property("ADBE Vector Grad Colors")
    : null;

  var fixtureColor = [0.123456789, 0.345678912, 0.567891234, 1];
  fillColor.setValue(fixtureColor);
  duplicateColor.setValue(fixtureColor);
  duplicateColor.expression = "value";
  duplicateColor.expressionEnabled = true;
  keyframedColor.setValueAtTime(0, fixtureColor);
  keyframedColor.setValueAtTime(1, fixtureColor);

  var disabledGroup = root.addProperty("ADBE Vector Group");
  disabledGroup.name = "CP_DISABLED_GROUP";
  var disabledContents = disabledGroup.property("ADBE Vectors Group");
  var disabledFill = disabledContents.addProperty("ADBE Vector Graphic - Fill");
  var disabledColor = disabledFill.property("ADBE Vector Fill Color");
  disabledColor.setValue([0.82, 0.17, 0.28, 1]);
  disabledGroup.enabled = false;

  var secondShape = comp.layers.addShape();
  secondShape.name = "CP_SECOND_COLOR_FIXTURE";
  var secondRoot = secondShape.property("ADBE Root Vectors Group");
  var secondGroup = secondRoot.addProperty("ADBE Vector Group");
  var secondFill = secondGroup
    .property("ADBE Vectors Group")
    .addProperty("ADBE Vector Graphic - Fill");
  secondFill.property("ADBE Vector Fill Color").setValue([0.16, 0.74, 0.42, 1]);

  var text = comp.layers.addText("Chroma Relay text fixture");
  text.name = "CP_TEXT_FIXTURE";

  shape = null;
  secondShape = null;
  text = null;
  for (var fixtureIndex = 1; fixtureIndex <= comp.numLayers; fixtureIndex += 1) {
    var fixtureLayer = comp.layer(fixtureIndex);
    if (fixtureLayer.name === "CP_COLOR_FIXTURE") shape = fixtureLayer;
    if (fixtureLayer.name === "CP_SECOND_COLOR_FIXTURE") secondShape = fixtureLayer;
    if (fixtureLayer.name === "CP_TEXT_FIXTURE") text = fixtureLayer;
  }
  root = shape.property("ADBE Root Vectors Group");
  contents = root.property(1).property("ADBE Vectors Group");
  fillColor = contents.property(1).property("ADBE Vector Fill Color");
  duplicateColor = contents.property(2).property("ADBE Vector Fill Color");
  keyframedColor = contents.property(3).property("ADBE Vector Fill Color");
  gradientColor = gradientCreated
    ? contents.property(4).property("ADBE Vector Grad Colors")
    : null;
  disabledGroup = root.property("CP_DISABLED_GROUP");
  disabledColor = disabledGroup
    .property("ADBE Vectors Group")
    .property(1)
    .property("ADBE Vector Fill Color");
  secondFill = secondShape
    .property("ADBE Root Vectors Group")
    .property(1)
    .property("ADBE Vectors Group")
    .property(1);
  var sourceText = text.property("ADBE Text Properties").property("ADBE Text Document");

  for (var layerIndex = 1; layerIndex <= comp.numLayers; layerIndex += 1) {
    comp.layer(layerIndex).selected = false;
  }
  shape.selected = true;
  text.selected = true;
  fillColor.selected = true;
  duplicateColor.selected = true;
  keyframedColor.selected = true;
  if (gradientColor) gradientColor.selected = true;
  sourceText.selected = true;
  comp.openInViewer();

  return JSON.stringify({
    ok: true,
    compName: comp.name,
    exactColor: fillColor.value,
    duplicateColor: duplicateColor.value,
    expressionEnabled: duplicateColor.expressionEnabled,
    keyframedColor: keyframedColor.value,
    keyCount: keyframedColor.numKeys,
    gradientCreated: gradientCreated,
    disabledGroupEnabled: disabledGroup.enabled,
    disabledColor: disabledColor.value,
    secondColor: secondFill.property("ADBE Vector Fill Color").value,
    selectedLayerCount: comp.selectedLayers.length,
    shapeSelectedPropertyCount: shape.selectedProperties.length,
    textSelectedPropertyCount: text.selectedProperties.length
  });
})();
