; Run the new, installed Node worker after copying files, including for /S and /UPDATE.
; It removes only unchanged files in the pinned old installer manifest, never user folders.
!macro NSIS_HOOK_POSTINSTALL
  nsExec::ExecToLog '"$INSTDIR\node\node.exe" "$INSTDIR\host\cleanup-legacy.mjs" "$INSTDIR"'
  Pop $0
  ${If} $0 != 0
    DetailPrint "Some old application resources could not be removed. Close the old application and run this installer again."
    SetErrorLevel 1
  ${EndIf}
  DetailPrint "Installing and linking the standalone IeumOffice application..."
  nsExec::ExecToLog '"$INSTDIR\node\node.exe" "$INSTDIR\host\ieum-setup.mjs"'
  Pop $0
  ${If} $0 != 0
    DetailPrint "IeumOffice setup will resume automatically when Workbench first opens. Internal editors are ready."
  ${EndIf}
!macroend
