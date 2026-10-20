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
  /** Occurrence of this exact row in its hunk; used if duplicates exist. */
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

export interface IndexedDiffRows {
  anchors: Array<DiffAnchor | null>;
  byFileAndLine: Map<string, number[]>;
  byFileHunkAndLine: Map<string, number[]>;
}

/** Convert Electron's transport error (which includes internal IPC wording) to
 *  short copy a person can act on. Unknown errors deliberately stay generic. */
export function diffCommentSendError(error: unknown, targetName: string): string {
  const detail = error instanceof Error ? error.message : String(error ?? "");
  if (/Claude Code offers an account-wide setting|Only the user answers it/i.test(detail)) {
    return `Not sent: ${targetName} is waiting for your answer to a question in Claude Code. Answer it in that pane, then send again. Your comment is kept.`;
  }
  if (/it appeared after the text was typed|the text may sit in the offer or the composer/i.test(detail)) {
    return `Aya typed the comments into ${targetName}, but a new question appeared before they could be submitted. Check that pane before trying again. Your comments are still saved.`;
  }
  return "Aya couldn't confirm that the comments were sent. Check the pane before trying again. Your comments are still saved.";
}

function rowKind(text: string): "add" | "del" | "ctx" | null {
  if (text.startsWith("+++") || text.startsWith("---")) return null;
  if (text.startsWith("+")) return "add";
  if (text.startsWith("-")) return "del";
  if (text.startsWith(" ")) return "ctx";
  return null;
}

const rowKey = (file: string, line: string) => JSON.stringify([file, line]);
const hunkRowKey = (file: string, hunk: string, line: string) => JSON.stringify([file, hunk, line]);

/** Index the diff in one pass so rendering a large diff does not rescan its
 *  prefix for every row. Repeated rows are counted within their hunk. */
export function indexDiffRows(lines: string[]): IndexedDiffRows {
  const anchors: Array<DiffAnchor | null> = Array(lines.length).fill(null);
  const byFileAndLine = new Map<string, number[]>();
  const byFileHunkAndLine = new Map<string, number[]>();
  let file: string | null = null;
  let hunk: string | null = null;
  let oldLine = 0;
  let newLine = 0;
  let previousHeader: string | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index];
    if (text.startsWith("diff --git ")) {
      file = null;
      hunk = null;
      previousHeader = null;
      continue;
    }
    if (text.startsWith("--- ")) {
      previousHeader = text;
      hunk = null;
      continue;
    }
    if (text.startsWith("+++ ")) {
      file = text.startsWith("+++ b/") ? text.slice(6)
        : text === "+++ /dev/null" && previousHeader?.startsWith("--- a/") ? previousHeader.slice(6)
          : null;
      previousHeader = null;
      hunk = null;
      continue;
    }
    if (text.startsWith("@@")) {
      const header = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      hunk = header ? text : null;
      oldLine = header ? Number(header[1]) : 0;
      newLine = header ? Number(header[2]) : 0;
      continue;
    }
    const kind = rowKind(text);
    if (!kind || !file || !hunk) continue;

    const anchor: DiffAnchor = {
      file,
      hunk,
      line: text,
      newLine: kind === "del" ? null : newLine,
      oldLine: kind === "add" ? null : oldLine,
      occurrence: byFileHunkAndLine.get(hunkRowKey(file, hunk, text))?.length ?? 0,
    };
    anchors[index] = anchor;
    const fileKey = rowKey(file, text);
    const fileMatches = byFileAndLine.get(fileKey);
    if (fileMatches) fileMatches.push(index);
    else byFileAndLine.set(fileKey, [index]);
    const hunkKey = hunkRowKey(file, hunk, text);
    const hunkMatches = byFileHunkAndLine.get(hunkKey);
    if (hunkMatches) hunkMatches.push(index);
    else byFileHunkAndLine.set(hunkKey, [index]);

    if (kind === "add") newLine += 1;
    else if (kind === "del") oldLine += 1;
    else { oldLine += 1; newLine += 1; }
  }
  return { anchors, byFileAndLine, byFileHunkAndLine };
}

/** Parse one commentable diff row and calculate its file-relative line numbers. */
export function locateDiffLine(lines: string[], index: number): DiffAnchor | null {
  return indexDiffRows(lines).anchors[index] ?? null;
}

/** Find an anchor by exact file + diff-line content. Prefer its old hunk; when
 *  context moved, use its occurrence among identical rows in that file. */
export function commentRowIndexInDiff(index: IndexedDiffRows, anchor: Pick<DiffAnchor, "file" | "hunk" | "line" | "occurrence">): number {
  const sameHunk = index.byFileHunkAndLine.get(hunkRowKey(anchor.file, anchor.hunk, anchor.line)) ?? [];
  if (sameHunk.length) return sameHunk[anchor.occurrence] ?? -1;
  const matches = index.byFileAndLine.get(rowKey(anchor.file, anchor.line)) ?? [];
  // Once the old hunk is gone, only a unique content match is safe to adopt.
  return matches.length === 1 ? matches[0] : -1;
}

export function commentRowIndex(lines: string[], anchor: Pick<DiffAnchor, "file" | "hunk" | "line" | "occurrence">): number {
  return commentRowIndexInDiff(indexDiffRows(lines), anchor);
}

export function isCommentOutdated(lines: string[], comment: DiffComment): boolean {
  return commentRowIndex(lines, comment) < 0;
}
