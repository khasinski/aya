// Composer assistance in the Conversation GUI: the suggested next prompt, the
// context-window meter and the skills picker. Pure helpers; ComposerAssist.tsx wires them.

export type GuiAssistAgent = "codex" | "claude" | "pi" | "antigravity";
export interface GuiSkill { name: string; description: string; argumentHint?: string }
export interface GuiContextUsage { usedTokens: number; maxTokens: number | null }
export interface SkillQuery { start: number; end: number; query: string }

/** Only Claude (native) and Codex (sampled) can predict the next prompt; only they list skills. */
export function assistSupported(agent: GuiAssistAgent): boolean {
  return agent === "claude" || agent === "codex";
}

/** Suggestions are on unless the user turned them off ("0"). */
export function parseSuggestionsPreference(stored: string | null | undefined): boolean {
  return stored !== "0";
}

export function contextUsageFromParams(params: Record<string, unknown>): GuiContextUsage | null {
  const used = params.usedTokens, max = params.maxTokens;
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0) return null;
  return { usedTokens: Math.round(used), maxTokens: typeof max === "number" && Number.isFinite(max) && max > 0 ? Math.round(max) : null };
}

/** The meter's short label and its tooltip. Without a known window it shows tokens only. */
export function contextMeterText(usage: GuiContextUsage): { label: string; title: string; percent: number | null } {
  const tokens = (value: number) => value.toLocaleString("en-US");
  const short = (value: number) => value >= 1_000_000 ? `${+(value / 1_000_000).toFixed(1)}M` : value >= 1000 ? `${Math.round(value / 1000)}k` : String(value);
  if (!usage.maxTokens) return { label: `${short(usage.usedTokens)} tokens`, title: `Context: ${tokens(usage.usedTokens)} tokens used`, percent: null };
  const percent = Math.min(100, Math.round((usage.usedTokens / usage.maxTokens) * 100));
  return { label: `${percent}%`, title: `Context: ${tokens(usage.usedTokens)} of ${tokens(usage.maxTokens)} tokens (${percent}%)`, percent };
}

/** A `$name` being typed at the caret opens the skills picker. */
export function skillQueryAt(prompt: string, caret: number): SkillQuery | null {
  const before = prompt.slice(0, caret);
  const match = /(?:^|\s)\$([\w:.-]*)$/.exec(before);
  if (!match) return null;
  const query = match[1];
  return { start: caret - query.length - 1, end: caret, query };
}

/** Prefix matches first, then names containing the text, then (unless namesOnly) descriptions. */
export function filterSkills(skills: GuiSkill[], query: string, limit = 8, namesOnly = false): GuiSkill[] {
  const q = query.toLowerCase();
  const rank = (skill: GuiSkill) => {
    const name = skill.name.toLowerCase();
    return name.startsWith(q) || name.split(":").pop()!.startsWith(q) ? 0 : name.includes(q) ? 1 : skill.description.toLowerCase().includes(q) ? 2 : 3;
  };
  return skills.map(skill => ({ skill, rank: rank(skill) })).filter(entry => entry.rank < (namesOnly ? 2 : 3))
    .sort((a, b) => a.rank - b.rank || a.skill.name.localeCompare(b.skill.name)).slice(0, limit).map(entry => entry.skill);
}

/** What a key does while the skills picker is open. Tab takes the highlighted skill; Enter takes it only once the user
 *  moved through the list with the arrows, so a message that merely contains `$word` (`why is $PATH empty`) still sends. */
export function skillPickerKey(key: string, shift: boolean, navigated: boolean): "move" | "pick" | "dismiss" | null {
  if (key === "ArrowDown" || key === "ArrowUp") return "move";
  if (key === "Tab" && !shift) return "pick";
  if (key === "Enter" && !shift && navigated) return "pick";
  if (key === "Escape") return "dismiss";
  return null;
}

/** The text the agent understands as a skill: Codex reads `$name` anywhere; Claude runs `/name` only at the start of the message. */
export function insertSkill(agent: GuiAssistAgent, prompt: string, at: SkillQuery | null, name: string): { prompt: string; caret: number } {
  const start = at ? at.start : 0, end = at ? at.end : prompt.length;
  if (agent === "claude") {
    const rest = (prompt.slice(0, start) + prompt.slice(end)).replace(/^\/\S*\s*/, "").trim();
    const head = `/${name} `;
    return { prompt: head + rest, caret: head.length + rest.length };
  }
  const head = prompt.slice(0, start) + `$${name} `;
  return { prompt: head + prompt.slice(end).replace(/^ /, ""), caret: head.length };
}

/** Claude skills are typed as `/name`, which Aya would otherwise run as a GUI command. A GUI command of the same name wins. */
export function isSkillInvocation(agent: GuiAssistAgent, text: string, skills: GuiSkill[], commands: { name: string }[] = []): boolean {
  if (agent !== "claude" || !text.startsWith("/")) return false;
  const name = text.slice(1).split(/\s/)[0];
  return !commands.some(command => command.name === name) && skills.some(skill => skill.name === name);
}
