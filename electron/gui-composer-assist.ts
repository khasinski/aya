// Composer assistance for the Conversation GUI: the predicted next prompt, the
// context-window meter and the skills list, normalised from each agent's protocol.

export interface GuiSkill { name: string; description: string; argumentHint?: string }
export interface GuiContextUsage { usedTokens: number; maxTokens: number | null }

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null);

// Adapted from T3 Code (MIT, https://github.com/pingdotgg/t3code), CodexAdapterV2's
// CODEX_PROMPT_SUGGESTION_PROMPT: Codex has no native suggestion, so Aya samples one.
export const CODEX_PROMPT_SUGGESTION_PROMPT =
  'Predict the next message the user will send in this conversation. Reply with only that message, written as the user would type it, in under 20 words. Do not use tools. If there is no clear next step, reply with nothing.';

/** A suggestion fills an empty composer: one short line, never a delegated-task echo. */
export function cleanPromptSuggestion(value: unknown): string {
  const line = text(value).trim().replace(/^["“](.*)["”]$/s, '$1').replace(/\s+/g, ' ').trim();
  if (!line || line.length > 500 || /^delegated task/i.test(line)) return '';
  return line;
}

/** Claude lists skills and custom commands with its own built-ins; only user, project, plugin and MCP rows are skills to pick. */
export function claudeSkills(commands: unknown): GuiSkill[] {
  const seen = new Set<string>();
  const skills: GuiSkill[] = [];
  for (const raw of Array.isArray(commands) ? commands : []) {
    const command = object(raw);
    const name = text(command.name).replace(/^\//, '');
    if (!name || command.builtin === true || seen.has(name)) continue;
    seen.add(name);
    skills.push({ name, description: text(command.description).replace(/\s*\(claude\.ai sync\)$/, ''), ...(text(command.argumentHint) ? { argumentHint: text(command.argumentHint) } : {}) });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/** Codex `skills/list` answers per working directory; disabled skills cannot be invoked. */
export function codexSkills(response: unknown): GuiSkill[] {
  const seen = new Set<string>();
  const skills: GuiSkill[] = [];
  for (const entry of Array.isArray(object(response).data) ? object(response).data as unknown[] : []) {
    for (const raw of Array.isArray(object(entry).skills) ? object(entry).skills as unknown[] : []) {
      const skill = object(raw);
      const name = text(skill.name);
      if (!name || skill.enabled === false || seen.has(name)) continue;
      seen.add(name);
      skills.push({ name, description: text(object(skill.interface).shortDescription) || text(skill.shortDescription) || text(skill.description) });
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/** Claude's `get_context_usage` control response. */
export function claudeContextUsage(response: unknown): GuiContextUsage | null {
  const usage = object(response);
  const usedTokens = count(usage.totalTokens);
  if (usedTokens === null) return null;
  return { usedTokens, maxTokens: count(usage.maxTokens) || null };
}

/** Codex `thread/tokenUsage/updated`: the last request's total is what the context holds now. */
export function codexContextUsage(params: unknown): GuiContextUsage | null {
  const usage = object(object(params).tokenUsage);
  const usedTokens = count(object(usage.last).totalTokens);
  if (usedTokens === null) return null;
  return { usedTokens, maxTokens: count(usage.modelContextWindow) || null };
}
