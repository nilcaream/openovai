// tests/update.test.mjs — check that an instance can take a newer version of the toolkit.
//
// No release is ever published to check this against. A release is served from here instead — the
// two routes GitHub answers, and a real archive made with tar in the shape it hands out — so the
// path an instance takes is the whole path, minus only the network in the middle. What that leaves
// unproven is said in the README and in the knowledge, not hidden here.
//
// The instances are separate per describe and thrown away: an update replaces most of an instance,
// so a check about what came after it cannot share a root with a check about what came before.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { installed, remove, repo, runToolLater, scratch, serveRelease, waitFor } from "./helpers.mjs";
import { RELEASES } from "../tools/release.mjs";
import { isOlderThan } from "../tools/version.mjs";

const HUMAN = "Mike";
const LEADER = "Superman";
const NEWER = "9.9.9";

// The version the instances here are installed at. Read from the repository rather than written
// down, because these instances are installed from it: a literal would be a second place holding
// the version this repository is on, and every check below would go red the day it is bumped
// while nothing about an update had changed.
const INSTALLED = fs.readFileSync(path.join(repo, "VERSION"), "utf8").trim();

// Something in the newer payload that the installed one has not got. Without it the release is a
// copy of what the instance already has, and a check asking whether an entry was replaced cannot
// tell the two states apart — it passes with the entry skipped entirely. Measured: the check for
// exactly that reported NOTHING NOTICED until each entry carried this.
const MARKER = "OpenOv AI release marker";

// One file in each of them, so a check can ask about every entry rather than about one of them.
const MARKED = [
  ["bin", "ovai"],
  ["tools", "ovai.mjs"],
  ["templates", "leader.md"],
];

const here = scratch("update-test");

process.on("exit", () => remove(here));

function options(root) {
  return {
    "--root": root,
    "--source": repo,
    "--human": HUMAN,
    "--leader": LEADER,
    "--leader-model": "sonnet",
    "--worker-model": "haiku",
    "--port": 0,
    "--auth": "inherit",
  };
}

function makeInstance(name) {
  const root = path.join(here, name);
  installed(options(root));
  return root;
}

// A newer release: this workspace with a different version and notes of its own, copied rather
// than described — what an update has to survive is a whole tree replacing a whole tree.
//
// It also carries a file that is NOT part of what an instance is made of. A release from GitHub is
// the whole repository, tests and documentation and all, and an instance must take the parts it is
// made of and leave the rest where it found it.
function makeRelease(name, { version = NEWER, notes = "Hiring happens on the page now.", without = null } = {}) {
  const tree = path.join(here, name);
  for (const entry of ["bin", "tools", "templates"]) {
    fs.cpSync(path.join(repo, entry), path.join(tree, entry), { recursive: true });
  }
  for (const marked of MARKED) {
    const file = path.join(tree, ...marked);
    if (fs.existsSync(file)) {
      fs.appendFileSync(file, `\n// ${MARKER}\n`);
    }
  }
  fs.writeFileSync(path.join(tree, "VERSION"), `${version}\n`);
  fs.writeFileSync(path.join(tree, "NOTES.md"), `${notes}\n`);
  fs.writeFileSync(path.join(tree, "CONTRIBUTING.md"), "not part of an instance\n");
  if (without !== null) {
    fs.rmSync(path.join(tree, without), { recursive: true, force: true });
  }
  return tree;
}

function update(root, from) {
  return runToolLater(root, ["update", "--from", from], process.env);
}

// Everything an instance is, apart from what the toolkit ships it. This is what an update must
// leave exactly as it found it, and reading it as content rather than as a list of names is the
// point: a desk rewritten under the same name would pass any check that only counted files.
function whatTheInstanceAccumulated(root) {
  const shipped = new Set(["bin", "tools", "templates", "VERSION"]);
  const found = new Map();

  const walk = (directory, prefix) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (prefix === "" && shipped.has(entry.name)) {
        continue;
      }
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full, relative);
      } else {
        found.set(relative, fs.readFileSync(full, "utf8"));
      }
    }
  };

  walk(root, "");
  return found;
}

function difference(before_, after_) {
  const changed = [];
  for (const [name, content] of after_) {
    if (!before_.has(name)) {
      changed.push(`added ${name}`);
    } else if (before_.get(name) !== content) {
      changed.push(`rewrote ${name}`);
    }
  }
  for (const name of before_.keys()) {
    if (!after_.has(name)) {
      changed.push(`removed ${name}`);
    }
  }
  return changed.sort();
}

