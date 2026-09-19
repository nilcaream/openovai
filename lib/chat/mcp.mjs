// The instance's own commands, offered to its sessions as tools rather than as shell lines.
//
// A shell line is a poor place to put a sentence somebody wrote: an apostrophe ends the quoting,
// a backtick is executed and its output sent instead of what was written — and several further
// shapes stop the session to be approved, on a panel nobody may be looking at. The same text as a
// tool argument is JSON: it arrives byte for byte, and nothing about it can end a quote.
//
// This file is the protocol and nothing else. It knows how a tool call arrives and how an answer
// is shaped, and knows nothing about the instance — what the tools ARE is the chat's to say, and
// is passed in. So the two questions ("is this a well-formed call" and "what may this session do")
// are answered in different places and neither can quietly become the other.

// What we speak. A client that asks for a version says so, and is answered with what it asked
// for: the shapes below have not changed across the versions in the field, and answering with our
// own would have a client that asked for an older one decide we cannot serve it.
const PROTOCOL = "2025-06-18";

// A JSON-RPC reply, and the two ways it can go. `id` is echoed because that is what pairs an
// answer with its question; a request that arrived without one is a notification and gets no
// answer at all.
function result(id, value) {
  return { status: 200, body: { jsonrpc: "2.0", id, result: value } };
}

function failed(id, code, message) {
  return { status: 200, body: { jsonrpc: "2.0", id, error: { code, message } } };
}

// A tool that refused is NOT a protocol error. The call arrived, was understood and was answered
// — with a no, in words the model reads and can act on. A JSON-RPC error at this level says the
// call itself was malformed, which is a different thing and reaches the model as a failure it
// cannot do anything about.
function said(text, refused = false) {
  return { content: [{ type: "text", text }], ...(refused ? { isError: true } : {}) };
}

// One request, answered.
//
// `server` is { name, version, tools }, where each tool is { name, description, inputSchema, run }
// and `run` answers { text } or { refused }. A tool may also say `offered: false`, which keeps it
// out of the list without taking it away: which sessions may do what is the chat's to decide, and
// all this knows is that somebody reaching for an unadvertised tool should hear that tool's own
// reason rather than that there is no such thing here.
//
// A call is answered whether or not anything was initialised first, and that is deliberate rather
// than lax. The chat can be stopped and started again in the middle of a session's turn — it is
// how the toolkit is updated — and a server that remembered a handshake would meet that turn's
// next call as a stranger. Holding nothing between requests is what makes a restart invisible.
export async function respond(asked, server) {
  if (asked === null || typeof asked !== "object" || typeof asked.method !== "string") {
    return failed(null, -32600, "that is not a request");
  }

  const id = asked.id ?? null;

  // Notifications carry no id and expect no answer. `notifications/initialized` is the one a
  // client sends after it has been told what we are.
  if (asked.method.startsWith("notifications/")) {
    return { status: 202, body: null };
  }

  if (asked.method === "initialize") {
    return result(id, {
      protocolVersion: typeof asked.params?.protocolVersion === "string" ? asked.params.protocolVersion : PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: { name: server.name, version: server.version },
    });
  }

  if (asked.method === "tools/list") {
    return result(id, {
      tools: server.tools
        .filter((tool) => tool.offered !== false)
        .map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    });
  }

  if (asked.method === "tools/call") {
    const wanted = server.tools.find((tool) => tool.name === asked.params?.name);
    if (wanted === undefined) {
      return result(id, said(`there is no ${asked.params?.name} tool here`, true));
    }

    // Whether the call is well formed is answered here, against what the tool declared, and
    // before the tool sees it. What the arguments MEAN — a name nobody has, a status too long, a
    // moment that cannot be placed — is the tool's to say, after this. A throw is different —
    // that is us being broken, and it reaches the model as the words of the failure rather than
    // as a dead call.
    const args = asked.params?.arguments ?? {};
    const unfit = misfit(wanted.inputSchema, args);
    if (unfit !== null) {
      return result(id, said(`${wanted.name}: ${unfit}`, true));
    }
    let answered;
    try {
      answered = await wanted.run(args);
    } catch (error) {
      return result(id, said(`${wanted.name} could not be done: ${error.message}`, true));
    }

    return result(id, answered.refused === undefined ? said(answered.text) : said(answered.refused, true));
  }

  return failed(id, -32601, `there is no ${asked.method} here`);
}

// The one way a call can be malformed and still name a tool: its arguments do not fit what that
// tool declared. Every argument the schema requires is there; each one given is of the type
// declared, is one of the values listed when values are listed, and is one the tool declared at
// all when the schema says there are no others. One level and no deeper, which is as far as any
// tool served here declares — and as far as the word "shape" goes. Answered in one line naming
// the argument, as a refusal rather than a protocol error, because a line the model can act on is
// the point: a call the tool never saw should read as one the model can make again, right.
//
// What a tool declares is trusted as declared. A type this does not know is not checked, so a
// tool that reaches for one gets what it always got; nothing here can refuse a call a tool would
// have taken.
const FITS = {
  string: (value) => typeof value === "string",
  number: (value) => typeof value === "number",
  integer: (value) => Number.isInteger(value),
  boolean: (value) => typeof value === "boolean",
  object: (value) => value !== null && typeof value === "object" && !Array.isArray(value),
  array: (value) => Array.isArray(value),
};

const CALLED = {
  string: "a string",
  number: "a number",
  integer: "a whole number",
  boolean: "true or false",
  object: "an object",
  array: "a list",
};

export function misfit(schema, args) {
  if (!FITS.object(args)) {
    return "the arguments are not an object";
  }
  const properties = schema?.properties ?? {};
  for (const name of schema?.required ?? []) {
    if (args[name] === undefined) {
      return `${name} is required`;
    }
  }
  for (const [name, value] of Object.entries(args)) {
    const declared = properties[name];
    if (declared === undefined) {
      if (schema?.additionalProperties === false) {
        return `${name} is not an argument it takes`;
      }
      continue;
    }
    if (FITS[declared.type] !== undefined && !FITS[declared.type](value)) {
      return `${name} is not ${CALLED[declared.type]}`;
    }
    if (Array.isArray(declared.enum) && !declared.enum.includes(value)) {
      return `${name} is not one of ${declared.enum.join(", ")}`;
    }
  }
  return null;
}
