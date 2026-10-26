<#
  Removes Zerox Buddy from this computer, including a broken install whose
  own uninstaller is already gone (the app no longer listed in Settings >
  Apps, but "Zerox Buddy.exe" still in the folder and starting with Windows).

    1. Force-closes Zerox Buddy and everything it started (SumatraPDF, NAPS2).
    2. Runs the app's own uninstaller silently, when it is still there.
    3. Deletes whatever is left: install folder, Apps-list entry, start-with-
       Windows entry, shortcuts, downloaded updates.
    4. Keeps the app's data folder (%APPDATA%\priinteve-zerox-desktop) unless
       -RemoveUserData is given. It holds machine-id, which lets a reinstall
       reuse this computer's device and printers instead of registering a
       second computer against the plan.

  Usage (or just double-click "Uninstall Zerox Buddy.cmd"):
    powershell -ExecutionPolicy Bypass -NoProfile -File Uninstall-Zerox-Buddy.ps1 [-RemoveUserData]
#>
param(
    [switch]$RemoveUserData
)

$ErrorActionPreference = "Continue"

$appId = "com.priinteve.zerox-desktop"
# electron-builder's NSIS GUID for $appId (UUID v5 in its namespace); the
# installer uses it for both of its registry keys.
$appGuid = "d1ee5387-baa6-58f3-8f10-c8d12dd098e5"
$productName = "Zerox Buddy"
$uninstallKeyRoots = @(
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall",
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"
)

function Say([string]$Message) { Write-Host "  $Message" }

function Get-UninstallEntries {
    foreach ($root in $uninstallKeyRoots) {
        Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object {
            $props = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
            if ($_.PSChildName -eq $appGuid -or $props.DisplayName -eq $productName) { $props }
        }
    }
}

function Stop-AppProcesses([string[]]$Dirs) {
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
        $procs = @(Get-CimInstance Win32_Process | Where-Object {
            $path = $_.ExecutablePath
            $path -and ($Dirs | Where-Object { $path.StartsWith("$_\", [System.StringComparison]::OrdinalIgnoreCase) })
        })
        if ($procs.Count -eq 0) { return $true }
        foreach ($p in $procs) {
            if ($attempt -eq 0) { Say "Closing $($p.Name) (PID $($p.ProcessId))" }
            Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Seconds 1
    }
    return $false
}

function Remove-Folder([string]$Dir) {
    if (-not (Test-Path -LiteralPath $Dir)) { return $true }
    for ($attempt = 0; $attempt -lt 5; $attempt++) {
        Remove-Item -LiteralPath $Dir -Recurse -Force -ErrorAction SilentlyContinue
        if (-not (Test-Path -LiteralPath $Dir)) { return $true }
        Start-Sleep -Seconds 1
    }
    return $false
}

Write-Host ""
Write-Host "Uninstalling $productName"
Write-Host ""

# --- Where is it installed? -----------------------------------------------
$entries = @(Get-UninstallEntries)
$installDirs = @(
    @((Join-Path $env:LOCALAPPDATA "Programs"), $env:ProgramFiles, ${env:ProgramFiles(x86)}) |
        Where-Object { $_ } | ForEach-Object { Join-Path $_ $productName }
)
foreach ($e in $entries) {
    if ($e.InstallLocation) { $installDirs += $e.InstallLocation.TrimEnd("\") }
}
$runValue = (Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -ErrorAction SilentlyContinue).$appId
if ($runValue -match '^"?([^"]+)\\[^\\"]+\.exe') { $installDirs += $Matches[1] }
$installDirs = @($installDirs | Where-Object { $_ } | Select-Object -Unique)

# --- 1. Close it ------------------------------------------------------------
if (-not (Stop-AppProcesses $installDirs)) {
    Say "Some $productName processes would not close. Restart the computer and run this again."
}

# --- 2. The app's own uninstaller, if it is still there --------------------
foreach ($e in $entries) {
    $exe = $null
    if ($e.UninstallString -match '^"([^"]+)"') { $exe = $Matches[1] }
    if ($exe -and (Test-Path -LiteralPath $exe)) {
        Say "Running the $productName uninstaller"
        $scope = if ($e.PSPath -like "*HKEY_LOCAL_MACHINE*") { "/allusers" } else { "/currentuser" }
        # _?= keeps NSIS from copying itself to %TEMP% and returning before it is done.
        $proc = Start-Process -FilePath $exe -ArgumentList "/S", $scope, "_?=$(Split-Path -Parent $exe)" -PassThru -Wait
        if ($proc.ExitCode -ne 0) { Say "The uninstaller exited with code $($proc.ExitCode); cleaning up by hand instead" }
    }
}

# --- 3. Whatever is left ----------------------------------------------------
$failed = @()
foreach ($dir in $installDirs) {
    if (Test-Path -LiteralPath $dir) {
        Say "Deleting $dir"
        if (-not (Remove-Folder $dir)) { $failed += $dir }
    }
}

foreach ($e in @(Get-UninstallEntries)) {
    Say "Removing the Apps-list entry"
    Remove-Item -LiteralPath $e.PSPath -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $e.PSPath) { $failed += "$($e.PSPath) (run this as administrator)" }
}
foreach ($key in @("HKCU:\Software\$appGuid", "HKLM:\Software\$appGuid")) {
    Remove-Item -LiteralPath $key -Recurse -Force -ErrorAction SilentlyContinue
}

Say "Removing start with Windows"
Remove-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name $appId -ErrorAction SilentlyContinue
Remove-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" -Name $appId -ErrorAction SilentlyContinue

$shortcuts = @(
    (Join-Path ([Environment]::GetFolderPath("Desktop")) "$productName.lnk"),
    (Join-Path ([Environment]::GetFolderPath("CommonDesktopDirectory")) "$productName.lnk"),
    (Join-Path ([Environment]::GetFolderPath("Programs")) "$productName.lnk"),
    (Join-Path ([Environment]::GetFolderPath("CommonPrograms")) "$productName.lnk")
)
foreach ($lnk in $shortcuts) {
    if (Test-Path -LiteralPath $lnk) {
        Say "Deleting shortcut $lnk"
        Remove-Item -LiteralPath $lnk -Force -ErrorAction SilentlyContinue
    }
}

$updaterCache = Join-Path $env:LOCALAPPDATA "priinteve-zerox-desktop-updater"
if (Test-Path -LiteralPath $updaterCache) {
    Say "Deleting downloaded updates"
    if (-not (Remove-Folder $updaterCache)) { $failed += $updaterCache }
}

# --- 4. App data ------------------------------------------------------------
$userData = Join-Path $env:APPDATA "priinteve-zerox-desktop"
if ($RemoveUserData) {
    if (Test-Path -LiteralPath $userData) {
        Say "Deleting app data $userData"
        if (-not (Remove-Folder $userData)) { $failed += $userData }
    }
} elseif (Test-Path -LiteralPath $userData) {
    Say "Kept app data in $userData (reinstalling reuses this computer's device and printers)"
}

Write-Host ""
if ($failed.Count -eq 0) {
    Write-Host "$productName has been uninstalled." -ForegroundColor Green
    exit 0
}
Write-Host "Could not remove:" -ForegroundColor Yellow
$failed | ForEach-Object { Write-Host "  $_" -ForegroundColor Yellow }
Write-Host "Restart the computer and run this again." -ForegroundColor Yellow
exit 1
