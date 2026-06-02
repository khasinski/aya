import type { Snippet } from "./types";

/** Bracketed-paste markers. Interactive programs that enable bracketed paste
 *  (shells with readline, the Claude/Codex TUIs, editors) treat everything
 *  between these as a single paste: embedded newlines are inserted literally
 *  instead of submitting line by line. Without this, a multi-line "hold"
 *  snippet would execute each line as it arrives — breaking the "type only,
 *  you press Enter" promise of autoRun=false. Wrapping single-line snippets is
 *  harmless (paste-then-run behaves the same as typing). */
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** The exact bytes Aya writes to the PTY when the user sends a snippet. The
 *  text is sent as a bracketed paste so multi-line snippets arrive as one
 *  block; `autoRun` then appends a carriage return so it executes immediately,
 *  otherwise the cursor is left on the pasted text for the user to press Enter.
 *
 *  This is the contract behind the play (▶) / pause (⏸) cue in the drawer:
 *  the icon promises "runs on send" vs "types only", and this function is
 *  where that promise is kept. Extracted as a pure core so the cue ↔
 *  side-effect contract can be tested without standing up a terminal. */
export function snippetPtyPayload(
  snippet: Pick<Snippet, "text" | "autoRun">,
): string {
  const pasted = `${PASTE_START}${snippet.text}${PASTE_END}`;
  return snippet.autoRun ? `${pasted}\r` : pasted;
}
