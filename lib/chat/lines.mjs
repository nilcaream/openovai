// What a tool call is drawn as on a Worker's panel: one short line, composed from the call's own
// input — a path, a pattern, a description — and never from its result. Pure, like render.mjs:
// a name and an input in, a sentence or null out, so the checks read the words without a server.
//
// Null is a call the panel says nothing about: a search of the tool list is the harness at work,
// a message to another seat is recorded by the server itself with its outcome, and a stop or a
// restart of the session shows on the panel as a mark, never as words.

import os from "node:os";

const HOME = os.homedir();

// A path with the home directory written as a tilde; the one shortening a line gets.
function shortPath(value) {
  return typeof value === "string" ? value.replace(HOME, "~") : "?";
}

// The head of a text: whitespace collapsed, cut with an ellipsis at `most` characters.
function head(value, most) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > most ? `${text.slice(0, most - 1)}…` : text;
}

function hostOf(value) {
  try {
    return new URL(value).host;
  } catch {
    return head(value, 60);
  }
}

// The instance's own tools, as a session calls them: by what they do, never by their names.
function ownTool(tool, i) {
  switch (tool) {
    case "room":
      return "Looking around the room";
    case "write_desk":
      return "Writing the desk";
    case "message":
    case "restart_session":
    case "stop_session":
    case "park":
    case "hire":
    case "permission":
      return null;
  }
  return undefined;
}

export function line(name, input) {
  const i = input || {};
  switch (name) {
    case "Bash":
      return i.description ? head(i.description, 120) : head(i.command, 80);
    case "Read":
      return `Reading ${shortPath(i.file_path)}`;
    case "Write":
      return `Writing ${shortPath(i.file_path)}`;
    case "Edit":
      return `Editing ${shortPath(i.file_path)}`;
    case "NotebookEdit":
      return `Editing notebook ${shortPath(i.notebook_path)}`;
    case "Grep":
    case "Glob":
      return `Searching ${head(i.pattern, 60)}${i.path ? ` in ${shortPath(i.path)}` : ""}`;
    case "SendMessage":
      return `Writing a message to ${i.to || i.recipient || "?"}`;
    case "ListAgents":
      return "Looking around the room";
    case "Agent":
      return `Delegating: ${head(i.description, 100)}${i.subagent_type ? ` (${i.subagent_type})` : ""}`;
    case "TaskOutput":
      return "Checking a background task";
    case "TaskStop":
      return "Stopping a background task";
    case "Skill":
      return `Using skill ${i.skill || "?"}`;
    case "ToolSearch":
      return null;
    case "Monitor":
      return `Watching: ${head(i.description || i.command, 100)}`;
    case "ScheduleWakeup":
    case "CronCreate":
    case "CronList":
    case "CronDelete":
      return "Scheduling a wake-up";
    case "WebFetch":
      return `Fetching ${hostOf(i.url)}`;
    case "WebSearch":
      return `Searching the web: ${head(i.query, 80)}`;
    case "Artifact":
      return i.action && i.action !== "publish" ? `Artifact: ${i.action}` : "Publishing an artifact";
    case "AskUserQuestion":
      return `Asking: ${head(i.questions?.[0]?.question, 140)}`;
    case "EnterPlanMode":
      return "Planning";
    case "ExitPlanMode":
      return "Plan ready";
    case "EndConversation":
      return "Closing the conversation";
  }
  if (name.startsWith("mcp__")) {
    const [, server, tool] = name.split("__");
    const own = server === "openovai" ? ownTool(tool, i) : undefined;
    return own === undefined ? `Calling ${server}: ${tool}` : own;
  }
  return `Using ${name}`;
}
