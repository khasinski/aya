import { printable } from "../shared/printable.cjs";
export { printable };

// Text from files and programs Aya does not control (team files agents write, what a teammate sent, a status
// command's output, a pane's screen, an ssh host's reply), encoded for where it goes. One rule per sink, not one
// function with switches: what is harmless in one place acts in the other.

// A terminal: C0 and C1 controls (ESC starts a sequence that can move the cursor, retitle the window, rewrite the
// screen), the line and paragraph separators, the bidi controls (they reorder what follows) and the deprecated
// format controls U+206A-206F. Tab and newline are text there.
// A pane's composer, where text is typed as keys: every Zs but U+0020 too, since a different space is a different
// token, so 16 of them would carry ~4 bits per gap.
const BLANK_OR_LINE = /[\p{Cc}\p{Zl}\p{Zp}\u2800\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]+/gu;
const HIDDEN = /[\p{Cf}\p{Default_Ignorable_Code_Point}\p{Co}\p{Cn}\p{Cs}]/gu;

/** A peer's text as one plain line to type: controls (Enter, ESC[201~ ending a paste early) become a space; format,
 *  ignorable, private-use and unassigned characters (bidi overrides, zero-width joiners, tags) hide or reorder text
 *  and go. */
export function oneLine(text: string): string {
  return text.replace(BLANK_OR_LINE, " ").replace(HIDDEN, "").trim();
}
