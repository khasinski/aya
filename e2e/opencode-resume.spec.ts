// opencode's `--continue` resumes the newest session of ANY git worktree of the
// repo, so a restored opencode pane must be launched with its own directory's
// session instead. The fake `opencode` lists a newer sibling-worktree session
// and an older one of the pane's cwd, then records the argv it was spawned with.

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
    `  printf '[{"id":"ses_sibling","directory":"/elsewhere/wt-b","updated":300},{"id":"ses_own","directory":"%s","updated":100}]' "$(pwd -P)"`,
    "  exit 0",
    "fi",
    `exec '${NODE}' '${ARGV_DUMP}' "$AYA_PROJECT_DIR/argv-$AYA_TERMINAL_ID.json" "$@"`,
    "",
  ].join("\n"),
  { mode: 0o755 },
);

test.use({
  seedOptions: {
    fakeHome: true,
    launchEnv: {
      PATH: `${bin}:${process.env.PATH}`,
      XDG_DATA_HOME: join(scratch, "xdg-data"),
    },
    presetList: [
      { id: "shell", name: "OpenCode", icon: "$", color: "", agent: "opencode", command: "opencode" },
    ],
  },
});

test("a restored opencode pane resumes its own directory's session, not the sibling's", async ({
  window,
  seeded,
}) => {
  void window;
  const dump = join(seeded.projectDir, `argv-${seeded.tabIds.right}.json`);
  await expect
    .poll(() => existsSync(dump), { message: "the pane never started", timeout: 60_000 })
    .toBe(true);
  const { args } = JSON.parse(readFileSync(dump, "utf8"));
  expect(args).toEqual(["--session", "ses_own"]);
});
