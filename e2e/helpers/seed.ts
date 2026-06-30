import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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
  /** Extra environment variables used when launching Electron for this seed. */
  launchEnv?: Record<string, string>;
  tabIds: { left: string; right: string };
  /** Set only when `missingDir` is requested: the non-existent path the open
   *  project points at (so a test can assert MissingDirModal's "Create folder"
   *  created it, or "Use home" did not). */
  missingDirPath?: string;
}

export interface SeedOptions {
  /** When false, the project has no split layout, so only the active tab is
   *  visible and switching happens via the sidebar (one terminal at a time).
   *  Defaults to true (1x2 split, both panes visible). */
  split?: boolean;
  /** When set, write ayaHome/usage.json so the account-wide usage chip renders
   *  (the file a user hook would normally produce). */
  usage?: Record<string, unknown>;
  /** When set, write a Codex rollout (under CODEX_HOME = root/codex-home) with a
   *  token_count event carrying this rate_limits object, so the Codex chip
   *  renders. */
  codexRateLimits?: Record<string, unknown>;
  /** When false, leave presets.json absent so first-launch PATH scanning runs. */
  presets?: boolean;
  /** Override the seeded preset list (defaults to a single "Shell" preset).
   *  Ignored when `presets` is false. Use to exercise the launcher menu with
   *  many entries (e.g. a scrollable dropdown). */
  presetList?: Array<{ id: string; name: string; icon: string; color: string; command: string }>;
  /** Extra environment variables for the Electron process. */
  launchEnv?: Record<string, string>;
  /** Create a fake shell/bin setup where interactive shell PATH reveals claude. */
  pathRepairHarness?: boolean;
  /** Names of extra projects that are known + recent but NOT open, so the
   *  recent-projects menu lists them as closed projects. */
  closedProjects?: string[];
  /** Make the project dir a real git repo on branch "feature/foo" with one
   *  commit, then leave a modified tracked file + an untracked file so the
   *  StatusBar shows a branch + "2 dirty" + a diff. */
  gitRepo?: boolean;
  /** Point the open project at a directory that does NOT exist, so the boot
   *  dir-check queues it and MissingDirModal appears. The path is exposed as
   *  `seeded.missingDirPath` so a test can assert "Create folder" made it. */
  missingDir?: boolean;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
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
  // When requested, point the project at a path we deliberately do NOT create,
  // so the boot dir-check queues it and MissingDirModal appears.
  const missingDirPath = opts.missingDir ? join(root, "missing-project-dir") : undefined;
  const effectiveProjectDir = missingDirPath ?? projectDir;

  if (opts.gitRepo) {
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: projectDir, stdio: "ignore" });
    git("init", "-q", "-b", "feature/foo");
    writeFileSync(join(projectDir, "committed.txt"), "one\ntwo\n");
    git("add", "committed.txt");
    git("-c", "user.email=t@e", "-c", "user.name=t", "commit", "-qm", "init");
    // Dirty state: modify the committed file + add a new one. (Distinct name
    // prefixes so test selectors don't collide on substrings.)
    writeFileSync(join(projectDir, "committed.txt"), "one\ntwoX\n");
    writeFileSync(join(projectDir, "added.txt"), "brand new\n");
  }

  if (opts.presets !== false) {
    const presetList = opts.presetList ?? [
      { id: "shell", name: "Shell", icon: "$", color: "", command: "$SHELL" },
    ];
    writeFileSync(join(ayaHome, "presets.json"), JSON.stringify({ presets: presetList }, null, 2));
  }

  const left = "tab-left";
  const right = "tab-right";
  writeFileSync(
    join(ayaHome, "projects", "e2e-proj.json"),
    JSON.stringify(
      {
        name: "e2e",
        directory: effectiveProjectDir,
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
  // Closed projects: known + recent but NOT open, so the recent-projects menu
  // lists them. Their directories need not exist (the menu only displays them).
  // Mirror the app's slugify (electron/text.ts) so seeded slugs match what real
  // project creation would produce, and guard against collisions that would
  // overwrite a file or duplicate a state entry.
  const slugify = (name: string) =>
    name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  const closed = opts.closedProjects ?? [];
  const closedSlugs: string[] = [];
  for (const name of closed) {
    const slug = slugify(name);
    if (slug === "e2e-proj" || closedSlugs.includes(slug)) {
      throw new Error(`seed: closedProjects slug collision for "${name}" (${slug})`);
    }
    closedSlugs.push(slug);
    writeFileSync(
      join(ayaHome, "projects", `${slug}.json`),
      JSON.stringify({ name, directory: join(root, "closed", slug), tabs: [] }, null, 2),
    );
  }
  writeFileSync(
    join(ayaHome, "projects-state.json"),
    JSON.stringify(
      {
        version: 1,
        order: ["e2e-proj", ...closedSlugs],
        open: ["e2e-proj"],
        recent: ["e2e-proj", ...closedSlugs],
      },
      null,
      2,
    ),
  );

  if (opts.usage) {
    writeFileSync(join(ayaHome, "usage.json"), JSON.stringify(opts.usage, null, 2));
  }

  if (opts.codexRateLimits) {
    // Mirrors CODEX_HOME (root/codex-home) set by the fixture env.
    const sessions = join(root, "codex-home", "sessions", "2026", "06", "03");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(
      join(sessions, "rollout-2026-06-03T00-00-00-test.jsonl"),
      JSON.stringify({
        payload: { type: "token_count", rate_limits: opts.codexRateLimits },
      }) + "\n",
    );
  }

  let launchEnv = opts.launchEnv;
  if (opts.pathRepairHarness) {
    const fakeBin = join(root, "interactive-bin");
    const fakeShell = join(root, "fake-login-shell");
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(join(fakeBin, "claude"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    writeFileSync(
      fakeShell,
      [
        "#!/bin/sh",
        "interactive=0",
        "cmd=",
        'while [ "$#" -gt 0 ]; do',
        '  case "$1" in',
        "    -i) interactive=1; shift ;;",
        "    -l) shift ;;",
        '    -c) shift; cmd="$1"; break ;;',
        "    *) shift ;;",
        "  esac",
        "done",
        'if [ "$interactive" = "1" ]; then',
        `  PATH=${shellQuote(fakeBin)}:$PATH`,
        "  export PATH",
        "fi",
        'exec /bin/sh -c "$cmd"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    chmodSync(fakeShell, 0o755);
    launchEnv = {
      ...launchEnv,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      SHELL: fakeShell,
    };
  }

  return {
    root,
    ayaHome,
    userDataDir,
    projectDir,
    launchEnv,
    tabIds: { left, right },
    missingDirPath,
  };
}
