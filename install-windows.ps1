#Requires -Version 5.1
<#
.SYNOPSIS
Install Yacwu's Node.js, Git, Bun, Gleam, Erlang/OTP and rebar3 prerequisites.
.DESCRIPTION
Uses WinGet for missing or outdated tools. Installs a checksum-verified rebar3
in this checkout's ignored .workspace/tools folder and adds it to the user PATH.
Run with -WhatIf to preview changes. Install and authenticate Codex separately.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param()
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Run this installer in PowerShell on Windows.' }

function Refresh-ToolPath {
    # Preserve entries set by the caller as well as newly installed user/machine paths.
    $env:Path = (@(
        [Environment]::GetEnvironmentVariable('Path', 'Machine')
        [Environment]::GetEnvironmentVariable('Path', 'User')
        $env:Path
    ) | Where-Object { $_ }) -join ';'
}

function Add-UserToolPath([string]$Directory) {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $entries = @($userPath -split ';' | Where-Object { $_ })
    if (@($entries | ForEach-Object { $_.TrimEnd('\') }) -notcontains $Directory.TrimEnd('\')) {
        [Environment]::SetEnvironmentVariable('Path', (($entries + $Directory) -join ';'), 'User')
    }
    # Put the selected compatible tool ahead of older versions in this process.
    $env:Path = "$Directory;$env:Path"
}

function Get-ToolVersion([string]$Name) {
    $command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $command) { return $null }
    try {
        if ($Name -eq 'erl') {
            $output = & $command.Source -noshell -eval 'erlang:display(erlang:system_info(otp_release)),halt().' 2>&1
        } else {
            $output = & $command.Source --version 2>&1
        }
        if ($LASTEXITCODE -ne 0) { return $null }
        $match = [regex]::Match(($output -join ' '), '\d+(?:\.\d+){0,3}')
        if (-not $match.Success) { return $null }
        $value = $match.Value
        if (-not $value.Contains('.')) { $value += '.0' }
        return [version]$value
    } catch { return $null }
}

function Find-ErlangBin {
    # The OTP installer can register Erlang without adding its bin folder to PATH.
    $candidates = @()
    if ($env:ERLANG_HOME) { $candidates += Join-Path $env:ERLANG_HOME 'bin' }
    foreach ($key in @('HKLM:\SOFTWARE\Ericsson\Erlang', 'HKCU:\SOFTWARE\Ericsson\Erlang')) {
        foreach ($entry in @(Get-ChildItem $key -ErrorAction SilentlyContinue)) {
            $installDir = $entry.GetValue('')
            if ($installDir) { $candidates += Join-Path $installDir 'bin' }
        }
    }
    foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if ($base) {
            foreach ($directory in @(Get-ChildItem -LiteralPath $base -Directory -Filter 'erl*' -ErrorAction SilentlyContinue)) {
                $candidates += Join-Path $directory.FullName 'bin'
            }
        }
    }
    foreach ($bin in ($candidates | Select-Object -Unique)) {
        if (Test-Path -LiteralPath (Join-Path $bin 'erl.exe')) {
            $release = & (Join-Path $bin 'erl.exe') -noshell -eval 'erlang:display(erlang:system_info(otp_release)),halt().' 2>&1
            if ($LASTEXITCODE -eq 0 -and ($release -join '') -match '(\d+)' -and [int]$Matches[1] -ge 27) { return $bin }
        }
    }
    return $null
}

Refresh-ToolPath
foreach ($tool in @(
    @{ Name = 'node'; Id = 'OpenJS.NodeJS.LTS'; Minimum = [version]'24.0' }
    @{ Name = 'git'; Id = 'Git.Git'; Minimum = [version]'2.0' }
    @{ Name = 'bun'; Id = 'Oven-sh.Bun'; Minimum = [version]'1.3' }
    @{ Name = 'gleam'; Id = 'Gleam.Gleam'; Minimum = [version]'1.18' }
    @{ Name = 'erl'; Id = 'Erlang.ErlangOTP'; Minimum = [version]'27.0' }
)) {
    $version = Get-ToolVersion $tool.Name
    if ($version -and $version -ge $tool.Minimum) {
        Write-Host "$($tool.Name) $version is ready."
        continue
    }
    if ($tool.Name -eq 'erl') {
        $bin = Find-ErlangBin
        if ($bin) {
            if ($PSCmdlet.ShouldProcess($bin, 'Add installed Erlang to user PATH')) { Add-UserToolPath $bin }
            continue
        }
    }
    if (-not $PSCmdlet.ShouldProcess($tool.Id, "Install or update with WinGet (minimum $($tool.Minimum))")) { continue }
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw 'WinGet is missing. Install Microsoft App Installer from https://aka.ms/getwinget, reopen PowerShell, and rerun .\install-windows.ps1.'
    }
    & winget install --id $tool.Id --exact --source winget --accept-package-agreements --accept-source-agreements --disable-interactivity
    $installExit = $LASTEXITCODE
    Refresh-ToolPath
    if ($tool.Name -eq 'erl' -and -not ((Get-ToolVersion 'erl') -ge [version]'27.0')) {
        $bin = Find-ErlangBin
        if ($bin) { Add-UserToolPath $bin }
    }
    $version = Get-ToolVersion $tool.Name
    if (-not $version -or $version -lt $tool.Minimum) {
        throw "Installation of $($tool.Id) did not provide the required version (WinGet exit $installExit). Reopen PowerShell and rerun this installer; check WinGet output above if it still fails."
    }
    Write-Host "$($tool.Name) $version is ready."
}

