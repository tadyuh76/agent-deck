#!/usr/bin/env bash
# Match the Windows Node 22 major version, with native Linux npm binaries.
set -euo pipefail
state="$HOME/.local/state/agent-deck"
mkdir -p "$state" "$HOME/.local/bin" "$HOME/.local/share/agent-deck"
curl --connect-timeout 20 --max-time 60 -fsSL https://nodejs.org/dist/index.json -o "$state/node-releases.json"
version="$(python3 -c 'import json,pathlib; releases=json.loads((pathlib.Path.home()/".local/state/agent-deck/node-releases.json").read_text()); print(next(r["version"] for r in releases if r["version"].startswith("v22.") and r["lts"]))')"
[[ "$version" =~ ^v22\.[0-9]+\.[0-9]+$ ]] || exit 1
archive="node-$version-linux-x64.tar.xz"
curl --connect-timeout 20 --max-time 180 --retry 2 -fsSL "https://nodejs.org/dist/$version/$archive" -o "$state/$archive"
curl --connect-timeout 20 --max-time 60 -fsSL "https://nodejs.org/dist/$version/SHASUMS256.txt" -o "$state/node-shasums.txt"
(cd "$state" && grep " $archive\$" node-shasums.txt | sha256sum --check --strict)
tar xJf "$state/$archive" -C "$HOME/.local/share/agent-deck"
for command in node npm npx corepack; do
  source_file="$HOME/.local/share/agent-deck/node-$version-linux-x64/bin/$command"
  if [[ -e "$source_file" ]]; then ln -sfn "$source_file" "$HOME/.local/bin/$command"; fi
done
"$HOME/.local/bin/node" --version
PATH="$HOME/.local/bin:$PATH" "$HOME/.local/bin/npm" --version
