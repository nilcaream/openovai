// What `ovai start` and `ovai configuration` say about Claude Code variables: one line per
// variable, sorted by name, with what a session gets of it, masked before it is written down.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { home } from "../lib/claude.mjs";
import { VARIABLES_FILE, gathered, record } from "../lib/variables.mjs";

// A mode these checks read is the one the code gave, not the one the shell's umask happens to leave:
// under 077 a file made with no mode at all is 0600 anyway, and no check could tell.
process.umask(0o022);

// The shell of the User's mockup, 2026-09-29 19:33.
const MOCKUP_SHELL = {
  ANTHROPIC_API_KEY: "plainvalue123",
  ANTHROPIC_BASE_URL: "https://proxy.example/v1?token=abc123",
  ANTHROPIC_CUSTOM_HEADERS: "X-Proxy-Auth: hunter2hunter2",
  ANTHROPIC_MODEL: "claude-opus-5-5",
  CLAUDE_CODE_OAUTH_TOKEN: "plainvalue123",
  DISABLE_AUTOUPDATER: "0",
  PATH: "/usr/bin",
};

describe("the Claude Code variables a start writes down", () => {
  let root;
  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "openovai-variables-"));
  });
  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("is the User's mockup, line for line", () => {
    assert.deepEqual(gathered("/home/user/openovai", "inherit", MOCKUP_SHELL), [
      "  ANTHROPIC_API_KEY = *** (removed)",
      "  ANTHROPIC_BASE_URL = https://proxy.example/v1?token=*** (passed on)",
      "  ANTHROPIC_CUSTOM_HEADERS = *** (passed on)",
      "  ANTHROPIC_MODEL = claude-opus-5-5 (overridden)",
      "  CLAUDE_CODE_ARTIFACT = 1",
      "  CLAUDE_CODE_OAUTH_TOKEN = *** (passed on)",
      "  CLAUDE_CODE_PROJECT_DIR_NAME = workspace",
      "  CLAUDE_CONFIG_DIR = /home/user/openovai/.local",
      "  DISABLE_AUTOUPDATER = 0 (overridden: 1)",
    ]);
  });

  it("says the machine's sign-in is removed when the instance signs in on its own", () => {
    assert.ok(gathered(root, "login", MOCKUP_SHELL).includes("  CLAUDE_CODE_OAUTH_TOKEN = *** (removed)"));
  });

  it("masks every query value of a URL, a passphrase and a header whatever its name", () => {
    const said = gathered(root, "login", {
      ANTHROPIC_BASE_URL: "https://proxy.example/v1?auth=abc123&region=eu",
      ANTHROPIC_CUSTOM_HEADERS: "X-Proxy-Auth: hunter2hunter2",
      CLAUDE_CODE_CLIENT_KEY_PASSPHRASE: "hunter2",
    }).join("\n");
    assert.match(said, /^ {2}ANTHROPIC_BASE_URL = https:\/\/proxy\.example\/v1\?auth=\*\*\*&region=\*\*\* \(passed on\)$/m);
    assert.match(said, /^ {2}CLAUDE_CODE_CLIENT_KEY_PASSPHRASE = \*\*\* \(passed on\)$/m);
    assert.doesNotMatch(said, /hunter2|abc123|=eu/);
  });

  it("keeps a number whose name only counts tokens", () => {
    assert.ok(gathered(root, "login", { MAX_THINKING_TOKENS: "32000" }).includes("  MAX_THINKING_TOKENS = 32000 (passed on)"));
  });

  it("says what a seat gets over the shell's home, effort and Artifact switch, and lists nothing that is not Claude Code's", () => {
    const said = gathered(root, "login", {
      CLAUDE_CONFIG_DIR: "/somewhere/else/.local",
      CLAUDE_CODE_EFFORT_LEVEL: "max",
      CLAUDE_CODE_ARTIFACT: "0",
      CLAUDE_CODE_SESSION_ID: "00000000-0000-0000-0000-000000000000",
      HTTPS_PROXY: "http://proxy.example",
    });
    assert.deepEqual(said, [
      "  CLAUDE_CODE_ARTIFACT = 0 (passed on)",
      "  CLAUDE_CODE_EFFORT_LEVEL = max (removed)",
      "  CLAUDE_CODE_PROJECT_DIR_NAME = workspace",
      `  CLAUDE_CONFIG_DIR = /somewhere/else/.local (overridden: ${home(root)})`,
      "  DISABLE_AUTOUPDATER = 1",
    ]);
  });

  it("writes them for their owner alone, with no value unmasked", () => {
    record(root, "inherit", MOCKUP_SHELL);
    const written = path.join(root, VARIABLES_FILE);
    assert.equal(fs.statSync(written).mode & 0o777, 0o600);
    assert.doesNotMatch(fs.readFileSync(written, "utf8"), /plainvalue123|abc123|hunter2/);
  });
});
