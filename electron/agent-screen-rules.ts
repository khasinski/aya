// Per-agent rules for reading a pane's rendered screen.
//
// A single list of prompt patterns for every agent has one structural problem:
// it can only say "this text is somewhere on screen". It cannot say "…but not
// while the user is scrolling back through the transcript", which is exactly
// where a generic matcher produces false approvals — the history contains old
// prompts, verbatim.
//
// So a rule set is prompt rules plus SUPPRESSOR rules. A suppressor that
// matches means "whatever else you see, this pane is not asking for anything
// right now" and wins outright. Anchoring a rule to a screen region does the
// rest: an approval box is always near the cursor, never twenty rows up.

import type { AgentKind } from "./presets";

/** Which part of the rendered screen a rule looks at.
 *  - `tail`: the last N non-empty rows — where a live prompt lives.
 *  - `lastLine`: only the final non-empty row, for prompts that end a line.
 *  - `screen`: everything currently visible. */
export type ScreenRegion = "tail" | "lastLine" | "screen";

export interface ScreenRule {
  id: string;
  kind: "prompt" | "suppressor";
  region: ScreenRegion;
  pattern: RegExp;
}

/** How many trailing rows the `tail` region covers. Wide enough for a
 *  multi-line approval box, narrow enough that a prompt scrolled well above
 *  the cursor no longer counts. */
export const TAIL_REGION_LINES = 12;

/** Applies to any agent without its own rules. Deliberately the same shape as
 *  the pre-per-agent behaviour, so an unknown CLI is no worse off than before. */
const GENERIC_RULES: readonly ScreenRule[] = [
  { id: "do-you-want", kind: "prompt", region: "tail", pattern: /Do you want (?:to|me to)/i },
  { id: "numbered-yes", kind: "prompt", region: "tail", pattern: /❯\s*1\.\s*Yes/i },
  { id: "yes-and-dont", kind: "prompt", region: "tail", pattern: /1\)\s*Yes,\s*and don't/i },
  {
    id: "approve-action",
    kind: "prompt",
    region: "tail",
    pattern: /Approve\s*(?:this\s+)?(?:edit|change|action|tool|command)/i,
  },
  { id: "accept-reject", kind: "prompt", region: "tail", pattern: /\bAccept all\b.*\bReject all\b/i },
  { id: "run-command", kind: "prompt", region: "tail", pattern: /Run this command\?\s*\[Y\/N\]/i },
  { id: "yn-suffix", kind: "prompt", region: "lastLine", pattern: /\[y\/n\]\s*$/i },
  { id: "yN-suffix", kind: "prompt", region: "lastLine", pattern: /\(y\/N\)\s*$/i },
  { id: "allow-question", kind: "prompt", region: "lastLine", pattern: /\b(?:Allow|Permit)\b.*\?\s*$/i },
  {
    id: "press-enter",
    kind: "prompt",
    region: "tail",
    pattern: /Press\s+enter\s+to\s+(?:continue|confirm)/i,
  },
  {
    id: "waiting-for-input",
    kind: "prompt",
    region: "tail",
    pattern: /Waiting for (?:your )?(?:input|approval|confirmation)/i,
  },
];

/** Rules that stop a pane being read as blocked. These are what per-agent
 *  knowledge actually buys: each one encodes a screen the agent shows where an
 *  approval-looking string is present but nothing is being asked. */
const CLAUDE_RULES: readonly ScreenRule[] = [
  ...GENERIC_RULES,
  {
    // Scrolling the transcript replays past prompts verbatim. Claude marks
    // that view, so the marker is a reliable "you are reading history".
    id: "transcript-view",
    kind: "suppressor",
    region: "screen",
    pattern: /(?:showing|viewing)\s+(?:full\s+)?transcript|ctrl\+r to (?:expand|toggle)/i,
  },
  {
    // The composer hint line is always on screen while the agent is idle and
    // simply waiting for the NEXT instruction — not blocked on a decision.
    id: "composer-hint",
    kind: "suppressor",
    region: "lastLine",
    pattern: /\?\s*for shortcuts/i,
  },
];

const CODEX_RULES: readonly ScreenRule[] = [
  ...GENERIC_RULES,
  {
    id: "codex-composer-hint",
    kind: "suppressor",
    region: "lastLine",
    pattern: /send\s+.*\bctrl\b.*\bnewline\b|\bEsc\b.*\binterrupt\b/i,
  },
];

const RULES_BY_AGENT: Partial<Record<AgentKind, readonly ScreenRule[]>> = {
  claude: CLAUDE_RULES,
  codex: CODEX_RULES,
};

export function rulesForAgent(agent: AgentKind | undefined): readonly ScreenRule[] {
  return (agent && RULES_BY_AGENT[agent]) || GENERIC_RULES;
}

/** True when this agent has rules of its own rather than the generic set —
 *  used by tests and diagnostics, not by the hot path. */
export function hasAgentRules(agent: AgentKind | undefined): boolean {
  return !!agent && !!RULES_BY_AGENT[agent];
}

function regionText(rows: readonly string[], region: ScreenRegion): string {
  const nonEmpty = rows.filter((row) => row.trim());
  if (region === "screen") return nonEmpty.join("\n");
  if (region === "lastLine") return nonEmpty[nonEmpty.length - 1] ?? "";
  return nonEmpty.slice(-TAIL_REGION_LINES).join("\n");
}

/** What the screen currently says about this pane.
 *  `"waiting"` — a prompt is up. `"clear"` — definitely not blocked.
 *  `null` — no opinion, so the caller should leave the existing state alone
 *  rather than assert a change. */
export function evaluateScreen(
  rows: readonly string[],
  agent: AgentKind | undefined,
): "waiting" | "clear" | null {
  if (rows.length === 0) return null;
  const rules = rulesForAgent(agent);
  // Suppressors are checked first and win outright: they describe a screen we
  // KNOW is not a prompt, so a stray match elsewhere must not override them.
  for (const rule of rules) {
    if (rule.kind !== "suppressor") continue;
    if (rule.pattern.test(regionText(rows, rule.region))) return "clear";
  }
  for (const rule of rules) {
    if (rule.kind !== "prompt") continue;
    if (rule.pattern.test(regionText(rows, rule.region))) return "waiting";
  }
  return "clear";
}
