// Per-agent screen rules. SUPPRESSORS are screens showing an approval-looking string while nothing is asked (a
// scrolled-back transcript); one that matches wins over any prompt (dialogs are read first), and regions keep a
// prompt near the cursor.

import type { AgentKind } from "./presets";

/** Which part of the screen a rule reads: the last TAIL_REGION_LINES non-empty rows, the last non-empty row, or all. */
export type ScreenRegion = "tail" | "lastLine" | "screen";

export interface ScreenRule {
  id: string;
  /** A dialog is a prompt drawn over a composer that is still on screen, so it is read before the suppressors. */
  kind: "prompt" | "suppressor" | "dialog";
  region: ScreenRegion;
  pattern: RegExp;
}

/** Wide enough for a multi-line approval box, narrow enough that a prompt scrolled well above the cursor no longer counts. */
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
  // A line prompt may end in a colon: "Set up a provider now? [Y/n]: " (hermes v0.21.5, recorded).
  { id: "yn-suffix", kind: "prompt", region: "lastLine", pattern: /\[y\/n\]:?\s*$/i },
  { id: "yN-suffix", kind: "prompt", region: "lastLine", pattern: /\(y\/N\):?\s*$/i },
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

// Rows a composer may have below it (model line, footer): any that do not end in a question.
const NOT_A_QUESTION = String.raw`(?![^\n]*(?:\?|\[y\/n\]|\(y\/N\))\s*$)`;
const trailing = (max: number): string => String.raw`(?:\n${NOT_A_QUESTION}[^\n]*){0,${max}}$`;

const CLAUDE_RULES: readonly ScreenRule[] = [
  ...GENERIC_RULES,
  {
    // Claude's trust check and pickers (/model) have a plain footer and an unnumbered selection: matched before the
    // selected row reads as a draft, or a composer drawn above clears the screen.
    id: "claude-trust-confirmation",
    kind: "dialog",
    region: "tail",
    pattern: /Enter\s+to\s+confirm\s*[·•]\s*Esc\s+to\s+(?:cancel|exit)/i,
  },
  {
    // Scrolling the transcript replays past prompts verbatim. Claude marks
    // that view, so the marker is a reliable "you are reading history".
    id: "transcript-view",
    kind: "suppressor",
    region: "screen",
    pattern: /(?:showing|viewing)\s+(?:full\s+)?transcript|ctrl\+r to (?:expand|toggle)/i,
  },
  {
    // A ruled composer ending the screen, up to three rows under it (mode row, statusLine), means no dialog is up
    // (a recorded dialog replaces it); question wording above is the agent's own answer.
    id: "composer-drawn",
    kind: "suppressor",
    region: "tail",
    pattern: new RegExp(String.raw`(?:^|\n)\s*─{8,}\n(?:\s*❯(?!\s*\d+[.)])[^\n]*\n)?\s*─{8,}` + trailing(3)),
  },
  {
    // The composer hint line is always on screen while the agent is idle and
    // simply waiting for the NEXT instruction - not blocked on a decision.
    id: "composer-hint",
    kind: "suppressor",
    region: "lastLine",
    pattern: /\?\s*for shortcuts/i,
  },
];

const CODEX_RULES: readonly ScreenRule[] = [
  ...GENERIC_RULES,
  {
    // Codex's approval replaces its composer (recorded 0.158/0.159), so a `›` composer row, not a
    // numbered option, with only its model line and footer below means nothing is asked.
    id: "codex-composer-drawn",
    kind: "suppressor",
    region: "tail",
    pattern: new RegExp(String.raw`(?:^|\n)\s*›(?!\s*\d+[.)])[^\n]*` + trailing(2)),
  },
  {
    id: "codex-composer-hint",
    kind: "suppressor",
    region: "lastLine",
    pattern: /send\s+.*\bctrl\b.*\bnewline\b|\bEsc\b.*\binterrupt\b/i,
  },
];

