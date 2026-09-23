// Where the toolkit's own Node.js and Claude Code are, for everything in lib/ that starts one.
//
// The versions come from lib/RUNTIME, the same file lib/runtime.sh reads before any node exists, and
// the places from the same rule it applies: the XDG data directory, one directory per exact version.
// Nothing here fetches anything — that is `runtime.sh ensure`, which bin/ovai runs first. This
// answers where, and `nodeCommand` and `claudeCommand` answer it only for a command that is there.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const RUNTIME_FILE = path.join("lib", "RUNTIME");

// The names the file pins, and nothing else: a line naming anything else is a mistake in the file.
const PINNED = ["node", "claude"];

const A_VERSION = /^\d+\.\d+\.\d+$/;

// Something is wrong with the pin file, or a runtime it pins is not where it should be. Nothing to
// do with the command line.
export class RuntimeError extends Error {}

// The exact versions pinned by the tree at ROOT: `{ node: "24.21.0", claude: "2.1.280" }`.
//
// One name and one version per line, `#` lines are notes. Every pinned name has to be there exactly
// once with a version like 1.2.3, because these go into a URL and a directory name and a loose
// reading here would be a strange path somewhere else.
export function pins(root) {
  const file = path.join(root, RUNTIME_FILE);
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new RuntimeError(`${file} is missing, so there is no runtime version to read`);
    }
    throw error;
  }

  const found = {};
  for (const line of text.split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    const [name, version, ...more] = line.split(" ");
    if (!PINNED.includes(name) || more.length > 0 || !A_VERSION.test(version ?? "")) {
      throw new RuntimeError(`${file} has a line that is not "<${PINNED.join("|")}> <version like 1.2.3>": ${JSON.stringify(line)}`);
    }
    if (found[name] !== undefined) {
      throw new RuntimeError(`${file} pins ${name} twice`);
    }
    found[name] = version;
  }
  for (const name of PINNED) {
    if (found[name] === undefined) {
      throw new RuntimeError(`${file} does not pin ${name}`);
    }
  }
  return found;
}

// Where the runtimes live: $XDG_DATA_HOME/openovai, and ~/.local/share/openovai when the variable
// is unset or empty, as the XDG Base Directory spec reads it. Data rather than config, because
// nothing in it is anybody's setting.
export function dataDirectory(env = process.env) {
  const base = env.XDG_DATA_HOME !== undefined && env.XDG_DATA_HOME !== "" ? env.XDG_DATA_HOME : path.join(os.homedir(), ".local", "share");
  return path.join(base, "openovai");
}

// The absolute paths the tree at ROOT runs on: the node binary, the npm that came with it, the
// claude command, and the data directory they are all under.
export function runtimePaths(root, env = process.env) {
  const pinned = pins(root);
  const data = dataDirectory(env);
  const node = path.join(data, "node", pinned.node);
  const claude = path.join(data, "claude", pinned.claude);
  return {
    data,
    node: path.join(node, "bin", "node"),
    npm: path.join(node, "bin", "npm"),
    claude: path.join(claude, "bin", "claude"),
  };
}

// The node this tree runs on, and the claude command its sessions are: each the absolute path, and
// each refused in one sentence when nothing runnable is there. Every start of either goes through
// one of these two, so a runtime that was never fetched is said once, with what fetches it, and
// never as a bare ENOENT from the middle of a spawn.
export function nodeCommand(root, env = process.env) {
  return there(runtimePaths(root, env).node, `Node.js ${pins(root).node}`, root);
}

export function claudeCommand(root, env = process.env) {
  return there(runtimePaths(root, env).claude, `Claude Code ${pins(root).claude}`, root);
}

function there(command, what, root) {
  try {
    fs.accessSync(command, fs.constants.X_OK);
  } catch {
    throw new RuntimeError(
      `${what} is not at ${command}: run ${path.join(root, "bin", "ovai")} start, which fetches it, or: sh ${path.join(root, "lib", "runtime.sh")} ensure`,
    );
  }
  return command;
}

// One line for a person: what this tree runs on and where it is kept.
export function describeRuntime(root, env = process.env) {
  const pinned = pins(root);
  return `node ${pinned.node}, claude ${pinned.claude}, under ${dataDirectory(env)}`;
}
