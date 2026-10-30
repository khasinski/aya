import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { socketPathLimit } from "../dist-electron/socket-path.js";
import { test, expect, ciElectronFlags, cleanUpSeeded, reapPtyHosts, spawnE2eElectron, assertHeadlessUiEvents } from "./fixtures";
import { appEnv, seedEnv } from "./helpers/seed";

// A unix socket path over the OS limit (104 bytes on macOS) makes listen() throw EINVAL: Aya refuses
// to start and says why.

const APP_ROOT = join(__dirname, "..");
const EXIT_TIMEOUT_MS = 20_000;

function waitForExit(child: import("node:child_process").ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once("exit", (code) => resolve(code)));
}

test("Aya started with an AYA_HOME too long for its sockets exits and names the limit", async () => {
  const seeded = seedEnv({});
  const longHome = join(seeded.root, "h".repeat(socketPathLimit()), "aya-home");
  mkdirSync(longHome, { recursive: true });
  const electronBinary = (await import("electron")).default as unknown as string;
  const child = spawnE2eElectron(
    electronBinary,
    [join(APP_ROOT, "dist-electron", "main.js"), `--user-data-dir=${seeded.userDataDir}`, ...ciElectronFlags()],
    {
      env: { ...appEnv(seeded), AYA_HOME: longHome },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = waitForExit(child);
  const killer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, EXIT_TIMEOUT_MS);
  try {
    const code = await exited;
    expect(code).toBe(1);
    expect(stderr).toMatch(/AYA_HOME.*too long/);
    expect(stderr).toContain(`the limit is ${socketPathLimit()}`);
    expect(stderr).toContain(longHome);
  } finally {
    clearTimeout(killer);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    }
    try { assertHeadlessUiEvents(seeded); }
    finally { await reapPtyHosts(longHome).finally(() => cleanUpSeeded(seeded)); }
  }
});

test("an AYA_HOME only the remote socket outgrows still starts Aya, with the bridge off and a message", async () => {
  const seeded = seedEnv({});
  const limit = socketPathLimit();
  // aya-remote.sock is two bytes longer than pty-host.sock: this home fits every other socket.
  const fill = limit + 1 - Buffer.byteLength(join(seeded.root, "x", "aya-home", "aya-remote.sock")) + 1;
  const home = join(seeded.root, "h".repeat(fill), "aya-home");
  expect(Buffer.byteLength(join(home, "aya-remote.sock"))).toBe(limit + 1);
  mkdirSync(home, { recursive: true });
  const electronBinary = (await import("electron")).default as unknown as string;
  const child = spawnE2eElectron(
    electronBinary,
    [join(APP_ROOT, "dist-electron", "main.js"), `--user-data-dir=${seeded.userDataDir}`, ...ciElectronFlags()],
    { env: { ...appEnv(seeded), AYA_HOME: home }, stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = waitForExit(child);
  try {
    await expect.poll(() => existsSync(join(home, "aya.sock")), { timeout: EXIT_TIMEOUT_MS }).toBe(true);
    expect(existsSync(join(home, "aya-remote.sock"))).toBe(false);
    expect(stderr).toMatch(/remote bridge is off.*too long/);
    expect(child.exitCode).toBeNull();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    try { assertHeadlessUiEvents(seeded); }
    finally { await reapPtyHosts(home).finally(() => cleanUpSeeded(seeded)); }
  }
});