const OPENCODE_RULES: readonly ScreenRule[] = [
  ...GENERIC_RULES,
  {
    // Its update box ("Update Available ... update now?") is drawn over the composer, whose bar stays on
    // screen under it, with Confirm focused (1.18.30, tests/fixtures/own-screens/opencode-idle).
    id: "opencode-dialog-buttons",
    kind: "dialog",
    region: "tail",
    pattern: /^\s*Skip\s+Confirm\s*$/m,
  },
  {
    // OpenCode's question dialog, which the plan agent asks its approval with, ends in this
    // footer (real capture, tests/fixtures/opencode-plan-question.screen.txt).
    id: "opencode-question",
    kind: "prompt",
    region: "tail",
    pattern: /enter submit\s+esc dismiss/i,
  },
  {
    // Its permission dialog (recorded at 80 and 134 columns, tests/fixtures/opencode-permission-*):
    // the button row, which replaces the composer like the question dialog.
    id: "opencode-permission",
    kind: "prompt",
    region: "tail",
    pattern: /Allow once\s+Allow always\s+Reject/,
  },
  {
    // The question dialog replaces the composer (recorded); its "Build · <model>" row above the ╹ edge with the status
    // row ending the screen means nothing is asked. A permission dialog is not recorded.
    id: "opencode-composer-drawn",
    kind: "suppressor",
    region: "tail",
    pattern: new RegExp(String.raw`(?:^|\n)\s*┃\s+[A-Z][\w-]*\s+·\s+\S[^\n]*\n\s*╹▀{8,}[^\n]*` + trailing(1)),
  },
];

// agy 1.2.14 (tests/fixtures/own-screens/agy-*): its trust dialog, "/" palette and model picker end in a
// navigation hint. Its idle composer is read in vt-state (only that screen takes a message).
const ANTIGRAVITY_RULES: readonly ScreenRule[] = [
  ...GENERIC_RULES,
  { id: "antigravity-select", kind: "prompt", region: "tail", pattern: /↑\/↓ Navigate\s*·\s*enter (?:Confirm|Select)|enter Select\s+esc Go Back/ },
];

const GROK_RULES: readonly ScreenRule[] = [
  ...GENERIC_RULES,
  {
    // Its permission prompt, worded as the grok 1.0.46 binary words it (permission/prompter.rs, acp_handler):
    // not recorded, so read before the composer, wherever it is drawn.
    id: "grok-permission",
    kind: "dialog",
    region: "tail",
    pattern: /\bYes, (?:allow once|allow all edits|always allow|and don't ask again|proceed|send once)\b|\bNo, and (?:tell Grok|don't ask again)\b|^\s*Allow(?: Edit| Delete| Execute)?\?\s*$/m,
  },
  {
    // The box (recorded in always-approve; other modes only change its label) closed, then the footer.
    // An overlay (palette, ctrl+x) hides the footer.
    id: "grok-composer-drawn",
    kind: "suppressor",
    region: "tail",
    pattern: /\n\s*│[^\n]*│\n\s*╰─+[^\n]*─╯\n[^\n]*(?:Shift\+Tab:mod|Ctrl\+x:shortcuts|Ctrl\+c:cancel)[^\n]*$/,
  },
];

/** What each CLI draws while it works: the composer stays empty then, so the hold check
 *  reads it as free (captures: tests/fixtures/busy-*, own-screens/grok-busy). */
