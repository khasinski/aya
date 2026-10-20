import type { ElectronApplication } from "@playwright/test";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import config from "../playwright.config";
import { cleanUpSeeded, closeAndWait, expect, hostPidsForHome, launchApp, test as base } from "./fixtures";
import { appEnv, seedEnv, type SeededEnv } from "./helpers/seed";

const test = base.extend<{ peerSeeded: SeededEnv; peerApp: ElectronApplication }>({
  peerSeeded: async ({}, use) => {
    const seeded = seedEnv();
    await use(seeded);
    await cleanUpSeeded(seeded);
  },
  peerApp: async ({ peerSeeded }, use) => {
    const app = await launchApp(peerSeeded);
    await use(app);
    await closeAndWait(app);
  },
});

const PANE_REQUEST_TIMEOUT_MS = 1_500;

/** Do not leave Playwright awaiting a context-bridged IPC promise past the
 *  expect.poll deadline: fixture teardown closes the renderer context. */
async function paneBufferWithin(
  window: import("@playwright/test").Page,
  terminalId: string,
  timeoutMs = PANE_REQUEST_TIMEOUT_MS,
  simulateStalledRequest = false,
): Promise<string | null> {
  return window.evaluate(async ({ id, timeoutMs, simulateStalledRequest }) => {
    let timer: number | undefined;
    try {
      return await Promise.race([
        simulateStalledRequest ? new Promise<string>(() => {}) : window.aya.ptyBuffer(id),
        new Promise<null>((resolve) => { timer = window.setTimeout(() => resolve(null), timeoutMs); }),
      ]);
    } finally {
      if (timer !== undefined) window.clearTimeout(timer);
    }
  }, { id: terminalId, timeoutMs, simulateStalledRequest });
}

async function writePaneWithin(window: import("@playwright/test").Page, terminalId: string, data: string): Promise<boolean> {
  const result = await window.evaluate(async ({ id, text, timeoutMs }) => {
    let timer: number | undefined;
    try {
      return await Promise.race([
        window.aya.ptyWrite(id, text).then((written) => written ? "written" as const : "refused" as const),
        new Promise<"timed-out">((resolve) => { timer = window.setTimeout(() => resolve("timed-out"), timeoutMs); }),
      ]);
    } finally {
      if (timer !== undefined) window.clearTimeout(timer);
    }
  }, { id: terminalId, text: data, timeoutMs: PANE_REQUEST_TIMEOUT_MS });
  if (result === "timed-out") throw new Error(`Pane ${terminalId} did not answer the input request within ${PANE_REQUEST_TIMEOUT_MS} ms.`);
  return result === "written";
}

test("concurrent apps keep separate Aya homes, HOME and Electron user data", async ({ app, seeded, peerApp, peerSeeded }) => {
  const [firstWindow, secondWindow] = await Promise.all([app.firstWindow(), peerApp.firstWindow()]);
  // ElectronApplication.evaluate can lose its result while the two new apps
  // are still starting. Wait until both renderers have loaded before querying
  // the main-process contexts.
  await Promise.all([firstWindow.waitForLoadState("domcontentloaded"), secondWindow.waitForLoadState("domcontentloaded")]);
  const identity = (running: ElectronApplication) => running.evaluate(({ app }) => ({
    ayaHome: process.env.AYA_HOME,
    home: process.env.HOME,
    userData: app.getPath("userData"),
    pid: process.pid,
  }));
  // Keep each main-process CDP evaluation short and serial even though both
  // Aya instances remain open concurrently for the isolation assertions.
  const first = await identity(app);
  const second = await identity(peerApp);
  // Electron canonicalizes macOS's /tmp -> /private/tmp symlink.
  expect(first).toMatchObject({ ayaHome: seeded.ayaHome, home: appEnv(seeded).HOME, userData: realpathSync(seeded.userDataDir) });
  expect(second).toMatchObject({ ayaHome: peerSeeded.ayaHome, home: appEnv(peerSeeded).HOME, userData: realpathSync(peerSeeded.userDataDir) });
  for (const key of ["ayaHome", "home", "userData", "pid"] as const) {
    expect(first[key], key).not.toBe(second[key]);
  }
  expect(await paneBufferWithin(firstWindow, "tab-left", 25, true)).toBeNull();
  for (const window of [firstWindow, secondWindow]) {
    await expect.poll(async () => (await paneBufferWithin(window, "tab-left")) ?? "").not.toBe("");
  }
  const hosts = [seeded, peerSeeded].map((seed) => hostPidsForHome(seed.ayaHome));
  expect(hosts[0]).toHaveLength(1);
  expect(hosts[1]).toHaveLength(1);
  expect(hosts[0][0]).not.toBe(hosts[1][0]);
  for (const seed of [seeded, peerSeeded]) {
    expect(seed.root).toBe(realpathSync(seed.root));
    for (const name of ["aya.sock", "pty-host.sock"]) {
      expect(statSync(join(seed.ayaHome, name)).isSocket(), name).toBe(true);
    }
    expect(Buffer.byteLength(join(seed.ayaHome, "aya-remote.sock"))).toBeLessThanOrEqual(104);
  }
  // Traffic, not just path strings: identical pane ids in two live hosts must
  // address different shells. Split the marker so its command cannot satisfy it.
  await writePaneWithin(firstWindow, "tab-left", "printf 'ISOLATION-%s\\n' 0\n");
  await writePaneWithin(secondWindow, "tab-left", "printf 'ISOLATION-%s\\n' 1\n");
  const buffers: string[] = [];
  for (const [index, window] of [firstWindow, secondWindow].entries()) {
    await expect.poll(async () => (await paneBufferWithin(window, "tab-left")) ?? "").toContain(`ISOLATION-${index}`);
    buffers.push((await paneBufferWithin(window, "tab-left")) ?? "");
  }
  expect(buffers[0]).not.toContain("ISOLATION-1");
  expect(buffers[1]).not.toContain("ISOLATION-0");
});

test("specs sharing the clipboard or built app files run serially after the isolated specs", () => {
  expect(config.fullyParallel).toBe(false);
  const isolated = config.projects!.find((project) => project.name === "isolated")!;
  const shared = config.projects!.find((project) => project.name === "shared-resources")!;
  expect(isolated.fullyParallel).toBe(true);
  expect(shared.workers).toBe(1);
  expect(shared.dependencies).toEqual(["isolated"]);
  expect(isolated.testIgnore).toBeInstanceOf(RegExp);
  expect(shared.testMatch).toBeInstanceOf(RegExp);
  const files = readdirSync(__dirname).filter((file) => file.endsWith(".spec.ts"));
  const usesSharedResource = (file: string) => /clipboard\.(?:readText|readImage|writeText|writeImage)|appendFileSync\(hostScript,|writeFileSync\(packageFile,/.test(readFileSync(join(__dirname, file), "utf8"));
  const assignedToShared = files.filter((file) => (shared.testMatch as RegExp).test(join(__dirname, file)));
  expect(assignedToShared.sort()).toEqual(files.filter(usesSharedResource).sort());
  for (const file of files) {
    expect((isolated.testIgnore as RegExp).test(join(__dirname, file)), file).toBe(assignedToShared.includes(file));
  }
});
