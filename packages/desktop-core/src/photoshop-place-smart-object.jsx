#target photoshop

(function () {
  var stage = 'startup';
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

  function readPayloadString(raw, key) {
    var marker = '"' + key + '":"';
    var start = raw.indexOf(marker);
    if (start < 0) throw new Error('payload_' + key + '_missing');
    start += marker.length;
    var end = raw.indexOf('"', start);
    if (end < 0) throw new Error('payload_' + key + '_missing');
    var value = raw.substring(start, end);
    if (!/^[A-Za-z0-9\+\/\=]+$/.test(value)) throw new Error('payload_' + key + '_invalid');
    return value;
  }

  function readPayload(payloadPath) {
    var payloadFile = new File(payloadPath);
    if (!payloadFile.exists || !payloadFile.open('r')) throw new Error('payload_unavailable');
    payloadFile.encoding = 'UTF8';
    var raw = payloadFile.read();
    payloadFile.close();
    if (!/"version"\s*:\s*1(?:\s*[,}])/.test(raw)) throw new Error('payload_version_unsupported');
    return {
      version: 1,
      imagePathBase64: readPayloadString(raw, 'imagePathBase64'),
      layerNameBase64: readPayloadString(raw, 'layerNameBase64')
    };
  }

  function placeEmbedded(imageFile) {
    try {
      var descriptor = new ActionDescriptor();
      descriptor.putPath(charIDToTypeID('null'), imageFile);
      descriptor.putEnumerated(
        charIDToTypeID('FTcs'),
        charIDToTypeID('QCSt'),
        charIDToTypeID('Qcsa')
      );
      executeAction(charIDToTypeID('Plc '), descriptor, DialogModes.NO);
      return app.activeDocument.activeLayer;
    } catch (placementError) {
      // Some Photoshop builds reject the embedded-place action descriptor
      // over COM. Transfer the pixels through a temporary source document,
      // then convert the copied layer before it can be reported as imported.
      var targetDocument = app.activeDocument;
      var sourceDocument = null;
      var copiedLayer = null;
      try {
        sourceDocument = app.open(imageFile);
        copiedLayer = sourceDocument.activeLayer.duplicate(targetDocument);
      } finally {
        if (sourceDocument !== null) sourceDocument.close(SaveOptions.DONOTSAVECHANGES);
        app.activeDocument = targetDocument;
      }
      try {
        targetDocument.activeLayer = copiedLayer;
        executeAction(stringIDToTypeID('newPlacedLayer'), undefined, DialogModes.NO);
        return targetDocument.activeLayer;
      } catch (conversionError) {
        try { if (copiedLayer !== null) copiedLayer.remove(); } catch (cleanupError) { /* preserve conversion failure */ }
        throw conversionError;
      }
    }
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

  if (app.documents.length === 0) { stage = 'create-document'; app.documents.add(); }
  stage = 'read-payload';
  var payload = readPayload('__PAYLOAD_PATH__');
  stage = 'resolve-asset';
  var imageFile = new File(decodeBase64Utf8(payload.imagePathBase64));
  if (!imageFile.exists) throw new Error('asset_not_found');

  var documentRef = app.activeDocument;
  stage = 'place-layer';
  var layer;
  try {
    layer = placeEmbedded(imageFile);
  } catch (placeError) {
    throw new Error('place-layer: ' + placeError);
  }
  if (layer.kind !== LayerKind.SMARTOBJECT) {
    try { layer.remove(); } catch (cleanupError) { /* preserve the type failure */ }
    throw new Error('place-layer: placed_layer_not_smart_object');
  }
  stage = 'rename-layer';
  layer.name = decodeBase64Utf8(payload.layerNameBase64);
  stage = 'read-bounds';
  var bounds = layer.bounds;
  var layerWidth = bounds[2].as('px') - bounds[0].as('px');
  var layerHeight = bounds[3].as('px') - bounds[1].as('px');
  var canvasWidth = documentRef.width.as('px');
  var canvasHeight = documentRef.height.as('px');
  var scale = Math.min(1, canvasWidth / layerWidth, canvasHeight / layerHeight);
  stage = 'resize-layer';
  if (scale < 1) layer.resize(scale * 100, scale * 100, AnchorPosition.MIDDLECENTER);
  stage = 'center-layer';
  centerLayerInDocument(layer, documentRef);
}());
