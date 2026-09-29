// `aya pane read` returns what the pane SHOWS. Against a Grok-shaped TUI the
// raw tail is only animation frames; the read must still carry its text.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures";

// App boot plus a login shell starting a program; slower than the 45 s default.
test.describe.configure({ timeout: 120_000 });

const AYA_CLI = join(__dirname, "..", "bin", "aya");
const ANIMATOR = join(__dirname, "helpers", "tui-animator.cjs");
const NODE = process.execPath;
/** Restated, not imported: the raw read's cap. */
const RAW_TAIL_CHARS = 64_000;

/** Real CLI against the TEST instance: every inherited AYA_* is dropped. */
function ayaPaneRead(ayaHome: string, target: string): string {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("AYA_")),
  ) as Record<string, string>;
  return execFileSync(AYA_CLI, ["pane", "read", target], {
    env: { ...env, AYA_HOME: ayaHome },
    encoding: "utf8",
    timeout: 15_000,
  });
}

test.use({
  seedOptions: {
    presetList: [
      {
        id: "shell",
        name: "Animator",
        icon: "$",
        color: "",
        command: `'${NODE}' '${ANIMATOR}' "$AYA_PROJECT_DIR/ready-$AYA_TERMINAL_ID"`,
      },
    ],
  },
});

test("pane read returns an animating TUI's screen text, not its frames", async ({
  window,
  seeded,
}) => {
  const id = seeded.tabIds.right;
  await expect
    .poll(() => existsSync(join(seeded.projectDir, `ready-${id}`)), {
      message: "the animator never pumped past the raw read's cap",
      timeout: 60_000,
    })
    .toBe(true);

  // The scenario is real: the raw tail no longer holds the text.
  const raw = await window.evaluate((ptyId) => window.aya.ptyBuffer(ptyId), id);
  expect(raw.slice(-RAW_TAIL_CHARS)).not.toContain("animator says hello");

  const text = ayaPaneRead(seeded.ayaHome, "shell 2");
  expect(text).toContain("animator says hello");
  expect(text).toContain("> prompt");
  expect(text).not.toContain("\x1b");
  const frameLines = text.split("\n").filter((line) => /[\u2800-\u28ff]/.test(line));
  expect(frameLines, "one animation frame on screen, not the history").toHaveLength(1);
});
