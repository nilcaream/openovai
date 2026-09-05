// {{NAME}} — a tool this workspace serves itself.
//
// The file is the tool. Its name is this tool's name, so this one is called {{NAME}} because the
// file is called {{NAME}}.mjs, and renaming the tool is renaming the file. Nothing registers it
// and there is no list to keep in step: the directory is the list.
//
// It is read when the chat starts, so start the chat again after changing anything in here.

// What a session reads before it decides whether to call this at all. Say what it does AND what it
// refuses, in the second person: a session that cannot tell will either not call it or call it
// wrongly, and one that has been told why it would be refused does not call it at all.
export const description = "Say what {{NAME}} does, and what it will not do.";

// What the call may carry. Every property wants a description of its own — it is the only place a
// session is told what to put there — and `required` says which of them it cannot leave out.
export const inputSchema = {
  type: "object",
  properties: {
    message: { type: "string", description: "What to do with. Replace this with what {{NAME}} actually takes." },
  },
  required: ["message"],
  additionalProperties: false,
};

// The work. It is handed what the call carried and what this workspace knows about the caller:
//
//   caller  the name of the session calling, taken from the workspace and never from anything the
//           session says, so it cannot be signed as somebody else
//   leads   whether that session is the one leading here
//   root    where this instance is, as an absolute path — the one thing this file cannot work out
//           for itself, since an instance records no path anywhere
//   config  what the instance says about itself, including the names of the person it works for
//           and of whoever leads
//
// Answer { text } with what to tell the caller, or { refused } with why not. A refusal is an
// answer: it arrives as words the calling session reads and can act on, rather than as a call that
// failed. Answering with neither is the one thing to avoid, and it is what forgetting to return
// does — the chat turns that into a refusal naming this file, but the sentence is nobody's.
//
// It may be async. Whatever it throws is caught and reaches the caller as words naming this file,
// so the chat and everybody working in it survive a bad afternoon in here.
export function run({ message }, { caller, leads, root, config }) {
  if (!leads) {
    return { refused: `{{NAME}} is the lead's, so ask ${config.leader}` };
  }

  return { text: `${caller} said ${message}, and ${root} is where this workspace lives` };
}
