(function () {
  function write(value) {
    var parts = [];
    var key;
    for (key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      parts.push('"' + key + '":"' + String(value[key])
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n') + '"');
    }
    WScript.StdOut.Write('{' + parts.join(',') + '}');
  }

  try {
    var app;
    var connection = 'running-object';
    var action = WScript.Arguments.length > 0 ? WScript.Arguments.Item(0) : '';
    if (action === '--inspect-progid') {
      var requestedProgId = WScript.Arguments.Item(1);
      app = GetObject('', requestedProgId);
      write({
        ok: true,
        action: 'inspected-progid',
        progId: requestedProgId,
        version: String(app.version),
        documentCount: app.documents.length
      });
      WScript.Quit(0);
    }
    try {
      app = GetObject('', 'Photoshop.Application');
    } catch (getObjectError) {
      connection = 'active-x';
      app = new ActiveXObject('Photoshop.Application');
    }
    if (action === '--inspect') {
      write({
        ok: true,
        action: 'inspected',
        connection: connection,
        version: String(app.version),
        documentCount: app.documents.length
      });
      WScript.Quit(0);
    }
    if (action === '--create') {
      app.DoJavaScript("app.documents.add(512, 512, 72, 'Canvas Atelier Acceptance');", [], 1);
      write({ ok: true, action: 'created', documentName: String(app.activeDocument.name) });
      WScript.Quit(0);
    }
    if (action === '--close') {
      if (app.documents.length > 0 && String(app.activeDocument.name) === 'Canvas Atelier Acceptance') {
        app.DoJavaScript('app.activeDocument.close(SaveOptions.DONOTSAVECHANGES);', [], 1);
        write({ ok: true, action: 'closed' });
      } else {
        write({ ok: false, action: 'not_closed' });
      }
      WScript.Quit(0);
    }
    write({ ok: false, action: 'invalid' });
  } catch (error) {
    write({
      ok: false,
      action: 'error',
      number: error && error.number,
      name: error && error.name,
      message: String(error && error.message ? error.message : error),
      description: String(error && error.description ? error.description : '')
    });
  }
}());
