// Main evaluates bundled rules against the host's applied snapshot. No host import.
import type { AgentKind } from "./presets";
import type { DataScreenRule, RuleKind, RuleAgent, ScreenRegion } from "./screen-rule-data";
import { builtinScreenRules } from "./screen-rule-provider";
export type { ScreenRegion } from "./screen-rule-data";
export type ScreenRule = DataScreenRule;
export const TAIL_REGION_LINES = 12;

function allRules(agent: AgentKind | undefined): readonly DataScreenRule[] {
  const state = builtinScreenRules.get();
  if (!state.available) return [];
  return agent && Object.hasOwn(state.rules.sets, agent) ? state.rules.sets[agent as RuleAgent] : state.rules.sets.generic;
}
export function rulesForAgent(agent: AgentKind | undefined): readonly ScreenRule[] {
  return allRules(agent).filter(r => r.kind === "prompt" || r.kind === "suppressor" || r.kind === "dialog");
}
export function regionText(rows: readonly string[], region: ScreenRegion): string {
  const nonEmpty = rows.filter(row => row.trim());
  if (region === "screen") return nonEmpty.join("\n");
  if (region === "lastLine") return nonEmpty[nonEmpty.length - 1] ?? "";
  return nonEmpty.slice(-TAIL_REGION_LINES).join("\n");
}
export interface ScreenRuleMatch {
  id: string; kind: RuleKind; source: string; version: string; digest: string; region: ScreenRegion; excerpt: string;
}
/** This is terminal output, not escaped JSON: strip complete/incomplete control
 * strings as well as every C0/C1/ESC/bidi code point, then bound the plain text. */
export function screenRuleExcerpt(text: string): string {
  let plain = "";
  // An excerpt needs only the start of a match. Never scan/allocate a full screen here.
  const prefix = text.slice(0, 1024);
  for (let i = 0; i < prefix.length; i++) {
    const c = prefix.charCodeAt(i);
    if (c === 27 || c === 0x9b || [0x90,0x98,0x9d,0x9e,0x9f].includes(c)) {
      const next = c === 27 ? prefix[++i] : c === 0x9b ? "[" : c === 0x9d ? "]" : "P";
      if (next === "[") { while (i + 1 < prefix.length) { const n = prefix.charCodeAt(++i); if (n >= 0x40 && n <= 0x7e) break; } }
      else if (next && "PX]^_".includes(next)) {
        while (++i < prefix.length) {
          if (prefix.charCodeAt(i) === 7 || prefix.charCodeAt(i) === 0x9c) break;
          if (prefix.charCodeAt(i) === 27 && prefix[i + 1] === "\\") { i++; break; }
        }
      } else { while (i < prefix.length && prefix.charCodeAt(i) >= 0x20 && prefix.charCodeAt(i) <= 0x2f) i++; }
      continue;
    }
    plain += prefix[i];
  }
  return [...plain.replace(/[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}\u206a-\u206f]/gu, "").replace(/\s+/gu, " ").trim()].slice(0, 160).join("");
}
export function matchingScreenRule(rows: readonly string[], agent: AgentKind | undefined, kind: RuleKind): ScreenRuleMatch | null {
  const state = builtinScreenRules.get();
  if (!state.available) return null;
  for (const rule of allRules(agent)) {
    if (rule.kind !== kind) continue;
    const match = rule.pattern.exec(regionText(rows, rule.region));
    if (match) return { id: rule.id, kind, source: rule.source, version: state.rules.version, digest: state.rules.digest, region: rule.region, excerpt: screenRuleExcerpt(match[0]) };
  }
  return null;
}
const VERDICT_ORDER = [["dialog", "waiting"], ["suppressor", "clear"], ["prompt", "waiting"]] as const;
export function evaluateScreenEvidence(rows: readonly string[], agent: AgentKind | undefined): { verdict: "waiting" | "clear" | null; match: ScreenRuleMatch | null } {
  if (rows.length === 0 || !builtinScreenRules.get().available) return { verdict: null, match: null };
  for (const [kind, verdict] of VERDICT_ORDER) {
    const match = matchingScreenRule(rows, agent, kind);
    if (match) return { verdict, match };
  }
  return { verdict: "clear", match: null };
}
export function evaluateScreen(rows: readonly string[], agent: AgentKind | undefined): "waiting" | "clear" | null { return evaluateScreenEvidence(rows, agent).verdict; }
const AYA_COMMAND = /(?:^|[^\w./-])aya\s+(?:open|project|focus|debug|notify|remote|status|pane|team|presets|capabilities|machines)\b/;
export function asksToRunAya(rows: readonly string[]): boolean { return AYA_COMMAND.test(regionText(rows, "tail")); }
export function screenOffersAccountSetting(rows: readonly string[], agent: AgentKind | undefined): boolean { return matchingScreenRule(rows, agent, "account-setting") !== null; }
export function screenShowsUsageLimit(rows: readonly string[], agent: AgentKind | undefined): boolean { return matchingScreenRule(rows, agent, "usage-limit") !== null; }
export function screenIsBusy(rows: readonly string[], agent: AgentKind | undefined): boolean { return matchingScreenRule(rows, agent, "busy") !== null; }
