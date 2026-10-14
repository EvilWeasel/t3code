; Weasel only. Override electron-builder's image-name kill fallback completely.
!macro customCheckAppRunning
  InitPluginsDir
  File /oname=$PLUGINSDIR\morrowbyte-installer-guard.ps1 "${BUILD_RESOURCES_DIR}\morrowbyte-installer-guard.ps1"
  nsExec::ExecToStack /TIMEOUT=40000 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\morrowbyte-installer-guard.ps1" -InstallRoot "$INSTDIR\." -AppExecutable "${APP_EXECUTABLE_FILENAME}"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    SetErrorLevel 20
    MessageBox MB_OK|MB_ICONSTOP "Morrowbyte cannot safely continue this installation. Close Morrowbyte and retry. No application processes were terminated." /SD IDOK
    Abort
  ${EndIf}
!macroend
