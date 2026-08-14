// Shared agent-preset helpers used by BOTH the Settings UI (display defaults)
// and the runtime spawn path (commandWithAutoResume). Keeping a single source
// here prevents the UI from showing auto-resume as enabled while the runtime
// silently treats it as disabled - the mismatch that lost agent sessions when
// a restored tab respawned without --continue.

import type { Preset } from "./types";

type Agent = NonNullable<Preset["agent"]>;

/** How Aya resumes a given agent CLI's prior session.
 *
 *  `continueLatest` is the "just pick up the most recent session for this cwd"
 *  form — no session id needed, so it fires on any restore. It is only set for
 *  agents whose flags were VERIFIED against the installed CLI (claude, codex,
 *  opencode, kilo, pi). Getting one of these wrong breaks every restore of
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
  sessionResume?: (sessionId: string) => string;
  resumeFlag: RegExp;
}

const GENERIC_RESUME_FLAG = /(?:^|\s)(?:-c|--continue|-r|--resume|--session|--conversation)(?:[=\s]|$)/;

const AGENT_SPECS: Record<Exclude<Agent, "custom">, AgentSpec> = {
  claude: {
    binary: /^claude(?:\s|$)/,
    continueLatest: "--continue",
    sessionResume: (id) => `--resume ${id}`,
    resumeFlag: /(?:^|\s)(?:-c|--continue|-r|--resume)(?:\s|$)/,
  },
  codex: {
    binary: /^codex(?:\s|$)/,
    continueLatest: "resume --last",
    sessionResume: (id) => `resume ${id}`,
    resumeFlag: /(?:^|\s)resume(?:\s|$)/,
  },
  // opencode, kilo (an opencode fork) and pi share this vocabulary. All three
  // were verified against the installed CLIs: `--continue` takes the latest
  // session, `--session <id>` takes a specific one. Note pi's `--resume` opens
  // an interactive picker — same trap as claude's bare `--resume` — so it is
  // deliberately not used here.
  opencode: {
    binary: /^opencode(?:\s|$)/,
    continueLatest: "--continue",
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
  antigravity: {
    binary: /^agy(?:\s|$)/,
    sessionResume: (id) => `--conversation ${id}`,
    resumeFlag: GENERIC_RESUME_FLAG,
  },
};

const KNOWN_AGENTS = Object.keys(AGENT_SPECS) as Array<Exclude<Agent, "custom">>;

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

/** The per-agent "continue latest session" CLI arguments. Wrong string =
 *  silently lost agent sessions, so they are named and pinned by tests (which
 *  also assert commandHasResumeFlag recognizes each one). */
export const CODEX_RESUME_ARG = "resume --last";
export const CLAUDE_RESUME_ARG = "--continue";

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

/** Build the spawn command for a (possibly restored) terminal. Appends a
 *  resume/continue arg only when the preset auto-resumes, the terminal was
 *  restored from disk, the command is non-empty, and no resume flag is present.
 *  A known `sessionId` resumes that exact session; otherwise the agent's
 *  "continue latest" form is used. Agents with neither are left untouched.
 *  Returns the original command (verbatim) when anything above rules it out. */
export function commandWithAutoResume(
  preset: Preset,
  restored: boolean | undefined,
  sessionId?: string,
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
    (sessionId ? sessionResumeArg(preset, sessionId) : null) ??
    resumeArg(preset);
  return arg ? `${command} ${arg}` : preset.command;
}
