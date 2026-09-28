// A team message goes from one real pane to another through the real app:
// role lookup, the pane id from the local assignments, the dated header.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures";
import {
  ASK_BRIEFLY_MS,
  AYA,
  TEAM_AGENT_READY_TIMEOUT_MS,
  TEAM_DELIVERY_TIMEOUT_MS,
  agentPreset,
  openTeams,
  teamLog,
  teamSeed,
} from "./helpers/team";
import { TEAM_REDELIVERY_MS } from "./timeouts";

const TEAM = `# ux-review

## Role: tester
Sends to: implementer
Must not: edit code
Plays the build each round.

## Role: implementer
Sends to: tester
Must not: skip a report
Fixes findings.
`;

test.use(teamSeed(TEAM, [agentPreset()]));

test("tester's aya team send reaches the implementer's pane with the team header", async ({ window, seeded }) => {
  await expect(window.getByTestId("xterm-host").first()).toBeVisible();
  const read = teamLog(seeded.projectDir);
  await expect.poll(() => read("tab-left"), { timeout: TEAM_AGENT_READY_TIMEOUT_MS }).toMatch(/SENT written to implementer's pane/);
  await expect
    .poll(() => read("tab-right"), { timeout: TEAM_DELIVERY_TIMEOUT_MS })
    .toMatch(/\[team ux-review \| from tester \| \d\d:\d\d\] round 5 ready/);
});

test.describe("an implementer on an approval prompt", () => {
  test.use(teamSeed(TEAM, [agentPreset("ask", "claude")]));

  test("is not typed into: Enter would answer the prompt", async ({ window, seeded }) => {
    await expect(window.getByTestId("xterm-host").first()).toBeVisible();
    const read = teamLog(seeded.projectDir);
    await expect.poll(() => read("tab-left"), { timeout: TEAM_AGENT_READY_TIMEOUT_MS }).toMatch(/FAIL .*implementer: shows an approval prompt; nothing was typed/);
    expect(read("tab-right")).not.toMatch(/round 5 ready/);
  });
});

test.describe("an implementer that answers its prompt later", () => {
  test.use(teamSeed(TEAM, [agentPreset(`ask-briefly ${ASK_BRIEFLY_MS}`, "claude")]));

  test("gets the held message once the prompt is gone, and the window says it was held", async ({ window, seeded }) => {
    await expect(window.getByTestId("xterm-host").first()).toBeVisible();
    const read = teamLog(seeded.projectDir);
    await expect.poll(() => read("tab-left"), { timeout: TEAM_AGENT_READY_TIMEOUT_MS }).toMatch(/FAIL .*implementer: shows an approval prompt/);
    // Retried every redelivery period once the prompt clears; a retry may land just before it does.
    await expect
      .poll(() => read("tab-right"), { timeout: ASK_BRIEFLY_MS + 2 * TEAM_REDELIVERY_MS + 5_000 })
      .toMatch(/\[team ux-review \| from tester \| \d\d:\d\d\] round 5 ready/);
    const dialog = await openTeams(window);
    await expect(dialog.getByLabel("ux-review messages")).toContainText(
      "written later (was held: shows an approval prompt)",
    );
  });
});

test.describe("an implementer pane that runs a plain shell", () => {
  test.use(teamSeed(TEAM, [{ id: "shell", name: "Shell", icon: "$", color: "", command: "$SHELL" }]));

  test("is not typed into: Enter would run the text as a command", async ({ window, seeded }) => {
    await expect(window.getByTestId("xterm-host").first()).toBeVisible();
    const send = () => {
      try {
        execFileSync(AYA, ["team", "send", "implementer", "touch should-not-exist"], {
          env: { ...process.env, AYA_SOCKET: join(seeded.ayaHome, "aya.sock"), AYA_TERMINAL_ID: "tab-left" },
          stdio: "pipe",
        });
        return "sent";
      } catch (err) {
        return String((err as { stderr?: Buffer }).stderr ?? err);
      }
    };
    await expect.poll(send, { timeout: TEAM_AGENT_READY_TIMEOUT_MS }).toMatch(/implementer: runs a shell; nothing was typed/);
    expect(existsSync(join(seeded.projectDir, "should-not-exist"))).toBe(false);
  });
});

test.describe("Start team", () => {
  test.use(teamSeed(TEAM, [agentPreset("quiet", "claude")]));

  test("sends every role a delivery test naming its peer", async ({ window, seeded }) => {
    await expect(window.getByTestId("xterm-host").first()).toBeVisible();
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
    teamSeed(TEAM, [agentPreset("quiet", "claude")], {
      "teams/e2e-proj/ux-review/state.json": JSON.stringify({ paused: false, started: true }),
      // Left by an earlier session: Aya's own round and delivery test, and a peer report.
      "teams/e2e-proj/ux-review/log.jsonl": [
        { id: 1, from: "aya", text: "Round 1: old round", held: "shows an approval prompt" },
        { id: 2, from: "aya", text: "Delivery test: old test", held: "no pane assigned" },
        { id: 3, from: "tester", text: "peer report from before", held: "shows an approval prompt" },
      ]
        .map((m) => JSON.stringify({ ...m, time: "2026-09-28T09:00:00Z", to: "implementer", commit: null, delivered: false }))
        .join("\n") + "\n",
    }),
  );

  test("types the peer's held report but never Aya's stale round or delivery test", async ({ window, seeded }) => {
    await expect(window.getByTestId("xterm-host").first()).toBeVisible();
    const read = teamLog(seeded.projectDir);
    // Redelivery runs every period once the pane is up.
    await expect.poll(() => read("tab-right"), { timeout: 3 * TEAM_REDELIVERY_MS + 5_000 }).toMatch(/peer report from before/);
    expect(read("tab-right")).not.toMatch(/old round|old test/);
  });
});
