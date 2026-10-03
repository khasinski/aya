// Just enough shell word splitting to find a command's leading `NAME=value`
// assignments and its options, quotes and backslash escapes included.

export interface ShellWord {
  /** Quotes removed. */
  text: string;
  start: number;
  end: number;
}

/** The words of one simple command, quotes (and shellQuote's '\'') resolved;
 *  null when it chains, redirects, substitutes or leaves a quote open. */
export function simpleShellWords(command: string): ShellWord[] | null {
  const words: ShellWord[] = [];
  let i = 0;
  while (i < command.length) {
    if (/\s/.test(command[i])) {
      i += 1;
      continue;
    }
    const start = i;
    let text = "";
    while (i < command.length && !/\s/.test(command[i])) {
      const ch = command[i];
      if (ch === "'") {
        const close = command.indexOf("'", i + 1);
        if (close < 0) return null;
        text += command.slice(i + 1, close);
        i = close + 1;
      } else if (ch === '"') {
        i += 1;
        while (i < command.length && command[i] !== '"') {
          if (command[i] === "\\" && '"\\$`'.includes(command[i + 1] ?? "")) i += 1;
          text += command[i];
          i += 1;
        }
        if (i >= command.length) return null;
        i += 1;
      } else if (ch === "\\") {
        text += command[i + 1] ?? "";
        i += 2;
      } else if (";&|<>`".includes(ch) || (ch === "$" && command[i + 1] === "(")) {
        return null;
      } else {
        text += ch;
        i += 1;
      }
    }
    words.push({ text, start, end: i });
  }
  return words;
}

function endOfShellToken(s: string, start: number): number {
  let quote: "'" | '"' | null = null;
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i];
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < s.length) {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "\\" && i + 1 < s.length) {
      i += 1;
      continue;
    }
    if (/\s/.test(ch)) return i;
  }
  return s.length;
}

/** The leading assignments, where the last one ends, and where the command
 *  after them starts (`command.length` when there is none). */
export function leadingEnvAssignments(command: string): {
  assignments: string[];
  end: number;
  rest: number;
} {
  const assignments: string[] = [];
  let pos = Math.max(command.search(/\S/), 0);
  let end = pos;
  while (pos < command.length) {
    const tokenEnd = endOfShellToken(command, pos);
    const token = command.slice(pos, tokenEnd);
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) break;
    assignments.push(token);
    end = tokenEnd;
    pos = tokenEnd;
    while (pos < command.length && /\s/.test(command[pos])) pos += 1;
  }
  return { assignments, end, rest: pos };
}

/** A command split at its program: the text before it (assignments, `exec`), the assignments, and the program with its arguments. */
export function splitProgram(command: string): { lead: string; assignments: string[]; program: string } {
  const trimmed = command.trim();
  const { assignments, rest } = leadingEnvAssignments(trimmed);
  const exec = /^exec\s+/.exec(trimmed.slice(rest))?.[0] ?? "";
  return { lead: trimmed.slice(0, rest) + exec, assignments, program: trimmed.slice(rest + exec.length) };
}

/** The words of `s`, quotes kept, split where the shell would split them. */
export function shellTokens(s: string): string[] {
  const tokens: string[] = [];
  let pos = 0;
  for (;;) {
    while (pos < s.length && /\s/.test(s[pos])) pos += 1;
    if (pos >= s.length) return tokens;
    const end = endOfShellToken(s, pos);
    tokens.push(s.slice(pos, end));
    pos = end;
  }
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*/;

function expandDollar(word: string, i: number, env: Record<string, string | undefined>): [string, number] {
  const braced = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}/.exec(word.slice(i));
  if (braced) return [env[braced[1]] ?? "", i + braced[0].length];
  const name = NAME.exec(word.slice(i + 1));
  if (name) return [env[name[0]] ?? "", i + 1 + name[0].length];
  const next = word[i + 1];
  if (next === undefined || !"({$?!#@*-0123456789".includes(next)) return ["$", i + 1];
  throw new Error(`unsupported shell expansion in ${word}`);
}

export function expandWord(word: string, env: Record<string, string | undefined>): string {
  let out = "";
  let i = 0;
  if (/^~(?:\/|$)/.test(word)) {
    out = env.HOME ?? "~";
    i = 1;
  }
  while (i < word.length) {
    const ch = word[i];
    if (ch === "'") {
      const end = word.indexOf("'", i + 1);
      if (end < 0) throw new Error(`unclosed quote in ${word}`);
      out += word.slice(i + 1, end);
      i = end + 1;
    } else if (ch === '"') {
      i += 1;
      while (word[i] !== '"') {
        if (i >= word.length || word[i] === "`") throw new Error(`unsupported word ${word}`);
        if (word[i] === "\\" && '"\\$`'.includes(word[i + 1] ?? "")) {
          out += word[i + 1];
          i += 2;
        } else if (word[i] === "$") {
          const [value, next] = expandDollar(word, i, env);
          out += value;
          i = next;
        } else {
          out += word[i];
          i += 1;
        }
      }
      i += 1;
    } else if (ch === "\\") {
      out += word[i + 1] ?? "";
      i += 2;
    } else if (ch === "$") {
      const [value, next] = expandDollar(word, i, env);
      out += value;
      i = next;
    } else if (ch === "`") {
      throw new Error(`unsupported command substitution in ${word}`);
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/** The word as the shell passes it on, with `env` as its variables (none set by
 *  default); as written when it would need the shell to run code. */
export function unquoteWord(word: string, env: Record<string, string | undefined> = {}): string {
  try {
    return expandWord(word, env);
  } catch {
    return word;
  }
}

/** `base` plus the assignments' values as the shell would expand them; throws
 *  on anything that would need the shell to run code (`$(…)`, backticks). */
export function envWithAssignments(
  base: Record<string, string | undefined>,
  assignments: string[],
): Record<string, string | undefined> {
  const env = { ...base };
  for (const token of assignments) {
    const eq = token.indexOf("=");
    env[token.slice(0, eq)] = expandWord(token.slice(eq + 1), env);
  }
  return env;
}

// A literal directory: no expansion but a leading `~/`, not an option.
const CD_LEAD = /^\s*cd\s+((?!-|~[^/\s&])(?:'[^']*'|"[^"$`\\]*"|[^\s&;|()<>$`'"\\])+)\s*&&\s*/;

/** `cd <dir> && ` in front of a program; null without one, or when the directory is not a literal.
 *  Callers recurse for a chain of them. */
export function cdLead(command: string): { dir: string; at: number } | null {
  const m = CD_LEAD.exec(command);
  return m && { dir: unquoteWord(m[1]), at: m[0].length };
}

const EXEC_WRAPPERS = new Set(["time", "nohup", "env", "nice"]);

/** Whether the program already runs `exec` (also quoted, or after time/nohup/env/nice), so another would be run as a command name. */
export function startsWithExec(program: string): boolean {
  const words = simpleShellWords(program)?.map((w) => w.text) ?? [];
  return words[0] === "exec" || (EXEC_WRAPPERS.has(words[0]) && words.includes("exec"));
}
