// What a dialog on a panel shows: decided here, drawn by the page.
//
// Two kinds of question reach a panel. A CALL STOP is a session stopped on a tool the instance has
// not settled: the request as the session made it, parked by permissions.mjs, and answered Allow,
// Always or Deny. A RULE REQUEST is the Leader asking the User to settle one rule for the whole
// instance, raised by the `permission` tool, and answered Allow, Deny or Ask. Both are rendered
// from the words the session wrote and nothing else: the tool, the command or the path, the reason
// the session gave beside the call — or the rule and why it was asked. Nothing is paraphrased and
// no line is shown for a field the request did not carry, because the person pressing the button
// is deciding on what was asked, and a word the server added is a word nobody asked for.
//
// A pure module with its own suite, so that what a dialog shows is a thing a test can assert on
// rather than markup nothing here can run.

// The Bash tool's own field for what a command is for. `Write` and `Edit` carry no such field:
// their dialog is the tool and the path.
const REASON_FIELD = "description";

// `dialogOf(request, who)` -> { kind, heading, lines, buttons }.
//
// `lines` is a list of { kind, text } in the order they are shown, `kind` one of `command`,
// `path`, `reason`, `input`, `rule`, `why`; `buttons` a list of { decision, label } in the order
// they are offered. The page sets every `text` with textContent.
export function dialogOf(request, who) {
  return request?.kind === "rule" ? ruleDialog(request, who) : callDialog(request, who);
}

function callDialog(request, who) {
  const input = request.input ?? {};
  const lines = [];
  if (typeof input.command === "string") {
    lines.push({ kind: "command", text: input.command });
  }
  if (typeof input.file_path === "string") {
    lines.push({ kind: "path", text: input.file_path });
  }
  const reason = input[REASON_FIELD];
  if (typeof reason === "string" && reason.trim() !== "") {
    lines.push({ kind: "reason", text: reason });
  }
  // Any other tool: the input whole, as the request made it. A dialog that showed a paraphrase
  // of an input nobody here has read would be a press into the dark.
  if (lines.length === 0) {
    lines.push({ kind: "input", text: JSON.stringify(input) });
  }

  // No Ask on a call stop: "ask" is a rule decision, and a call that stopped is already being
  // asked. Always is offered only where the server composed a rule that would let a call like this
  // one through.
  const buttons = [{ decision: "allow", label: "Allow" }];
  if (typeof request.shape === "string") {
    buttons.push({ decision: "always", label: `Always allow ${request.shape}` });
  }
  buttons.push({ decision: "deny", label: "Deny" });

  return { kind: "call", heading: `${who} wants to use ${request.tool}`, lines, buttons };
}

function ruleDialog(request, who) {
  return {
    kind: "rule",
    heading: `${who} asks you to settle a rule`,
    lines: [
      { kind: "rule", text: request.rule },
      { kind: "why", text: request.why },
    ],
    // Three, always: the rule and the why are the session's words, and the User's press is the
    // last word on that rule. No Always — a rule request IS the instance-wide question — and no
    // reason input: the reason is the Leader's why, already there.
    buttons: [
      { decision: "allow", label: "Allow" },
      { decision: "deny", label: "Deny" },
      { decision: "ask", label: "Ask every time" },
    ],
  };
}
