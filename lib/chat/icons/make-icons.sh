#!/bin/bash
# make-icons.sh — rasterise the SVG sources in this directory to the PNGs the manifest lists.
# A one-off build step, run again only when a source changes; the PNGs are committed. Headless
# Chrome does the rendering, one short-lived process per icon that exits by itself, on a throwaway
# profile that is removed when the script ends.
#
# maskable.svg -> 512-maskable.png: the icon an installed app shows on a platform that cuts icons
# to its own shape (a circle, a squircle, a rounded square). The ground fills the whole square
# and the mark sits inside the central 80% — the part every shape keeps — so nothing is cut and
# nothing is letterboxed. 192.png and 512.png (purpose "any") have no source here and are kept
# as committed.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
readonly CHROME="${CHROME:-google-chrome}"
PROFILE="$(mktemp -d ./.chrome-profile.XXXX.tmp)"
readonly PROFILE
cleanup() { rm -rf "${PROFILE}"; }
trap cleanup EXIT

render() { # <source.svg> <size> <out.png> — Chrome draws the SVG document at the window size
    local -r source="${1}" size="${2}" out="${3}"
    "${CHROME}" --headless=new --no-sandbox --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
        --user-data-dir="${PROFILE}" --window-size="${size},${size}" --screenshot="${out}" \
        "file://${PWD}/${source}" >/dev/null 2>&1
    echo "wrote ${out}"
}

render maskable.svg 512 512-maskable.png
