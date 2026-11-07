// What a message sent from the Conversation GUI composer does. While the agent works Enter either queues the message
// for the next turn or steers the running one (the user's default); Cmd/Ctrl+Enter does the opposite for one message.

export type FollowUpPreference = "queue" | "steer";
export type SendAction = "send" | "queue" | "steer";

export function parseFollowUpPreference(stored: string | null | undefined): FollowUpPreference {
  return stored === "steer" ? "steer" : "queue";
}

export interface SendActionInput {
  /** A turn is running, a side question is open, or messages are already queued ahead of this one. */
  mustWait: boolean;
  /** A turn is running (steering needs one). */
  busy: boolean;
  steerSupported: boolean;
  preference: FollowUpPreference;
  /** Cmd/Ctrl held: use the other action for this message. */
  opposite: boolean;
  hasAttachments: boolean;
  isCommand: boolean;
}

/** "steer" is only possible into a running turn, on an agent that supports it, with a text-only message. */
export function sendAction(input: SendActionInput): SendAction {
  if (input.isCommand) return "send";
  if (!input.mustWait) return "send";
  const wanted: FollowUpPreference = input.opposite ? (input.preference === "steer" ? "queue" : "steer") : input.preference;
  const canSteer = input.busy && input.steerSupported && !input.hasAttachments;
  return wanted === "steer" && canSteer ? "steer" : "queue";
}

/** The label of the send button, which says what Enter will do. */
export function sendLabel(action: SendAction): string {
  return action === "steer" ? "Steer ↗" : action === "queue" ? "Queue ↑" : "Send ↑";
}

/** The hint under the composer while the agent works. */
export function followUpHint(preference: FollowUpPreference, steerSupported: boolean): string {
  if (!steerSupported) return "Enter queues · Shift+Enter for a new line";
  return preference === "steer" ? "Enter steers · ⌘Enter queues · Shift+Enter for a new line" : "Enter queues · ⌘Enter steers · Shift+Enter for a new line";
}

// ---- recalling sent prompts (ArrowUp / ArrowDown in the composer) ---------------------------------------------------

export interface Recall { index: number; text: string }

/** One ArrowUp / ArrowDown. `history` is the prompts sent in this conversation, oldest first. Recall starts from an
 *  empty composer and continues only while the text is the unedited recalled prompt; `atEdge` says the caret is on the
 *  first line (ArrowUp) or the last (ArrowDown), where the arrow has nowhere else to go. Null means "do not handle". */
export function recallStep(
  history: readonly string[],
  recall: Recall | null,
  prompt: string,
  direction: "up" | "down",
  atEdge: boolean,
): { prompt: string; recall: Recall | null } | null {
  if (!atEdge) return null;
  const unedited = recall !== null && prompt === recall.text;
  if (direction === "up") {
    if (!unedited && prompt !== "") return null;
    if (history.length === 0) return null;
    const index = unedited ? Math.max(0, recall.index - 1) : history.length - 1;
    return { prompt: history[index]!, recall: { index, text: history[index]! } };
  }
  if (!unedited) return null;
  const index = recall.index + 1;
  if (index >= history.length) return { prompt: "", recall: null };
  return { prompt: history[index]!, recall: { index, text: history[index]! } };
}

/** The text of a user message as typed: steered messages are shown with a leading arrow. */
export function sentPromptText(messageText: string): string {
  return messageText.startsWith("↳ ") ? messageText.slice(2) : messageText;
}

// ---- quoting an assistant response -----------------------------------------------------------------------------------

/** A selection as a Markdown block quote, ready to put in the composer with a blank line after it. */
export function quoteMarkdown(selection: string): string {
  const lines = selection.replace(/\r\n?/g, "\n").trim().split("\n");
  return `${lines.map((line) => (line.trim() ? `> ${line}` : ">")).join("\n")}\n\n`;
}

/** The composer's text after adding a quote: after what is already there, on its own paragraph. */
export function withQuote(prompt: string, selection: string): string {
  const quote = quoteMarkdown(selection);
  if (!selection.trim()) return prompt;
  if (!prompt.trim()) return quote;
  return `${prompt.replace(/\s+$/, "")}\n\n${quote}`;
}

// ---- stashing a draft (Cmd+S) --------------------------------------------------------------------------------------

/** Cmd+S with text saves it for later; with an empty composer it brings the latest stash back. */
export function stashStep(
  stash: readonly string[],
  prompt: string,
): { prompt: string; stash: string[] } | null {
  if (prompt.trim()) return { prompt: "", stash: [...stash, prompt] };
  if (stash.length === 0) return null;
  return { prompt: stash[stash.length - 1]!, stash: stash.slice(0, -1) };
}
