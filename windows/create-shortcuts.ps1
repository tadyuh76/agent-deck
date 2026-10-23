param(
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
$installedDesktop = Join-Path $env:LOCALAPPDATA 'AgentDeck\desktop-install.json'
$terminal = (Get-Command wt.exe -ErrorAction Stop).Source
$linuxBin = "/home/$LinuxUser/.local/bin"
$fragmentDir = Join-Path $env:LOCALAPPDATA 'Microsoft\Windows Terminal\Fragments\Agent Deck'
New-Item -ItemType Directory -Path $fragmentDir -Force | Out-Null
$profileId = '{119e82d8-4801-4c18-9ad1-70f3f15eadd1}'
$fragment = @{
    profiles = @(@{
        guid = $profileId
        name = 'Agent Deck'
        commandline = "wsl.exe --distribution $Distribution --user $LinuxUser --exec $linuxBin/agent-deck-windows"
        startingDirectory = "%USERPROFILE%"
        font = @{face = 'Cascadia Mono'; size = 10}
        colorScheme = 'One Half Dark'
        padding = '4'
        bellStyle = 'none'
        closeOnExit = 'graceful'
        suppressApplicationTitle = $true
        tabTitle = 'Agent Deck'
    })
}
$fragment | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $fragmentDir 'agent-deck.json') -Encoding utf8
$shell = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Agent Deck'
New-Item -ItemType Directory -Path $startMenu -Force | Out-Null
foreach ($directory in @($desktop, $startMenu)) {
    $shortcut = $shell.CreateShortcut((Join-Path $directory 'Agent Deck.lnk'))
    $shortcut.TargetPath = $terminal
    $shortcut.Arguments = "--maximized new-tab --profile $profileId --title `"Agent Deck`" wsl.exe --distribution $Distribution --user $LinuxUser --exec $linuxBin/agent-deck-windows"
    $shortcut.WorkingDirectory = $env:USERPROFILE
    $shortcut.Description = 'Agent Deck: six Claude terminals for your projects'
    if (Test-Path -LiteralPath $installedDesktop) {
        $desktopConfig = Get-Content -LiteralPath $installedDesktop -Raw | ConvertFrom-Json
        if (Test-Path -LiteralPath $desktopConfig.executable) {
            $shortcut.TargetPath = $desktopConfig.executable
            $shortcut.Arguments = ''
            $shortcut.WorkingDirectory = Split-Path $desktopConfig.executable -Parent
        }
    }
    $shortcut.Save()
}
# One sign-in shortcut per Claude account in the deck's account list.
# Windows PowerShell mangles double quotes in native arguments: none here.
$listAccounts = 'console.log(require(process.env.HOME+`/.config/agent-deck/account-registry`).accounts.filter(a=>a.tool===`claude`).map(a=>a.slot.toLowerCase()).join(`,`))'
$accounts = Invoke-Wsl -d $Distribution -u $LinuxUser --cd '~' --exec .local/bin/node -e $listAccounts | Select-Object -Last 1
foreach ($account in "$accounts".Split(',', [StringSplitOptions]::RemoveEmptyEntries)) {
    $shortcut = $shell.CreateShortcut((Join-Path $startMenu "Sign in $account.lnk"))
    $shortcut.TargetPath = $terminal
    $shortcut.Arguments = "new-tab --title `"Agent Deck - $account login`" wsl.exe --distribution $Distribution --user $LinuxUser --exec $linuxBin/agent-deck-login $account"
    $shortcut.Description = "Sign in to the isolated $account account"
    $shortcut.Save()
}
Write-Output "Desktop shortcut: $(Join-Path $desktop 'Agent Deck.lnk')"
Write-Output "Start menu: $startMenu"
