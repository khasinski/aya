import { _electron as electron, type ElectronApplication } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, ciElectronFlags, closeAndWait, hostPidsForHome, delay } from "./fixtures";
import { appEnv, type SeededEnv } from "./helpers/seed";
import { waitForShellReady } from "./helpers/terminal";
const root = join(__dirname, "..");
const apps: ElectronApplication[] = [];
test.afterEach(async () => { for (const app of apps.splice(0)) await closeAndWait(app); });
async function launch(seeded: SeededEnv, answer: number) {
  const app = await electron.launch({ cwd: root, args: [join(__dirname, "helpers/owner-question-main.cjs"), `--user-data-dir=${seeded.userDataDir}`, ...ciElectronFlags()],
    env: { ...appEnv(seeded), AYA_E2E_PTY_SHUTDOWN: "0", AYA_OWNER_TEST_ANSWER: String(answer) } });
  apps.push(app); return { app, window: await app.firstWindow() };
}
function questions(home: string): Array<{ detail: string }> {
  const file = join(home, "owner-questions.jsonl"); return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
}
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
for (const answer of [1, 0]) test(`legacy migration ${answer ? "Cancel preserves" : "confirmation replaces"} the original process`, async ({ seeded }) => {
  const legacy = spawn(process.execPath, [join(__dirname, "helpers/legacy-pty-host.cjs")], { cwd: root, env: appEnv(seeded), stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(legacy, "exit");
  try {
    const [bytes] = await once(legacy.stdout!, "data"), before = JSON.parse(String(bytes));
    const { window } = await launch(seeded, answer);
    await expect(window.getByTestId("xterm-host").first()).toBeVisible();
    expect(questions(seeded.ayaHome)).toHaveLength(1); expect(questions(seeded.ayaHome)[0].detail).toContain("cannot be moved from the older host");
    if (answer) { expect(alive(before.child)).toBe(true); expect(existsSync(join(seeded.ayaHome, "pty-owner/record.json"))).toBe(false); }
    else { await expect.poll(() => alive(before.child)).toBe(false); await waitForShellReady(window); expect(existsSync(join(seeded.ayaHome, "pty-owner/record.json"))).toBe(true); }
  } finally { if (legacy.exitCode === null && legacy.signalCode === null) legacy.kill("SIGTERM"); await closed; }
});
for (const answer of [1, 0]) test(`incompatible owner ${answer ? "Cancel retains" : "confirmation stops"} the native inventory`, async ({ seeded }) => {
  const first = await launch(seeded, 1); await waitForShellReady(first.window);
  const file = join(seeded.ayaHome, "pty-owner/record.json"), original = JSON.parse(readFileSync(file, "utf8"));
  apps.splice(apps.indexOf(first.app), 1); await closeAndWait(first.app);
  const hosts = hostPidsForHome(seeded.ayaHome); expect(hosts).toHaveLength(1); process.kill(hosts[0], "SIGKILL");
  await expect.poll(() => alive(hosts[0])).toBe(false);
  // Only this disposable owner's metadata changes; executable/signatures stay intact.
  original.binaryHash = "0".repeat(64); writeFileSync(file, JSON.stringify(original), { mode: 0o600 });
  const second = await launch(seeded, answer);
  await expect(second.window.getByTestId("xterm-host").first()).toBeVisible();
  expect(questions(seeded.ayaHome)).toHaveLength(1); expect(questions(seeded.ayaHome)[0].detail).toMatch(/disconnected|native PTY owner/);
  if (answer) {
    expect(alive(original.pid)).toBe(true);
    for (const pane of original.panes) expect(alive(pane.pid)).toBe(true);
    await expect(second.window.getByTestId("xterm-host").first()).toContainText("disconnected");
    await delay(200); expect(JSON.parse(readFileSync(file, "utf8")).pid).toBe(original.pid);
  } else {
    await expect.poll(() => alive(original.pid)).toBe(false);
    for (const pane of original.panes) await expect.poll(() => alive(pane.pid)).toBe(false);
    await waitForShellReady(second.window); expect(JSON.parse(readFileSync(file, "utf8")).pid).not.toBe(original.pid);
  }
});
