import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect, PTY_HOST_SCRIPT, delay } from "./fixtures";
import { fireShortcut } from "./helpers/shortcut";
import type { ElectronApplication, Page } from "@playwright/test";

// Settings > Diagnostics speaks for the same account of the terminal host that Aya's launch check and the Restart
// Aya red dot use, and says what is wrong. Both states below happened on 2026-10-13: a host serving every pane with
// no pty-host.sock, and a second host holding duplicate agents that no window showed.

async function openDiagnostics(app: ElectronApplication, window: Page) {
  await window.waitForLoadState("load");
  await fireShortcut(app, "open-settings");
  const settings = window.locator(".aya-modal--settings");
  await expect(settings).toBeVisible();
  await settings.getByTestId("settings-tab").filter({ hasText: "Diagnostics" }).click();
  return settings;
}

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("a host with no pty-host.sock is warned about, and Restart puts things right", async ({ window, app, seeded }) => {
  const settings = await openDiagnostics(app, window);
  const refresh = settings.locator(".aya-modal-btn", { hasText: "Refresh" });
  const report = async () => {
    await refresh.click();
    const pre = settings.locator(".aya-settings-diagnostics-json");
    await expect(pre).not.toBeEmpty();
    return JSON.parse((await pre.innerText()).trim());
  };
  // Once Aya talks to its host: removing the socket earlier would race Aya's own first connection to it.
  await expect.poll(async () => (await report()).ptyHost.pid, { timeout: 15_000 }).toBeGreaterThan(1);
  await expect(settings.locator(".aya-settings-diagnostics-warnings")).toHaveCount(0);

  // The state the 2026-10-13 race left: the host Aya uses runs, its socket file is gone.
  const socket = join(seeded.ayaHome, "pty-host.sock");
  unlinkSync(socket);
  await refresh.click();
  const warnings = settings.getByRole("status").filter({ hasText: "Warning:" });
  await expect(warnings).toContainText("has no pty-host.sock: the next Aya start will start a second host");

  window.once("dialog", (dialog) => void dialog.accept());
  await settings.locator(".aya-settings-general-row", { hasText: "PTY host" }).getByRole("button", { name: "Restart" }).click();
  await expect.poll(() => existsSync(socket), { timeout: 15_000 }).toBe(true);
  await refresh.click();
  await expect(settings.locator(".aya-settings-diagnostics-warnings")).toHaveCount(0);
});

test("a running host Aya does not use is listed, and Stop other hosts ends it", async ({ window, app, seeded }) => {
  // A real host of this build under another home, entered in this Aya's registry: as the orphaned host was.
  const otherHome = mkdtempSync(join(tmpdir(), "aya-e2e-other-"));
  const other = spawn(process.execPath, [PTY_HOST_SCRIPT], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, AYA_HOME: otherHome, ELECTRON_RUN_AS_NODE: "1" },
  });
  const otherPid = other.pid as number;
  try {
    const records = join(otherHome, "pty-hosts");
    await expect.poll(() => (existsSync(records) ? readdirSync(records).length : 0), { timeout: 15_000 }).toBe(1);
    mkdirSync(join(seeded.ayaHome, "pty-hosts"), { recursive: true });
    copyFileSync(join(records, `${otherPid}.json`), join(seeded.ayaHome, "pty-hosts", `${otherPid}.json`));

    const settings = await openDiagnostics(app, window);
    await settings.locator(".aya-modal-btn", { hasText: "Refresh" }).click();
    const warnings = settings.getByRole("status").filter({ hasText: "Warning:" });
    await expect(warnings).toContainText(`1 other terminal host still runs (pid ${otherPid})`);
    const json = JSON.parse((await settings.locator(".aya-settings-diagnostics-json").innerText()).trim());
    expect(json.ptyHost.otherHosts.map((h: { pid: number }) => h.pid)).toEqual([otherPid]);

    // Aya asks in the main process (Aya Web reaches this too): a no stops nothing, a yes stops the host.
    const answer = async (response: number) =>
      app.evaluate(({ dialog }, response) => {
        const asked: string[] = [];
        (globalThis as { __asked?: string[] }).__asked = asked;
        dialog.showMessageBox = (async (...args: unknown[]) => {
          const options = args.find((a) => a && typeof a === "object" && "message" in (a as object)) as { message: string; detail?: string };
          asked.push(`${options.message} ${options.detail ?? ""}`);
          return { response, checkboxChecked: false };
        }) as typeof dialog.showMessageBox;
      }, response);
    const asked = () => app.evaluate(() => (globalThis as { __asked?: string[] }).__asked ?? []);
    await answer(1);
    await settings.getByRole("button", { name: "Stop other hosts" }).click();
    await expect.poll(asked).toHaveLength(1);
    expect((await asked())[0]).toContain("another terminal host still running from before");
    expect(isAlive(otherPid)).toBe(true);

    await answer(0);
    await settings.getByRole("button", { name: "Stop other hosts" }).click();
    await expect.poll(() => isAlive(otherPid), { timeout: 15_000 }).toBe(false);
    await expect(settings.locator(".aya-settings-diagnostics-warnings")).toHaveCount(0);
  } finally {
    if (isAlive(otherPid)) process.kill(-otherPid, "SIGKILL");
    await delay(100);
    rmSync(otherHome, { recursive: true, force: true });
  }
});
