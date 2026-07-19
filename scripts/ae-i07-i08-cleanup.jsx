(function () {
  if (!app.project) return JSON.stringify({ ok: true, removed: false });
  var removed = false;
  for (var index = app.project.numItems; index >= 1; index -= 1) {
    var item = app.project.item(index);
    if (item && item.name === "CP_I07_I08_FIXTURE") {
      item.remove();
      removed = true;
    }
  }
  return JSON.stringify({ ok: true, removed: removed, remainingItems: app.project.numItems });
})();
