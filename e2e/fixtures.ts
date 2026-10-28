import {
  test as base,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as net from "node:net";
import { join } from "node:path";
import { appEnv, seedEnv, type SeededEnv, type SeedOptions } from "./helpers/seed";

export const {spawnAuthenticatedHost,authenticateFixtureSocket,redeemFixtureQuit,forgetFixtureAuthority}=require("../tests/helpers/pty-host-launch.cjs") as {
  spawnAuthenticatedHost:typeof spawn;
  authenticateFixtureSocket:(socket:net.Socket,home:string)=>Promise<unknown>;
  redeemFixtureQuit:(home:string)=>Promise<void>;
  forgetFixtureAuthority:(home:string)=>void;
};

const APP_ROOT = join(__dirname, "..");
export const PTY_HOST_SCRIPT = join(APP_ROOT, "dist-electron", "pty-host.js");
const REMOVE_RETRY_COUNT = 5;
const REMOVE_RETRY_DELAY_MS = 100;
export const PTY_HOST_SHUTDOWN_TIMEOUT_MS = 1_000;
/** How long to wait for a host to actually exit before killing it. */
export const PTY_HOST_EXIT_TIMEOUT_MS = 5_000;
/** How long a SIGKILLed host may still show up in the process table. */
const PTY_HOST_REAP_TIMEOUT_MS = 2_000;
export const APP_GRACEFUL_CLOSE_TIMEOUT_MS = 1_000;
export const APP_PROCESS_EXIT_TIMEOUT_MS = 2_000;

/** CI-only: no SUID sandbox there, and the GPU process under xvfb keeps
 *  app.close() from ever resolving. Playwright's launch adds --no-sandbox itself; a raw spawn does not. */
export function ciElectronFlags(): string[] {
  return process.env.CI ? ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] : [];
}

