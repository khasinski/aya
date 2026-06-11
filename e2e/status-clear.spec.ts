import net from "node:net";
import { join } from "node:path";
import { test, expect } from "./fixtures";

// Regression for #34 (Part 0): `aya status clear` must actually clear a red
// `error` dot. The control-status handler used to delete externalStatus but keep
// the stale `status: "error"`, so the sidebar dot stayed red forever once an
// agent reported an error and never cleared it. Placement = control-status
// lifecycle; the one invariant: error -> clear leaves no error dot.

// Send one control-socket request (newline-delimited JSON), resolve on the
// server's `{ ok }` reply. Mirrors what `bin/aya status ...` writes.
function sendControl(
  ayaHome: string,
  payload: Record<string, unknown>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(join(ayaHome, "aya.sock"));
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on("data", () => resolve());
    socket.on("error", reject);
    socket.on("close", () => resolve());
  });
}

test("aya status clear removes a red error dot (#34)", async ({
  window,
  seeded,
}) => {
  const dot = window
    .locator(".aya-sidebar-row", { hasText: "shell 1" })
    .locator(".aya-sidebar-statusdot");

  // Baseline: a freshly spawned shell is not in error.
  await expect(dot).toBeVisible();
  await expect(dot).not.toHaveClass(/aya-sidebar-statusdot--error/);

  // Let the shell's startup output drain. The PTY reducer sets status="running"
  // on every data chunk, so late startup output would otherwise flip the dot
  // away from "error" on its own and mask the clear bug (false green).
  await window.waitForTimeout(2000);

  // Agent reports an error -> dot turns red.
  await sendControl(seeded.ayaHome, {
    type: "status",
    level: "error",
    text: "boom",
    terminalId: seeded.tabIds.left,
  });
  await expect(dot).toHaveClass(/aya-sidebar-statusdot--error/);

  // Guard against the PTY-output race: the error must be STABLE (the PTY is
  // quiet). If startup output were still arriving it would flip the dot to
  // "running" here and this would fail loudly instead of a silent false green.
  await window.waitForTimeout(1500);
  await expect(dot).toHaveClass(/aya-sidebar-statusdot--error/);

  // Agent (or user) clears it -> dot must no longer be red. THIS is the #34
  // regression: clear used to keep the stale status:"error".
  await sendControl(seeded.ayaHome, {
    type: "status",
    level: "clear",
    terminalId: seeded.tabIds.left,
  });
  await expect(dot).not.toHaveClass(/aya-sidebar-statusdot--error/);
});

// Counterpart invariant: `clear` strips the AGENT overlay but must NOT erase a
// real PTY error. A non-zero exit is a genuine lifecycle condition, so the dot
// stays red after clear. Guards the `exitCode !== 0 -> "error"` branch of the
// fix (a naive "clear always -> idle" would regress this silently).
test("aya status clear keeps a red dot for a genuinely failed terminal (#34)", async ({
  window,
  seeded,
}) => {
  const pane = window.locator(".aya-pane").first();
  const dot = window
    .locator(".aya-sidebar-row", { hasText: "shell 1" })
    .locator(".aya-sidebar-statusdot");

  // Exit the shell with a non-zero code -> PTY reducer sets status:"error".
  await pane.locator(".xterm-screen").click();
  await window.keyboard.type("exit 1");
  await window.keyboard.press("Enter");
  await expect(window.locator(".aya-pane:first-child .xterm-rows")).toContainText(
    /process exited/i,
    { timeout: 5000 },
  );
  await expect(dot).toHaveClass(/aya-sidebar-statusdot--error/);

  // Clearing the agent status must leave the real exit error in place.
  await sendControl(seeded.ayaHome, {
    type: "status",
    level: "clear",
    terminalId: seeded.tabIds.left,
  });
  await window.waitForTimeout(1000);
  await expect(dot).toHaveClass(/aya-sidebar-statusdot--error/);
});

// Part 1 of #34: focusing a terminal acknowledges its stuck agent status -
// there is no separate dismiss control. Reported on the NON-active terminal
// (shell 2) so selecting it is a real focus transition.
test("focusing a terminal clears its stuck agent error (#34, Part 1)", async ({
  window,
  seeded,
}) => {
  const dot = window
    .locator(".aya-sidebar-row", { hasText: "shell 2" })
    .locator(".aya-sidebar-statusdot");

  // Drain startup output (see the first test for why) then report an error on
  // the non-active terminal.
  await window.waitForTimeout(2000);
  await sendControl(seeded.ayaHome, {
    type: "status",
    level: "error",
    text: "boom",
    terminalId: seeded.tabIds.right,
  });
  await expect(dot).toHaveClass(/aya-sidebar-statusdot--error/);
  // Stable (PTY quiet) - not masked by the output race.
  await window.waitForTimeout(1500);
  await expect(dot).toHaveClass(/aya-sidebar-statusdot--error/);

  // Visit the terminal -> the overlay is acknowledged and the dot clears.
  await window.locator(".aya-sidebar-row", { hasText: "shell 2" }).click();
  await expect(dot).not.toHaveClass(/aya-sidebar-statusdot--error/);
});

// The project-tab badge is a pure aggregate: it stays red while ANY terminal in
// the project is flagged, and only clears once every flagged terminal has been
// visited. The badge reads externalStatus, so it is immune to the PTY-output
// race (no drain needed).
test("project badge persists until every flagged terminal is visited (#34, Part 1)", async ({
  window,
  seeded,
}) => {
  const badge = window.locator(".aya-tab-bell");

  // Let bootstrap settle so the active-tab is stable; otherwise the late
  // activation would fire clear-on-focus and wipe the flag we set on the
  // active terminal before we can assert on it.
  await window.waitForTimeout(2000);

  // Flag BOTH terminals (shell 1 is the active one, shell 2 is not).
  await sendControl(seeded.ayaHome, {
    type: "status",
    level: "error",
    text: "boom 1",
    terminalId: seeded.tabIds.left,
  });
  await sendControl(seeded.ayaHome, {
    type: "status",
    level: "error",
    text: "boom 2",
    terminalId: seeded.tabIds.right,
  });
  await expect(badge).toHaveClass(/aya-tab-bell--error/);

  // Visit shell 2 -> its flag clears, but shell 1 still holds the badge red.
  await window.locator(".aya-sidebar-row", { hasText: "shell 2" }).click();
  await expect(badge).toHaveClass(/aya-tab-bell--error/);

  // Visit shell 1 -> the last flag clears, so the aggregate badge disappears.
  await window.locator(".aya-sidebar-row", { hasText: "shell 1" }).click();
  await expect(badge).toHaveCount(0);
});
