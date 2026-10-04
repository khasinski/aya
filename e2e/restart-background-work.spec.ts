// Finding 16: Restart terminal stops what a Claude Code pane runs in the background. A pane whose footer shows the
// task pill ("2 shells, 1 monitor") asks first (Cancel keeps it, Restart restarts); a pane without it restarts
// without asking; the resumed team pane then gets Aya's note, typed like its other messages.

import type { ElectronApplication, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { agentBin } from "./helpers/agent-bin";
import { E2E_REDELIVERY_MS } from "./timeouts";
import { AGENT, AYA, countMatches, runningTeam, teamLog, TEAM_AGENT_READY_TIMEOUT_MS, TEAM_DELIVERY_TIMEOUT_MS, TWO_ROLE_TEAM } from "./helpers/team";

const NOTE = "Aya restarted this pane; background tasks and monitors you had are gone; start again the ones you still need.";

// The fake agent runs as `claude`, so Aya gives each pane a session id and a restart resumes it (--resume), which it logs.
// Unquoted: Aya gives a session id only to a command whose program is the agent's binary as written.
const MONITOR = { id: "shell", name: "Agent", icon: "a", color: "", agent: "claude" as const, command: `${agentBin("claude", AGENT)} '${AYA}' monitor` };
test.use(runningTeam(TWO_ROLE_TEAM, MONITOR));

/** Answers Aya's native question with `answer` (0: Restart, 1: Cancel) and records what it asked. */
async function answerDialogs(app: ElectronApplication, answer: number) {
  await app.evaluate(({ dialog }, a) => {
    const g = globalThis as unknown as { asked: string[] };
    g.asked ??= [];
    dialog.showMessageBox = (async (...args: unknown[]) => {
      g.asked.push((args.at(-1) as { detail: string }).detail);
      return { response: a, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  }, answer);
}
const asked = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { asked?: string[] }).asked ?? []);

async function restart(window: Page, name: string) {
  await window.locator(`.aya-sidebar-row[data-terminal-name="${name}"]`).click({ button: "right" });
  await window.locator(".aya-context-menu-item", { hasText: "Restart terminal" }).click();
}

const launches = (log: string) => (log.match(/^LAUNCH /gm) ?? []).length;

test("Restart terminal asks when the pane shows background work, and the resumed role gets the note", async ({ app, window, seeded }) => {
  const read = teamLog(seeded.projectDir);
  await expect.poll(() => read("tab-right"), { timeout: TEAM_AGENT_READY_TIMEOUT_MS }).toMatch(/^LAUNCH (fresh|resumed)$/m);
  await expect.poll(() => read("tab-left"), { timeout: TEAM_AGENT_READY_TIMEOUT_MS }).toMatch(/^LAUNCH (fresh|resumed)$/m);

  // Cancel: asked about this pane's work, and the pane keeps its process (its log is not started over).
  await answerDialogs(app, 1);
  const before = read("tab-right");
  await restart(window, "shell 2");
  await expect.poll(() => asked(app)).toHaveLength(1);
  expect((await asked(app))[0]).toMatch(/^Restarting shell 2 stops what these panes run in the background \(shell 2: 2 shells, 1 monitor\)/);
  await window.waitForTimeout(1_500);
  expect(read("tab-right")).toBe(before);

  // Restart: asked again, the pane restarts resumed, and its new process gets the note once, from Aya.
  await answerDialogs(app, 0);
  await restart(window, "shell 2");
  await expect.poll(() => read("tab-right"), { timeout: TEAM_AGENT_READY_TIMEOUT_MS }).toMatch(/^LAUNCH resumed$/m);
  expect(await asked(app)).toHaveLength(2);
  await expect.poll(() => read("tab-right"), { timeout: TEAM_DELIVERY_TIMEOUT_MS }).toContain(NOTE);
  expect(read("tab-right")).toMatch(new RegExp(`\\[team ux-review \\| from aya \\| [^\\]]+\\] ${NOTE.replace(/[.;]/g, "\\$&")}`));

  // No pill: restarts without asking, and its resumed process gets no note, however many passes run.
  await restart(window, "shell 1");
  await expect.poll(() => read("tab-left"), { timeout: TEAM_AGENT_READY_TIMEOUT_MS }).toMatch(/^LAUNCH resumed$/m);
  expect(await asked(app)).toHaveLength(2);
  await window.waitForTimeout(2 * E2E_REDELIVERY_MS + 1_000);
  expect(read("tab-left")).not.toContain(NOTE);
  expect(countMatches(read("tab-right"), new RegExp(NOTE.replace(/[.;]/g, "\\$&"), "g"))).toBe(1);
  expect(launches(read("tab-right"))).toBe(1);
});
