import { test as base } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, hostPidsForHome, test } from "./fixtures";

// A finished test leaves no pty host of its AYA_HOME and no root: the first test adds a stand-in host that
// never exits, so only the fixture's reap can remove it; the second runs after the teardown and looks.

const scratch = mkdtempSync(join(tmpdir(), "aya-no-host-"));
const standInScript = join(scratch, "pty-host.js");
writeFileSync(standInScript, "setInterval(() => {}, 1000);");
let standIn: ChildProcess | undefined;
let seen: { home: string; root: string } | undefined;

test.describe.configure({ mode: "serial" });

test.afterAll(() => {
  standIn?.kill("SIGKILL");
  rmSync(scratch, { recursive: true, force: true });
});

test("a test that ran the app has hosts of its home", async ({ window, seeded }) => {
  await window.waitForLoadState("load");
  standIn = spawn(process.execPath, [standInScript], {
    env: { ...process.env, AYA_HOME: seeded.ayaHome },
    stdio: "ignore",
  });
  await expect.poll(() => hostPidsForHome(seeded.ayaHome)).toContain(standIn.pid!);
  seen = { home: seeded.ayaHome, root: seeded.root };
});

base("after the teardown no host of that home is left, and the home is gone", () => {
  expect(seen, "the first test did not run").toBeDefined();
  expect(hostPidsForHome(seen!.home)).toEqual([]);
  expect(existsSync(seen!.root)).toBe(false);
});
