// A team message goes from one real pane to another through the real app:
// role lookup, the pane id from the local assignments, the dated header.

import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  ASK_BRIEFLY_MS,
  TEAM_AGENT_READY_TIMEOUT_MS,
  TEAM_DELIVERY_TIMEOUT_MS,
  agentPreset,
  openTeams,
  TEAM_STATE_DIR,
  teamLog,
  teamSeed,
  TWO_ROLE_TEAM,
  START_REPLY_TIMEOUT_MS,
  DELIVERY_SLACK_MS,
} from "./helpers/team";
import { firstTerminalShown } from "./helpers/terminal";
import { TEAM_REDELIVERY_MS } from "./timeouts";

test.use(teamSeed(TWO_ROLE_TEAM, { presetList: [agentPreset()] }));

test("tester's aya team send reaches the implementer's pane with the team header", async ({ window, seeded }) => {
  await firstTerminalShown(window);
  const read = teamLog(seeded.projectDir);
  await expect.poll(() => read("tab-left"), { timeout: TEAM_AGENT_READY_TIMEOUT_MS }).toMatch(/SENT written to implementer's pane/);
  await expect
    .poll(() => read("tab-right"), { timeout: TEAM_DELIVERY_TIMEOUT_MS })
    .toMatch(/\[team ux-review \| from tester \| \d\d:\d\d\] round 5 ready/);
});

test.describe("an implementer on an approval prompt", () => {
  test.use(teamSeed(TWO_ROLE_TEAM, { presetList: [agentPreset("ask", "claude")] }));

  test("is not typed into: Enter would answer the prompt", async ({ window, seeded }) => {
    await firstTerminalShown(window);
    const read = teamLog(seeded.projectDir);
    await expect.poll(() => read("tab-left"), { timeout: TEAM_AGENT_READY_TIMEOUT_MS }).toMatch(/FAIL .*implementer: shows an approval prompt; nothing was typed/);
    expect(read("tab-right")).not.toMatch(/round 5 ready/);
  });
});

test.describe("an implementer that answers its prompt later", () => {
  test.use(teamSeed(TWO_ROLE_TEAM, { presetList: [agentPreset(`ask-briefly ${ASK_BRIEFLY_MS}`, "claude")] }));

  test("gets the held message once the prompt is gone, and the window says it was held", async ({ window, seeded }) => {
    await firstTerminalShown(window);
    const read = teamLog(seeded.projectDir);
    await expect.poll(() => read("tab-left"), { timeout: TEAM_AGENT_READY_TIMEOUT_MS }).toMatch(/FAIL .*implementer: shows an approval prompt/);
    // Retried every redelivery period once the prompt clears; a retry may land just before it does.
    await expect
      .poll(() => read("tab-right"), { timeout: ASK_BRIEFLY_MS + 2 * TEAM_REDELIVERY_MS + DELIVERY_SLACK_MS })
      .toMatch(/\[team ux-review \| from tester \| \d\d:\d\d\] round 5 ready/);
    const dialog = await openTeams(window);
    await expect(dialog.getByLabel("ux-review messages")).toContainText(
      "written later (was held: shows an approval prompt)",
    );
  });
});

test.describe("an implementer pane that runs a plain shell", () => {
  // The tester's own pane sends: an id forged from outside its process tree is refused (caller-proof.ts).
  const plain = { id: "plain", name: "Shell", icon: "$", color: "", command: "$SHELL" };
  const seed = teamSeed(TWO_ROLE_TEAM, { presetList: [agentPreset(), plain] });
  test.use({ seedOptions: { ...seed.seedOptions, rightTab: { presetId: "plain", name: "Shell" } } });

  test("is not typed into: Enter would run the text as a command", async ({ window, seeded }) => {
    await firstTerminalShown(window);
    const read = teamLog(seeded.projectDir);
    await expect.poll(() => read("tab-left"), { timeout: TEAM_AGENT_READY_TIMEOUT_MS }).toMatch(/FAIL .*implementer: runs a shell; nothing was typed/);
  });
});

test.describe("Start team", () => {
  test.use(teamSeed(TWO_ROLE_TEAM, { presetList: [agentPreset("quiet", "claude")] }));

  test("sends every role a delivery test naming its peer", async ({ window, seeded }) => {
    await firstTerminalShown(window);
    const read = teamLog(seeded.projectDir);
    // Start refuses (and sends nothing) until every agent has drawn its composer.
    let result = { started: false, delivered: [] as string[] };
    await expect
      .poll(async () => (result = await window.evaluate(() => window.aya.teamStart("e2e-proj", "ux-review"))).started, {
        timeout: TEAM_AGENT_READY_TIMEOUT_MS,
      })
      .toBe(true);
    expect(result.delivered.sort()).toEqual(["implementer", "tester"]);
    await expect.poll(() => read("tab-left"), { timeout: TEAM_DELIVERY_TIMEOUT_MS }).toMatch(/from aya .*Delivery test.*aya team send implementer/);
    await expect.poll(() => read("tab-right"), { timeout: TEAM_DELIVERY_TIMEOUT_MS }).toMatch(/Delivery test.*aya team send tester/);
  });
});

test.describe("a running team restored after a restart", () => {
  test.use(
    teamSeed(TWO_ROLE_TEAM, {
      presetList: [agentPreset("quiet", "claude")],
      ayaHomeFiles: {
        [`${TEAM_STATE_DIR}/state.json`]: JSON.stringify({ paused: false, started: true }),
        // Left by an earlier session: Aya's own round and delivery test, and a peer report.
        [`${TEAM_STATE_DIR}/log.jsonl`]:
          [
            { id: 1, from: "aya", text: "Round 1: old round", held: "shows an approval prompt" },
            { id: 2, from: "aya", text: "Delivery test: old test", held: "no pane assigned" },
            { id: 3, from: "tester", text: "peer report from before", held: "shows an approval prompt" },
          ]
            .map((m) => JSON.stringify({ ...m, time: "2026-09-28T09:00:00Z", to: "implementer", commit: null, delivered: false }))
            .join("\n") + "\n",
      },
    }),
  );

  test("types the peer's held report but never Aya's stale round or delivery test", async ({ window, seeded }) => {
    await firstTerminalShown(window);
    const read = teamLog(seeded.projectDir);
    // Redelivery runs every period once the pane is up.
    await expect.poll(() => read("tab-right"), { timeout: 3 * TEAM_REDELIVERY_MS + DELIVERY_SLACK_MS }).toMatch(/peer report from before/);
    expect(read("tab-right")).not.toMatch(/old round|old test/);
  });
});

// Start's task from the Teams window, to the tester (the first role).
async function startWithTask(window: Page, task: string) {
  const dialog = await openTeams(window);
  await dialog.getByLabel("Task for ux-review").fill(task);
  const start = dialog.getByRole("button", { name: "Start", exact: true });
  // Start refuses until every agent has drawn its composer: press it again until it took.
  await expect(async () => {
    if (await start.isVisible()) await start.click();
    await expect(dialog.getByText(/^Started;/)).toBeVisible({ timeout: START_REPLY_TIMEOUT_MS });
  }).toPass({ timeout: TEAM_AGENT_READY_TIMEOUT_MS });
  return dialog;
}

test.describe("Start with a task on a focused Claude composer", () => {
  test.use(teamSeed(TWO_ROLE_TEAM, { presetList: [agentPreset("focused-cursor", "claude")] }));

  test("the placeholder under the cursor is not a draft: the task is typed, not parked in the inbox", async ({ window, seeded }) => {
    await firstTerminalShown(window);
    const dialog = await startWithTask(window, "retest the login");
    await expect(dialog.getByText("Started; task sent to tester.")).toBeVisible();
    await expect(dialog.getByText("has text the user is typing")).toHaveCount(0);
    await expect.poll(() => teamLog(seeded.projectDir)("tab-left"), { timeout: TEAM_DELIVERY_TIMEOUT_MS }).toMatch(/from user \| \d\d:\d\d\] retest the login/);
  });
});

