#!/usr/bin/env bash
# make-extension-ubuntu.sh — Builds the Word Replacer extension for Vivaldi on Ubuntu (or WSL).
#
# What it does:
#   1. zips the extension/ folder into word-replacer-extension.zip
#   2. extracts that ZIP into the folder you load in Vivaldi ("Load unpacked")
#   3. prints both locations (in WSL it also copies the folder path to the Windows clipboard)
#
# Output folder: WSL    -> C:\Users\<you>\VivaldiExtensions\   (Vivaldi runs on Windows)
#                Ubuntu -> ~/VivaldiExtensions/
#                or the folder given as the first argument.
# Usage: bash make-extension-ubuntu.sh [output-folder]
# Needs: python3 (installed on Ubuntu by default). Set WR_NO_CLIPBOARD=1 to skip the clipboard.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$REPO/extension"
MARKER="DEPLOYED-BY-WORD-REPLACER.txt"

# Prints an error and stops.
fail() {
  echo "Error: $*" >&2
  exit 1
}

# True when running inside WSL (Windows Subsystem for Linux).
is_wsl() {
  [ -n "${WSL_DISTRO_NAME:-}" ] || grep -qi microsoft /proc/version 2>/dev/null
}

# Default output folder: the Windows user folder in WSL, the home folder otherwise.
default_out() {
  if is_wsl; then
    local win
    win="$(cd /mnt/c && cmd.exe /d /c 'echo %USERPROFILE%' 2>/dev/null | tr -d '\r')"
    if [ -z "$win" ] || [ "${win#%}" != "$win" ]; then
      fail "could not find your Windows user folder"
    fi
    echo "$(wslpath -u "$win")/VivaldiExtensions"
  else
    echo "$HOME/VivaldiExtensions"
  fi
}

# Shows a path the way the user will type it into Vivaldi (Windows style in WSL).
show_path() {
  if is_wsl; then wslpath -w "$1"; else echo "$1"; fi
}

[ -f "$SRC/manifest.json" ] || fail "extension folder not found next to this script: $SRC"
command -v python3 >/dev/null || fail "python3 is needed: sudo apt install python3"

OUT="${1:-$(default_out)}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd -P)"
ZIP="$OUT/word-replacer-extension.zip"
TARGET="$OUT/word-replacer"

# Safety: never overlap the source, never delete a folder this script did not create.
SRC_REAL="$(realpath -m "$SRC")"
TARGET_REAL="$(realpath -m "$TARGET")"
case "$TARGET_REAL/" in "$SRC_REAL/"*) fail "the output folder overlaps the source folder $SRC" ;; esac
case "$SRC_REAL/" in "$TARGET_REAL/"*) fail "the output folder overlaps the source folder $SRC" ;; esac
if [ -d "$TARGET" ] && [ -n "$(ls -A "$TARGET")" ] && [ ! -f "$TARGET/$MARKER" ]; then
  fail "$TARGET already exists and was not made by this script. Move it away first."
fi

# Zip (files at the root of the ZIP), then extract into a clean target folder.
python3 - "$SRC" "$ZIP" "$TARGET" <<'PY'
import os, shutil, sys, zipfile

src, zip_path, target = sys.argv[1:4]
tmp = zip_path + ".tmp"
with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
    for root, dirs, files in os.walk(src):
        dirs.sort()
        for name in sorted(files):
            full = os.path.join(root, name)
            z.write(full, os.path.relpath(full, src).replace(os.sep, "/"))
os.replace(tmp, zip_path)
shutil.rmtree(target, ignore_errors=True)
with zipfile.ZipFile(zip_path) as z:
    z.extractall(target)
PY
printf 'Made by make-extension-ubuntu.sh. Running it again replaces this folder.\nEdit the files in the project, not here.\n' >"$TARGET/$MARKER"

FOLDER="$(show_path "$TARGET")"
echo
echo "Done!"
echo "  ZIP file (copy it to another computer): $(show_path "$ZIP")"
echo "  Extension folder (load it in Vivaldi):  $FOLDER"
if is_wsl && [ "${TARGET#/mnt/}" = "$TARGET" ]; then
  echo "  Warning: Vivaldi on Windows cannot load extensions from WSL folders. Use a folder under /mnt/c/."
fi
if is_wsl && [ -z "${WR_NO_CLIPBOARD:-}" ] && command -v clip.exe >/dev/null; then
  printf '%s' "$FOLDER" | clip.exe && echo "  (folder path copied to the clipboard)"
fi
echo
echo "Next: open vivaldi://extensions -> turn on Developer mode -> Load unpacked -> select the extension folder."
echo "Already installed? Click the reload button on Word Replacer instead."
