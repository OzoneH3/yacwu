# Missing-prerequisite regression: preview all installs without touching Windows.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$tokens = $null
$parseErrors = $null
foreach ($file in @('install-windows.ps1', 'start.ps1')) {
    [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $root $file), [ref]$tokens, [ref]$parseErrors) | Out-Null
    if ($parseErrors) { throw ($parseErrors | Out-String) }
}
$global:yacwuInstallerQueriedTools = [System.Collections.Generic.List[string]]::new()
function Get-Command { param($Name, $CommandType, $ErrorAction) $global:yacwuInstallerQueriedTools.Add($Name); return $null }
function Get-ChildItem { param($Path, $LiteralPath, [switch]$Directory, $Filter, $ErrorAction) return @() }
function Test-Path { param($LiteralPath) return $false }
function winget { throw 'Preview attempted package installation' }
function Invoke-WebRequest { throw 'Preview attempted a download' }
$originalOS = $env:OS
try {
    $env:OS = 'Windows_NT'
    $preview = & (Join-Path $root 'install-windows.ps1') -WhatIf 6>&1 | Out-String
    foreach ($tool in @('node', 'git', 'bun', 'gleam', 'erl', 'rebar3')) {
        if (-not $global:yacwuInstallerQueriedTools.Contains($tool)) { throw "Missing prerequisite check: $tool" }
    }
    if ($preview.Contains('Toolchain ready')) { throw 'Preview must not claim installation succeeded' }
    Write-Host 'Installer syntax and all six missing-prerequisite previews passed.'
} finally {
    $env:OS = $originalOS
    Remove-Variable -Name yacwuInstallerQueriedTools -Scope Global
}
