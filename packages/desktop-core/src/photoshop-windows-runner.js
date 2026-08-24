(function () {
  function writeResult(value) {
    WScript.StdOut.Write(JSON.stringify(value));
  }

  function readText(path) {
    var fileSystem = new ActiveXObject('Scripting.FileSystemObject');
    var file = fileSystem.OpenTextFile(path, 1, false, -1);
    var text = file.ReadAll();
    file.Close();
    return text;
  }

  try {
    if (WScript.Arguments.length === 1 && WScript.Arguments.Item(0) === '--inspect') {
      var inspectedApp = GetObject('', 'Photoshop.Application');
      writeResult({
        kind: 'running',
        majorVersion: parseInt(String(inspectedApp.version).split('.')[0], 10),
        activeDocument: inspectedApp.documents.length > 0,
      });
      WScript.Quit(0);
    }
    if (WScript.Arguments.length !== 2) throw new Error('invalid_arguments');
    var jsxPath = WScript.Arguments.Item(0);
    var payloadPath = WScript.Arguments.Item(1);
    var app = GetObject('', 'Photoshop.Application');
    var majorVersion = parseInt(String(app.version).split('.')[0], 10);
    if (!isFinite(majorVersion) || majorVersion < 20) {
      writeResult({ kind: 'photoshop_version_unsupported', majorVersion: majorVersion });
      WScript.Quit(0);
    }
    if (app.documents.length === 0) {
      writeResult({ kind: 'no_active_document' });
      WScript.Quit(0);
    }
    var source = readText(jsxPath);
    app.DoJavaScript(source, [payloadPath], 1);
    writeResult({ kind: 'success', layerName: app.activeDocument.activeLayer.name });
  } catch (error) {
    var message = String(error && error.message ? error.message : error);
    if (/permission|denied|access/iu.test(message)) {
      writeResult({ kind: 'automation_denied' });
    } else if (/active.document/iu.test(message)) {
      writeResult({ kind: 'no_active_document' });
    } else {
      writeResult({ kind: 'placement_failed' });
    }
  }
}());
