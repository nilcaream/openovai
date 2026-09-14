// The page's stylesheet, read as rules: the token table per theme, no colour outside it, a rule
// for every class the page emits and no rule for a class it never does. The page is read as text
// and never run here, and the stylesheet is parsed rather than grepped, so a check is about a rule
// and its value rather than about a string being somewhere in the file. Every mutation in
// tests/mutations-page.json names the check it was written to redden.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { repo, styleRules } from "./helpers.mjs";

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
// (`kind: "…"` in render.mjs), and the classes the markup outside the script carries. The dialog
// lines' kinds (`shown.className = kind`, from dialog.mjs) are not read: no rule styles them, and the
// dead-selector check is what says so the day one does.
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

// A class the page emits without a rule of its own: a reply row is drawn as .md and takes its
// defaults. The check keeps this list honest by refusing a rule for a name on it.
const UNSTYLED = new Set(["reply"]);

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
});