$rebarVersion = Get-ToolVersion 'rebar3'
if ($rebarVersion -and $rebarVersion -ge [version]'3.27') {
    Write-Host "rebar3 $rebarVersion is ready."
} elseif ($PSCmdlet.ShouldProcess('rebar3 3.27.0', 'Download verified release and add its directory to user PATH')) {
    if (-not (Get-Command escript -CommandType Application -ErrorAction SilentlyContinue)) { throw 'Erlang escript.exe is not on PATH. Reopen PowerShell and rerun the installer.' }
    $workspace = Join-Path $PSScriptRoot '.workspace'
    $bin = Join-Path $workspace 'tools\rebar3'
    New-Item -ItemType Directory -Force -Path $bin | Out-Null
    if (-not (Test-Path -LiteralPath (Join-Path $workspace '.gitignore'))) {
        Set-Content -LiteralPath (Join-Path $workspace '.gitignore') -Value '*' -Encoding Ascii
    }
    $download = Join-Path $bin 'rebar3.download'
    # Digest published by the erlang/rebar3 GitHub release API for tag 3.27.0.
    $expectedHash = 'AF85AAB41F9FD74BDD6341EBDF6FE9C88077AAB9F8EAC82371583FA02F2B0BDF'
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    try {
        Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/erlang/rebar3/releases/download/3.27.0/rebar3' -OutFile $download
        if ((Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash -ne $expectedHash) { throw 'rebar3 checksum mismatch; refusing to install the download.' }
        Move-Item -LiteralPath $download -Destination (Join-Path $bin 'rebar3') -Force
    } finally {
        if (Test-Path -LiteralPath $download) { Remove-Item -LiteralPath $download -Force }
    }
    @'
@echo off
escript.exe "%~dp0rebar3" %*
exit /b %errorlevel%
'@ | Set-Content -LiteralPath (Join-Path $bin 'rebar3.cmd') -Encoding Ascii
    Add-UserToolPath $bin
    $rebarVersion = Get-ToolVersion 'rebar3'
    if (-not $rebarVersion -or $rebarVersion -lt [version]'3.27') { throw 'rebar3 was installed but could not run. Check Erlang/OTP and escript.exe.' }
    Write-Host "rebar3 $rebarVersion is ready."
}

if (-not $WhatIfPreference) {
    Write-Host 'Toolchain ready. Reopen PowerShell before running .\start.ps1.'
    Write-Host 'If Codex is not installed, run npm.cmd install -g @openai/codex, then codex login (see README).'
}
