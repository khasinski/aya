// What a pane's command is, and how to run it; pure, so the app and the pty
// host share it without the app loading the host's terminal code.

import * as path from "node:path";
import { simpleShellWords } from "./shell-words";

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** `command` run with `dir` first on PATH. As an assignment on the command
 *  itself it applies after the shell's rc files, which may reorder PATH. */
export function withCliFirst(command: string, dir: string): string {
  return `PATH=${shellQuote(dir)}:"$PATH" ${command}`;
}

/** Append `dir` to a PATH value unless it is already there: an installed
 *  shim earlier on PATH keeps winning, the bundled CLI is the fallback. */
export function pathWithFallbackDir(value: string | undefined, dir: string): string {
  if (!value) return dir;
  return value.split(path.delimiter).includes(dir) ? value : `${value}${path.delimiter}${dir}`;
}

/** Null for a compound command: an added argument would land on the wrong one.
 *  Operators inside quotes (a brief, a role note) do not make it compound. */
export function simpleCommand(command: string): string | null {
  const trimmed = command.trim();
  const words = simpleShellWords(trimmed);
  if (!words?.length) return null;
  // A newline between words separates commands; the word splitter calls it a space.
  const gaps = words.map((w, i) => trimmed.slice(i ? words[i - 1].end : 0, w.start));
  if (gaps.some((g) => g.includes("\n"))) return null;
  // An argument added after a # comment or a line-continuing backslash would never reach the program.
  const raw = words.map((w) => trimmed.slice(w.start, w.end));
  return raw.some((r) => r.startsWith("#")) || /(?<!\\)(?:\\\\)*\\$/.test(raw[raw.length - 1]) ? null : trimmed;
}

/** A plain interactive shell, not an agent: Enter would run typed text. */
export function isShellCommand(command: string): boolean {
  return /^(?:\$SHELL|(?:\S*\/)?(?:bash|zsh|sh|fish))(?:\s+-[a-z]+)*\s*$/.test(command.trim());
}

// What an agent CLI sets for its children: `markers` always go; `companions` (colors, pagers) only when a marker shows
// it launched Aya, at its value (null: any), so a user's own NO_COLOR stays. Grok's values: one unverified run.
interface SessionCli {
  markers: string[];
  companions: Record<string, string | null>;
}

const CLAUDE: SessionCli = {
  markers: [
    "CLAUDECODE",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_PID",
  ],
  companions: {
    AI_AGENT: null,
    CLAUDE_EFFORT: null,
    CLAUDE_CODE_HOST_SESSION_ID: null,
    CLAUDE_JOB_DIR: null,
    CLAUDE_BG_BACKEND: null,
    TRACEPARENT: null,
    GIT_EDITOR: "true",
  },
};
const CODEX: SessionCli = {
  markers: ["CODEX_CI", "CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED", "CODEX_SESSION_ID", "CODEX_THREAD_ID"],
  companions: {
    CODEX_MANAGED_BY_NPM: null,
    CODEX_MANAGED_PACKAGE_ROOT: null,
    CODEX_VERSION: null,
    NO_COLOR: "1",
    PAGER: "cat",
    GIT_PAGER: "cat",
    GH_PAGER: "cat",
    LOGNAME: "root",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
  },
};
// AGENT and OPENCODE are generic names a user may set: only an OpenCode session takes them.
const OPENCODE: SessionCli = { markers: ["OPENCODE_PID"], companions: { AGENT: null, OPENCODE: null } };
const GROK: SessionCli = {
  markers: ["GROK_AGENT", "GROK_SESSION_ID"],
  companions: {
    AWS_PAGER: "",
    CARGO_TERM_PROGRESS_WHEN: "always",
    CARGO_TERM_PROGRESS_WIDTH: "80",
    CI: "true",
    CLICOLOR: "1",
    CLICOLOR_FORCE: "1",
    FORCE_COLOR: "1",
    GH_PAGER: "cat",
    GIT_EDITOR: "true",
    GIT_PAGER: "cat",
    GIT_SEQUENCE_EDITOR: "true",
    GIT_TERMINAL_PROMPT: "0",
    GRADLE_OPTS: "-Dorg.gradle.console=rich",
    MANPAGER: "cat",
    MAVEN_OPTS: "-Dstyle.color=always",
    NO_COLOR: "1",
    NPM_CONFIG_PROGRESS: "true",
    PAGER: "cat",
    PIP_PROGRESS_BAR: "on",
    SYSTEMD_PAGER: "cat",
  },
};

/** The environment without the agent CLI sessions that launched it; the user's
 *  own settings (CLAUDE_CONFIG_DIR, CODEX_HOME, a NO_COLOR of their own) stay. */
export function withoutSessionMarkers(env: Record<string, string>): Record<string, string> {
  const out = { ...env };
  for (const cli of [CLAUDE, CODEX, OPENCODE, GROK]) {
    if (!cli.markers.some((key) => key in env)) continue;
    for (const key of cli.markers) delete out[key];
    for (const [key, value] of Object.entries(cli.companions)) {
      if (value === null || env[key] === value) delete out[key];
    }
  }
  return out;
}
