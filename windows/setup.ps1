param(
    [string]$Distribution = 'Ubuntu-24.04'
)
# Installs Agent Deck on Windows: Linux packages in WSL, Claude accounts, the
# two default project folders, the desktop app and its shortcuts. Safe to run
# again: what is already set up is kept.
$ErrorActionPreference = 'Stop'
$env:WSL_UTF8 = '1'
$kit = Split-Path $PSScriptRoot -Parent
function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }
function Stop-Setup($text) { Write-Host "`n$text" -ForegroundColor Yellow; exit 1 }
# Output of a WSL command. WSL may warn on stderr (an untranslatable Windows
# PATH entry), which Windows PowerShell would otherwise raise as an error.
function Invoke-Wsl {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & wsl.exe @args 2>$null } finally { $ErrorActionPreference = $previous }
}
function Refresh-Path {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

Step "Checking WSL ($Distribution)"
if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) { Stop-Setup 'WSL is not installed. In an Administrator PowerShell run: wsl --install, restart Windows, then run this again.' }
$distros = @(Invoke-Wsl --list --quiet | ForEach-Object { "$_".Trim([char]0, ' ') } | Where-Object { $_ })
if ($distros -notcontains $Distribution) {
    Write-Host "$Distribution is not installed. Setup installs it; the Ubuntu window then asks for a new Linux user name and password."
    if ((Read-Host 'Install it now? (Y/n)') -match '^[nN]') { exit 1 }
    & wsl.exe --install -d $Distribution
    Stop-Setup "Once the Linux user is created (and Windows restarted, if it asks), run install-windows.cmd again."
}
$linuxUser = "$(Invoke-Wsl -d $Distribution --exec whoami | Select-Object -Last 1)".Trim()
if (-not $linuxUser -or $linuxUser -eq 'root') { Stop-Setup "Make a regular user the default for $Distribution (open Ubuntu and create one), then run this again." }
Write-Host "Using $Distribution as Linux user: $linuxUser"

Step 'Checking Windows tools'
foreach ($tool in @(
        @{ name = 'node.exe'; id = 'OpenJS.NodeJS.LTS'; label = 'Node.js LTS' },
        @{ name = 'git.exe'; id = 'Git.Git'; label = 'Git for Windows' },
        @{ name = 'wt.exe'; id = 'Microsoft.WindowsTerminal'; label = 'Windows Terminal' })) {
    if (Get-Command $tool.name -ErrorAction SilentlyContinue) { Write-Host "Found $($tool.label)"; continue }
    if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) { Stop-Setup "Install $($tool.label), then run this again." }
    Write-Host "Installing $($tool.label)..."
    & winget.exe install -e --id $tool.id --accept-package-agreements --accept-source-agreements
    Refresh-Path
    if (-not (Get-Command $tool.name -ErrorAction SilentlyContinue)) { Stop-Setup "$($tool.label) is installed. Close this window and run install-windows.cmd again." }
}
$browsers = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe")
if (-not ($browsers | Where-Object { Test-Path -LiteralPath $_ })) { Stop-Setup 'Google Chrome or Microsoft Edge is needed to sign in to Claude.' }

Step 'Installing Linux packages (tmux, Git, Go, build tools)'
$toWsl = { param($windowsPath) "$(Invoke-Wsl -d $Distribution -u $linuxUser --exec wslpath -u $windowsPath | Select-Object -Last 1)".Trim() }
& wsl.exe -d $Distribution -u root --exec bash (& $toWsl (Join-Path $PSScriptRoot 'install-packages.sh'))
if ($LASTEXITCODE -ne 0) { Stop-Setup 'Installing Linux packages failed. Check the network and run this again.' }

Step 'Claude accounts'
$hasAccounts = "$(Invoke-Wsl -d $Distribution -u $linuxUser --cd '~' --exec sh -c 'test -f .config/agent-deck/accounts.js && echo yes' | Select-Object -Last 1)".Trim()
$emails = ''
if ($hasAccounts -eq 'yes') {
    Write-Host 'Keeping the accounts set up before (~/.config/agent-deck/accounts.js).'
} else {
    Write-Host 'Enter the Claude sign-in emails; each one becomes an account in the deck (up to 10).'
    do { $emails = (Read-Host 'Emails (comma separated)') -replace '\s', '' } while (-not $emails)
}

Step 'Default project folders (odd / even terminals)'
$saved = $null
try { $saved = (Invoke-Wsl -d $Distribution -u $linuxUser --cd '~' --exec cat .config/agent-deck/windows-projects.json) -join "`n" | ConvertFrom-Json } catch {}
function Ask-Folder($label, $previous) {
    while ($true) {
        $hint = if ($previous) { " [Enter = $previous]" } else { '' }
        $answer = (Read-Host "$label$hint").Trim('"', ' ')
        if (-not $answer -and $previous) { return $previous }
        if ($answer -and (Test-Path -LiteralPath $answer -PathType Container)) { return & $toWsl (Resolve-Path -LiteralPath $answer).Path }
        Write-Host 'Folder not found, try again (for example D:\Projects\my-app).' -ForegroundColor Yellow
    }
}
$web = Ask-Folder 'First project folder' $saved.web
$mobile = Ask-Folder 'Second project folder (may be the same)' $(if ($saved.mobile) { $saved.mobile } else { $web })

Step 'Installing Agent Deck in WSL (Node, Claude Code, agent-deck, plugins)'
$installWsl = & $toWsl (Join-Path $PSScriptRoot 'install-wsl.sh')
& wsl.exe -d $Distribution -u $linuxUser --cd '~' --exec env "AGENT_DECK_ACCOUNTS=$emails" bash $installWsl $web $mobile
if ($LASTEXITCODE -ne 0) { Stop-Setup 'The WSL setup failed. See the error above, fix it and run this again.' }

Step 'Building and installing the desktop app'
& (Join-Path $PSScriptRoot 'install-desktop.ps1') -Distribution $Distribution -LinuxUser $linuxUser
Step 'Creating shortcuts'
& (Join-Path $PSScriptRoot 'create-shortcuts.ps1') -Distribution $Distribution -LinuxUser $linuxUser

Write-Host "`nDone. Last step: Start menu -> Agent Deck -> 'Sign in <name>' for each account, then open Agent Deck from the desktop." -ForegroundColor Green
