#!/usr/bin/env bash
set -euo pipefail

DOTFILES="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$HOME/.config/tmux"
ln -sf "$DOTFILES/tmux/tmux.conf" "$HOME/.config/tmux/tmux.conf"
ln -sf "$DOTFILES/git/gitconfig" "$HOME/.gitconfig"

grep -qxF "source $DOTFILES/bash/aliases" "$HOME/.bashrc" 2>/dev/null \
	|| echo "source $DOTFILES/bash/aliases" >> "$HOME/.bashrc"
