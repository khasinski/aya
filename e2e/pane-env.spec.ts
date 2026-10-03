// Aya launched from another CLI's session or from an Aya pane must not hand that session to its panes: a foreign session
// marker changes how the pane's agent behaves, and the outer pane's project would take a saved team.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures";
import { SLOW_EXPECT_TIMEOUT_MS } from "./timeouts";
import { AYA, NODE } from "./helpers/team";
import { FOREIGN, OUTER_AYA } from "./helpers/foreign-env";
import { firstTerminalShown } from "./helpers/terminal";

const PROBE = join(__dirname, "helpers", "pane-env-probe.cjs");

test.use({
  seedOptions: {
    singleTab: { presetId: "shell", name: "probe" },
    presetList: [{ id: "shell", name: "Probe", icon: "p", color: "", command: `'${NODE}' '${PROBE}' "$AYA_PROJECT_DIR" '${AYA}'` }],
    launchEnv: { ...FOREIGN, ...OUTER_AYA },
  },
});

test("a pane launched from foreign sessions and an outer Aya pane sees only its own", async ({ window, seeded }) => {
  await firstTerminalShown(window);
  const read = (name: string) => join(seeded.projectDir, `${name}-tab-left.json`);
  await expect.poll(() => existsSync(read("save")), { timeout: SLOW_EXPECT_TIMEOUT_MS }).toBe(true);
  const env = JSON.parse(readFileSync(read("env"), "utf8"));
  const save = JSON.parse(readFileSync(read("save"), "utf8"));

  for (const key of [...Object.keys(FOREIGN), "ELECTRON_RUN_AS_NODE"]) expect(env[key], key).toBeUndefined();
  expect(env.AYA_PROJECT_SLUG).toBe("e2e-proj");
  expect(env.AYA_PRESET_ID).toBe("shell");
  expect(env.AYA_TERMINAL_ID).toBe("tab-left");
  expect(save.stderr).toBe("");
  expect(existsSync(join(seeded.ayaHome, "teams", "e2e-proj", "ux-fix", "saved.md"))).toBe(true);
});
