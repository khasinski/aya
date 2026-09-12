import {
  test as base,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
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

/** Signal 0 checks existence without delivering anything. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function closeAndWait(app: ElectronApplication): Promise<void> {
  const proc = app.process();
  const pid = proc.pid;
  const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
  const closed = app.close().catch(() => undefined);
  await Promise.race([closed, delay(APP_GRACEFUL_CLOSE_TIMEOUT_MS)]);

  // Escalate on liveness, not `proc.killed` ("a signal was sent"): Playwright
  // sends one first, so SIGKILL was skipped - leaks were found alive 13 h later.
  if (pid !== undefined && isAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone between the check and the signal
    }
  }
  await Promise.race([exited, delay(APP_PROCESS_EXIT_TIMEOUT_MS)]);

  // SIGKILL cannot be caught, so a survivor is a real leak: it keeps its temp
  // AYA_HOME and respawns its pty-host, starving every later run in the suite.
  if (pid !== undefined && isAlive(pid)) {
    console.error(`[e2e] app pid ${pid} survived SIGKILL - it will disturb later tests`);
  }
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

  seeded: async ({ seedOptions }, use, testInfo) => {
    const s = seedEnv(seedOptions);
    await use(s);
    // Attach the PTY lifecycle log before the root is wiped: the only record.
    if (testInfo.status !== testInfo.expectedStatus) {
      for (const name of ["pty-events.log", "pty-events.log.1"]) {
        const p = join(s.ayaHome, name);
        if (existsSync(p)) {
          await testInfo.attach(name, { path: p, contentType: "text/plain" });
        }
      }
    }
    await removeSeededRoot(s.root);
  },

  app: async ({ seeded, seedOptions }, use) => {
    // A host started FIRST makes the app treat it as REUSED, so boot-restored
    // tabs must attach-only instead of respawning.
    let preStartedHost: ChildProcess | null = null;
    if (seedOptions.preStartPtyHost) {
      preStartedHost = spawn(
        process.execPath,
        [join(APP_ROOT, "dist-electron", "pty-host.js")],
        {
          env: { ...process.env, AYA_HOME: seeded.ayaHome },
          stdio: "ignore",
        },
      );
      const socketPath = join(seeded.ayaHome, "pty-host.sock");
      const deadline = Date.now() + PTY_HOST_SHUTDOWN_TIMEOUT_MS * 5;
      while (!existsSync(socketPath)) {
        if (Date.now() > deadline) {
          throw new Error("pre-started pty host never created its socket");
        }
        await delay(50);
      }
    }
    // No AYA_DEV: load the built dist/index.html. ELECTRON_RUN_AS_NODE must go
    // or Electron starts as plain Node with no `app`.
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
    // Empty CODEX_HOME: never read the real machine's rollout logs.
    env.CODEX_HOME = join(seeded.root, "codex-home");
    Object.assign(env, seeded.launchEnv);

    // The built main entry, not the app root: a bare directory arg reads as
    // "open this project". main.ts skips argv entries ending in "main.js".
    const launchArgs = [
      join(APP_ROOT, "dist-electron", "main.js"),
      `--user-data-dir=${seeded.userDataDir}`,
    ];
    // CI-only: no SUID sandbox there, and the GPU process under xvfb keeps
    // app.close() from ever resolving.
    if (process.env.CI) {
      launchArgs.push("--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage");
    }

    const app = await electron.launch({ args: launchArgs, cwd: APP_ROOT, env });
    await use(app);
    await closeAndWait(app);
    await shutdownPtyHost(seeded.ayaHome);
    // Belt for a hung host. Liveness, not `.killed` - see closeAndWait.
    if (preStartedHost?.pid !== undefined && isAlive(preStartedHost.pid)) {
      try {
        preStartedHost.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  },

  window: async ({ app }, use) => {
    const win = await app.firstWindow();
    await win.waitForLoadState("domcontentloaded");
    await use(win);
  },
});

export const expect = test.expect;
