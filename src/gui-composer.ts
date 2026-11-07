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
