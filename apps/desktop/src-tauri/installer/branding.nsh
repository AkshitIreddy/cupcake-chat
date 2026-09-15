; Included before Tauri expands the standard MUI pages. Keep the upstream
; install, upgrade, shortcut, WebView2 and uninstall behavior intact.
!define MUI_BGCOLOR "FFF7F3"
!define MUI_TEXTCOLOR "57323F"
!define MUI_INSTFILESPAGE_COLORS "57323F FFF7F3"
!define MUI_WELCOMEPAGE_TITLE "Welcome to$\r$\nCupcake Chat"
!define MUI_WELCOMEPAGE_TEXT "A little curiosity. A whole team of possibilities.$\r$\n$\r$\nBring your favorite models and a team of Cupcake advisors into one cozy workspace.$\r$\n$\r$\nLet's make room for your next idea."
!define MUI_FINISHPAGE_TITLE "Your Cupcakes are ready"
!define MUI_FINISHPAGE_TEXT "Cupcake Chat is installed.$\r$\n$\r$\nOpen the app to choose your first model, meet your advisors, and make yourself at home."
!define MUI_FINISHPAGE_RUN_TEXT "Open Cupcake Chat"

; An upgrade must replace the runtime tree, not overlay it: old Python package
; metadata otherwise survives and fails the host's exact manifest validation.
!macro NSIS_HOOK_PREINSTALL
  IfFileExists "$INSTDIR\sidecars\sidecars.manifest.json" 0 cupcake_runtime_clean
  ClearErrors
  RMDir /r "$INSTDIR\sidecars"
  IfErrors 0 cupcake_runtime_clean
  MessageBox MB_OK|MB_ICONSTOP "Close Cupcake Chat before installing this update."
  Abort
  cupcake_runtime_clean:
!macroend