test.describe("Start with a task that waits for a draft to clear", () => {
  const DRAFT_MS = 4_000;
  test.use(teamSeed(TWO_ROLE_TEAM, { presetList: [agentPreset(`draft-briefly ${DRAFT_MS}`, "claude")] }));

  test("the Started line about the inbox goes once the task is written", async ({ window, seeded }) => {
    await firstTerminalShown(window);
    const dialog = await startWithTask(window, "retest the login");
    await expect(dialog.getByText("Started; task for tester waits in its inbox: has text the user is typing.")).toBeVisible();
    await expect.poll(() => teamLog(seeded.projectDir)("tab-left"), { timeout: DRAFT_MS + 3 * TEAM_REDELIVERY_MS + DELIVERY_SLACK_MS }).toMatch(/retest the login/);
    await expect(dialog.getByLabel("ux-review messages")).toContainText("written later (was held: has text the user is typing)");
    await expect(dialog.getByText(/waits in its inbox/)).toHaveCount(0);
  });
});

test.describe("Start with a task right behind the delivery test, on a composer that redraws late", () => {
  const REDRAW_MS = 1_000;
  test.use(teamSeed(TWO_ROLE_TEAM, { presetList: [agentPreset(`slow-echo ${REDRAW_MS}`, "claude")] }));

  test("Aya's own delivery test still in the composer is not the user's draft: the task is typed at once", async ({ window, seeded }) => {
    await firstTerminalShown(window);
    const dialog = await startWithTask(window, "retest the login");
    await expect(dialog.getByText("Started; task sent to tester.")).toBeVisible();
    await expect(dialog.getByText("has text the user is typing")).toHaveCount(0);
    await expect.poll(() => teamLog(seeded.projectDir)("tab-left"), { timeout: TEAM_DELIVERY_TIMEOUT_MS }).toMatch(/from user \| \d\d:\d\d\] retest the login/);
  });
});
