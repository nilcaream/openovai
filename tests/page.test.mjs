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

  // The stop glyph is out of the flow, over the box at its right edge: the box and the room for
  // what is typed are the same width with the glyph and without it — no rule on the box changes
  // under any class — and the glyph sits on the box's own ground with a 2px ring of it, so it
  // reads over letters under it. It takes its default display, so the hidden attribute hides it.
  it("keep the stop glyph out of the flow, over the box on its own ground, the box the same width with it and without it", () => {
    const glyph = rules.find((rule) => rule.selector === ".composer .stop").declarations;
    assert.equal(glyph.position, "absolute");
    assert.equal(glyph.right, "9px");
    assert.equal(glyph.display, undefined, "a display of its own would outrank the hidden attribute");
    assert.equal(glyph.background, "var(--bg)");
    assert.equal(glyph["box-shadow"], "0 0 0 2px var(--bg)");
    assert.equal(rules.find((rule) => rule.selector === ".composer").declarations.position, "relative");
    const box = rules.find((rule) => rule.selector === "textarea").declarations;
    assert.equal(box.width, "100%");
    assert.equal(box.padding, "8px 10px");
    for (const rule of rules) {
      if (rule.selector === "textarea" || !/textarea/.test(rule.selector)) continue;
      for (const property of Object.keys(rule.declarations)) assert.doesNotMatch(property, /^(padding|width|margin|box-sizing)/, `${rule.selector} sizes the box: ${property}`);
    }
    assert.doesNotMatch(script, /stoppable/, "the composer is marked while the glyph is there: a rule under that mark would size the box");
  });

  // The bottom area — the cards of the panel's questions, then the composer — is in the panel's
  // column under the rows, never over them: the rows give it its room and shrink. It takes no
  // more than most of the panel, and the cards scroll inside it, so a stack of cards leaves the
  // rows and the composer in sight.
  it("keep the bottom area in the panel's column under the rows, taking its room from them", () => {
    const bottom = rules.find((rule) => rule.selector === ".bottom").declarations;
    assert.equal(bottom.position, undefined, "a position of its own takes the bottom area out of the column and over the rows");
    assert.equal(bottom.flex, "0 0 auto", "a bottom area that shrinks clips its cards under the composer");
    assert.equal(bottom["max-height"], "75%");
    assert.equal(bottom.display, "flex");
    assert.equal(bottom["flex-direction"], "column");
    const cards = rules.find((rule) => rule.selector === ".cards").declarations;
    assert.equal(cards["overflow-y"], "auto");
    assert.equal(cards["min-height"], "0");
    const rows = rules.find((rule) => rule.selector === ".rows").declarations;
    assert.equal(rows.flex, "1 1 auto");
    assert.equal(rows["min-height"], "0", "rows that cannot shrink push the bottom area out of the panel");
    assert.equal(rules.find((rule) => rule.selector === ".composer").declarations.flex, "0 0 auto");
    assert.match(script, /bottom\.append\(cards, composer\);\s*section\.append\(headLine, rows, bottom\);/, "the bottom area is the panel's last child, the cards then the composer in it");
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

  // What the User typed to a Worker is the User's own prompt, so the Leader's panel draws it on
  // the User's ground under its `<User> → <Worker>` label; what one Worker said to another is
  // neither a prompt to the Leader nor the User's words, and has a ground of its own.
  it("draw what the User typed to a Worker on the User's ground on the Leader's panel, and a Worker's words to a Worker on a ground of their own", () => {
    const bubble = rules.find((rule) => rule.selector === ".msg.typed .bubble");
    assert.equal(bubble.declarations.background, "var(--me)", "the User's own ground, as under the User's row");
    assert.equal(bubble.declarations["border-color"], "var(--me-line)");
    assert.equal(bubble.declarations["white-space"], "pre-wrap", "typed words keep their lines, as on the User's own ground");
    const heard = rules.find((rule) => rule.selector === ".msg.overheard .bubble");
    assert.equal(heard.declarations.background, "var(--typed)");
    assert.equal(heard.declarations["border-color"], "var(--typed-line)");
    assert.equal(heard.declarations["white-space"], undefined, "a Worker's words to a Worker are markdown, like a message to a session or from one: pre-wrap on the bubble would draw the markup's own newlines as blank lines");
    assert.equal(heard.declarations["overflow-wrap"], "anywhere");
  });

  // On the dark theme the ground of a message from a Worker used to sit one step off the Leader's
  // reply ground beside it — #1a2a3d against #1c232d, a contrast of 1.09 — and the two rows read
  // as one. The ground is held a visible step lighter: a contrast of 1.2 or more against the
  // reply ground, the WCAG ratio of the two relative luminances, read off the page's own dark
  // block. The light pair (#e3f0fc on #ffffff, 1.16) is a blue tint on white and reads apart;
  // it is not held here.
  it("keep the dark ground of a message from a Worker a visible step off the Leader's reply ground", () => {
    const channel = (hex) => { const c = parseInt(hex, 16) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const luminance = (hex) => 0.2126 * channel(hex.slice(1, 3)) + 0.7152 * channel(hex.slice(3, 5)) + 0.0722 * channel(hex.slice(5, 7));
    const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
    const dark = tokenBlocks[1].declarations;
    const ratio = contrast(dark["--from"], dark["--reply"]);
    assert.ok(ratio >= 1.2, `dark: --from ${dark["--from"]} against --reply ${dark["--reply"]} is a contrast of ${ratio.toFixed(2)}, under 1.2`);
  });

  it("mark the line of a message as a click, and light the message a click found", () => {
    const line = rules.find((rule) => rule.selector === ".rows .line.peer");
    assert.equal(line.declarations.cursor, "pointer");
    assert.equal(line.declarations["border-left"], "3px solid var(--accent)");
    const lit = rules.find((rule) => rule.selector === ".msg.focus .bubble");
    assert.equal(lit.declarations.outline, "2px solid var(--accent)");
  });

  // A folded message is one line of its body, cut with an ellipsis: the line clamp, which cuts
  // across the blocks of the markdown where a nowrap would only cut the first, and it needs the
  // box display and the vertical orient to take. Every row that folds — to a session, from one,
  // or between two Workers — has a markdown body, so the one rule on `.md` is the whole clamp.
  it("clip a folded message to one line of its body, cut with an ellipsis", () => {
    const folded = rules.find((rule) => rule.selector === ".msg.collapsed .md");
    assert.ok(folded !== undefined, "the clamp is under the fold class, on the markdown body, and on nothing else");
    assert.equal(folded.declarations["-webkit-line-clamp"], "1", "one line, and an ellipsis where it is cut");
    assert.equal(folded.declarations.display, "-webkit-box");
    assert.equal(folded.declarations["-webkit-box-orient"], "vertical");
    assert.equal(folded.declarations.overflow, "hidden");
  });

  // The pointer is over a row with something under its fold — the mark the page sets once the
  // row is measured — folded or open, so the mouse says the row answers a click. A row of a fold
  // kind whose body fits its one line carries none: a double click would change nothing there.
  it("carry the pointer over the rows marked as having something to fold, and over no other row", () => {
    const pointing = (selector) => rules.some((rule) => rule.selector.split(",").map((part) => part.trim()).includes(selector) && rule.declarations.cursor === "pointer");
    assert.ok(pointing(".msg.foldable"), "a row with something under its fold carries the pointer");
    for (const other of [".msg", ".msg.user", ".msg.typed", ".msg.peer-in", ".msg.peer-out", ".msg.overheard", ".msg.perm", ".msg.collapsed"]) assert.ok(!pointing(other), `${other} carries no pointer of itself`);
  });

  it("make the stamp a click, and say so under the pointer", () => {
    const stamp = rules.find((rule) => rule.selector === ".meta .t");
    assert.equal(stamp.declarations.cursor, "pointer");
    const under = rules.find((rule) => rule.selector === ".meta .t:hover");
    assert.equal(under.declarations["text-decoration"], "underline dotted");
    assert.equal(under.declarations.color, "var(--fg)");
  });

  it("draw the User's row on the waiting ground, dashed and dimmed, until it is delivered, and its waiting words small and faint beside the label", () => {
    const bubble = rules.find((rule) => rule.selector === ".msg.pending .bubble");
    assert.equal(bubble.declarations.background, "var(--pending)");
    assert.equal(bubble.declarations["border-style"], "dashed");
    assert.equal(bubble.declarations.color, "var(--fg-dim)");
    assert.ok(rules.indexOf(bubble) > rules.indexOf(rules.find((rule) => rule.selector === ".msg.user .bubble")), "the waiting ground is declared after the User's, or it never shows on the User's row");
    const tag = rules.find((rule) => rule.selector === ".who .tag");
    assert.equal(tag.declarations.color, "var(--fg-faint)");
    assert.equal(tag.declarations["font-family"], "var(--mono)");
    assert.equal(tag.declarations["font-size"], ".72rem");
    assert.equal(tag.declarations["font-weight"], "400");
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

  // The stage is three grid columns: the Leader's in the middle, capped at 1092px, the Workers'
  // either side sharing what is left. A side column with a minimum of 0 is the first to go when
  // the window narrows — DevTools docked right is enough — while the middle keeps its 1092px. So
  // the side columns hold 406px each and it is the middle that gives way.
  it("hold the side columns at 406px and let the Leader's column give way", () => {
    const stage = rules.find((rule) => rule.selector === "#stage");
    assert.equal(stage.declarations["grid-template-columns"], "minmax(406px, 1fr) minmax(0, 1092px) minmax(406px, 1fr)");
  });

  // The copy button sits in the top-right corner of a code block, so the block is what it is
  // placed against; it is invisible until the block is hovered, or it has the focus, or it has
  // just copied — that state is the icon's own colour, and the tick in place of the clipboard.
  it("keep the copy button in a code block's corner, shown on hover and while it says copied", () => {
    assert.equal(rules.find((rule) => rule.selector === ".md pre").declarations.position, "relative");
    const copy = rules.find((rule) => rule.selector === ".md pre .copy");
    assert.equal(copy.declarations.position, "absolute");
    assert.equal(copy.declarations.top, "4px");
    assert.equal(copy.declarations.right, "4px");
    assert.equal(copy.declarations.opacity, "0");
    assert.deepEqual(rules.find((rule) => rule.selector === ".md pre:hover .copy, .md pre .copy:focus-visible, .md pre .copy.copied").declarations, { opacity: "1" });
    assert.equal(rules.find((rule) => rule.selector === ".md pre .copy.copied").declarations.color, "var(--ok)");
    assert.deepEqual(rules.find((rule) => rule.selector === ".md pre .copy .tick, .md pre .copy.copied .clip").declarations, { display: "none" });
    assert.deepEqual(rules.find((rule) => rule.selector === ".md pre .copy.copied .tick").declarations, { display: "inline" });
  });

  it("draw a tool line in the dim mono of a machine word", () => {
    const line = rules.find((rule) => rule.selector === ".rows .line");
    assert.equal(line.declarations.color, "var(--fg-dim)");
  });

  // The line that says what a seat is at is a tool line — the same look — held to exactly one
  // line whatever it says: a path that would wrap is cut with an ellipsis, so the row never
  // changes height as its words change.
  it("hold the line that says what a seat is at to exactly one line, cut with an ellipsis", () => {
    const doing = rules.find((rule) => rule.selector === ".rows .line.doing");
    assert.deepEqual(doing.declarations, { "white-space": "nowrap", overflow: "hidden", "text-overflow": "ellipsis" });
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

  // The User's own row says what became of it, from the words panels.mjs picks: waiting — the
  // words beside the label, on the dashed ground — until the server writes the row again as
  // delivered, when the row it has changes ground, the words leave the label and the glyph goes in
  // beside the stamp, fitted with it; the panel's state at the draw says whether the wait is a
  // queue behind the turn under way.
  it("draws the User's row waiting on the dashed ground until the server says delivered, then changes the row it has", () => {
    assert.match(script, /if \(shown\.kind === "user"\) \{\s*const said = delivery\(shown\.delivered, panel\.section\.classList\.contains\("busy"\), panel\.name\);\s*if \(said\.wait\) \{\s*const tag = document\.createElement\("span"\);\s*tag\.className = "tag";\s*tag\.textContent = said\.text;\s*who\.append\(tag\);\s*line\.classList\.add\("pending"\);\s*\} else \{\s*meta\.append\(deliveredElement\(said\)\);\s*\}\s*\}/);
    assert.match(script, /function deliveredElement\(said\) \{\s*const st = document\.createElement\("span"\);\s*st\.className = "st";\s*st\.dataset\.whole = said\.text;\s*st\.dataset\.glyph = said\.glyph;\s*st\.textContent = said\.text;\s*return st;\s*\}/);
    assert.match(script, /if \(shown\.kind === "user" && !shown\.delivered\) panel\.waiting\.set\(index, line\);/);
    assert.match(script, /function deliveredRow\(panel, index\) \{\s*const element = panel\.waiting\.get\(index\);\s*if \(element === undefined\) return;\s*panel\.waiting\.delete\(index\);\s*element\.classList\.remove\("pending"\);\s*element\.querySelector\("\.tag"\)\.remove\(\);\s*const time = element\.querySelector\("\.t"\);\s*time\.parentElement\.append\(deliveredElement\(delivery\(true, false, panel\.name\)\)\);\s*fitStamps\(\[time\]\);\s*\}/);
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

  // Reaching a reader who is not at the page: a browser notification, through the browser's own
  // system, for a card appearing on any panel and for the Leader's turn ending — read off the event
  // against the state before it is applied, and told after the draw. Never while the page is
  // visible, never with the switch off, never without the browser's permission; one per panel at
  // a time, since the tag is the seat; a click brings the page and the panel back. No sound of
  // the page's own.
  it("notifies through the browser on a card and on the Leader's reply, only while the page is not visible and the switch is on", () => {
    assert.match(script, /import \{[^}]*\bCARD\b[^}]*\bREPLY\b[^}]*\bnoticed\b[^}]*\} from "\.\/panels\.mjs"/);
    assert.match(script, /const data = JSON\.parse\(event\.data\);\s*(?:\/\/[^\n]*\n\s*)*const notice = noticed\(state, \{ name, data \}\);\s*applyEvent\(state, \{ name, data \}\);\s*draw\(\);\s*if \(notice !== null\) notified\(notice\);/, "read against the state before the event is applied, told after the draw");
    assert.match(script, /function notified\(\{ seat, kind \}\) \{\s*if \(document\.visibilityState === "visible" \|\| !notifyOn\(kind\)\) return;\s*if \(!\("Notification" in window\) \|\| Notification\.permission !== "granted"\) return;/);
    assert.match(script, /const body = kind === CARD \? `\$\{seat\} requires your action` : `\$\{seat\} finished their turn`;/, "the body names the seat and says which of the two it is");
    assert.match(script, /new Notification\(title\(state\), \{ body, tag: seat \}\)/, "one per panel at a time: the tag is the seat");
    assert.match(script, /shown\.addEventListener\("click", \(\) => \{\s*window\.focus\(\);\s*sections\.get\(seat\)\?\.section\.scrollIntoView\(\{ block: "nearest" \}\);\s*shown\.close\(\);/);
    assert.doesNotMatch(script, /new Audio\(|<audio|\.play\(\)/, "a sound of the page's own");
  });

  // The two switches, on the Leader's head after the theme toggle: the action-needed notification
  // and the end-of-turn notification, each on unless the browser's storage says off — and on when
  // there is no storage to ask. The browser's own permission is asked from the click that turns a
  // switch on, as browsers require, and from nowhere else: a page that asked at load would be a
  // page that asks on every visit.
  it("keeps the two switches on the Leader's head, on by default, in storage, and asks the browser only from a switch turned on", () => {
    assert.match(script, /headLine\.append\(themeToggle\);\s*headLine\.append\(notifySwitch\(CARD\), notifySwitch\(REPLY\)\);/);
    assert.match(script, /\[CARD\]: \{ key: "openovai-notify-action", label: "Action-needed notifications", icons: ALERT \+ ALERT_SLASHED, on: "Notifying when someone requires your action while this page is not visible — click to stop", off: "Not notifying when someone requires your action — click to start" \},/);
    assert.match(script, /\[REPLY\]: \{ key: "openovai-notify-turn", label: "End-of-turn notifications", icons: BELL \+ BELL_SLASHED, on: "Notifying when the Leader finishes a turn while this page is not visible — click to stop", off: "Not notifying when the Leader finishes a turn — click to start" \},/);
    assert.match(script, /function notifyOn\(kind\) \{\s*try \{ return localStorage\.getItem\(NOTIFY\[kind\]\.key\) !== "off"; \} catch \(error\) \{ return true; \}/, "on unless the store says off, and on when there is no store");
    assert.match(script, /try \{ localStorage\.setItem\(NOTIFY\[kind\]\.key, on \? "on" : "off"\); \} catch \(error\) \{\}/);
    assert.match(script, /if \(on && "Notification" in window && Notification\.permission === "default"\) Notification\.requestPermission\(\);/);
    assert.equal(script.match(/requestPermission/g).length, 1, "the browser is asked from the switch and nowhere else");
    assert.match(script, /button\.classList\.toggle\("on", on\);\s*button\.title = on \? NOTIFY\[kind\]\.on : NOTIFY\[kind\]\.off;/, "the tooltip says which way the switch is");
  });

  // Each switch is an icon button in the theme toggle's style — no word, an aria-label for the
  // name, 15px stroke icons — lit while on, and the same icon with a slash across it while off:
  // both drawings are in the DOM and the switch's state picks the one drawn, as the theme does
  // with the sun and the moon.
  it("draws each switch as an icon button in the theme toggle's style, lit while on and slashed while off", () => {
    assert.match(script, /button\.className = "notify";\s*button\.setAttribute\("aria-label", NOTIFY\[kind\]\.label\);\s*button\.innerHTML = NOTIFY\[kind\]\.icons;/, "an icon and a name, no word");
    for (const [name, cls] of [["ALERT", "lit"], ["ALERT_SLASHED", "slashed"], ["BELL", "lit"], ["BELL_SLASHED", "slashed"]]) {
      assert.match(script, new RegExp(`const ${name} = '<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">`), `${name} is a stroke icon under the ${cls} class`);
    }
    assert.match(script, /const ALERT = '<svg[^']*<circle cx="12" cy="12" r="9\.5"\/><path d="M12 7\.5v5\.5M12 16\.5h\.01"\/>/, "an exclamation mark in a circle");
    assert.match(script, /const ALERT_SLASHED = '<svg[^']*M3 3l18 18"\/>/, "the same, with a slash across it");
    assert.match(script, /const BELL_SLASHED = '<svg[^']*M1 1l22 22"\/>/, "the bell, with a slash across it");
    const notify = rules.find((rule) => rule.selector === ".phead .notify");
    assert.ok(notify !== undefined, "no rule for the switch");
    assert.equal(notify.declarations.cursor, "pointer");
    assert.equal(notify.declarations.border, "0");
    assert.equal(notify.declarations.width, "22px");
    assert.equal(notify.declarations.color, "var(--fg-faint)");
    assert.equal(rules.find((rule) => rule.selector === ".phead .notify.on")?.declarations.color, "var(--fg)", "lit while on");
    assert.equal(rules.find((rule) => rule.selector === ".phead .notify svg")?.declarations.width, "15px");
    assert.equal(rules.find((rule) => rule.selector === ".phead .notify .lit")?.declarations.display, "none", "the lit icon is not drawn while off");
    assert.equal(rules.find((rule) => rule.selector === ".phead .notify.on .lit")?.declarations.display, "block", "and is while on");
    assert.equal(rules.find((rule) => rule.selector === ".phead .notify.on .slashed")?.declarations.display, "none", "the slashed icon is not drawn while on");
  });

  // The pill: shown by a draw that appended rows while the reader was more than 80px above the
  // newest, gone once a scroll brings them near it or a click takes them there. It is a child of
  // the rows (sticky needs a scrolling ancestor) and their LAST child after every draw, or the
  // rows appended after it would carry it up into the middle of the panel.
  it("shows the pill when rows land below a reader who is not near the newest, and takes them there on a click", () => {
    assert.match(script, /const nearTheNewest = \(rows\) => rows\.scrollHeight - rows\.scrollTop - rows\.clientHeight < 80;/);
    assert.match(script, /\n      rows\.append\(jump\);\n/, "the pill is a child of the rows");
    assert.match(script, /panel\.shown = about\.rows\.length;\n(?:[^\n]*\n){61}      if \(panel\.jump !== null && panel\.jump !== panel\.rows\.lastElementChild\) panel\.rows\.append\(panel\.jump\);\n/, "the pill is put back last AFTER the rows are appended, before the scroll is decided");
    assert.match(script, /\} else if \(panel\.jump !== null && !near\) \{\s*panel\.jump\.classList\.add\("show"\);/);
    assert.match(script, /rows\.addEventListener\("scroll", \(\) => \{\s*if \(nearTheNewest\(rows\)\) jump\.classList\.remove\("show"\);/);
    assert.match(script, /jump\.addEventListener\("click", \(\) => \{\s*rows\.scrollTop = rows\.scrollHeight;\s*jump\.classList\.remove\("show"\);/);
  });

  // The line that says what a seat is at, while the server says it: one element, made once when
  // the word comes and taken out once it is gone — its text changed in place in between, never
  // a second element, so the rows never jump for it — kept the last row after whatever landed,
  // before the pill goes back. Its coming is a row landing; a change of its words is not.
  it("draws what a seat is at as one line, made once, changed in place, last among the rows, gone with the word", () => {
    const draw = script.slice(script.indexOf("function drawPanel(panel)"), script.indexOf("// ------------------------------------------------------------------------------- the page"));
    assert.match(draw, /if \(about\.doing === null\) \{\s*if \(panel\.doing !== null\) \{\s*panel\.doing\.remove\(\);\s*panel\.doing = null;\s*\}\s*\} else \{\s*if \(panel\.doing === null\) \{\s*panel\.doing = document\.createElement\("div"\);\s*panel\.doing\.className = "line doing";\s*landed = true;\s*\}\s*panel\.doing\.textContent = about\.doing;\s*if \(landed\) panel\.rows\.append\(panel\.doing\);\s*\}\s*\/\/[^\n]*\n\s*if \(panel\.jump !== null && panel\.jump !== panel\.rows\.lastElementChild\) panel\.rows\.append\(panel\.jump\);/);
    assert.equal(draw.match(/createElement\("div"\)/g).length, 1, "the draw makes the one element for what a seat is at, and no other");
    assert.match(script, /panel\.waiting\.clear\(\);\s*panel\.doing = null;/, "a panel drawn afresh forgets the line, which its rows no longer hold");
    assert.match(script, /waiting: new Map\(\), doing: null \};/, "a panel starts with no such line");
  });

  // Every panel follows its newest row or not, on its own: a word of the panel's, set from where
  // its rows stand on every scroll of them and nowhere else, true from the start. The draw pins a
  // panel to its newest when it follows and on its first draw; a panel that does not follow is
  // left exactly where the reader has it, whatever lands.
  it("leaves a panel that does not follow exactly where the reader has it when rows land", () => {
    assert.match(script, /const follows = panel\.shown === 0 \|\| panel\.view\.follow;/, "the draw asks the panel's own word, and pins on the first draw");
    const draw = script.slice(script.indexOf("function drawPanel(panel)"), script.indexOf("// ------------------------------------------------------------------------------- the page"));
    assert.equal(draw.match(/scrollTop =/g).length, 1, "the draw writes the scroll position in one place");
    assert.match(draw, /if \(follows\) \{\s*panel\.rows\.scrollTop = panel\.rows\.scrollHeight;\s*\}/, "and that place is under the panel's word");
    assert.doesNotMatch(draw, /panel\.rows\.scrollHeight - panel\.rows\.scrollTop - panel\.rows\.clientHeight < \d/, "the draw measures nothing itself: a box that grew hides the last lines, and a measure here would call a following panel gone");
  });

  // A scroll of the rows — a wheel, the bar, a key, the page pinning the newest — sets the word
  // from where the rows stand: at the newest row, within a few px, the panel follows; away from
  // it, it does not; back at it, it follows again, with nothing pressed.
  it("follows the newest row while the reader is at it, and lets go when they scroll away", () => {
    assert.match(script, /const atTheNewest = \(rows\) => rows\.scrollHeight - rows\.scrollTop - rows\.clientHeight < 4;/);
    assert.match(script, /const view = \{ follow: true \};/, "a panel follows from the start");
    assert.match(script, /rows\.addEventListener\("scroll", \(\) => \{\s*view\.follow = atTheNewest\(rows\);/, "every scroll of the rows sets the word from where they stand");
    assert.match(script, /return \{ name, section, [^}]*\bview\b[^}]*\};/, "the draw reads the same word the scroll sets");
  });

  // Typing never scrolls a panel that does not follow, and never engages it: nothing in the
  // composer — the box's key, input and submit handlers, the autosize — touches the rows' scroll
  // position. The one place the bottom area reaches the rows is the rows' own observer: whenever
  // they change size — a taller box, a card, a resized window — a panel that follows is pinned to
  // its newest, and one that does not is left where the reader has it. The scroll writes of the
  // whole script are counted, so a new one is a new sentence here.
  it("never scrolls a panel that does not follow on a key, a typed line, a send or a taller box", () => {
    const composer = script.slice(script.indexOf("const composer = document.createElement(\"form\");"), script.indexOf("const bottom = document.createElement(\"div\");"));
    assert.ok(composer.length > 500, "the composer was not found");
    assert.doesNotMatch(composer, /scrollTop|scrollIntoView|view\.follow =/, "the composer neither scrolls the rows nor sets the word");
    assert.match(script, /new ResizeObserver\(\(\) => \{[^}]*\n\s*if \(view\.follow\) rows\.scrollTop = rows\.scrollHeight;\s*\}\)\.observe\(rows\);/, "rows that changed size pin a panel to its newest only while it follows");
    assert.equal(script.match(/\.scrollTop = /g).length, 3, "three scroll writes: the pill's click, the rows' observer on a following panel, the draw on a following panel");
  });

  // While a panel follows, its head carries the follow class and one rule gives it a mark of
  // its own; the class is set from the word whenever the word is, and once at the start.
  it("marks the head of a panel that follows, and only then", () => {
    assert.match(script, /const showFollow = \(\) => headLine\.classList\.toggle\("follow", view\.follow\);/, "the class is the word, set or cleared with it");
    assert.match(script, /view\.follow = [^\n]*;\s*showFollow\(\);/, "set right after every scroll sets the word");
    assert.match(script, /\n    showFollow\(\);\n/, "and once at the start, when the panel follows before its first scroll");
    const following = rules.find((rule) => rule.selector === ".phead.follow").declarations;
    assert.ok(Object.keys(following).length > 0, "a following head has a mark of its own");
  });

  // The mark of a following head is the left border a clickable tool line carries — the same
  // width and the same colour token, on either theme, taken from that line's own rule; the head
  // keeps no ground of its own. The border is 1px wider than the head's, so the padding gives that
  // px back and the head's words stay where they are when the panel starts or stops following.
  it("mark the head of a following panel with the clickable line's left border", () => {
    const line = rules.find((rule) => rule.selector === ".rows .line.peer").declarations;
    const head = rules.find((rule) => rule.selector === ".phead").declarations;
    const following = rules.find((rule) => rule.selector === ".phead.follow").declarations;
    assert.equal(following["border-left"], line["border-left"], "the border is the clickable line's, as that rule has it");
    assert.equal(following["border-left"], "3px solid var(--accent)");
    assert.equal(following.background, undefined, "no ground of its own");
    assert.equal(head.border, "2px solid var(--line)");
    assert.equal(head.padding, "4px 10px 3px");
    assert.equal(following["padding-left"], "9px", "the head's 10px less the border's extra px");
  });

  // The stop glyph: in the composer, after the box; there while the turn can be stopped; a click
  // hides it and asks the server to stop the turn.
  it("puts the stop glyph in the box, shows it while the turn can be stopped, and stops the turn on a click", () => {
    assert.match(script, /stop\.className = "stop";[\s\S]{0,400}composer\.append\(box, stop\);/);
    assert.match(script, /panel\.stop\.hidden = !stopEnabled\(state, panel\.name\);/);
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
  // the label is the one part of the line that trims, so it is the label that says — and a status
  // beside it that has a glyph goes with it, the glyph alone where the stamp is the clock alone.
  // All stamps are set whole first and measured after, so a change of width costs one layout, not
  // one per row; measured for the rows a draw appends and for every row when the rows change width.
  it("gives a row's stamp up to the time alone where the whole day would cut the label, on append and on every change of width, and the status beside it up to its glyph", () => {
    assert.match(script, /time\.dataset\.whole = when\.whole;\s*time\.dataset\.clock = when\.clock;\s*time\.textContent = when\.whole;/);
    assert.match(script, /function fitStamps\(stamps\) \{\s*for \(const time of stamps\) setStamp\(time, false\);\s*const cut = \[\.\.\.stamps\]\.filter\(\(time\) => \{ const label = time\.parentElement\.querySelector\("\.lbl"\); return label\.scrollWidth > label\.clientWidth; \}\);\s*for \(const time of cut\) setStamp\(time, true\);\s*\}/);
    assert.match(script, /function setStamp\(time, short\) \{\s*time\.textContent = short \? time\.dataset\.clock : time\.dataset\.whole;\s*const st = time\.parentElement\.querySelector\("\.st"\);\s*if \(st !== null && st\.dataset\.glyph !== undefined\) st\.textContent = short \? st\.dataset\.glyph : st\.dataset\.whole;\s*\}/);
    assert.match(script, /new ResizeObserver\(\(\) => \{\s*fitStamps\(rows\.querySelectorAll\("\.t"\)\);/);
    assert.match(script, /if \(time !== null\) added\.push\(time\);\s*(?:[^\n]*\n)?\s*\}\s*fitStamps\(added\);\s*(?:fitFolds\(folded\);\s*)?panel\.shown = about\.rows\.length;/, "the appended rows are fitted once, after the loop");
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
  // click: the message is found on the Leader's panel by that id, opened, brought into view with
  // its label at the top — a message opened whole can be taller than the rows, and centred it
  // would start off-screen — and lit for a moment. A line that is nothing of the kind gets none of
  // it.
  it("marks the line of a message with its id and takes a click on it to the message on the Leader's panel, opened", () => {
    assert.match(script, /if \(shown\.msg !== undefined\) \{\s*line\.classList\.add\("peer"\);\s*line\.dataset\.msg = shown\.msg;\s*line\.onclick = \(\) => focusMessage\(shown\.msg\);\s*\}\s*return line;/);
    assert.match(script, /if \(shown\.msg !== undefined\) line\.dataset\.msg = shown\.msg;/, "a bubble carries the id too, for the click to find");
    assert.match(script, /function focusMessage\(id\) \{\s*const leader = sections\.get\(state\.leader\);\s*const found = leader === undefined \? null : leader\.rows\.querySelector\(`\.msg\[data-msg="\$\{id\}"\]`\);\s*if \(found === null\) return;\s*found\.classList\.remove\("collapsed"\);\s*found\.scrollIntoView\(\{ block: "start" \}\);/, "opened before it is brought into view, so the scroll is to the row as it will stand");
    assert.match(script, /found\.classList\.add\("focus"\);\s*setTimeout\(\(\) => found\.classList\.remove\("focus"\), FOCUS_FOR\);/);
    assert.match(script, /const FOCUS_FOR = 1500;/);
  });

  // A message on the Leader's panel, to a session or from one, is folded as its row is built —
  // a class on the row, nothing measured, nothing stored, so a fresh page folds every one.
  it("folds a message to a session or from one as its row is built", () => {
    assert.match(script, /\n      line\.classList\.add\("collapsed"\);\n/, "the fold is a class on the row");
    assert.match(script, /line\.classList\.add\("collapsed"\);(?:[^\n]*\n)+?\s*return line;\s*\}\s*\n\s*\/\/ The copy button/, "set in rowElement, on the row before it is returned");
    assert.doesNotMatch(script, /localStorage[^\n]*collapsed|collapsed[^\n]*localStorage/, "nothing about the fold is stored");
  });

  // A double click on a row with something under its fold opens it, and the next folds it again;
  // a row whose body fits answers no double click, since there is nothing to open. A single click
  // does nothing to a row — it is what selects a word, and the stamp's click points at the row —
  // and there is no word under the row that opens it.
  it("opens a folded message on a double click, folds it again on the next, and on nothing else", () => {
    assert.match(script, /line\.addEventListener\("dblclick", \(\) => \{\n\s*if \(line\.classList\.contains\("foldable"\)\) line\.classList\.toggle\("collapsed"\);\n\s*\}\);/, "the toggle, under the mark of something to fold");
    assert.doesNotMatch(script, /(?:addEventListener\("click"|onclick)[^\n]*collapsed/, "a single click never folds or opens a row");
    assert.doesNotMatch(script, /show all|collapsible\(|"more"/, "no word under the row opens it");
  });

  // Whether a folded row has anything under its fold is measured once the row is on the page —
  // its body taller than the one line it is clamped to, or not — for the rows a draw appended,
  // and again for every folded row at each change of the rows' size, as the stamps are: a body
  // that fit one width may not fit another. The mark is a class on the row, the one the pointer
  // rule is under; a row already open keeps the mark it was opened with. A row folded behind a
  // placeholder has the whole message under its fold by construction: its body is not drawn, so
  // it measures nothing, and the mark is by the class.
  it("marks a folded row as having something to fold by its clamped body's overflow, once it is on the page and at every change of the rows' size", () => {
    assert.match(script, /function fitFolds\(folded\) \{\n\s*for \(const row of folded\) \{\n\s*if \(!row\.classList\.contains\("collapsed"\)\) continue;\n\s*const body = row\.querySelector\("\.md"\);\n\s*row\.classList\.toggle\("foldable", row\.classList\.contains\("placeholder"\) \|\| body\.scrollHeight > body\.clientHeight\);/, "the clamped body's scroll height against its client height, on the folded rows alone — and a row behind a placeholder by its class");
    assert.match(script, /if \(line\.classList\.contains\("collapsed"\)\) folded\.push\(line\);\n(?:[^\n]*\n)*?\s*fitFolds\(folded\);\n\s*panel\.shown = about\.rows\.length;/, "the rows a draw appended are measured after they are on the page, once, after the loop");
    assert.match(script, /new ResizeObserver\(\(\) => \{\n(?:[^\n]*\n)*?\s*fitFolds\(rows\.querySelectorAll\("\.msg\.collapsed"\)\);/, "and every folded row again when the rows change size");
  });

  // A message between sessions is folded — to the Leader, from the Leader, or between two Workers
  // and overheard. What the User typed on a panel and what the User typed to a Worker are shown
  // whole: the renderer gives them other kinds, and the fold is under the three kinds alone.
  it("folds what one Worker said to another like a message to a session or from one, and shows the User's words whole", () => {
    assert.match(script, /line\.append\(bubble\);\n    if \(shown\.kind === "peer-in" \|\| shown\.kind === "peer-out" \|\| shown\.kind === "overheard"\) \{\n/, "the fold is under the three kinds of a message between sessions, and nothing else");
    const names = { chat: "Server", seat: "Bobby", leader: "Bobby", user: "Copter" };
    const folded = new Set(["peer-in", "peer-out", "overheard"]);
    assert.equal(row({ from: "Bobby", to: "Tom", msg: "m1", text: "go" }, names).kind, "peer-out");
    assert.equal(row({ from: "Tom", to: "Bobby", msg: "m2", text: "done" }, names).kind, "peer-in");
    assert.equal(row({ from: "Eva", to: "Sam", overheard: true, msg: "m3", text: "hi" }, names).kind, "overheard");
    for (const entry of [{ from: "user", text: "hi" }, { from: "user", typedTo: "Tom", text: "hi" }]) {
      const shown = row(entry, names);
      assert.ok(!folded.has(shown.kind), `${shown.who} is drawn as ${shown.kind}, a kind the page folds`);
    }
  });

  // A message whose markdown opens with something other than a paragraph — a table, a list, a
  // code block, a heading, a quote, a rule — has no first line the clamp could show: a table
  // clamped to one line drew whole and would not fold. The renderer decides it on the markdown
  // source, by the first non-blank line, and the page folds such a row behind a placeholder in the
  // meta's style in place of the body; the row is foldable by construction, and a double click
  // opens the whole rendered markdown as on any other row. Nothing is stripped, nothing cut.
  it("folds a message that opens with a table, a list, a code block, a heading, a quote or a rule behind a placeholder, and keeps it foldable", () => {
    const names = { chat: "Server", seat: "Bobby", leader: "Bobby", user: "Copter" };
    const table = "| a | b |\n|---|---|\n| 1 | 2 |";
    for (const text of [table, "- one\n- two", "* one", "+ one", "1. one", "12) twelve", "# Title", "###### Small", "> quoted", "```js\nx\n```", "~~~\nx\n~~~", "---", "***", "___", `\n\n  ${table}`]) {
      assert.equal(row({ from: "Tom", to: "Bobby", msg: "m2", text }, names).placeholder, true, `${JSON.stringify(text)} opens with a block, not a paragraph`);
    }
    for (const text of ["go", "**bold** first", "*em* first", "#tag", "-dash", "2024 was the year", "hi\n\n| a |\n|---|", "", "\n\n"]) {
      assert.equal(row({ from: "Tom", to: "Bobby", msg: "m2", text }, names).placeholder, false, `${JSON.stringify(text)} opens with a paragraph, or nothing`);
    }
    assert.equal(row({ from: "Bobby", to: "Tom", msg: "m1", text: table }, names).placeholder, true, "a message the Leader sent");
    assert.equal(row({ from: "Eva", to: "Sam", overheard: true, msg: "m3", text: table }, names).placeholder, true, "one overheard");
    assert.equal(row({ from: "Bobby", text: table }, names).placeholder, undefined, "a reply is never folded, so it carries no placeholder");
    assert.equal(row({ from: "user", text: table }, names).placeholder, undefined);
    assert.match(script, /line\.addEventListener\("dblclick", \(\) => \{\n(?:[^\n]*\n)*?\s*\}\);\n\s*(?:\/\/[^\n]*\n\s*)*if \(shown\.placeholder === true\) \{\n\s*line\.classList\.add\("placeholder"\);\n\s*const fold = document\.createElement\("div"\);\n\s*fold\.className = "fold";\n\s*fold\.textContent = "\(double-click to see the whole message\)";\n\s*bubble\.append\(fold\);\n\s*\}\n\s*\}/, "under the fold of a message between sessions: the mark on the row, the placeholder after the body");
    assert.deepEqual(rules.find((rule) => rule.selector === ".msg .fold")?.declarations, { display: "none", "font-size": ".72rem", color: "var(--fg-faint)", "font-family": "var(--mono)" }, "the meta's style, and not drawn on a row that shows its first line");
    assert.deepEqual(rules.find((rule) => rule.selector === ".msg.collapsed.placeholder .md")?.declarations, { display: "none" }, "the body is not drawn while the row is folded");
    assert.deepEqual(rules.find((rule) => rule.selector === ".msg.collapsed.placeholder .fold")?.declarations, { display: "block" }, "the placeholder is, and only then");
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
    assert.match(script, /if \(shown\.kind === "line" && shown\.msg === undefined && panel\.last !== null && panel\.last\.text === shown\.text\) \{\s*panel\.last\.count \+= 1;\s*panel\.last\.n\.textContent = ` ×\$\{panel\.last\.count\}`;\s*landed = true;\s*panel\.lines\.set\(index, panel\.last\.el\);\s*continue;/);
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

  // A following panel is pinned to its newest on any row that landed — a bubble, a pill, a tool
  // line, a repeated call that only grew a counter — and the stamps list is for the fitter alone:
  // a tool line has no stamp, and a draw that brings tool lines only would leave a following
  // panel short of its end, where the next scroll of the rows would let it go.
  it("pins a following panel on any row that landed, a tool line and a counter too, never on the stamps alone", () => {
    const draw = script.slice(script.indexOf("function drawPanel(panel)"), script.indexOf("// ------------------------------------------------------------------------------- the page"));
    assert.match(draw, /let landed = false;\s*panel\.empty\.hidden = about\.rows\.length > 0;\s*const added = \[\];\s*const folded = \[\];\s*if \(about\.rows\.length > panel\.shown\) \{/, "the word is set before any row is drawn, beside the stamps list and the folded list");
    assert.match(draw, /panel\.last\.n\.textContent = ` ×\$\{panel\.last\.count\}`;\s*landed = true;/, "a counter that grew is a row that landed");
    assert.match(draw, /panel\.rows\.append\(line\);\s*landed = true;/, "an element appended is a row that landed");
    assert.match(draw, /if \(landed\) \{\s*if \(follows\) \{\s*panel\.rows\.scrollTop = panel\.rows\.scrollHeight;/, "the pin hangs on the word");
    assert.doesNotMatch(draw, /if \(added\.length > 0\)/, "the stamps list decides the scroll");
  });

  // A question is a card in the panel's bottom area, right above the composer — always in sight,
  // on the Leader's panel and a Worker's alike — and never among the rows: its coming is no
  // reason to scroll them, on a panel that follows or one that does not. The draw decides the
  // scroll on the rows it appended and on nothing else; what a taller bottom area does to a
  // following panel is the rows' observer's business. A card stands while its question does:
  // rows drawn again from nothing leave it where it is, since it was never one of them.
  it("draws a question as a card in the bottom area above the composer, and never scrolls the rows for it", () => {
    assert.match(script, /const card = question\(panel\.name, request\);\s*panel\.drawn\.set\(request\.id, card\);\s*panel\.cards\.append\(card\);/);
    assert.doesNotMatch(script, /panel\.rows\.append\(card\)/, "a card among the rows");
    const draw = script.slice(script.indexOf("function drawPanel(panel)"), script.indexOf("// ------------------------------------------------------------------------------- the page"));
    assert.match(draw, /if \(landed\) \{\s*if \(follows\) \{\s*panel\.rows\.scrollTop = panel\.rows\.scrollHeight;\s*\} else if \(panel\.jump !== null && !near\) \{\s*panel\.jump\.classList\.add\("show"\);/, "the scroll is decided on what landed in the rows, and on nothing else");
    assert.doesNotMatch(draw, /asked/, "a card is counted as something that landed in the rows");
    assert.doesNotMatch(script, /panel\.drawn\.clear\(\)/, "rows drawn again from nothing forget their cards, which stand in the bottom area and would be drawn twice");
    assert.equal(rules.find((rule) => rule.selector === ".cards").declarations["overflow-y"], "auto", "a stack of cards scrolls inside the bottom area");
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

  // The desk title reaches the page in the seat's `about`, and the page used to hang it on the
  // panel as a tooltip. Nothing on the page shows it now: no title on the panel's section.
  it("hangs no tooltip on a panel", () => {
    assert.doesNotMatch(script, /section\.title = /, "a panel carries a tooltip");
  });

  // A copy button on every fenced code block a reply draws, and one click handler on the rows
  // for all of them: the click finds the button, copies the code inside its block — the code
  // element, never the button's own markup — and says copied on the button for a moment.
  it("puts a copy button on every code block and copies the block's code on one delegated click", () => {
    assert.match(script, /body\.innerHTML = shown\.html;\s*if \(shown\.tight === true\) body\.classList\.add\("tight"\);\s*for \(const block of body\.querySelectorAll\("pre"\)\) block\.append\(copyButton\(\)\);/);
    assert.match(script, /rows\.addEventListener\("click", \(event\) => \{\s*const copy = event\.target\.closest\(".copy"\);\s*if \(copy === null\) return;\s*const block = copy\.parentElement;\s*navigator\.clipboard\.writeText\(\(block\.querySelector\("code"\) \?\? block\)\.textContent\)\.then\(\(\) => \{\s*copy\.classList\.add\("copied"\);\s*setTimeout\(\(\) => copy\.classList\.remove\("copied"\), COPIED_FOR\);/);
    assert.match(script, /function copyButton\(\) \{\s*const button = document\.createElement\("button"\);\s*button\.type = "button";\s*button\.className = "copy";/);
  });

  it("draws a reply's markdown as elements — a link, a code span — never as the words of the markup", () => {
    const shown = row({ from: "Ray", text: "see [it](https://x.y/z) in `code`" }, { chat: "Server" });
    assert.match(shown.html, /<a href="https:\/\/x\.y\/z"[^>]*>it<\/a>/);
    assert.match(shown.html, /<code>code<\/code>/);
    assert.match(script, /body\.className = "md";\s*body\.innerHTML = shown\.html;/, "the reply body is not filled with its markup under .md");
    assert.doesNotMatch(script, /textContent = shown\.html/, "a reply's markup pasted as text");
  });
});
