import { effectiveAutoResume, inferAgent } from "../../agentPreset";
import { uuid } from "../../uuid";
import { presetSlug, type Preset, type Snippet } from "../../types";

export const DEFAULT_CLAUDE_CONFIG_DIR = "~/.claude";
export const DEFAULT_CODEX_CONFIG_DIR = "~/.codex";

export interface DraftPreset extends Preset {
  __key: string;
}

export function toDraft(p: Preset): DraftPreset {
  const agent = p.agent ?? inferAgent(p);
  return {
    ...p,
    agent,
    configDir: p.configDir ?? inferConfigDir(p.command, agent),
    unsafeMode: p.unsafeMode ?? inferUnsafeMode(p.command, agent),
    // Same default the runtime uses, so the toggle the user sees matches the
    // flag the spawn actually applies (single source: effectiveAutoResume).
    autoResume: effectiveAutoResume(p),
    __key: uuid(),
  };
}

export function fromDraft(p: DraftPreset): Preset {
  const id = p.id.trim() || presetSlug(p.name);
  const themeId = p.themeId && p.themeId.trim() ? p.themeId : undefined;
  const agent = p.agent;
  const configDir =
    p.configDir && p.configDir.trim() ? p.configDir.trim() : undefined;
  return {
    id,
    name: p.name,
    icon: p.icon,
    color: p.color,
    command: p.command,
    ...(agent ? { agent } : {}),
    ...(configDir ? { configDir } : {}),
    ...(p.unsafeMode ? { unsafeMode: true } : {}),
    // Persist autoResume explicitly (incl. false) so a deliberate opt-out
    // survives - absence is treated as "default on" for agent presets.
    ...(typeof p.autoResume === "boolean" ? { autoResume: p.autoResume } : {}),
    ...(p.agentBrief ? { agentBrief: true } : {}),
    ...(p.interfaceMode === "gui" ? { interfaceMode: "gui" as const } : {}),
    ...(themeId ? { themeId } : {}),
  };
}

export function inferConfigDir(command: string, agent: Preset["agent"]): string | undefined {
  const key =
    agent === "claude"
      ? "CLAUDE_CONFIG_DIR"
      : agent === "codex"
        ? "CODEX_HOME"
        : null;
  if (!key) return undefined;
  const value = command.match(new RegExp(`(?:^|\\s)${key}=("[^"]*"|'[^']*'|\\S+)`))?.[1];
  if (!value) return undefined;
  const unquoted = value.replace(/^"|"$/g, "").replace(/^'|'$/g, "");
  return unquoted.replace(/^\$HOME(?=\/|$)/, "~");
}

export function inferUnsafeMode(command: string, agent: Preset["agent"]): boolean {
  if (agent === "claude") {
    return /\s--dangerously-skip-permissions(?:\s|$)/.test(` ${command} `);
  }
  if (agent === "codex") {
    return /\s(?:--dangerously-bypass-approvals-and-sandbox|--yolo)(?:\s|$)/.test(
      ` ${command} `,
    );
  }
  return false;
}

export function quoteEnv(value: string): string {
  const trimmed = value.trim();
  if (/^~(?=\/|$)/.test(trimmed)) {
    const suffix = trimmed.slice(1).replace(/(["\\$`])/g, "\\$1");
    return `"$HOME${suffix}"`;
  }
  return `"${trimmed.replace(/(["\\$`])/g, "\\$1")}"`;
}

export function isDefaultAgentConfigDir(
  agent: Preset["agent"],
  configDir: string | undefined,
): boolean {
  const trimmed = configDir?.trim();
  if (!trimmed) return true;
  if (agent === "claude") {
    return trimmed === DEFAULT_CLAUDE_CONFIG_DIR || trimmed === "$HOME/.claude";
  }
  if (agent === "codex") {
    return trimmed === DEFAULT_CODEX_CONFIG_DIR || trimmed === "$HOME/.codex";
  }
  return false;
}

export function agentCommand(
  agent: Preset["agent"],
  configDir: string | undefined,
  unsafeMode: boolean | undefined,
): string {
  if (agent === "claude") {
    const base = configDir?.trim() && !isDefaultAgentConfigDir(agent, configDir)
      ? `CLAUDE_CONFIG_DIR=${quoteEnv(configDir)} claude`
      : "claude";
    return unsafeMode ? `${base} --dangerously-skip-permissions` : base;
  }
  if (agent === "codex") {
    const base = configDir?.trim() && !isDefaultAgentConfigDir(agent, configDir)
      ? `CODEX_HOME=${quoteEnv(configDir)} codex`
      : "codex";
    return unsafeMode ? `${base} --dangerously-bypass-approvals-and-sandbox` : base;
  }
  return "";
}

export interface DraftSnippet extends Snippet {
  __key: string;
}

export function snippetToDraft(c: Snippet): DraftSnippet {
  return { ...c, __key: uuid() };
}

export function snippetFromDraft(c: DraftSnippet): Snippet {
  return {
    id: c.id.trim() || presetSlug(c.name || c.text),
    name: c.name,
    text: c.text,
    autoRun: c.autoRun,
  };
}
