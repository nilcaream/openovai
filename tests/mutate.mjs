// tests/mutate.mjs — prove a check by breaking the code it is about.
//
//   node tests/mutate.mjs tests/mutations.json
//
// A check that has never been watched failing is not a check. This runs the suite once with each
// mutation applied and reports which LEAF checks went red, so a mutation that reddens the check it
// was written for has been proven and one that reddens nothing has not.
//
// Everything a sweep has to get right is in here rather than in the head of whoever is writing
// checks today: a sweep runner written by hand gets the bounds, the baseline or the restore wrong
// in a different place each time, and every one of those mistakes reads like a finding about the
// suite rather than like a broken runner. It never
// touches the tree you are working in: it builds N copies of it under .tmp/ and mutates those, so
// a sweep that is killed, OOMed or parked mid-mutation cannot leave a deliberate bug in your
// checkout. The copies run in parallel, which is free — the suite spends its time waiting on
// fixtures, not on the CPU.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// How many copies to sweep in parallel. Bounded by MEMORY, not by cores: one run peaks around
// 300 MB once its chat server and stand-ins are counted, and a sweep is usually run on a machine
// that is also running an editor and a browser. Four copies is ~1.2 GB and about 1.5 cores' worth
// of work. An OOM kill mid-mutation is the accident this tool exists to prevent, so the default
// errs low; raise it with --copies when the machine is quiet.
const COPIES = Math.max(1, Math.min(4, os.cpus().length));

// A per-CHECK bound, which is how a mutation that hangs by design is caught. node --test defaults
// to --test-timeout=0, meaning no bound at all, so one await that never settles hangs the whole
// sweep for ever. With this, the hanging check goes red BY NAME and the rest of the file finishes.
const CHECK_TIMEOUT = 30_000;

// The outer net, for the case the runner itself wedges rather than a check. Derived from the
// measured baseline (below), never a constant: a number chosen when the suite took two minutes is
// meaningless once it takes five.
const BOUND_MULTIPLE = 3;
const BOUND_FLOOR = 120_000;

function usage() {
  return `node tests/mutate.mjs <mutations.json> [options]

  --suite <path>         test file to run                 (default tests/chat.test.mjs)
  --copies <n>           pinned copies to sweep at once    (default ${COPIES})
  --check-timeout <ms>   per-check bound                   (default ${CHECK_TIMEOUT})
  --out <path>           where the result JSON goes        (default .tmp/mutations.json)
  --keep                 leave the copies behind for inspection

A mutations file is a JSON array:

  [
    {
      "name": "the popup is awaited",
      "catches": "says nothing on the panel when the desktop is not reached",
      "edits": [{ "file": "tools/chat/pop.mjs", "from": "  pop(", "to": "  await pop(" }]
    }
  ]

  name     what the mutation does, in the words you would say out loud
  catches  the ONE leaf check it was written to redden
  edits    applied in order to one in-memory copy of each file, so two edits to the same
           file cannot clobber each other. Each "from" must match exactly once.
`;
}

function options(argv) {
  const chosen = {
    list: undefined,
    suite: "tests/chat.test.mjs",
    copies: COPIES,
    checkTimeout: CHECK_TIMEOUT,
    out: path.join(repo, ".tmp", "mutations.json"),
    keep: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--suite") chosen.suite = argv[(i += 1)];
    else if (flag === "--copies") chosen.copies = Number(argv[(i += 1)]);
    else if (flag === "--check-timeout") chosen.checkTimeout = Number(argv[(i += 1)]);
    else if (flag === "--out") chosen.out = path.resolve(argv[(i += 1)]);
    else if (flag === "--keep") chosen.keep = true;
    else if (flag === "--help" || flag === "-h") return null;
    else if (chosen.list === undefined) chosen.list = flag;
    else throw new Error(`I do not know what to do with ${flag}`);
  }
  if (chosen.list === undefined) return null;
  return chosen;
}

// ---------------------------------------------------------------------------- the mutation list

