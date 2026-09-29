// opencode's `--continue` resumes the newest session of ANY git worktree of the
// repo, so a restored opencode pane must be launched with its own directory's
// session instead. The fake `opencode` logs each session lookup, lists a newer
// sibling-worktree session and an older one of the pane's cwd, and records the
// argv it was spawned with.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "./fixtures";

const NODE = process.execPath;
const ARGV_DUMP = join(__dirname, "helpers", "argv-dump.cjs");
const scratch = mkdtempSync(join(tmpdir(), "aya-e2e-opencode-"));
const bin = join(scratch, "bin");
mkdirSync(bin);
writeFileSync(
  join(bin, "opencode"),
  [
    "#!/bin/sh",
    'if [ "$1" = session ]; then',
    '  echo "$PWD" >> "$PWD/opencode-lookups.log"',
    `  printf '[{"id":"ses_sibling","directory":"/elsewhere/wt-b","updated":300},{"id":"ses_own","directory":"%s","updated":100}]' "$(pwd -P)"`,
    "  exit 0",
    "fi",
    `exec '${NODE}' '${ARGV_DUMP}' "$AYA_PROJECT_DIR/argv-$AYA_TERMINAL_ID.json" "$@"`,
    "",
  ].join("\n"),
  { mode: 0o755 },
);

const seedOptions = {
  fakeHome: true,
  launchEnv: {
    PATH: `${bin}:${process.env.PATH}`,
    XDG_DATA_HOME: join(scratch, "xdg-data"),
  },
  presetList: [
    { id: "shell", name: "OpenCode", icon: "$", color: "", agent: "opencode", command: "opencode" },
  ],
};

const argvDump = (seeded: { projectDir: string }, tabId: string) =>
  join(seeded.projectDir, `argv-${tabId}.json`);

test.describe("fresh pty host", () => {
  test.use({ seedOptions });

  test("a restored opencode pane resumes its own directory's session, not the sibling's", async ({
    window,
    seeded,
  }) => {
    void window;
    const dump = argvDump(seeded, seeded.tabIds.right);
    await expect
      .poll(() => existsSync(dump), { message: "the pane never started", timeout: 60_000 })
      .toBe(true);
    expect(JSON.parse(readFileSync(dump, "utf8")).args).toEqual(["--session", "ses_own"]);
  });
});

test.describe("reused pty host", () => {
  test.use({ seedOptions: { ...seedOptions, split: false, preStartPtyHost: true } });

  test("a tab that only re-attaches never asks opencode; Shift+Enter then resumes its own session", async ({
    window,
    seeded,
  }) => {
    const lookups = join(seeded.projectDir, "opencode-lookups.log");
    await expect(
      window.locator('[data-testid="sidebar-terminal"] .aya-sidebar-statusdot--idle').first(),
    ).toBeVisible({ timeout: 10_000 });
    expect(existsSync(lookups), "an attach-only boot must not list sessions").toBe(false);

    await window.getByTestId("xterm-host").first().click();
    await window.keyboard.press("Shift+Enter");
    const dump = argvDump(seeded, seeded.tabIds.left);
    await expect.poll(() => existsSync(dump), { timeout: 30_000 }).toBe(true);
    expect(JSON.parse(readFileSync(dump, "utf8")).args).toEqual(["--session", "ses_own"]);
    expect(readFileSync(lookups, "utf8").trim().split("\n")).toHaveLength(1);
  });
});
