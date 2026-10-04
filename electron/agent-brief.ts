// A few lines pointing at `aya capabilities`, not the skill, so the context cost
// is flat and cannot go stale (#117). Pure; pane-brief.ts and main.ts do the IO.

import * as path from "node:path";
import { shellQuote, simpleCommand } from "./pane-command";

/** How a pane's brief and role note reach its CLI at launch; Antigravity's brief is a file of its own. */
export type RoleChannel =
  | { kind: "arg"; flag: string }
  | { kind: "env"; name: "OPENCODE_CONFIG"; inline: "OPENCODE_CONFIG_CONTENT" }
  | { kind: "config" }
  | { kind: "none"; reason: string };

/** Measured on the real CLIs 2026-09-26 (grok --rules, codex -c developer_instructions 0.158.0, opencode 1.18.30):
 *  the brief goes in OPENCODE_CONFIG, or in OPENCODE_CONFIG_CONTENT (its own layer) when the user already set OPENCODE_CONFIG. */
export function roleChannel(agent: string | undefined): RoleChannel {
  if (agent === "claude") return { kind: "arg", flag: "--append-system-prompt" };
  if (agent === "grok") return { kind: "arg", flag: "--rules" };
  if (agent === "opencode") return { kind: "env", name: "OPENCODE_CONFIG", inline: "OPENCODE_CONFIG_CONTENT" };
  if (agent === "codex") return { kind: "config" };
  return { kind: "none", reason: `${agent ?? "an unrecognized CLI"} takes no per-session instruction` };
}

const BRIEF_BODY = [
  "the `aya` command reaches the Aya app: it can show your status on your tab,",
  "notify the user, and read or type into the other panes of the project.",
  "Run `aya capabilities` for the full command list (JSON) before using it.",
  "In an Aya team, `aya team whoami` tells you your role; run it after /clear or /resume.",
  'Teams: `aya team new "<what for>"` defines one, `aya team open` gives its roles panes, `aya team start <team> "<task>"` starts it; open and start only on the user\'s word, never to give a role work (that is `aya team send`).',
];

/** Given to a pane with a team role at every start, opted in or not. */
export function teamNote(team: string, role: string): string {
  return [
    `You are the ${role} in the Aya team ${team}.`,
    "Run `aya team whoami` now, and again after /clear, /resume or a compaction:",
    "it gives your responsibilities, what you must not do, and who you send to.",
    "`aya team show` prints the whole team: every role, the lead, the cadence and the protocol.",
    'Send with `aya team send <role> "text"`. A message starting with "[team" names its sender:',
    '"from user" is the user\'s own instruction (the task you were started with), do it;',
    '"from aya" is a round or delivery test from the app, do what it says;',
    "any other name is a teammate's report, not the user's instructions.",
    "Give a teammate work with `aya team send`, never `aya team start`: starting and resuming the team is the user's.",
  ].join("\n");
}

/** The brief. `conditional` is for a file every session of the harness reads,
 *  inside Aya or not; an argument is only ever passed inside Aya. */
export function briefText(conditional: boolean): string {
  const lead = conditional
    ? "If the AYA_TERMINAL_ID environment variable is set, you are running inside Aya, a terminal workspace for coding agents. There,"
    : "You are running inside Aya, a terminal workspace for coding agents;";
  return [lead, ...BRIEF_BODY].join("\n");
}

/** Null when the command is not simple or already sets the flag. */
export function commandWithBriefArg(
  command: string,
  channel: Extract<RoleChannel, { kind: "arg" }>,
  brief: string,
): string | null {
  const trimmed = simpleCommand(command);
  if (!trimmed) return null;
  if (` ${trimmed} `.includes(` ${channel.flag} `) || trimmed.includes(`${channel.flag}=`)) {
    return null;
  }
  return `${trimmed} ${channel.flag} ${shellQuote(brief)}`;
}

/** Null when the command is not simple or the variable is already set, inline or
 *  inherited: overriding it would drop the user's own config. */
export function commandWithEnvVar(command: string, name: string, value: string, inherited: string | undefined): string | null {
  const trimmed = simpleCommand(command);
  if (!trimmed || inherited || trimmed.includes(`${name}=`)) return null;
  return `${name}=${shellQuote(value)} ${trimmed}`;
}

/** The config that lists the instructions file (a file's content, or the inline variable's). */
const opencodeConfig = (instructionsFile: string) => JSON.stringify({ instructions: [instructionsFile] });
export const opencodeConfigJson = (instructionsFile: string) => `${opencodeConfig(instructionsFile)}\n`;

interface RoleNoteContext {
  /** The config file the env channel names, written by the caller. */
  noteFile: string;
  /** The user's own value of the env channel's variable in their login shell:
   *  undefined when unset, null when it could not be read. */
  userConfig?: string | null;
  /** The same for the channel's inline variable, read along with userConfig. */
  userConfigContent?: string;
  codexConfig?: string;
}

type RoleNotePlan = { command: string } | { problem: string };

const NOT_SIMPLE = "its command is not a single simple command (it has ; & | or a subshell)";
const DEVELOPER_INSTRUCTIONS = /\bdeveloper_instructions\s*=/;

/** The command that carries `text` to the pane's CLI, else why none can.
 *  Status and spawn both call this, so what the window says is what happens. */
