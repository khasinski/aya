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

test("concurrent apps keep separate Aya homes, HOME and Electron user data", async ({ app, seeded, peerApp, peerSeeded }) => {
  const identity = (running: ElectronApplication) => running.evaluate(({ app }) => ({
    ayaHome: process.env.AYA_HOME,
    home: process.env.HOME,
    userData: app.getPath("userData"),
    pid: process.pid,
  }));
  const [first, second] = await Promise.all([identity(app), identity(peerApp)]);
  // Electron canonicalizes macOS's /tmp -> /private/tmp symlink.
  expect(first).toMatchObject({ ayaHome: seeded.ayaHome, home: appEnv(seeded).HOME, userData: realpathSync(seeded.userDataDir) });
  expect(second).toMatchObject({ ayaHome: peerSeeded.ayaHome, home: appEnv(peerSeeded).HOME, userData: realpathSync(peerSeeded.userDataDir) });
  for (const key of ["ayaHome", "home", "userData", "pid"] as const) {
    expect(first[key], key).not.toBe(second[key]);
  }
  const [firstWindow, secondWindow] = await Promise.all([app.firstWindow(), peerApp.firstWindow()]);
  for (const window of [firstWindow, secondWindow]) {
    await expect.poll(() => window.evaluate(() => window.aya.ptyBuffer("tab-left"))).not.toBe("");
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
  await Promise.all([firstWindow, secondWindow].map((window, i) => window.evaluate(
    (n) => window.aya.ptyWrite("tab-left", `printf 'ISOLATION-%s\\n' ${n}\n`), i,
  )));
  const buffers = await Promise.all([firstWindow, secondWindow].map(async (window, i) => {
    await expect.poll(() => window.evaluate(() => window.aya.ptyBuffer("tab-left"))).toContain(`ISOLATION-${i}`);
    return window.evaluate(() => window.aya.ptyBuffer("tab-left"));
  }));
  expect(buffers[0]).not.toContain("ISOLATION-1");
  expect(buffers[1]).not.toContain("ISOLATION-0");
});

test("specs sharing the clipboard or built host run serially after the isolated specs", () => {
  expect(config.fullyParallel).toBe(false);
  const isolated = config.projects!.find((project) => project.name === "isolated")!;
  const shared = config.projects!.find((project) => project.name === "shared-resources")!;
  expect(isolated.fullyParallel).toBe(true);
  expect(shared.workers).toBe(1);
  expect(shared.dependencies).toEqual(["isolated"]);
  expect(isolated.testIgnore).toBeInstanceOf(RegExp);
  expect(shared.testMatch).toBeInstanceOf(RegExp);
  const files = readdirSync(__dirname).filter((file) => file.endsWith(".spec.ts"));
  const usesSharedResource = (file: string) => /clipboard\.(?:readText|writeText)|appendFileSync\(hostScript,/.test(readFileSync(join(__dirname, file), "utf8"));
  const assignedToShared = files.filter((file) => (shared.testMatch as RegExp).test(join(__dirname, file)));
  expect(assignedToShared.sort()).toEqual(files.filter(usesSharedResource).sort());
  for (const file of files) {
    expect((isolated.testIgnore as RegExp).test(join(__dirname, file)), file).toBe(assignedToShared.includes(file));
  }
});
