// `aya pane send --wait` must hold until the agent has started working AND settled; a pane still idle right after
// the send is not done. The stand-in agent works for a fixed time after Enter, so the wait has to last about that long.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test, expect } from "./fixtures";
import { envWithoutAya } from "./helpers/env";

const CLI = join(__dirname, "..", "bin", "aya");
const AGENT = join(__dirname, "helpers", "busy-after-enter-agent.cjs");
const WORK_MS = 2500;
const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
const preset = { id: "busy-agent", name: "Busy agent", icon: "a", color: "", agent: "claude", command: `${quote(process.execPath)} ${quote(AGENT)} ${WORK_MS}` };

test.use({ seedOptions: { rightTab: { presetId: "busy-agent", name: "agent" }, presetList: [{ id: "shell", name: "Shell", icon: "$", color: "", command: "$SHELL" }, preset] } });

const pane = (home: string, args: string[]) =>
  spawnSync(CLI, ["pane", ...args], { env: { ...envWithoutAya(), AYA_HOME: home }, encoding: "utf8", timeout: 40_000 });

test("send --wait returns after the agent worked and went idle, and times out while it still works", async ({ seeded, window }) => {
  await expect(window.getByTestId("xterm-host").last()).toBeVisible();
  await expect.poll(() => { const r = pane(seeded.ayaHome, ["state", "agent"]); return r.stdout || `ERR ${r.status} ${r.stderr}`; }, { timeout: 20_000 }).toContain('"agent": idle');

  const started = Date.now();
  const done = pane(seeded.ayaHome, ["send", "agent", "do the thing", "--wait", "--timeout", "20"]);
  const took = Date.now() - started;
  expect(done.status, done.stderr).toBe(0);
  expect(done.stdout).toContain('"agent" finished and is idle.');
  expect(done.stdout).not.toContain("No work was seen");
  expect(took).toBeGreaterThanOrEqual(WORK_MS - 500);
  await expect.poll(() => pane(seeded.ayaHome, ["state", "agent"]).stdout, { timeout: 10_000 }).toContain('"agent": idle');

  const slow = pane(seeded.ayaHome, ["send", "agent", "again", "--wait", "--timeout", "1"]);
  expect(slow.status).toBe(1);
  expect(slow.stdout).toContain("Timed out after 1 seconds");
});
