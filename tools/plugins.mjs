// Tools an instance serves that the toolkit did not ship.
//
// The chat already serves a session a handful of tools of its own, and what they are is decided
// in the repository. That is right for the ones every instance wants and wrong for the ones only
// one instance wants: what such a tool has to reach — the tracker one team files its work in, the
// machine another one builds on, wherever a third keeps its notes — is different in every
// workspace. None of that can ship in a toolkit that installs on machines it knows nothing about,
// so it has to be written where the machine is known — beside the instance.
//
// Not the desktop popup, which is written beside the instance for the same reason and is NOT one of
// these. `pop.mjs` is called by the chat because something happened; a file in here is a tool a
// session chooses to call, and the popup being one would hand a lead a second way to reach the
// person. See tools/chat/pop.mjs.
//
// A file is the whole of it. One file is one tool and its name is the tool's name, so two files
// cannot claim one name and nothing has to be registered, listed or kept in step with anything:
// the directory IS the list, the same way a directory under work/ is a person. Renaming a tool is
// renaming its file, which is the honest way round — a name that lived in a field could disagree
// with the file holding it and nothing could say which of the two was right.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { readTemplate, render } from "./desks.mjs";

// Where an instance keeps them. At the root beside work/, and deliberately NOT
// under tools/: taking a newer version of the toolkit removes every payload directory before it
// copies the new one in, so a tool kept in there would be deleted by the first update, silently,
// because the update reports what it replaced and not what it took away.
//
// Not under work/ either, and for a sharper reason: that directory listing IS the roster, so a
// directory in it is a person. Plugins live where they cannot be mistaken for one.
export const PLUGINS = "plugins";

// What one looks like before a name is written into it. It lives in templates/ beside the desk and
// persona ones, so it travels with the payload and is replaced by an update — a scaffold is part of
// the toolkit, and a tool started from it is not.
export const PLUGIN_TEMPLATE = path.join("templates", "plugin.mjs");

// A tool of the instance's own could not be started. Nothing to do with the command line that
// asked for it, so it is answered on its own rather than with the usage under it.
export class PluginError extends Error {}

// What a file has to be called to be one. The extension is the module it is; the name is the tool.
const SUFFIX = ".mjs";

// And what is left once the extension is off. A letter, then letters, digits and hyphens, and
// short enough to read in a sentence. No underscore, and that is the whole reason the rule is
// written out rather than left to the filesystem: a permission rule for a single tool of a server
// is spelled mcp__<server>__<tool>, so a tool whose name held two of them would make a rule that
// named a different tool than the one somebody meant to allow.
const NAME = /^[A-Za-z][A-Za-z0-9-]{0,31}$/;

// The names the chat serves itself, which a file cannot take. They are checked before the module
// is read rather than after the list is built, so that a file called say.mjs is told it cannot be
// called that, instead of being appended to a list where the first say wins and the second is a
// tool that is there and never reached.
//
// It is written here and not beside those tools because the chat reads this file and not the other
// way round. The suite holds the two in step: it reads this list and asserts that what the chat
// serves a lead is exactly it, so a tool of the chat's own that nobody added here is a red suite.
export const BUILT_IN = ["say", "status", "room", "interrupt", "hire", "retire"];

// What every one of them has to export. A file missing any of these is not a tool that half works;
// it is a tool the chat would offer and then fail on, at whatever later moment somebody called it.
const EXPORTS = ["description", "inputSchema", "run"];

export function pluginsDirectory(root) {
  return path.join(root, PLUGINS);
}

// Every tool this instance serves itself, in the shape the chat's own tools are in — name,
// description, inputSchema, run — so that what reaches a session is one list and nothing in it
// says where it came from, and beside it every file that was meant to be one and is not.
//
// Both halves, because a plugin that cannot be served is not an error and not nothing. It is not
// an error: the chat starts anyway and goes on serving the rest, since a workspace where nobody
// can talk to anybody is a worse answer to a typo in one file than a workspace missing one tool.
// And it is not nothing: a tool that is silently absent is the failure this whole arrangement is
// most likely to produce, because the directory IS the list and a file that is in it looks served.
// So the reason travels back with the tools and is said out loud by whoever starts the chat.
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
    return { tools: [], refused: [] };
  }

  const tools = [];
  const refused = [];

  for (const entry of entries.filter(isPlugin).sort(byName)) {
    const name = entry.name.slice(0, -SUFFIX.length);

    // The two things that can be answered without reading the file, answered without reading it.
    if (!NAME.test(name)) {
      refused.push({ file: entry.name, reason: describePluginName(name) });
      continue;
    }
    if (BUILT_IN.includes(name)) {
      refused.push({ file: entry.name, reason: describeBuiltIn(name) });
      continue;
    }

    // And the file itself, which is somebody else's code and can do anything at all on the way in
    // — a syntax error, an import of something that is not installed, work at the top level that
    // throws. Caught here rather than left to end the chat, because the chat is what everybody
    // else in the workspace is using and one broken file is not a reason to take it away.
    let written;
    try {
      written = await import(pathToFileURL(path.join(directory, entry.name)).href);
    } catch (error) {
      refused.push({ file: entry.name, reason: `it could not be read: ${error.message}` });
      continue;
    }

    // A file that loads and is missing a part is worse than one that does not load, because it
    // would be offered: a session would read a tool with no description, or call one and be
    // answered by nothing. Refused now, whole, while the answer can still be a sentence.
    const missing = EXPORTS.filter((named) => written[named] === undefined);
    if (missing.length > 0) {
      refused.push({ file: entry.name, reason: `a tool is ${EXPORTS.join(", ")}, and this one exports no ${missing.join(" and no ")}` });
      continue;
    }

    tools.push({
      name,
      description: written.description,
      inputSchema: written.inputSchema,
      run: written.run,
    });
  }

  return { tools, refused };
}

