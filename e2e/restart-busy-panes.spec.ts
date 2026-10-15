// #217: a restart of the PTY host stops every pane's process, as an update's does. Aya asks first about an agent
// mid-turn and a shell running a command, not only about background tasks: Cancel keeps both processes, Restart
// stops them.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ElectronApplication, Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { fireShortcut } from "./helpers/shortcut";
import { agentPreset } from "./helpers/team";
import { visiblePane, waitForShellReady } from "./helpers/terminal";

// team-agent.cjs in "busy" mode draws Claude's footer mid-turn ("esc to interrupt") in tab-right; named `claude`,
// with the preset's agent, the pane is Claude's to Aya. Busy mode ignores the argument after it: this run's mark,
// so ps finds this agent and no other test's.
const MARK = `restart-busy-${randomUUID().slice(0, 8)}`;
const BUSY = { ...agentPreset(`busy ${MARK}`, "claude"), id: "busy", name: "Busy" };
// A length nothing else on the machine sleeps for, so ps finds this command only.
const COMMAND = "sleep 3593";
const QUESTION =
  `Restarting the PTY host stops what these panes are doing (shell 1: running ${COMMAND}; agent: mid-turn). ` +
  "An agent mid-turn stops before its turn ends. A command running in a shell stops.";

test.use({
  seedOptions: {
    rightTab: { presetId: "busy", name: "agent" },
    presetList: [{ id: "shell", name: "Shell", icon: "$", color: "", command: "$SHELL" }, BUSY],
  },
});

/** Answers Aya's native question before a restart with `answer` (0: Restart, 1: Cancel) and records what it asked.
 *  In Electron the window's own confirm() is a message box too: it goes on to the real one, which the page answers. */
async function answerDialogs(app: ElectronApplication, answer: number) {
  await app.evaluate(({ dialog }, a) => {
    const g = globalThis as unknown as { asked: string[]; showMessageBox: typeof dialog.showMessageBox };
    g.asked ??= [];
    g.showMessageBox ??= dialog.showMessageBox.bind(dialog);
    dialog.showMessageBox = (async (...args: Parameters<typeof dialog.showMessageBox>) => {
      const options = args.at(-1) as { message: string; detail?: string };
      if (options.message !== "Work in progress will stop") return g.showMessageBox(...args);
      g.asked.push(options.detail ?? "");
      return { response: a, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  }, answer);
}
const asked = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { asked?: string[] }).asked ?? []);

/** Settings > Diagnostics, open for the test's restarts. */
async function openDiagnostics(app: ElectronApplication, window: Page) {
  await fireShortcut(app, "open-settings");
  const settings = window.locator(".aya-modal--settings");
  await expect(settings).toBeVisible();
  await settings.getByTestId("settings-tab").filter({ hasText: "Diagnostics" }).click();
  return settings;
}

/** PTY host > Restart, past the window's own confirm. */
async function restartHost(settings: Locator) {
  settings.page().once("dialog", (dialog) => void dialog.accept());
  await settings.locator(".aya-settings-general-row", { hasText: "PTY host" }).getByRole("button", { name: "Restart" }).click();
}

/** The pids of the busy stand-in agent now. */
function agents(): number[] {
  return execFileSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim().match(/^(\d+) (.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null && m[2].includes("team-agent.cjs") && m[2].includes(MARK))
    .map((m) => Number(m[1]));
}

/** The pids running COMMAND now. */
function sleeping(): number[] {
  return execFileSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim().match(/^(\d+) (.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null && m[2] === COMMAND)
    .map((m) => Number(m[1]));
}

test("a host restart asks about an agent mid-turn and a shell running a command", async ({ app, window }) => {
  const buffer = (id: string) => window.evaluate((terminalId) => window.aya.ptyBuffer(terminalId), id);
  await waitForShellReady(window);
  await expect.poll(() => buffer("tab-right"), { timeout: 15_000 }).toContain("esc to interrupt");
  const shell = visiblePane(window, "shell 1").getByTestId("xterm-host");
  await shell.click();
  await window.keyboard.insertText(COMMAND);
  await window.keyboard.press("Enter");
  await expect.poll(sleeping, { timeout: 10_000 }).toHaveLength(1);
  const [sleep] = sleeping();
  expect(agents()).toHaveLength(1);
  const [agent] = agents();
  const settings = await openDiagnostics(app, window);

  // Cancel: asked about both panes, and the command and the agent keep running.
  await answerDialogs(app, 1);
  await restartHost(settings);
  await expect.poll(() => asked(app)).toEqual([QUESTION]);
  await window.waitForTimeout(1_000);
  expect(sleeping()).toEqual([sleep]);
  expect(agents()).toEqual([agent]);

  // Restart: asked again, and the restart stops the command and the agent's process.
  await answerDialogs(app, 0);
  await restartHost(settings);
  await expect.poll(() => asked(app)).toEqual([QUESTION, QUESTION]);
  await expect.poll(sleeping, { timeout: 15_000 }).toEqual([]);
  await expect.poll(agents, { timeout: 15_000 }).not.toContain(agent);
});

test("a restart whose question cannot be asked does not go ahead", async ({ app, window }) => {
  await waitForShellReady(window);
  const shell = visiblePane(window, "shell 1").getByTestId("xterm-host");
  await shell.click();
  await window.keyboard.insertText(COMMAND);
  await window.keyboard.press("Enter");
  await expect.poll(sleeping, { timeout: 10_000 }).toHaveLength(1);
  const [sleep] = sleeping();
  // The question fails in main (no handler): before, the restart went ahead without asking and ended the command.
  await app.evaluate(({ ipcMain }) => ipcMain.removeHandler("pty:confirm-restart"));
  await window.locator('.aya-sidebar-row[data-terminal-name="shell 1"]').click({ button: "right" });
  await window.locator(".aya-context-menu-item", { hasText: "Restart terminal" }).click();
  await window.waitForTimeout(2_000);
  expect(sleeping()).toEqual([sleep]);
});
