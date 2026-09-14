// Which instance a process belongs to, and what that instance says about itself. Shared by the
// command (ovai.mjs) and the server process (serve.mjs): both are handed `--root` by bin/ovai,
// which works it out from where it sits, so neither has to guess where it is running.

import fs from "node:fs";
import path from "node:path";

import { CONFIG_FILE } from "./seed.mjs";

// The process was not started as an instance's: no root, or a root that is not an instance.
export class InstanceError extends Error {}

export function readRoot(argv) {
  const at = argv.indexOf("--root");
  if (at === -1 || argv[at + 1] === undefined) {
    throw new InstanceError("--root is missing; run this instance's bin/ovai rather than the tool directly");
  }
  return { root: argv[at + 1], rest: [...argv.slice(0, at), ...argv.slice(at + 2)] };
}

// Where this instance keeps its description.
export function configFile(root) {
  return path.join(root, CONFIG_FILE);
}

export function readConfig(root) {
  const file = configFile(root);
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new InstanceError(`${file} is missing; this directory is not an instance`);
    }
    throw error;
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new InstanceError(`${file} is not readable as JSON: ${error.message}`);
  }
}
