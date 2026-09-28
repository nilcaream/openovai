// Secrets masked out of text the server writes down: the rows of `runtime.log` and of every panel
// conversation, where a session's Bash command lands whole, and the permission rules admin mode
// reports to the Leader.
//
// Best-effort, by shape: a short list of patterns for the well-known kinds of token, each
// replacing only the secret part with MASK, so the command around it still reads. What it cannot
// catch is anything without a shape — a password passed positionally (`mysql -p hunter2`,
// `sshpass hunter2`), a token in a variable or a file name that says nothing, a secret split across
// lines or encoded, a vendor prefix not on the list. A secret-looking name catches its value
// whatever the value is, so `--max-tokens=100` is masked too: a lost number is the cheaper mistake.
//
// The token shapes are the prepush piicheck's, with its minimum lengths; its placeholder and
// entropy refinements are not taken, since they grade a hit for a person to judge and a masker
// has nobody to ask.

export const MASK = "***";

// A name that says its value is a secret: `token`, `api_key`, `GITHUB_TOKEN`, `client-secret`,
// `password`, `key`, `X-Api-Key`.
const NAME = "[A-Za-z0-9_.-]*(?:token|secret|passw(?:or)?d|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)[A-Za-z0-9_-]*|(?:[A-Za-z0-9_.-]*[_.-])?key";
// A value, up to the next space, quote or shell separator — and never one that starts with `*`, so
// a permission rule's `secrets:*` stays a rule.
const VALUE = "[^\\s\"'`&|;,)*][^\\s\"'`&|;,)]*";

// A value that is a secret by its own shape, wherever it stands.
const SHAPES = [
  // Well-known prefixed tokens.
  ["an Anthropic or OpenAI key", /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, MASK],
  ["a GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,})/g, MASK],
  ["a GitLab token", /\bglpat-[A-Za-z0-9_-]{20,}/g, MASK],
  ["a Slack token", /\bxox[abprse]-[A-Za-z0-9-]{10,}/g, MASK],
  ["an AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, MASK],
  ["a Google API key", /\bAIza[0-9A-Za-z_-]{35}/g, MASK],
  ["an npm token", /\bnpm_[A-Za-z0-9]{36}/g, MASK],
  ["a JWT", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, MASK],
  // An Authorization header's value, whatever its scheme, and a Bearer value anywhere.
  ["an Authorization header", /(\bauthorization["']?[ \t]*[:=][ \t]*(?:bearer[ \t]+|basic[ \t]+|token[ \t]+)?)[^\s"'`]+/gi, `$1${MASK}`],
  ["a Bearer value", /(\bbearer[ \t]+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${MASK}`],
  // A URL's userinfo: the password of `user:pass@`, and a lone user long enough to be a token.
  ["a URL password", /(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@'"`]+:)[^/\s@'"`]+@/gi, `$1${MASK}@`],
  ["a URL token user", /(\b[a-z][a-z0-9+.-]*:\/\/)[A-Za-z0-9_-]{20,}@/gi, `$1${MASK}@`],
];

// A value that is a secret by the name before it: `NAME=value`, `NAME: value`, `"name": "value"`,
// `?key=value` — and a flag followed by its value. For commands only: in prose `key:` and
// `secret:` are words, and the word after them is not a secret ("public key: HTTP 403").
// The name and its value are on one line: a line ending in `secret:` does not take the next
// line's `-` for its value.
const NAMED = [
  ["a secret assignment", new RegExp(`(\\b(?:${NAME})["']?[ \\t]*[=:][ \\t]*["']?)${VALUE}`, "gi"), `$1${MASK}`],
  ["a secret flag", new RegExp(`((?:^|\\s)--?(?:${NAME})[ \\t]+["']?)(?!-)${VALUE}`, "gi"), `$1${MASK}`],
];

export const PATTERNS = [...SHAPES, ...NAMED];

function masked(text, patterns) {
  return patterns.reduce((text_, [, pattern, replacement]) => text_.replace(pattern, replacement), String(text));
}

// A command: a Bash line, a card's, a permission rule, a row of runtime.log.
export function mask(text) {
  return masked(text, PATTERNS);
}

// What a session or the User wrote in words: a token is masked by its shape, never by a name.
export function maskProse(text) {
  return masked(text, SHAPES);
}
