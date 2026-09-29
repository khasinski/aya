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

export function teamChat(log: TeamMessage[]): ChatEntry[] {
  const chat: ChatEntry[] = [];
  for (const message of [...log].sort((a, b) => a.id - b.id)) {
    const last = chat.at(-1);
    const group = last?.kind === "delivery-test" ? last : null;
    if (isDeliveryTest(message)) {
      // Tests follow each other; a reply between them starts no new Start.
      if (group && group.answered.length === 0) {
        group.tested.push(message.to);
        group.messages.push(message);
      } else {
        chat.push({ kind: "delivery-test", id: message.id, time: message.time, tested: [message.to], answered: [], messages: [message] });
      }
      continue;
    }
    const answers = group && group.tested.includes(message.from) && !group.answered.includes(message.from) && ONE_WORD.test(message.text.trim());
    if (group && answers) {
      group.answered.push(message.from);
      group.messages.push(message);
      continue;
    }
    const system = message.from === AYA_SENDER || message.from === USER_SENDER;
    chat.push({ kind: system ? "system" : "peer", message, abnormal: abnormal(message) });
  }
  return chat;
}
