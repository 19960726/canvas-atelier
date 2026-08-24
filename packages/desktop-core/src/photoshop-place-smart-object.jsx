#target photoshop

(function () {
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

  function readPayload(payloadPath) {
    var payloadFile = new File(payloadPath);
    if (!payloadFile.exists || !payloadFile.open('r')) throw new Error('payload_unavailable');
    payloadFile.encoding = 'UTF8';
    var raw = payloadFile.read();
    payloadFile.close();
    var payload = JSON.parse(raw);
    if (payload.version !== 1) throw new Error('payload_version_unsupported');
    return payload;
  }

  function placeEmbedded(imageFile) {
    var descriptor = new ActionDescriptor();
    descriptor.putPath(charIDToTypeID('null'), imageFile);
    descriptor.putEnumerated(
      charIDToTypeID('FTcs'),
      charIDToTypeID('QCSt'),
      charIDToTypeID('Qcsa')
    );
    executeAction(charIDToTypeID('Plc '), descriptor, DialogModes.NO);
    return app.activeDocument.activeLayer;
  }

  function centerLayerInDocument(layer, documentRef) {
    var bounds = layer.bounds;
    var left = bounds[0].as('px');
    var top = bounds[1].as('px');
    var right = bounds[2].as('px');
    var bottom = bounds[3].as('px');
    var layerCenterX = left + ((right - left) / 2);
    var layerCenterY = top + ((bottom - top) / 2);
    var canvasCenterX = documentRef.width.as('px') / 2;
    var canvasCenterY = documentRef.height.as('px') / 2;
    layer.translate(canvasCenterX - layerCenterX, canvasCenterY - layerCenterY);
  }

  if (app.documents.length === 0) throw new Error('no_active_document');
  if (arguments.length !== 1) throw new Error('payload_path_required');

  var payload = readPayload(arguments[0]);
  var imageFile = new File(decodeBase64Utf8(payload.imagePathBase64));
  if (!imageFile.exists) throw new Error('asset_not_found');

  var documentRef = app.activeDocument;
  var layer = placeEmbedded(imageFile);
  layer.name = decodeBase64Utf8(payload.layerNameBase64);
  var bounds = layer.bounds;
  var layerWidth = bounds[2].as('px') - bounds[0].as('px');
  var layerHeight = bounds[3].as('px') - bounds[1].as('px');
  var canvasWidth = documentRef.width.as('px');
  var canvasHeight = documentRef.height.as('px');
  var scale = Math.min(1, canvasWidth / layerWidth, canvasHeight / layerHeight);
  if (scale < 1) layer.resize(scale * 100, scale * 100, AnchorPosition.MIDDLECENTER);
  centerLayerInDocument(layer, documentRef);
}());
