// Shared agent-preset helpers used by BOTH the Settings UI (display defaults)
// and the runtime spawn path (commandWithAutoResume). Keeping a single source
// here prevents the UI from showing auto-resume as enabled while the runtime
// silently treats it as disabled - the mismatch that lost agent sessions when
// a restored tab respawned without --continue.

import type { Preset } from "./types";

type Agent = NonNullable<Preset["agent"]>;

/** Best-effort agent classification from a preset's command, used when the
 *  preset has no explicit `agent` field (older presets predate it). Mirrors the
 *  electron-side inference so UI, runtime, and host agree. */
export function inferAgent(preset: Pick<Preset, "command">): Agent {
  const command = preset.command.trim();
  if (/\bCLAUDE_CONFIG_DIR=/.test(command) || /^claude(?:\s|$)/.test(command)) {
    return "claude";
  }
  if (/\bCODEX_HOME=/.test(command) || /^codex(?:\s|$)/.test(command)) {
    return "codex";
  }
  return "custom";
}

/** The preset's agent, preferring the explicit field and falling back to
 *  command inference. */
export function effectiveAgent(preset: Preset): Agent {
  return preset.agent ?? inferAgent(preset);
}

export function isAgentPreset(preset: Preset): boolean {
  const agent = effectiveAgent(preset);
  return agent === "claude" || agent === "codex";
}

/** Whether a restored terminal of this preset should resume its prior session.
 *  Defaults ON for agent presets (claude/codex) so a preset that predates the
 *  `autoResume` field still resumes - matching what the Settings UI shows. An
 *  explicit `false` is honored (deliberate opt-out). */
export function effectiveAutoResume(preset: Preset): boolean {
  return preset.autoResume ?? isAgentPreset(preset);
}

/** The argument that continues the MOST RECENT session for the cwd. A bare
 *  `--resume` (claude) / `resume` (codex) opens an interactive picker instead
 *  of auto-continuing, so use the "continue latest" forms. */
export function resumeArg(preset: Preset): string {
  return effectiveAgent(preset) === "codex" ? "resume --last" : "--continue";
}

/** True when the command already carries a resume/continue flag, so appending
 *  another would be wrong (e.g. the user baked `-c` into the preset). This is a
 *  token-level heuristic, not a shell parser: it matches whitespace-delimited
 *  flags, so a flag quoted inside a literal prompt or one wedged against shell
 *  punctuation (`;`, `|`) is not recognized. Preset commands are simple launch
 *  lines, so that limit is acceptable. */
export function commandHasResumeFlag(preset: Preset, command: string): boolean {
  return effectiveAgent(preset) === "codex"
    ? /(?:^|\s)resume(?:\s|$)/.test(command)
    : /(?:^|\s)(?:-c|--continue|-r|--resume)(?:\s|$)/.test(command);
}

/** Build the spawn command for a (possibly restored) terminal. Appends a
 *  resume/continue arg only when the preset auto-resumes, the terminal was
 *  restored from disk, the command is non-empty, and no resume flag is present.
 *  Returns the original command (verbatim) otherwise. */
export function commandWithAutoResume(
  preset: Preset,
  restored: boolean | undefined,
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
  return `${command} ${resumeArg(preset)}`;
}
