import net from "node:net";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

// Regression for #34 (Part 0): `aya status clear` must actually clear a red
// `error` dot. The control-status handler used to delete externalStatus but keep
// the stale `status: "error"`, so the sidebar dot stayed red forever once an
// agent reported an error and never cleared it. Placement = control-status
// lifecycle; the one invariant: error -> clear leaves no error dot.
//
// No fixed sleeps in this file: readiness and ordering are proven by
// observables (see the helpers below), so the specs are deterministic on slow
// CI runners too (#7 follow-up).

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

// --- deterministic readiness helpers ----------------------------------------

/** Bootstrap is settled once the sidebar marks shell 1 active: the active-tab
 *  map is populated, so no later activation can fire clear-on-focus and wipe a
 *  status we are about to set on the active terminal. */
async function bootstrapped(window: Page): Promise<void> {
  await expect(window.locator(".aya-sidebar-row--active")).toHaveText(
    /shell 1/,
  );
}

/** Prove a pane's shell finished starting up. The PTY buffers typed input
 *  until the shell reads it (the same prompt-agnostic trick as the #32 restart
 *  readiness), so the echoed marker appearing in the pane's rows means startup
 *  output has drained - after this, no late chunk can flip a status we inject.
 *  NOTE: clicking the pane focuses it, which (by design) makes that terminal
 *  the active one - callers that rely on a later focus TRANSITION must click
 *  another pane afterwards. */
async function shellReady(
  window: Page,
  paneIndex: number,
  marker: string,
): Promise<void> {
  const pane = window.locator(".aya-pane").nth(paneIndex);
  await pane.locator(".xterm-screen").click();
  await window.keyboard.insertText(`echo ${marker}`);
  await window.keyboard.press("Enter");
  await expect(pane.locator(".xterm-rows")).toContainText(marker, {
    timeout: 10000,
  });
}

/** Ordering barrier for control updates: sendControl resolves on the server's
 *  reply and the renderer applies control:status events in arrival order, so
 *  once THIS update's effect is visible, every update sent before it has been
 *  applied too. Lets a test assert "the clear was processed" without sleeping.
 *  Targets shell 2, so only usable when shell 2 is not itself under test; call
 *  shellReady(1, ...) first so a late startup chunk cannot flip the waiting
 *  dot back to running. */
async function controlBarrier(
  window: Page,
  ayaHome: string,
  rightTabId: string,
): Promise<void> {
  await sendControl(ayaHome, {
    type: "status",
    level: "waiting",
    text: "sync barrier",
    terminalId: rightTabId,
  });
  await expect(
    window
      .locator(".aya-sidebar-row", { hasText: "shell 2" })
      .locator(".aya-sidebar-statusdot"),
  ).toHaveClass(/aya-sidebar-statusdot--waiting/);
}

function dotFor(window: Page, name: string) {
  return window
    .locator(".aya-sidebar-row", { hasText: name })
    .locator(".aya-sidebar-statusdot");
}

test("aya status clear removes a red error dot (#34)", async ({
  window,
  seeded,
}) => {
  const dot = dotFor(window, "shell 1");

  // Baseline: a freshly spawned shell is not in error.
  await expect(dot).toBeVisible();
  await expect(dot).not.toHaveClass(/aya-sidebar-statusdot--error/);

  // Deterministic readiness: bootstrap settled, BOTH shells past their startup
  // output (shell 2 because the barrier below relies on it).
  await bootstrapped(window);
  await shellReady(window, 1, "READY_CLEAR_R");
  await shellReady(window, 0, "READY_CLEAR_L");

  // Agent reports an error -> dot turns red.
  await sendControl(seeded.ayaHome, {
    type: "status",
    level: "error",
    text: "boom",
    terminalId: seeded.tabIds.left,
  });
  await expect(dot).toHaveClass(/aya-sidebar-statusdot--error/);

  // Agent (or user) clears it -> dot must no longer be red. THIS is the #34
  // regression: clear used to keep the stale status:"error". The barrier
  // proves the clear was processed rather than racing the assertion.
  await sendControl(seeded.ayaHome, {
    type: "status",
    level: "clear",
    terminalId: seeded.tabIds.left,
  });
  await controlBarrier(window, seeded.ayaHome, seeded.tabIds.right);
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
  const dot = dotFor(window, "shell 1");

  // Shell 2 must be ready before it can serve as the ordering barrier target.
  await bootstrapped(window);
  await shellReady(window, 1, "READY_EXIT_R");

  // Exit the shell with a non-zero code -> PTY reducer sets status:"error".
  await pane.locator(".xterm-screen").click();
  await window.keyboard.type("exit 1");
  await window.keyboard.press("Enter");
  await expect(
    window.locator(".aya-pane:first-child .xterm-rows"),
  ).toContainText(/process exited/i, { timeout: 5000 });
  await expect(dot).toHaveClass(/aya-sidebar-statusdot--error/);

  // Clearing the agent status must leave the real exit error in place. The
  // barrier proves the clear has been applied before we assert "still red".
  await sendControl(seeded.ayaHome, {
    type: "status",
    level: "clear",
    terminalId: seeded.tabIds.left,
  });
  await controlBarrier(window, seeded.ayaHome, seeded.tabIds.right);
  await expect(dot).toHaveClass(/aya-sidebar-statusdot--error/);
});

