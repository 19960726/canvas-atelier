!macro customInstall
  SetShellVarContext all
  Delete "$DESKTOP\CanvasForge.lnk"
  Delete "$SMPROGRAMS\CanvasForge.lnk"
  Delete "$SMPROGRAMS\CanvasForge\CanvasForge.lnk"
  RMDir "$SMPROGRAMS\CanvasForge"

  SetShellVarContext current
  Delete "$DESKTOP\CanvasForge.lnk"
  Delete "$SMPROGRAMS\CanvasForge.lnk"
  Delete "$SMPROGRAMS\CanvasForge\CanvasForge.lnk"
  RMDir "$SMPROGRAMS\CanvasForge"
!macroend
