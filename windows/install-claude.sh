#!/usr/bin/env bash
# Native Claude installer fallback when claude.ai/install.sh is rate limited.
set -euo pipefail
state="$HOME/.local/state/agent-deck"
mkdir -p "$state"
bucket='https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases'
version="$(curl --connect-timeout 20 --max-time 60 -fsSL "$bucket/latest")"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Invalid Claude release version.' >&2; exit 1; }
curl --connect-timeout 20 --max-time 60 -fsSL "$bucket/$version/manifest.json" -o "$state/claude-manifest.json"
curl --connect-timeout 20 --max-time 300 --retry 2 -fsSL "$bucket/$version/linux-x64/claude" -o "$state/claude-download"
python3 - <<'PY'
import hashlib
import json
from pathlib import Path
state = Path.home() / '.local/state/agent-deck'
expected = json.loads((state / 'claude-manifest.json').read_text())['platforms']['linux-x64']['checksum']
with (state / 'claude-download').open('rb') as binary:
    actual = hashlib.file_digest(binary, 'sha256').hexdigest()
if actual != expected:
    raise SystemExit('Claude binary SHA-256 mismatch')
print('Claude binary SHA-256 verified')
PY
chmod 755 "$state/claude-download"
"$state/claude-download" install "$version"
