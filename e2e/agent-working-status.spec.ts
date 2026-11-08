// The sidebar dot says an agent WORKS from its screen (not from bytes flowing), keeps saying so across a repaint
// between tool calls, and lets go once the screen has settled.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { test, expect } from "./fixtures";
import { envWithoutAya } from "./helpers/env";

const CLI = join(__dirname, "..", "bin", "aya");
const AGENT = join(__dirname, "helpers", "busy-after-enter-agent.cjs");
const WORK_MS = 4000;
const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
const preset = { id: "busy-agent", name: "Busy agent", icon: "a", color: "", agent: "claude", command: `${quote(process.execPath)} ${quote(AGENT)} ${WORK_MS}` };

test.use({ seedOptions: { rightTab: { presetId: "busy-agent", name: "agent" }, presetList: [{ id: "shell", name: "Shell", icon: "$", color: "", command: "$SHELL" }, preset] } });

test("the dot shows work from the screen and releases it afterwards", async ({ seeded, window }) => {
  const dot = (text: string) => window.getByRole("img", { name: `agent: ${text}` });
  await expect(window.getByTestId("xterm-host").last()).toBeVisible();
  await expect.poll(() => execFileSync(CLI, ["pane", "state", "agent"], { env: { ...envWithoutAya(), AYA_HOME: seeded.ayaHome }, encoding: "utf8", timeout: 10_000 }), { timeout: 20_000 }).toContain('"agent": idle');
  await expect(window.getByRole("img", { name: /^agent: Terminal is (idle|running)\.$/ })).toBeVisible();
  execFileSync(CLI, ["pane", "send", "agent", "go"], { env: { ...envWithoutAya(), AYA_HOME: seeded.ayaHome }, timeout: 15_000 });
  await expect(dot("Agent is working.")).toBeVisible({ timeout: 8_000 });
  await expect(dot("Agent is working.")).toHaveClass(/aya-sidebar-statusdot--working/);
  await expect(dot("Agent is working.")).toBeHidden({ timeout: WORK_MS + 6_000 });
  await expect(window.getByRole("img", { name: /^agent: Terminal is (idle|running)\.$/ })).toBeVisible();
});
