// Shared agent-preset helpers used by BOTH the Settings UI (display defaults)
// and the runtime spawn path (commandWithAutoResume). Keeping a single source
// here prevents the UI from showing auto-resume as enabled while the runtime
// silently treats it as disabled - the mismatch that lost agent sessions when
// a restored tab respawned without --continue.

import type { Preset, SpawnCommand } from "./types";

type Agent = NonNullable<Preset["agent"]>;

/** How Aya resumes a given agent CLI's prior session.
 *
 *  `continueLatest` is the "just pick up the most recent session for this cwd"
 *  form - no session id needed, so it fires on any restore. It is only set for
 *  agents whose flags were VERIFIED against the installed CLI (claude, codex,
 *  opencode, kilo, pi, antigravity). Getting one of these wrong breaks every restore of
 *  that agent, so an unverified guess must never land here.
 *
 *  `sessionResume` needs a concrete session id, which Aya only learns when the
 *  agent reports one over the OSC 9001 channel (see integrations.md). For the
 *  agents that are not installed here, those argument shapes come from herdr's
 *  `src/agent_resume.rs` (Apache-2.0) rather than from running the CLI, so
 *  they stay behind the "we actually have an id" gate: a wrong flag cannot
 *  corrupt a normal launch, it just never fires.
 *
 *  Beware picker flags: a bare `--resume` opens an interactive session chooser
 *  in claude and pi, which would hang a restored tab waiting for a keypress.
 *  Always prefer the non-interactive "continue" form.
 *
 *  `resumeFlag` must recognise every form this agent might already carry, so a
 *  user who baked a resume flag into their preset never gets a second one
 *  appended. */
interface AgentSpec {
  /** Matches the agent's binary at the start of a command. */
  binary: RegExp;
  continueLatest?: string;
  /** `continueLatest` picks the cwd's newest session, a sibling pane's when panes share the folder: such a pane resumes
   *  a known id or starts fresh. */
  latestIsPerDir?: boolean;
  sessionResume?: (sessionId: string) => string;
  resumeFlag: RegExp;
}

const GENERIC_RESUME_FLAG = /(?:^|\s)(?:-c|--continue|-r|--resume|--session|--session-id|--conversation)(?:[=\s]|$)/;

const AGENT_SPECS: Record<Exclude<Agent, "custom">, AgentSpec> = {
  claude: {
    binary: /^claude(?:\s|$)/,
    continueLatest: "--continue",
    latestIsPerDir: true,
    sessionResume: (id) => `--resume ${id}`,
    resumeFlag: /(?:^|\s)(?:-c|--continue|-r|--resume|--session-id)(?:[=\s]|$)/,
  },
  codex: {
    binary: /^codex(?:\s|$)/,
    continueLatest: "resume --last",
    latestIsPerDir: true,
    sessionResume: (id) => `resume ${id}`,
    resumeFlag: /(?:^|\s)resume(?:\s|$)/,
  },
  // opencode, kilo (an opencode fork) and pi share this vocabulary. All three
  // were verified against the installed CLIs: `--continue` takes the latest
  // session, `--session <id>` takes a specific one. Note pi's `--resume` opens
  // an interactive picker - same trap as claude's bare `--resume` - so it is
  // deliberately not used here. opencode's `--continue` spans every git
  // worktree of the repo, so the pty host swaps it for this cwd's own session
  // (electron/opencode-session.ts).
  opencode: {
    binary: /^opencode(?:\s|$)/,
    continueLatest: "--continue",
    latestIsPerDir: true,
    sessionResume: (id) => `--session ${id}`,
    resumeFlag: GENERIC_RESUME_FLAG,
  },
  kilo: {
    binary: /^kilo(?:\s|$)/,
    continueLatest: "--continue",
    sessionResume: (id) => `--session ${id}`,
    resumeFlag: GENERIC_RESUME_FLAG,
  },
  pi: {
    binary: /^pi(?:\s|$)/,
    continueLatest: "--continue",
    sessionResume: (id) => `--session ${id}`,
    resumeFlag: GENERIC_RESUME_FLAG,
  },
  cursor: {
    binary: /^cursor-agent(?:\s|$)/,
    sessionResume: (id) => `--resume ${id}`,
    resumeFlag: GENERIC_RESUME_FLAG,
  },
  copilot: {
    binary: /^copilot(?:\s|$)/,
    sessionResume: (id) => `--resume=${id}`,
    resumeFlag: GENERIC_RESUME_FLAG,
  },
  grok: {
    binary: /^grok(?:\s|$)/,
    sessionResume: (id) => `--resume ${id}`,
    resumeFlag: GENERIC_RESUME_FLAG,
  },
  droid: {
    binary: /^droid(?:\s|$)/,
    sessionResume: (id) => `--resume ${id}`,
    resumeFlag: GENERIC_RESUME_FLAG,
  },
  devin: {
    binary: /^devin(?:\s|$)/,
    sessionResume: (id) => `--resume ${id}`,
    resumeFlag: GENERIC_RESUME_FLAG,
  },
  kimi: {
    binary: /^kimi(?:\s|$)/,
    sessionResume: (id) => `--session ${id}`,
    resumeFlag: GENERIC_RESUME_FLAG,
  },
  hermes: {
    binary: /^hermes(?:\s|$)/,
    sessionResume: (id) => `--resume ${id}`,
    resumeFlag: GENERIC_RESUME_FLAG,
  },
  qodercli: {
    binary: /^qodercli(?:\s|$)/,
    sessionResume: (id) => `--resume ${id}`,
    resumeFlag: GENERIC_RESUME_FLAG,
  },
  // Verified on agy 1.2.11: --continue is per directory and starts fresh when
  // there is no earlier conversation.
  antigravity: {
    binary: /^agy(?:\s|$)/,
    continueLatest: "--continue",
    sessionResume: (id) => `--conversation ${id}`,
    resumeFlag: GENERIC_RESUME_FLAG,
  },
};

