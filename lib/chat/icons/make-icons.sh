#!/bin/bash
# make-icons.sh — rasterise the SVG sources in this directory to the PNGs the manifest and the
# page list. A one-off build step, run again only when a source changes; the PNGs are committed.
# Headless Chrome does the rendering, one short-lived process per icon that exits by itself, on a
# throwaway profile that is removed when the script ends.
#
# icon.svg -> 192.png, 512.png: the mark on a rounded square, the corners left clear — the tab's
# icon and the installed app's icon on a platform that shows icons as they are (purpose "any").
# icon-asking.svg -> 192-asking.png: the same mark with the ring in the page's warn colour, the
# tab's icon while a panel asks.
# maskable.svg -> 512-maskable.png: the icon an installed app shows on a platform that cuts icons
# to its own shape (a circle, a squircle, a rounded square). The ground fills the whole square
# and the mark sits inside the central 80% — the part every shape keeps — so nothing is cut and
# nothing is letterboxed.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
readonly CHROME="${CHROME:-google-chrome}"
PROFILE="$(mktemp -d ./.chrome-profile.XXXX.tmp)"
readonly PROFILE
cleanup() { rm -rf "${PROFILE}"; }
trap cleanup EXIT

render() { # <source.svg> <size> <out.png> — Chrome draws the SVG document at the window size,
    # on a clear ground, so what the source leaves unpainted comes out transparent. A source
    # drawn at more than one size carries a viewBox and no width or height, so it fills the window.
    local -r source="${1}" size="${2}" out="${3}"
    "${CHROME}" --headless=new --no-sandbox --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
        --default-background-color=00000000 \
        --user-data-dir="${PROFILE}" --window-size="${size},${size}" --screenshot="${out}" \
        "file://${PWD}/${source}" >/dev/null 2>&1
    echo "wrote ${out}"
}

render icon.svg 192 192.png
render icon.svg 512 512.png
render icon-asking.svg 192 192-asking.png
render maskable.svg 512 512-maskable.png
