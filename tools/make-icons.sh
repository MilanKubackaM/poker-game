#!/usr/bin/env bash
# Rasterizes the PWA icons in client/public/icons from the SVG sources in tools/icons.
# Needs a Chromium-based browser: CHROME=/path/to/chrome tools/make-icons.sh (defaults to the Playwright headless shell).
set -euo pipefail
cd "$(dirname "$0")/.."
CHROME="${CHROME:-$(ls -d "$HOME"/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell 2>/dev/null | tail -1)}"
[ -x "$CHROME" ] || { echo "Chromium not found, set CHROME=" >&2; exit 2; }
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

render() { # <source svg> <size> <output png>
  local page="$work/page.html"
  printf '<html><body style="margin:0;background:transparent"><img src="file://%s" width="%s" height="%s" style="display:block"></body></html>' \
    "$PWD/tools/icons/$1" "$2" "$2" > "$page"
  "$CHROME" --headless --disable-gpu --hide-scrollbars --default-background-color=00000000 \
    --allow-file-access-from-files --window-size="$2,$2" --screenshot="$PWD/client/public/icons/$3" "file://$page" >/dev/null 2>&1
  echo "client/public/icons/$3"
}

render chip.svg 192 icon-192.png
render chip.svg 512 icon-512.png
render chip-on-felt.svg 512 icon-maskable-512.png
render chip-on-felt.svg 180 apple-touch-icon.png
