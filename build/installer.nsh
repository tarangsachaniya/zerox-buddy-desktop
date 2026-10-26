; Picked up automatically by electron-builder (directories.buildResources/installer.nsh).

; Replaces electron-builder's running-app check. Zerox Buddy lives in the tray
; (closing the window keeps it printing) and starts SumatraPDF / NAPS2 out of
; resources\, and any of them can hold files open. When the uninstaller ran
; past them it removed the registry entry and every unlocked file, but left a
; broken Zerox Buddy.exe behind that still started with Windows and no longer
; showed up in Apps to be uninstalled. So: force-close everything running
; from $INSTDIR, and wait until it is really gone.
!macro customCheckAppRunning
  ; An empty $INSTDIR would match every process on the machine.
  ${If} $INSTDIR != ""
    StrCpy $R9 0
    zeroxCloseLoop:
      ; Exit code = how many processes were still running from $INSTDIR (each one force-stopped).
      nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "$$d = '$INSTDIR\'; $$p = @(Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$d, 'OrdinalIgnoreCase') }); $$p | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }; exit $$p.Count"`
      Pop $R8
      ${If} $R8 == "error"
        ; No PowerShell: /T also ends the SumatraPDF / NAPS2 children it started.
        nsExec::Exec `"$SYSDIR\taskkill.exe" /F /T /IM "${APP_EXECUTABLE_FILENAME}"`
        Pop $R8
        Sleep 1500
      ${ElseIf} $R8 != 0
        IntOp $R9 $R9 + 1
        ${If} $R9 < 10
          DetailPrint `Closing "${PRODUCT_NAME}"...`
          Sleep 1000
          Goto zeroxCloseLoop
        ${EndIf}
      ${EndIf}
  ${EndIf}
!macroend

!macro customUnInstall
  ; An update runs the old uninstaller too; it must keep autostart and the
  ; updater cache (the new installer is running out of that cache).
  ${ifNot} ${isUpdated}
    ; app.setLoginItemSettings() writes these; NSIS doesn't know about them.
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${APP_ID}"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "${APP_ID}"
    RMDir /r "$LOCALAPPDATA\priinteve-zerox-desktop-updater"
  ${endIf}
!macroend