describe("taking a newer version from a directory", () => {
  const root = makeInstance("from-directory");
  const tree = makeRelease("release");
  let accumulated;
  let done;

  before(async () => {
    // A file this version has and the next one has not, so a check can ask whether an update
    // replaces the payload or merely writes over it.
    fs.writeFileSync(path.join(root, "tools", "left-behind.mjs"), "// dropped by the newer version\n");
    // And a tool this instance serves itself, which is the opposite case and the reason the
    // directory it lives in is not part of the payload. An update replaces every payload entry
    // whole, so a tool kept under one of them would be taken away by the first update anybody ran
    // — silently, since an update reports what it replaced and not what it removed.
    //
    // No check of its own. The check that everything outside the payload survives is already here
    // and already asks of every file at once, and a second one reading this file back would be
    // reddened by the same single edit and by nothing else.
    fs.writeFileSync(path.join(root, "plugins", "notify.mjs"), "// a tool this instance serves itself\n");
    accumulated = whatTheInstanceAccumulated(root);
    done = await update(root, tree);
  });

  it("says what it did", () => {
    assert.equal(done.status, 0);
  });

  it("puts the instance on the version the release is", () => {
    assert.equal(fs.readFileSync(path.join(root, "VERSION"), "utf8").trim(), NEWER);
  });

  it("names both versions", () => {
    const said = `Was on ${INSTALLED}, now on ${NEWER}`;
    assert.ok(done.stdout.includes(said), `nothing said ${JSON.stringify(said)}: ${done.stdout}`);
  });

  // Every entry, in one expression, so that skipping one of them cannot pass as replacing the
  // others — and named, so a failure says which one did not arrive.
  it("brings the new payload in, all of it", () => {
    const arrived = MARKED.filter((marked) =>
      fs.readFileSync(path.join(root, ...marked), "utf8").includes(MARKER),
    );
    assert.deepEqual(arrived, MARKED);
  });

  // Replaced, not written over. A file the newer version dropped has to go, or an instance stops
  // being a copy of any version and becomes the union of two.
  it("takes away what the newer version does not have", () => {
    assert.equal(fs.existsSync(path.join(root, "tools", "left-behind.mjs")), false);
  });

  // A release is the whole repository. What an instance is made of is a list, and everything else
  // in there is somebody else's business.
  it("takes only what an instance is made of", () => {
    assert.equal(fs.existsSync(path.join(root, "CONTRIBUTING.md")), false);
  });

  // The whole of what an update must not do, in one reading. Every file outside the payload,
  // compared by content: the desks, the personas, the settings, the instance's own description of
  // itself, its Claude Code home with what the workspace has learned in it, and the panels. The one
  // thing that may appear is the word it leaves for the chat.
  it("changes nothing outside the payload but the word it leaves for the chat", () => {
    assert.deepEqual(difference(accumulated, whatTheInstanceAccumulated(root)), ["added chat/untold.json"]);
  });

  it("leaves the word saying which versions it moved between", () => {
    const said = JSON.parse(fs.readFileSync(path.join(root, "chat", "untold.json"), "utf8"));
    assert.deepEqual([said.from, said.to], [INSTALLED, NEWER]);
  });

  it("leaves the notes the release carried with it", () => {
    const said = JSON.parse(fs.readFileSync(path.join(root, "chat", "untold.json"), "utf8"));
    assert.match(said.notes, /Hiring happens on the page now\./);
  });

  it("says nothing to do when the instance is already on it", async () => {
    assert.match((await update(root, tree)).stdout, /is the latest release/);
  });
});

describe("taking a newer version from a release", () => {
  const root = makeInstance("from-release");
  let served;
  let done;

  before(async () => {
    served = await serveRelease(makeRelease("served"), `v${NEWER}`);
    done = await runToolLater(root, ["update", "--from", served.latest], process.env);
  });

  after(() => served?.close());

  it("takes it", () => {
    assert.equal(done.status, 0);
  });

  it("puts the instance on the version the release is", () => {
    assert.equal(fs.readFileSync(path.join(root, "VERSION"), "utf8").trim(), NEWER);
  });

  // The archive is opened somewhere inside the instance and that somewhere is not part of it.
  it("leaves nothing of the package behind", () => {
    assert.equal(fs.existsSync(path.join(root, ".release")), false);
  });
});

