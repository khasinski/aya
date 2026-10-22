import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, cleanUpSeeded, closeAndWait, hostPidsForHome, launchApp } from "./fixtures";
import { seedEnv } from "./helpers/seed";

test.use({
  seedOptions: {
    remoteProject: true,
    split: false,
    singleTab: { presetId: "shell", name: "Remote shell" },
  },
});

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

test("a real host Aya relaunch restores a remote PTY and replays the exact gap", async ({ seeded }) => {
  test.setTimeout(90_000);
  const triggerPath = join(seeded.root, "release-remote-session");
  const emittedPath = join(seeded.root, "remote-session-gap-emitted");
  const pidDirectory = join(seeded.root, "remote-session-pids");
  const gapRecord = join(seeded.root, "remote-session-gap-bytes");
  const command = [
    `printf '%s' "$$" > ${shellQuote(pidDirectory)}-"$AYA_TERMINAL_ID"`,
    "printf 'REMOTE_SESSION_READY\\n'",
    `while [ ! -e ${shellQuote(triggerPath)} ]; do sleep 0.05; done`,
    `printf 'HOST_AYA_RELAUNCH_GAP\\n' | tee -a ${shellQuote(gapRecord)}-"$AYA_TERMINAL_ID"`,
    `: > ${shellQuote(emittedPath)}-"$AYA_TERMINAL_ID"`,
    "exec cat",
  ].join("; ");
  const hostSeed = seedEnv({
    singleTab: { presetId: "shell", name: "Host shell" },
    split: false,
    presetList: [{ id: "shell", name: "Shell", icon: "$", color: "", command }],
    launchEnv: { AYA_E2E_PTY_SHUTDOWN: "0" },
  });
  const remoteSocket = join(hostSeed.ayaHome, "aya-remote.sock");
  let hostApp: Awaited<ReturnType<typeof launchApp>> | undefined;
  let clientApp: Awaited<ReturnType<typeof launchApp>> | undefined;

  try {
    hostApp = await launchApp(hostSeed);
    const hostWindow = await hostApp.firstWindow();
    await expect(hostWindow.getByTestId("xterm-host").first()).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => existsSync(remoteSocket), { timeout: 20_000 }).toBe(true);

    // The test client points its ordinary SSH shim at the real host Aya's
    // remote socket. Only transport is local; the remote server and session
    // restoration are owned by the actual Electron main process.
    const clientProjectFile = join(seeded.ayaHome, "projects", "e2e-proj.json");
    const clientProject = JSON.parse(readFileSync(clientProjectFile, "utf8"));
    clientProject.remote.directory = hostSeed.projectDir;
    writeFileSync(clientProjectFile, JSON.stringify(clientProject, null, 2), { mode: 0o600 });
    seeded.launchEnv = { ...seeded.launchEnv, AYA_REMOTE_SOCKET: remoteSocket };

    clientApp = await launchApp(seeded);
    const clientWindow = await clientApp.firstWindow();
    await expect(clientWindow.locator('[data-testid="terminal-pane"][data-terminal-id="tab-left"]')).toBeVisible({ timeout: 20_000 });
    await clientWindow.getByRole("button", { name: "$ Shell", exact: true }).click();
    const pane = clientWindow.locator('[data-testid="terminal-pane"][data-terminal-name="Shell"]');
    await expect(pane).toBeVisible({ timeout: 20_000 });
    await expect(pane.locator(".aya-pane-remote-label")).toContainText("Remote:");
    await expect(pane.locator(".xterm-rows")).toContainText("REMOTE_SESSION_READY", { timeout: 20_000 });
    const terminalId = await pane.getAttribute("data-terminal-id");
    expect(terminalId).toBeTruthy();

    const hostPtyHostPids = hostPidsForHome(hostSeed.ayaHome);
    expect(hostPtyHostPids).toHaveLength(1);
    const originalPid = Number(readFileSync(`${pidDirectory}-${terminalId}`, "utf8"));
    expect(originalPid).toBeGreaterThan(1);
    const oldMainPid = hostApp.process().pid;

    await closeAndWait(hostApp);
    hostApp = undefined;
    expect(hostPidsForHome(hostSeed.ayaHome)).toEqual(hostPtyHostPids);
    expect(() => process.kill(originalPid, 0)).not.toThrow();
    await expect(pane.getByTestId("terminal-history-notice")).toContainText("Disconnected from", { timeout: 15_000 });

    // The surviving PTY emits while the host Aya main and its remote socket
    // are gone. Its marker file is written only after the bytes reach the PTY.
    writeFileSync(triggerPath, "release");
    await expect.poll(() => existsSync(`${emittedPath}-${terminalId}`), { timeout: 10_000 }).toBe(true);

    hostApp = await launchApp(hostSeed);
    expect(hostApp.process().pid).not.toBe(oldMainPid);
    const relaunchedHostWindow = await hostApp.firstWindow();
    await expect(relaunchedHostWindow.getByTestId("xterm-host").first()).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => existsSync(remoteSocket), { timeout: 20_000 }).toBe(true);
    expect(Number(readFileSync(`${pidDirectory}-${terminalId}`, "utf8"))).toBe(originalPid);
    expect(() => process.kill(originalPid, 0)).not.toThrow();
    expect(readFileSync(`${gapRecord}-${terminalId}`, "utf8")).toBe("HOST_AYA_RELAUNCH_GAP\n");

    await expect(pane.locator(".xterm-rows")).toContainText("HOST_AYA_RELAUNCH_GAP", { timeout: 20_000 });
    await expect.poll(async () => {
      const text = await pane.locator(".xterm-rows").innerText();
      return {
        ready: text.split("REMOTE_SESSION_READY").length - 1,
        gap: text.split("HOST_AYA_RELAUNCH_GAP").length - 1,
      };
    }).toEqual({ ready: 1, gap: 1 });
    await pane.locator(".xterm-screen").click();
    await clientWindow.keyboard.type("INPUT_AFTER_HOST_AYA_RELAUNCH");
    await clientWindow.keyboard.press("Enter");
    await expect.poll(async () => (await pane.locator(".xterm-rows").innerText()).split("INPUT_AFTER_HOST_AYA_RELAUNCH").length - 1).toBe(2);
  } finally {
    if (clientApp) await closeAndWait(clientApp);
    if (hostApp) await closeAndWait(hostApp);
    await cleanUpSeeded(hostSeed);
  }
});
