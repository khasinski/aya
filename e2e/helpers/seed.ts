import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { COMMAND_PROBE_TIMEOUT_MS } from "../../dist-electron/constants.js";

/** A slowLoginShell delay past the command probe's limit, as a heavy rc file under load is. */
export const PAST_PROBE_MS = COMMAND_PROBE_TIMEOUT_MS + 1_000;

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
  /** The second tab (id tab-right) runs this preset instead of a shell. */
  rightTab?: { presetId: string; name: string };
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
  /** $SHELL waits this long before it runs anything (a heavy rc file under load), and `cli`
   *  is a stub on PATH that prints "<cli> started" and stays up. */
  slowLoginShell?: { delayMs: number; cli: string };
  /** The right tab runs in a symlink to the project dir: one folder, spelled twice. */
  rightTabViaSymlink?: boolean;
  /** Session ids already saved on the tabs, as a previous run left them. */
  tabSessionIds?: { left?: string; right?: string };
  /** The left tab shared its folder with another pane once, as a previous run recorded. */
  leftSharedDir?: boolean;
  /** The project lives on a host reached by ssh. `ssh`, `claude` and `grok` on PATH stand in
   *  for it: the "remote" agents keep their sessions under <root>/remote-home, out of Aya's sight. */
  remoteProject?: boolean;
  /** Files written under HOME (shell rc files, say). */
  homeFiles?: Record<string, string>;
  /** `ssh` on PATH is e2e/helpers/fake-ssh-machines.cjs: fixed probe answers per target, every call logged to
   *  `<root>/ssh-calls.log`. No real host is ever reached. */
  fakeSshMachines?: boolean;
  /** The claude config dir under HOME that holds a transcript
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
  // Keep sockets short and use the shell's canonical cwd spelling from boot.
  // Otherwise /tmp -> /private/tmp looks like a checkout change to the UI.
  const root = realpathSync(mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "aya-e2e-")));
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

  let symlinkDir: string | undefined;
  if (opts.rightTabViaSymlink) {
    symlinkDir = join(root, "project-link");
    symlinkSync(effectiveProjectDir, symlinkDir);
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
        ...(opts.remoteProject ? { remote: { hostId: "fakehost", label: "fakehost", sshTarget: "me@fakehost", directory: effectiveProjectDir } } : {}),
        tabs: [
          {
            id: left,
            presetId: "shell",
            name: "shell 1",
            ...(opts.tabSessionIds?.left ? { sessionId: opts.tabSessionIds.left } : {}),
            ...(opts.leftSharedDir ? { sharedDir: true } : {}),
            ...opts.singleTab,
          },
          ...(opts.singleTab ? [] : [{
            id: right,
            presetId: "shell",
            name: "shell 2",
            ...(opts.tabSessionIds?.right ? { sessionId: opts.tabSessionIds.right } : {}),
            ...(worktreeDir ?? symlinkDir ? { cwd: worktreeDir ?? symlinkDir } : {}),
            ...opts.rightTab,
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

  // Startup syncs the antigravity rule and CLI shims under os.homedir(): never the account's.
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  if (opts.launchEnv?.HOME && !insideRoot(opts.launchEnv.HOME, root)) {
    throw new Error(`seed: launchEnv HOME ${opts.launchEnv.HOME} is outside the seeded root`);
  }
  let launchEnv: Record<string, string> = { HOME: home, ...opts.launchEnv };
  const prependPath = (bin: string) => (launchEnv = { ...launchEnv, PATH: `${bin}:${launchEnv.PATH ?? process.env.PATH}` });
  const homeFiles = { ...opts.homeFiles };
  // A login shell stand-in: runs the -c script, ignores -l and -i.
  const RUN_C = 'while [ "$#" -gt 0 ]; do\n  case "$1" in -c) shift; exec /bin/sh -c "$1" ;; *) shift ;; esac\ndone\n';
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

  if (opts.slowLoginShell) {
    const { delayMs, cli } = opts.slowLoginShell;
    const bin = join(root, "slow-shell-bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, cli), `#!/bin/sh\necho "${cli} started"\nexec sleep 600\n`, { mode: 0o755 });
    const slowShell = join(root, "slow-login-shell");
    writeFileSync(slowShell, `#!/bin/sh\nsleep ${delayMs / 1000}\n${RUN_C}`, { mode: 0o755 });
    prependPath(bin);
    launchEnv.SHELL = slowShell;
  }

  if (opts.remoteProject) {
    const bin = join(root, "remote-bin");
    mkdirSync(bin, { recursive: true });
    const remoteShell = join(bin, "remote-shell");
    writeFileSync(remoteShell, `#!/bin/sh\n${RUN_C}`, { mode: 0o755 });
    // Only the pane's `ssh -tt <target> <script>`; Aya's other ssh calls (preset listing) fail fast.
    writeFileSync(join(bin, "ssh"), `#!/bin/sh\n[ "$1" = "-tt" ] || exit 255\nSHELL=${shellQuote(remoteShell)} exec /bin/sh -c "$3"\n`, { mode: 0o755 });
    const remoteHome = join(root, "remote-home");
    for (const [name, env, fake] of [
      ["claude", `CLAUDE_CONFIG_DIR=${shellQuote(join(remoteHome, ".claude"))}`, "fake-claude.cjs"],
      ["grok", `GROK_HOME=${shellQuote(join(remoteHome, ".grok"))}`, "fake-grok.cjs"],
    ]) {
      writeFileSync(
        join(bin, name),
        `#!/bin/sh\nexport ${env}\nexec ${shellQuote(process.execPath)} ${shellQuote(join(__dirname, fake))} ${shellQuote(effectiveProjectDir)}/agent-"$AYA_TERMINAL_ID".jsonl "$@"\n`,
        { mode: 0o755 },
      );
    }
    prependPath(bin);
    // A login shell puts /usr/bin (the real ssh) back in front of PATH.
    homeFiles[".zprofile"] = homeFiles[".bash_profile"] = `export PATH=${shellQuote(bin)}:"$PATH"\n`;
  }

  if (opts.fakeSshMachines) {
    if (opts.remoteProject) throw new Error("seed: fakeSshMachines and remoteProject each own ssh");
    const bin = join(root, "ssh-bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "ssh"),
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(join(__dirname, "fake-ssh-machines.cjs"))} "$@"\n`,
      { mode: 0o755 },
    );
    prependPath(bin);
    launchEnv = { ...launchEnv, AYA_FAKE_SSH_LOG: join(root, "ssh-calls.log") };
    // Aya merges the login shell's PATH in front at startup; that shell must find this ssh first too.
    const front = `export PATH=${shellQuote(bin)}:"$PATH"\n`;
    for (const rc of [".zprofile", ".zshrc", ".bash_profile", ".bashrc"]) homeFiles[rc] = `${homeFiles[rc] ?? ""}${front}`;
  }

  if (opts.fakeBins?.length) {
    const bin = join(root, "fake-bin");
    mkdirSync(bin, { recursive: true });
    for (const name of opts.fakeBins) {
      writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    }
    prependPath(bin);
  }

  for (const [rel, text] of Object.entries(homeFiles)) {
    mkdirSync(dirname(join(home, rel)), { recursive: true });
    writeFileSync(join(home, rel), text);
  }
  if (opts.claudeTranscriptsIn) {
    // Claude names the folder after its real cwd (a symlinked tmpdir resolved).
    const slug = realpathSync(effectiveProjectDir).replace(/[^a-zA-Z0-9]/g, "-");
    const dir = join(home, opts.claudeTranscriptsIn, "projects", slug);
    mkdirSync(dir, { recursive: true });
    for (const id of Object.values(opts.tabSessionIds ?? {})) {
      if (id) writeFileSync(join(dir, `${id}.jsonl`), "{}\n");
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

export const insideRoot = (path: string, root: string): boolean => path.startsWith(`${root}/`);

const DROPPED_FROM_APP_ENV = ["ELECTRON_RUN_AS_NODE", "AYA_DEV", "AYA_SOCKET", "AYA_TERMINAL_ID", "AYA_PROJECT_SLUG", "AYA_PRESET_ID"];

/** The env for the app (or its pty host): the runner's env with every config dir
 *  pointing into the seeded root, so no launch reads or writes the account's. */
export function appEnv(
  seeded: Pick<SeededEnv, "root" | "ayaHome" | "launchEnv">,
  base: NodeJS.ProcessEnv = process.env,
  e2eFlags = true,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (typeof v === "string" && !DROPPED_FROM_APP_ENV.includes(k)) env[k] = v;
  }
  const home = join(seeded.root, "home");
  env.AYA_HOME = seeded.ayaHome;
  env.CODEX_HOME = join(seeded.root, "codex-home");
  env.GROK_HOME = join(seeded.root, "grok-home");
  // Only if the runner set them: an unset one already falls back under HOME.
  if (env.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = join(home, ".claude");
  if (env.XDG_CONFIG_HOME) env.XDG_CONFIG_HOME = join(home, ".config");
  if (env.OPENCODE_CONFIG_DIR) env.OPENCODE_CONFIG_DIR = join(home, ".config", "opencode");
  if (e2eFlags) {
    env.AYA_E2E_PTY_SHUTDOWN = "1";
    if (!base.CI) env.AYA_E2E_HEADLESS = "1";
  }
  return Object.assign(env, seeded.launchEnv);
}
