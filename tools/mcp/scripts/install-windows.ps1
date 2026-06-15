param(
  [string]$StationUrl = "",
  [string]$User = "",
  [switch]$AllowWrites,
  [switch]$AllowAlarmActions,
  [switch]$SkipDoctor
)

$ErrorActionPreference = "Stop"

function Require-Command {
  param([string]$Name, [string]$InstallHint)

  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $cmd) {
    throw "$Name was not found. $InstallHint"
  }
}

function Require-Node18 {
  Require-Command "node" "Install Node.js 18 or newer. On Windows, winget install OpenJS.NodeJS"
  $versionText = (& node --version).Trim()
  $major = [int]($versionText.TrimStart("v").Split(".")[0])
  if ($major -lt 18) {
    throw "Node.js 18 or newer is required. Current version: $versionText"
  }
  Write-Host "OK Node.js $versionText"
}

function Set-McpEnv {
  param([string]$Name, [string]$Value)

  if ($Value -ne "") {
    Set-Item -Path "Env:$Name" -Value $Value
  }
}

$mcpRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $mcpRoot

Require-Node18
Require-Command "npm" "Install Node.js 18 or newer; npm ships with Node.js."

Write-Host ""
Write-Host "Building baskStream MCP in $mcpRoot"
npm run setup

Set-McpEnv "BASKSTREAM_STATION_URL" $StationUrl
Set-McpEnv "BASKSTREAM_USER" $User
Set-McpEnv "BASKSTREAM_VERIFY_TLS" "false"
Set-McpEnv "BASKSTREAM_ALLOW_WRITES" ($(if ($AllowWrites) { "true" } else { "false" }))
Set-McpEnv "BASKSTREAM_ALLOW_ALARM_ACTIONS" ($(if ($AllowAlarmActions) { "true" } else { "false" }))

if ($StationUrl -ne "" -and $User -ne "" -and -not $env:BASKSTREAM_PASSWORD) {
  $securePassword = Read-Host "Niagara password for this test session" -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
  try {
    $env:BASKSTREAM_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  }
  finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  }
}

if (-not $SkipDoctor) {
  Write-Host ""
  Write-Host "Running MCP doctor"
  npm run doctor
}

Write-Host ""
Write-Host "Client config snippets for this machine"
npm run print-config