const BUSY_RULES: Partial<Record<AgentKind, readonly Omit<ScreenRule, "kind">[]>> = {
  claude: [
    { id: "claude-busy", region: "lastLine", pattern: /\besc to interrupt\b/i },
    // The spinner row ("✽ Generating…", "✻ Compacting conversation…") outlasts a footer that a narrow pane cuts off;
    // a finished turn reads "✻ Crunched for 15s", with no ellipsis. Glyphs: ✻ and ✽ are captured, the rest of the frames are not.
    { id: "claude-spinner", region: "tail", pattern: /^\s*[✢✳✶✻✽]\s+[^\n…]{2,60}…(?:\s*\(.*\))?\s*$/m },
  ],
  codex: [{ id: "codex-busy", region: "tail", pattern: /^\s*\S\s+Working \(.*\besc to interrupt\)/im }],
  opencode: [{ id: "opencode-busy", region: "tail", pattern: /\besc interrupt\b/i }],
  antigravity: [{ id: "antigravity-busy", region: "tail", pattern: /^\s*\S\s+Generating\.\.\./m }],
  // Grok 1.0.46: a braille spinner row ending in "[stop]" right above the composer box, and "Ctrl+c:cancel" in the
  // hint row that ends the screen. Either alone: an overlay hides the hint row, the spinner row comes a moment later.
  grok: [
    { id: "grok-spinner", region: "tail", pattern: /^\s*[⠀-⣿]\s+\S[^\n]*\[stop\]\s*\n\s*╭─/m },
    { id: "grok-cancel-hint", region: "lastLine", pattern: /\bCtrl\+c:cancel\b/ },
  ],
};

const RULES_BY_AGENT: Partial<Record<AgentKind, readonly ScreenRule[]>> = {
  claude: CLAUDE_RULES,
  codex: CODEX_RULES,
  opencode: OPENCODE_RULES,
  grok: GROK_RULES,
  antigravity: ANTIGRAVITY_RULES,
};

export function rulesForAgent(agent: AgentKind | undefined): readonly ScreenRule[] {
  return (agent && RULES_BY_AGENT[agent]) || GENERIC_RULES;
}

function regionText(rows: readonly string[], region: ScreenRegion): string {
  const nonEmpty = rows.filter((row) => row.trim());
  if (region === "screen") return nonEmpty.join("\n");
  if (region === "lastLine") return nonEmpty[nonEmpty.length - 1] ?? "";
  return nonEmpty.slice(-TAIL_REGION_LINES).join("\n");
}

// The `aya` subcommands (bin/aya, held equal by a test); not preceded by a path or word, so "cd ~/aya" is not one.
const AYA_COMMAND = /(?:^|[^\w./-])aya\s+(?:open|project|focus|debug|notify|remote|status|pane|team|presets|capabilities|machines)\b/;

export function asksToRunAya(rows: readonly string[]): boolean {
  return AYA_COMMAND.test(regionText(rows, "tail"));
}

// Dialogs first (drawn over a composer that is still on screen), then suppressors, which win over any prompt.
const VERDICT_ORDER = [["dialog", "waiting"], ["suppressor", "clear"], ["prompt", "waiting"]] as const;

/** "waiting" when a prompt is up, "clear" when not blocked, null (an empty screen) for no opinion. */
export function evaluateScreen(
  rows: readonly string[],
  agent: AgentKind | undefined,
): "waiting" | "clear" | null {
  if (rows.length === 0) return null;
  const rules = rulesForAgent(agent);
  for (const [kind, verdict] of VERDICT_ORDER) {
    if (rules.some((rule) => rule.kind === kind && rule.pattern.test(regionText(rows, rule.region)))) return verdict;
  }
  return "clear";
}

// What a CLI's dialog says when its account ran out. codex-cli 0.159.3 is recorded (own-screens/codex-credits);
// Claude's and Grok's are not: add theirs here once one is recorded, never a guessed text.
const USAGE_LIMIT_RULES: Partial<Record<AgentKind, RegExp>> = {
  codex: /\bYour workspace is out of credits\b|\bUsage limit reached\b/,
};

export function screenShowsUsageLimit(rows: readonly string[], agent: AgentKind | undefined): boolean {
  const rule = agent && USAGE_LIMIT_RULES[agent];
  return !!rule && rule.test(regionText(rows, "tail"));
}

export function screenIsBusy(rows: readonly string[], agent: AgentKind | undefined): boolean {
  const rules = agent && BUSY_RULES[agent];
  return !!rules && rules.some((rule) => rule.pattern.test(regionText(rows, rule.region)));
}
