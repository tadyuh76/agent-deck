#!/bin/zsh
# Installs Agent Deck on this Mac.
# One line:  curl -fsSL https://raw.githubusercontent.com/tadyuh76/agent-deck/main/install.sh | zsh
# Usage: ./install.sh [default-working-folder]   full setup (asks for the folder if omitted)
#        ./install.sh --add-account              add another account (any subscription), then update the setup
#        ./install.sh --sign-in                  sign in the accounts that are not signed in yet
#        ./install.sh --folder <path>            only change the default working folder
#        ./install.sh --models [kind model effort]   change the model and effort new chats start with
#                                                (asks, or e.g. --models claude sonnet high; "default" leaves it to the tool)
#        ./install.sh --uninstall                remove Agent Deck (accounts and conversations stay)
# Safe to run again: it backs up anything it would replace and skips work already done.
set -euo pipefail
kit="${0:A:h}"
deck="$HOME/.config/agent-deck"
bin="$HOME/.local/bin"
export PATH="$bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
# Run from inside a Claude chat, the installer would otherwise hand that chat's
# login to every account it sets up.
unset -m 'CLAUDE*' 'ANTHROPIC_*' 'AI_AGENT' 2>/dev/null || true
export AGENTDECK_SUPPRESS_TMUX_WARNING=1
stamp=$(date +%Y%m%d-%H%M%S)
step() { print -P "%F{cyan}==>%f $*"; }
fail() { print -P "%F{red}Stopped:%f $*"; exit 1; }
ask() { local answer=""; print -n -- "$1" >/dev/tty; read -r answer </dev/tty || true; print -r -- "$answer"; }
interactive=0; { : </dev/tty; } 2>/dev/null && interactive=1

[[ "$(uname)" == Darwin ]] || fail "Agent Deck is a Mac app; this setup is for macOS."

# Run as one line: fetch the rest of the setup, then carry on from it.
if [[ ! -f "$kit/deck/workspace.js" ]]; then
  kit="$HOME/.local/share/agent-deck/kit"
  step "Downloading Agent Deck"
  rm -rf "$kit"; mkdir -p "$kit"
  curl -fsSL https://github.com/tadyuh76/agent-deck/archive/refs/heads/main.tar.gz | tar xz --strip-components=1 -C "$kit"
  if (( interactive )); then exec /bin/zsh "$kit/install.sh" "$@" </dev/tty; else exec /bin/zsh "$kit/install.sh" "$@"; fi
