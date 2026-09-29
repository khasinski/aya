import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostPidsForHome, reapPtyHosts } from "./fixtures";

// reapPtyHosts SIGKILLs by pid, so it must only ever hit hosts of the AYA_HOME
// it was given. The stand-ins are this test's own node processes named
// pty-host.js; `renameAfterMs` makes one stop looking like a host while alive,
// as a pid reused by an unrelated process would.

const root = mkdtempSync(join(tmpdir(), "aya-reap-"));
const STAND_IN_SOURCE = `const ms = Number(process.argv[2]);
  if (ms > 0) setTimeout(() => { process.title = "not-a-host"; }, ms);
  setInterval(() => {}, 1000);`;
const standInScript = join(root, "pty-host.js");
const otherScript = join(root, "other-tool.js");
writeFileSync(standInScript, STAND_IN_SOURCE);
writeFileSync(otherScript, STAND_IN_SOURCE);
const standIns: ChildProcess[] = [];

function startStandIn(ayaHome: string, renameAfterMs = 0, script = standInScript): ChildProcess {
  const child = spawn(process.execPath, [script, String(renameAfterMs)], {
    env: { ...process.env, AYA_HOME: ayaHome },
    stdio: "ignore",
  });
  standIns.push(child);
  return child;
}

/** The exit event, not kill(pid, 0): a SIGKILLed child stays a zombie until
 *  this process reaps it, and a zombie still answers signal 0. */
function exitsWithin(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

const EXIT_GRACE_MS = 1_000;

async function waitUntilFound(ayaHome: string, pid: number): Promise<void> {
  await expect.poll(() => hostPidsForHome(ayaHome)).toContain(pid);
}

test.afterAll(() => {
  for (const child of standIns) child.kill("SIGKILL");
  rmSync(root, { recursive: true, force: true });
});

test("reaps a host of its own AYA_HOME and leaves another home's alone", async () => {
  const mine = join(root, "home-a");
  const other = join(root, "home-b");
  const own = startStandIn(mine);
  const foreign = startStandIn(other);
  await waitUntilFound(mine, own.pid!);
  await waitUntilFound(other, foreign.pid!);

  await reapPtyHosts(mine);

  expect(await exitsWithin(own, EXIT_GRACE_MS)).toBe(true);
  expect(await exitsWithin(foreign, EXIT_GRACE_MS)).toBe(false);
});

test("an AYA_HOME that is a prefix of another does not match it", async () => {
  const mine = join(root, "aya-e2e-abc");
  const longer = join(root, "aya-e2e-abcd");
  const foreign = startStandIn(longer);
  await waitUntilFound(longer, foreign.pid!);

  expect(hostPidsForHome(mine)).toEqual([]);
  await reapPtyHosts(mine);
  expect(await exitsWithin(foreign, EXIT_GRACE_MS)).toBe(false);
});

test("a process of the same AYA_HOME that is not a pty host is left alone", async () => {
  const mine = join(root, "home-d");
  const host = startStandIn(mine);
  const app = startStandIn(mine, 0, otherScript);
  await waitUntilFound(mine, host.pid!);

  await reapPtyHosts(mine);

  expect(await exitsWithin(host, EXIT_GRACE_MS)).toBe(true);
  expect(await exitsWithin(app, EXIT_GRACE_MS)).toBe(false);
});

test("a pid that stops being this home's host before the kill is spared", async () => {
  const mine = join(root, "home-c");
  const standIn = startStandIn(mine, 1_500);
  await waitUntilFound(mine, standIn.pid!);

  await reapPtyHosts(mine);

  expect(await exitsWithin(standIn, EXIT_GRACE_MS)).toBe(false);
});
