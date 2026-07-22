; Tauri NSIS installer hooks.

!macro NSIS_HOOK_POSTINSTALL
  ; Windows keeps a cached copy of every app's taskbar/desktop icon and keeps
  ; showing the stale one after an upgrade. Flush the cache so the freshly
  ; installed icon appears immediately instead of the previous version's.
  nsExec::Exec '"$SYSDIR\ie4uinit.exe" -show'
  Pop $0
!macroend
