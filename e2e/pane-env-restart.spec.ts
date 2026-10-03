// Aya launched from foreign agent sessions: the pane runs, exits, and is
// restarted through Shift+Enter. Both spawns must see a clean env.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures";
import { SLOW_EXPECT_TIMEOUT_MS } from "./timeouts";
import { FOREIGN, OUTER_AYA } from "./helpers/foreign-env";
import { agentBin } from "./helpers/agent-bin";
import { firstTerminalShown } from "./helpers/terminal";

// Named like the real CLI: Aya resumes only a command whose program is the agent's own binary.
const CLAUDE = agentBin("claude", join(__dirname, "helpers", "env-dump.cjs"));

test.use({
  seedOptions: {
    split: false,
    // Both dump runs must belong to this pane: a sibling would race the file
    // counter and could masquerade as the restart's second run.
    singleTab: { presetId: "shell", name: "Dump" },
    // Preserve the original two-pane shared-folder latch: both launches stay
    // fresh --session-id launches even after the companion is gone.
    leftSharedDir: true,
    launchEnv: { ...FOREIGN, ...OUTER_AYA },
    presetList: [{ id: "shell", name: "Dump", icon: "d", color: "", agent: "claude", command: `${CLAUDE} "$AYA_PROJECT_DIR"` }],
  },
});

test("launched from a foreign session: the first spawn and the restarted respawn are both clean", async ({ window, seeded }) => {
  await firstTerminalShown(window);
  await expect(window.getByTestId("xterm-host")).toHaveCount(1);
  const run = (n: number) => join(seeded.projectDir, `run-${n}.json`);
  await expect.poll(() => existsSync(run(1)), { timeout: SLOW_EXPECT_TIMEOUT_MS }).toBe(true);
  // The helper writes its file before exiting. Shift+Enter restarts only
  // after the renderer has processed that exit, not merely the file write.
  await expect(window.locator(".aya-sidebar-statusdot--idle")).toHaveCount(1);
  await window.getByTestId("xterm-host").first().click();
  await window.keyboard.press("Shift+Enter");
  await expect.poll(() => existsSync(run(2)), { timeout: SLOW_EXPECT_TIMEOUT_MS }).toBe(true);
  const runs = [1, 2].map((n) => JSON.parse(readFileSync(run(n), "utf8")));
  // The stand-in saves no session, so the respawn is a fresh launch with an id of its own.
  for (const r of runs) expect(r.argv[0], "both spawns carry a session arg").toBe("--session-id");
  for (const [i, r] of runs.entries()) {
    for (const key of [...Object.keys(FOREIGN), "ELECTRON_RUN_AS_NODE"]) expect.soft(r.env[key], `run ${i + 1}: ${key}`).toBeUndefined();
    expect(r.env.AYA_PROJECT_SLUG).toBe("e2e-proj");
    expect(r.env.AYA_PRESET_ID).toBe("shell");
  }
});
