// `aya team open` in the gap after the window loaded but before its project list did (held by a test delay) is refused
// as retryable, and a pane's CLI asks again until the project is there.

import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { test, expect } from "./fixtures";
import { askControl } from "./helpers/control";
import { AYA, agentPreset, readAssignments, TWO_ROLE_TEAM } from "./helpers/team";
import { AGENT_TEST_TIMEOUT_MS } from "./timeouts";

const PROJECTS_STATE_DELAY_MS = 10_000;

test.use({
  seedOptions: {
    presetList: [agentPreset("quiet", "claude")],
    projectFiles: { ".aya/teams/ux-review.md": TWO_ROLE_TEAM },
    ayaHomeFiles: { "teams/e2e-proj/ux-review/saved.md": TWO_ROLE_TEAM, "teams/e2e-proj/ux-review/assignments.json": JSON.stringify({ tester: "tab-left", implementer: "tab-right" }) },
    launchEnv: { AYA_E2E_PROJECTS_STATE_DELAY_MS: String(PROJECTS_STATE_DELAY_MS) },
  },
});

const OPEN = ["team", "open", "--replace", "ux-review", "tester=new:shell"];

test("team open before the project list has loaded is refused as retryable", async ({ app, seeded }) => {
  await (await app.firstWindow()).waitForLoadState("domcontentloaded");
  const reply = await askControl<{ ok: boolean; error?: string; retry?: boolean }>(seeded.ayaHome, { type: "team-open", team: "ux-review", replace: true, panes: [{ role: "tester", target: "new:shell" }] });
  expect(reply).toMatchObject({ ok: false, retry: true });
  expect(reply.error).toMatch(/Aya is still starting/);
  expect(readAssignments(seeded.ayaHome)).toEqual({ tester: "tab-left", implementer: "tab-right" });
});

test("aya team open from a pane waits out the gap and opens the pane", async ({ app, seeded }) => {
  test.setTimeout(AGENT_TEST_TIMEOUT_MS);
  await (await app.firstWindow()).waitForLoadState("domcontentloaded");
  const env = { ...process.env, AYA_SOCKET: join(seeded.ayaHome, "aya.sock"), AYA_HOME: seeded.ayaHome, AYA_TERMINAL_ID: "tab-left", AYA_OPEN_WAIT_SECONDS: "60" };
  const { stdout } = await promisify(execFile)(AYA, OPEN, { env });
  expect(stdout).toMatch(/gave 1 role a pane, 1 new/);
  expect(readAssignments(seeded.ayaHome).tester).not.toBe("tab-left");
});
