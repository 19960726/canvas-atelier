(function () {
  function quoteJsonString(value) {
    return '"' + String(value)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n')
      .replace(/\t/g, '\\t') + '"';
  }

  function stringifyFlatObject(value) {
    var parts = [];
    var key;
    for (key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      var item = value[key];
      var encoded = typeof item === 'string'
        ? quoteJsonString(item)
        : item === null ? 'null' : String(item);
      parts.push(quoteJsonString(key) + ':' + encoded);
    }
    return '{' + parts.join(',') + '}';
  }

  function writeResult(value) {
    WScript.StdOut.Write(stringifyFlatObject(value));
  }

  function readText(path) {
    var fileSystem = new ActiveXObject('Scripting.FileSystemObject');
    var file = fileSystem.OpenTextFile(path, 1, false, 0);
    var text = file.ReadAll();
    file.Close();
    return text;
  }

  function decodeBase64Utf8(value) {
    var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
    var output = '';
    var index = 0;
    value = String(value).replace(/[^A-Za-z0-9\+\/\=]/g, '');
    while (index < value.length) {
      var encoded1 = alphabet.indexOf(value.charAt(index++));
      var encoded2 = alphabet.indexOf(value.charAt(index++));
      var encoded3 = alphabet.indexOf(value.charAt(index++));
      var encoded4 = alphabet.indexOf(value.charAt(index++));
      var character1 = (encoded1 << 2) | (encoded2 >> 4);
      var character2 = ((encoded2 & 15) << 4) | (encoded3 >> 2);
      var character3 = ((encoded3 & 3) << 6) | encoded4;
      output += String.fromCharCode(character1);
      if (encoded3 !== 64) output += String.fromCharCode(character2);
      if (encoded4 !== 64) output += String.fromCharCode(character3);
    }
    return decodeURIComponent(escape(output));
  }

  function readPayloadValue(path, key) {
    var raw = readText(path);
    var marker = '"' + key + '":"';
    var start = raw.indexOf(marker);
    if (start < 0) throw new Error('payload_' + key + '_missing');
    start += marker.length;
    var end = raw.indexOf('"', start);
    if (end < 0) throw new Error('payload_' + key + '_missing');
    return decodeBase64Utf8(raw.substring(start, end));
  }

  function directLayerTransfer(application, payloadFile) {
    var targetDocument = application.activeDocument;
    var imagePath = readPayloadValue(payloadFile, 'imagePathBase64');
    var layerName = readPayloadValue(payloadFile, 'layerNameBase64');
    var sourceDocument = application.open(imagePath);
    var sourceLayer = sourceDocument.activeLayer;
    var copiedLayer;
    try {
      copiedLayer = sourceLayer.duplicate(targetDocument);
    } catch (duplicateError) {
      // COM exposes Copy/Paste more consistently than Layer.duplicate.
      sourceLayer.copy();
      app.activeDocument = targetDocument;
      copiedLayer = targetDocument.paste();
    }
    // Renaming can be rejected for locked/background layers by some COM
    // versions; successful duplication is already a valid import.
    try { copiedLayer.name = layerName; } catch (renameError) { /* keep Photoshop name */ }
    sourceDocument.close(2);
    application.activeDocument = targetDocument;
    return copiedLayer.name;
  }

  function connectPhotoshop() {
    var ids = ['Photoshop.Application.27', 'Photoshop.Application.200', 'Photoshop.Application.200.1', 'Photoshop.Application'];
    var lastError = null;
    for (var index = 0; index < ids.length; index += 1) {
      try {
        return GetObject('', ids[index]);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('photoshop_not_running');
  }

  try {
    if (WScript.Arguments.length === 1 && WScript.Arguments.Item(0) === '--inspect') {
      var inspectedApp = connectPhotoshop();
      writeResult({
        kind: 'running',
        majorVersion: parseInt(String(inspectedApp.version).split('.')[0], 10),
        activeDocument: inspectedApp.documents.length > 0
      });
      WScript.Quit(0);
    }
    if (WScript.Arguments.length !== 2) throw new Error('invalid_arguments');
    var jsxPath = WScript.Arguments.Item(0);
    var payloadPath = WScript.Arguments.Item(1);
    var app = connectPhotoshop();
    var majorVersion = parseInt(String(app.version).split('.')[0], 10);
    if (!isFinite(majorVersion) || majorVersion < 13) {
      writeResult({ kind: 'photoshop_version_unsupported', majorVersion: majorVersion });
      WScript.Quit(0);
    }
    // Photoshop COM is often running with no document. Create a neutral
    // document so importing a canvas asset does not fail just because the
    // user has not opened a file yet.
    if (app.documents.length === 0) {
      app.documents.add();
    }
    var source = readText(jsxPath);
    // Photoshop COM versions disagree on the optional execution-mode enum;
    // omitting it keeps the second argument as the portable string array.
    var escapedPayloadPath = String(payloadPath).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    source = source.replace('__PAYLOAD_PATH__', escapedPayloadPath);
    app.DoJavaScript(source);
    writeResult({ kind: 'success', layerName: app.activeDocument.activeLayer.name });
  } catch (error) {
    var message = String(error && error.message ? error.message : error);
    var number = Number(error && error.number);
    if (number === -2147221021 || /operation unavailable/i.test(message)) {
      writeResult({ kind: 'automation_unavailable' });
    } else if (/permission|denied|access/i.test(message)) {
      writeResult({ kind: 'automation_denied' });
    } else if (/active.document/i.test(message)) {
      writeResult({ kind: 'no_active_document' });
    } else if (typeof app !== 'undefined') {
      try {
        var fallbackLayerName = directLayerTransfer(app, payloadPath);
        writeResult({ kind: 'success', layerName: fallbackLayerName, method: 'direct-com' });
        WScript.Quit(0);
      } catch (fallbackError) {
        message = String(fallbackError && fallbackError.message ? fallbackError.message : fallbackError);
      }
      // Keep the stable kind for the bridge while exposing a short diagnostic
      // to the local QA runner so COM failures can be fixed instead of guessed.
      writeResult({ kind: 'placement_failed', message: message.slice(0, 240) });
    }
  }
}());
