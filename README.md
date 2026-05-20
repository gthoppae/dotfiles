# dotfiles

Personal dotfiles managed via symlinks.

## Install

```bash
git clone https://github.com/gthoppae/dotfiles.git ~/dotfiles
~/dotfiles/install.sh
```

`install.sh` is idempotent — safe to re-run after pulling updates.

## Bootstrap (fresh machine)

`bootstrap.sh` installs base packages, then runs `install.sh`. Use on a new
bare-metal/VM host; containers should call `install.sh` directly.

```bash
~/dotfiles/bootstrap.sh
```

## Structure

```
dotfiles/
├── bash/
│   ├── aliases       # shell aliases (sourced from ~/.bashrc)
│   └── exports       # env vars (not sourced yet — wire up when needed)
├── git/
│   └── gitconfig     # symlinked to ~/.gitconfig
├── tmux/
│   └── tmux.conf     # symlinked to ~/.config/tmux/tmux.conf
├── install.sh        # symlinks configs into place
└── bootstrap.sh      # apt-installs base tools, then runs install.sh
```

## Pi packages

The Data 360 browser/query explorer package now lives outside this dotfiles repo:

```text
https://github.com/gthoppae/pi-data360-browser
```

Install it in pi with:

```text
pi install git:github.com/gthoppae/pi-data360-browser
```

## Use in a dev container

```dockerfile
RUN apt-get update && apt-get install -y tmux git curl && rm -rf /var/lib/apt/lists/*
RUN git clone https://github.com/gthoppae/dotfiles.git /root/dotfiles && \
    /root/dotfiles/install.sh
```

For iteration without rebuilding, mount the repo:

```bash
docker run -d --name devbox \
  -v "$PWD":/workspace \
  -v ~/dotfiles:/root/dotfiles \
  --entrypoint sleep my-dev-image infinity
```
