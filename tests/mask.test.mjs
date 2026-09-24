import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { snapshot } from "../lib/admin.mjs";
import { called, sink } from "../lib/chat/log.mjs";
import { mask } from "../lib/mask.mjs";

// Every token here is put together at run time, so no line of this file has a token's shape and
// the pre-push scan reads none.
const fill = (n, c = "q") => c.repeat(n);

// Each pattern, with the commands it is there for, and what they read masked.
const MASKED = {
  "an Anthropic or OpenAI key": [[`curl -d x ${"sk-" + "ant-" + fill(24)}`, "curl -d x ***"]],
  "a GitHub token": [[`echo ${"ghp" + "_" + fill(36)} | gh auth login --with-token`, "echo *** | gh auth login --with-token"]],
  "a GitLab token": [[`export GL=${"glpat" + "-" + fill(20)}`, "export GL=***"]],
  "a Slack token": [[`SLACK=${"xoxb" + "-" + fill(24)} node bot.mjs`, "SLACK=*** node bot.mjs"]],
  "an AWS access key": [[`aws configure set aws_access_key_id ${"AK" + "IA" + fill(16, "Q")}`, "aws configure set aws_access_key_id ***"]],
  "a Google API key": [[`curl "https://maps.example.com/v1?k=${"AI" + "za" + fill(35)}"`, `curl "https://maps.example.com/v1?k=***"`]],
  "an npm token": [[`NPM=${"npm" + "_" + fill(36)} npm publish`, "NPM=*** npm publish"]],
  "a JWT": [[`curl -b s=${"ey" + "J" + fill(10)}.${"ey" + "J" + fill(10)}.${fill(10)} https://a.example.com`, "curl -b s=*** https://a.example.com"]],
  "an Authorization header": [[`curl -H "Authorization: Basic ${fill(12)}" https://api.example.com`, `curl -H "Authorization: Basic ***" https://api.example.com`]],
  "a Bearer value": [[`http a.example.com "X-Auth: Bearer ${fill(20)}"`, `http a.example.com "X-Auth: Bearer ***"`]],
  "a URL password": [[`git clone https://deploy:${fill(12)}@git.example.com/r.git`, "git clone https://deploy:***@git.example.com/r.git"]],
  "a URL token user": [[`git clone https://${fill(40)}@git.example.com/o/r.git`, "git clone https://***@git.example.com/o/r.git"]],
  "a secret assignment": [
    [`PGPASSWORD=${fill(10)} psql -h db`, "PGPASSWORD=*** psql -h db"],
    [`curl "https://a.example.com/?api_key=${fill(10)}&q=1"`, `curl "https://a.example.com/?api_key=***&q=1"`],
    [`echo '{"token": "${fill(10)}"}'`, `echo '{"token": "***"}'`],
  ],
  "a secret flag": [[`mytool --password ${fill(10)} --verbose`, "mytool --password *** --verbose"]],
};

// What must come out byte for byte: ordinary commands, rules, and the server's own rows, several
// with a secret-sounding word in them.
const ORDINARY = [
  "git log --format=%H",
  "git status --porcelain",
  'node --test --test-name-pattern="masks a JWT" tests/mask.test.mjs',
  "ssh git@github.com",
  "git clone https://github.com/o/r.git",
  "grep -rn token lib/",
  'grep -rn "password" docs/',
  "npm run build -- --key-file=./k.pem",
  "ssh-keygen -t ed25519 -C deploy",
  "awk -F: '{print $1}' /etc/passwd",
  'curl -H "Accept: application/json" https://api.example.com',
  "Bash(npm:*)",
  "Read(./secrets:*)",
  "Read(./.env)",
  "successor started, 4000 tokens of context",
  "serving /srv/room at http://127.0.0.1:4000 pid 12 host h user u version 0.18.0",
];

describe("what masking hides", () => {
  for (const [name, cases] of Object.entries(MASKED)) {
    it(`masks ${name}`, () => {
      for (const [given, masked] of cases) {
        assert.equal(mask(given), masked);
      }
    });
  }

  it("leaves ordinary commands byte for byte", () => {
    for (const given of ORDINARY) {
      assert.equal(mask(given), given);
    }
  });
});

describe("where masking is applied", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ovai-mask-"));
  after(() => fs.rmSync(root, { recursive: true, force: true }));
  const secret = fill(20);
  const command = `curl -H "Authorization: Bearer ${secret}" https://api.example.com`;

  it("masks a session's command in runtime.log", () => {
    const rows = [];
    sink((row) => rows.push(row));
    try {
      called("Worker", { id: "toolu_mask", name: "Bash", what: command });
    } finally {
      sink(null);
    }
    assert.equal(rows.length, 1);
    assert.ok(rows[0].endsWith(` called Worker toolu_mask curl -H "Authorization: Bearer ***" https://api.example.com`), rows[0]);
  });

  it("masks a permission rule in what admin mode reports", () => {
    fs.mkdirSync(path.join(root, ".local"), { recursive: true });
    fs.writeFileSync(path.join(root, ".local", "settings.json"), JSON.stringify({ permissions: { allow: [`Bash(${command})`] } }));
    assert.deepEqual(snapshot(root).rules[".local/settings.json"], ['allow Bash(curl -H "Authorization: Bearer ***" https://api.example.com)']);
  });
});
