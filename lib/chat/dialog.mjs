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
//
// A QUESTION is AskUserQuestion: the session asking the User, which reaches the server as a call
// stop like any other. Its dialog is the questions and their options, answered Send or Cancel;
// `questions` carries them as { question, header, multiSelect, options: [{ label, description }] }.
export function dialogOf(request, who) {
  if (request?.kind === "rule") {
    return ruleDialog(request, who);
  }
  return isQuestion(request) ? questionDialog(request, who) : callDialog(request, who);
}

function isQuestion(request) {
  return request?.tool === QUESTION_TOOL && Array.isArray(request.input?.questions) && request.input.questions.length > 0;
}

const QUESTION_TOOL = "AskUserQuestion";

function questionDialog(request, who) {
  return {
    kind: "questions",
    heading: `${who} asks you`,
    lines: [],
    questions: request.input.questions.map((one) => ({
      question: String(one?.question ?? ""),
      header: String(one?.header ?? ""),
      multiSelect: one?.multiSelect === true,
      options: (Array.isArray(one?.options) ? one.options : []).map((option) => ({ label: String(option?.label ?? ""), description: String(option?.description ?? "") })),
    })),
    buttons: [
      { decision: "answer", label: "Send" },
      { decision: "deny", label: "Cancel" },
    ],
  };
}

// What one question reads back as on the card: the labels picked and, while Other is picked, the
// User's own words — words typed there and then left for another option are not the answer. Several
// are joined by ", "; "" while there is nothing.
export function answerOf({ picked, other, own }) {
  const words = other ? own.trim() : "";
  return [...picked, words].filter((said) => said !== "").join(", ");
}

// What an answered question goes back to the run as: its input, with `answers` naming, for every
// question asked, the words the User gave — an option's label, several joined by ", ", or their
// own. Null when the call is not a question or any question is left without an answer, since
// the tool reads a missing answer as the User not answering at all.
export function answeredInput(request, answers) {
  if (!isQuestion(request) || answers === null || typeof answers !== "object") {
    return null;
  }
  const given = {};
  for (const { question } of request.input.questions) {
    const said = answers[question];
    if (typeof said !== "string" || said.trim() === "") {
      return null;
    }
    given[question] = said.trim();
  }
  return { ...request.input, answers: given };
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
  // asked. Always is offered only where the server composed the rules that would let a call like
  // this one through — one, or one per side of a compound command, every one of them on the
  // button, since the press writes them all.
  const buttons = [{ decision: "allow", label: "Allow" }];
  if (Array.isArray(request.shape) && request.shape.length > 0) {
    buttons.push({ decision: "always", label: `Always allow ${request.shape.join(" and ")}` });
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
