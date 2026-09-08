!ifndef BUILD_UNINSTALLER
  !define CANVAS_INSTALLER_PROCESS_HELPER "${__FILEDIR__}\installer-process-check.ps1"
  !macro customCheckAppRunning
    ; Run only once the destination is known, not when the wizard opens.
    InitPluginsDir
    File /oname=$PLUGINSDIR\installer-process-check.ps1 "${CANVAS_INSTALLER_PROCESS_HELPER}"
    ${Do}
      nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\installer-process-check.ps1" -InstallDirectory "$INSTDIR"'
      Pop $0
      ${If} $0 == 0
        ${ExitDo}
      ${EndIf}
      ; Never force-close a window with unsaved work. Silent updates fail safely.
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "请保存并退出目标目录中的 Canvas Atelier 后重试。若已退出，请检查该目录的进程访问权限。" /SD IDCANCEL IDRETRY +3
      SetErrorLevel 2
      Quit
    ${Loop}
  !macroend
!endif
