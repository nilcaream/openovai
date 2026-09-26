// What the person set for every session here, handed to the subagents those sessions start too.
//
// A seat starts a subagent with the Agent tool, and the subagent is given the prompt its parent
// wrote and nothing else: not the persona, not the person's files. So a line in
// `customization/common.md` holds for a seat and is unknown to everything the seat hands work to,
// unless the seat remembers to copy it, every time. Wired as a SubagentStart hook (lib/seed.mjs),
// this answers with that file as context the harness adds to every subagent at its start
// (measured on 2.1.280: the subagent reads it; knowledge/subagent-preamble-depends-on-the-type.md).
//
// `common.md` alone, because it is the file for every session here; a subagent is neither the
// Leader nor a Worker, and the hook is not told whose it is. Framed the way the persona frames it
// (lib/desks.mjs `customization`): the content byte for byte, so the person's words reach the
// subagent as they wrote them. No file, no answer — an absence is the person's answer.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CUSTOMIZATION } from "../desks.mjs";

// The instance this file is installed in, from where it sits (lib/hooks/ under the root).
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const SUBAGENT_HOOK_COMMAND = 'node "${CLAUDE_PROJECT_DIR}/lib/hooks/subagent.mjs"';

// No matcher: a SubagentStart matcher picks subagents by type, and this is for every type.
export const SUBAGENT_HOOK_ENTRY = { hooks: [{ type: "command", command: SUBAGENT_HOOK_COMMAND }] };
export function subagentHookWired(settings) {
  const entries = settings?.hooks?.SubagentStart;
  return Array.isArray(entries) && entries.some((entry) => Array.isArray(entry?.hooks) && entry.hooks.some((hook) => hook?.command === SUBAGENT_HOOK_COMMAND));
}

const SOURCE = path.posix.join(CUSTOMIZATION, "common.md");

// What the harness reads back: the file in its frame as SubagentStart context, or nothing.
export function answerFor(root) {
  let content = null;
  try {
    content = fs.readFileSync(path.join(root, SOURCE), "utf8");
  } catch {
    return "";
  }
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SubagentStart",
      additionalContext: `What the person at this instance set for every session here, you included:\n<customization source="${SOURCE}">\n${content}</customization>`,
    },
  });
}

// Run as the hook: the input read to its end and not needed, the answer on stdout, exit 0 either way.
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    fs.readFileSync(0);
  } catch {
    // No input is no reason not to answer.
  }
  process.stdout.write(answerFor(ROOT));
}
