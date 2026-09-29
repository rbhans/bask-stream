# Installs the bask CLI from GitHub releases (Windows).
#
#   irm https://raw.githubusercontent.com/rbhans/bask-stream/main/cli/install.ps1 | iex
#
# Options (environment variables):
#   $env:BASK_VERSION = "0.1.0"      a specific version (default: the newest bask release)
#   $env:BASK_INSTALL_DIR = "..."    where to put bask.exe (default: %LOCALAPPDATA%\Programs\bask)
& {
  $ErrorActionPreference = "Stop"
  $ProgressPreference = "SilentlyContinue"   # Invoke-WebRequest is much faster without the progress bar
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $repo = "rbhans/bask-stream"
  $installDir = if ($env:BASK_INSTALL_DIR) { $env:BASK_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "Programs\bask" }
  # Only an x64 build exists; Windows on ARM runs it under emulation.
  $asset = "bask-windows-x64.exe"

  if ($env:BASK_VERSION) {
    $tag = "bask-v" + ($env:BASK_VERSION -replace '^v', '')
  } else {
    # The repository also holds module releases, so pick the newest tag starting with bask-v.
    $releases = Invoke-RestMethod -UseBasicParsing "https://api.github.com/repos/$repo/releases?per_page=50"
    $tag = ($releases | Where-Object { $_.tag_name -like "bask-v*" } | Select-Object -First 1).tag_name
    if (-not $tag) { throw "No bask release found at https://github.com/$repo/releases" }
  }

  $base = "https://github.com/$repo/releases/download/$tag"
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("bask-" + [Guid]::NewGuid())
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    Write-Host "Downloading $asset ($tag)..."
    $exe = Join-Path $tmp "bask.exe"
    Invoke-WebRequest -UseBasicParsing "$base/$asset" -OutFile $exe

    $sums = $null
    try { $sums = (Invoke-WebRequest -UseBasicParsing "$base/SHA256SUMS").Content } catch { }
    if ($sums) {
      if ($sums -is [byte[]]) { $sums = [Text.Encoding]::UTF8.GetString($sums) }
      $line = ($sums -split "`n") | Where-Object { $_ -match "\s$([regex]::Escape($asset))\s*$" } | Select-Object -First 1
      if (-not $line) { throw "No checksum listed for $asset" }
      $expected = ($line -split '\s+')[0].ToLower()
      $actual = (Get-FileHash -Algorithm SHA256 $exe).Hash.ToLower()
      if ($expected -ne $actual) { throw "Checksum mismatch for $asset" }
    }

    New-Item -ItemType Directory -Force -Path $installDir | Out-Null
    $target = Join-Path $installDir "bask.exe"
    Move-Item -Force $exe $target
    Write-Host "Installed $(& $target --version) to $target"
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }

  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if (-not $userPath) { $userPath = "" }
  if (-not (($userPath -split ';') -contains $installDir)) {
    [Environment]::SetEnvironmentVariable("Path", (($userPath.TrimEnd(';'), $installDir) -join ';').TrimStart(';'), "User")
    $env:Path = "$env:Path;$installDir"
    Write-Host "Added $installDir to your PATH (open a new terminal if 'bask' is not found)."
  }

  Write-Host ""
  Write-Host "Next: bask login https://<station> -u <user> --insecure"
  Write-Host "Then: bask"
}
