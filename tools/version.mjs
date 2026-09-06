// What version of the toolkit an instance is on.
//
// It is a file in the payload rather than a field in openovai.json, and that is what makes taking a
// newer version need no migration of anything: the version travels with the code it names, so
// replacing the payload replaces it too and the two cannot disagree. There is no field to rewrite
// and nothing to look up.
//
// It could not have gone in openovai.json in any case. That file is the instance's description of
// itself and holds no path and no URL at all, deliberately, so that an instance can be moved and
// still be itself — and everything release-shaped is one or the other.

import fs from "node:fs";
import path from "node:path";

export const VERSION_FILE = "VERSION";

// The version the toolkit at `root` is: one line, trimmed. A file rather than a JSON field
// because it is read from a shell as often as from here, and there is nothing else it has to say.
//
// Nothing when there is no such file. An instance made before the toolkit carried a version is a
// real thing to be standing in front of, and `ovai status` is the command somebody runs when they
// are trying to work out what they have — it should answer that question rather than die of it.
export function version(root) {
  try {
    return fs.readFileSync(path.join(root, VERSION_FILE), "utf8").trim();
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
