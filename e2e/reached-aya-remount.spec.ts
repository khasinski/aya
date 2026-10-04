// A pane that proved it reaches Aya keeps that proof while its process runs: a re-mount only replays output,
// and the pty host (with the pane's process) outlives a quit of the app.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { test, expect, closeAndWait, launchApp } from "./fixtures";
import { envWithoutAya } from "./helpers/env";
import { AYA, TEAM_AGENT_READY_TIMEOUT_MS, openTeams, rightTabSeed, SHELL_PRESET, HANDOFF_TEAM, WRAPPED_REACHING_CODEX } from "./helpers/team";
import { firstTerminalShown } from "./helpers/terminal";
import { AGENT_TEST_TIMEOUT_MS } from "./timeouts";
import { TEAMS_REFRESH_MS } from "../src/hooks/useTeams";

/** A pane's launch note on the card, once the window has read the pane (its status) and refreshed twice more. */
const noteAfterRefresh = async (window: Page) => {
  const card = (await openTeams(window)).getByTestId("team-ux-review");
  await expect(card.getByLabel("implementer status")).toHaveText("ready");
  await window.waitForTimeout(TEAMS_REFRESH_MS * 2);
  return card.getByLabel("implementer launch note");
};
const log = (projectDir: string) => {
  const file = join(projectDir, "codex-tab-right.log");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
};
/** Opens the team with the wrapped Codex as implementer and waits for its process to call aya. */
const proveReach = async (window: Page, ayaHome: string, projectDir: string) => {
  await firstTerminalShown(window);
  const env = { ...envWithoutAya(), AYA_SOCKET: join(ayaHome, "aya.sock"), AYA_TERMINAL_ID: "tab-left" };
  await expect.poll(() => log(projectDir), { timeout: TEAM_AGENT_READY_TIMEOUT_MS }).toMatch(/^ARGS --dangerously-bypass-approvals-and-sandbox\n/);
  expect(spawnSync(AYA, ["team", "open", "ux-review", "implementer=pane:tab-right"], { env, encoding: "utf8" }).stderr).toBe("");
  await expect.poll(() => log(projectDir), { timeout: TEAM_AGENT_READY_TIMEOUT_MS }).toMatch(/WHOAMI team +ux-review\nyou +implementer\n/);
  await expect(await noteAfterRefresh(window)).toHaveCount(0);
};

test.describe("a wrapped Codex pane that has called aya", () => {
  test.use(rightTabSeed(HANDOFF_TEAM, [SHELL_PRESET, WRAPPED_REACHING_CODEX], WRAPPED_REACHING_CODEX));

  test("keeps its proof across a re-mount of the same process", async ({ window, seeded }) => {
    test.setTimeout(AGENT_TEST_TIMEOUT_MS);
    await proveReach(window, seeded.ayaHome, seeded.projectDir);
    const started = log(seeded.projectDir).match(/^ARGS /gm)?.length;
    await window.reload();
    await firstTerminalShown(window);
    await expect(await noteAfterRefresh(window)).toHaveCount(0);
    // The same process: a re-mount, not a restart.
    expect(log(seeded.projectDir).match(/^ARGS /gm)?.length).toBe(started);
  });
});

test.describe("a wrapped Codex pane that has called aya, Aya quit and relaunched", () => {
  test.use(rightTabSeed(HANDOFF_TEAM, [SHELL_PRESET, WRAPPED_REACHING_CODEX], WRAPPED_REACHING_CODEX));

  test("keeps its proof while the host keeps the same process", async ({ seeded }) => {
    test.setTimeout(AGENT_TEST_TIMEOUT_MS);
    // The host outlives the app, as in production.
    const env = { ...seeded, launchEnv: { ...seeded.launchEnv, AYA_E2E_PTY_SHUTDOWN: "0" } };
    const first = await launchApp(env);
    try {
      await proveReach(await first.firstWindow(), seeded.ayaHome, seeded.projectDir);
    } finally {
      await closeAndWait(first);
    }
    const started = log(seeded.projectDir).match(/^ARGS /gm)?.length;
    const second = await launchApp(env);
    try {
      const window = await second.firstWindow();
      await firstTerminalShown(window);
      await expect(await noteAfterRefresh(window)).toHaveCount(0);
      expect(log(seeded.projectDir).match(/^ARGS /gm)?.length, "the same process: the host kept it").toBe(started);
    } finally {
      await closeAndWait(second);
    }
  });
});