// A mutation the tool cannot understand is a mistake in the list, not a finding about the suite,
// and it has to say so before anything runs rather than reporting NOTHING NOTICED an hour later.
function readMutations(where) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(where, "utf8"));
  } catch (error) {
    throw new Error(`${where} is not readable JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`${where} must be a non-empty array of mutations`);
  }
  parsed.forEach((mutation, index) => {
    const at = `mutation ${index + 1}`;
    if (typeof mutation.name !== "string" || mutation.name === "") throw new Error(`${at} has no name`);
    if (typeof mutation.catches !== "string" || mutation.catches === "") {
      throw new Error(`${at} (${mutation.name}) has no "catches": name the ONE leaf check it is written to redden`);
    }
    if (!Array.isArray(mutation.edits) || mutation.edits.length === 0) throw new Error(`${at} (${mutation.name}) has no edits`);
    for (const edit of mutation.edits) {
      if (typeof edit.file !== "string" || typeof edit.from !== "string" || typeof edit.to !== "string") {
        throw new Error(`${at} (${mutation.name}) has an edit that is not {file, from, to}`);
      }
    }
  });
  return parsed;
}

// ------------------------------------------------------------------------------------- the tree

function git(argv, cwd = repo) {
  return spawnSync("git", argv, { cwd, encoding: "utf8" });
}

// What the working tree looks like right now, as one string. Taken before the sweep and again
// after it: if it moved while the copies were being made, the copies were built from a target that
// was moving and every result in the sweep is about a tree nobody has.
function treeState() {
  const said = git(["status", "--porcelain"]);
  if (said.status !== 0) throw new Error(`git status failed: ${said.stderr.trim()}`);
  return said.stdout;
}

// One copy of the working tree, tracked content and uncommitted work alike.
//
// git archive alone would give the committed tree, which is the wrong tree: a sweep runs while a
// change is still uncommitted, and proving checks against code that has not been written yet is
// worse than not proving them. So the committed tree is laid down first and everything git reports
// as changed is copied over it — modified, added, untracked and deleted.
function buildCopy(into) {
  fs.rmSync(into, { recursive: true, force: true });
  fs.mkdirSync(into, { recursive: true });

  const archive = spawnSync("git", ["archive", "HEAD"], { cwd: repo, maxBuffer: 512 * 1024 * 1024 });
  if (archive.status !== 0) throw new Error(`git archive failed: ${archive.stderr}`);
  const unpacked = spawnSync("tar", ["-x", "-C", into], { input: archive.stdout });
  if (unpacked.status !== 0) throw new Error(`unpacking the copy failed: ${unpacked.stderr}`);

  for (const line of treeState().split("\n")) {
    if (line === "") continue;
    // Porcelain is two status columns, a space, then the path; a rename carries "old -> new".
    const shown = line.slice(3);
    const where = shown.includes(" -> ") ? shown.slice(shown.indexOf(" -> ") + 4) : shown;
    const name = where.replace(/^"|"$/g, "");
    const from = path.join(repo, name);
    const to = path.join(into, name);
    if (fs.existsSync(from)) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.cpSync(from, to, { recursive: true });
    } else {
      fs.rmSync(to, { recursive: true, force: true });
    }
  }
  return into;
}

// -------------------------------------------------------------------------------- running a suite

// Node has to be on the PATH and not merely be the interpreter: install.sh and bin/ovai resolve
// `node` themselves and refuse a major older than the toolkit needs. Whichever node is running
// this tool is the one its children get.
function environment() {
  return { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}` };
}

// Every `not ok` in the TAP, split into the leaves that actually failed and the describes that are
// only red because a leaf under them is.
//
// The discriminator is the YAML block's own `type:`, never the indentation and never the
// `# Subtest:` lines — node prints one of those before EVERY test, parent and leaf alike, so a
// filter built on them removes every failure and the sweep reports NOTHING NOTICED for a suite
// that was biting on all of them — a clean-looking sweep is the one failure mode nothing else
// catches.
function readTap(output) {
  const lines = output.split("\n");
  let leaves = 0;
  const red = [];
  for (let i = 0; i < lines.length; i += 1) {
    const point = /^(\s*)(ok|not ok) \d+ - (.*)$/.exec(lines[i]);
    if (point === null) continue;
    let kind = "test";
    for (let j = i + 1; j < Math.min(i + 12, lines.length); j += 1) {
      if (/^\s*\.\.\.\s*$/.test(lines[j])) break;
      const said = /^\s*type: '(\w+)'/.exec(lines[j]);
      if (said !== null) {
        kind = said[1];
        break;
      }
    }
    if (kind === "suite") continue;
    leaves += 1;
    if (point[2] === "not ok") red.push(point[3].replace(/\s+#.*$/, "").trim());
  }
  return { leaves, red };
}

// One suite run in one copy. Answers with what went red, and — just as important — with whether the
// run is worth reading at all: a suite that died early reports few checks and no failures, which
// looks exactly like a clean pass.
// spawn and not spawnSync, and that is the whole of what makes the copies parallel: spawnSync holds
// the event loop, so several of them started "at once" would still run one after another. This was
// measured the wrong way round first - a three-copy sweep that took exactly three times one copy.
function runSuite(where, { suite, checkTimeout, boundMs }) {
  const began = Date.now();
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--test", "--test-reporter=tap", `--test-timeout=${checkTimeout}`, suite],
      { cwd: where, env: environment(), stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    let timedOut = false;
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        output += chunk;
      });
    }
    // The outer net. A check that hangs is caught by --test-timeout above and goes red by name;
    // this is for the case the runner itself wedges, and it takes the whole process group down.
    const bound = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, boundMs);
    child.on("close", () => {
      clearTimeout(bound);
      const { leaves, red } = readTap(output);
      resolve({ leaves, red, timedOut, tookMs: Date.now() - began });
    });
  });
}

