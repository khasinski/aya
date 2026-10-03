// Start's delivery test to a role that sits on a prompt is held in its inbox. The group line "Delivery test: 0/2 answered"
// must say so, and the row inside it must carry the warning.

import { test, expect } from "./fixtures";
import { TEAM_STATE_DIR, TWO_ROLE_TEAM, agentPreset, openTeams, teamSeed } from "./helpers/team";

const entry = (id: number, to: string, held?: string) =>
  JSON.stringify({ id, from: "aya", to, commit: null, time: "2026-09-30T10:00:00.000Z", text: "Delivery test: run aya team whoami.", delivered: !held, ...(held ? { held } : {}) });

test.use(
  teamSeed(TWO_ROLE_TEAM, {
    presetList: [agentPreset("quiet", "claude")],
    ayaHomeFiles: { [`${TEAM_STATE_DIR}/log.jsonl`]: `${entry(1, "tester")}\n${entry(2, "implementer", "shows an approval prompt")}\n` },
  }),
);

test("a held delivery test is flagged on the group line and on its row", async ({ window }) => {
  const dialog = await openTeams(window);
  const chat = dialog.getByLabel("ux-review messages");
  const group = chat.getByRole("button", { name: /Delivery test: 0\/2 answered/ });
  await expect(group).toContainText("⚠ 1 held");
  await group.click();
  await expect(chat.locator(".aya-chat-alert")).toHaveText("⚠ not typed: shows an approval prompt");
  await expect(chat.locator(".aya-chat-alert")).toHaveCount(1);
});
