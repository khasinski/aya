// Review comments on the status-bar diff, sent to an agent pane as one prompt.
// The diff view is the artifact the user points at (a line, a hunk) instead of
// describing the place in words; the pane that edits the checkout gets the
// comments with paths, line numbers and the quoted line.

/** One remark the user left on a diff line. `line` is the raw diff line
 *  (prefix included) so the agent sees the exact text, not a number that
 *  drifts after its next edit. `newLine` is the line number in the working
 *  copy (null for a removed line, which exists only in HEAD). */
export interface DiffComment {
  file: string;
  hunk: string;
  line: string;
  newLine: number | null;
  oldLine: number | null;
  note: string;
}

/** Where a row of `git diff` output sits: its file, its hunk header and its
 *  line numbers on both sides, walked back from the row itself. null for rows
 *  that are not code (file headers, hunk headers, index lines). */
export function locateDiffLine(
  lines: string[],
  index: number,
): Omit<DiffComment, "note"> | null {
  const text = lines[index];
  if (text === undefined) return null;
  const kind = diffLineKind(text);
  if (kind === null) return null;
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
        // Rows between the header and this one advance the counters.
        oldLine = Number(header[1]);
        newLine = Number(header[2]);
        for (let j = i + 1; j < index; j += 1) {
          const k = diffLineKind(lines[j]);
          if (k === "add") newLine += 1;
          else if (k === "del") oldLine += 1;
          else if (k === "ctx") {
            oldLine += 1;
            newLine += 1;
          }
        }
        continue;
      }
    }
    if (prior.startsWith("+++ b/")) {
      file = prior.slice("+++ b/".length);
      break;
    }
    if (prior.startsWith("+++ ")) {
      // "+++ /dev/null": a deleted file; its name is on the --- line.
      const removed = lines[i - 1];
      file = removed?.startsWith("--- a/") ? removed.slice("--- a/".length) : prior.slice(4);
      break;
    }
  }
  if (!file || !hunk) return null;
  return {
    file,
    hunk,
    line: text,
    newLine: kind === "del" ? null : newLine,
    oldLine: kind === "add" ? null : oldLine,
  };
}

function diffLineKind(text: string): "add" | "del" | "ctx" | null {
  if (text.startsWith("+++ ") || text.startsWith("--- ")) return null;
  if (text.startsWith("+")) return "add";
  if (text.startsWith("-")) return "del";
  if (text.startsWith(" ")) return "ctx";
  return null;
}

/** The place a comment points at, as the agent should read it. */
export function commentLocation(comment: Pick<DiffComment, "file" | "newLine" | "oldLine">): string {
  if (comment.newLine !== null) return `${comment.file}:${comment.newLine}`;
  return `${comment.file}:${comment.oldLine} (removed line, numbered in HEAD)`;
}

/** The prompt one pane gets for a batch of comments: one numbered item per
 *  comment with its location, the quoted diff line and the note. Control
 *  bytes are stripped so a pasted note cannot submit extra turns. */
export function reviewPrompt(comments: DiffComment[], checkout: string | null): string {
  const where = checkout ? ` of \`${checkout}\`` : "";
  const head = [
    `Review comments on the current \`git diff\`${where}. Address each one, in the file and line named; the quoted line is from the diff, so find it by its text if the numbers have moved.`,
    "",
  ];
  const items = comments.map((c, i) => {
    // The paste-end marker whole, then every other control byte (ESC included).
    const note = c.note
      .replace(/\x1b\[201~/g, " ")
      .replace(/[\x00-\x08\x0b-\x1f\x7f]+/g, " ")
      .trim();
    return [`${i + 1}. ${commentLocation(c)}`, `   ${c.hunk}`, `   > ${c.line}`, `   ${note}`].join("\n");
  });
  return [...head, ...items].join("\n");
}

/** Comments survive a reload of the diff while their line still exists;
 *  this finds the row a comment belongs under in the current text. */
export function commentRowIndex(lines: string[], comment: Pick<DiffComment, "file" | "hunk" | "line">): number {
  let file: string | null = null;
  let hunk: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i];
    if (text.startsWith("--- a/") && lines[i + 1]?.startsWith("+++ /dev/null")) {
      file = text.slice(6); // a deleted file is named on the --- line only
      hunk = null;
      continue;
    }
    if (text.startsWith("+++ ")) {
      if (text.startsWith("+++ b/")) file = text.slice(6);
      else if (!text.startsWith("+++ /dev/null")) file = null;
      hunk = null;
      continue;
    }
    if (text.startsWith("@@")) {
      hunk = text;
      continue;
    }
    if (file === comment.file && hunk === comment.hunk && text === comment.line) return i;
  }
  return -1;
}

/** An agent pane the review can go to. `hold` says why not right now. */
export interface ReviewTarget {
  id: string;
  projectSlug: string;
  name: string;
  hold: string | null;
}

/** The prompt as a bracketed paste (the same wrap as a snippet, see
 *  snippet-payload.ts) so its line breaks arrive as one block. Enter follows
 *  after REVIEW_SUBMIT_DELAY_MS: typed in one write, Codex swallowed the
 *  Enter after a long paste (measured for team messages, electron/control.ts). */
export function reviewPtyPayload(prompt: string): string {
  return `\x1b[200~${prompt}\x1b[201~`;
}
export const REVIEW_SUBMIT_DELAY_MS = 150;
