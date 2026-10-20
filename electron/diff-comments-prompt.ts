import type { DiffComment } from "./diff-comments-store";

const CONTROL_EXCEPT_NEWLINE_TAB = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g;
const CONTROL_OR_LINE_BREAK = /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g;
export const MAX_DIFF_REVIEW_PROMPT_BYTES = 48 * 1024;

function safeNote(note: string): string {
  return note.replace(/\r\n?/g, "\n").replace(/\x1b\[201~/g, " ").replace(CONTROL_EXCEPT_NEWLINE_TAB, " ").trim();
}

function safeSingleLine(value: string): string {
  return value.replace(/\x1b\[201~/g, " ").replace(CONTROL_OR_LINE_BREAK, " ").trim();
}

/** One numbered item per comment. A long batch is refused, never shortened. */
export function reviewPrompt(comments: DiffComment[], checkout: string): string {
  const head = `Review comments on the current working diff in ${safeSingleLine(checkout)}. Address every numbered item. The quoted row is from the diff; find it by its text if the line number moved.\n`;
  const items = comments.map((comment, index) => {
    const file = safeSingleLine(comment.file);
    const hunk = safeSingleLine(comment.hunk);
    const line = safeSingleLine(comment.line);
    const location = comment.newLine !== null
      ? `${file}:${comment.newLine}`
      : `${file}:${comment.oldLine} (removed line, numbered in HEAD)`;
    return `${index + 1}. ${location}\n   ${hunk}\n   > ${line}\n   ${safeNote(comment.note)}`;
  });
  const prompt = `${head}\n${items.join("\n\n")}`;
  if (Buffer.byteLength(prompt, "utf8") > MAX_DIFF_REVIEW_PROMPT_BYTES) {
    throw new Error("These comments make one message too long. Shorten or remove some comments, then send again.");
  }
  return prompt;
}

export function reviewPtyPayload(prompt: string): string {
  return `\x1b[200~${prompt}\x1b[201~`;
}
