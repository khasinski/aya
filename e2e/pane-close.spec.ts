// `aya pane close` from the real CLI into the real app: a shell pane is refused without --force,
// since its state says nothing about what runs in it; with --force the window closes the tab
// and saves the project.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures";

const AYA_CLI = join(__dirname, "..", "bin", "aya");

function aya(ayaHome: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("AYA_"))) as Record<string, string>;
  return new Promise((done) => {
    execFile(AYA_CLI, args, { env: { ...env, AYA_HOME: ayaHome }, encoding: "utf8", timeout: 20_000 }, (err, stdout, stderr) =>
      done({ code: err ? 1 : 0, stdout, stderr }),
    );
  });
}

const savedTabs = (ayaHome: string): string[] =>
  JSON.parse(readFileSync(join(ayaHome, "projects", "e2e-proj.json"), "utf8")).tabs.map((t: { name: string }) => t.name);

test("a shell pane closes only with --force, and then leaves the window, the project file and pane list", async ({ window, seeded }) => {
  const right = window.locator(`[data-testid="sidebar-terminal"][data-terminal-id="${seeded.tabIds.right}"]`);
  await expect(right).toBeVisible();
  expect((await aya(seeded.ayaHome, ["pane", "wait", "shell 2", "--timeout", "15"])).code, "the shell came up").toBe(0);

  const refused = await aya(seeded.ayaHome, ["pane", "close", "shell 2"]);
  expect(refused.code).toBe(1);
  expect(refused.stderr).toMatch(/shell 2 is shell; closing it stops what runs in it; pass --force/);
  await expect(right).toBeVisible();

  const closed = await aya(seeded.ayaHome, ["pane", "close", "shell 2", "--force"]);
  expect(closed).toMatchObject({ code: 0, stdout: "closed shell 2\n" });
  await expect(right).toHaveCount(0);
  await expect.poll(() => savedTabs(seeded.ayaHome)).toEqual(["shell 1"]);
  expect((await aya(seeded.ayaHome, ["pane", "list"])).stdout).not.toContain("shell 2");
});