// Part 1 of #34: focusing a terminal acknowledges its stuck agent status -
// there is no separate dismiss control. Reported on the NON-active terminal
// (shell 2) so selecting it is a real focus transition.
test("focusing a terminal clears its stuck agent error (#34, Part 1)", async ({
  window,
  seeded,
}) => {
  const dot = dotFor(window, "shell 2");

  // Readiness: shell 2 past startup (so no late chunk can flip the injected
  // error), then hand focus back to shell 1 so that selecting shell 2 below is
  // a genuine focus TRANSITION (shellReady left shell 2 active).
  await bootstrapped(window);
  await shellReady(window, 1, "READY_FOCUS_R");
  await window.locator(".aya-pane").first().locator(".xterm-screen").click();

  await sendControl(seeded.ayaHome, {
    type: "status",
    level: "error",
    text: "boom",
    terminalId: seeded.tabIds.right,
  });
  await expect(dot).toHaveClass(/aya-sidebar-statusdot--error/);

  // Visit the terminal -> the overlay is acknowledged and the dot clears.
  await window.locator(".aya-sidebar-row", { hasText: "shell 2" }).click();
  await expect(dot).not.toHaveClass(/aya-sidebar-statusdot--error/);
});

// The project-tab badge is a pure aggregate: it stays red while ANY terminal in
// the project is flagged, and only clears once every flagged terminal has been
// visited. The badge reads externalStatus, so it is immune to the PTY-output
// race - only bootstrap needs to have settled (a late activation would fire
// clear-on-focus and wipe the flag we set on the active terminal).
test("project badge persists until every flagged terminal is visited (#34, Part 1)", async ({
  window,
  seeded,
}) => {
  const badge = window.locator(".aya-tab-bell");

  await bootstrapped(window);

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

// Regression for #40: a status carrying an explicit terminalId must land on
// THAT terminal. bin/aya always sends projectSlug + cwd alongside terminalId,
// and both match every sibling terminal in the project - the old single-pass
// matcher let the FIRST sibling (shell 1) win before the exact-id terminal
// (shell 2) was ever considered.
test("status with terminalId targets that terminal, not the project's first (#40)", async ({
  window,
  seeded,
}) => {
  const dot1 = dotFor(window, "shell 1");
  const dot2 = dotFor(window, "shell 2");

  // Shell 2 must be past its startup output: a late chunk would flip the
  // injected error back to "running" and fail the assertion below.
  await bootstrapped(window);
  await shellReady(window, 1, "READY_ROUTE_R");

  // Mimic the full bin/aya payload: terminalId AND projectSlug AND cwd.
  await sendControl(seeded.ayaHome, {
    type: "status",
    level: "error",
    text: "boom",
    terminalId: seeded.tabIds.right,
    projectSlug: "e2e-proj",
    cwd: seeded.projectDir,
  });

  // The exact-id terminal (shell 2) gets the error...
  await expect(dot2).toHaveClass(/aya-sidebar-statusdot--error/);
  // ...and the first project sibling (shell 1) must NOT be painted instead.
  await expect(dot1).not.toHaveClass(/aya-sidebar-statusdot--error/);
});