fi
# A setup kit made for a team comes with its accounts and the owner's defaults.
team=0; [[ -f "$kit/deck/accounts.js" ]] && team=1
# Account lists from before subscriptions were added name a tool instead.
[[ -f "$deck/accounts.js" ]] && command -v node >/dev/null && (cd "$deck" && node -e '
  const fs=require("fs"),list=require("./accounts.js");
  if(list.some(a=>a.tool)){fs.writeFileSync("accounts.js","module.exports="+JSON.stringify(list.map(({tool,...a})=>({...a,provider:a.provider||tool})),null,2)+";\n");}
')

# The default working folder: where new chats start unless a panel picks another.
set_folder() {
  [[ -d "$1" ]] || fail "Folder not found: $1"
  local file="$deck/config.toml"
  [[ -f "$file" ]] || fail "Run the full setup first."
  node -e '
    const fs=require("fs"),[file,folder]=process.argv.slice(1);
    const text=fs.readFileSync(file,"utf8").replace(/^default_path\s*=.*$/m,"default_path = "+JSON.stringify(folder));
    fs.writeFileSync(file,text,{mode:0o600});
  ' "$file" "${1:A}"
  print "Default working folder: ${1:A}"
}
if [[ "${1:-}" == --folder ]]; then set_folder "${2:?Usage: ./install.sh --folder <path>}"; exit 0; fi
if [[ "${1:-}" == --models ]]; then
  [[ -f "$deck/accounts.js" ]] || fail "Run the full setup first."
  cp "$kit"/deck/{models,codex-app,account-registry,providers,paths,terminal-env}.js "$deck/"
  if (( $# > 1 )); then node "$deck/models.js" --set "${@:2}" || exit 1; exit 0; fi
  (( interactive )) || fail "Run this in Terminal so it can ask, or name them: --models claude opus xhigh"
  node "$deck/models.js" --again
  exit 0
fi
if [[ "${1:-}" == --uninstall ]]; then
  step "Removing Agent Deck"
  homes=()
  [[ -f "$deck/accounts.js" ]] && homes=("${(@f)$(node "$deck/accounts-setup.js" --homes claude 2>/dev/null)}")
  for home in $homes; do CLAUDE_CONFIG_DIR="$home" agent-deck hooks uninstall >/dev/null 2>&1 || true; done
  pkill -x AgentDeck 2>/dev/null || true
  tmux -L agent-deck-managed kill-server 2>/dev/null || true
  launchctl bootout "gui/$(id -u)/local.agent-deck.rebuild" 2>/dev/null || true
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -u "/Applications/Agent Deck.app" 2>/dev/null || true
  rm -rf "/Applications/Agent Deck.app" "$deck" "$HOME/.local/share/agent-deck" "$HOME/Library/Application Support/AgentDeck" \
    "$HOME/Library/LaunchAgents/local.agent-deck.rebuild.plist" "$bin/agent-deck" "$bin/agent-deck-run"
  defaults delete local.agentdeck.app 2>/dev/null || true
  print "Removed. Your accounts and conversations are still there."
  exit 0
fi
if [[ "${1:-}" == --sign-in ]]; then
  [[ -f "$deck/accounts.js" ]] || fail "Run the full setup first."
  (( interactive )) || fail "Run this in Terminal so it can sign you in."
  cp "$kit"/deck/{accounts-setup,providers,paths,terminal-env,account-registry,codex-app}.js "$deck/"
  node "$deck/accounts-setup.js" --sign-in || exit $?
  exit 0
fi
add_account=0
if [[ "${1:-}" == --add-account ]]; then add_account=1; shift; fi

# Run again, it keeps the folder chosen before (--folder changes it).
folder="${1:-}"
if [[ -z "$folder" && -f "$deck/config.toml" ]]; then
  folder=$(sed -n 's/^default_path = "\(.*\)"$/\1/p' "$deck/config.toml" | head -1)
fi
if [[ -z "$folder" ]]; then
  suggested="$HOME"
  for candidate in "$HOME/Coding Projects" "$HOME/Developer" "$HOME/Projects" "$HOME/projects" "$HOME/Code" "$HOME/code" "$HOME/src"; do
    if [[ -d "$candidate" ]]; then suggested="$candidate"; break; fi
  done
  if (( interactive )); then folder=$(ask "Folder where new chats start [${suggested/#$HOME/~}]: "); fi
  folder="${folder:-$suggested}"
fi
folder="${folder/#\~/$HOME}"
[[ -d "$folder" ]] || fail "Folder not found: $folder"
folder="${folder:A}"

step "Tools"
if ! command -v brew >/dev/null; then
  (( interactive )) || fail "Install Homebrew first: https://brew.sh"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" </dev/tty
  command -v brew >/dev/null || fail "Homebrew did not install. See https://brew.sh"
fi
for formula in node tmux go git; do
  command -v $formula >/dev/null || brew install $formula
done
if ! command -v swift >/dev/null; then
  xcode-select --install 2>/dev/null || true
  fail "Install Apple's command line tools in the window that opened, then run this again."
fi
# The Agent Deck app is built from iTerm2.
mdfind "kMDItemCFBundleIdentifier == 'com.googlecode.iterm2'" | grep -q . || brew install --cask iterm2
command -v python3 >/dev/null || brew install python

step "Deck files → $deck"
mkdir -p "$deck" "$bin" "$HOME/Library/Logs"
if [[ ! -f "$deck/.installed-by-kit" ]]; then
  for file in config.toml accounts.js; do [[ -f "$deck/$file" ]] && cp "$deck/$file" "$deck/$file.before-kit-$stamp"; done
fi
cp "$kit"/deck/*.js "$kit/deck/iterm.py" "$kit/deck/iterm-profile.json" "$kit/deck/rebuild-agent-deck" "$kit/deck/agy-chat" "$kit/deck/agent-deck.patch" "$kit/deck/agent-deck.base" "$deck/"
rm -rf "$deck/app"; cp -R "$kit/app" "$deck/app"
chmod +x "$deck"/{workspace,panel,panel-labels,limit-router,models,accounts-setup}.js "$deck/iterm.py" "$deck/rebuild-agent-deck" "$deck/agy-chat"
touch "$deck/.installed-by-kit"

if [[ ! -f "$deck/accounts.js" ]] || (( add_account )); then
  step "Accounts"
  (( interactive )) || fail "Run this in Terminal so it can ask which accounts to use."
  if [[ -f "$deck/accounts.js" ]]; then node "$deck/accounts-setup.js" --add; else node "$deck/accounts-setup.js" --first; fi || fail "The accounts were not saved."
fi
# The tools each subscription needs, and a folder of its own for each account.
step "Tools for your subscriptions"
node "$deck/accounts-setup.js" --prepare || fail "A subscription's tool did not install. See the message above."

step "Deck controller"
# The controller that arranges the deck windows talks to the app through iTerm2's Python API.
env_dir="$HOME/.local/share/agent-deck/iterm-env"
if [[ ! -x "$env_dir/bin/python" ]]; then
  if command -v uv >/dev/null; then uv venv -q --python 3.12 "$env_dir"; else python3 -m venv "$env_dir"; fi
fi
if command -v uv >/dev/null; then uv pip install -q --python "$env_dir/bin/python" iterm2; else "$env_dir/bin/python" -m pip install -q --upgrade iterm2; fi

homes=("${(@f)$(node "$deck/accounts-setup.js" --homes claude)}")
homes=(${homes:#})

# Whether chats ask before running commands and editing files. A team kit
# follows the owner's deck; otherwise the choice made the first time is kept.
skip=false
if (( team )); then
  skip=true
elif [[ -f "$deck/config.toml" ]]; then
  if grep -q '^  dangerous_mode = true' "$deck/config.toml"; then skip=true; fi
elif (( interactive )); then
  if [[ "$(ask "Let chats run commands and edit files without asking each time? [y/N]: ")" == [yY]* ]]; then skip=true; fi
fi
if [[ $skip == true ]]; then
  for home in $homes; do
    node -e '
      const fs=require("fs"),file=process.argv[1]+"/settings.json";
      let settings={};try{settings=JSON.parse(fs.readFileSync(file,"utf8"));}catch{}
      fs.writeFileSync(file,JSON.stringify({skipDangerousModePermissionPrompt:true,...settings},null,2)+"\n");
    ' "$home"
  done
fi

if (( interactive )); then
  step "Sign-in"
  node "$deck/accounts-setup.js" --sign-in || print "  The setup carries on; it lists what is left at the end."
fi

# The model and effort new chats start with: asked once for each kind of
# account (a team kit suggests the owner's); accounts added later get the same.
models=(--suggest "$kit/deck/team-models.json")
(( interactive )) && models+=(--ask)
node "$deck/models.js" $models || print "  The default model could not be set; change it later with --models."

step "Deck configuration"
default_dir="${homes[1]:-$HOME/.claude}"
(cd "$deck" && node -e '
  const fs=require("fs"),[template,folder,claudeDir,skip]=process.argv.slice(1);
  const profiles=require("child_process").execFileSync(process.execPath,["accounts-setup.js","--profiles"],{encoding:"utf8"}).trimEnd();
  const text=fs.readFileSync(template,"utf8").replace("__DEFAULT_FOLDER__",folder).replace("__DEFAULT_CLAUDE_DIR__",claudeDir).replace("__PROFILES__",profiles).replaceAll("__SKIP_PERMISSIONS__",skip).replace("__CURSOR_COMMAND__",skip==="true"?"agent --force":"agent").replace("__DECK__",process.cwd());
  fs.writeFileSync("config.toml",text,{mode:0o600});
' "$kit/config.template.toml" "$folder" "$default_dir" "$skip")

step "Building Agent Deck (first build takes a few minutes)"
"$deck/rebuild-agent-deck" --force || fail "The build did not finish. See ~/Library/Logs/Agent Deck.log"
print "  $(agent-deck --version 2>/dev/null | tail -1)"
agent-deck telemetry disable >/dev/null 2>&1 || true

step "Status hooks for each account"
for home in $homes; do CLAUDE_CONFIG_DIR="$home" agent-deck hooks install >/dev/null 2>&1 || fail "Could not add the status hooks for $home."; done

step "Agent Deck app (builds in about a minute)"
rm -f "$bin/agent-deck-six"
cat > "$bin/agent-deck-run" <<'LAUNCH'
#!/bin/zsh
# Runs one program of a deck window in its pane, starting it again if
# it fails. It ends with the pane.
# Usage: agent-deck-run <workspace> <script> [args…]
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export AGENTDECK_SUPPRESS_TMUX_WARNING=1 AGENT_DECK_ALLOW_OUTER_TMUX=1
export LANG=en_US.UTF-8 LC_CTYPE=en_US.UTF-8
export AGENT_DECK_WORKSPACE="$1"; shift
unset TMUX
while true; do
  node "$@"
  code=$?
  (( code == 0 || code > 128 )) && exit $code
  # 75: the deck's code was updated; start again straight away.
  (( code == 75 )) || sleep 1
done
LAUNCH
chmod +x "$bin/agent-deck-run" "$deck/app/build-app"
# An earlier kit put a different Agent Deck app in ~/Applications; only this one stays.
old_app="$HOME/Applications/Agent Deck.app"
if [[ -d "$old_app" ]]; then
  pkill -f "$old_app/" 2>/dev/null || true
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -u "$old_app" 2>/dev/null || true
  rm -rf "$old_app"
  replaced=1
fi
"$deck/app/build-app" >/dev/null || fail "The app did not build. Run $deck/app/build-app to see why."
# The Dock keeps its own copy of app icons; without this it can show the old one.
if (( ${replaced:-0} )); then rm -f "$(getconf DARWIN_USER_CACHE_DIR)com.apple.dock.iconcache"; killall Dock 2>/dev/null || true; fi

step "Daily rebuild on new Agent Deck releases"
plist="$HOME/Library/LaunchAgents/local.agent-deck.rebuild.plist"
mkdir -p "${plist:h}"
cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>local.agent-deck.rebuild</string>
  <key>ProgramArguments</key>
  <array><string>/bin/zsh</string><string>$deck/rebuild-agent-deck</string></array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>5</integer><key>Minute</key><integer>30</integer></dict>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/Agent Deck.log</string>
  <key>StandardOutPath</key><string>/dev/null</string>
</dict>
</plist>
PLIST
launchctl bootout "gui/$(id -u)/local.agent-deck.rebuild" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$plist"

if ! node "$deck/accounts-setup.js" --check; then
  print "\nSign in to the accounts above, then open Agent Deck from Applications:"
  print "  curl -fsSL https://raw.githubusercontent.com/tadyuh76/agent-deck/main/install.sh | zsh -s -- --sign-in"
  exit 3
fi
print "\nDone. Agent Deck is in Applications; keep it in the Dock."
print "Right-click it in the Dock, or press ⌘N, for a new deck."
if (( interactive )); then open -a "Agent Deck"; fi
