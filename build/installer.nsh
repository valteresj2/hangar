; Custom NSIS steps for the Hangar installer (included through nsis.include in electron-builder.yml).
; Registers the hangar:// URL scheme for the install scope the user chose (SHELL_CONTEXT is HKCU for "only me" and
; HKLM for "all users"), the same keys Electron's app.setAsDefaultProtocolClient('hangar') writes at run time.
; The portable .exe has no installer: there the app registers the scheme itself.

!macro customInstall
  WriteRegStr SHELL_CONTEXT "Software\Classes\hangar" "" "URL:Hangar"
  WriteRegStr SHELL_CONTEXT "Software\Classes\hangar" "URL Protocol" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\hangar\DefaultIcon" "" "$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\",0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\hangar\shell\open\command" "" "$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" $\"%1$\""
!macroend

; Updates run the old uninstaller before installing the new version: keep the keys then (customInstall rewrites them).
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegKey SHELL_CONTEXT "Software\Classes\hangar"
    ; The app may also have registered itself per user at run time (setAsDefaultProtocolClient writes HKCU).
    ReadRegStr $0 HKCU "Software\Classes\hangar\shell\open\command" ""
    StrCmp $0 "$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" $\"%1$\"" 0 +2
      DeleteRegKey HKCU "Software\Classes\hangar"
  ${endIf}
!macroend
