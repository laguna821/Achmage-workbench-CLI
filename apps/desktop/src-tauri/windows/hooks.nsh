; The persistent host may outlive its window. Ask the installed owner to drain before
; replacing executable files. Never kill other Node/AI processes or discard active jobs.
!macro NSIS_HOOK_PREINSTALL
  IfFileExists "$INSTDIR\host\service-cli.mjs" 0 workbench_update_ready
  nsExec::ExecToLog /TIMEOUT=45000 '"$INSTDIR\node\node.exe" "$INSTDIR\host\service-cli.mjs" prepare-update'
  Pop $0
  ${If} $0 == 20
    DetailPrint "Workbench still has active tasks. Finish or stop them in the app, then run this installer again."
    MessageBox MB_OK|MB_ICONEXCLAMATION "Workbench에 실행 중인 작업이 있습니다. 앱에서 작업을 완료하거나 중단한 뒤 설치를 다시 실행해 주세요." /SD IDOK
    SetErrorLevel 20
    Abort
  ${ElseIf} $0 != 0
    DetailPrint "The Workbench background host could not be safely prepared for this update."
    MessageBox MB_OK|MB_ICONEXCLAMATION "Workbench 백그라운드 호스트의 종료를 확인하지 못했습니다. 앱을 정상 종료한 뒤 설치를 다시 실행해 주세요." /SD IDOK
    SetErrorLevel 21
    Abort
  ${EndIf}
  workbench_update_ready:
!macroend

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
