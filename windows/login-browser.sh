#!/usr/bin/env bash
# Keep each slot's OAuth browser cookies separate from the other accounts.
set -euo pipefail
account="${AGENT_DECK_LOGIN_ACCOUNT:?Missing account slot}"
# The slot names a browser profile folder; accept only a plain name.
[[ "$account" =~ ^[a-z0-9][a-z0-9._-]*$ ]] || exit 1
url="${1:?Missing sign-in URL}"
case "$url" in https://*) ;; *) echo 'Expected an HTTPS sign-in URL.' >&2; exit 1 ;; esac
browser='/mnt/c/Program Files/Google/Chrome/Application/chrome.exe'
if [[ ! -f "$browser" ]]; then browser='/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'; fi
[[ -f "$browser" ]] || { echo 'Chrome or Edge is required for isolated sign-in.' >&2; exit 1; }
local_app_data="$(cd /mnt/c && /mnt/c/Windows/System32/cmd.exe /d /c 'echo %LOCALAPPDATA%' | tr -d '\r')"
profile="$(wslpath -u "$local_app_data")/AgentDeck/Login/$account"
mkdir -p "$profile"
exec "$browser" "--user-data-dir=$(wslpath -w "$profile")" --no-first-run --no-default-browser-check --new-window "$url"
