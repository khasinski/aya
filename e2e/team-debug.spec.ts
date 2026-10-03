// "debug on" in the real app, with no restart: aya debug on while a team runs, and the team's debug.jsonl shows the brake's
// hold of the rounds a quiet lead does not answer and, once it answers, each round with its reason; aya team debug prints them.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UNANSWERED_ROUNDS } from "../dist-electron/team-progress.js";
import { test, expect } from "./fixtures";
import { AYA, TEAM_AGENT_READY_TIMEOUT_MS, TEAM_STATE_DIR, agentPreset, openTeams, teamMinute, LEAD_TEAM, runningTeam, RHYTHM_MINUTE_MS, TEAM_CLOCK_TIMEOUT_MS } from "./helpers/team";

const TEAM = `${LEAD_TEAM}\n## Cadence\ntester every 1 min\n`;

const base = runningTeam(TEAM, agentPreset("quiet", "claude"));

test.describe("debug on", () => {
  test.use(teamMinute(base, RHYTHM_MINUTE_MS));

  test("turned on while the team runs: the brake's hold, then each round with its reason, in debug.jsonl", async ({ window, seeded }) => {
    await openTeams(window);
    const file = join(seeded.ayaHome, TEAM_STATE_DIR, "debug.jsonl");
    const events = () => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
    await window.waitForTimeout(3 * RHYTHM_MINUTE_MS);
    expect(existsSync(file), "off by default: nothing written").toBe(false);

    const cli = (...args: string[]) => spawnSync("/bin/sh", [AYA, ...args], { env: { PATH: process.env.PATH, HOME: seeded.root, AYA_HOME: seeded.ayaHome }, encoding: "utf8" });
    expect(cli("debug", "on").status).toBe(0);
    await expect.poll(() => events().some((e) => e.event === "round" && e.held === "brake"), { timeout: TEAM_AGENT_READY_TIMEOUT_MS }).toBe(true);
    // The lead's answer ends the hold: the next rounds go, each with the reason it was due.
    writeFileSync(join(seeded.projectDir, "send-request-tab-left"), "implementer take the second half of the solver");
    await expect.poll(() => events().some((e) => e.event === "round" && e.reason === "rhythm" && e.typed === true), { timeout: TEAM_CLOCK_TIMEOUT_MS }).toBe(true);
    expect(events().some((e) => e.event === "round-check" && e.rhythm === true)).toBe(true);

    const printed = cli("team", "debug", "ux-review");
    expect(printed.status, printed.stderr).toBe(0);
    expect(printed.stdout).toMatch(new RegExp(`round +round=\\d+ held=brake unanswered=${UNANSWERED_ROUNDS}`));

    expect(cli("debug", "off").status).toBe(0);
    await window.waitForTimeout(RHYTHM_MINUTE_MS);
    const after = events().length;
    await window.waitForTimeout(3 * RHYTHM_MINUTE_MS);
    expect(events().length, "off again: nothing more").toBe(after);
  });
});
