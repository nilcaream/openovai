#!/bin/sh
#
# run.sh NAME — run the hook lib/hooks/NAME.mjs on the toolkit's own node.
#
# The harness runs a hook's command in a shell of the session, with whatever PATH that session has,
# so a command that says `node` runs the machine's node, or none at all. This is what the settings
# name instead: it asks lib/runtime.sh where the node this version pins is, the same answer bin/ovai
# gets, and hands the hook to it with the harness's input and output untouched. Found from where it
# sits, so the settings name it by the harness's own name for the root and keep no absolute path.

set -eu

here="$(cd -- "$(dirname -- "$0")" && pwd -P)"
node="$(sh "${here}/../runtime.sh" node-path)"
exec "${node}" "${here}/$1.mjs"
