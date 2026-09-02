On Error Resume Next
Dim app, payloadPath, raw, imagePath, target, source, layer
Set app = Nothing
Set app = Nothing
On Error Resume Next
Set app = GetObject("", "Photoshop.Application.27")
If app Is Nothing Then Set app = GetObject("", "Photoshop.Application.200")
If app Is Nothing Then Set app = GetObject("", "Photoshop.Application.200.1")
If app Is Nothing Then Set app = GetObject("", "Photoshop.Application")
On Error GoTo 0
If Err.Number <> 0 Then WScript.Echo "{""kind"":""automation_unavailable""}": WScript.Quit 0
If WScript.Arguments.Count = 1 And WScript.Arguments.Item(0) = "--inspect" Then
  WScript.Echo "{""kind"":""running"",""majorVersion"":" & ParseMajorVersion(app.Version) & ",""activeDocument"":" & LCase(CStr(app.Documents.Count > 0)) & "}"
  WScript.Quit 0
End If
If WScript.Arguments.Count <> 2 Then WScript.Echo "{""kind"":""placement_failed""}": WScript.Quit 0
payloadPath = WScript.Arguments.Item(1)
raw = ReadText(payloadPath)
imagePath = DecodeUtf8(ExtractBase64(raw, "imagePathBase64"))
If app.Documents.Count = 0 Then
  Err.Clear
  Set target = app.Documents.Add
  If Err.Number <> 0 Or target Is Nothing Then WScript.Echo "{""kind"":""no_active_document""}": WScript.Quit 0
Else
  Set target = app.ActiveDocument
End If
Err.Clear
Set source = app.Open(imagePath)
If Err.Number <> 0 Or source Is Nothing Then WScript.Echo "{""kind"":""placement_failed"",""message"":""open_failed""}": WScript.Quit 0
Err.Clear
Set layer = source.ActiveLayer.Duplicate(target)
If Err.Number <> 0 Or layer Is Nothing Then WScript.Echo "{""kind"":""placement_failed"",""message"":""duplicate_failed""}": WScript.Quit 0
Err.Clear
source.Close 2
Err.Clear
Set app.ActiveDocument = target
Err.Clear
WScript.Echo "{""kind"":""success"",""layerName"":""Canvas Atelier Import"",""method"":""direct-com""}"
WScript.Quit 0

Function ParseMajorVersion(value)
  Dim parts
  parts = Split(CStr(value), ".")
  If IsNumeric(parts(0)) Then
    ParseMajorVersion = CInt(parts(0))
  Else
    ParseMajorVersion = 0
  End If
End Function

Function ReadText(path)
  Dim fs, f
  Set fs = CreateObject("Scripting.FileSystemObject")
  Set f = fs.OpenTextFile(path, 1, False, 0)
  ReadText = f.ReadAll
  f.Close
End Function

Function ExtractBase64(text, key)
  Dim marker, start, finish
  marker = Chr(34) & key & Chr(34) & ":" & Chr(34)
  start = InStr(text, marker) + Len(marker)
  finish = InStr(start, text, Chr(34))
  ExtractBase64 = Mid(text, start, finish - start)
End Function

Function DecodeUtf8(value)
  Dim xml, node, stream
  Set xml = CreateObject("MSXML2.DOMDocument.6.0")
  Set node = xml.createElement("b64")
  node.DataType = "bin.base64"
  node.Text = value
  Set stream = CreateObject("ADODB.Stream")
  stream.Type = 1
  stream.Open
  stream.Write node.nodeTypedValue
  stream.Position = 0
  stream.Type = 2
  stream.Charset = "utf-8"
  DecodeUtf8 = stream.ReadText
  stream.Close
End Function
