#!/bin/zsh
# Installs Agent Deck on this Mac.
# One line:  curl -fsSL https://raw.githubusercontent.com/tadyuh76/agent-deck/main/install.sh | zsh
# Usage: ./install.sh [default-working-folder]   full setup (asks for the folder if omitted)
#        ./install.sh --add-account              add another Claude account, then update the setup
#        ./install.sh --folder <path>            only change the default working folder
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
if [[ "${1:-}" == --uninstall ]]; then
  step "Removing Agent Deck"
  homes=()
  [[ -f "$deck/accounts.js" ]] && homes=("${(@f)$(cd "$deck" && node -e 'for(const a of require("./account-registry").accounts)if(a.tool==="claude")console.log(a.home)' 2>/dev/null)}")
  for home in $homes; do CLAUDE_CONFIG_DIR="$home" agent-deck hooks uninstall >/dev/null 2>&1 || true; done
  pkill -x AgentDeck 2>/dev/null || true
  tmux -L agent-deck-managed kill-server 2>/dev/null || true
  launchctl bootout "gui/$(id -u)/local.agent-deck.rebuild" 2>/dev/null || true
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -u "/Applications/Agent Deck.app" 2>/dev/null || true
  rm -rf "/Applications/Agent Deck.app" "$deck" "$HOME/.local/share/agent-deck" "$HOME/Library/Application Support/AgentDeck" \
    "$HOME/Library/LaunchAgents/local.agent-deck.rebuild.plist" "$bin/agent-deck" "$bin/agent-deck-run"
  defaults delete local.agentdeck.app 2>/dev/null || true
  print "Removed. Your Claude accounts and conversations are still there."
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
command -v claude >/dev/null || curl -fsSL https://claude.ai/install.sh | bash
command -v claude >/dev/null || fail "Claude Code did not install. See https://claude.com/claude-code"
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
cp "$kit"/deck/*.js "$kit/deck/iterm.py" "$kit/deck/iterm-profile.json" "$kit/deck/rebuild-agent-deck" "$kit/deck/agent-deck.patch" "$kit/deck/agent-deck.base" "$deck/"
rm -rf "$deck/app"; cp -R "$kit/app" "$deck/app"
chmod +x "$deck"/{workspace,panel,panel-labels,limit-router}.js "$deck/iterm.py" "$deck/rebuild-agent-deck"
touch "$deck/.installed-by-kit"

if [[ ! -f "$deck/accounts.js" ]] || (( add_account )); then
  step "Claude accounts"
  print "Agent Deck can use several Claude accounts. When a chat reaches an account's"
  print "usage limit, it carries on in another one. Start with yours; add more any time."
  existing=$(env -i HOME="$HOME" PATH="$PATH" claude auth status </dev/null 2>/dev/null | node -e 'try{const s=JSON.parse(require("fs").readFileSync(0,"utf8"));if(s.loggedIn&&s.email)console.log(s.email);}catch{}' || true)
  # A short name shown on its chats, e.g. "Work"; suggested from the email.
  account_name() {
    local suggested="${(C)${${1%%@*}//[^A-Za-z0-9]/ }}" name=""
    suggested="${${suggested[1,12]}% }"
    if (( interactive )); then name=$(ask "  Short name for it [$suggested]: "); fi
    print -r -- "${${name:-$suggested}[1,12]}"
  }
  entries=()
  if [[ ! -f "$deck/accounts.js" ]]; then
    email=""
    if (( interactive )); then email=$(ask "Your Claude account email${existing:+ [$existing]}: "); fi
    email="${email:-$existing}"
    [[ "$email" == *@* ]] || fail "Run this in Terminal so it can ask for your Claude account."
    entries+=("$email" "$(account_name "$email")" "$HOME/.claude")
  fi
  while (( interactive )); do
    email=$(ask "Another Claude account's email (Enter to finish): ")
    [[ -n "$email" ]] || break
    if [[ "$email" != *@* ]]; then print "That is not an email address."; continue; fi
    entries+=("$email" "$(account_name "$email")" "")
    if (( add_account )); then break; fi
  done
  # Each account gets a short name, a colour and its own folder.
  (cd "$deck" && node -e '
    const fs=require("fs"),file="accounts.js",entries=process.argv.slice(1);
    let list=[];try{list=require("./"+file).map(a=>({...a,home:a.home.replace(require("os").homedir(),"~")}));}catch{}
    const colors=["218;119;86","94;202;221","154;201;87","224;106;180","234;181;80","66;133;244","175;135;255","39;199;168"];
    for(let i=0;i<entries.length;i+=3){
      const email=entries[i];if(list.some(a=>a.email===email))continue;
      const name=entries[i+1].trim()||"Claude",base=name.replace(/[^A-Za-z0-9]/g,"")||"Claude";
      let slot=base;for(let n=2;list.some(a=>a.slot===slot);n++)slot=base+n;
      const home=entries[i+2]?entries[i+2].replace(require("os").homedir(),"~"):"~/.claude-"+slot.toLowerCase();
      list.push({name,tool:"claude",slot,email,color:colors[list.length%colors.length],home});
    }
    fs.writeFileSync(file,"module.exports="+JSON.stringify(list,null,2)+";\n");
    for(const a of list)console.log("  "+a.name.padEnd(13)+a.email);
  ' "${entries[@]}")
fi

step "Deck controller"
# The controller that arranges the deck windows talks to the app through iTerm2's Python API.
env_dir="$HOME/.local/share/agent-deck/iterm-env"
if [[ ! -x "$env_dir/bin/python" ]]; then
  if command -v uv >/dev/null; then uv venv -q --python 3.12 "$env_dir"; else python3 -m venv "$env_dir"; fi
fi
if command -v uv >/dev/null; then uv pip install -q --python "$env_dir/bin/python" iterm2; else "$env_dir/bin/python" -m pip install -q --upgrade iterm2; fi

step "Accounts and shared conversation folder"
# Every account reads and writes one transcripts folder, so a chat can move
# between accounts without losing its history.
shared="$HOME/.claude/projects"
mkdir -p "$shared"
homes=("${(@f)$(cd "$deck" && node -e 'for(const a of require("./account-registry").accounts)if(a.tool==="claude")console.log(a.home)')}")
for home in $homes; do
  mkdir -p "$home"
  if [[ -L "$home/projects" ]]; then
    [[ "$(readlink "$home/projects")" == "$shared" ]] || { rm "$home/projects"; ln -s "$shared" "$home/projects"; }
  elif [[ "$home/projects" -ef "$shared" ]]; then
    :
  else
    if [[ -d "$home/projects" ]]; then
      cp -Rn "$home/projects/" "$shared/" 2>/dev/null || true
      mv "$home/projects" "$home/projects.before-kit-$stamp"
    fi
    ln -s "$shared" "$home/projects"
  fi
  # A team kit: the same defaults as the owner's deck, newest Opus at extra-high effort.
  if (( team )); then
    node -e '
      const fs=require("fs"),file=process.argv[1]+"/settings.json";
      let settings={};try{settings=JSON.parse(fs.readFileSync(file,"utf8"));}catch{}
      const merged={model:"claude-opus-5-5",effortLevel:"xhigh",skipDangerousModePermissionPrompt:true,...settings};
      fs.writeFileSync(file,JSON.stringify(merged,null,2)+"\n");
    ' "$home"
  fi
done

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

# Signs in each account that is not signed in yet (in Terminal, through the
# browser), and lists any still missing.
signed_in() {
  env -i HOME="$HOME" PATH="$PATH" CLAUDE_CONFIG_DIR="$1" claude auth status </dev/null 2>/dev/null |
    node -e 'try{const s=JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit(s.loggedIn&&s.email===process.argv[1]?0:1);}catch{process.exit(1);}' "$2"
}
sign_in() {
  local login=$1 name email home
  while IFS=$'\t' read -r name email home; do
    if signed_in "$home" "$email"; then
      if (( login )); then print "  signed in      ${(r:13:)name}$email"; fi
      continue
    fi
    if (( login )); then
      print "  Sign in as $email ($name) in the browser window that opens."
      env -i HOME="$HOME" PATH="$PATH" CLAUDE_CONFIG_DIR="$home" claude auth login --email "$email" </dev/tty || true
      if signed_in "$home" "$email"; then print "  signed in      ${(r:13:)name}$email"; continue; fi
    fi
    missing=1
    print "  NOT SIGNED IN  ${(r:13:)name}$email"
    print "    env -i HOME=\"\$HOME\" PATH=\"\$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin\" CLAUDE_CONFIG_DIR=\"$home\" claude auth login --email $email"
  done < <(cd "$deck" && node -e 'for(const a of require("./account-registry").accounts)if(a.tool==="claude")console.log([a.name,a.email,a.home].join("\t"))')
}
if (( interactive )); then
  step "Sign-in"
  missing=0
  sign_in 1
  if (( missing )); then print "  The setup carries on; it lists what is left at the end."; fi
fi

step "Deck configuration"
default_dir="${homes[1]}"
(cd "$deck" && node -e '
  const fs=require("fs"),[template,folder,claudeDir,skip]=process.argv.slice(1);
  const accounts=require("./account-registry").accounts;
  const profiles=accounts.map(a=>`    [profiles.${a.slot}.${a.tool}]\n      config_dir = ${JSON.stringify(a.home)}`).join("\n");
  const text=fs.readFileSync(template,"utf8").replace("__DEFAULT_FOLDER__",folder).replace("__DEFAULT_CLAUDE_DIR__",claudeDir).replace("__PROFILES__",profiles).replace("__SKIP_PERMISSIONS__",skip);
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

missing=0
sign_in 0
if (( missing )); then print "\nSign in to the accounts above, then open Agent Deck from Applications."; exit 3; fi
print "\nDone. Agent Deck is in Applications; keep it in the Dock."
print "Right-click it in the Dock, or press ⌘N, for a new deck."
if (( interactive )); then open -a "Agent Deck"; fi
