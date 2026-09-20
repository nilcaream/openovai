// tests/runtime.test.mjs — where the toolkit's own node and claude are, and how they are fetched.
//
// Nothing here reaches nodejs.org or npm. The archive the shell fetches from is a directory served
// on a port here, holding a tarball made here — a node that is a two-line shell script saying its
// version — and the checksum file that names it. What is checked is what the script does around a
// download: reads the pin, names the platform, verifies, unpacks, moves into place once, reuses,
// refuses; and that lib/runtime.mjs answers the same paths from the same file.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { remove, repo, scratch } from "./helpers.mjs";
import { RUNTIME_FILE, RuntimeError, dataDirectory, pins, runtimePaths } from "../lib/runtime.mjs";

const here = scratch("runtime-test");
const A_VERSION = /^\d+\.\d+\.\d+$/;

// The platform the script will name for this machine, in the words nodejs.org uses.
const PLATFORM = `linux-${{ x64: "x64", arm64: "arm64" }[process.arch]}`;

// The versions the fixture pins: not ones that exist, so a test that reached the real archive by
// mistake would fail on a 404 rather than pass on a real download.
const NODE = "9.9.9";
const CLAUDE = "8.8.8";
const PIN = `# a note\nnode ${NODE}\nclaude ${CLAUDE}\n`;

after(() => remove(here));

// A tree with a RUNTIME of its own and the real script beside it, the way lib/ carries them.
function aTree(name, pin = PIN) {
  const tree = path.join(here, name);
  fs.mkdirSync(path.join(tree, "lib"), { recursive: true });
  fs.writeFileSync(path.join(tree, RUNTIME_FILE), pin);
  fs.copyFileSync(path.join(repo, "lib", "runtime.sh"), path.join(tree, "lib", "runtime.sh"));
  return tree;
}