const KNOWN_AGENTS = Object.keys(AGENT_SPECS) as Array<Exclude<Agent, "custom">>;

// Mirrored by electron/agent-session.ts; a test holds the two equal.
const BEFORE_PROGRAM = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"(?:[^"\\]|\\.)*"|\\.|[^\s'"\\])*\s+)*(?:exec\s+)?(?:\S*\/)?/;

/** Whether the program after `NAME=value` assignments and a plain `exec` is an agent's own binary; a flag appended to
 *  a wrapper (bash -c, env, ssh, docker) lands on the wrapper. */
export function launchesAgentDirectly(command: string): boolean {
  const program = command.slice(BEFORE_PROGRAM.exec(command)?.[0].length ?? 0);
  return KNOWN_AGENTS.some((agent) => AGENT_SPECS[agent].binary.test(program));
}

/** Best-effort agent classification from a preset's command, used when the
 *  preset has no explicit `agent` field (older presets predate it). Mirrors the
 *  electron-side inference so UI, runtime, and host agree. */
export function inferAgent(preset: Pick<Preset, "command">): Agent {
  const command = preset.command.trim();
  // Config-dir env prefixes are how Aya's own account presets launch these
  // two, so they classify even when the binary is not the first token.
  if (/\bCLAUDE_CONFIG_DIR=/.test(command)) return "claude";
  if (/\bCODEX_HOME=/.test(command)) return "codex";
  for (const agent of KNOWN_AGENTS) {
    if (AGENT_SPECS[agent].binary.test(command)) return agent;
  }
  return "custom";
}

/** The preset's agent, preferring the explicit field and falling back to
 *  command inference. */
export function effectiveAgent(preset: Preset): Agent {
  return preset.agent ?? inferAgent(preset);
}

function agentSpec(preset: Preset): AgentSpec | null {
  const agent = effectiveAgent(preset);
  return agent === "custom" ? null : AGENT_SPECS[agent];
}

export function isAgentPreset(preset: Preset): boolean {
  return effectiveAgent(preset) !== "custom";
}

/** Whether a restored terminal of this preset should resume its prior session.
 *  Defaults ON for agent presets so a preset that predates the `autoResume`
 *  field still resumes - matching what the Settings UI shows. An explicit
 *  `false` is honored (deliberate opt-out). */
export function effectiveAutoResume(preset: Preset): boolean {
  return preset.autoResume ?? isAgentPreset(preset);
}

/** The argument that continues the MOST RECENT session for the cwd, or null
 *  for agents with no such form (they can only resume a known session id). A
 *  bare `--resume` (claude) / `resume` (codex) opens an interactive picker
 *  instead of auto-continuing, so the "continue latest" forms are used. */
export function resumeArg(preset: Preset): string | null {
  return agentSpec(preset)?.continueLatest ?? null;
}

/** The argument that resumes one SPECIFIC session, or null when the agent has
 *  no known session-resume form. */
