// The page's stylesheet, read as rules: the token table per theme, no colour outside it, no token
// outside the table, a rule for every class the page emits, no rule for a class it never
// does, no selector on an attribute the script never sets, and no selector declared twice. The page is read as text
// and never run here, and the stylesheet is parsed rather than grepped, so a check is about a rule
// and its value rather than about a string being somewhere in the file. Every mutation in
// tests/mutations-page.json names the check it was written to redden.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { repo, styleRules } from "./helpers.mjs";
import { row } from "../lib/chat/render.mjs";

const source = fs.readFileSync(path.join(repo, "lib", "chat", "page.html"), "utf8");
// Two scripts: the head one that sets the theme before the first paint, and the page's own module.
const opened = source.indexOf('<script type="module">');
const script = source.slice(opened, source.indexOf("</script>", opened));
const rules = styleRules(source);
const tokens = JSON.parse(fs.readFileSync(path.join(repo, "tests", "page-tokens.json"), "utf8"));

// A token block is a rule that declares custom properties. The light one is bare :root; the dark
// one is the second, and sits under the theme attribute the page sets.
const isToken = (property) => property.startsWith("--");
const tokenBlocks = rules.filter((rule) => Object.keys(rule.declarations).some(isToken));
const only = (declarations, keep) => Object.fromEntries(Object.entries(declarations).filter(([property]) => keep(property)));

// The CSS named colours, so a `background: white` is as much a raw colour as a hex.
const NAMED = new Set(`aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet
brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan
darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon
darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey
dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey
honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral
lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue
lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine
mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred
midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid
palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple
red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray
slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow
yellowgreen`.split(/\s+/));

// The one colour that is not a token: the inline-code ground, made to read on both grounds.
const INLINE_CODE_GROUND = "rgba(127,127,127,.18)";

// Every class the page puts on an element, read from its source: the literals the script assigns
// (`className = "…"`, `classList.add|toggle("…")`, `class="…"` in a template), the static head of a
// template literal (`row ${kind}` names `row`), the row kinds that template is filled with
// (`kind: "…"` in render.mjs), and the classes the markup outside the script carries. A dialog
// line (from dialog.mjs) is drawn under one of two literal classes, the raw block or the reason
// line, so its kind never reaches the page as a class.
function classes() {
  const emitted = new Set();
  const add = (list) => list.split(/\s+/).forEach((name) => name !== "" && emitted.add(name));
  const assigned = /className = "([^"]*)"|className = `([^`$]*)\$\{|classList\.(?:add|toggle)\("([^"]*)"/g;
  for (const found of script.matchAll(assigned)) add(found[1] ?? found[2] ?? found[3]);
  for (const [, list] of source.matchAll(/class="([^"]*)"/g)) add(list);
  assert.ok(emitted.size >= 10, `the page names only ${emitted.size} classes, so this check read almost nothing`);
  const render = fs.readFileSync(path.join(repo, "lib", "chat", "render.mjs"), "utf8");
  const kinds = [...render.matchAll(/\bkind: "([\w-]+)"/g)].map(([, kind]) => kind);
  assert.ok(kinds.length >= 5, `render.mjs names only ${kinds.length} row kinds, so this check read almost nothing`);
  kinds.forEach((kind) => emitted.add(kind));
  return { emitted, selectors: rules.map((rule) => rule.selector).join(" ") };
}

// A class the page emits without a rule of its own, taking its defaults. The check keeps this
// list honest by refusing a rule for a name on it.
const UNSTYLED = new Set([]);

const named = (name) => new RegExp(`\\.${name}(?![\\w-])`);

describe("the token table", () => {
  it("declares the light tokens in bare :root and the dark ones under the theme attribute, each with its colour-scheme", () => {
    assert.equal(tokenBlocks.length, 2, "two token blocks, light then dark");
    const [light, dark] = tokenBlocks;
    assert.equal(light.selector, ":root");
    assert.equal(light.media, null);
    assert.deepEqual(only(light.declarations, isToken), tokens.light);
    assert.equal(light.declarations["color-scheme"], "light");
    assert.equal(dark.selector, ':root[data-theme="dark"]', "dark is the page's own choice, never the system's");
    assert.equal(dark.media, null);
    assert.deepEqual({ ...tokens.light, ...only(dark.declarations, isToken) }, tokens.dark);
    assert.equal(dark.declarations["color-scheme"], "dark");
  });

  it("colours the installed app's title bar with the light panel head", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(repo, "lib", "chat", "manifest.webmanifest"), "utf8"));
    assert.equal(manifest.theme_color, tokens.light["--panel-2"]);
  });
});

