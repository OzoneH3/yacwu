# Build and run local Codex in the foreground. Works from Windows PowerShell 5.1.
$ErrorActionPreference = 'Stop'
# Pick up tool installs made since this terminal was opened.
if ($env:OS -eq 'Windows_NT') {
    $env:Path = (@(
        [Environment]::GetEnvironmentVariable('Path', 'Machine')
        [Environment]::GetEnvironmentVariable('Path', 'User')
        $env:Path
    ) | Where-Object { $_ }) -join ';'
}
Push-Location $PSScriptRoot
try {
    foreach ($tool in @('bun', 'node', 'gleam', 'erl', 'rebar3', 'git')) {
        if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "Missing prerequisite: $tool. Run .\install-windows.ps1 to install the required tools, then reopen PowerShell." }
    }
    if (-not $env:YACWU_CODEX_BIN -and -not (Get-Command codex -ErrorAction SilentlyContinue)) {
        throw 'Install Codex with npm install -g @openai/codex, then run codex login.'
    }
    & bun install
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed' }
    & bun run build
    if ($LASTEXITCODE -ne 0) { throw 'UI build failed' }
    Push-Location server
    try {
        & gleam build
        if ($LASTEXITCODE -ne 0) { throw 'Server build failed' }
    } finally { Pop-Location }
    if (-not $env:YACWU_INSECURE_SKIP_AUTH) { $env:YACWU_INSECURE_SKIP_AUTH = '1' }
    if (-not $env:HOST) { $env:HOST = '127.0.0.1' }
    & node scripts/run-server.mjs @args
    exit $LASTEXITCODE
} finally { Pop-Location }
