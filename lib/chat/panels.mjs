// What the page shows, decided here and drawn in page.html: which panels there are and where,
// what each one's head says, whether its composer and its stop glyph take input, what the tab
// title carries. Pure: a state in, a state out, no document — so the same code runs under node
// for the checks and in the browser for the page.
//
// A panel is a process (target 3.1). A Worker's panel appears when its process is started and
// goes when its process is gone — dimmed first, and removed after a short while, so a process
// replaced within seconds and a process that died look the same and neither needs a word. The
// Leader's panel is always there: the next thing typed to it starts it. Nothing here reads why
// a process is going: the page carries no word for the life of a session.

export const PRODUCT = "OpenOv AI";

// How the page stands to the server: on its stream, or without one — the server stopping, gone,
// or not yet reached again. A server that said it is stopping is as good as gone: nothing is
// typed into it from then on, and the page says so the one way it says it.
export const CONNECTED = "connected";
export const DISCONNECTED = "disconnected";

// How long a Worker's panel is kept after its process closed, in milliseconds.
export const GONE_AFTER = 30_000;

// How long a word on the tool line stays up before the next one may replace it, in milliseconds,
// and how many words may wait their turn behind the one showing.
export const SHOWN_FOR = 500;
export const LINE_QUEUE = 3;

export function fresh() {
  return {
    leader: null,
    user: null,
    chat: null,
    // The instance's root as the title says it.
    instance: "",
    // The account's usage windows as the head says them, null until read.
    quota: null,
    // Names in the order their panels appeared on this page — a new panel never reshuffles the
    // panels the User is reading. A panel that goes leaves the order with it, so a Worker back
    // after a while is one panel, the newest, and not a name listed twice.
    order: [],
    panels: {},
    connection: CONNECTED,
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
    running: about.running === true,
    busy: about.busy === true,
    // What the seat is at, as the line shows it: the server's words, or null while there are none
    // — off a turn, and on every Worker. A page opened mid-turn shows the snapshot's word at once.
    doing: typeof about.doing === "string" ? about.doing : null,
    // When the word showing went up, and the words the server said since that have not had their
    // turn on the line yet, oldest first.
    doingSince: now,
    waiting: [],
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
  panel.busy = about.busy === true;
  panel.running = about.running === true;
  said(panel, typeof about.doing === "string" ? about.doing : null, now);
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

// A panel taken off the page, and its name out of the order with it.
function gone(state, name) {
  delete state.panels[name];
  state.order = state.order.filter((listed) => listed !== name);
}

// The tool line: what the seat is at, one word at a time, each up for SHOWN_FOR before the next
// replaces it — a call that took a few milliseconds is otherwise on the line for one frame, and
// the User sees that something was there between two "Thinking…" and cannot read what. The
// server's word queues behind the one showing; a word that repeats the newest one known — the
// last waiting, else the one showing — is nothing new and is not queued, so "Thinking…" said
// twice is one "Thinking…". The word for no line, null, queues like any other: the line drains
// at its pace once the turn is over and goes only then, since the Leader's calls are nowhere
// else on the panel. More than LINE_QUEUE words waiting drop the oldest: the newest say what the
// seat is at now, and the line never trails the seat by more than LINE_QUEUE times SHOWN_FOR.
function said(panel, word, now) {
  const newest = panel.waiting.length > 0 ? panel.waiting.at(-1) : panel.doing;
  if (word === newest) {
    return;
  }
  panel.waiting.push(word);
  if (panel.waiting.length > LINE_QUEUE) {
    panel.waiting.shift();
  }
  settle(panel, now);
}

// The next word goes up once the one showing has had its time; an empty line has nothing to
// read, so a word behind a null goes up at once. Answers when the next waiting word is due, or
// null while none waits.
function settle(panel, now) {
  while (panel.waiting.length > 0 && (panel.doing === null || now - panel.doingSince >= SHOWN_FOR)) {
    panel.doing = panel.waiting.shift();
    panel.doingSince = now;
  }
  return panel.waiting.length > 0 ? panel.doingSince + SHOWN_FOR : null;
}

// Every panel's line moved on as far as `now` allows. Answers the soonest moment a waiting word
// is due on any panel, for the page to come back at, or null while none waits anywhere.
export function advance(state, now = Date.now()) {
  let due = null;
  for (const panel of Object.values(state.panels)) {
    const at = settle(panel, now);
    if (at !== null && (due === null || at < due)) {
      due = at;
    }
  }
  return due;
}

// Whether a panel follows its newest row, decided at every tick of the page's timer. A hand that
// moved the rows away from the newest since the last tick — a wheel up, an up key, a finger, the
// bar dragged up — lets the panel go, wherever the rows stand now. Otherwise a panel at the newest
// follows, and one that follows keeps following: a tall row that lands and moves the bottom away
// is no word from the reader, and the page pins the newest back into view.
export function following(follow, atNewest, away) {
  if (away) return false;
  return follow || atNewest;
}

// One event from the stream, applied. Answers the state.
export function applyEvent(state, { name, data }, now = Date.now()) {
  switch (name) {
    case "snapshot": {
      state.leader = data.leader;
      state.user = data.user;
      state.chat = data.chat;
      state.instance = data.instance ?? "";
      state.quota = data.quota ?? null;
      const listed = new Set(data.sessions.map((about) => about.name));
      for (const about of data.sessions) {
        seen(state, about, now, { fromSnapshot: true });
      }
      for (const name of Object.keys(state.panels)) {
        if (!listed.has(name)) {
          gone(state, name);
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
    case "quota": {
      state.quota = data;
      break;
    }
    case "stopping": {
      state.connection = DISCONNECTED;
      break;
    }
    default:
      break;
  }
  return state;
}

// What an event is worth telling a reader who is not at the page, read against the state as it
// stands BEFORE the event is applied: a card that was not on its panel — a call stopped on a
// question, a rule to settle — on any panel, and the end of the Leader's turn, however it ended.
// Nothing else: a Worker's turn ends into the Leader's hands, and a row, a seat coming or going,
// a quota reading are a record, read when the reader reads it. Answers the seat and the kind, or
// null.
export const CARD = "card";
export const REPLY = "reply";

export function noticed(state, { name, data }) {
  const panel = state.panels[data?.seat ?? data?.name];
  if (panel === undefined) return null;
  if (name === "asking") {
    const shown = new Set(panel.asking.map((request) => request.id));
    return data.pending.some((request) => !shown.has(request.id)) ? { seat: panel.name, kind: CARD } : null;
  }
  if (name === "seat" && panel.name === state.leader && panel.busy && data.busy !== true) {
    return { seat: panel.name, kind: REPLY };
  }
  return null;
}

// A Worker's panel dimmed for GONE_AFTER is removed; the Leader's never is. Answers the names
// removed.
export function prune(state, now = Date.now()) {
  const removed = [];
  for (const panel of Object.values(state.panels)) {
    if (panel.name !== state.leader && panel.dimmed && panel.stoppedAt !== null && now - panel.stoppedAt >= GONE_AFTER) {
      gone(state, panel.name);
      removed.push(panel.name);
    }
  }
  return removed;
}

// ------------------------------------------------------------------------------------- controls

// Typing into a panel: not while the page has no server to take it, and not into a panel whose
// process is gone. The Leader's composer is never disabled on its own account.
export function composersEnabled(state, name) {
  const panel = state.panels[name];
  return panel !== undefined && state.connection === CONNECTED && !panel.dimmed;
}

// The stop glyph: while a turn is running, on a panel that takes input.
export function stopEnabled(state, name) {
  const panel = state.panels[name];
  return composersEnabled(state, name) && panel.busy;
}

// --------------------------------------------------------------------------------------- marks

// The state word on a head: what the session is doing — listening between turns, working while
// a turn runs, waiting for you while it asks — with how many questions, when more than one, so
// the head says what is waiting below before the reader scrolls to it. A dimmed panel gets no
// word, and neither does any panel while the page has no stream: the red dot is the mark, and
// the server that would know is not there to ask.
export const LISTENING = "listening";
export const WORKING = "working";
export const WAITING = "waiting for you";

export function stateWord(state, name) {
  const panel = state.panels[name];
  if (panel.dimmed || state.connection === DISCONNECTED) return "";
  if (asking(state, name)) return panel.asking.length > 1 ? `${WAITING} · ${panel.asking.length} prompts` : WAITING;
  return panel.busy ? WORKING : LISTENING;
}

// The dot before a name: red for a process that is gone and for every panel while the page has
// no stream, amber while a turn runs, green between turns.
export const RED = "red";
export const AMBER = "amber";
export const GREEN = "green";

export function dot(state, name) {
  const panel = state.panels[name];
  if (panel.dimmed || state.connection === DISCONNECTED) return RED;
  return panel.busy ? AMBER : GREEN;
}

export function asking(state, name) {
  const panel = state.panels[name];
  return panel !== undefined && panel.asking.length > 0;
}

// The tab title: the product and the instance, the same whatever is asking — the tab's icon
// carries that, so the title never moves.
export function title(state) {
  return [PRODUCT, state.instance].filter((part) => part !== "").join(" ");
}

// Whether any panel asks: what the tab's icon shows.
export function anyAsking(state) {
  return Object.keys(state.panels).some((name) => asking(state, name));
}

// The head of a panel, in parts: the name, the facts (the model, the context in k when known) and
// the state word.
export function head(state, name) {
  const panel = state.panels[name];
  const facts = [panel.model, panel.context === null ? "" : `${Math.round(panel.context / 1000)}k`];
  return { name: panel.name, info: facts.filter((fact) => fact !== "").join(" "), state: stateWord(state, name) };
}

// --------------------------------------------------------------------------------------- quota

// The account's usage windows on the Leader's head, one line: the session window and the time
// to its reset, then the weekly window over every model and the weekly window of the one model
// that has its own, each with its reset when the reading gave one. Nothing while there is no
// reading.
function windowSaid(label, percent, reset) {
  const named = label === "" ? percent : `${label} ${percent}`;
  return reset === null ? named : `${named} (${reset})`;
}

export function quotaLine(quota) {
  if (quota === null) return "";
  return [windowSaid("", quota.session, quota.reset), windowSaid("all", quota.all, quota.allReset), windowSaid("fable", quota.fable, quota.fableReset)].join(" · ");
}

// The same, spelled out, for the line's tooltip, with when the reading was taken.
export function quotaTitle(quota, when = (iso) => iso) {
  if (quota === null) return "";
  return `session ${quota.session}, resets in ${quota.reset} · all models ${quota.all}${quota.allReset === null ? "" : `, resets in ${quota.allReset}`} · Fable ${quota.fable}${quota.fableReset === null ? "" : `, resets in ${quota.fableReset}`}\nasked of the Anthropic usage API at ${when(quota.updated)}`;
}

// ---------------------------------------------------------------------------- the User's own row

// What the User's own row says of itself: delivered, beside its stamp, once the frame it became
// has gone into the process — the glyph alone where the stamp is the clock alone; until then
// waiting, beside its label — queued for the seat's next step when the seat is busy, sending
// otherwise. A waiting word is drawn as a wait. A row that waited says when it went in and how
// long after it was typed — `waited` is the clock of the write and the seconds between — since
// the stamp beside it is the time it was typed; a wait under LATE_AFTER seconds is not a wait.
export const SENDING = "sending…";
export const DELIVERED = "delivered ✓";
export const DELIVERED_GLYPH = "✓";
export const LATE_AFTER = 5;

export function delivery(delivered, busy, name, waited = null) {
  if (delivered) {
    if (waited !== null && waited.seconds >= LATE_AFTER) {
      return { text: `delivered ${waited.clock} ✓ — ${waited.seconds} s after`, glyph: DELIVERED_GLYPH, wait: false };
    }
    return { text: DELIVERED, glyph: DELIVERED_GLYPH, wait: false };
  }
  return { text: busy ? `queued — ${name} reads it at its next step` : SENDING, wait: true };
}

// ----------------------------------------------------------------------------------- references

// A click on a row's stamp points at that row from the composer: a short token goes into the box,
// `(ref:2026.09.14-14:39:14)` — the day and the clock of the stamp, the weekday dropped — and what
// is sent carries it spelled out, `(ref: 14:39:14 Paul — "the first line of the row…")`, since the
// session reading it has no page to look the token up on. `refs` is the panel's own table, token
// to spelling; two rows in one second get two tokens, the second and every later one numbered,
// rather than one token pointing at whichever came first. The token is answered, or null for a
// stamp with less than a day and a clock on it.
export function reference(refs, whole, who, text) {
  const parts = String(whole).trim().split(/\s+/);
  if (parts.length < 2) return null;
  const clock = parts.at(-1);
  const first = String(text).trim().split("\n")[0].replace(/\s+/g, " ");
  const spelled = `${clock} ${who} — "${first.slice(0, 80)}${first.length > 80 ? "…" : ""}"`;
  let token = `(ref:${parts[0]}-${clock})`;
  for (let n = 2; refs.has(token) && refs.get(token) !== spelled; n += 1) token = `(ref:${parts[0]}-${clock}#${n})`;
  refs.set(token, spelled);
  return token;
}

// What the User typed while the panel moved on carries what it was typed against: `anchor` is the
// last stamped row shown when the first key went into an empty box, `latest` the last one shown
// now, each `{ whole, who, text }`. When a row arrived in between, the text goes with the anchor's
// token in front — unless it points at that row already; otherwise it goes as it is.
export function typedAgainst(refs, anchor, latest, text) {
  if (anchor === null || anchor === latest) return text;
  const token = reference(refs, anchor.whole, anchor.who, anchor.text);
  if (token === null || String(text).includes(token)) return text;
  return `${token} ${text}`;
}

// The page tells the server a key went into a seat's box at most once in this many milliseconds:
// the typing hold counts from the last one it heard, so a beat well inside its quiet is enough.
export const TYPING_BEAT = 2000;

// Whether a key going into the box at `now` is told, the last one told having been at `last`
// (null for never).
export function typingBeat(last, now) {
  return last === null || now - last >= TYPING_BEAT;
}

// What is typed, with every token the table knows spelled out; one it does not know — typed by
// hand, or left from a page since reloaded — goes as it is.
export function spellReferences(refs, text) {
  return String(text).replace(/\(ref:[^)]*\)/g, (token) => (refs.has(token) ? `(ref: ${refs.get(token)})` : token));
}
