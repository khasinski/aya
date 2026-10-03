import { test, expect } from "./fixtures";
import { SLOW_EXPECT_TIMEOUT_MS } from "./timeouts";
import { PAST_PROBE_MS } from "./helpers/seed";

// A login shell slower than the 2.5 s probe limit must not make an installed CLI "command not found".

test.use({
  seedOptions: {
    split: false,
    singleTab: { presetId: "slowcli", name: "Slow CLI" },
    presetList: [
      { id: "shell", name: "Shell", icon: "$", color: "", command: "$SHELL" },
      { id: "slowcli", name: "Slow CLI", icon: "*", color: "", command: "slowcli" },
    ],
    slowLoginShell: { delayMs: PAST_PROBE_MS, cli: "slowcli" },
  },
});

test("an installed CLI starts even when the login shell answers slower than the probe waits", async ({ window }) => {
  await expect(window.locator(".aya-xterm-host:visible").first()).toContainText("slowcli started", { timeout: SLOW_EXPECT_TIMEOUT_MS });
  await expect(window.locator(".aya-pane-recovery:visible")).toHaveCount(0);
});