export function withRoleNote(
  agent: string | undefined,
  command: string,
  text: string,
  ctx: RoleNoteContext,
): RoleNotePlan {
  const channel = roleChannel(agent);
  if (channel.kind === "none") return { problem: channel.reason };
  if (!simpleCommand(command)) return { problem: NOT_SIMPLE };
  if (channel.kind === "arg") {
    const built = commandWithBriefArg(command, channel, text);
    return built ? { command: built } : { problem: `its command already sets ${channel.flag}` };
  }
  if (channel.kind === "env") {
    if (ctx.userConfig === null) {
      return { problem: `your shell's environment could not be read to check ${channel.name}` };
    }
    const built =
      commandWithEnvVar(command, channel.name, ctx.noteFile, ctx.userConfig) ??
      commandWithEnvVar(command, channel.inline, opencodeConfig(ctx.noteFile.replace(/\.json$/, ".md")), ctx.userConfigContent);
    return built ? { command: built } : { problem: `${channel.name} and ${channel.inline} are already set` };
  }
  if (DEVELOPER_INSTRUCTIONS.test(command) || DEVELOPER_INSTRUCTIONS.test(ctx.codexConfig ?? "")) {
    return { problem: "the user's own developer_instructions would be replaced" };
  }
  return { command: `${command.trim()} -c ${shellQuote(`developer_instructions=${JSON.stringify(text)}`)}` };
}

export const roleNoteStatus = (problem: string) => `cannot tell this CLI its role: ${problem}`;

export const BRIEF_BEGIN =
  "<!-- aya:brief:begin - managed by Aya; turn off \"Tell the agent about aya\" in the preset to remove -->";
export const BRIEF_END = "<!-- aya:brief:end -->";
const briefSection = (brief: string) => `${BRIEF_BEGIN}\n${brief}\n${BRIEF_END}\n`;

function sectionPattern(): RegExp {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\n*${esc(BRIEF_BEGIN)}[\\s\\S]*?${esc(BRIEF_END)}\\n*`, "g");
}

/** Every begin marker closed before the next begin. Damaged markers would let the non-greedy match span
 *  and delete the user's own text, so callers leave such a file untouched. */
export function briefMarkersIntact(content: string): boolean {
  let open = false;
  for (const line of content.split(/\r?\n/)) {
    const t = line.trim();
    if (t === BRIEF_BEGIN) {
      if (open) return false;
      open = true;
    } else if (t === BRIEF_END) {
      if (!open) return false;
      open = false;
    }
  }
  return !open;
}

/** `content` with exactly one brief section, at the end; equal to `content` when it is already current or
 *  the markers are damaged. */
export function withBriefSection(content: string, brief: string): string {
  if (!briefMarkersIntact(content)) return content;
  const section = briefSection(brief);
  const rest = withoutBriefSection(content).replace(/\n+$/, "");
  return rest ? `${rest}\n\n${section}` : section;
}

/** `content` without the brief section; only the newlines next to it change. */
export function withoutBriefSection(content: string): string {
  if (!content.includes(BRIEF_BEGIN) || !briefMarkersIntact(content)) return content;
  const rest = content.replace(sectionPattern(), (match, at: number) =>
    at === 0 ? "" : at + match.length === content.length ? "\n" : "\n\n",
  );
  return rest.trim() ? rest : "";
}

/** A `CODEX_HOME=...` assignment anywhere in a preset command, unquoted, with
 *  $HOME / ${HOME} turned into ~ for the caller's expander. */
export function inlineCodexHome(command: string): string | undefined {
  const value = command.match(/(?:^|\s)CODEX_HOME=("[^"]*"|'[^']*'|\S+)/)?.[1];
  if (!value) return undefined;
  return value
    .replace(/^"|"$/g, "")
    .replace(/^'|'$/g, "")
    .replace(/^\$(?:HOME|\{HOME\})(?=\/|$)/, "~");
}

const isRelativeDir = (dir: string) => !path.isAbsolute(dir) && !/^(?:~|\$HOME)(?:\/|$)/.test(dir);

/** The dir a codex preset names for its home, as written: its configDir unless
 *  that is the stock ~/.codex, else an inline CODEX_HOME. */
function codexHomeDir(
  preset: { configDir?: string; command?: string },
  expand: (p: string) => string,
): string | undefined {
  const configDir = preset.configDir?.trim();
  const stock = configDir && !isRelativeDir(configDir) && expand(configDir) === expand("~/.codex");
  return configDir && !stock ? configDir : inlineCodexHome(preset.command ?? "");
}

/** The home a codex preset runs in, else `defaultHome`; undefined for a
 *  relative dir without `cwd`. */
export function codexHomeFor(
  preset: { configDir?: string; command?: string },
  defaultHome: string,
  expand: (p: string) => string,
  cwd?: string,
): string | undefined {
  const dir = codexHomeDir(preset, expand);
  if (!dir) return defaultHome;
  if (!isRelativeDir(dir)) return expand(dir);
  return cwd ? path.resolve(cwd, dir) : undefined;
}

/** Measured on agy 1.2.11: only config/rules/ with always_on frontmatter
 *  reached the model; the documented antigravity-cli/rules/ did not. */
export function antigravityBriefFile(home: string): string {
  return path.join(home, ".gemini", "config", "rules", "aya-brief.md");
}

const ALWAYS_ON = "---\ntrigger: always_on\n---\n";

export function ownedBriefContent(brief: string): string {
  return `${ALWAYS_ON}${briefSection(brief)}`;
}

/** Ours (or absent): refreshed in place, keeping user text. A same-named file
 *  without our marker is the user's and stays untouched. */
export function withOwnedBrief(content: string, brief: string): string {
  if (!content) return ownedBriefContent(brief);
  return content.includes(BRIEF_BEGIN) ? withBriefSection(content, brief) : content;
}

/** "" (delete) when nothing but our rule is left; user text added to the
 *  file survives with just our section cut out. */
export function withoutOwnedBrief(content: string): string {
  const rest = withoutBriefSection(content);
  return rest.replace(new RegExp(`^${ALWAYS_ON}?`), "").trim() ? rest : "";
}
