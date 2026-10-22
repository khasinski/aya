import { test, expect } from "./fixtures";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RemoteTerminalClient } from "../dist-electron/remote-client.js";
import { sshArgs } from "../dist-electron/ssh.js";

const SHOTS = "/tmp/aya-remote-terminal-client-screens";

test.describe("remote terminal v2 client", () => {
  test.use({ seedOptions: { remoteProject: true, remoteTerminalHost: "v2", split: false, singleTab: { presetId: "shell", name: "Remote shell" } } });

  test("types, resizes, detaches, and reattaches with output replay while another client stays read-only", async ({ window, seeded }) => {
    mkdirSync(SHOTS, { recursive: true });
    await expect(window.locator('[data-testid="terminal-pane"][data-terminal-id="tab-left"]')).toBeVisible({ timeout: 20_000 });
    await window.getByRole("button", { name: "$ Shell", exact: true }).click();
    const pane = window.locator('[data-testid="terminal-pane"][data-terminal-name="Shell"]');
    await expect(pane).toBeVisible({ timeout: 20_000 });
    const terminalId = await pane.getAttribute("data-terminal-id");
    expect(terminalId).toBeTruthy();
    await expect(pane.locator(".aya-pane-remote-label")).toHaveText(/Remote: fakehost/);
    await expect(window.locator(".aya-tab-remote-chip").first()).toHaveText(/Remote: fakehost/);
    await expect(window.locator('[data-testid="sidebar-terminal"][data-terminal-name="Shell"] .aya-tab-remote-chip')).toHaveText(/Remote: fakehost/);
    await expect.poll(() => readRemoteState(seeded.root).find((item) => item.terminalId === terminalId)?.pid).toBeGreaterThan(1);

    await pane.locator(".xterm-screen").click();
    await window.keyboard.type("REMOTE_V2_INPUT");
    await window.keyboard.press("Enter");
    await expect.poll(async () => occurrences(await pane.locator(".xterm-rows").innerText(), "REMOTE_V2_INPUT"), { timeout: 10_000 }).toBe(2);

    const beforeResize = readRemoteState(seeded.root).find((item) => item.terminalId === terminalId)?.size;
    await window.setViewportSize({ width: 920, height: 610 });
    await expect.poll(() => readRemoteState(seeded.root).find((item) => item.terminalId === terminalId)?.size).not.toEqual(beforeResize);

    const processBeforeDetach = readRemoteState(seeded.root).find((item) => item.terminalId === terminalId)?.pid;
    expect(processBeforeDetach).toBeGreaterThan(1);
    const observer = openObserver(seeded.root);
    try {
      const attached = await observer.attach(terminalId!, 0);
      expect(attached.readOnly).toBe(true);
      await expect(observer.write(terminalId!, "MUST_NOT_TYPE\n")).rejects.toThrow(/another Aya controls this host/i);
      await expect(observer.resize(terminalId!, 101, 33)).rejects.toThrow(/another Aya controls this host/i);
    } finally {
      await observer.detach();
    }

    // This is the same close path used when a pane tab is closed, while the
    // saved tab remains available for a later mount.
    await window.evaluate((id) => window.aya.ptyKill(id), terminalId);
    expect(isAlive(processBeforeDetach!)).toBe(true);
    const afterDetach = openObserver(seeded.root);
    try {
      expect((await afterDetach.list()).find((item) => item.terminalId === terminalId)?.state).toBe("running");
      await afterDetach.attach(terminalId!, 0);
      await afterDetach.write(terminalId!, "OUTPUT_DURING_DETACH\n");
    } finally {
      await afterDetach.detach();
    }

    await window.evaluate(({ id, cwd }) => window.aya.ptySpawn({
      ptyId: id,
      projectSlug: "e2e-proj",
      presetId: "shell",
      command: "cat",
      cwd,
      cols: 80,
      rows: 24,
      attachOnly: true,
    }), { id: terminalId!, cwd: seeded.projectDir });
    await expect.poll(async () => occurrences(await pane.locator(".xterm-rows").innerText(), "OUTPUT_DURING_DETACH"), { timeout: 10_000 }).toBe(2);
    expect(readRemoteState(seeded.root).find((item) => item.terminalId === terminalId)?.pid).toBe(processBeforeDetach);
    await window.screenshot({ path: join(SHOTS, "remote-terminal.png") });

    // The fixture's host preset is `cat`; EOF makes its process exit without
    // ending the stable local tab. Restart must spawn a fresh host PTY rather
    // than attaching to that already-exited session id.
    await pane.locator(".xterm-screen").click();
    await window.keyboard.press("Control+D");
    const exitObserver = openObserver(seeded.root);
    try {
      await expect.poll(async () => (await exitObserver.list()).find((item) => item.terminalId === terminalId)?.state, { timeout: 10_000 }).toBe("exited");
    } finally {
      await exitObserver.detach();
    }
    await pane.locator(".xterm-screen").click();
    await window.keyboard.press("Shift+Enter");
    await expect.poll(() => {
      const pid = readRemoteState(seeded.root).find((item) => item.terminalId === terminalId)?.pid;
      return typeof pid === "number" && pid > 1 && pid !== processBeforeDetach;
    }, { timeout: 10_000 }).toBe(true);
    const restartedPid = readRemoteState(seeded.root).find((item) => item.terminalId === terminalId)?.pid;
    expect(restartedPid).toBeGreaterThan(1);
    await pane.locator(".xterm-screen").click();
    await window.keyboard.type("REMOTE_AFTER_RESTART");
    await window.keyboard.press("Enter");
    await expect.poll(async () => occurrences(await pane.locator(".xterm-rows").innerText(), "REMOTE_AFTER_RESTART"), { timeout: 10_000 }).toBe(2);

    await pane.locator(".xterm-screen").click({ button: "right" });
    await window.getByTestId("terminal-context-end-remote").click();
    await expect.poll(() => isAlive(restartedPid!)).toBe(false);
  });
});

test.describe("remote terminal v1 fallback", () => {
  test.use({ seedOptions: { remoteProject: true, remoteTerminalHost: "v1", split: false, singleTab: { presetId: "shell", name: "Remote shell" } } });

  test("uses the direct SSH terminal with a visible one-line notice", async ({ window }) => {
    const pane = window.locator('[data-testid="terminal-pane"][data-terminal-id="tab-left"]');
    await expect(pane).toBeVisible({ timeout: 20_000 });
    await expect(pane.locator(".xterm-rows")).toContainText("Aya is using a direct SSH terminal; closing it ends the session.", { timeout: 20_000 });
    await pane.locator(".xterm-screen").click();
    await window.keyboard.type("LEGACY_FALLBACK_INPUT");
    await window.keyboard.press("Enter");
    await expect(pane.locator(".xterm-rows")).toContainText("LEGACY_FALLBACK_INPUT", { timeout: 10_000 });
  });
});

function readRemoteState(root: string): Array<{ terminalId: string; pid: number | null; size: { cols: number; rows: number } | null }> {
  try { return JSON.parse(readFileSync(join(root, "remote-terminal-state.json"), "utf8")); }
  catch { return []; }
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

function occurrences(text: string, marker: string): number {
  return text.split(marker).length - 1;
}

function openObserver(root: string): RemoteTerminalClient {
  const bridge = spawn("ssh", sshArgs("me@fakehost", ["aya remote --stdio"]), {
    env: {
      ...process.env,
      PATH: `${join(root, "remote-bin")}:${process.env.PATH ?? ""}`,
      AYA_REMOTE_SOCKET: join(root, "remote-terminal.sock"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  return new RemoteTerminalClient(bridge);
}
