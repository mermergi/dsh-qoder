#requires -Version 5
<#
.SYNOPSIS
  Install @local/dsh-plugin-qoder into the dsh "desktop" profile and restore deps.

.DESCRIPTION
  Mirrors how the first-party local plugin (dsh-plugin-prompt-editor) is wired:
  it adds a `link:` dependency and a `dsh.profile.bundles` entry to the profile's
  package.json, backs up the original file, then runs `pnpm install`. Idempotent:
  re-running only touches what is missing.

.NOTES
  After running, fully restart dsh for the provider to appear.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install-plugin.ps1

.EXAMPLE
  # plugin checked out somewhere else, dsh not on the default location
  powershell -ExecutionPolicy Bypass -File .\install-plugin.ps1 -DshHome 'D:\dsh'
#>

param(
  # Where the plugin lives. Defaults to this script's folder, i.e. the repo root,
  # because the package files (index.js / client.js / package.json) sit at the root.
  [string] $PluginSource = $PSScriptRoot,
  # dsh installation directory. Auto-detected from the Windows uninstall registry;
  # pass explicitly if dsh was installed in a non-standard way.
  [string] $DshHome = "",
  # dsh profile to install into.
  [string] $ProfileName = "desktop"
)

$ErrorActionPreference = "Stop"

$PluginName = "@local/dsh-plugin-qoder"

if (-not (Test-Path (Join-Path $PluginSource "index.js"))) {
  throw "Plugin source not found at '$PluginSource'. Run this script from inside the cloned repo, or pass -PluginSource."
}

function Find-DshHome {
  if ($DshHome) { return (Resolve-Path $DshHome -ErrorAction SilentlyContinue).Path }
  # The electron-builder uninstall record carries the install directory, which is
  # the only reliable way to find `resources\runtime` on an unknown machine.
  $keys = @(
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
  )
  foreach ($key in $keys) {
    $hit = Get-ItemProperty $key -ErrorAction SilentlyContinue |
      Where-Object { $_.DisplayName -like "*DeepSeek Harness*" -and $_.InstallLocation } |
      Select-Object -First 1
    if ($hit) { return $hit.InstallLocation }
  }
  return ""
}

$DshHome = Find-DshHome
$ProfileDir = Join-Path $env:USERPROFILE ".dsh\profiles\$ProfileName"

if (-not (Test-Path $ProfileDir)) {
  throw "dsh profile '$ProfileName' not found at '$ProfileDir'. Launch dsh once, or adjust -ProfileName."
}

$PkgPath = Join-Path $ProfileDir "package.json"

# Backup once per invocation with a timestamp suffix.
$Backup = "$PkgPath.bak-qoder-$(Get-Date -Format yyyyMMddHHmmss)"
Copy-Item $PkgPath $Backup
Write-Host "Backed up package.json -> $Backup"

# Link path must use forward slashes for pnpm on Windows.
$LinkPath = ($PluginSource -replace '\\', '/')

$pkg = Get-Content $PkgPath -Raw | ConvertFrom-Json

if (-not $pkg.dependencies) {
  $pkg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{})
}
if ($pkg.dependencies.PSObject.Properties.Name -notcontains $PluginName) {
  $pkg.dependencies | Add-Member -NotePropertyName $PluginName -NotePropertyValue "link:$LinkPath"
  Write-Host "Added dependency: $PluginName -> link:$LinkPath"
} else {
  Write-Host "Dependency already present."
}

if (-not $pkg.dsh) { $pkg | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) }
if (-not $pkg.dsh.profile) { $pkg.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{ bundles = @() }) }
if (-not $pkg.dsh.profile.bundles) { $pkg.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @() }

$Bundles = @($pkg.dsh.profile.bundles)
if ($Bundles -notcontains $PluginName) {
  $Bundles += $PluginName
  $pkg.dsh.profile.bundles = $Bundles
  Write-Host "Added bundle entry: $PluginName"
} else {
  Write-Host "Bundle entry already present."
}

$json = $pkg | ConvertTo-Json -Depth 10
# Write WITHOUT a BOM: dsh's JSON parser rejects a leading U+FEFF.
[System.IO.File]::WriteAllText($PkgPath, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "Wrote updated package.json (no BOM)."

# Resolve pnpm: prefer PATH, then the pnpm bundled inside the dsh installation.
$pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
$BundledPnpm = if ($DshHome) { Join-Path $DshHome "resources\runtime\pnpm\bin\pnpm.cjs" } else { "" }
$BundledNode = if ($DshHome) { Join-Path $DshHome "resources\runtime\bin\node.cmd" } else { "" }

Push-Location $ProfileDir
try {
  if ($pnpm) {
    Write-Host "Running: pnpm install"
    pnpm install
  } elseif (Test-Path $BundledPnpm) {
    Write-Host "Running: bundled pnpm install"
    & $BundledNode $BundledPnpm install
  } else {
    Write-Warning "pnpm not found (nor a dsh-bundled one under '$DshHome'). package.json is wired; run 'pnpm install' in '$ProfileDir' manually."
  }
}
finally {
  Pop-Location
}

Write-Host ""
Write-Host "Done. Fully restart dsh, then set your Qoder PAT:"
Write-Host "  `$env:QODER_PAT = 'pt-...'   (or store it as credential ref QODER_PAT)"
