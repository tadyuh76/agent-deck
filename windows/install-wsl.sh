#!/usr/bin/env bash
# Run as the regular WSL user after installing tmux, node, git, go and build tools.
set -euo pipefail
kit="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$HOME/.local/bin:/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
for variable in ${!CLAUDE@} ${!ANTHROPIC_@}; do unset "$variable"; done
unset AI_AGENT TMUX
deck="$HOME/.config/agent-deck"
state="$HOME/.local/state/agent-deck"
source_dir="$HOME/.local/share/agent-deck/source"
stamp="$(date +%Y%m%d-%H%M%S)"
# The two projects the six panels open by default (odd and even panels).
web="${1:?Pass the WSL path of the first project folder}"
mobile="${2:?Pass the WSL path of the second project folder (may be the same)}"
[[ -d "$web" && -d "$mobile" ]] || { echo 'Both project folders must exist.' >&2; exit 1; }
mkdir -p "$deck" "$state" "$HOME/.local/bin" "$HOME/Projects"
if [[ ! -x "$HOME/.local/bin/node" || ! -x "$HOME/.local/bin/npm" ]]; then
  bash "$kit/windows/install-node.sh"
fi
for existing in config.toml paths.js iterm.js; do
  if [[ -f "$deck/$existing" ]]; then cp -p "$deck/$existing" "$deck/$existing.before-wsl-$stamp"; fi
