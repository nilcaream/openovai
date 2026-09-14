// The page's stylesheet, read as rules: the token table per theme, no colour outside it, no token
// outside the table, a rule for every class the page emits, no rule for a class it never
// does and no selector on an attribute the script never sets. The page is read as text
// and never run here, and the stylesheet is parsed rather than grepped, so a check is about a rule
// and its value rather than about a string being somewhere in the file. Every mutation in
// tests/mutations-page.json names the check it was written to redden.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { repo, styleRules } from "./helpers.mjs";
import { row } from "../tools/chat/render.mjs";

const source = fs.readFileSync(path.join(repo, "tools", "chat", "page.html"), "utf8");
const script = source.slice(source.indexOf("<script"), source.indexOf("</script>"));
const rules = styleRules(source);
const tokens = JSON.parse(fs.readFileSync(path.join(repo, "tests", "page-tokens.json"), "utf8"));

// A token block is a rule that declares custom properties. The light one is bare :root; the dark
// one is the second, whatever selector or query it sits under.
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
  const render = fs.readFileSync(path.join(repo, "tools", "chat", "render.mjs"), "utf8");
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
  it("declares the light tokens in bare :root and the dark ones in the second token block, each with its colour-scheme", () => {
    assert.equal(tokenBlocks.length, 2, "two token blocks, light then dark");
    const [light, dark] = tokenBlocks;
    assert.equal(light.selector, ":root");
    assert.equal(light.media, null);
    assert.deepEqual(only(light.declarations, isToken), tokens.light);
    assert.equal(light.declarations["color-scheme"], "light");
    assert.deepEqual({ ...tokens.light, ...only(dark.declarations, isToken) }, tokens.dark);
    assert.equal(dark.declarations["color-scheme"], "dark");
  });

  it("colours the installed app's title bar with the light panel head", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(repo, "tools", "chat", "manifest.webmanifest"), "utf8"));
    assert.equal(manifest.theme_color, tokens.light["--panel-2"]);
  });
});

describe("the rules", () => {
  it("set the page's type in rem on the sans stack, one and a half lines high", () => {
    const body = rules.find((rule) => rule.selector === "body" && rule.media === null);
    assert.equal(body.declarations.font, "1rem/1.5 var(--sans)");
  });

  it("mark a panel whose process is gone with a red dot on its head", () => {
    const dot = rules.find((rule) => rule.selector === ".panel.dimmed .phead .name::before");
    assert.equal(dot.declarations.background, "var(--bad)");
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
  it("stamps a row with the reader's own day and time, the weekday written out, on a 24-hour clock", () => {
    const options = [...script.matchAll(/new Intl\.DateTimeFormat\("en-GB", \{([^}]*)\}\)/g)].map(([, inside]) => inside);
    assert.equal(options.length, 2, "one formatter for the row's stamp and one for the day pill");
    const [stamp, day] = options;
    assert.match(stamp, /\bweekday: "long"/);
    assert.match(stamp, /\bhourCycle: "h23"/);
    assert.match(day, /\bweekday: "short"/);
    for (const inside of options) assert.doesNotMatch(inside, /timeZone/, "a zone of the page's own instead of the reader's");
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
  // not in the literal list chat.test.mjs pins.
  it("says in the empty box whom a message reaches and which key sends it", () => {
    assert.match(script, /box\.placeholder = `Message \$\{name\} — Enter sends, Shift\+Enter for a new line`/);
  });

  // The page is never run here, so the proof is in two halves: the renderer turns a reply into
  // markup that carries elements, and the page hands that markup to the body as markup — the one
  // place a reply's HTML is parsed. Pasted as text, a link would read as its brackets.
  it("draws a reply's markdown as elements — a link, a code span — never as the words of the markup", () => {
    const shown = row({ from: "Ray", text: "see [it](https://x.y/z) in `code`" }, { chat: "the chat" });
    assert.match(shown.html, /<a href="https:\/\/x\.y\/z"[^>]*>it<\/a>/);
    assert.match(shown.html, /<code>code<\/code>/);
    assert.match(script, /body\.className = "md";\s*body\.innerHTML = shown\.html;/, "the reply body is not filled with its markup under .md");
    assert.doesNotMatch(script, /textContent = shown\.html/, "a reply's markup pasted as text");
  });
});
