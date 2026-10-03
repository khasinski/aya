// Claude's Notification hook (`aya status waiting`) and Stop hook (`aya status done`) both arrive while its permission
// dialog is still up: the screen owns dialogs, so the pane stays waiting and no "finished" row is written.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures";
import { SLOW_EXPECT_TIMEOUT_MS } from "./timeouts";
import { sendControl } from "./helpers/control";
import { AYA } from "./helpers/team";
import { firstTerminalShown } from "./helpers/terminal";

const NODE = process.execPath;
const SCRIPT = join(__dirname, "helpers", "dialog-then-hook.cjs");
const CLAUDE_AT_DIALOG = { id: "shell", name: "Claude", icon: "c", color: "", agent: "claude", command: `'${NODE}' '${SCRIPT}' '${AYA}'` };

const SHELL = { id: "plain", name: "Shell", icon: "$", color: "", command: "$SHELL" };

test.use({ seedOptions: { presetList: [CLAUDE_AT_DIALOG, SHELL], rightTab: { presetId: "plain", name: "barrier" } } });

test("a hook's finished turn while a permission dialog is on screen leaves the pane waiting", async ({ window, seeded }) => {
  await firstTerminalShown(window);
  const dot = window.locator('.aya-sidebar-row[data-terminal-id="tab-left"] .aya-sidebar-statusdot');
  await expect(dot).toHaveClass(/aya-sidebar-statusdot--waiting/, { timeout: SLOW_EXPECT_TIMEOUT_MS });

  writeFileSync(join(seeded.projectDir, "go-tab-left"), "");
  const log = () => {
    const file = join(seeded.projectDir, "dialog-tab-left.log");
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  };
  await expect.poll(log, { timeout: SLOW_EXPECT_TIMEOUT_MS }).toMatch(/HOOK-SENT\n/);
  // The window applies control statuses in arrival order: once one sent after the hooks' shows, theirs have landed.
  await sendControl(seeded.ayaHome, { type: "status", level: "error", text: "barrier", terminalId: seeded.tabIds.right });
  await expect(window.locator('.aya-sidebar-row[data-terminal-id="tab-right"] .aya-sidebar-statusdot')).toHaveClass(/aya-sidebar-statusdot--error/);
  await expect(dot).toHaveClass(/aya-sidebar-statusdot--waiting/);
  // The finished turn did arrive: it is the pane's reported status, only the dialog outranks it.
  await expect(window.locator('[data-testid="terminal-pane"][data-terminal-id="tab-left"] .aya-pane-header-activity--done')).toHaveText("Turn finished");

  await window.getByTitle("Open attention center").click();
  const timeline = window.locator(".aya-attention-modal .aya-timeline-row");
  await expect(timeline.filter({ hasText: "reported an error" })).toHaveCount(1);
  await expect(timeline.filter({ hasText: "finished" })).toHaveCount(0);
});
