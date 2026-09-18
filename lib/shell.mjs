// How a shell command is read here: where it is cut into sides, which words are the shell's own
// rather than a program's, what a program's name may look like, and what a Bash rule in the
// settings holds. Two readers share this — the permission card, which offers a rule per side
// (lib/chat/permissions.mjs), and the hook that lets a compound of allowed sides through
// (lib/hooks/compound.mjs) — and a command that reads as two sides to one must read as two sides to
// the other, or a rule the card offered is one the hook does not honour.

// Where a command is cut: `||`, `&&`, `|&`, `;`, `|`, a newline, and a background `&` that is not
// part of a redirection (`&>`, `>&`). Longest first, so `||` is never read as two pipes.
const SEPARATORS = ["||", "&&", "|&", ";", "|", "\n", "&"];

// The separator that starts at one place in the text, or null.
function separatorAt(text, at) {
  for (const separator of SEPARATORS) {
    if (!text.startsWith(separator, at)) {
      continue;
    }
    if (separator === "&" && (text[at + 1] === ">" || text[at - 1] === ">" || text[at - 1] === "<")) {
      return null;
    }
    return separator;
  }
  return null;
}

// The shell's reserved words: a side that starts with one is not a command but a piece of one.
export const RESERVED = new Set(["for", "do", "done", "while", "until", "if", "then", "else", "elif", "fi", "case", "esac", "select", "function", "in", "time", "coproc", "{", "}", "!", "[[", "]]"]);

// A first word a rule can name: a bare name, no slash, tilde, dollar or quote in it.
export const BARE_WORD = /^[A-Za-z0-9_.-]+$/;

// git is judged by its subcommand, and the subcommand has to be a word.
export const GIT_SUBCOMMAND = /^[a-z][a-z-]*$/;

// The command cut into its sides, each trimmed, in the order written. A separator inside quotes
// is text — `git commit -m "a; b"` is one side — and a backslash keeps the character after it. An
// empty side is only allowed after a separator that ends a command rather than joining one to the
// next — `a;` and `a &` are whole, `a &&` is not — and a command that is not whole, or that
// leaves a quote open, is nothing (null).
export function sidesOf(command) {
  const text = String(command).trim();
  const sides = [];
  let side = "";
  let quote = null;
  let before = null;

  const cut = (separator) => {
    const trimmed = side.trim();
    side = "";
    if (trimmed === "") {
      if (before !== ";" && before !== "&" && before !== "\n") {
        return false;
      }
    } else {
      sides.push(trimmed);
    }
    before = separator;
    return true;
  };

  let at = 0;
  while (at < text.length) {
    const char = text[at];
    if (char === "\\" && quote !== "'") {
      side += char + (text[at + 1] ?? "");
      at += 2;
      continue;
    }
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      }
      side += char;
      at += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      side += char;
      at += 1;
      continue;
    }
    const separator = separatorAt(text, at);
    if (separator === null) {
      side += char;
      at += 1;
      continue;
    }
    if (!cut(separator)) {
      return null;
    }
    at += separator.length;
  }
  if (quote !== null || !cut(null)) {
    return null;
  }
  return sides;
}

// The Bash rules in a list, each as a test of one side of a command: a prefix rule (`:*` or ` *`
// after the prefix) holds the side that is the prefix or starts with it and a space; any other
// rule holds the side that is exactly the command it names. Rules for other tools hold nothing.
export function holdersOf(rules) {
  if (!Array.isArray(rules)) {
    return [];
  }
  return rules.flatMap((rule) => {
    const named = /^Bash\((.+)\)$/.exec(String(rule))?.[1];
    if (named === undefined) {
      return [];
    }
    const prefix = /^(.+?)(?::\*| \*)$/.exec(named)?.[1];
    if (prefix !== undefined) {
      return [(side) => side === prefix || side.startsWith(`${prefix} `)];
    }
    return [(side) => side === named];
  });
}
