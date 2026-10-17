<#
make-extension-windows.ps1 - Builds the Word Replacer extension for Vivaldi on Windows.
Started by make-extension-windows.cmd (double-click). It:
  1. zips the extension folder into word-replacer-extension.zip (files at the root, "/" separators)
  2. extracts that ZIP into the folder you load in Vivaldi ("Load unpacked")
  3. prints both locations and copies the folder path to the clipboard
Default output: C:\Users\<you>\VivaldiExtensions\ (or the folder given as the first argument).
Uses only Windows PowerShell 5.1 + .NET (no extra software). -NoClipboard skips the clipboard.
#>
param(
  [string]$OutDir = (Join-Path $env:USERPROFILE 'VivaldiExtensions'),
  [switch]$NoClipboard
)
$ErrorActionPreference = 'Stop'
$Marker = 'DEPLOYED-BY-WORD-REPLACER.txt'

# Prints an error and stops with exit code 1.
function Stop-WithError([string]$Message) {
  Write-Host "Error: $Message" -ForegroundColor Red
  exit 1
}

# Full path of a folder, ending with a backslash (for overlap checks).
function Get-FullDir([string]$Path) {
  ([IO.Path]::GetFullPath($Path)).TrimEnd('\') + '\'
}

# Writes the ZIP: every file of $Source, with names relative to $Source and "/" separators.
function New-ExtensionZip([string]$Source, [string]$ZipPath) {
  Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
  $root = Get-FullDir $Source
  $stream = [IO.File]::Open($ZipPath, [IO.FileMode]::Create)
  try {
    $archive = New-Object IO.Compression.ZipArchive($stream, [IO.Compression.ZipArchiveMode]::Create)
    try {
      Get-ChildItem -LiteralPath $Source -Recurse -File | Sort-Object FullName | ForEach-Object {
        $name = $_.FullName.Substring($root.Length).Replace('\', '/')
        [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
          $archive, $_.FullName, $name, [IO.Compression.CompressionLevel]::Optimal)
      }
    } finally { $archive.Dispose() }
  } finally { $stream.Dispose() }
}

$Repo = Split-Path -Parent $PSScriptRoot
$Src = Join-Path $Repo 'extension'
if (-not (Test-Path -LiteralPath (Join-Path $Src 'manifest.json'))) {
  Stop-WithError "extension folder not found next to this script: $Src"
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$OutDir = (Resolve-Path -LiteralPath $OutDir).ProviderPath
$Zip = Join-Path $OutDir 'word-replacer-extension.zip'
$Target = Join-Path $OutDir 'word-replacer'

# Safety: never overlap the source, never delete a folder this script did not create.
$srcFull = Get-FullDir $Src
$targetFull = Get-FullDir $Target
$ic = [StringComparison]::OrdinalIgnoreCase
if ($targetFull.StartsWith($srcFull, $ic) -or $srcFull.StartsWith($targetFull, $ic)) {
  Stop-WithError "the output folder overlaps the source folder $Src"
}
if ((Test-Path -LiteralPath $Target) -and
    (Get-ChildItem -LiteralPath $Target -Force | Select-Object -First 1) -and
    -not (Test-Path -LiteralPath (Join-Path $Target $Marker))) {
  Stop-WithError "$Target already exists and was not made by this script. Move it away first."
}

try {
  $tmp = "$Zip.tmp"
  New-ExtensionZip $Src $tmp
  Move-Item -LiteralPath $tmp -Destination $Zip -Force
  if (Test-Path -LiteralPath $Target) { Remove-Item -LiteralPath $Target -Recurse -Force }
  [IO.Compression.ZipFile]::ExtractToDirectory($Zip, $Target)
  Set-Content -LiteralPath (Join-Path $Target $Marker) -Value @(
    'Made by make-extension-windows.cmd. Running it again replaces this folder.',
    'Edit the files in the project, not here.')
} catch {
  Stop-WithError $_.Exception.Message
}

Write-Host ''
Write-Host 'Done!' -ForegroundColor Green
Write-Host "  ZIP file (copy it to another computer): $Zip"
Write-Host "  Extension folder (load it in Vivaldi):  $Target"
if (-not $NoClipboard) {
  try {
    Set-Clipboard -Value $Target
    Write-Host '  (folder path copied to the clipboard)'
  } catch { }
}
Write-Host ''
Write-Host 'Next: open vivaldi://extensions -> turn on Developer mode -> Load unpacked -> select the extension folder.'
Write-Host 'Already installed? Click the reload button on Word Replacer instead.'
exit 0
