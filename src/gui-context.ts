// Context a Conversation GUI composer can add to a message: review comments on the working diff, and the output of a
// terminal pane. Both become plain text blocks in the draft, so what the agent receives is what the user can read.

export interface ReviewComment {
  file: string;
  hunk: string;
  line: string;
  newLine: number | null;
  oldLine: number | null;
  note: string;
}

const CONTROL_EXCEPT_NEWLINE_TAB = /[\x00-\x08\x0b-\x1f\x7f-\x9f‪-‮⁦-⁩]/g;
const CONTROL_OR_LINE_BREAK = /[\x00-\x1f\x7f-\x9f‪-‮⁦-⁩]/g;
export const MAX_REVIEW_BLOCK_BYTES = 48 * 1024;

const safeNote = (note: string): string => note.replace(/\r\n?/g, "\n").replace(/\x1b\[201~/g, " ").replace(CONTROL_EXCEPT_NEWLINE_TAB, " ").trim();
const safeSingleLine = (value: string): string => value.replace(/\x1b\[201~/g, " ").replace(CONTROL_OR_LINE_BREAK, " ").trim();

/** The same numbered review message `aya` sends to a terminal pane (electron/diff-comments-prompt.ts; a test keeps the
 *  two identical). A batch that would be too long throws rather than being shortened. */
export function reviewCommentsBlock(comments: readonly ReviewComment[], checkout: string): string {
  const head = `Review comments on the current working diff in ${safeSingleLine(checkout)}. Address every numbered item. The quoted row is from the diff; find it by its text if the line number moved.\n`;
  const items = comments.map((comment, index) => {
    const file = safeSingleLine(comment.file);
    const location = comment.newLine !== null ? `${file}:${comment.newLine}` : `${file}:${comment.oldLine} (removed line, numbered in HEAD)`;
    return `${index + 1}. ${location}\n   ${safeSingleLine(comment.hunk)}\n   > ${safeSingleLine(comment.line)}\n   ${safeNote(comment.note)}`;
  });
  const block = `${head}\n${items.join("\n\n")}`;
  if (new TextEncoder().encode(block).length > MAX_REVIEW_BLOCK_BYTES) {
    throw new Error("These comments make one message too long. Shorten or remove some comments, then add them again.");
  }
  return block;
}

/** Terminal output as a labelled code block. The fence is longer than any run of backticks inside, so the text cannot
 *  close it early. */
export function terminalExcerptBlock(name: string, output: string): string {
  const text = output.replace(/\r\n?/g, "\n").replace(CONTROL_EXCEPT_NEWLINE_TAB, " ").replace(/\s+$/, "");
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `Output of the terminal "${safeSingleLine(name)}":\n${fence}\n${text}\n${fence}`;
}

/** The draft after adding a block: on its own paragraph after whatever is already written. */
export function withContextBlock(prompt: string, block: string): string {
  return prompt.trim() ? `${prompt.replace(/\s+$/, "")}\n\n${block}\n\n` : `${block}\n\n`;
}
