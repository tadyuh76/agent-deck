#!/usr/bin/env bash
# Run as root inside the WSL distribution: the Linux tools Agent Deck needs.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q tmux git golang-go build-essential python3 curl ca-certificates xz-utils wslu locales
# The deck's terminals run with LANG=en_US.UTF-8.
locale -a | grep -qi '^en_US\.utf-\?8$' || locale-gen en_US.UTF-8
echo 'Linux packages ready.'
