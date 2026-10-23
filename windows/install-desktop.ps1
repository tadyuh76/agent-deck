param(
    [switch]$SkipBuild,
    [string]$Distribution = 'Ubuntu-24.04',
    # Defaults to the distribution's own default user.
    [string]$LinuxUser = ''
)
$ErrorActionPreference = 'Stop'
$env:WSL_UTF8 = '1'
# Output of a WSL command. WSL may warn on stderr (an untranslatable Windows
# PATH entry), which Windows PowerShell would otherwise raise as an error.
function Invoke-Wsl {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & wsl.exe @args 2>$null } finally { $ErrorActionPreference = $previous }
}
if (-not $LinuxUser) { $LinuxUser = "$(Invoke-Wsl -d $Distribution --exec whoami | Select-Object -Last 1)".Trim() }
if (-not $LinuxUser) { throw "Could not read the default user of $Distribution." }
$kit = Split-Path $PSScriptRoot -Parent
$desktopSource = Join-Path $kit 'desktop'
if (-not $SkipBuild) {
    Push-Location -LiteralPath $desktopSource
    try {
        & npm.cmd ci --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
        if (-not (Test-Path -LiteralPath 'node_modules\electron\dist\electron.exe')) {
            & node node_modules/electron/install.js
            if ($LASTEXITCODE -ne 0) { throw 'Electron download failed.' }
        }
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw 'Desktop build failed.' }
        & npm.cmd run package
        if ($LASTEXITCODE -ne 0) { throw 'Desktop packaging failed.' }
    } finally { Pop-Location }
}
# Agent Deck's browser: Playwright MCP (run by Windows Node, which can reach
# the browser's loopback DevTools port) and the launcher shared with the
# Browser tab.
$browserRoot = Join-Path $env:LOCALAPPDATA 'AgentDeck\browser'
New-Item -ItemType Directory -Path $browserRoot -Force | Out-Null
$browserPackage = Join-Path $browserRoot 'package.json'
if (-not (Test-Path -LiteralPath $browserPackage)) { '{"private":true}' | Set-Content -LiteralPath $browserPackage -Encoding ascii }
Push-Location -LiteralPath $browserRoot
try {
    & npm.cmd install --no-audit --no-fund '@playwright/mcp@0.0.83'
    if ($LASTEXITCODE -ne 0) { throw 'Playwright MCP install failed.' }
} finally { Pop-Location }
foreach ($name in @('browser-host.cjs', 'browser-mcp.cjs')) {
    Copy-Item -LiteralPath (Join-Path $desktopSource $name) -Destination $browserRoot -Force
}
$wslScript = "$(Invoke-Wsl -d $Distribution -u $LinuxUser --exec wslpath -u (Join-Path $PSScriptRoot 'install-desktop.sh') | Select-Object -Last 1)".Trim()
& wsl.exe -d $Distribution -u $LinuxUser --exec bash $wslScript
if ($LASTEXITCODE -ne 0) { throw 'WSL desktop setup failed.' }
$release = Join-Path $desktopSource 'release\AgentDeck-win32-x64'
if (-not (Test-Path -LiteralPath (Join-Path $release 'AgentDeck.exe'))) { throw 'Packaged executable was not found.' }
$appRoot = Join-Path $env:LOCALAPPDATA 'AgentDeck'
$destination = Join-Path $appRoot ('Desktop-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $destination -Force | Out-Null
Get-ChildItem -LiteralPath $release -Force | Copy-Item -Destination $destination -Recurse -Force
$executable = Join-Path $destination 'AgentDeck.exe'
# The app reads distribution and linuxUser to start its WSL backend.
@{executable=$executable;source=$desktopSource;installedAt=(Get-Date -Format o);distribution=$Distribution;linuxUser=$LinuxUser} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $appRoot 'desktop-install.json') -Encoding utf8
$shortcutShell = New-Object -ComObject WScript.Shell
$startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Agent Deck'
New-Item -ItemType Directory -Path $startMenu -Force | Out-Null
foreach ($directory in @([Environment]::GetFolderPath('Desktop'),$startMenu)) {
    $shortcut = $shortcutShell.CreateShortcut((Join-Path $directory 'Agent Deck.lnk'))
    $shortcut.TargetPath = $executable
    $shortcut.Arguments = ''
    $shortcut.WorkingDirectory = $destination
    $shortcut.IconLocation = $executable
    $shortcut.Description = 'Agent Deck Desktop: six terminals, file editor, Git diff and system tray'
    $shortcut.Save()
}
Write-Output "Installed: $executable"
