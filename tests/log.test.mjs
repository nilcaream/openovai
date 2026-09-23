// tests/log.test.mjs — the server's log: one writer, one row shape.
//
// What is checked here is the row itself — its moment, its four columns, the `-` for what a row
// has not got, and that the three rows of one call carry one name and one id — and that nothing in
// the chat server writes past the writer. What each row says is checked where the thing it says
// happens: the chat, lifecycle and store suites read the rows off the same sink.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";

import { EVENTS, called, ended, failed, fullName, log, moment, returned, row, sink, tool } from "../lib/chat/log.mjs";
import { repo } from "./helpers.mjs";

const MOMENT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/;

// The files whose every line of output is the log: the chat server, and the process that runs it.
// marked.mjs is the vendored markdown library, whose own error path is not the server's.
function serverFiles() {
  const chat = path.join(repo, "lib", "chat");
  return [
    ...fs.readdirSync(chat).filter((name) => name.endsWith(".mjs") && name !== "marked.mjs").map((name) => path.join(chat, name)),
    path.join(repo, "lib", "serve.mjs"),
  ];
}

describe("the log", () => {
  const rows = [];
  sink((one) => rows.push(one));
  after(() => sink(null));

  it("writes nothing through console: every server file says what it says as a row", () => {
    const left = [];
    for (const file of serverFiles()) {
      fs.readFileSync(file, "utf8").split("\n").forEach((line, index) => {
        if (/\bconsole\.(log|error|warn|info|debug)\(/.test(line)) {
          left.push(`${path.relative(repo, file)}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    assert.deepEqual(left, []);
  });

  it("stamps a row with the moment to the millisecond and the zone's offset", () => {
    const at = new Date("2026-09-20T00:15:33.007Z");
    const said = moment(at);
    assert.match(said, MOMENT);
    // The same instant it was given, with the milliseconds inside it.
    assert.equal(new Date(said).getTime(), at.getTime());
    assert.equal(said.slice(19, 23), ".007");
  });

  it("is four columns and the text, single spaces, a dash for a column the row has not got", () => {
    const at = new Date();
    assert.equal(row(at, "queued", "Paul", null, "user #3, 1 waiting"), `${moment(at)} queued Paul - user #3, 1 waiting`);
    assert.equal(row(at, "started", null, null, "serving /srv at http://127.0.0.1:1"), `${moment(at)} started - - serving /srv at http://127.0.0.1:1`);
    assert.equal(row(at, "called", "Paul", "toolu_01X", "Read /srv/a"), `${moment(at)} called Paul toolu_01X Read /srv/a`);
  });

  it("refuses an event outside the set, which is named once", () => {
    assert.ok(EVENTS.has("started") && EVENTS.has("called") && EVENTS.has("tool") && EVENTS.has("failed"));
    assert.throws(() => row(new Date(), "info", null, null, "x"), /not a log event: info/);
    assert.throws(() => log("queued:", "Paul", null, "x"), /not a log event: queued:/);
  });

  it("writes a text of several lines as that many rows, each with the same columns", () => {
    const from = rows.length;
    log("plugins", null, null, "This instance serves a tool of its own: slow\nplugins/broken.mjs is not served: no run");
    const said = rows.slice(from).map((one) => one.slice(one.indexOf(" ") + 1));
    assert.deepEqual(said, ["plugins - - This instance serves a tool of its own: slow", "plugins - - plugins/broken.mjs is not served: no run"]);
    assert.ok(rows.slice(from).every((one) => MOMENT.test(one.split(" ")[0])));
  });

  // The stream names a call and its id when it is made and its id alone when it is back; the
  // MCP request for one of the server's own tools names the bare tool and nothing else. The
  // three rows still read as one call: one full name, one id, in the same columns.
  it("gives the called, tool and failed rows of one call the same full name and the same id", () => {
    const from = rows.length;
    const name = fullName("openovai", "write_desk");
    assert.equal(name, "mcp__openovai__write_desk");
    called("Paul", { id: "toolu_01A", name, what: name });
    tool("Paul", name, 12, null);
    failed("Paul", { id: "toolu_01A", why: "refused: an empty title" });
    const said = rows.slice(from).map((one) => one.split(" ").slice(1));
    assert.deepEqual(said.map((columns) => [columns[0], columns[1], columns[2]]), [
      ["called", "Paul", "toolu_01A"],
      ["tool", "Paul", "toolu_01A"],
      ["failed", "Paul", "toolu_01A"],
    ]);
    assert.deepEqual(said.map((columns) => columns.slice(3).join(" ")), [name, `${name} in 12 ms`, `${name}: refused: an empty title`]);
  });

  it("pairs a tool row with the oldest call of that seat and name not yet served, and with nothing once the call is back or the seat is gone", () => {
    const message = fullName("openovai", "message");
    const desk = fullName("openovai", "write_desk");
    called("Paul", { id: "toolu_01B", name: message, what: message });
    called("Paul", { id: "toolu_01E", name: desk, what: desk });
    called("Jane", { id: "toolu_01F", name: message, what: message });
    called("Paul", { id: "toolu_01C", name: message, what: message });
    called("Jane", { id: "toolu_01D", name: message, what: message });
    // Back before any tool row: not the server's tool after all, and forgotten.
    called("Paul", { id: "toolu_01H", name: message, what: message });
    returned("toolu_01H");
    const from = rows.length;
    tool("Paul", message, 1, null);
    tool("Paul", message, 2, null);
    tool("Jane", message, 3, new Error("the wire broke"));
    tool("Paul", message, 4, null);
    ended("Jane", "stop");
    tool("Jane", message, 5, null);
    tool("Paul", desk, 6, null);
    const said = rows.slice(from).map((one) => one.split(" ").slice(1).join(" "));
    assert.deepEqual(said, [
      `tool Paul toolu_01B ${message} in 1 ms`,
      `tool Paul toolu_01C ${message} in 2 ms`,
      `tool Jane toolu_01F ${message} failed in 3 ms: the wire broke`,
      `tool Paul - ${message} in 4 ms`,
      "stopped Jane - stop",
      `tool Jane - ${message} in 5 ms`,
      `tool Paul toolu_01E ${desk} in 6 ms`,
    ]);
  });

  // A process gone is one row, `stopped`, with what it ended as — the record's own word, or the
  // exit of one that ended on its own — no id, and after the seat's last call rows: the calls it
  // took out with it were already written, the row is what closes them.
  it("writes one stopped row for a seat gone, with why in the text and no id, after its calls are dropped", () => {
    const name = fullName("openovai", "stop_session");
    called("Paul", { id: "toolu_01S", name, what: name });
    tool("Paul", name, 2, null);
    const from = rows.length;
    ended("Paul", "idle-forced");
    ended("Jane", "exit 1");
    tool("Paul", name, 3, null);
    const said = rows.slice(from).map((one) => one.split(" ").slice(1).join(" "));
    assert.deepEqual(said, ["stopped Paul - idle-forced", "stopped Jane - exit 1", `tool Paul - ${name} in 3 ms`]);
    assert.ok(EVENTS.has("stopped"));
  });
});
