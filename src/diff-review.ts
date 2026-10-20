/** A comment on one row of a local working-tree diff. The raw diff line and
 *  hunk are retained so it can be found again after the checkout changes. */
export interface DiffComment {
  id: string;
  file: string;
  hunk: string;
  /** Includes the leading +, - or space that identifies the diff row. */
  line: string;
  newLine: number | null;
  oldLine: number | null;
  /** Occurrence of this exact row in the file; used if the hunk header shifts. */
  occurrence: number;
  checkout: string;
  note: string;
  createdAt: string;
  sentAt: string | null;
  sentTo: string | null;
}

export type DiffCommentDraft = Omit<DiffComment, "sentAt" | "sentTo"> & {
  sentAt?: null;
  sentTo?: null;
};

export interface DiffAnchor {
  file: string;
  hunk: string;
  line: string;
  newLine: number | null;
  oldLine: number | null;
  occurrence: number;
}

export interface ReviewTarget {
  id: string;
  projectSlug: string;
  name: string;
}

function rowKind(text: string): "add" | "del" | "ctx" | null {
  if (text.startsWith("+++") || text.startsWith("---")) return null;
  if (text.startsWith("+")) return "add";
  if (text.startsWith("-")) return "del";
  if (text.startsWith(" ")) return "ctx";
  return null;
}

/** Parse a commentable diff row and calculate its file-relative line numbers. */
export function locateDiffLine(lines: string[], index: number): DiffAnchor | null {
  const text = lines[index];
  if (text === undefined) return null;
  const kind = rowKind(text);
  if (!kind) return null;

  let file: string | null = null;
  let hunk: string | null = null;
  let oldLine = 0;
  let newLine = 0;
  for (let i = index - 1; i >= 0; i -= 1) {
    const prior = lines[i];
    if (!hunk) {
      const header = prior.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (header) {
        hunk = prior;
        oldLine = Number(header[1]);
        newLine = Number(header[2]);
        for (let j = i + 1; j < index; j += 1) {
          const previousKind = rowKind(lines[j]);
          if (previousKind === "add") newLine += 1;
          else if (previousKind === "del") oldLine += 1;
          else if (previousKind === "ctx") { oldLine += 1; newLine += 1; }
        }
        continue;
      }
    }
    if (prior.startsWith("+++ b/")) { file = prior.slice(6); break; }
    if (prior.startsWith("+++ ")) {
      const removed = lines[i - 1];
      file = removed?.startsWith("--- a/") ? removed.slice(6) : prior.slice(4);
      break;
    }
  }
  if (!file || !hunk) return null;
  let occurrence = 0;
  for (let i = 0; i < index; i += 1) {
    const prior = lines[i];
    if (prior === text && rowKind(prior)) {
      // Count only inside this file section.
      const priorFile = currentFile(lines, i);
      if (priorFile === file) occurrence += 1;
    }
  }
  return {
    file,
    hunk,
    line: text,
    newLine: kind === "del" ? null : newLine,
    oldLine: kind === "add" ? null : oldLine,
    occurrence,
  };
}

function currentFile(lines: string[], index: number): string | null {
  for (let i = index - 1; i >= 0; i -= 1) {
    if (lines[i].startsWith("+++ b/")) return lines[i].slice(6);
    if (lines[i] === "+++ /dev/null") return lines[i - 1]?.startsWith("--- a/") ? lines[i - 1].slice(6) : null;
    if (lines[i].startsWith("+++ ")) return null;
  }
  return null;
}

/** Find an anchor by exact file + diff-line content. Prefer its old hunk; when
 *  context moved, use its occurrence among identical rows in that file. */
export function commentRowIndex(lines: string[], anchor: Pick<DiffAnchor, "file" | "hunk" | "line" | "occurrence">): number {
  const matches: number[] = [];
  let file: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i];
    if (text.startsWith("--- a/") && lines[i + 1] === "+++ /dev/null") {
      file = text.slice(6);
      continue;
    }
    if (text.startsWith("+++ ")) {
      file = text.startsWith("+++ b/") ? text.slice(6) : null;
      continue;
    }
    if (text.startsWith("@@")) continue;
    if (file === anchor.file && rowKind(text) && text === anchor.line) matches.push(i);
  }
  if (!matches.length) return -1;
  const sameHunk = matches.filter((i) => currentHunk(lines, i) === anchor.hunk);
  if (sameHunk.length === 1) return sameHunk[0];
  return matches[anchor.occurrence] ?? (matches.length === 1 ? matches[0] : -1);
}

function currentHunk(lines: string[], index: number): string | null {
  for (let i = index - 1; i >= 0; i -= 1) {
    if (lines[i].startsWith("@@")) return lines[i];
    if (lines[i].startsWith("diff --git")) return null;
  }
  return null;
}

export function isCommentOutdated(lines: string[], comment: DiffComment): boolean {
  return commentRowIndex(lines, comment) < 0;
}
