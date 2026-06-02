import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SeededEnv {
  /** Temp root holding all isolated state for one app launch. */
  root: string;
  /** AYA_HOME passed to the app (its config dir). */
  ayaHome: string;
  /** Electron `--user-data-dir` (cache, single-instance lock) - kept distinct
   *  so the test instance never collides with a running Aya. */
  userDataDir: string;
  /** Working directory of the seeded project (must exist for terminals). */
  projectDir: string;
  tabIds: { left: string; right: string };
}

export interface SeedOptions {
  /** When false, the project has no split layout, so only the active tab is
   *  visible and switching happens via the sidebar (one terminal at a time).
   *  Defaults to true (1x2 split, both panes visible). */
  split?: boolean;
}

/** Build a throwaway, deterministic environment for one Electron launch:
 *  a project with two shell terminals (in a 1x2 split by default), a single
 *  shell preset (so no PATH harness scan pulls in claude/codex), and an empty
 *  snippet store that the app seeds with its defaults on boot. */
export function seedEnv(opts: SeedOptions = {}): SeededEnv {
  const split = opts.split !== false;
  const root = mkdtempSync(join(tmpdir(), "aya-e2e-"));
  const ayaHome = join(root, "aya-home");
  const userDataDir = join(root, "electron-data");
  const projectDir = join(root, "project");
  mkdirSync(join(ayaHome, "projects"), { recursive: true });
  mkdirSync(userDataDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });

  writeFileSync(
    join(ayaHome, "presets.json"),
    JSON.stringify(
      { presets: [{ id: "shell", name: "Shell", icon: "$", color: "", command: "$SHELL" }] },
      null,
      2,
    ),
  );

  const left = "tab-left";
  const right = "tab-right";
  writeFileSync(
    join(ayaHome, "projects", "e2e-proj.json"),
    JSON.stringify(
      {
        name: "e2e",
        directory: projectDir,
        tabs: [
          { id: left, presetId: "shell", name: "shell 1" },
          { id: right, presetId: "shell", name: "shell 2" },
        ],
        ...(split
          ? {
              splitLayout: {
                rows: 1,
                cols: 2,
                rowFr: [1],
                colFr: [1, 1],
                cells: [left, right],
                activeCell: 0,
              },
            }
          : {}),
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(ayaHome, "projects-state.json"),
    JSON.stringify({ version: 1, order: ["e2e-proj"], open: ["e2e-proj"], recent: ["e2e-proj"] }, null, 2),
  );

  return { root, ayaHome, userDataDir, projectDir, tabIds: { left, right } };
}
