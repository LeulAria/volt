#!/bin/sh
# Runs a command with a minimal environment: no CLAUDE_*/ANTHROPIC_* from the session that starts it.
exec env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" SHELL="${SHELL:-/bin/zsh}" TERM="${TERM:-xterm-256color}" LANG="${LANG:-en_US.UTF-8}" TMPDIR="$TMPDIR" PATH="/Users/leularia/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/Users/leularia/.bun/bin" "$@"
