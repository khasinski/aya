// The team log as the Teams window's chat: oldest first, each Start's
// delivery-test exchange on one line, Aya's and the user's messages as system lines.

import { AYA_SENDER, USER_SENDER } from "./team-view";
import type { TeamMessage } from "./types";

const DELIVERY_TEST_PREFIX = "Delivery test:";
// The one word a role sends back to a delivery test; anything longer is a real message.
const ONE_WORD = /^\S+$/;

export type ChatEntry =
  | { kind: "peer" | "system"; message: TeamMessage; abnormal: boolean }
  | { kind: "delivery-test"; id: number; time: string; tested: string[]; answered: string[]; messages: TeamMessage[] };

/** Worth the user's eye: still held, or typed only after a hold. */
export const abnormal = (m: Pick<TeamMessage, "delivered" | "held">): boolean => !m.delivered || Boolean(m.held);

const isDeliveryTest = (m: TeamMessage) => m.from === AYA_SENDER && m.text.startsWith(DELIVERY_TEST_PREFIX);

/** Answers join the latest Start's line whatever is logged in between (a task
 *  goes out before them); a role that writes anything else is no longer waited for. */
/** `roles`: the team's role ids; in a team saved before "user" was reserved,
 *  a message from "user" is that role's, not a task (such a team takes none). */
export function teamChat(log: TeamMessage[], roles: string[] = []): ChatEntry[] {
  const userIsRole = roles.includes(USER_SENDER);
  const chat: ChatEntry[] = [];
  let group: Extract<ChatEntry, { kind: "delivery-test" }> | null = null;
  let testing = false;
  const spoke = new Set<string>();
  for (const message of [...log].sort((a, b) => a.id - b.id)) {
    if (isDeliveryTest(message)) {
      if (!group || !testing) {
        group = { kind: "delivery-test", id: message.id, time: message.time, tested: [], answered: [], messages: [] };
        chat.push(group);
        spoke.clear();
      }
      group.tested.push(message.to);
      group.messages.push(message);
      testing = true;
      continue;
    }
    testing = false;
    const waited = group && group.tested.includes(message.from) && !group.answered.includes(message.from) && !spoke.has(message.from);
    if (group && waited && ONE_WORD.test(message.text.trim())) {
      group.answered.push(message.from);
      group.messages.push(message);
      continue;
    }
    spoke.add(message.from);
    const system = message.from === AYA_SENDER || (message.from === USER_SENDER && !userIsRole);
    chat.push({ kind: system ? "system" : "peer", message, abnormal: abnormal(message) });
  }
  return chat;
}
