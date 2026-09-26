<#
  Runs detached, spawned by src/main/updater/updater-service.ts's
  installAndRestart() right before it calls electron-updater's
  quitAndInstall(true, true) and then exits. Nothing else watches this
  update from here on -- the app that would normally do that has just quit,
  which is the entire reason this exists as a separate process.

  What it does, in order:
    1. Waits for the OLD app process (OldPid) to actually exit.
    2. Waits for the NSIS silent installer (already triggered by
       quitAndInstall) to lay down the new exe, then a short grace period
       for it to finish writing every other file.
    3. Watches for a new process at that exe to come up and stay alive for a
       stability window.
    4a. Success: deletes pending-update.json and the backup directory (the
        one thing that failed is exactly what this run is refusing --
        nothing failed, so there is nothing worth keeping the backup for;
        the NEXT update's own installAndRestart() prunes unconditionally
        anyway).
    4b. Failure (never came up / did not stay up / installer never even
        produced the exe): kills any stray broken-install process, deletes
        the install directory, restores it from BackupPath, relaunches the
        OLD exe (MainExePath), and writes update-failed.json so the
        relaunched (old, now-restored) app can show a "previous version was
        restored" notice on its next startup check.

  Never prompts for input, never opens a window, always exits 0 (success) or
  1 (failure/rolled back) so the caller could inspect the exit code if it
  were still around to see it -- which in practice it never is, since it has
  already quit; the log file is the real record.

  Usage:
    powershell -ExecutionPolicy Bypass -NoProfile -File updater-watchdog.ps1 `
      -OldPid <int> -NewExePath <path> -BackupPath <path> -MainExePath <path> -UserDataDir <path>
#>
param(
    [Parameter(Mandatory = $true)][int]$OldPid,
    [Parameter(Mandatory = $true)][string]$NewExePath,
    [Parameter(Mandatory = $true)][string]$BackupPath,
    [Parameter(Mandatory = $true)][string]$MainExePath,
    [Parameter(Mandatory = $true)][string]$UserDataDir
)

$logDir = Join-Path $UserDataDir "logs"
$logPath = Join-Path $logDir "watchdog.log"
$pendingMarkerPath = Join-Path $UserDataDir "pending-update.json"
$failedMarkerPath = Join-Path $UserDataDir "update-failed.json"

function Write-Log {
    param([string]$Message)
    try {
        if (-not (Test-Path $logDir)) {
            New-Item -ItemType Directory -Path $logDir -Force | Out-Null
        }
        $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
        Add-Content -Path $logPath -Value $line -Encoding UTF8
    } catch {
        # Logging must never be the reason this script fails to do its job.
    }
}

Write-Log "Watchdog Started (OldPid=$OldPid, NewExePath=$NewExePath, BackupPath=$BackupPath, MainExePath=$MainExePath)"

$installDir = Split-Path -Path $NewExePath -Parent
$exeBaseName = [System.IO.Path]::GetFileNameWithoutExtension((Split-Path -Path $NewExePath -Leaf))

# --- Step 1: wait for the old process to exit ------------------------------
$oldExitTimeoutSeconds = 60
$waited = 0
while ($waited -lt $oldExitTimeoutSeconds) {
    $proc = Get-Process -Id $OldPid -ErrorAction SilentlyContinue
    if (-not $proc) { break }
    Start-Sleep -Seconds 1
    $waited++
}
if ($waited -ge $oldExitTimeoutSeconds) {
    Write-Log "Old process (PID $OldPid) never exited after $oldExitTimeoutSeconds s - proceeding anyway"
} else {
    Write-Log "Old process (PID $OldPid) confirmed exited after $waited s"
}

# --- Step 2: wait for the NSIS silent installer to produce the new exe -----
$installTimeoutSeconds = 60
$installWaited = 0
$exeAppeared = $false
while ($installWaited -lt $installTimeoutSeconds) {
    if (Test-Path -LiteralPath $NewExePath) { $exeAppeared = $true; break }
    Start-Sleep -Seconds 1
    $installWaited++
}

if ($exeAppeared) {
    Write-Log "New exe found at '$NewExePath' after $installWaited s - waiting a grace period for the rest of the install to finish"
    Start-Sleep -Seconds 5
} else {
    Write-Log "New exe never appeared at '$NewExePath' within $installTimeoutSeconds s"
}

# --- Step 3: watch for a healthy new process --------------------------------
$overallTimeoutSeconds = 90
$requiredStableSeconds = 10
$overallStart = Get-Date
$healthy = $false

if ($exeAppeared) {
    while (((Get-Date) - $overallStart).TotalSeconds -lt $overallTimeoutSeconds) {
        $newProc = Get-Process -Name $exeBaseName -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($newProc) {
            Write-Log "New process '$exeBaseName' (PID $($newProc.Id)) detected - watching for $requiredStableSeconds s of stability"
            $stableSeconds = 0
            $stillRunning = $true
            while ($stableSeconds -lt $requiredStableSeconds) {
                Start-Sleep -Seconds 1
                $stableSeconds++
                if (-not (Get-Process -Id $newProc.Id -ErrorAction SilentlyContinue)) {
                    $stillRunning = $false
                    break
                }
            }
            if ($stillRunning) {
                $healthy = $true
                break
            }
            Write-Log "New process exited after only $stableSeconds s - still watching until the overall $overallTimeoutSeconds s timeout in case it restarts"
        }
        Start-Sleep -Seconds 1
    }
}

# --- Step 4: success, or restore-and-relaunch -------------------------------
if ($healthy) {
    Write-Log "Installation Completed - new version is running and stable"
    Remove-Item -LiteralPath $pendingMarkerPath -Force -ErrorAction SilentlyContinue

    # Retention policy: keep only the most recent backup, and "most recent"
    # after a SUCCESSFUL update is none at all -- there is nothing to roll
    # back to a version that just proved itself. (The next update's own
    # pre-install step prunes unconditionally regardless, so leaving this
    # here would only cost disk space in the meantime.)
    if (Test-Path -LiteralPath $BackupPath) {
        Remove-Item -LiteralPath $BackupPath -Recurse -Force -ErrorAction SilentlyContinue
    }
    Write-Log "Cleaned up pending-update marker and backup at '$BackupPath'"
    exit 0
}

Write-Log "Rollback Started - no healthy new process within $overallTimeoutSeconds s"

$reason = "New version did not start a stable process within $overallTimeoutSeconds seconds"
if (-not $exeAppeared) {
    $reason = "Installer never produced the new executable at '$NewExePath' within $installTimeoutSeconds seconds"
}

# Kill any stray/broken process from the failed install before touching files on disk.
$strayProcs = Get-Process -Name $exeBaseName -ErrorAction SilentlyContinue
if ($strayProcs) {
    $strayIds = ($strayProcs | ForEach-Object { $_.Id }) -join ", "
    Write-Log "Stopping stray process(es) for '$exeBaseName': $strayIds"
    $strayProcs | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
}

$failedFromVersion = $null
$failedToVersion = $null
if (Test-Path -LiteralPath $pendingMarkerPath) {
    try {
        $pending = Get-Content -LiteralPath $pendingMarkerPath -Raw | ConvertFrom-Json
        $failedFromVersion = $pending.fromVersion
        $failedToVersion = $pending.toVersion
    } catch {
        Write-Log "Could not parse pending-update.json for version info: $_"
    }
}

try {
    if (-not (Test-Path -LiteralPath $BackupPath)) {
        throw "No backup found at '$BackupPath' - cannot restore"
    }

    if (Test-Path -LiteralPath $installDir) {
        Remove-Item -LiteralPath $installDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
    Copy-Item -Path (Join-Path $BackupPath "*") -Destination $installDir -Recurse -Force

    Write-Log "Restored install directory from backup at '$BackupPath'"

    $failedMarker = @{
        fromVersion = $failedFromVersion
        toVersion   = $failedToVersion
        reason      = $reason
        timestamp   = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }
    ($failedMarker | ConvertTo-Json) | Set-Content -LiteralPath $failedMarkerPath -Encoding UTF8
    Remove-Item -LiteralPath $pendingMarkerPath -Force -ErrorAction SilentlyContinue

    Write-Log "Relaunching restored old version at '$MainExePath'"
    Start-Process -FilePath $MainExePath

    Write-Log "Rollback Completed"
    exit 1
} catch {
    Write-Log "Rollback FAILED: $_"
    try {
        $failedMarker = @{
            fromVersion = $failedFromVersion
            toVersion   = $failedToVersion
            reason      = "Rollback failed: $_"
            timestamp   = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        }
        ($failedMarker | ConvertTo-Json) | Set-Content -LiteralPath $failedMarkerPath -Encoding UTF8
    } catch {
        # If even writing the failure marker fails, there is nothing further
        # this script can do -- the plain-text log above is the last resort.
    }
    exit 1
}
