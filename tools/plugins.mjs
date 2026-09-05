// Tools an instance serves that the toolkit did not ship.
//
// The chat already serves a session a handful of tools of its own, and what they are is decided
// in the repository. That is right for the ones every instance wants and wrong for the ones only
// one instance wants: a workspace whose person is not at the page needs something that pops on
// their desktop, and how a desktop is made to pop is `notify-send` here, `osascript` there and a
// toast API somewhere else. None of that can ship in a toolkit that installs on machines it knows
// nothing about, so it has to be written where the machine is known — beside the instance.
//
// A file is the whole of it. One file is one tool and its name is the tool's name, so two files
// cannot claim one name and nothing has to be registered, listed or kept in step with anything:
// the directory IS the list, the same way a directory under work/ is a person. Renaming a tool is
// renaming its file, which is the honest way round — a name that lived in a field could disagree
// with the file holding it and nothing could say which of the two was right.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Where an instance keeps them. At the root beside work/ and personas/, and deliberately NOT
// under tools/: taking a newer version of the toolkit removes every payload directory before it
// copies the new one in, so a tool kept in there would be deleted by the first update, silently,
// because the update reports what it replaced and not what it took away.
//
// Not under work/ either, and for a sharper reason: that directory listing IS the roster, so a
// directory in it is a person. Plugins live where they cannot be mistaken for one.
export const PLUGINS = "plugins";

// What a file has to be called to be one. The extension is the module it is; the name is the tool.
const SUFFIX = ".mjs";

export function pluginsDirectory(root) {
  return path.join(root, PLUGINS);
}

// Every tool this instance serves itself, in the shape the chat's own tools are in — name,
// description, inputSchema, run — so that what reaches a session is one list and nothing in it
// says where it came from.
//
// Read once, by whoever is about to serve. Not per request: a module is imported once per process,
// so a directory read on every call would show a NEW file and go on serving the old code of a
// CHANGED one, and nobody looking at it could tell which of the two they had. Once is a rule
// somebody can hold in their head — a plugin is picked up when the chat is started, which is the
// act that already replaces everything else the chat is running.
//
// An instance with no such directory has no such tools, which is most of them.
export async function pluginsIn(root) {
  const directory = pluginsDirectory(root);

  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const served = [];
  for (const entry of entries.filter(isPlugin).sort(byName)) {
    const written = await import(pathToFileURL(path.join(directory, entry.name)).href);
    served.push({
      name: entry.name.slice(0, -SUFFIX.length),
      description: written.description,
      inputSchema: written.inputSchema,
      run: written.run,
    });
  }
  return served;
}

// What a plugin answered, in the two shapes the chat knows how to pass on, or a refusal saying it
// answered in neither.
//
// A tool answers { text } or { refused } and there is no third thing. A handler that forgets to
// return answers with nothing at all, and nothing at all reaches the model as a tool call that
// came back empty — no words, no failure, nothing to act on, which is the one answer a model
// cannot do anything with. It is the first mistake anybody writing one of these makes, so it is
// answered here rather than left to arrive as silence, and the sentence names the plugin because
// the person who has to fix it is the person who wrote that file.
//
// A refusal, not a throw: the call arrived and was understood, and what is wrong is the plugin
// rather than the request.
export function answerFrom(name, given) {
  if (typeof given?.refused === "string") {
    return { refused: given.refused };
  }
  if (typeof given?.text === "string") {
    return { text: given.text };
  }
  return {
    refused: `${name} answered with nothing that can be passed on: a tool of this instance answers { text } or { refused }, and this one answered ${describe(given)}`,
  };
}

// What it answered instead, short enough to read in a sentence. The shape is what the person
// fixing it needs; the contents are theirs and could be anything at all.
function describe(given) {
  if (given === undefined || given === null) {
    return String(given);
  }
  return typeof given === "object" ? `an object with ${Object.keys(given).join(", ") || "nothing"} in it` : typeof given;
}

// A file, named the way a tool is named. A directory in there is not a tool with parts; anything
// that is not a module is not a module, and notes somebody left beside their plugin are notes.
function isPlugin(entry) {
  return entry.isFile() && entry.name.endsWith(SUFFIX) && entry.name.length > SUFFIX.length;
}

// In the order a person would list them, rather than the order the filesystem happens to give
// them, so that what the chat says it is serving reads the same on two machines.
function byName(one, other) {
  return one.name.localeCompare(other.name);
}
