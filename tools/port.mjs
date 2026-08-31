// Finding out what is holding a port.
//
// Only ever used to make a refusal to start more useful. "Port 7910 is already taken" leaves
// somebody hunting; naming the process turns it into one command. Everything here is
// best-effort by design: it answers null rather than throwing, and the caller says less when
// it does.

import fs from "node:fs";
import path from "node:path";

// Where Linux lists listening sockets. Both families, because whatever is holding the port
// might be bound to the IPv6 wildcard rather than to 127.0.0.1.
const SOCKET_TABLES = ["/proc/net/tcp", "/proc/net/tcp6"];

// The state a socket is in when it is listening, as /proc spells it.
const LISTENING = "0A";

// Command lines can run to a paragraph. This is a hint, not a record.
const LONGEST_COMMAND = 120;

// The inode of every listening socket on this port. A port can have more than one — one per
// address family, or per address — and any of them will do to name the process.
function listeningInodes(port) {
  const inodes = [];

  for (const table of SOCKET_TABLES) {
    let text;
    try {
      text = fs.readFileSync(table, "utf8");
    } catch {
      continue;
    }

    for (const line of text.split("\n").slice(1)) {
      const columns = line.trim().split(/\s+/);
      if (columns.length < 10 || columns[3] !== LISTENING) {
        continue;
      }
      // "0100007F:1EE6" — the address, then the port, in hexadecimal.
      const [, hexPort] = columns[1].split(":");
      if (Number.parseInt(hexPort, 16) === port) {
        inodes.push(columns[9]);
      }
    }
  }

  return inodes;
}

// The process holding one of those sockets. Found by looking for the socket among everything
// every process has open, which only works for processes this user owns — another user's
// /proc/<pid>/fd is not readable, and that is the case where we simply say less.
function processHolding(inodes) {
  const wanted = new Set(inodes.map((inode) => `socket:[${inode}]`));

  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }

    let handles;
    try {
      handles = fs.readdirSync(path.join("/proc", entry, "fd"));
    } catch {
      continue;
    }

    for (const handle of handles) {
      let target;
      try {
        target = fs.readlinkSync(path.join("/proc", entry, "fd", handle));
      } catch {
        continue;
      }
      if (wanted.has(target)) {
        return entry;
      }
    }
  }

  return null;
}

function commandOf(pid) {
  let raw;
  try {
    raw = fs.readFileSync(path.join("/proc", pid, "cmdline"), "utf8");
  } catch {
    return null;
  }

  const command = raw.replaceAll("\0", " ").trim();
  if (command === "") {
    return null;
  }
  return command.length > LONGEST_COMMAND ? `${command.slice(0, LONGEST_COMMAND)}…` : command;
}

// `{ pid, command }` for whatever is listening on this port, or null when the machine cannot
// say — which is every machine without /proc, and any process belonging to somebody else.
export function holderOf(port) {
  let pid;
  try {
    const inodes = listeningInodes(port);
    if (inodes.length === 0) {
      return null;
    }
    pid = processHolding(inodes);
  } catch {
    return null;
  }

  if (pid === null || pid === undefined) {
    return null;
  }
  return { pid, command: commandOf(pid) };
}
