// What the page shows, decided here and drawn in page.html: which panels there are and where,
// what each one's head says, whether its composer and its STOP take input, what the tab title
// carries, what the status line reads. Pure: a state in, a state out, no document — so the same
// code runs under node for the checks and in the browser for the page.
//
// A panel is a process (target 3.1). A Worker's panel appears when its process is started and
// goes when its process is gone — dimmed first, and removed after a short while, so a process
// replaced within seconds and a process that died look the same and neither needs a word. The
// Leader's panel is always there: the next thing typed to it starts it. Nothing here reads why
// a process is going: the page carries no word for the life of a session.

export const PRODUCT = "OpenOv AI";
export const SHORT = "ovai";

// How long a Worker's panel is kept after its process closed, in milliseconds.
export const GONE_AFTER = 30_000;

export function fresh() {
  return {
    leader: null,
    user: null,
    chat: null,
    // Names in the order their panels appeared on this page — a new panel never reshuffles the
    // panels the User is reading.
    order: [],
    panels: {},
    standing: {},
    connection: "connected",
  };
}

// ------------------------------------------------------------------------------------ placement

// The Leader in the middle; the Workers alternate left, right, left in the order their panels
// appeared, so a panel keeps its side for the life of the page.
export function place(seats, leader, order) {
  const present = new Set(seats);
  const workers = order.filter((name) => name !== leader && present.has(name));
  const left = [];
  const right = [];
  workers.forEach((name, at) => (at % 2 === 0 ? left : right).push(name));
  return { left, mid: leader, right };
}

// ------------------------------------------------------------------------------------- the keys

// Enter sends, Shift+Enter is a newline; a key pressed while an input method is composing is
// the input method's.
export function keyAction({ key, shiftKey = false, isComposing = false }) {
  if (key !== "Enter" || isComposing) {
    return null;
  }
  return shiftKey ? "newline" : "send";
}

// --------------------------------------------------------------------------------------- events

function panelOf(state, about, now) {
  return {
    name: about.name,
    model: about.model ?? "",
    context: typeof about.context === "number" ? about.context : null,
    title: about.title ?? "",
    running: about.running === true,
    busy: about.busy === true,
    dimmed: false,
    stoppedAt: null,
    since: now,
    asking: [],
    // null until the page has this panel's history; a panel made from the snapshot gets its rows
    // on the same stream, a panel made from a later `seat` event asks for them.
    rows: null,
    // The indexes of rows the server wrote again after the page drew them — a tool line whose
    // call failed — for the page to mark, and to empty once it has.
    amended: [],
  };
}

// What a seat's `about` object changes on its panel: the facts in the head, and the dim when a
// Worker's process is gone. The panel is made when there is none and the process is running;
// the Leader's is made whether or not it is.
function seen(state, about, now, { fromSnapshot }) {
  const name = about.name;
  let panel = state.panels[name];
  if (panel === undefined) {
    if (about.running !== true && name !== state.leader) {
      return;
    }
    panel = panelOf(state, about, now);
    state.panels[name] = panel;
    state.order.push(name);
    if (fromSnapshot) {
      panel.rows = [];
    }
    return;
  }
  panel.model = about.model ?? panel.model;
  panel.context = typeof about.context === "number" ? about.context : panel.context;
  panel.title = about.title ?? panel.title;
  panel.busy = about.busy === true;
  panel.running = about.running === true;
  if (name === state.leader) {
    return;
  }
  if (panel.running) {
    panel.dimmed = false;
    panel.stoppedAt = null;
  } else if (!panel.dimmed) {
    panel.dimmed = true;
    panel.stoppedAt = now;
  }
}

// One event from the stream, applied. Answers the state.
export function applyEvent(state, { name, data }, now = Date.now()) {
  switch (name) {
    case "snapshot": {
      state.leader = data.leader;
      state.user = data.user;
      state.chat = data.chat;
      state.standing = data.standing ?? {};
      const listed = new Set(data.sessions.map((about) => about.name));
      for (const about of data.sessions) {
        seen(state, about, now, { fromSnapshot: true });
      }
      for (const name of Object.keys(state.panels)) {
        if (!listed.has(name)) {
          delete state.panels[name];
        }
      }
      break;
    }
    case "rows": {
      const panel = state.panels[data.seat];
      if (panel !== undefined) {
        panel.rows = [...(panel.rows ?? []).slice(0, data.since), ...data.rows];
      }
      break;
    }
    case "row": {
      const panel = state.panels[data.seat];
      if (panel === undefined || panel.rows === null) {
        break;
      }
      if (data.index === panel.rows.length) {
        panel.rows.push(data.row);
      } else if (data.index > panel.rows.length) {
        panel.rows = null;
      } else {
        // A row the server wrote again, at an index the page holds: it replaces the one there.
        panel.rows[data.index] = data.row;
        panel.amended.push(data.index);
      }
      break;
    }
    case "asking": {
      const panel = state.panels[data.seat];
      if (panel !== undefined) {
        panel.asking = data.pending;
      }
      break;
    }
    case "seat": {
      seen(state, data, now, { fromSnapshot: false });
      break;
    }
    case "standing": {
      state.standing = data;
      break;
    }
    case "stopping": {
      state.connection = "stopping";
      break;
    }
    default:
      break;
  }
  return state;
}

