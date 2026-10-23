#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
account="${1:-}"
# The account slot (its name in lower case) and its email come from the
# deck's account list, ~/.config/agent-deck/accounts.js.
lookup="$(node -e '
const want = process.argv[1];
const list = require(process.env.HOME + "/.config/agent-deck/account-registry").accounts.filter(a => a.tool === "claude");
const a = list.find(a => a.slot.toLowerCase() === want);
if (!a) { console.error("Usage: agent-deck-login " + list.map(a => a.slot.toLowerCase()).join("|")); process.exit(1); }
console.log(a.home + "\t" + a.email);
' "$account")" || exit 1
IFS=$'\t' read -r config email <<<"$lookup"
echo "Sign in to $email in the browser."
echo 'If the browser does not open, copy the URL printed below into your browser.'
env -i HOME="$HOME" USER="$USER" TERM="${TERM:-xterm-256color}" PATH="$PATH" LANG=en_US.UTF-8 \
  WSL_INTEROP="${WSL_INTEROP:-}" WSL_DISTRO_NAME="${WSL_DISTRO_NAME:-Ubuntu-24.04}" \
  BROWSER="$HOME/.local/bin/agent-deck-login-browser" AGENT_DECK_LOGIN_ACCOUNT="$account" CLAUDE_CONFIG_DIR="$config" \
  claude auth login --email "$email"
identity="$(env -i HOME="$HOME" PATH="$PATH" CLAUDE_CONFIG_DIR="$config" claude auth status)"
actual="$(printf '%s' "$identity" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("email", ""))')"
if [[ "${actual,,}" != "${email,,}" ]]; then
  echo "This slot signed in as $actual. It must use $email."
  echo 'Switch to the correct account in the browser, then run this sign-in shortcut again.'
  read -r -p 'Press Enter to close. ' || true
  exit 1
fi
echo "Signed in correctly as $actual. You can close this tab."
read -r -p 'Press Enter to close. ' || true
