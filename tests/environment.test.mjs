// What a process started here carries of the one that started it. A server typed in a session's
// shell, and every session that server starts, get this instance's Claude Code home and nothing of
// the session or the seat they were started from; the machine's sign-in stays when the instance
// inherits it.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { environment, home, serverEnvironment } from "../lib/claude.mjs";

// What Claude Code and a seat put on a session, as read off a server started from a seat's shell.
const STARTERS = {
  CLAUDECODE: "1",
  CLAUDE_CODE_ENTRYPOINT: "sdk-cli",
  CLAUDE_CODE_SESSION_ID: "00000000-0000-0000-0000-000000000000",
  CLAUDE_CODE_SESSION_ATTENDED: "0",
  CLAUDE_CODE_CHILD_SESSION: "1",
  CLAUDE_CODE_MESSAGING_SOCKET: "/run/user/1000/cc-socks/1.sock",
  CLAUDE_CODE_MESSAGING_TOKEN: "token",
  CLAUDE_CODE_EXECPATH: "/somewhere/claude.exe",
  CLAUDE_CODE_PROJECT_DIR_NAME: "somebody-else",
  CLAUDE_PID: "1",
  CLAUDE_EFFORT: "medium",
  PWD: "/somewhere/else",
  OLDPWD: "/somewhere",
  OPENOVAI_SEAT: "Starter",
  OPENOVAI_SESSION_SECRET: "secret",
  ENABLE_CLAUDEAI_MCP_SERVERS: "false",
  CLAUDE_CONFIG_DIR: "/somewhere/else/.local",
};
const SIGN_IN = { CLAUDE_CODE_OAUTH_TOKEN: "machine-sign-in" };

describe("what a process started here carries of its starter", () => {
  let root;
  const saved = {};
  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "openovai-environment-"));
    for (const [name, value] of Object.entries({ ...STARTERS, ...SIGN_IN })) {
      saved[name] = process.env[name];
      process.env[name] = value;
    }
  });
  after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("starts the server with this instance's home and nothing of the session or seat it was typed in", () => {
    const env = serverEnvironment(root);
    for (const name of Object.keys(STARTERS)) {
      if (name === "CLAUDE_CONFIG_DIR") continue;
      assert.equal(env[name], undefined, `${name} is the starter's, not the server's`);
    }
    assert.equal(env.CLAUDE_CONFIG_DIR, home(root));
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, SIGN_IN.CLAUDE_CODE_OAUTH_TOKEN, "the machine's sign-in is not the starter's to take away");
  });

  it("starts a seat with nothing of the session the server was typed in, and its own seat and home", () => {
    const env = environment(root, "inherit", "Paul");
    for (const name of Object.keys(STARTERS)) {
      if (["CLAUDE_CONFIG_DIR", "OPENOVAI_SEAT", "ENABLE_CLAUDEAI_MCP_SERVERS", "CLAUDE_CODE_PROJECT_DIR_NAME"].includes(name)) continue;
      assert.equal(env[name], undefined, `${name} is the starter's, not the seat's`);
    }
    assert.equal(env.OPENOVAI_SEAT, "Paul");
    assert.equal(env.CLAUDE_CONFIG_DIR, home(root));
    assert.equal(env.CLAUDE_CODE_PROJECT_DIR_NAME, "workspace");
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, SIGN_IN.CLAUDE_CODE_OAUTH_TOKEN, "inherit keeps the machine's sign-in");
  });

  it("is what `ovai start` spawns the server with", () => {
    const source = fs.readFileSync(new URL("../lib/ovai.mjs", import.meta.url), "utf8");
    assert.match(source, /spawn\(nodeCommand\(root\), \[SERVER, "--root", root\], \{\s*cwd: root,\s*env: serverEnvironment\(root\),/);
  });
});