// ------------------------------------------------------------------------------- one mutation

// Snapshot, apply, run, put back — and the putting back is in a `finally`, so a throw between the
// two cannot leave the copy carrying a deliberate bug for the next mutation to be measured against.
async function sweepOne(where, mutation, run) {
  const pristine = new Map();
  try {
    for (const edit of mutation.edits) {
      const target = path.join(where, edit.file);
      if (!fs.existsSync(target)) throw new Error(`${edit.file} is not in the tree`);
      if (!pristine.has(target)) pristine.set(target, fs.readFileSync(target, "utf8"));
      const text = fs.readFileSync(target, "utf8");
      const hits = text.split(edit.from).length - 1;
      // Not once is a mistake in the mutation, either way round. None means the anchor is stale and
      // the mutation was never applied; more than one means it was applied somewhere nobody meant.
      if (hits !== 1) {
        throw new Error(`${edit.file}: "${edit.from.slice(0, 60).replace(/\n/g, "\\n")}" matched ${hits} times, not once`);
      }
      fs.writeFileSync(target, text.replace(edit.from, () => edit.to));
    }
    return { ...(await run()), refused: null };
  } catch (error) {
    return { leaves: 0, red: [], timedOut: false, tookMs: 0, refused: error.message };
  } finally {
    for (const [target, text] of pristine) fs.writeFileSync(target, text);
  }
}

// What a finished mutation means, in the words the reader needs. Kept apart from the running so the
// rules are readable in one place.
function verdictOf(mutation, result, baselineLeaves) {
  if (result.refused !== null) return { verdict: "HARNESS", why: result.refused, bit: false };
  if (result.timedOut) {
    return { verdict: "TIMED OUT", why: "the run did not finish inside the bound; nothing about it can be read", bit: false };
  }
  // A run that reported fewer checks than the baseline died somewhere, and its short list of
  // failures is not a list of what the suite noticed.
  if (result.leaves < baselineLeaves) {
    return {
      verdict: "UNREPORTABLE",
      why: `only ${result.leaves} of ${baselineLeaves} checks ran, so the suite died early`,
      bit: false,
    };
  }
  if (result.red.length === 0) {
    return { verdict: "NOTHING NOTICED", why: "no check went red; this is dead code or a vacuous check, never 'the code is fine'", bit: false };
  }
  if (!result.red.includes(mutation.catches)) {
    return {
      verdict: "WRONG CHECK",
      why: `red, but "${mutation.catches}" was not among them — something else is covering this`,
      bit: false,
    };
  }
  return { verdict: "BIT", why: null, bit: true };
}

// ------------------------------------------------------------------------------------- the sweep