done
for file in "$kit"/deck/*.js; do
  case "$(basename "$file")" in accounts.js|accounts.example.js) ;; *) cp "$file" "$deck/" ;; esac
done
cp "$kit/deck/agent-deck.patch" "$kit/deck/agent-deck.base" "$kit/deck/agy-chat" "$deck/"
# The account list is personal: keep one already installed, otherwise take
# the kit's own, or build it from the emails in AGENT_DECK_ACCOUNTS / asked.
if [[ ! -f "$deck/accounts.js" ]]; then
  if [[ -n "${AGENT_DECK_ACCOUNTS:-}" ]]; then
    node "$kit/windows/make-accounts.js" "$deck/accounts.js" "$AGENT_DECK_ACCOUNTS"
  elif [[ -f "$kit/deck/accounts.js" ]]; then
    cp "$kit/deck/accounts.js" "$deck/accounts.js"
  else
    read -r -p 'Claude sign-in emails, separated by commas: ' emails
    node "$kit/windows/make-accounts.js" "$deck/accounts.js" "$emails"
  fi
fi
cp "$kit/windows/paths.js" "$kit/windows/tmux-controller.js" "$deck/"
printf '%s\n' "module.exports = require('./tmux-controller');" > "$deck/iterm.js"
if [[ -f "$HOME/.local/share/agent-deck/desktop/backend.cjs" ]]; then
  cp "$kit/windows/desktop-bridge.js" "$deck/desktop-bridge.js"
  cp "$kit/windows/iterm-desktop.js" "$deck/iterm.js"
fi
chmod +x "$deck"/{workspace,panel,panel-labels,limit-router,models,accounts-setup}.js "$deck/agy-chat"

if [[ ! -x "$HOME/.local/bin/claude" ]]; then
  echo 'Installing Claude Code from the official installer...'
  if curl --connect-timeout 20 --max-time 120 -fsSL https://claude.ai/install.sh -o "$state/install-claude.sh"; then
    bash "$state/install-claude.sh"
  else
    bash "$kit/windows/install-claude.sh"
  fi
fi
claude --version

echo 'Configuring the three isolated accounts and the two projects...'
node - "$kit/config.template.toml" "$web" "$mobile" <<'NODE'
const fs = require('fs'), os = require('os');
const [template, web, mobile] = process.argv.slice(2), home = os.homedir();
const root = home + '/.config/agent-deck';
const accounts = require(root + '/account-registry').accounts;
const shared = home + '/.claude/projects';
fs.mkdirSync(shared, {recursive: true, mode: 0o700});
for (const a of accounts.filter(a => a.tool === 'claude')) {
  fs.mkdirSync(a.home, {recursive: true, mode: 0o700});
  const projects = a.home + '/projects';
  try {
    const stat = fs.lstatSync(projects);
    if (!stat.isSymbolicLink() || fs.readlinkSync(projects) !== shared) throw new Error('Existing account project folder needs manual review: ' + projects);
  } catch (error) { if (error.code === 'ENOENT') fs.symlinkSync(shared, projects); else throw error; }
  const file = a.home + '/settings.json';
  let settings = {}; try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Use the CLI's supported model alias. Keep the user's saved preferences.
  fs.writeFileSync(file, JSON.stringify({model: 'opus', effortLevel: 'high', ...settings}, null, 2) + '\n', {mode: 0o600});
}
// Same configuration as the Mac setup; Windows keeps Claude's permission prompts.
const profiles = require('child_process').execFileSync(process.execPath, [root + '/accounts-setup.js', '--profiles'], {encoding: 'utf8'}).trimEnd();
const claudeHome = (accounts.find(a => a.tool === 'claude') || accounts[0]).home;
const text = fs.readFileSync(template, 'utf8').replace('__DEFAULT_FOLDER__', web).replace('__DEFAULT_CLAUDE_DIR__', claudeHome).replace('__PROFILES__', profiles).replaceAll('__SKIP_PERMISSIONS__', 'false').replace('__CURSOR_COMMAND__', 'agent').replace('__DECK__', root);
fs.writeFileSync(root + '/config.toml', text, {mode: 0o600});
fs.writeFileSync(root + '/windows-projects.json', JSON.stringify({web, mobile}, null, 2) + '\n', {mode: 0o600});
const panels = require(root + '/panels');
for (let slot = 1; slot <= 6; slot++) {
  const old = panels.read('claude-desk', slot);
  if (!old.lastId) panels.write('claude-desk', slot, {path: slot % 2 ? web : mobile});
}
for (const target of new Set([web, mobile])) {
  const name = require('path').basename(target);
  const link = home + '/Projects/' + name;
  try { fs.lstatSync(link); } catch (error) { if (error.code === 'ENOENT') fs.symlinkSync(target, link); else throw error; }
}
NODE

echo 'Building the supplied customized Agent Deck source...'
base="$(tr -d '\r\n' < "$deck/agent-deck.base")"
if [[ ! -d "$source_dir/.git" ]]; then
  mkdir -p "$source_dir"
  archive="$state/agent-deck-$base.tar.gz"
  curl --connect-timeout 20 --max-time 240 --retry 2 -fsSL "https://github.com/asheshgoplani/agent-deck/archive/refs/tags/v$base.tar.gz" -o "$archive"
  tar xzf "$archive" -C "$source_dir" --strip-components=1
  git -C "$source_dir" init -q -b deck
  git -C "$source_dir" add -A
  git -C "$source_dir" -c user.name=AgentDeck -c user.email=deck@localhost commit -qm "upstream v$base"
  git -C "$source_dir" apply --ignore-space-change --index "$deck/agent-deck.patch"
  git -C "$source_dir" -c user.name=AgentDeck -c user.email=deck@localhost commit -qm 'supplied deck customizations'
fi
cd "$source_dir"
GOTOOLCHAIN=auto GOMAXPROCS=2 go build -p 2 -trimpath -ldflags "-s -w -X main.Version=$base+local.wsl" -o "$HOME/.local/bin/agent-deck.new" ./cmd/agent-deck
chmod 755 "$HOME/.local/bin/agent-deck.new"
mv "$HOME/.local/bin/agent-deck.new" "$HOME/.local/bin/agent-deck"
agent-deck --version
agent-deck telemetry disable
node -e 'for (const a of require(process.argv[1]).accounts) if (a.tool === "claude") console.log(a.home)' "$deck/account-registry" |
while read -r config; do
  AGENTDECK_PROFILE=default CLAUDE_CONFIG_DIR="$config" agent-deck hooks install
done

cat > "$HOME/.local/bin/agent-deck-run" <<'RUN'
#!/usr/bin/env bash
export PATH="$HOME/.local/bin:/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export AGENTDECK_SUPPRESS_TMUX_WARNING=1 AGENT_DECK_ALLOW_OUTER_TMUX=1
export LANG=en_US.UTF-8 LC_CTYPE=en_US.UTF-8
export AGENT_DECK_WORKSPACE="$1"
shift
unset TMUX
while true; do
  node "$@"
  code=$?
  if (( code == 0 || code > 128 )); then exit "$code"; fi
  if (( code != 75 )); then sleep 1; fi
done
RUN
cat > "$HOME/.local/bin/agent-deck-windows" <<'LAUNCH'
#!/usr/bin/env bash
export PATH="$HOME/.local/bin:/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 TERM=xterm-256color
unset TMUX
exec node "$HOME/.config/agent-deck/tmux-controller.js" "${1:-claude-desk}"
LAUNCH
cp "$kit/windows/login.sh" "$HOME/.local/bin/agent-deck-login"
cp "$kit/windows/login-browser.sh" "$HOME/.local/bin/agent-deck-login-browser"
chmod +x "$HOME/.local/bin/agent-deck-"{run,windows,login,login-browser}
if ! grep -qF '# Agent Deck WSL' "$HOME/.bashrc"; then
  cat >> "$HOME/.bashrc" <<'PROFILE'

# Agent Deck WSL
export PATH="$HOME/.local/bin:$PATH"
export BROWSER=/usr/bin/wslview
PROFILE
fi
echo 'Installing Claude Code plugins for every account...'
node "$deck/claude-skills.js" install || echo "Plugin setup incomplete; rerun: node $deck/claude-skills.js install"
slots="$(node -e 'console.log(require(process.argv[1]).accounts.filter(a => a.tool === "claude").map(a => a.slot.toLowerCase()).join(", "))' "$deck/account-registry")"
echo "Installed. Sign in each account with agent-deck-login <name> ($slots)."