// What the chat says about them where it was started. Nothing at all when the instance has none,
// which is most of them: a line saying no every time would be read once and never again.
//
// Both halves are said, and the refusals are said one to a line naming the file. A count would be
// cheaper to write and useless to read — the person who has to fix this wrote one of those files
// and needs to know which one and what was wrong with it, and they are looking at the terminal
// they started the chat in, which is the only place this can be said at all.
export function describePlugins({ tools, refused }) {
  const lines = [];
  if (tools.length > 0) {
    lines.push(`This instance serves ${tools.length === 1 ? "a tool" : `${tools.length} tools`} of its own: ${tools.map((tool) => tool.name).join(", ")}`);
  }
  for (const { file, reason } of refused) {
    lines.push(`${path.join(PLUGINS, file)} is not served: ${reason}`);
  }
  return lines.join("\n");
}

// The name rule, for whoever is about to write one of these rather than read it. The same test the
// loader makes, asked before the file exists, so that a name a tool cannot have is refused while
// somebody is still typing it instead of going quiet on the next chat start.
export function isPluginName(name) {
  return typeof name === "string" && NAME.test(name);
}

// Why it was refused, in the words somebody can act on. The rule is short enough to say outright,
// which is better than pointing at where it is written down.
export function describePluginName(name) {
  return `${name === undefined ? "nothing" : `"${name}"`} is not a name a tool can have — a letter, then letters, digits and hyphens, up to 32 of them`;
}

// And why a name the chat serves itself is refused, said once and read from both ends: the loader
// says it about a file it found, and the command says it about a name somebody typed. One sentence
// rather than two, because they are one fact, and two copies of a fact drift the first time either
// is reworded.
function describeBuiltIn(name) {
  return `${name} is already the name of a tool the chat serves everywhere, and a file cannot take it`;
}

// Start one. It writes the file and nothing else happens — no list gains an entry, because there
// is no list, and the chat picks it up the next time it is started.
//
// The template is read from the instance rather than from wherever the toolkit was installed from,
// the same way a desk template is, which is what lets an instance start a plugin on a machine the
// source was never on.
//
// A name whose file is already there is refused rather than written over. What is in that file is
// somebody's work, and a command that quietly replaces it to get its own job done is worse than
// the surprise it is saving them.
//
// A name the chat serves itself is refused too, and it is refused here rather than beside the
// character rule, because the two are refusals about different things. A name a tool cannot have
// is something wrong with what was typed — answered where a command line is answered, with the
// usage under it. A name that is taken is something true of the workspace: `say` is a name a tool
// can have, and what is in the way is that this chat already serves one. That is the refusal the
// file-is-already-there guard below makes, and this is the same refusal about a file that does not
// have to exist yet.
//
// It goes first, before that guard, because it is the one that cannot be got round. A file can be
// moved out of the way; the four names the chat serves cannot, so being told the file is not this
// command's to write over would send somebody to delete a file and be refused all over again.
//
// And it is asked while somebody is still typing the name, which is the difference that matters:
// the loader turns such a file away too, but not until the next chat start — minutes and a written
// handler after the moment the name could have been changed for nothing.
export function writePlugin(root, from, name) {
  const target = path.join(pluginsDirectory(root), `${name}${SUFFIX}`);
  if (BUILT_IN.includes(name)) {
    throw new PluginError(describeBuiltIn(name));
  }
  if (fs.existsSync(target)) {
    throw new PluginError(`${name} is already a tool here; ${path.relative(root, target)} is not this command's to write over`);
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, render("plugin", readTemplate(from, "plugin", PLUGIN_TEMPLATE), { NAME: name }));
  return [target];
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
