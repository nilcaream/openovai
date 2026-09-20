// tests/openovai.test.mjs — the command that installs an instance: installs itself from a pipe,
// names a version, fetches that release once and hands over to its installer.
//
// Nothing here reaches GitHub. What the command asks for is served on a port here: where
// releases/latest redirects to, a tag archive made here around a stub install.sh that says what it
// was handed, and the script's own text for the copy a piped run fetches. What is checked is what
// the script does around those: which version it names and says first, what it fetches and what it
// reuses, what it hands the installer, and what it refuses.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { remove, repo, scratch } from "./helpers.mjs";

const here = scratch("openovai-test");
const script = path.join(repo, "openovai");

// The releases the fixture serves: not ones that exist, so a run that reached GitHub by mistake
// would fail on a 404 rather than pass on a real download. The newest has an installer; so has the
// one before it; the oldest has none.
const LATEST = "9.9.9";
const OLDER = "9.9.8";
const BARE = "9.9.7";

after(() => remove(here));

// A command on the PATH, saying what it is told to say.
function standIn(directory, name, body) {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

// A PATH holding the tools the script needs and nothing else, less the ones named: how a check asks
// what happens on a machine without one of them.
function pathWithout(...missing) {
  const toolbox = path.join(here, `toolbox-without-${missing.join("-") || "nothing"}`);
  fs.mkdirSync(toolbox, { recursive: true });
  for (const name of ["sh", "uname", "grep", "curl", "wget", "tar", "mkdir", "rm", "mv", "chmod", "ln", "sed", "head", "cat", "dirname", "gzip"]) {
    if (missing.includes(name)) continue;
    const found = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
    if (found !== "") fs.symlinkSync(found, path.join(toolbox, name));
  }
  return toolbox;
}

// A tag archive the way GitHub serves one: everything under one directory named for the tag,
// which is why the script strips one level off. The installer inside is a stub that says where it
// is and what it was handed, one argument per line, so a check reads the exact argument list.
function anArchive(version, { installer = true } = {}) {
  const stage = path.join(here, "stage", version);
  const tree = path.join(stage, `openovai-${version}`);
  fs.mkdirSync(path.join(tree, "lib"), { recursive: true });
  fs.writeFileSync(path.join(tree, "lib", "VERSION"), `${version}\n`);
  if (installer) {
    standIn(tree, "install.sh", 'printf \'stub install.sh in %s\\n\' "$(cd -- "$(dirname -- "$0")" && pwd -P)"\nfor one in "$@"; do printf \'arg: %s\\n\' "${one}"; done');
  }
  const made = spawnSync("tar", ["-czf", "-", "-C", stage, `openovai-${version}`], { maxBuffer: 16 * 1024 * 1024 });
  assert.equal(made.status, 0, String(made.stderr));
  return made.stdout;
}

// The fixture on a port, counting what was asked of it. `latest` is what releases/latest redirects
// to; `self` is what /openovai serves — the script's own text unless a check says otherwise.
function serve({ latest = `/releases/tag/v${LATEST}`, self = fs.readFileSync(script) } = {}) {
  const archives = { [LATEST]: anArchive(LATEST), [OLDER]: anArchive(OLDER), [BARE]: anArchive(BARE, { installer: false }) };
  const asked = [];
  const server = http.createServer((request, response) => {
    asked.push(request.url);
    const base = `http://127.0.0.1:${server.address().port}`;
    if (request.url === "/releases/latest") {
      if (latest === null) {
        response.writeHead(200, { "content-type": "text/html" }).end("<html>a page, not a redirect</html>");
        return;
      }
      response.writeHead(302, { location: `${base}${latest}` }).end();
      return;
    }
    if (request.url === "/openovai") {
      response.writeHead(200).end(self);
      return;
    }
    const tag = /^\/archive\/refs\/tags\/v(\d+\.\d+\.\d+)\.tar\.gz$/.exec(request.url);
    if (tag !== null && archives[tag[1]] !== undefined) {
      response.writeHead(200, { "content-type": "application/gzip" }).end(archives[tag[1]]);
      return;
    }
    response.writeHead(404).end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${server.address().port}`, asked, close: () => server.close() }));
  });
}

// A home of its own for one check: nothing under it yet, and the paths the script will use.
function aHome(name) {
  const home = path.join(here, "homes", name);
  fs.mkdirSync(home, { recursive: true });
  const data = path.join(home, ".local", "share", "openovai");
  return { home, data, bin: path.join(home, ".local", "bin"), releases: path.join(data, "releases") };
}

// The command as a user runs it: from its place, with a home of its own, everything else as given.
// Not spawnSync: what it fetches from is served by this very process, and a blocked event loop
// answers no request. `input` is what it reads from stdin, which is a pipe unless a check says
// otherwise; `command` is what to run when it is not the script itself.
function run(argv, { home, url, env = {}, input = "", command = script, stdinIsFile = false }) {
  return new Promise((resolve) => {
    const child = spawn(command, argv, {
      env: { PATH: process.env.PATH, HOME: home, OPENOVAI_RELEASES: url, ...env },
      stdio: [stdinIsFile ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (out += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (err += chunk));
    child.on("close", (status) => resolve({ status, out: out.trim(), err: err.trim(), lines: out.trim().split("\n") }));
    if (!stdinIsFile) child.stdin.end(input);
  });
}

// The script read from a pipe by a shell, the way `curl … | sh` runs it. The shell is a command
// line, since busybox's is `busybox sh`.
function piped(shell, { home, url, env = {} }) {
  const [command, ...argv] = shell.split(" ");
  return run(argv, { home, url, env, command, input: fs.readFileSync(script, "utf8") });
}

// What the stub installer said it was handed, in order.
function handed(said) {
  return said.lines.filter((line) => line.startsWith("arg: ")).map((line) => line.slice("arg: ".length));
}

// Whether a terminal can be made here. `script` from util-linux runs a command on a pty of its own;
// the checks about what happens on a terminal say they were skipped without it.
const canMakeATerminal = spawnSync("script", ["--version"], { encoding: "utf8" }).status === 0;

// A command run on a terminal, told `input` on it.
function onATerminal(commandLine, { home, url, input }) {
  return run(["-qec", commandLine, "/dev/null"], { home, url, command: "script", input });
}

describe("run from its place", () => {
  let served;

  before(async () => {
    served = await serve();
  });

  after(() => served.close());

  it("takes the version as the first argument, and asks nothing about the latest", async () => {
    const { home, releases } = aHome("first-argument");
    const said = await run([OLDER], { home, url: served.url });
    assert.equal(said.status, 0, said.err);
    assert.deepEqual(said.lines, [
      `openovai ${OLDER}`,
      `Fetching release ${OLDER} from ${served.url}/archive/refs/tags/v${OLDER}.tar.gz into ${releases}/${OLDER}`,
      `Release ${OLDER} in ${releases}/${OLDER}`,
      `Handing over to ${releases}/${OLDER}/install.sh`,
      `stub install.sh in ${releases}/${OLDER}`,
      "arg: --source",
      `arg: ${releases}/${OLDER}`,
    ]);
    assert.deepEqual(served.asked.filter((one) => one === "/releases/latest"), []);
  });

  it("takes the version after --version", async () => {
    const { home, releases } = aHome("version-option");
    const said = await run(["--version", OLDER], { home, url: served.url });
    assert.equal(said.status, 0, said.err);
    assert.equal(said.lines[0], `openovai ${OLDER}`);
    assert.deepEqual(handed(said), ["--source", `${releases}/${OLDER}`]);
  });

  it("refuses --version without a version like 1.2.3", async () => {
    const { home } = aHome("version-option-short");
    for (const argv of [["--version"], ["--version", "1.2"], ["--version", "latest"]]) {
      const said = await run(argv, { home, url: served.url });
      assert.equal(said.status, 1, argv.join(" "));
      assert.equal(said.err, "openovai: --version takes a version like 1.2.3");
      assert.equal(said.out, "", "nothing was said before the refusal");
    }
  });

  it("takes the newest release from where releases/latest redirects, and says so first", async () => {
    const { home, releases } = aHome("latest");
    const before = served.asked.length;
    const said = await run([], { home, url: served.url });
    assert.equal(said.status, 0, said.err);
    assert.equal(said.lines[0], `openovai ${LATEST} (latest)`);
    assert.deepEqual(served.asked.slice(before), ["/releases/latest", `/archive/refs/tags/v${LATEST}.tar.gz`]);
    assert.deepEqual(handed(said), ["--source", `${releases}/${LATEST}`]);
  });

  it("resolves the latest through wget when there is no curl", async () => {
    const { home } = aHome("latest-wget");
    const said = await run([], { home, url: served.url, env: { PATH: pathWithout("curl") } });
    assert.equal(said.status, 0, said.err);
    assert.equal(said.lines[0], `openovai ${LATEST} (latest)`);
  });

  it("refuses a releases/latest that does not redirect to a tag", async () => {
    const page = await serve({ latest: null });
    try {
      const { home } = aHome("latest-page");
      const said = await run([], { home, url: page.url });
      assert.equal(said.status, 1);
      assert.equal(said.err, `openovai: could not tell the latest release from ${page.url}/releases/latest: it did not redirect to a tag like v1.2.3`);
      assert.equal(said.out, "");
    } finally {
      page.close();
    }
  });

  it("fetches a release once and reuses it", async () => {
    const { home, releases } = aHome("reuse");
    assert.equal((await run([OLDER], { home, url: served.url })).status, 0);
    const before = served.asked.length;
    const said = await run([OLDER], { home, url: served.url });
    assert.equal(said.status, 0, said.err);
    assert.equal(said.lines[1], `Release ${OLDER} already in ${releases}/${OLDER}`);
    assert.equal(served.asked.length, before, "nothing was asked of the server");
    assert.deepEqual(fs.readdirSync(path.join(releases, "..", "tmp")), []);
  });

  it("passes every other argument through unchanged", async () => {
    const { home, releases } = aHome("pass-through");
    const rest = ["--root", "/somewhere/with a space", "", "--yes", "--version", "not-ours-any-more"];
    const said = await run([OLDER, ...rest], { home, url: served.url });
    assert.equal(said.status, 0, said.err);
    assert.deepEqual(handed(said), ["--source", `${releases}/${OLDER}`, ...rest]);
  });

  it("hands the installer its own release directory as --source", async () => {
    const { home, releases } = aHome("source");
    const said = await run([OLDER, "--root", "/somewhere"], { home, url: served.url });
    assert.equal(said.status, 0, said.err);
    assert.ok(said.lines.includes(`stub install.sh in ${releases}/${OLDER}`), said.out);
    assert.deepEqual(handed(said).slice(0, 2), ["--source", `${releases}/${OLDER}`]);
  });

  it("refuses a release without install.sh, and leaves nothing behind", async () => {
    const { home, releases, data } = aHome("bare");
    const said = await run([BARE], { home, url: served.url });
    assert.equal(said.status, 1);
    assert.equal(said.err, `openovai: release ${BARE} has no install.sh; there is nothing to hand over to`);
    assert.equal(fs.existsSync(path.join(releases, BARE)), false, "nothing at the release's place");
    assert.deepEqual(fs.readdirSync(path.join(data, "tmp")), []);
  });

  it("refuses a download that fails, in one line", async () => {
    const { home } = aHome("missing");
    const said = await run(["1.2.3"], { home, url: served.url });
    assert.equal(said.status, 1);
    assert.equal(said.err, `openovai: could not download ${served.url}/archive/refs/tags/v1.2.3.tar.gz`);
  });

  it("refuses a release directory that is there without install.sh", async () => {
    const { home, releases } = aHome("broken");
    fs.mkdirSync(path.join(releases, "9.9.6"), { recursive: true });
    const said = await run(["9.9.6"], { home, url: served.url });
    assert.equal(said.status, 1);
    assert.equal(said.err, `openovai: ${releases}/9.9.6 is there but has no install.sh; remove the directory and run this again`);
  });

  it("refuses anything but Linux in one line", async () => {
    const { home } = aHome("not-linux");
    const fake = path.join(here, "not-linux");
    standIn(fake, "uname", "echo Darwin");
    const said = await run([OLDER], { home, url: served.url, env: { PATH: `${fake}:${process.env.PATH}` } });
    assert.equal(said.status, 1);
    assert.equal(said.err, "openovai: only Linux is supported, and this is Darwin");
  });

  it("refuses to run without tar", async () => {
    const { home } = aHome("no-tar");
    const said = await run([OLDER], { home, url: served.url, env: { PATH: pathWithout("tar") } });
    assert.equal(said.status, 1);
    assert.equal(said.err, "openovai: tar is required to unpack a release, and it is not on your PATH");
  });

  it("refuses to run without curl or wget", async () => {
    const { home } = aHome("no-curl");
    const said = await run([OLDER], { home, url: served.url, env: { PATH: pathWithout("curl", "wget") } });
    assert.equal(said.status, 1);
    assert.equal(said.err, "openovai: curl or wget is required to download a release, and neither is on your PATH");
  });

  it("asks which version when nothing was said and there is a terminal to ask on", { skip: !canMakeATerminal && "no `script` to make a terminal with" }, async () => {
    const { home, releases } = aHome("asked");
    assert.equal((await run([LATEST], { home, url: served.url })).status, 0);
    const said = await onATerminal(script, { home, url: served.url, input: `${OLDER}\n` });
    assert.equal(said.status, 0, said.err);
    assert.match(said.out, new RegExp(`Which version\\? latest ${LATEST} \\[latest\\]:`));
    assert.match(said.out, new RegExp(`openovai ${OLDER}\\r?\\n`));
    assert.deepEqual(handed(said).map((one) => one.replace(/\r$/, "")), ["--source", `${releases}/${OLDER}`]);
  });

  it("takes an empty answer as the latest", { skip: !canMakeATerminal && "no `script` to make a terminal with" }, async () => {
    const { home } = aHome("asked-nothing");
    const said = await onATerminal(script, { home, url: served.url, input: "\n" });
    assert.equal(said.status, 0, said.err);
    assert.match(said.out, new RegExp(`openovai ${LATEST} \\(latest\\)`));
  });

  it("asks nothing when there is no terminal, or when anything was said", async () => {
    const { home } = aHome("not-asked");
    const quiet = await run([], { home, url: served.url, stdinIsFile: true });
    assert.equal(quiet.status, 0, quiet.err);
    assert.equal(quiet.lines[0], `openovai ${LATEST} (latest)`);
    assert.equal(quiet.err, "", "no question was asked");
    const told = await run(["--root", "/somewhere"], { home, url: served.url });
    assert.equal(told.status, 0, told.err);
    assert.deepEqual(handed(told).slice(2), ["--root", "/somewhere"]);
  });
});

describe("read from a pipe", () => {
  let served;

  before(async () => {
    served = await serve();
  });

  after(() => served.close());

  // The shells a user's `sh` may be, of those on this machine.
  const shells = ["sh", "dash", "bash", "busybox sh"].filter((one) => spawnSync("sh", ["-c", `command -v ${one.split(" ")[0]}`]).status === 0);

  it("installs itself, links it into ~/.local/bin, and says how to put that on the PATH", async () => {
    const { home, data, bin } = aHome("self");
    const profile = path.join(home, ".profile");
    fs.writeFileSync(profile, "# untouched\n");
    const said = await piped("sh", { home, url: served.url });
    assert.equal(said.status, 0, said.err);
    assert.deepEqual(said.lines, [
      `Installed openovai at ${data}/openovai`,
      `Linked ${bin}/openovai`,
      `${bin} is not on your PATH. Add this line to your shell profile (~/.profile, ~/.bashrc or ~/.zshrc), then open a new terminal:`,
      '  export PATH="$HOME/.local/bin:$PATH"',
      "Then run: openovai",
    ]);
    assert.equal(fs.readFileSync(path.join(data, "openovai"), "utf8"), fs.readFileSync(script, "utf8"), "the copy is this script");
    assert.equal(fs.statSync(path.join(data, "openovai")).mode & 0o777, 0o755);
    assert.equal(fs.readlinkSync(path.join(bin, "openovai")), path.join(data, "openovai"));
    assert.equal(fs.readFileSync(profile, "utf8"), "# untouched\n", "no profile was edited");
    assert.deepEqual(fs.readdirSync(home).sort(), [".local", ".profile"]);
  });

  it("runs from its place once installed", async () => {
    const { home, bin, releases } = aHome("self-then-run");
    assert.equal((await piped("sh", { home, url: served.url })).status, 0);
    const said = await run([OLDER], { home, url: served.url, command: path.join(bin, "openovai") });
    assert.equal(said.status, 0, said.err);
    assert.equal(said.lines[0], `openovai ${OLDER}`);
    assert.deepEqual(handed(said), ["--source", `${releases}/${OLDER}`]);
  });

  it("says nothing about the PATH when ~/.local/bin is on it", async () => {
    const { home, bin } = aHome("self-on-path");
    const said = await piped("sh", { home, url: served.url, env: { PATH: `${bin}:${process.env.PATH}` } });
    assert.equal(said.status, 0, said.err);
    assert.equal(said.lines.at(-1), "Now run: openovai");
    assert.doesNotMatch(said.out, /export PATH/);
  });

  it("installs itself through every sh on this machine alike", async () => {
    assert.ok(shells.length > 0, "no shell to pipe through");
    for (const shell of shells) {
      const { home, data } = aHome(`self-${shell}`);
      const said = await piped(shell, { home, url: served.url });
      assert.equal(said.status, 0, `${shell}: ${said.err}`);
      assert.equal(fs.readFileSync(path.join(data, "openovai"), "utf8"), fs.readFileSync(script, "utf8"), `${shell}: the copy is this script`);
    }
  });

  it("keeps the copy under $XDG_DATA_HOME when the variable is set", async () => {
    const { home, bin } = aHome("self-xdg");
    const xdg = path.join(here, "self-xdg-data");
    const said = await piped("sh", { home, url: served.url, env: { XDG_DATA_HOME: xdg } });
    assert.equal(said.status, 0, said.err);
    assert.equal(said.lines[0], `Installed openovai at ${xdg}/openovai/openovai`);
    assert.equal(fs.readlinkSync(path.join(bin, "openovai")), path.join(xdg, "openovai", "openovai"));
  });

  it("refuses a copy that is not this script, and installs nothing", async () => {
    const page = await serve({ self: "<html>not found</html>" });
    try {
      const { home, data, bin } = aHome("self-page");
      const said = await piped("sh", { home, url: page.url });
      assert.equal(said.status, 1);
      assert.equal(said.err, `openovai: what ${page.url}/openovai served is not the openovai command`);
      assert.equal(fs.existsSync(path.join(data, "openovai")), false);
      assert.equal(fs.existsSync(path.join(bin, "openovai")), false);
      assert.deepEqual(fs.readdirSync(data), []);
    } finally {
      page.close();
    }
  });

  it("refuses a terminal with no script at $0, in one line", { skip: !canMakeATerminal && "no `script` to make a terminal with" }, async () => {
    const { home, data } = aHome("self-terminal");
    const said = await onATerminal(`sh -c "$(cat ${script})"`, { home, url: served.url, input: "" });
    assert.equal(said.status, 1);
    // A terminal has one stream: what the script refused with is in the output the pty carried.
    assert.match(said.out, new RegExp(`^openovai: run this from a pipe \\(curl -fsSL ${served.url}/openovai \\| sh\\) or from where it is installed`));
    assert.equal(fs.existsSync(data), false);
  });
});