describe("what an update refuses", () => {
  const root = makeInstance("refusals");

  it("refuses a package that is not an OpenOv AI instance, saying what it is missing", async () => {
    const refused = await update(root, makeRelease("not-a-workspace", { without: "templates" }));
    const said = /^ovai: .*does not look like an OpenOv AI instance.*templates/m.test(refused.stderr);
    assert.equal([refused.status === 0, said].join(" "), "false true");
  });

  it("leaves the instance on the version it was on", () => {
    assert.equal(fs.readFileSync(path.join(root, "VERSION"), "utf8").trim(), INSTALLED);
  });

  // A default that is taken quietly when the command line is mistyped would update an instance
  // from somewhere other than the place that was meant.
  //
  // Both read the exit status the command uses for a command line it could not make sense of, and
  // not merely a non-zero one. Anything at all handed to --from fails later anyway — a word that is
  // neither a directory nor an address is asked for as a URL and does not answer — so a check that
  // only asked for a failure would pass with the whole of this reading removed.
  it("refuses an argument that is not the one option, as a command line", async () => {
    assert.equal((await runToolLater(root, ["update", "somewhere"], process.env)).status, 2);
  });

  it("refuses --from with nothing after it, as a command line", async () => {
    assert.equal((await runToolLater(root, ["update", "--from"], process.env)).status, 2);
  });

  // Read rather than fetched. Nothing here talks to the place the toolkit is published from — a
  // check that did would be a check on somebody else's uptime — so what is asserted is the address
  // itself. There is nothing to derive it from, which is exactly why it is written down twice: an
  // instance that quietly began updating itself from somewhere else is the one failure here nobody
  // would notice from the outside.
  it("looks at the releases of the toolkit itself when it is not told where", () => {
    assert.equal(RELEASES, "https://api.github.com/repos/nilcaream/openovai/releases/latest");
  });
});

// Which of two versions is the earlier one, asked of the versions themselves rather than through
// an instance. It is about digits and there is nothing to install to say so: 0.10.0 comes after
// 0.5.0 and reads as coming before it the moment the two are compared as words, and an instance
// installed to prove that would have to be installed at a version this repository is not on.
describe("which version is older", () => {
  it("compares the numbers rather than the words", () => {
    const answered = [
      ["0.4.9", "0.5.0"],
      ["0.5.0", "0.5.0"],
      ["0.5.1", "0.5.0"],
      ["0.10.0", "0.5.0"],
      ["0.5.0", "0.10.0"],
      ["1.0", "0.99.99"],
      ["0.5", "0.5.0"],
      ["0.5.0", "0.5"],
    ].map(([candidate, installed_]) => isOlderThan(candidate, installed_));

    assert.deepEqual(answered, [true, false, false, false, true, false, false, false]);
  });

  // A refusal has to be certain of what it is refusing. Nothing that is not a row of numbers can
  // be placed before or after anything, and an instance made before the toolkit carried a version
  // has nothing to be placed after at all — so neither is called older, and an update carrying
  // one of them goes on as it always did rather than being stopped by a comparison nobody made.
  it("calls nothing older that it cannot place", () => {
    const answered = [
      ["0.5.0", null],
      [null, "0.5.0"],
      ["0.5.0", "dev"],
      ["dev", "0.5.0"],
      ["0.5.0-rc1", "0.5.0"],
    ].map(([candidate, installed_]) => isOlderThan(candidate, installed_));

    assert.deepEqual(answered, [false, false, false, false, false]);
  });
});

// A running chat is serving the code that is about to be replaced under it, and a process keeps the
// code it started with. Refusing here is also what means no session is ever mid-turn during an
// update.
describe("an update while the chat is running", () => {
  const root = makeInstance("while-serving");
  const tree = makeRelease("while-serving-release");
  let chat;
  let refused;

  before(async () => {
    chat = runToolLater(root, ["chat"], { ...process.env, PATH: process.env.PATH });
    await waitFor(() => (fs.existsSync(path.join(root, "chat", "listening.json")) ? true : null));
    const url = JSON.parse(fs.readFileSync(path.join(root, "chat", "listening.json"), "utf8")).url;
    await waitFor(async () => {
      try {
        return (await fetch(`${url}/health`)).ok ? true : null;
      } catch {
        return null;
      }
    });
    refused = await update(root, tree);
  });

  after(async () => {
    const recorded = path.join(root, "chat", "listening.json");
    if (fs.existsSync(recorded)) {
      process.kill(JSON.parse(fs.readFileSync(recorded, "utf8")).pid, "SIGTERM");
    }
    await chat;
  });

  it("refuses, and says to stop the chat", async () => {
    const said = /stop it with ctrl-c/.test(refused.stderr);
    assert.equal([refused.status === 0, said].join(" "), "false true");
  });

  it("leaves the instance on the version it was on", () => {
    assert.equal(fs.readFileSync(path.join(root, "VERSION"), "utf8").trim(), INSTALLED);
  });
});
