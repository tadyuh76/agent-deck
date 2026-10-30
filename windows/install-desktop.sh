#!/usr/bin/env bash
set -euo pipefail
kit="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$HOME/.local/bin:/usr/bin:/bin"
target="$HOME/.local/share/agent-deck/desktop"
root="$HOME/.config/agent-deck"
mkdir -p "$target"
printf '%s\n' '{"private":true,"dependencies":{"node-pty":"1.1.0"}}' > "$target/package.json"
(cd "$target" && npm install --no-audit --no-fund)
cp "$kit"/desktop/backend/*.cjs "$target/"
mkdir -p "$root/git-bin"
cat > "$root/git-bin/git" <<'BRIDGE'
#!/bin/sh
exec "$HOME/.local/bin/node" "$HOME/.local/share/agent-deck/desktop/git-agent-bridge.cjs" "$@"
BRIDGE
chmod 700 "$root/git-bin/git"
cp "$kit/deck/terminal-env.js" "$root/terminal-env.js"
cp "$kit/deck/panel.js" "$root/panel.js"
cp "$kit/deck/claude-skills.js" "$root/claude-skills.js"
# Quota display and panel helpers used by the desktop backend.
for name in account-usage.js panels.js workspace.js; do
  cp "$kit/deck/$name" "$root/$name"
  node --check "$root/$name"
done
node --check "$root/panel.js"
cp "$kit/windows/desktop-bridge.js" "$root/desktop-bridge.js"
if [[ ! -f "$root/iterm.js.before-desktop" ]]; then cp "$root/iterm.js" "$root/iterm.js.before-desktop"; fi
cp "$kit/windows/iterm-desktop.js" "$root/iterm.js"
node --check "$root/iterm.js"
# Launcher for the browser MCP server (Windows Node, isolated context per
# session). Registering it with Claude is a separate, explicit step.
browser_dir="$(wslpath "$(/mnt/c/Windows/System32/cmd.exe /c 'echo %LOCALAPPDATA%' 2>/dev/null | tr -d '\r')")/AgentDeck/browser"
if [[ -f "$browser_dir/browser-mcp.cjs" ]]; then
  cat > "$HOME/.local/bin/agent-deck-browser-mcp" <<BROWSER
#!/bin/sh
exec "/mnt/c/Program Files/nodejs/node.exe" '$(wslpath -w "$browser_dir/browser-mcp.cjs")' --isolated "\$@"
BROWSER
  chmod 755 "$HOME/.local/bin/agent-deck-browser-mcp"
fi
echo 'Desktop backend installed.'
