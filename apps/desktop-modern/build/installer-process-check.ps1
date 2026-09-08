param([string]$InstallDirectory)

# Only the exact bundled stdio bridge may be stopped automatically. A GUI,
# unknown invocation, or inaccessible process must be left for the user.
function Invoke-CanvasInstallerProcessCheck {
  param([string]$InstallDirectory)
  $ErrorActionPreference = 'Stop'
  try {
    if ([string]::IsNullOrWhiteSpace($InstallDirectory) -or -not [IO.Path]::IsPathRooted($InstallDirectory)) { return 1 }
    $targetExe = [IO.Path]::GetFullPath((Join-Path $InstallDirectory 'Canvas Atelier.exe'))
    $targetBridge = [IO.Path]::GetFullPath((Join-Path $InstallDirectory 'resources\mcp\canvasforge-mcp.cjs'))
    $bridgeCommand = '^\s*"' + [regex]::Escape($targetExe) + '"\s+(?:"' + [regex]::Escape($targetBridge) + '"|' + [regex]::Escape($targetBridge) + ')\s*$'
    $rows = @(Get-CimInstance Win32_Process -Filter "Name='Canvas Atelier.exe'" -ErrorAction Stop)
    if (@($rows | Where-Object { [string]::IsNullOrWhiteSpace($_.ExecutablePath) }).Count -gt 0) { return 1 }
    $targets = @($rows | Where-Object { [string]::Equals($_.ExecutablePath, $targetExe, [StringComparison]::OrdinalIgnoreCase) })
    if (@($targets | Where-Object { $_.CommandLine -notmatch $bridgeCommand }).Count -gt 0) { return 2 }
    foreach ($entry in $targets) {
      # Recheck identity immediately before stopping, in case a PID was reused.
      $current = @(Get-CimInstance Win32_Process -Filter "ProcessId=$($entry.ProcessId)" -ErrorAction Stop | Where-Object ProcessId -eq $entry.ProcessId)
      if ($current.Count -eq 0) { continue }
      if ($current[0].CreationDate -ne $entry.CreationDate -or $current[0].ExecutablePath -ne $targetExe -or $current[0].CommandLine -notmatch $bridgeCommand) { return 1 }
      $handle = Get-Process -Id $entry.ProcessId -ErrorAction SilentlyContinue
      Stop-Process -Id $entry.ProcessId -Force -ErrorAction Stop
      if ($null -ne $handle -and -not $handle.WaitForExit(5000)) { return 1 }
    }
    # A client may restart the bridge. Fail closed instead of copying over it.
    $remaining = @(Get-CimInstance Win32_Process -Filter "Name='Canvas Atelier.exe'" -ErrorAction Stop | Where-Object { $_.ExecutablePath -eq $targetExe -or [string]::IsNullOrWhiteSpace($_.ExecutablePath) })
    if ($remaining.Count -gt 0) { return 1 }
    return 0
  } catch { return 1 }
}

if ($MyInvocation.InvocationName -ne '.') {
  exit (Invoke-CanvasInstallerProcessCheck -InstallDirectory $InstallDirectory)
}
