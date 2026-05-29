# Custom zsh prompt: time + user@host + cwd + git branch/dirty + exit-code marker
# Sourced from ~/.zshrc by install.sh

setopt prompt_subst
autoload -Uz vcs_info
zstyle ':vcs_info:git:*' formats ' (%b%u%c)'
zstyle ':vcs_info:git:*' actionformats ' (%b|%a%u%c)'
zstyle ':vcs_info:*' check-for-changes true
zstyle ':vcs_info:*' unstagedstr '*'
zstyle ':vcs_info:*' stagedstr '+'
precmd() {
  local ec=$?
  vcs_info
  if (( ec )); then __err="%F{red}✘${ec}%f "; else __err=""; fi
}

# show ✘<code> only when the previous command failed
PROMPT='%F{8}%D{%H:%M}%f %F{green}%n@%m%f:%F{blue}%~%f%F{yellow}${vcs_info_msg_0_}%f
${__err}%(!.#.$) '