// The script run as an instance would run it: a home of its own, PATH as it is, XDG unset unless
// given. What it printed, what it refused with, and how it ended. Not spawnSync: the archive it
// fetches from is served by this very process, and a blocked event loop answers no request.
function sh(tree, argv, env = {}) {
  const home = path.join(tree, "home");
  fs.mkdirSync(home, { recursive: true });
  return new Promise((resolve) => {
    const child = spawn("sh", [path.join(tree, "lib", "runtime.sh"), ...argv], {
      env: { PATH: process.env.PATH, HOME: home, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (out += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (err += chunk));
    child.on("close", (status) => resolve({ status, out: out.trim(), err: err.trim(), home }));
  });
}

// A stand-in for a command on the PATH, saying what it is told to say.
function standIn(directory, name, script) {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, name);
  fs.writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return file;
}

// The archive: v<NODE>/node-v<NODE>-<platform>.tar.gz with bin/node and bin/npm in it, and the
// SHASUMS256.txt that names it among others. `sums` rewrites the checksum file for a check about a
// download that does not match it.
function anArchive(name, { npm = true, sums = (lines) => lines } = {}) {
  const root = path.join(here, name);
  const release = path.join(root, `v${NODE}`);
  const unpacked = `node-v${NODE}-${PLATFORM}`;
  const stage = path.join(root, "stage");
  standIn(path.join(stage, unpacked, "bin"), "node", `printf 'v${NODE}\\n'`);
  if (npm) standIn(path.join(stage, unpacked, "bin"), "npm", "printf 'npm stand-in\\n'");
  fs.mkdirSync(release, { recursive: true });
  const tarball = path.join(release, `${unpacked}.tar.gz`);
  const made = spawnSync("tar", ["-czf", tarball, "-C", stage, unpacked], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  const sum = crypto.createHash("sha256").update(fs.readFileSync(tarball)).digest("hex");
  const lines = [
    `${"0".repeat(64)}  node-v${NODE}-darwin-arm64.tar.gz`,
    `${sum}  ${unpacked}.tar.gz`,
    `${"1".repeat(64)}  node-v${NODE}.tar.xz`,
  ];
  fs.writeFileSync(path.join(release, "SHASUMS256.txt"), `${sums(lines).join("\n")}\n`);
  return { root, tarball, sums: path.join(release, "SHASUMS256.txt") };
}

// The archive on a port, counting what was asked of it.
function serve(root) {
  const asked = [];
  const server = http.createServer((request, response) => {
    asked.push(request.url);
    const file = path.join(root, request.url);
    if (!fs.existsSync(file)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200).end(fs.readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${server.address().port}`, asked, close: () => server.close() }));
  });
}

describe("the pin file", () => {
  it("pins node and claude to exact versions in this tree", async () => {
    const pinned = pins(repo);
    assert.match(pinned.node, A_VERSION);
    assert.match(pinned.claude, A_VERSION);
  });

  it("skips notes and reads one version per name", async () => {
    assert.deepEqual(pins(aTree("notes")), { node: NODE, claude: CLAUDE });
  });

  it("refuses a line that is not a name and a version", async () => {
    assert.throws(
      () => pins(aTree("loose", "node latest\nclaude 1.2.3\n")),
      (raised) => raised instanceof RuntimeError && /has a line that is not "<node\|claude> <version like 1\.2\.3>": "node latest"/.test(raised.message),
    );
  });

  it("refuses a file that does not pin every name", async () => {
    assert.throws(() => pins(aTree("short", `node ${NODE}\n`)), (raised) => raised instanceof RuntimeError && /does not pin claude/.test(raised.message));
  });

  it("is read the same by the shell", async () => {
    const pinned = pins(repo);
    assert.equal((await sh(repo, ["pin", "node"])).out, pinned.node);
    assert.equal((await sh(repo, ["pin", "claude"])).out, pinned.claude);
  });

  it("is refused by the shell when a version is not three numbers", async () => {
    const said = await sh(aTree("loose-sh", "node 24\nclaude 1.2.3\n"), ["pin", "node"]);
    assert.equal(said.status, 1);
    assert.match(said.err, /does not pin node to one version like 1\.2\.3/);
  });
});

describe("the data directory", () => {
  it("is $XDG_DATA_HOME/openovai when the variable is set", async () => {
    assert.equal(dataDirectory({ XDG_DATA_HOME: "/somewhere/data" }), "/somewhere/data/openovai");
    assert.equal((await sh(repo, ["data-dir"], { XDG_DATA_HOME: "/somewhere/data" })).out, "/somewhere/data/openovai");
  });

  it("is ~/.local/share/openovai when the variable is unset", async () => {
    assert.equal(dataDirectory({}), path.join(os.homedir(), ".local", "share", "openovai"));
    const said = await sh(repo, ["data-dir"]);
    assert.equal(said.out, path.join(said.home, ".local", "share", "openovai"));
  });

  it("reads an empty variable as unset", async () => {
    assert.equal(dataDirectory({ XDG_DATA_HOME: "" }), path.join(os.homedir(), ".local", "share", "openovai"));
    const said = await sh(repo, ["data-dir"], { XDG_DATA_HOME: "" });
    assert.equal(said.out, path.join(said.home, ".local", "share", "openovai"));
  });
});

describe("the platform", () => {
  it("is this machine, in the words nodejs.org uses", async () => {
    assert.equal((await sh(repo, ["platform"])).out, PLATFORM);
  });

  it("refuses anything but Linux in one line", async () => {
    const fake = path.join(here, "not-linux");
    standIn(fake, "uname", 'case "$1" in -s) echo Darwin ;; -m) echo arm64 ;; esac');
    const said = await sh(repo, ["platform"], { PATH: `${fake}:${process.env.PATH}` });
    assert.equal(said.status, 1);
    assert.equal(said.err, "runtime.sh: only Linux is supported, and this is Darwin");
  });

  it("refuses a machine nodejs.org has no archive for", async () => {
    const fake = path.join(here, "odd-machine");
    standIn(fake, "uname", 'case "$1" in -s) echo Linux ;; -m) echo riscv64 ;; esac');
    const said = await sh(repo, ["platform"], { PATH: `${fake}:${process.env.PATH}` });
    assert.equal(said.status, 1);
    assert.match(said.err, /^runtime\.sh: only x86_64 and arm64 are supported, and this machine is riscv64$/);
  });
});

describe("the paths", () => {
  const env = { XDG_DATA_HOME: path.join(here, "paths-data") };

  it("are absolute, under the data directory, one directory per exact version", async () => {
    const tree = aTree("paths");
    const data = path.join(env.XDG_DATA_HOME, "openovai");
    assert.deepEqual(runtimePaths(tree, env), {
      data,
      node: path.join(data, "node", NODE, "bin", "node"),
      npm: path.join(data, "node", NODE, "bin", "npm"),
      claude: path.join(data, "claude", CLAUDE, "bin", "claude"),
    });
  });

  it("are answered the same by the shell", async () => {
    const tree = aTree("paths-sh");
    const paths = runtimePaths(tree, env);
    assert.equal((await sh(tree, ["node-path"], env)).out, paths.node);
    assert.equal((await sh(tree, ["npm-path"], env)).out, paths.npm);
    assert.equal((await sh(tree, ["claude-path"], env)).out, paths.claude);
  });
});

describe("verify", () => {
  it("passes an archive whose checksum is the one the file names", async () => {
    const archive = anArchive("verify-good");
    const said = await sh(repo, ["verify", archive.tarball, archive.sums]);
    assert.equal(said.status, 0, said.err);
  });

  it("refuses an archive whose checksum does not match", async () => {
    const archive = anArchive("verify-bad", { sums: (lines) => lines.map((line) => line.replace(/^[0-9a-f]{64}  node-v.*linux/, `${"f".repeat(64)}  node-v${NODE}-linux`)) });
    const said = await sh(repo, ["verify", archive.tarball, archive.sums]);
    assert.equal(said.status, 1);
    assert.match(said.err, /does not match its checksum in SHASUMS256\.txt; the download is corrupt or tampered with/);
  });

  it("refuses a checksum file that does not name the archive", async () => {
    const archive = anArchive("verify-unnamed", { sums: (lines) => lines.filter((line) => !line.includes("linux")) });
    const said = await sh(repo, ["verify", archive.tarball, archive.sums]);
    assert.equal(said.status, 1);
    assert.match(said.err, /has 0 lines naming node-v.*, not one; nothing was verified/);
  });
});

describe("ensure", () => {
  let archive;
  let served;

  before(async () => {
    archive = anArchive("archive");
    served = await serve(archive.root);
  });

  after(() => served.close());

  // A tree pinned to the fixture, its own data directory, and the claude the fixture cannot install
  // already in place — so `ensure` is about node, and says of claude that it is there.
  function anInstance(name, { claude = true } = {}) {
    const tree = aTree(name);
    const env = { XDG_DATA_HOME: path.join(tree, "xdg"), OPENOVAI_NODE_DIST: served.url };
    const paths = runtimePaths(tree, env);
    if (claude) standIn(path.dirname(paths.claude), "claude", "printf 'claude stand-in\\n'");
    return { tree, env, paths };
  }

  it("fetches the pinned node from the archive, verified, and puts it in place", async () => {
    const { tree, env, paths } = anInstance("fetch");
    const said = await sh(tree, ["ensure"], env);
    assert.equal(said.status, 0, said.err);
    assert.deepEqual(said.out.split("\n"), [
      `Fetching Node.js ${NODE} (${PLATFORM}) from ${served.url}/v${NODE} into ${path.dirname(path.dirname(paths.node))}`,
      `Node.js ${NODE} in ${path.dirname(path.dirname(paths.node))}`,
      `Claude Code ${CLAUDE} already in ${path.dirname(path.dirname(paths.claude))}`,
    ]);
    assert.equal(spawnSync(paths.node, ["--version"], { encoding: "utf8" }).stdout.trim(), `v${NODE}`);
    assert.ok(fs.existsSync(paths.npm), "npm came with node");
    assert.deepEqual(served.asked, [`/v${NODE}/node-v${NODE}-${PLATFORM}.tar.gz`, `/v${NODE}/SHASUMS256.txt`]);
  });

  it("leaves nothing under tmp once the runtime is in place", async () => {
    const { tree, env, paths } = anInstance("tidy");
    assert.equal((await sh(tree, ["ensure"], env)).status, 0);
    assert.deepEqual(fs.readdirSync(path.join(paths.data, "tmp")), []);
  });

  it("reuses a node that is already there and asks the archive for nothing", async () => {
    const { tree, env, paths } = anInstance("reuse");
    assert.equal((await sh(tree, ["ensure"], env)).status, 0);
    const before = served.asked.length;
    const said = await sh(tree, ["ensure"], env);
    assert.equal(said.status, 0, said.err);
    assert.deepEqual(said.out.split("\n"), [
      `Node.js ${NODE} already in ${path.dirname(path.dirname(paths.node))}`,
      `Claude Code ${CLAUDE} already in ${path.dirname(path.dirname(paths.claude))}`,
    ]);
    assert.equal(served.asked.length, before);
  });

  it("refuses a node directory that is there but does not run as the pinned version", async () => {
    const { tree, env, paths } = anInstance("broken");
    standIn(path.dirname(paths.node), "node", "printf 'v0.0.1\\n'");
    const said = await sh(tree, ["ensure"], env);
    assert.equal(said.status, 1);
    assert.match(said.err, /is there but .*bin\/node does not run as Node\.js 9\.9\.9; remove the directory and run this again/);
  });

  it("refuses a download that does not match its checksum and leaves nothing behind", async () => {
    const tampered = anArchive("tampered", { sums: (lines) => lines.map((line) => line.replace(/^[0-9a-f]{64}  node-v.*linux/, `${"f".repeat(64)}  node-v${NODE}-linux`)) });
    const bad = await serve(tampered.root);
    try {
      const { tree, env, paths } = anInstance("corrupt");
      const said = await sh(tree, ["ensure"], { ...env, OPENOVAI_NODE_DIST: bad.url });
      assert.equal(said.status, 1);
      assert.match(said.err, /does not match its checksum/);
      assert.equal(fs.existsSync(path.dirname(path.dirname(paths.node))), false, "nothing at the node's place");
      assert.deepEqual(fs.readdirSync(path.join(paths.data, "tmp")), []);
    } finally {
      bad.close();
    }
  });

  it("refuses a claude directory that is there without its command", async () => {
    const { tree, env, paths } = anInstance("claude-broken", { claude: false });
    fs.mkdirSync(path.dirname(path.dirname(paths.claude)), { recursive: true });
    const said = await sh(tree, ["ensure"], env);
    assert.equal(said.status, 1);
    assert.match(said.err, /is there but .*bin\/claude is not runnable; remove the directory and run this again/);
  });

  it("installs claude with the npm that came with node, and says so when there is none", async () => {
    const bare = anArchive("bare", { npm: false });
    const served2 = await serve(bare.root);
    try {
      const { tree, env } = anInstance("no-npm", { claude: false });
      const said = await sh(tree, ["ensure"], { ...env, OPENOVAI_NODE_DIST: served2.url });
      assert.equal(said.status, 1);
      assert.match(said.err, /bin\/npm is missing; Node\.js has to be fetched before Claude Code/);
    } finally {
      served2.close();
    }
  });
});
