import { test, expect } from "./fixtures";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Agent session resume. Any persisted tab is `restored` on boot, so an agent
// preset must respawn with a "continue latest session" flag - otherwise the
// agent starts a brand-new empty session and the conversation is lost.
//
// We use a preset that (a) is inferred as an agent via the CLAUDE_CONFIG_DIR=
// prefix and (b) writes its received argv to a file in the project cwd. Reading
// that file proves the REAL spawned process got the flag Aya appended - more
// robust than scraping xterm output through an interactive login shell.
//
// The bug guarded: the runtime read raw preset.autoResume (undefined for any
// preset predating the field) while the Settings UI defaulted it ON, so agent
// tabs respawned with no resume flag and lost their session.

test.use({
  seedOptions: {
    split: false,
    presetList: [
      {
        id: "shell",
        name: "Shell",
        icon: "$",
        color: "",
        // Inferred as claude (CLAUDE_CONFIG_DIR=); echoes the args Aya appended
        // to resume-marker.txt in the project cwd. NOTE: deliberately NOT a
        // `sh -c '...'` wrapper - the `-c` token would trip commandHasResumeFlag
        // (it reads as an existing continue flag) and suppress the very append
        // we are testing. The host already runs the command inside a shell, so
        // the redirection works directly.
        command:
          'CLAUDE_CONFIG_DIR=/tmp/aya-e2e-resume echo "$@" > resume-marker.txt',
      },
    ],
  },
});

test("a restored agent terminal respawns with --continue (resumes, not fresh)", async ({
  window,
  seeded,
}) => {
  // Wait until the app has mounted the terminal and spawned it.
  await expect(window.getByTestId("xterm-host").first()).toBeVisible();

  const markerPath = join(seeded.projectDir, "resume-marker.txt");
  // The marker contains the args Aya appended. It must include the continue
  // flag; substring (not exact) tolerates echo's trailing newline / spacing.
  // Without the autoResume default, no flag is appended -> marker lacks it.
  await expect
    .poll(
      () => {
        try {
          return readFileSync(markerPath, "utf8").includes("--continue");
        } catch {
          return false;
        }
      },
      { timeout: 10_000 },
    )
    .toBe(true);
});