describe("the rules", () => {
  it("set the page's type in rem on the sans stack, one and a half lines high", () => {
    const body = rules.find((rule) => rule.selector === "body" && rule.media === null);
    assert.equal(body.declarations.font, "1rem/1.5 var(--sans)");
  });

  it("mark a panel whose process is gone, or whose page has no stream, with a red dot on its head", () => {
    const dot = rules.find((rule) => rule.selector === ".panel.gone .phead .name::before");
    assert.equal(dot.declarations.background, "var(--bad)");
  });

  // The three state rules share a specificity, so the order decides: a process gone mid-turn is
  // red, never the amber of the turn it was on.
  it("mark a panel whose turn is running with an amber dot, and let a gone process outrank it", () => {
    const at = (selector) => rules.findIndex((rule) => rule.selector === `.panel.${selector} .phead .name::before`);
    assert.equal(rules[at("busy")].declarations.background, "var(--warn)");
    assert.equal(rules[at("idle")].declarations.background, "var(--ok)");
    assert.ok(at("gone") > at("busy") && at("gone") > at("idle"), "the gone rule sits above a state rule, which then wins on a gone panel");
  });

  // Every word on a head is pinned and the head clips at its right edge: the context is never the
  // part that goes, whatever the width. The theme toggle is pushed to that edge.
  it("pin every word of a head, clip the head at its edge, and push the theme toggle to it", () => {
    const declared = (selector) => rules.find((rule) => rule.selector === selector)?.declarations;
    assert.equal(declared(".phead").overflow, "hidden");
    assert.equal(declared(".phead")["white-space"], "nowrap");
    for (const part of [".phead .info", ".phead .state", ".phead .conn, .phead .quota"]) assert.equal(declared(part).flex, "0 0 auto", part);
    assert.equal(declared(".phead .info")["text-overflow"], undefined, "the model and the context are shown whole or clipped, never cut to a fragment");
    assert.equal(declared(".phead .theme")["margin-left"], "auto");
  });

  // The stop glyph sits inside the box, at its right edge; the box keeps the room for it only
  // while it is there. The glyph takes its default display, so the hidden attribute hides it.
  it("put the stop glyph at the right edge of the box and keep the room for it while it is there", () => {
    const glyph = rules.find((rule) => rule.selector === ".composer .stop").declarations;
    assert.equal(glyph.position, "absolute");
    assert.equal(glyph.right, "9px");
    assert.equal(glyph.display, undefined, "a display of its own would outrank the hidden attribute");
    assert.equal(rules.find((rule) => rule.selector === ".composer").declarations.position, "relative");
    assert.equal(rules.find((rule) => rule.selector === ".composer.stoppable textarea").declarations["padding-right"], "36px");
  });

  it("draw what the User typed on the User's own ground", () => {
    const bubble = rules.find((rule) => rule.selector === ".msg.user .bubble");
    assert.equal(bubble.declarations.background, "var(--me)");
  });

  it("draw the deny button of a question on the ground of what goes to the session", () => {
    const deny = rules.find((rule) => rule.selector === ".msg.perm .acts button[data-decision=deny]");
    assert.equal(deny.declarations.background, "var(--to)");
  });

  it("let the composer grow with what is typed and never by a drag", () => {
    const box = rules.find((rule) => rule.selector === "textarea");
    assert.equal(box.declarations.resize, "none");
  });

  it("draw the pill for rows that arrived below the reader as a pill", () => {
    const pill = rules.find((rule) => rule.selector === "#jump");
    assert.equal(pill.declarations["border-radius"], "999px");
  });

  it("draw a message the Leader sent on the ground of what goes to the session", () => {
    const bubble = rules.find((rule) => rule.selector === ".msg.peer-out .bubble");
    assert.equal(bubble.declarations.background, "var(--to)");
  });

  it("draw what the User typed to a Worker on a ground of its own on the Leader's panel, as the User's words", () => {
    const bubble = rules.find((rule) => rule.selector === ".msg.typed .bubble");
    assert.equal(bubble.declarations.background, "var(--typed)");
    assert.equal(bubble.declarations["border-color"], "var(--typed-line)");
    assert.equal(bubble.declarations["white-space"], "pre-wrap", "typed words keep their lines, as on the User's own ground");
  });

  it("mark the line of a message as a click, and light the message a click found", () => {
    const line = rules.find((rule) => rule.selector === ".rows .line.peer");
    assert.equal(line.declarations.cursor, "pointer");
    assert.equal(line.declarations["border-left"], "3px solid var(--accent)");
    const lit = rules.find((rule) => rule.selector === ".msg.focus .bubble");
    assert.equal(lit.declarations.outline, "2px solid var(--accent)");
  });

  it("clip a folded message to three lines, faded at its edge, and draw the word that opens it as a link", () => {
    const folded = rules.find((rule) => rule.selector === ".bubble .md.collapsed");
    assert.equal(folded.declarations["max-height"], "4.5em", "three lines at the page's line height of 1.5");
    assert.equal(folded.declarations.overflow, "hidden");
    assert.equal(folded.declarations["mask-image"], "linear-gradient(currentcolor 80%, transparent)");
    const more = rules.find((rule) => rule.selector === ".more");
    assert.equal(more.declarations.color, "var(--accent)");
    assert.equal(more.declarations.cursor, "pointer");
    assert.equal(more.declarations.border, "0");
  });

  it("make the stamp a click, and say so under the pointer", () => {
    const stamp = rules.find((rule) => rule.selector === ".meta .t");
    assert.equal(stamp.declarations.cursor, "pointer");
    const under = rules.find((rule) => rule.selector === ".meta .t:hover");
    assert.equal(under.declarations["text-decoration"], "underline dotted");
    assert.equal(under.declarations.color, "var(--fg)");
  });

  it("draw the User's row on the waiting ground, dashed, until it is delivered, and its word in amber while it waits", () => {
    const bubble = rules.find((rule) => rule.selector === ".msg.pending .bubble");
    assert.equal(bubble.declarations.background, "var(--pending)");
    assert.equal(bubble.declarations["border-style"], "dashed");
    assert.ok(rules.indexOf(bubble) > rules.indexOf(rules.find((rule) => rule.selector === ".msg.user .bubble")), "the waiting ground is declared after the User's, or it never shows on the User's row");
    assert.equal(rules.find((rule) => rule.selector === ".meta .st.wait").declarations.color, "var(--warn)");
  });

  // A code block is set at .85rem on the block itself, 1.4 lines high, and the code inside it
  // inherits the size: a size on the inner element compounds with the block's and the block
  // reads bigger than the text around it.
  it("set a code block at .85rem, 1.4 lines high, on the block itself, the code inside inheriting", () => {
    const block = rules.find((rule) => rule.selector === ".md pre");
    assert.equal(block.declarations["font-size"], ".85rem");
    assert.equal(block.declarations["line-height"], "1.4");
    assert.equal(rules.find((rule) => rule.selector === ".md pre code").declarations["font-size"], "inherit");
  });

  it("draw a tool line in the dim mono of a machine word", () => {
    const line = rules.find((rule) => rule.selector === ".rows .line");
    assert.equal(line.declarations.color, "var(--fg-dim)");
  });

  // The pill sticks to the bottom edge of the rows it belongs to, not to the viewport: a pill fixed
  // to the viewport sits over whatever is open below the rows — the reason input of a permission
  // card, first of all — while a sticky last child of the rows sits above it, 24px up.
  it("keep the pill inside the rows, stuck 24px above their bottom edge", () => {
    const pill = rules.find((rule) => rule.selector === "#jump");
    assert.equal(pill.declarations.position, "sticky");
    assert.equal(pill.declarations.bottom, "24px");
    assert.deepEqual(rules.find((rule) => rule.selector === "#jump.show").declarations, { display: "block" }, "showing the pill changes its display only, never its position");
  });

  // Every pin above reads the FIRST rule under a selector while the cascade takes the LAST, so a
  // second rule under the same selector would change the page behind a green pin.
  it("declare no selector twice", () => {
    const seen = new Set();
    for (const rule of rules) {
      const key = `${rule.media ?? ""}|${rule.keyframes ?? ""}|${rule.selector}`;
      assert.ok(!seen.has(key), `${rule.selector} is declared twice${rule.media === null ? "" : ` under @media ${rule.media}`}`);
      seen.add(key);
    }
    assert.ok(seen.size >= 50, `the stylesheet has only ${seen.size} rules, so this check read almost nothing`);
  });

  it("carry no raw colour outside the token blocks", () => {
    for (const rule of rules) {
      if (tokenBlocks.includes(rule)) continue;
      for (const [property, value] of Object.entries(rule.declarations)) {
        const bare = value.split(INLINE_CODE_GROUND).join(" ");
        const where = `${rule.media === null ? "" : `${rule.media} `}${rule.selector} { ${property}: ${value} }`;
        assert.doesNotMatch(bare, /#[0-9a-f]{3,8}\b|\b(rgba?|hsla?)\(/i, where);
        for (const word of bare.toLowerCase().match(/[a-z]+/g) ?? []) assert.ok(!NAMED.has(word), where);
      }
    }
  });

  // A var() naming a token the table does not declare renders as nothing: the browser drops the
  // declaration, and the page looks wrong without a word.
  it("name no token the table does not declare", () => {
    const declared = new Set(Object.keys(tokens.light));
    let used = 0;
    for (const rule of rules) {
      for (const [property, value] of Object.entries(rule.declarations)) {
        for (const [, name] of value.matchAll(/var\((--[\w-]+)/g)) {
          used += 1;
          assert.ok(declared.has(name), `${rule.selector} { ${property}: ${value} } names ${name}, which the table does not declare`);
        }
      }
    }
    assert.ok(used >= 20, `the stylesheet uses a token only ${used} times, so this check read almost nothing`);
  });

  it("give every class the page emits at least one rule", () => {
    const { emitted, selectors } = classes();
    for (const name of emitted) {
      if (UNSTYLED.has(name)) assert.doesNotMatch(selectors, named(name), `.${name} is styled now: take it out of UNSTYLED`);
      else assert.match(selectors, named(name), `no rule names .${name}`);
    }
  });

  it("name no class the page never emits", () => {
    const { emitted, selectors } = classes();
    for (const [, name] of selectors.matchAll(/\.([a-z][\w-]*)/gi)) {
      assert.ok(emitted.has(name), `.${name} matches nothing the page emits`);
    }
  });

  // The same for an attribute: `[data-x=…]` matches only an element the script stamps with
  // `dataset.x = …`, and the stamp is also what a click reads back — so a selector on an
  // attribute the script never sets parses, matches nothing, and says nothing.
  it("select no attribute the script never sets", () => {
    let seen = 0;
    for (const rule of rules) {
      for (const [, name] of rule.selector.matchAll(/\[data-([\w-]+)/g)) {
        seen += 1;
        const property = name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
        assert.match(script, new RegExp(`dataset\\.${property} = `), `[data-${name}] matches nothing the script sets`);
      }
    }
    assert.ok(seen >= 1, "the stylesheet selects on no attribute, so this check read nothing");
  });
});

describe("the script", () => {
  it("stamps a row with the reader's own day and time, the weekday written out, on a 24-hour clock, and the day pill with the same", () => {
    const options = [...script.matchAll(/new Intl\.DateTimeFormat\("en-GB", \{([^}]*)\}\)/g)].map(([, inside]) => inside);
    assert.equal(options.length, 1, "one formatter, for the row's stamp and the day pill alike: a second one is a second format");
    const [stamp] = options;
    assert.match(stamp, /\bweekday: "long"/);
    assert.match(stamp, /\bhourCycle: "h23"/);
    assert.match(stamp, /\bmonth: "2-digit"/, "the month is a number, never a word or a word cut short");
    assert.doesNotMatch(stamp, /timeZone/, "a zone of the page's own instead of the reader's");
    assert.match(script, /const day = `\$\{part\.year\}\.\$\{part\.month\}\.\$\{part\.day\}`;\s*const clock = `\$\{part\.hour\}:\$\{part\.minute\}:\$\{part\.second\}`;\s*return \{ whole: `\$\{day\} \$\{part\.weekday\} \$\{clock\}`, clock, day \};/);
  });

  // The pill between two days carries the whole stamp of the first row of the new day, and goes
  // in only between a row of one day and a row of the next: never before the first row drawn,
  // whatever day it was written on, and never after the last — it is appended right before the
  // row it announces. A row without a stamp keeps the day. The trim of a Worker panel takes the
  // pill with the rows before it, so it is never the first thing on a panel either.
  it("puts the pill between two days only, with the whole stamp of the first row of the new day on it, and never first", () => {
    assert.match(script, /function dayPill\(when\) \{\s*const element = pill\(when\.whole\);\s*element\.dataset\.day = when\.day;\s*return element;\s*\}/);
    assert.match(script, /const when = stamp\(entry\.at\);\s*if \(entry\.at !== undefined && when\.day !== panel\.day\) \{\s*if \(panel\.day !== null\) \{\s*panel\.last = null;\s*panel\.rows\.append\(dayPill\(when\)\);\s*\}\s*panel\.day = when\.day;\s*\}/);
    assert.match(script, /while \(drawn\.length > 100\) drawn\.shift\(\)\.remove\(\);\s*\/\/[^\n]*\n\s*while \(drawn\.length > 0 && drawn\[0\]\.dataset\.day !== undefined\) drawn\.shift\(\)\.remove\(\);/);
    assert.match(script, /panel\.shown = 0;\s*panel\.day = null;/, "a panel drawn afresh starts with no day, so its first row gets no pill");
  });

  // The User's own row says what became of it beside its stamp, from the words panels.mjs picks:
  // waiting — on the dashed ground, in amber — until the server writes the row again as delivered,
  // when the row it has changes ground and word; the panel's state at the draw says whether the
  // wait is a queue behind the turn under way.
  it("draws the User's row waiting on the dashed ground until the server says delivered, then changes the row it has", () => {
    assert.match(script, /if \(shown\.kind === "user"\) \{\s*const st = document\.createElement\("span"\);\s*st\.className = "st";\s*const said = delivery\(shown\.delivered, panel\.section\.classList\.contains\("busy"\), panel\.name\);\s*st\.textContent = said\.text;\s*if \(said\.wait\) \{\s*st\.classList\.add\("wait"\);\s*line\.classList\.add\("pending"\);\s*\}\s*meta\.append\(st\);\s*\}/);
    assert.match(script, /if \(shown\.kind === "user" && !shown\.delivered\) panel\.waiting\.set\(index, line\);/);
    assert.match(script, /function deliveredRow\(panel, index\) \{\s*const element = panel\.waiting\.get\(index\);\s*if \(element === undefined\) return;\s*panel\.waiting\.delete\(index\);\s*element\.classList\.remove\("pending"\);\s*const st = element\.querySelector\("\.st"\);\s*st\.classList\.remove\("wait"\);\s*st\.textContent = delivery\(true, false, panel\.name\)\.text;\s*\}/);
    assert.match(script, /for \(const index of about\.amended\.splice\(0\)\) \{[^}]*\}\s*if \(about\.rows\[index\]\.delivered === true\) deliveredRow\(panel, index\);\s*\}/);
    assert.match(script, /panel\.lines\.clear\(\);\s*panel\.waiting\.clear\(\);/, "a panel drawn afresh forgets whom it was waiting on");
    assert.match(script, /for \(const kept of \[panel\.lines, panel\.waiting\]\) \{\s*for \(const \[index, element\] of kept\) \{\s*if \(!element\.isConnected\) kept\.delete\(index\);/, "the trim lets go of a waiting row it no longer holds");
  });

  // Every stamp is a click that points at its row from the panel's composer: the token from
  // panels.mjs, built from the whole stamp — never from what is on screen, which may be the clock
  // alone — goes into the box after a space, the box is told and takes the next keystroke; what is
  // sent is the box with every token spelled out.
  it("makes every stamp a click that puts a reference to its row into the composer, spelled out on send", () => {
    assert.match(script, /time\.title = REFERENCE;\s*time\.addEventListener\("click", \(\) => pointAt\(panel, time, shown\.who, body\)\);/);
    assert.match(script, /const REFERENCE = "click to reference this message in your reply";/);
    assert.match(script, /function pointAt\(panel, time, who, body\) \{\s*const token = reference\(panel\.refs, time\.dataset\.whole, who, body\.textContent\);\s*if \(token === null\) return;\s*const typed = panel\.box\.value;\s*panel\.box\.value = `\$\{typed\}\$\{typed !== "" && !\/\\s\$\/\.test\(typed\) \? " " : ""\}\$\{token\} `;\s*panel\.box\.dispatchEvent\(new Event\("input"\)\);\s*if \(!panel\.box\.disabled\) panel\.box\.focus\(\);\s*\}/);
    assert.match(script, /const refs = new Map\(\);/);
    assert.match(script, /composer\.addEventListener\("submit", \(event\) => \{\s*event\.preventDefault\(\);\s*const text = spellReferences\(refs, box\.value\);/);
  });

  // Enter sends and the box grows: the page is never run here, so the wiring is read as text —
  // the key handler hands a send to the form, and every input resets the height to auto and
  // then sets it from the scroll height under the 40vh cap — without the reset the box never
  // shrinks back after a send or a deleted line.
  it("sends on Enter through the form, and grows the box with what is typed, capped at 40vh", () => {
    assert.match(script, /box\.addEventListener\("keydown", \(event\) => \{\s*if \(keyAction\(event\) === "send"\) \{\s*event\.preventDefault\(\);\s*composer\.requestSubmit\(\);/);
    assert.match(script, /box\.addEventListener\("input", autosize\)/);
    assert.match(script, /box\.style\.height = "auto";\s*const max = window\.innerHeight \* 0\.4;\s*box\.style\.height = `\$\{Math\.min\(box\.scrollHeight, max\)\}px`;/);
  });

  // The placeholder is a property of the box, not a word of the page's own, so it is read here and
  // not in the literal list chat.test.mjs pins. The whole sentence when it fits the box on one line,
  // its head when the box is too narrow — measured in the box's own font, and again whenever the
  // box changes width; while a turn runs the sentence says so, and that Enter still sends.
  it("says in the empty box whom a message reaches and which key sends it, the whole sentence only where it fits", () => {
    assert.match(script, /const whole = busy \? `\$\{name\} is working — Enter still sends` : `Message \$\{name\} — Enter sends, Shift\+Enter for a new line`;/);
    assert.match(script, /box\.placeholder = textWidth\(whole, box\) <= room \? whole : busy \? `\$\{name\} is working` : `Message \$\{name\}`;/);
    assert.match(script, /const busy = section\.classList\.contains\("busy"\);/, "the sentence follows the panel's own busy mark");
    assert.match(script, /new ResizeObserver\(fitPlaceholder\)\.observe\(box\);/);
    assert.match(script, /gauge\.measureText\(text\)\.width/);
    assert.match(script, /gauge\.font = `\$\{style\.fontStyle\} \$\{style\.fontWeight\} \$\{style\.fontSize\} \$\{style\.fontFamily\}`;/, "the gauge measures in the box own font");
    assert.match(script, /const room = box\.clientWidth - parseFloat\(style\.paddingLeft\) - parseFloat\(style\.paddingRight\);/, "the room is the box inner width");
  });

  // The theme is the page's own choice: set before the first paint by a script that must sit above
  // the stylesheet (below it, a page kept dark paints light first), flipped by the toggle, kept
  // under one key, and carried to the theme-color meta so an installed app's title bar follows.
  it("sets the stored theme above the stylesheet, flips it on the toggle, keeps it and repaints the title bar", () => {
    const head = source.indexOf("<script>");
    assert.ok(head !== -1, "no head script");
    assert.ok(head < source.indexOf("<style>"), "the head script sits below the stylesheet");
    const headScript = source.slice(head, source.indexOf("</script>", head));
    assert.match(headScript, /document\.documentElement\.dataset\.theme = localStorage\.getItem\("openovai-theme"\) === "dark" \? "dark" : "light";/);
    assert.match(headScript, /catch \(error\) \{ document\.documentElement\.dataset\.theme = "light"; \}/);
    assert.match(script, /function applyTheme\(theme\) \{\s*document\.documentElement\.dataset\.theme = theme;\s*try \{ localStorage\.setItem\("openovai-theme", theme\); \} catch \(error\) \{\}/);
    assert.match(script, /themeMeta\.content = getComputedStyle\(document\.documentElement\)\.getPropertyValue\("--panel-2"\)\.trim\(\)/);
    assert.match(script, /themeToggle\.addEventListener\("click", \(\) => applyTheme\(document\.documentElement\.dataset\.theme === "dark" \? "light" : "dark"\)\);/);
  });

  // The pill: shown by a draw that appended rows while the reader was more than 80px above the
  // newest, gone once a scroll brings them near it or a click takes them there. It is a child of
  // the rows (sticky needs a scrolling ancestor) and their LAST child after every draw, or the
  // rows appended after it would carry it up into the middle of the panel.
  it("shows the pill when rows land below a reader who is not near the newest, and takes them there on a click", () => {
    assert.match(script, /const nearTheNewest = \(rows\) => rows\.scrollHeight - rows\.scrollTop - rows\.clientHeight < 80;/);
    assert.match(script, /\n      rows\.append\(jump\);\n/, "the pill is a child of the rows");
    assert.match(script, /panel\.shown = about\.rows\.length;\n(?:[^\n]*\n){31}      if \(panel\.jump !== null && panel\.jump !== panel\.rows\.lastElementChild\) panel\.rows\.append\(panel\.jump\);\n    \}\n/, "the pill is put back last AFTER the rows are appended, as the last statement of the draw");
    assert.match(script, /\} else if \(panel\.jump !== null && !near\) \{\s*panel\.jump\.classList\.add\("show"\);/);
    assert.match(script, /rows\.addEventListener\("scroll", \(\) => \{\s*if \(nearTheNewest\(rows\)\) jump\.classList\.remove\("show"\);/);
    assert.match(script, /jump\.addEventListener\("click", \(\) => \{\s*rows\.scrollTop = rows\.scrollHeight;\s*jump\.classList\.remove\("show"\);/);
  });

  // The stop glyph: in the composer, after the box; there while the turn can be stopped, the box
  // keeping the room for it then; a click hides it and asks the server to stop the turn.
  it("puts the stop glyph in the box, shows it while the turn can be stopped, and stops the turn on a click", () => {
    assert.match(script, /stop\.className = "stop";[\s\S]{0,400}composer\.append\(box, stop\);/);
    assert.match(script, /const stoppable = stopEnabled\(state, panel\.name\);\s*panel\.stop\.hidden = !stoppable;\s*panel\.composer\.classList\.toggle\("stoppable", stoppable\);/);
    assert.match(script, /stop\.addEventListener\("click", \(\) => \{\s*stop\.hidden = true;\s*call\(`\/sessions\/\$\{encodeURIComponent\(name\)\}\/stop`, \{ method: "POST" \}\)/);
    assert.doesNotMatch(script, /headLine\.append\([^)]*stop/, "the glyph is in the box, not on the head");
  });

  // The dot and the placeholder follow what the server says of the panel's turn: the page reads
  // `busy` from the panel and marks the panel with it on every draw, then refits the placeholder —
  // a ResizeObserver alone would say the idle sentence on a busy box that never changed width.
  it("marks a panel idle, busy or gone from its dot on every draw, and refits the empty box then", () => {
    assert.match(script, /const colour = dot\(state, panel\.name\);\s*panel\.section\.classList\.toggle\("idle", colour === GREEN\);\s*panel\.section\.classList\.toggle\("busy", colour === AMBER\);\s*panel\.section\.classList\.toggle\("gone", colour === RED\);/);
    assert.match(script, /panel\.box\.disabled = !composersEnabled\(state, panel\.name\);\s*panel\.fitPlaceholder\(\);/, "the refit comes after the marks, in the draw");
  });

  // A row's stamp: the whole day and time, or the time alone where the whole would cut the label —
  // the label is the one part of the line that trims, so it is the label that says. All stamps
  // are set whole first and measured after, so a change of width costs one layout, not one per
  // row; measured for the rows a draw appends and for every row when the rows change width.
  it("gives a row's stamp up to the time alone where the whole day would cut the label, on append and on every change of width", () => {
    assert.match(script, /time\.dataset\.whole = when\.whole;\s*time\.dataset\.clock = when\.clock;\s*time\.textContent = when\.whole;/);
    assert.match(script, /function fitStamps\(stamps\) \{\s*for \(const time of stamps\) time\.textContent = time\.dataset\.whole;\s*const cut = \[\.\.\.stamps\]\.filter\(\(time\) => \{ const label = time\.parentElement\.querySelector\("\.lbl"\); return label\.scrollWidth > label\.clientWidth; \}\);\s*for \(const time of cut\) time\.textContent = time\.dataset\.clock;\s*\}/);
    assert.match(script, /new ResizeObserver\(\(\) => fitStamps\(rows\.querySelectorAll\("\.t"\)\)\)\.observe\(rows\);/);
    assert.match(script, /if \(time !== null\) added\.push\(time\);\s*\}\s*fitStamps\(added\);\s*panel\.shown = about\.rows\.length;/, "the appended rows are fitted once, after the loop");
  });

  // A tool line has no stamp: what the loop pushes to the fitter is the stamp it found, never a
  // null the fitter would read textContent on.
  it("pushes only a stamp it found to the fitter", () => {
    assert.match(script, /const time = line\.querySelector\("\.t"\);\s*if \(time !== null\) added\.push\(time\);/);
  });

  // A tool call is a line, built by one function that always appends the counter span: the err
  // class from the shown row, never a ternary in the class name (the classes check reads
  // literals), and the text as text.
  it("builds a tool line as a div with its summary as text, the err class and the reason from the row, and a counter span after it", () => {
    assert.match(script, /function lineElement\(shown\) \{\s*const line = document\.createElement\("div"\);\s*line\.className = "line";\s*if \(shown\.err === true\) line\.classList\.add\("err"\);\s*line\.title = shown\.why;\s*line\.textContent = shown\.text;\s*const count = document\.createElement\("span"\);\s*count\.className = "n";\s*line\.append\(count\);/);
    assert.match(script, /if \(shown\.kind === "line"\) return lineElement\(shown\);/);
  });

  // A divider row — the Leader's process gone — is the same pill as the day between two rows:
  // one function builds both, a div of the divider class with the word in a span.
  it("draws a divider row as the pill between two days, built by the one pill function", () => {
    assert.match(script, /function pill\(word\) \{\s*const element = document\.createElement\("div"\);\s*element\.className = "divider";\s*const text = document\.createElement\("span"\);\s*text\.textContent = word;\s*element\.append\(text\);\s*return element;/);
    assert.match(script, /if \(shown\.kind === "divider"\) return pill\(shown\.text\);/);
    assert.match(script, /const element = pill\(when\.whole\);/, "the day pill is the same pill");
  });

  // A line that is one end of a message between two sessions carries the message's id and is a
  // click: the message is found on the Leader's panel by that id, brought into view and lit for a
  // moment. A line that is nothing of the kind gets none of it.
  it("marks the line of a message with its id and takes a click on it to the message on the Leader's panel", () => {
    assert.match(script, /if \(shown\.msg !== undefined\) \{\s*line\.classList\.add\("peer"\);\s*line\.dataset\.msg = shown\.msg;\s*line\.onclick = \(\) => focusMessage\(shown\.msg\);\s*\}\s*return line;/);
    assert.match(script, /if \(shown\.msg !== undefined\) line\.dataset\.msg = shown\.msg;/, "a bubble carries the id too, for the click to find");
    assert.match(script, /function focusMessage\(id\) \{\s*const leader = sections\.get\(state\.leader\);\s*const found = leader === undefined \? null : leader\.rows\.querySelector\(`\.msg\[data-msg="\$\{id\}"\]`\);\s*if \(found === null\) return;\s*found\.scrollIntoView\(\{ block: "center" \}\);/);
    assert.match(script, /found\.classList\.add\("focus"\);\s*setTimeout\(\(\) => found\.classList\.remove\("focus"\), FOCUS_FOR\);/);
    assert.match(script, /const FOCUS_FOR = 1500;/);
  });

  // A message on the Leader's panel, to a session or from one, shows three lines of itself: the
  // body is folded once it is on the page, and a body that fits is unfolded again and carries no
  // word; one that does not gets the word under it that opens it and folds it again.
  it("folds a message to a session or from one to three lines, once it is on the page, with a word that opens it", () => {
    assert.match(script, /if \(shown\.kind === "peer-in" \|\| shown\.kind === "peer-out"\) collapsible\(line\.querySelector\("\.md"\)\);/);
    assert.match(script, /panel\.rows\.append\(line\);(?:[^\n]*\n)+?[^\n]*collapsible\(line\.querySelector/, "folded after the row is on the page, never before");
    assert.match(script, /function collapsible\(body\) \{\s*body\.classList\.add\("collapsed"\);\s*if \(body\.scrollHeight <= body\.clientHeight\) \{\s*body\.classList\.remove\("collapsed"\);\s*return;\s*\}/);
    assert.match(script, /more\.className = "more";\s*more\.textContent = "show all";\s*more\.onclick = \(\) => \{\s*const folded = body\.classList\.toggle\("collapsed"\);\s*more\.textContent = folded \? "show all" : "collapse";\s*\};\s*body\.after\(more\);/);
  });

  // A call that failed after its line was drawn: the server writes the row again with err and
  // the reason, the page lists its index under amended, and the draw marks the element of that
  // index and gives it the reason.
  it("marks the line of a call that failed red, by its index, with the reason for a tooltip", () => {
    assert.match(script, /for \(const index of about\.amended\.splice\(0\)\) \{\s*const element = panel\.lines\.get\(index\);\s*if \(element !== undefined && about\.rows\[index\]\.err === true\) \{\s*element\.classList\.add\("err"\);\s*element\.title = about\.rows\[index\]\.why \?\? "";\s*\}/);
    assert.match(script, /panel\.lines\.set\(index, line\);/, "a drawn line is kept by its index");
  });

  // Identical neighbouring calls are one line with a counter: the repeated call writes ×N into
  // the counter span of the line appended last and draws nothing; any other row ends the run —
  // and so does a line that is one end of a message, which is never merged and never merged into.
  it("merges a repeated call into one line with a counter, never a message's line", () => {
    assert.match(script, /if \(shown\.kind === "line" && shown\.msg === undefined && panel\.last !== null && panel\.last\.text === shown\.text\) \{\s*panel\.last\.count \+= 1;\s*panel\.last\.n\.textContent = ` ×\$\{panel\.last\.count\}`;\s*panel\.lines\.set\(index, panel\.last\.el\);\s*continue;/);
    assert.match(script, /panel\.last = shown\.msg === undefined \? \{ text: shown\.text, el: line, count: 1, n: line\.lastElementChild \} : null;/, "a message's line ends the run");
    assert.match(script, /\} else \{\s*panel\.last = null;\s*if \(shown\.kind === "user" && !shown\.delivered\) panel\.waiting\.set\(index, line\);\s*\}/, "a bubble ends the run");
    assert.match(script, /panel\.last = null;\s*panel\.rows\.append\(dayPill\(when\)\);/, "a pill ends the run");
  });

  // A Worker panel holds a hundred drawn rows: the first draw starts
  // a hundred from the end rather than building every row and trimming, and every draw lets the
  // oldest go past a hundred. The Leader's panel is the User's own conversation and keeps it all.
  it("keeps the last hundred rows of a Worker panel and every row of the Leader's", () => {
    assert.match(script, /const from = panel\.jump === null && panel\.shown === 0 \? Math\.max\(panel\.shown, about\.rows\.length - 100\) : panel\.shown;/);
    assert.match(script, /if \(panel\.jump === null\) \{\s*const drawn = \[\.\.\.panel\.rows\.children\]\.filter\(\(child\) => child\.matches\("\.msg, \.line, \.divider"\)\);\s*while \(drawn\.length > 100\) drawn\.shift\(\)\.remove\(\);/);
  });

  // The Leader's head, after the state word: the connection word, red while the page has no
  // stream, and the quota line with its tooltip — drawn from the words panels.mjs makes, on
  // every draw; the theme toggle after them.
  it("draws the connection word and the quota line on the Leader's head, and marks a lost stream", () => {
    assert.match(script, /headLine\.append\(facts\.conn, facts\.quota\);[\s\S]{0,600}headLine\.append\(themeToggle\);/);
    assert.match(script, /panel\.facts\.conn\.textContent = state\.connection;\s*panel\.facts\.conn\.classList\.toggle\("off", state\.connection !== CONNECTED\);/);
    assert.match(script, /panel\.facts\.quota\.textContent = quotaLine\(state\.quota\);\s*panel\.facts\.quota\.title = quotaTitle\(state\.quota, \(iso\) => stamp\(iso\)\.whole\);/);
    assert.match(script, /document\.title = title\(state\);/);
  });

  // Without a stream the page says so and asks the server about it once a second: a 503 is the
  // instance still stopping (call() marks that, as disconnected), no answer is the server gone,
  // anything else opens the stream again; a 401 reloads, in call(). The stream's own error and
  // the server's word that it is stopping both say disconnected; only an open stream says
  // connected.
  it("says disconnected when the stream drops or the server is stopping, keeps asking, and connects again", () => {
    assert.match(script, /stream\.addEventListener\("error", \(\) => \{\s*stream\.close\(\);\s*lost\(\);\s*setTimeout\(probe, 1000\);/);
    assert.match(script, /function lost\(\) \{\s*if \(state\.connection !== DISCONNECTED\) \{\s*state\.connection = DISCONNECTED;\s*draw\(\);/);
    assert.match(script, /call\("\/sessions"\)\.then\(\s*\(answered\) => \(answered\.status === 503 \? setTimeout\(probe, 1000\) : connect\(\)\),\s*\(\) => \{\s*lost\(\);\s*setTimeout\(probe, 1000\);/);
    assert.match(script, /if \(answered\.status === 503\) \{\s*applyEvent\(state, \{ name: "stopping", data: \{\} \}\);\s*draw\(\);/);
    assert.match(script, /stream\.addEventListener\("open", \(\) => \{\s*state\.connection = CONNECTED;\s*draw\(\);/);
    assert.match(script, /const EVENTS = \["snapshot", "rows", "row", "asking", "seat", "quota", "stopping"\];/);
    assert.ok(!script.includes("STOPPING"), "the page still carries a stopping word");
  });

  // The page is never run here, so the proof is in two halves: the renderer turns a reply into
  // markup that carries elements, and the page hands that markup to the body as markup — the one
  // place a reply's HTML is parsed. Pasted as text, a link would read as its brackets.
  // A message between two sessions: the outcome glyph, the compact markdown class and a line's
  // red are each set after the fact from the shown row, under a guard — never a ternary in a
  // class name (the classes check reads literals) and never a word of the page's own (the words
  // come from the renderer).
  it("draws the glyph and a line with the renderer's words, and the compact markdown under its own class", () => {
    assert.match(script, /if \(shown\.status !== undefined\) \{\s*const st = document\.createElement\("span"\);\s*st\.className = "st";\s*if \(shown\.status\.bad === true\) st\.classList\.add\("bad"\);\s*st\.textContent = shown\.status\.text;\s*st\.title = shown\.status\.title;\s*meta\.append\(st\);/);
    assert.match(script, /body\.innerHTML = shown\.html;\s*if \(shown\.tight === true\) body\.classList\.add\("tight"\);/);
    assert.match(script, /if \(shown\.err === true\) line\.classList\.add\("err"\);/);
    assert.match(script, /rowOf\(entry, \{ chat: state\.chat, seat: panel\.name, leader: state\.leader, user: state\.user \}\)/, "the renderer is told whose panel the row is on, and who the User is");
  });

  it("draws a reply's markdown as elements — a link, a code span — never as the words of the markup", () => {
    const shown = row({ from: "Ray", text: "see [it](https://x.y/z) in `code`" }, { chat: "the chat" });
    assert.match(shown.html, /<a href="https:\/\/x\.y\/z"[^>]*>it<\/a>/);
    assert.match(shown.html, /<code>code<\/code>/);
    assert.match(script, /body\.className = "md";\s*body\.innerHTML = shown\.html;/, "the reply body is not filled with its markup under .md");
    assert.doesNotMatch(script, /textContent = shown\.html/, "a reply's markup pasted as text");
  });
});
