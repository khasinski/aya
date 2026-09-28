// Typed into a real shell pane (#117), so the PTY's own AYA_TERMINAL_ID /
// AYA_SOCKET carry the call - nothing is set by the test.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures";
import { AGENT_START_TIMEOUT_MS, AGENT_TEST_TIMEOUT_MS } from "./timeouts";

// App boot plus a login shell; slower than the 45 s default.
test.describe.configure({ timeout: AGENT_TEST_TIMEOUT_MS });

const AYA_CLI = join(__dirname, "..", "bin", "aya");

test("a pane's `aya capabilities` answers and shows up in Diagnostics", async ({
  window,
  seeded,
}) => {
  const out = join(seeded.projectDir, "caps.json");
  await window.locator(".aya-pane").nth(1).locator(".xterm-screen").click();
  // Retyped until it lands: a starting shell drops early input.
  await expect
    .poll(
      async () => {
        if (existsSync(out) && readFileSync(out, "utf8").trim().endsWith("}")) return true;
        await window.keyboard.insertText(`'${AYA_CLI}' capabilities > '${out}'`);
        await window.keyboard.press("Enter");
        return false;
      },
      { message: "the pane never ran aya capabilities", timeout: AGENT_START_TIMEOUT_MS, intervals: [1_000] },
    )
    .toBe(true);

  const doc = JSON.parse(readFileSync(out, "utf8"));
  expect(doc.insideAya).toBe(true);
  expect(doc.terminalId).toBe(seeded.tabIds.right);
  expect(doc.commands.map((c: { command: string }) => c.command)).toContain("pane send");

  const adoption = await window.evaluate(
    async () => (await window.aya.getDiagnostics()).cliAdoption,
  );
  const callers = adoption.filter((row) => row.panesThatRanCapabilities > 0);
  // One row: the call was attributed to the harness the pane was LAUNCHED
  // with - an unrecorded launch would land under "unknown" with 0 launched.
  expect(callers).toHaveLength(1);
  expect(callers[0].panesThatRanCapabilities).toBe(1);
  expect(callers[0].panesLaunched).toBeGreaterThanOrEqual(1);
});
