#!/usr/bin/env bash
set -euo pipefail

sudo apt-get update
sudo apt-get install -y tmux git neovim

"$(cd "$(dirname "$0")" && pwd)"/install.sh
