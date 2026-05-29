#!/usr/bin/env bash
set -euo pipefail

DOTFILES="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$HOME/.config/tmux"
ln -sf "$DOTFILES/tmux/tmux.conf" "$HOME/.config/tmux/tmux.conf"
ln -sf "$DOTFILES/git/gitconfig" "$HOME/.gitconfig"

# Full shell rc files are repo-managed; symlink them into place.
# (They source the aliases/prompt fragments under bash/ and zsh/.)
ln -sf "$DOTFILES/bash/bashrc" "$HOME/.bashrc"
ln -sf "$DOTFILES/zsh/zshrc"  "$HOME/.zshrc"
