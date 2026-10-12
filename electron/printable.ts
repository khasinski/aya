// Text a file holds, printed to a terminal. A team file is written by agents and saved by the user, so its roles,
// rules and protocol reach `aya team show` and `aya team whoami` unchecked; a control character there would act,
// not show: ESC starts a sequence that can move the cursor, retitle the window or rewrite what is on screen, and a
// carriage return or a bidi override can make a line read as something else.

// C0 but tab and newline, DEL, C1, and the bidi marks, embeddings, overrides and isolates.
const UNPRINTABLE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

/** `text` with every character that would act on a terminal shown as "?". */
export function printableText(text: string): string {
  return text.replace(UNPRINTABLE, "?");
}

/** `value` as indented JSON a terminal shows as text. JSON.stringify escapes C0 but leaves DEL, C1 and the bidi
 *  characters raw (measured); they are escaped here as \uXXXX, so the data a program parses is unchanged. */
export function printableJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(UNPRINTABLE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
