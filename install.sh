#!/bin/zsh
# Copy the plugin into a vault. There is no build step — main.js is the source.
#
# Target: $1, or the path in .dev-vault, e.g.
#   <vault>/.obsidian/plugins/folder-drawer
set -e
cd "$(dirname "$0")"
dest=${1:-$( [[ -f .dev-vault ]] && < .dev-vault )}
[[ -n $dest ]] || { print -u2 "usage: ./install.sh <vault>/.obsidian/plugins/folder-drawer"; exit 1; }
mkdir -p "$dest"
cp main.js styles.css manifest.json "$dest/"
print "installed to $dest"