async function main() {
  const chosen = options(process.argv.slice(2));
  if (chosen === null) {
    process.stdout.write(usage());
    return 0;
  }
  const mutations = readMutations(chosen.list);
  const before = treeState();
  const scratch = path.join(repo, ".tmp", "mutate");
  fs.mkdirSync(scratch, { recursive: true });

  const howMany = Math.max(1, Math.min(chosen.copies, mutations.length));
  process.stdout.write(`${mutations.length} mutations, ${howMany} pinned ${howMany === 1 ? "copy" : "copies"}, suite ${chosen.suite}\n\n`);

  const copies = [];
  for (let i = 0; i < howMany; i += 1) copies.push(buildCopy(path.join(scratch, `copy-${i + 1}`)));

  // Every copy is baselined on its own, unmutated, before it is allowed to carry a mutation.
  // A sweep that starts from a tree somebody already broke reports the same checks red for every
  // mutation, which reads exactly like a suite watching everything and is the opposite of the truth.
  const bounds = { suite: chosen.suite, checkTimeout: chosen.checkTimeout, boundMs: BOUND_FLOOR };
  const first = await runSuite(copies[0], bounds);
  if (first.timedOut || first.red.length > 0 || first.leaves === 0) {
    process.stdout.write(`THE TREE IS NOT GREEN BEFORE ANY OF THIS — ${first.red.join(" | ") || "the baseline did not finish"}\n`);
    return 2;
  }
  // The outer bound is derived from what the baseline actually took, so it stays honest as the
  // suite grows.
  bounds.boundMs = Math.max(BOUND_FLOOR, first.tookMs * BOUND_MULTIPLE);
  process.stdout.write(`baseline green: ${first.leaves} checks in ${(first.tookMs / 1000).toFixed(1)}s (bound ${(bounds.boundMs / 1000).toFixed(0)}s)\n`);

  const others = await Promise.all(copies.slice(1).map((where) => runSuite(where, bounds)));
  for (const [index, also] of others.entries()) {
    if (also.red.length > 0 || also.leaves !== first.leaves) {
      process.stdout.write(`copy ${path.basename(copies[index + 1])} did not baseline the same as copy-1 — refusing to sweep\n`);
      return 2;
    }
  }
  process.stdout.write(`every copy baselined at ${first.leaves} checks\n\n`);

  // Each copy takes the next mutation off one shared queue rather than a fixed share, so one slow
  // mutation does not leave three copies idle.
  const queue = mutations.map((mutation, index) => ({ mutation, index }));
  const results = new Array(mutations.length);
  await Promise.all(
    copies.map(async (where) => {
      for (;;) {
        const next = queue.shift();
        if (next === undefined) return;
        const result = await sweepOne(where, next.mutation, () => runSuite(where, bounds));
        const verdict = verdictOf(next.mutation, result, first.leaves);
        results[next.index] = {
          name: next.mutation.name,
          catches: next.mutation.catches,
          ...verdict,
          red: result.red,
          checks: result.leaves,
          tookMs: result.tookMs,
          copy: path.basename(where),
        };
        process.stdout.write(
          `${verdict.verdict.padEnd(16)} ${next.mutation.name}\n` +
            (verdict.why === null
            ? `                 reddened ${result.red.length} of ${first.leaves}: ${result.red.slice(0, 4).join(" | ")}${result.red.length > 4 ? " | …" : ""}\n`
            : `                 ${verdict.why}\n`),
        );
      }
    }),
  );

  // The copies are put back to pristine by every mutation's own `finally`; this proves it rather
  // than assuming it, which is the other half of trusting any of the results above.
  let restored = true;
  const closing = await Promise.all(copies.map((where) => runSuite(where, bounds)));
  for (const [index, again] of closing.entries()) {
    if (again.red.length > 0 || again.leaves !== first.leaves) {
      process.stdout.write(`\n${path.basename(copies[index])} IS NOT GREEN AGAIN: ${again.red.join(" | ") || "the run did not finish"}\n`);
      restored = false;
    }
  }

  const after = treeState();
  const steady = after === before;
  if (!steady) {
    process.stdout.write(`\nTHE WORKING TREE CHANGED WHILE THIS RAN — somebody else is editing it, so throw this sweep away\n`);
  }

  fs.mkdirSync(path.dirname(chosen.out), { recursive: true });
  fs.writeFileSync(chosen.out, `${JSON.stringify({ suite: chosen.suite, baselineChecks: first.leaves, steady, restored, results }, null, 2)}\n`);

  const missed = results.filter((result) => !result.bit);
  process.stdout.write(`\n${results.length - missed.length} of ${results.length} bit the check they were written for\n`);
  for (const result of missed) process.stdout.write(`  ${result.verdict}: ${result.name}\n`);
  process.stdout.write(`written to ${chosen.out}\n`);

  if (!chosen.keep) fs.rmSync(scratch, { recursive: true, force: true });

  // The last line, and the thing to look for. A sweep that did not print it did not finish, and
  // nothing above it can be trusted.
  process.stdout.write("\n=== SWEEP COMPLETE ===\n");
  return steady && restored && missed.length === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`mutate: ${error.message}\n`);
    process.exit(2);
  },
);