export function delay(ms: number): Promise<void> {
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

/** Pty hosts running for this AYA_HOME, found by their environment rather than
 *  the registry: a host records itself only once listening, so one still
 *  booting when its app died (seen in e2e) has no record. */
export function hostPidsForHome(ayaHome: string): number[] {
  const wanted = `AYA_HOME=${ayaHome}`;
  if (process.platform === "linux") {
    return readdirSync("/proc")
      .filter((d) => /^\d+$/.test(d))
      .filter((d) => {
        try {
          return (
            readFileSync(`/proc/${d}/cmdline`, "utf8").includes("pty-host.js") &&
            readFileSync(`/proc/${d}/environ`, "utf8").split("\0").includes(wanted)
          );
        } catch {
          return false;
        }
      })
      .map(Number);
  }
  const out = spawnSync("ps", ["eww", "-A", "-o", "pid=,command="], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).stdout;
  // Matched as whole " KEY=value" words, so a home with a space in it still
  // matches, and a longer home that starts with this one does not.
  return (out ?? "")
    .split("\n")
    .filter(
      (line) =>
        /\/pty-host\.js(\s|$)/.test(line) && (line.includes(` ${wanted} `) || line.endsWith(` ${wanted}`)),
    )
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

/** Reap the seeded home's pty hosts, then delete its root even if that throws. */
export async function cleanUpSeeded(s: SeededEnv): Promise<void> {
  try {
    await reapPtyHosts(s.ayaHome);
  } finally {
    await removeSeededRoot(s.root);
  }
}

/** Leave no pty host of this AYA_HOME running, and throw if one survives: a
 *  leaked host keeps its children and loads every later test. */
export async function reapPtyHosts(ayaHome: string): Promise<void> {
  const pids = hostPidsForHome(ayaHome);
  if (pids.length === 0) { await reapNativeOwner(ayaHome); return; }
  await shutdownPtyHost(ayaHome, pids);
  // A SIGKILLed process lingers in the table until the kernel reaps it.
  const deadline = Date.now() + PTY_HOST_REAP_TIMEOUT_MS;
  let leaked = hostPidsForHome(ayaHome);
  while (leaked.length > 0 && Date.now() < deadline) {
    await delay(50);
    leaked = hostPidsForHome(ayaHome);
  }
  if (leaked.length > 0) {
    throw new Error(`pty host(s) ${leaked.join(", ")} of ${ayaHome} outlived the test`);
  }
  await reapNativeOwner(ayaHome);
}

/** A crashed JS host leaves its native inventory deliberately alive. Fixture
 * cleanup is authorized to stop only that disposable home's verified owner. */
async function reapNativeOwner(ayaHome: string): Promise<void> {
  const file = join(ayaHome, "pty-owner/record.json");
  if (!existsSync(file)) return;
  const record = JSON.parse(readFileSync(file, "utf8"));
  if (record.executable !== join(APP_ROOT, "dist-electron/aya-pty-owner")) throw new Error("Unexpected fixture owner executable");
  const { ownerRecordIsLive } = require("../dist-electron/pty-owner-registry.js") as { ownerRecordIsLive(r: unknown): boolean };
  if (!ownerRecordIsLive(record)) return;
  process.kill(record.pid, "SIGTERM");
  const deadline = Date.now() + 5000;
  while (ownerRecordIsLive(record) && Date.now() < deadline) await delay(25);
  if (ownerRecordIsLive(record)) throw new Error(`Native owner ${record.pid} outlived its test`);
}

/** Asks the host to shut down; `pids` are then waited for and SIGKILLed if still alive. */
export async function shutdownPtyHost(ayaHome: string, pids: number[] = []): Promise<void> {
  await redeemFixtureQuit(ayaHome).catch(()=>{});
  const socketPath = join(ayaHome, "pty-host.sock");
  await Promise.race([
    new Promise<void>((resolve) => {
      const socket = net.createConnection(socketPath);
      socket.once("connect", () => {void (async()=>{
        await authenticateFixtureSocket(socket,ayaHome);socket.resume();
        socket.end(`${JSON.stringify({ id: 1, type: "shutdown" })}\n`);
      })().catch(()=>socket.destroy());});
      socket.once("close", resolve);
      socket.once("error", resolve);
    }),
    delay(PTY_HOST_SHUTDOWN_TIMEOUT_MS),
  ]);

  // A host is DESIGNED to outlive its app, so nothing else will collect it, and
  // the race above regularly expires before it has finished draining children.
  // Measured: one host per spec file survived, ~50 by the end of a run, and the
  // contention made unrelated specs time out.
  const deadline = Date.now() + PTY_HOST_EXIT_TIMEOUT_MS;
  while (pids.some(isAlive) && Date.now() < deadline) await delay(50);
  // Rescanned, not `pids`: one of those may have exited and been reused since.
  for (const pid of hostPidsForHome(ayaHome)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
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

export function launchApp(seeded: SeededEnv): Promise<ElectronApplication> {
  // No AYA_DEV: load the built dist/index.html; no ELECTRON_RUN_AS_NODE, or
  // Electron starts as plain Node with no `app`. Both are dropped by appEnv.
  const env = appEnv(seeded);
  if (!process.env.CI && env.AYA_E2E_HEADLESS !== "1") {
    throw new Error("Local e2e must launch Aya with hidden windows");
  }

  // The built main entry, not the app root: a bare directory arg reads as
  // "open this project". main.ts skips argv entries ending in "main.js".
  const launchArgs = [
    join(APP_ROOT, "dist-electron", "main.js"),
    `--user-data-dir=${seeded.userDataDir}`,
  ];
  launchArgs.push(...ciElectronFlags());
  return launchE2eElectron({ args: launchArgs, cwd: APP_ROOT, env });
}

/** Every Electron e2e launch, including wrapper-main launches, shares this local headless gate. */
export function launchE2eElectron(options: Parameters<typeof electron.launch>[0]): Promise<ElectronApplication> {
  const env = { ...(options.env as NodeJS.ProcessEnv | undefined) };
  if (env.AYA_E2E_RUN === "1" && !process.env.CI && env.AYA_E2E_HEADLESS !== "1") {
    throw new Error("Local e2e must launch Aya with hidden windows");
  }
  if (env.AYA_E2E_HEADLESS === "1") {
    if (!env.AYA_E2E_HEADLESS_UI_LOG) throw new Error("Headless e2e launch is missing its UI event log");
    const args = [...(options.args ?? [])];
    const originalMain = args[0];
    if (!originalMain || originalMain.startsWith("-")) {
      throw new Error("Headless e2e launch must name its Electron main entry as the first argument");
    }
    env.AYA_E2E_REAL_MAIN = originalMain;
    env.AYA_E2E_HEADLESS_UI_MODULE = join(APP_ROOT, "dist-electron", "e2e-headless-ui.js");
    args[0] = join(APP_ROOT, "e2e", "helpers", "headless-main.cjs");
    return electron.launch({ ...options, args, env });
  }
  return electron.launch({ ...options, env });
}

/** Raw Electron subprocesses use the same headless bootstrap and launch guard as Playwright launches. */
export function spawnE2eElectron(
  binary: string,
  inputArgs: string[],
  options: import("node:child_process").SpawnOptions,
): ReturnType<typeof spawn> {
  const env = { ...(options.env as NodeJS.ProcessEnv | undefined) };
  if (env.AYA_E2E_RUN === "1" && !process.env.CI && env.AYA_E2E_HEADLESS !== "1") {
    throw new Error("Local e2e must launch Aya with hidden windows");
  }
  const args = [...inputArgs];
  if (env.AYA_E2E_HEADLESS === "1") {
    if (!env.AYA_E2E_HEADLESS_UI_LOG) throw new Error("Headless e2e launch is missing its UI event log");
    const originalMain = args[0];
    if (!originalMain || originalMain.startsWith("-")) throw new Error("Headless Electron spawn must name its entry as the first argument");
    env.AYA_E2E_REAL_MAIN = originalMain;
    env.AYA_E2E_HEADLESS_UI_MODULE = join(APP_ROOT, "dist-electron", "e2e-headless-ui.js");
    args[0] = join(APP_ROOT, "e2e", "helpers", "headless-main.cjs");
  }
  return spawn(binary, args, { ...options, env });
}

/** Declare the native UI requests a test intentionally exercises in headless mode. */
export function expectHeadlessUiEvents(seeded: SeededEnv, kinds: string[]): void {
  writeFileSync(join(seeded.root, "e2e-headless-ui-expected.json"), JSON.stringify(kinds), { mode: 0o600 });
}

/** Handle renderer JS dialogs in both local-headless runs and visible CI/Xvfb runs. */
export async function handleRendererDialogs(
  page: Page,
  seeded: SeededEnv,
  responses: Partial<Record<"renderer.alert" | "renderer.confirm" | "renderer.prompt", boolean | string | null>> = {},
): Promise<{ read: () => Promise<Array<{ kind: string; message: string }>> }> {
  const headless = appEnv(seeded).AYA_E2E_HEADLESS === "1";
  if (headless) {
    await page.evaluate((values) => {
      const w = window as Window & { __ayaE2eHeadlessUi: { setResponse: (kind: string, response: unknown) => void }; __ayaE2eRendererEvents?: Array<{ kind: string; message: string }> };
      w.__ayaE2eRendererEvents = [];
      window.addEventListener("aya:e2e-headless-dialog", (event) => w.__ayaE2eRendererEvents?.push((event as CustomEvent).detail));
      for (const [kind, response] of Object.entries(values)) w.__ayaE2eHeadlessUi.setResponse(kind, response);
    }, responses);
    return { read: () => page.evaluate(() => (window as Window & { __ayaE2eRendererEvents?: Array<{ kind: string; message: string }> }).__ayaE2eRendererEvents ?? []) };
  }
  const events: Array<{ kind: string; message: string }> = [];
  page.on("dialog", async (dialog) => {
    const kind = `renderer.${dialog.type()}`;
    events.push({ kind, message: dialog.message() });
    const response = responses[kind as keyof typeof responses];
    if (dialog.type() === "confirm" && response === false) await dialog.dismiss();
    else if (dialog.type() === "prompt" && typeof response === "string") await dialog.accept(response);
    else await dialog.accept();
  });
  return { read: async () => events };
}

function headlessUiFailure(seeded: SeededEnv): Error | null {
  const env = appEnv(seeded);
  if (env.AYA_E2E_HEADLESS !== "1") return null;
  const logPath = env.AYA_E2E_HEADLESS_UI_LOG;
  const logged = existsSync(logPath)
    ? readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { kind: string; expected?: boolean })
    : [];
  const actual = logged.filter((event) => event.expected !== true).map((event) => event.kind);
  const expectedPath = join(seeded.root, "e2e-headless-ui-expected.json");
  const expected = existsSync(expectedPath) ? JSON.parse(readFileSync(expectedPath, "utf8")) as string[] : [];
  return JSON.stringify(actual) === JSON.stringify(expected)
    ? null
    : new Error(`Headless e2e requested native UI: expected ${JSON.stringify(expected)}, observed ${JSON.stringify(actual)}`);
}

export function assertHeadlessUiEvents(seeded: SeededEnv): void {
  const error = headlessUiFailure(seeded);
  if (error) throw error;
}

export async function closeAndWait(app: ElectronApplication): Promise<void> {
  let proc: ReturnType<ElectronApplication["process"]>;
  try { proc = app.process(); }
  catch { return; } // A test may have explicitly quit Aya and awaited its exit.
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
    const uiError = headlessUiFailure(s);
    // Attach the PTY lifecycle log before the root is wiped: the only record.
    if (testInfo.status !== testInfo.expectedStatus) {
      for (const name of ["pty-events.log", "pty-events.log.1", "e2e-headless-ui.log"]) {
        const p = join(s.ayaHome, name);
        const uiLog = join(s.root, name);
        const evidence = name === "e2e-headless-ui.log" ? uiLog : p;
        if (existsSync(evidence)) {
          await testInfo.attach(name, { path: evidence, contentType: "text/plain" });
        }
      }
    }
    // Here, not in `app`: this teardown also runs when launching the app failed.
    try{await cleanUpSeeded(s);}finally{forgetFixtureAuthority(s.ayaHome);}
    if (uiError) throw uiError;
  },

  app: async ({ seeded, seedOptions }, use) => {
    let remoteTerminalHost: ReturnType<typeof spawn> | null = null;
    const remoteHostMode = seedOptions.remoteTerminalHost ?? (seedOptions.remoteProject ? "v1" : undefined);
    if (remoteHostMode) {
      const remoteHome = join(seeded.root, "remote-terminal-host-home");
      const remoteSocket = seeded.launchEnv?.AYA_REMOTE_SOCKET;
      if (!remoteSocket) throw new Error("remote terminal host fixture is missing AYA_REMOTE_SOCKET");
      const hostEnv = {
        ...appEnv(seeded, process.env, false),
        AYA_HOME: remoteHome,
        AYA_REMOTE_SOCKET: remoteSocket,
        AYA_REMOTE_TEST_MODE: remoteHostMode,
        AYA_REMOTE_TEST_PROJECT: seeded.projectDir,
        AYA_REMOTE_TEST_PTY_HOST: PTY_HOST_SCRIPT,
        AYA_REMOTE_TEST_STATE: join(seeded.root, "remote-terminal-state.json"),
        AYA_REMOTE_TEST_PRESETS: JSON.stringify(seedOptions.presetList ?? []),
        AYA_REMOTE_TEST_MAIN_PID_FILE: join(seeded.root, "remote-terminal-main.pid"),
      };
      remoteTerminalHost = spawn(process.execPath, [join(APP_ROOT, "e2e/helpers/fake-remote-terminal-host.cjs")], {
        cwd: APP_ROOT,
        env: hostEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let ready = "";
      let errorOutput = "";
      remoteTerminalHost.stdout?.on("data", (chunk) => { ready += String(chunk); });
      remoteTerminalHost.stderr?.on("data", (chunk) => { errorOutput += String(chunk); });
      const readyDeadline = Date.now() + 5_000;
      while (!ready.includes("READY\n")) {
        if (remoteTerminalHost.exitCode !== null) throw new Error(`remote terminal host exited before ready: ${errorOutput}`);
        if (Date.now() > readyDeadline) throw new Error(`remote terminal host did not become ready: ${errorOutput}`);
        await delay(20);
      }
    }
    try {
    // A host started FIRST makes the app treat it as REUSED, so boot-restored
    // tabs must attach-only instead of respawning.
    if (seedOptions.preStartPtyHost) {
      // Match main's startHost: the Node/Electron runtime is part of the host content identity.
      const issuer=spawnE2eElectron(require("electron") as string,[join(APP_ROOT,'tests/helpers/pty-prestart-announced.cjs')],{
        env:{...appEnv(seeded,process.env,false),ELECTRON_RUN_AS_NODE:'1',AYA_TEST_HOST_SCRIPT:PTY_HOST_SCRIPT},stdio:['ignore','ignore','pipe'],
      });
      let issuerError='';issuer.stderr?.on('data',chunk=>{issuerError+=String(chunk);});
      await new Promise<void>((resolve,reject)=>{issuer.once('error',reject);issuer.once('exit',code=>code===0?resolve():reject(Error('Announced prestart issuer failed: '+issuerError)));});
      const socketPath = join(seeded.ayaHome, "pty-host.sock");
      const deadline = Date.now() + PTY_HOST_SHUTDOWN_TIMEOUT_MS * 5;
      while (!existsSync(socketPath)) {
        if (Date.now() > deadline) {
          throw new Error("pre-started pty host never created its socket");
        }
        await delay(50);
      }
    }
    const app = await launchApp(seeded);
    await use(app);
    await closeAndWait(app);
    } finally {
      if (remoteTerminalHost && remoteTerminalHost.exitCode === null) {
        const child = remoteTerminalHost;
        const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
        child.kill("SIGTERM");
        await Promise.race([closed, delay(5_000)]);
        if (child.exitCode === null) child.kill("SIGKILL");
      }
    }
  },

  window: async ({ app }, use) => {
    const win = await app.firstWindow();
    await win.waitForLoadState("domcontentloaded");
    if (!process.env.CI) {
      const visible = await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((candidate) => candidate.isVisible()),
      );
      if (visible) throw new Error("A local e2e window became visible");
    }
    await use(win);
  },
});

export const expect = test.expect;
