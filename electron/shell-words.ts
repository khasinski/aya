// Just enough shell word splitting to find a command's leading `NAME=value`
// assignments, quotes and backslash escapes included.

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

function expandWord(word: string, env: Record<string, string | undefined>): string {
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
