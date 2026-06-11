import {
  test as base,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { rmSync } from "node:fs";
import * as net from "node:net";
import { join } from "node:path";
import { seedEnv, type SeededEnv, type SeedOptions } from "./helpers/seed";

const APP_ROOT = join(__dirname, "..");
const REMOVE_RETRY_COUNT = 5;
const REMOVE_RETRY_DELAY_MS = 100;
export const PTY_HOST_SHUTDOWN_TIMEOUT_MS = 1_000;
export const APP_GRACEFUL_CLOSE_TIMEOUT_MS = 1_000;
export const APP_PROCESS_EXIT_TIMEOUT_MS = 2_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function removeSeededRoot(root: string): Promise<void> {
  for (let attempt = 0; attempt < REMOVE_RETRY_COUNT; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        attempt === REMOVE_RETRY_COUNT - 1 ||
        (code !== "ENOTEMPTY" && code !== "EBUSY" && code !== "EPERM")
      ) {
        throw error;
      }
      await delay(REMOVE_RETRY_DELAY_MS);
    }
  }
}

async function shutdownPtyHost(ayaHome: string): Promise<void> {
  const socketPath = join(ayaHome, "pty-host.sock");
  await Promise.race([
    new Promise<void>((resolve) => {
      const socket = net.createConnection(socketPath);
      socket.once("connect", () => {
        socket.end(`${JSON.stringify({ id: 1, type: "shutdown" })}\n`);
      });
      socket.once("close", resolve);
      socket.once("error", resolve);
    }),
    delay(PTY_HOST_SHUTDOWN_TIMEOUT_MS),
  ]);
}

async function closeAndWait(app: ElectronApplication): Promise<void> {
  const proc = app.process();
  const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
  const closed = app.close().catch(() => undefined);
  await Promise.race([closed, delay(APP_GRACEFUL_CLOSE_TIMEOUT_MS)]);
  if (!proc.killed) proc.kill("SIGKILL");
  await Promise.race([closed, exited, delay(APP_PROCESS_EXIT_TIMEOUT_MS)]);
}

/** Fixtures that launch the built Aya app once per test against an isolated,
 *  seeded environment and tear it down afterward. */
export const test = base.extend<{
  /** Per-test seed options. Override with `test.use({ seedOptions: {...} })`. */
  seedOptions: SeedOptions;
  seeded: SeededEnv;
  app: ElectronApplication;
  window: Page;
}>({
  seedOptions: [{}, { option: true }],

  seeded: async ({ seedOptions }, use) => {
    const s = seedEnv(seedOptions);
    await use(s);
    await removeSeededRoot(s.root);
  },

  app: async ({ seeded }, use) => {
    // Production-like launch: no AYA_DEV, so the app loads the built
    // dist/index.html. ELECTRON_RUN_AS_NODE must be stripped or Electron starts
    // as plain Node (no `app`). AYA_HOME + --user-data-dir isolate all state.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string" && k !== "ELECTRON_RUN_AS_NODE" && k !== "AYA_DEV") {
        env[k] = v;
      }
    }
    env.AYA_HOME = seeded.ayaHome;
    env.AYA_E2E_PTY_SHUTDOWN = "1";
    if (!process.env.CI) {
      env.AYA_E2E_HEADLESS = "1";
    }
    // Isolate Codex usage too: point CODEX_HOME at an empty dir so the Codex
    // chip never picks up the real machine's ~/.codex rollout logs.
    env.CODEX_HOME = join(seeded.root, "codex-home");

    // Point Electron at the built main entry, NOT the app root: a bare
    // directory arg is interpreted by main.ts as "open this project", which
    // would open the aya repo itself as a spurious project. main.ts skips argv
    // entries ending in "main.js", so this avoids that.
    const launchArgs = [
      join(APP_ROOT, "dist-electron", "main.js"),
      `--user-data-dir=${seeded.userDataDir}`,
    ];
    // CI runners can't use the Chromium SUID sandbox, and the GPU process under
    // xvfb keeps app.close() from ever resolving (leaving the worker hung). Both
    // flags are CI-only.
    if (process.env.CI) {
      launchArgs.push("--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage");
    }

    const app = await electron.launch({ args: launchArgs, cwd: APP_ROOT, env });
    await use(app);
    await closeAndWait(app);
    await shutdownPtyHost(seeded.ayaHome);
  },

  window: async ({ app }, use) => {
    const win = await app.firstWindow();
    await win.waitForLoadState("domcontentloaded");
    await use(win);
  },
});

export const expect = test.expect;
