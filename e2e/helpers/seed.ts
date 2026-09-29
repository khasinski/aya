import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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
  /** Set only when `gitWorktree` is requested: the worktree the right tab runs
   *  in (branch "wt/bar", one modified file). */
  worktreeDir?: string;
}

export interface SeedOptions {
  /** The project opens with this one tab (id tab-left) instead of two shells,
   *  and no split layout. */
  singleTab?: { presetId: string; name: string };
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
  presetList?: Array<{
    id: string;
    name: string;
    icon: string;
    color: string;
    command: string;
    autoResume?: boolean;
  }>;
  /** Extra environment variables for the Electron process. */
  launchEnv?: Record<string, string>;
  /** Create a fake shell/bin setup where interactive shell PATH reveals claude. */
  pathRepairHarness?: boolean;
  /** HOME = <root>/home, for code that writes under the user's home. */
  fakeHome?: boolean;
  /** Session ids already saved on the tabs, as a previous run left them. */
  tabSessionIds?: { left?: string; right?: string };
  /** With fakeHome: the claude config dir under HOME that holds a transcript
   *  for each of `tabSessionIds`, as Claude saves one per conversation. */
  claudeTranscriptsIn?: string;
  /** Stub executables put first on PATH, so harness detection finds them. */
  fakeBins?: string[];
  /** #115's machine: an rvm gemset first on PATH with a working Aya shim, dead
   *  pre-#39 shims below it in ~/bin and ~/.local/bin, and a foreign `aya` last.
   *  "off-path": only the gemset and system dirs are on PATH. */
  cliInstallHarness?: boolean | "off-path";
  /** GROK_HOME with a logs/unified.jsonl holding one credits-config line. */
  grokCredits?: { pct: number; end: string; ts: string };
  /** Names of extra projects that are known + recent but NOT open, so the
   *  recent-projects menu lists them as closed projects. */
  closedProjects?: string[];
  /** Make the project dir a real git repo on branch "feature/foo" with one
   *  commit, then leave a modified tracked file + an untracked file so the
   *  StatusBar shows a branch + "2 dirty" + a diff. */
  gitRepo?: boolean;
  /** Requires `gitRepo`. Add a git worktree on branch "wt/bar" with its own
   *  dirty file, and bind the RIGHT tab to it (tab.cwd), so tests can check the
   *  status bar follows the active terminal's checkout. Path: `worktreeDir`. */
  gitWorktree?: boolean;
  /** Point the open project at a directory that does NOT exist, so the boot
   *  dir-check queues it and MissingDirModal appears. The path is exposed as
   *  `seeded.missingDirPath` so a test can assert "Create folder" made it. */
  missingDir?: boolean;
  /** Write the project's `.aya/project.json` with these presets, so the repo
   *  preset-import flow (ProjectPresetImportModal) triggers for the project. */
  repoPresets?: Array<{ id: string; name: string; icon: string; color: string; command: string }>;
  /** Files to write before launch, relative to the project dir or AYA_HOME. */
  projectFiles?: Record<string, string>;
  ayaHomeFiles?: Record<string, string>;
  /** Open a SECOND project ("e2e-proj-2", one tab named "shell 3") so tests can
   *  exercise project switching (e.g. the project-N shortcut). */
  secondProject?: boolean;
  /** Start a PTY host (holding no sessions) BEFORE the app launches, so the
   *  app connects to a REUSED host: boot-restored tabs must then attach-only
   *  (-> stopped/restartable) instead of auto-respawning. Consumed by the
   *  `app` fixture, not by seedEnv. */
  preStartPtyHost?: boolean;
  /** Write ayaHome/snippets.json with these snippets instead of letting the
   *  app seed its defaults. */
  snippetList?: Array<{ id: string; name: string; text: string; autoRun: boolean }>;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Build a throwaway, deterministic environment for one Electron launch:
 *  a project with two shell terminals (in a 1x2 split by default), a single
 *  shell preset (so no PATH harness scan pulls in claude/codex), and an empty
 *  snippet store that the app seeds with its defaults on boot. */
export function seedEnv(opts: SeedOptions = {}): SeededEnv {
  const split = opts.split !== false && !opts.singleTab;
  const root = mkdtempSync(join(tmpdir(), "aya-e2e-"));
  const ayaHome = join(root, "aya-home");
  const userDataDir = join(root, "electron-data");
  const projectDir = join(root, "project");
  mkdirSync(join(ayaHome, "projects"), { recursive: true });
  mkdirSync(userDataDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  // When requested, point the project at a path we deliberately do NOT create,
  // so the boot dir-check queues it and MissingDirModal appears.
  if (opts.missingDir && opts.repoPresets) {
    // repoPresets writes under projectDir, but missingDir repoints the project
    // away from it, so the repo config would not be associated with the project.
    throw new Error("seed: missingDir and repoPresets cannot be combined");
  }
  const missingDirPath = opts.missingDir ? join(root, "missing-project-dir") : undefined;
  const effectiveProjectDir = missingDirPath ?? projectDir;
  // Repo-local launchers: a `.aya/project.json` in the project dir triggers the
  // ProjectPresetImportModal (suggest importing the repo's presets).
  if (opts.repoPresets) {
    mkdirSync(join(projectDir, ".aya"), { recursive: true });
    writeFileSync(
      join(projectDir, ".aya", "project.json"),
      JSON.stringify({ presets: opts.repoPresets }, null, 2),
    );
  }

  for (const [base, files] of [
    [projectDir, opts.projectFiles],
    [ayaHome, opts.ayaHomeFiles],
  ] as const) {
    for (const [rel, text] of Object.entries(files ?? {})) {
      mkdirSync(dirname(join(base, rel)), { recursive: true });
      writeFileSync(join(base, rel), text);
    }
  }

  let worktreeDir: string | undefined;
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
    if (opts.gitWorktree) {
      // A second checkout with its OWN branch and its own single dirty file, so
      // "which checkout is the status bar reading?" has an unambiguous answer.
      worktreeDir = join(root, "wt-bar");
      git("worktree", "add", "-q", "-b", "wt/bar", worktreeDir);
      writeFileSync(join(worktreeDir, "committed.txt"), "one\ntwoWT\n");
    }
  } else if (opts.gitWorktree) {
    throw new Error("seed: gitWorktree requires gitRepo");
  }

  if (opts.presets !== false) {
    const presetList = opts.presetList ?? [
      { id: "shell", name: "Shell", icon: "$", color: "", command: "$SHELL" },
    ];
    writeFileSync(join(ayaHome, "presets.json"), JSON.stringify({ presets: presetList }, null, 2));
  }
  if (opts.snippetList) {
    writeFileSync(join(ayaHome, "snippets.json"), JSON.stringify({ snippets: opts.snippetList }, null, 2));
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
          {
            id: left,
            presetId: "shell",
            name: "shell 1",
            ...(opts.tabSessionIds?.left ? { sessionId: opts.tabSessionIds.left } : {}),
            ...opts.singleTab,
          },
          ...(opts.singleTab ? [] : [{
            id: right,
            presetId: "shell",
            name: "shell 2",
            ...(opts.tabSessionIds?.right ? { sessionId: opts.tabSessionIds.right } : {}),
            ...(worktreeDir ? { cwd: worktreeDir } : {}),
          }]),
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
  // Optional second OPEN project so tests can switch projects.
  const secondSlug = opts.secondProject ? "e2e-proj-2" : null;
  if (secondSlug) {
    const projectDir2 = join(root, "project2");
    mkdirSync(projectDir2, { recursive: true });
    writeFileSync(
      join(ayaHome, "projects", `${secondSlug}.json`),
      JSON.stringify(
        {
          name: "e2e 2",
          directory: projectDir2,
          tabs: [{ id: "tab-p2", presetId: "shell", name: "shell 3" }],
        },
        null,
        2,
      ),
    );
  }
  const openSlugs = ["e2e-proj", ...(secondSlug ? [secondSlug] : [])];
  writeFileSync(
    join(ayaHome, "projects-state.json"),
    JSON.stringify(
      {
        version: 1,
        order: [...openSlugs, ...closedSlugs],
        open: openSlugs,
        recent: [...openSlugs, ...closedSlugs],
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

  if (opts.fakeBins?.length) {
    const bin = join(root, "fake-bin");
    mkdirSync(bin, { recursive: true });
    for (const name of opts.fakeBins) {
      writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    }
    launchEnv = { ...launchEnv, PATH: `${bin}:${launchEnv?.PATH ?? process.env.PATH}` };
  }

  if (opts.fakeHome) {
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    launchEnv = { ...launchEnv, HOME: home };
    if (opts.claudeTranscriptsIn) {
      // Claude names the folder after its real cwd (a symlinked tmpdir resolved).
      const slug = realpathSync(effectiveProjectDir).replace(/[^a-zA-Z0-9]/g, "-");
      const dir = join(home, opts.claudeTranscriptsIn, "projects", slug);
      mkdirSync(dir, { recursive: true });
      for (const id of Object.values(opts.tabSessionIds ?? {})) {
        if (id) writeFileSync(join(dir, `${id}.jsonl`), "{}\n");
      }
    }
  }

  if (opts.cliInstallHarness) {
    const home = join(root, "cli-home");
    const gemset = join(home, ".rvm", "gems", "ruby-3.4.4", "bin");
    const homeBin = join(home, "bin");
    const localBin = join(home, ".local", "bin");
    const toolsBin = join(home, "tools");
    // A dotfiles-managed copy: PATH holds a SYMLINK to a dead legacy shim kept
    // in a repo. It must never be written through or removed (#120 review).
    const linkBin = join(home, "link-bin");
    const dotfiles = join(home, "dotfiles");
    for (const dir of [gemset, homeBin, localBin, toolsBin, linkBin, dotfiles]) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(
      join(dotfiles, "aya"),
      '#!/bin/sh\nexec "/Applications/Aya.app/Contents/Resources/app.asar/bin/aya" "$@"\n',
      { mode: 0o755 },
    );
    symlinkSync(join(dotfiles, "aya"), join(linkBin, "aya"));
    writeFileSync(join(toolsBin, "aya"), "#!/bin/sh\nexec /usr/bin/true\n", { mode: 0o755 });
    // Healthy: execs this checkout's CLI, which exists.
    writeFileSync(
      join(gemset, "aya"),
      `#!/bin/sh\nexec ${JSON.stringify(join(__dirname, "..", "..", "bin", "aya"))} "$@"\n`,
      { mode: 0o755 },
    );
    // Dead: the pre-#39 shim from #115, execing into the asar archive.
    for (const dir of [homeBin, localBin]) {
      writeFileSync(
        join(dir, "aya"),
        '#!/bin/sh\nexec "/Applications/Aya.app/Contents/Resources/app.asar/bin/aya" "$@"\n',
        { mode: 0o755 },
      );
    }
    // A login shell that adds nothing, so PATH repair leaves this PATH alone.
    const quietShell = join(root, "quiet-login-shell");
    writeFileSync(
      quietShell,
      [
        "#!/bin/sh",
        'while [ "$#" -gt 0 ]; do',
        '  case "$1" in -c) shift; exec /bin/sh -c "$1" ;; *) shift ;; esac',
        "done",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    launchEnv = {
      ...launchEnv,
      HOME: home,
      PATH: [
        gemset,
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
        ...(opts.cliInstallHarness === "off-path" ? [] : [homeBin, localBin, toolsBin, linkBin]),
      ].join(":"),
      SHELL: quietShell,
    };
  }

  if (opts.grokCredits) {
    const grokHome = join(root, "grok-home");
    mkdirSync(join(grokHome, "logs"), { recursive: true });
    const { pct, end, ts } = opts.grokCredits;
    writeFileSync(
      join(grokHome, "logs", "unified.jsonl"),
      `${JSON.stringify({
        ts,
        msg: "billing: fetched credits config",
        ctx: { config: { creditUsagePercent: pct, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end } } },
      })}\n`,
    );
    launchEnv = { ...launchEnv, GROK_HOME: grokHome };
  }

  return {
    root,
    ayaHome,
    userDataDir,
    projectDir,
    launchEnv,
    tabIds: { left, right },
    missingDirPath,
    worktreeDir,
  };
}
