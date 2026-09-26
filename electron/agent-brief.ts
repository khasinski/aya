// Telling an agent that `aya` exists (#117, points 2-3). Not the skill: a few
// lines that say "you are in Aya, run `aya capabilities`", so the context cost
// is flat and the command list can never go stale (the CLI answers it). There
// is no universal channel, so each harness declares one: an argument at launch,
// an environment variable pointing at a file Aya owns, a marked section in a
// global instructions file, or none - a first-class answer, not a gap. Opt-in per preset (`agentBrief`). Pure: main.ts does IO.

import * as path from "node:path";

export type BriefChannel =
  | { kind: "arg"; flag: string }
  | { kind: "env"; name: "OPENCODE_CONFIG_CONTENT" }
  | { kind: "file"; file: "codex-agents-md" }
  | { kind: "none" };

/** Per harness. Unknown and unlisted harnesses get none. Each was checked
 *  against the real CLI (2026-09-26): grok's --rules reached the model;
 *  opencode appended an OPENCODE_CONFIG_CONTENT `instructions` entry to the
 *  user's own instead of replacing them (`opencode debug config`, 1.18.30). */
export function briefChannel(agent: string | undefined): BriefChannel {
  if (agent === "claude") return { kind: "arg", flag: "--append-system-prompt" };
  if (agent === "grok") return { kind: "arg", flag: "--rules" };
  if (agent === "opencode") return { kind: "env", name: "OPENCODE_CONFIG_CONTENT" };
  if (agent === "codex") return { kind: "file", file: "codex-agents-md" };
  return { kind: "none" };
}

const BRIEF_BODY = [
  "the `aya` command reaches the Aya app: it can show your status on your tab,",
  "notify the user, and read or type into the other panes of the project.",
  "Run `aya capabilities` for the full command list (JSON) before using it.",
];

/** The brief. `conditional` is for a file every session of the harness reads,
 *  inside Aya or not; an argument is only ever passed inside Aya. */
export function briefText(conditional: boolean): string {
  const lead = conditional
    ? "If the AYA_TERMINAL_ID environment variable is set, you are running inside Aya, a terminal workspace for coding agents. There,"
    : "You are running inside Aya, a terminal workspace for coding agents;";
  return [lead, ...BRIEF_BODY].join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The launch command with the brief appended as an argument, or null when
 *  appending is not safe: the command is more than one simple command (the
 *  argument would land on the wrong one), or it already sets the flag. */
/** One simple command we can safely extend, trimmed; null otherwise. */
function simpleCommand(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed || /[;&|`\n]|\$\(/.test(trimmed)) return null;
  return trimmed;
}

export function commandWithBriefArg(
  command: string,
  channel: Extract<BriefChannel, { kind: "arg" }>,
  brief: string,
): string | null {
  const trimmed = simpleCommand(command);
  if (!trimmed) return null;
  if (` ${trimmed} `.includes(` ${channel.flag} `) || trimmed.includes(`${channel.flag}=`)) {
    return null;
  }
  return `${trimmed} ${channel.flag} ${shellQuote(brief)}`;
}

/** The launch command with the env assignment that points the harness at
 *  `briefFile` (a file under AYA_HOME), or null when not safe: a compound
 *  command, a command that already sets the variable, or one inherited from
 *  the environment - overriding it would drop the user's own inline config. */
export function commandWithBriefEnv(
  command: string,
  channel: Extract<BriefChannel, { kind: "env" }>,
  briefFile: string,
  inherited: string | undefined,
): string | null {
  const trimmed = simpleCommand(command);
  if (!trimmed || inherited || trimmed.includes(`${channel.name}=`)) return null;
  const value = JSON.stringify({ instructions: [briefFile] });
  return `${channel.name}=${shellQuote(value)} ${trimmed}`;
}

export const BRIEF_BEGIN =
  "<!-- aya:brief:begin - managed by Aya; turn off \"Tell the agent about aya\" in the preset to remove -->";
export const BRIEF_END = "<!-- aya:brief:end -->";

function sectionPattern(): RegExp {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\n?${esc(BRIEF_BEGIN)}[\\s\\S]*?${esc(BRIEF_END)}\\n?`, "g");
}

/** `content` with exactly one brief section, at the end; the rest untouched.
 *  Equal to `content` when the section is already current. */
export function withBriefSection(content: string, brief: string): string {
  const section = `${BRIEF_BEGIN}\n${brief}\n${BRIEF_END}\n`;
  const rest = content.replace(sectionPattern(), "\n").replace(/\n+$/, "");
  const next = rest ? `${rest}\n\n${section}` : section;
  return next;
}

/** `content` without the brief section; equal to `content` when there is none. */
export function withoutBriefSection(content: string): string {
  if (!content.includes(BRIEF_BEGIN)) return content;
  const rest = content.replace(sectionPattern(), "\n").replace(/\n{3,}/g, "\n\n");
  return rest.trim() ? `${rest.replace(/\n+$/, "")}\n` : "";
}

/** A leading `CODEX_HOME=...` assignment in a preset command, unquoted, with
 *  $HOME turned into ~ for the caller's expander. */
export function inlineCodexHome(command: string): string | undefined {
  const value = command.match(/(?:^|\s)CODEX_HOME=("[^"]*"|'[^']*'|\S+)/)?.[1];
  if (!value) return undefined;
  return value
    .replace(/^"|"$/g, "")
    .replace(/^'|'$/g, "")
    .replace(/^\$HOME(?=\/|$)/, "~");
}

/** Which AGENTS.md a codex preset reads: its configDir, else a CODEX_HOME set
 *  inline in its command, else the default home. */
export function codexAgentsFile(
  preset: { configDir?: string; command: string },
  defaultHome: string,
  expand: (p: string) => string,
): string {
  const dir = preset.configDir?.trim() || inlineCodexHome(preset.command);
  return path.join(dir ? expand(dir) : defaultHome, "AGENTS.md");
}

export interface CodexBriefPlan {
  /** AGENTS.md files that must carry the section. */
  ensure: string[];
  /** AGENTS.md files a codex preset points at with the brief off everywhere. */
  remove: string[];
}

/** Several presets can share one codex home: the section stays while ANY of
 *  them opts in, and is removed only when all of them are off. */
export function planCodexBriefs(
  presets: Array<{ file: string; agentBrief: boolean }>,
): CodexBriefPlan {
  const on = new Set(presets.filter((p) => p.agentBrief).map((p) => p.file));
  const off = new Set(
    presets.filter((p) => !p.agentBrief && !on.has(p.file)).map((p) => p.file),
  );
  return { ensure: [...on].sort(), remove: [...off].sort() };
}

/** Append `dir` to a PATH value unless it is already there: an installed
 *  shim earlier on PATH keeps winning, the bundled CLI is the fallback. */
export function pathWithFallbackDir(value: string | undefined, dir: string): string {
  const entries = (value ?? "").split(path.delimiter).filter(Boolean);
  if (entries.includes(dir)) return entries.join(path.delimiter);
  return [...entries, dir].join(path.delimiter);
}
