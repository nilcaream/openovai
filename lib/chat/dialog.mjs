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
// A DEFAULT is the one exception, because no session asked it: ovai's own card for a rule a fresh
// instance is born with that the settings hold nowhere, raised by the server at its start. Its words
// are ovai's, fixed beside the rule (lib/desks.mjs, `DEFAULT_RULES`), answered by the recommended
// list or Ignore.
//
// A pure module with its own suite, so that what a dialog shows is a thing a test can assert on
// rather than markup nothing here can run.

// The Bash tool's own field for what a command is for. `Write` and `Edit` carry no such field:
// their dialog is the tool and the path.
const REASON_FIELD = "description";

// `dialogOf(request, who)` -> { kind, heading, lines, buttons }.
//
// `lines` is a list of { kind, text } in the order they are shown, `kind` one of `command`,
// `agent`, `path`, `reason`, `input`, `saves`, `rules`, `rule`, `why`; `buttons` a list of { decision, label } in the order
// they are offered. The page sets every `text` with textContent.
//
// A QUESTION is AskUserQuestion: the session asking the User, which reaches the server as a call
// stop like any other. Its dialog is the questions and their options, answered Send or Cancel;
// `questions` carries them as { question, header, multiSelect, options: [{ label, description }] }.
export function dialogOf(request, who) {
  if (request?.kind === "rule") {
    return ruleDialog(request, who);
  }
  if (request?.kind === "default") {
    return defaultDialog(request);
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
  // A call one of the session's subagents made: said first, in the words the session started it
  // with — its type and its description — and, where its start was not seen, that it was one.
  const agent = request.agent;
  if (agent !== null && typeof agent === "object") {
    const type = typeof agent.type === "string" && agent.type !== "" ? agent.type : null;
    const description = typeof agent.description === "string" && agent.description !== "" ? agent.description : null;
    const whose = type === null ? "from a subagent" : `from its subagent ${type}`;
    lines.push({ kind: "agent", text: description === null ? whose : `${whose} — “${description}”` });
  }
  const said = lines.length;
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
  if (lines.length === said) {
    lines.push({ kind: "input", text: JSON.stringify(input) });
  }

  // No Ask on a call stop: "ask" is a rule decision, and a call that stopped is already being
  // asked. Always is offered only where the server composed the rules that would let a call like
  // this one through — one, or one per side of a compound command, every one of them on the
  // card, one to a line right above the buttons, since the press writes them all. They are a
  // line and not the button's label: a rule is as long as the path in it, and a button that long
  // runs out of a narrow panel.
  const buttons = [{ decision: "allow", label: "Allow" }];
  if (Array.isArray(request.shape) && request.shape.length > 0) {
    lines.push({ kind: "saves", text: "Always allow saves:" }, { kind: "rules", text: request.shape.join("\n") });
    buttons.push({ decision: "always", label: "Always allow" });
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

// What the recommended button on a default's card says: what the press does, in the words of the
// rule dialog's own buttons.
const RECOMMENDED = { allow: "Allow", deny: "Deny", ask: "Ask every time" };

// ovai's own card for a rule a fresh instance is born with and these settings hold nowhere. It
// explains itself, since nobody else on the panel will: where the rule came from, what it does and
// why. Two buttons: the list ovai recommends, labelled as what it does, and Ignore, which is
// remembered and never asked again.
function defaultDialog(request) {
  return {
    kind: "default",
    heading: "A new ovai default rule came with the update",
    lines: [
      { kind: "rule", text: request.rule },
      { kind: "why", text: request.why },
      { kind: "why", text: "Ignore, and ovai never asks about this rule again." },
    ],
    buttons: [
      { decision: request.list, label: RECOMMENDED[request.list] },
      { decision: "ignore", label: "Ignore" },
    ],
  };
}
