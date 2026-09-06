// The instance's own commands, offered to its sessions as tools rather than as shell lines.
//
// A persona used to tell a session to run `ovai say <name> <message>`, and a session runs that by
// composing a shell line. The message is free text, so an apostrophe ends the quoting and a
// backtick is executed and its output sent instead of what was written — and several further
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

    // Whatever the tool has to say about what it was handed, it says itself: it knows what its
    // arguments mean and this does not. A throw is different — that is us being broken, and it
    // reaches the model as the words of the failure rather than as a dead call.
    let answered;
    try {
      answered = await wanted.run(asked.params?.arguments ?? {});
    } catch (error) {
      return result(id, said(`${wanted.name} could not be done: ${error.message}`, true));
    }

    return result(id, answered.refused === undefined ? said(answered.text) : said(answered.refused, true));
  }

  return failed(id, -32601, `there is no ${asked.method} here`);
}