export function sessionResumeArg(
  preset: Preset,
  sessionId: string,
): string | null {
  const spec = agentSpec(preset);
  if (!spec?.sessionResume || !sessionId.trim()) return null;
  return spec.sessionResume(sessionId.trim());
}

/** True when the command already carries a resume/continue flag, so appending
 *  another would be wrong (e.g. the user baked `-c` into the preset). This is a
 *  token-level heuristic, not a shell parser: it matches whitespace-delimited
 *  flags, so a flag quoted inside a literal prompt or one wedged against shell
 *  punctuation (`;`, `|`) is not recognized. Preset commands are simple launch
 *  lines, so that limit is acceptable. */
export function commandHasResumeFlag(preset: Preset, command: string): boolean {
  const spec = agentSpec(preset);
  if (!spec) return false;
  return spec.resumeFlag.test(command);
}

/** A restored terminal's command with its resume arg: a known `sessionId`, else "continue latest" unless `sharesDir`
 *  makes that a sibling's session; verbatim unless an auto-resuming preset's restored command has no resume flag. */
export function commandWithAutoResume(
  preset: Preset,
  restored: boolean | undefined,
  sessionId?: string,
  sharesDir = false,
): string {
  const command = preset.command.trim();
  if (
    !restored ||
    !effectiveAutoResume(preset) ||
    !command ||
    commandHasResumeFlag(preset, command)
  ) {
    return preset.command;
  }
  const arg =
    (sessionId && launchesAgentDirectly(command) ? sessionResumeArg(preset, sessionId) : null) ??
    (sharesDir && agentSpec(preset)?.latestIsPerDir ? null : resumeArg(preset));
  return arg ? `${command} ${arg}` : preset.command;
}

const BRIEF_HINTS = new Map<Agent, string>([
  ["claude", "Adds a short note via --append-system-prompt when the pane starts."],
  ["codex", "Adds a short note via -c developer_instructions when the pane starts; not when your Codex config or the command already sets developer_instructions, which Aya never replaces."],
  ["grok", "Adds a short note via --rules when the pane starts."],
  ["opencode", "Adds a short note to opencode's instructions for Aya panes only (OPENCODE_CONFIG)."],
  ["antigravity", "Adds one always-on Antigravity rule, shared by all agy presets (deleted when none opts in)."],
]);

/** Null hides the toggle: the harness has no channel. Mirrors roleChannel in electron/agent-brief.ts plus
 *  Antigravity's own rule file; a test holds them equal. */
export function agentBriefHint(agent: Agent | undefined): string | null {
  return (agent ? BRIEF_HINTS.get(agent) : undefined) ?? null;
}

/** What to spawn for a pane: `command`, and `sharedDirCommand` for when a peer of the same agent (`peerCwds`) turns
 *  out, by real path at the host, to run in the same folder. */
export function resumeSpawn(
  preset: Preset,
  pane: { id: string; cwd: string; restored?: boolean; sessionId?: string; sharedDir?: boolean },
  panes: Array<{ id: string; preset: Preset; cwd: string }>,
): SpawnCommand {
  const command = commandWithAutoResume(preset, pane.restored, pane.sessionId, pane.sharedDir);
  const sharedDirCommand = commandWithAutoResume(preset, pane.restored, pane.sessionId, true);
  if (sharedDirCommand === command) return { command };
  const agent = effectiveAgent(preset);
  const peerCwds = panes
    .filter((p) => p.id !== pane.id && effectiveAgent(p.preset) === agent)
    .map((p) => p.cwd);
  return peerCwds.length > 0 ? { command, sharedDirCommand, peerCwds } : { command };
}

const withoutTrailingSlash = (cwd: string) => (cwd.length > 1 ? cwd.replace(/\/+$/, "") : cwd);

/** The panes with a peer of the same "continue latest" agent in their folder, by its
 *  spelling (the pty host also compares live peers by real path). */
export function sharingPaneIds(panes: Array<{ id: string; preset: Preset; cwd: string }>): Set<string> {
  const groups = new Map<string, string[]>();
  for (const pane of panes) {
    if (!agentSpec(pane.preset)?.latestIsPerDir) continue;
    const key = `${effectiveAgent(pane.preset)}\0${withoutTrailingSlash(pane.cwd)}`;
    groups.set(key, [...(groups.get(key) ?? []), pane.id]);
  }
  return new Set([...groups.values()].filter((ids) => ids.length > 1).flat());
}