// A Worker's panel dimmed for GONE_AFTER is removed; the Leader's never is. Answers the names
// removed.
export function prune(state, now = Date.now()) {
  const removed = [];
  for (const panel of Object.values(state.panels)) {
    if (panel.name !== state.leader && panel.dimmed && panel.stoppedAt !== null && now - panel.stoppedAt >= GONE_AFTER) {
      delete state.panels[panel.name];
      removed.push(panel.name);
    }
  }
  return removed;
}

// ------------------------------------------------------------------------------------- controls

// Typing into a panel: not while the instance is stopping, and not into a panel whose process is
// gone. The Leader's composer is never disabled on its own account.
export function composersEnabled(state, name) {
  const panel = state.panels[name];
  return panel !== undefined && state.connection !== "stopping" && !panel.dimmed;
}

// STOP: while a turn is running, on a panel that takes input.
export function stopEnabled(state, name) {
  const panel = state.panels[name];
  return composersEnabled(state, name) && panel.busy;
}

// --------------------------------------------------------------------------------------- marks

// The state word on a head: what the session is doing — listening between turns, working while
// a turn runs, waiting for you while it asks. A dimmed panel gets no word: the fade and the red
// dot are the mark.
export const LISTENING = "listening";
export const WORKING = "working";
export const WAITING = "waiting for you";

export function stateWord(state, name) {
  const panel = state.panels[name];
  if (panel.dimmed) return "";
  if (asking(state, name)) return WAITING;
  return panel.busy ? WORKING : LISTENING;
}

export function asking(state, name) {
  const panel = state.panels[name];
  return panel !== undefined && panel.asking.length > 0;
}

// The tab title carries the mark while any panel asks.
export function title(state) {
  const any = Object.keys(state.panels).some((name) => asking(state, name));
  return any ? `● ${SHORT}` : SHORT;
}

// The head of a panel, in parts: the name, the facts (the model, the context in k when known)
// and the state word.
export function head(state, name) {
  const panel = state.panels[name];
  const facts = [panel.model, panel.context === null ? "" : `${Math.round(panel.context / 1000)}k`];
  return { name: panel.name, info: facts.filter((fact) => fact !== "").join(" "), state: stateWord(state, name) };
}

// ---------------------------------------------------------------------------------- status line

function quotaSaid(standing) {
  const said = Object.entries(standing ?? {})
    .filter(([, reading]) => reading.stage === "warning" || reading.stage === "critical")
    .map(([window, reading]) => `${reading.key ?? window} ${reading.stage}${reading.resets ? `, resets ${reading.resets}` : ""}`);
  return said.length === 0 ? "ok" : said.join("; ");
}

// The instance facts, in parts, for the Leader's head: the product and its version, the instance
// (`ovai` prints the address only), the port, the quota with the worst stage any window is at,
// and how the page stands to the server.
export function statusParts(health, snapshot, connection) {
  const stages = Object.values(snapshot?.standing ?? {}).map((reading) => reading.stage);
  const stage = stages.includes("critical") ? "critical" : stages.includes("warning") ? "warning" : "ok";
  return {
    version: `${PRODUCT} ${health?.version ?? "?"}`,
    instance: health?.instance ?? "?",
    port: `port ${health?.port ?? "?"}`,
    quota: { text: `quota ${quotaSaid(snapshot?.standing)}`, stage },
    connection,
  };
}

// The same facts as one line, with the Leader named between the port and the quota.
export function statusLine(health, snapshot, connection) {
  const parts = statusParts(health, snapshot, connection);
  return [parts.version, parts.instance, parts.port, `Leader ${snapshot?.leader ?? "?"}`, parts.quota.text, parts.connection].join(" · ");
}
