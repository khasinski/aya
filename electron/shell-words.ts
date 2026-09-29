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
