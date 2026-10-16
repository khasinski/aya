// Read-only state explanation: one fresh applied host snapshot, evaluated in main.
import type { VtSnapshot } from "./vt-mirror";
import { snapshotBusy, snapshotHold, snapshotStatus } from "./vt-state";
import { evaluateScreenEvidence, matchingScreenRule, type ScreenRuleMatch } from "./agent-screen-rules";
import { builtinScreenRules, HOLD_RULES_UNAVAILABLE } from "./screen-rule-provider";
import { HOLD_ACCOUNT_SETTING, HOLD_APPROVAL, HOLD_APPROVE_AYA, HOLD_CHOICE, HOLD_DRAFT, HOLD_RECOVERY_UNKNOWN, HOLD_SHELL, HOLD_STARTING, HOLD_USAGE_LIMIT } from "./pane-holds";
export interface PaneStateResult {
  state: "unknown" | "stopped" | "starting" | "waiting" | "busy" | "held" | "idle" | "shell";
  hold: string | null; busy: boolean; waiting: boolean | null; generation: string | null;
  rules: { available: boolean; version?: string; digest?: string; reason?: string };
  evidence: { for: "waiting" | "hold" | "busy"; match?: ScreenRuleMatch; policy?: string; source?: string }[];
}
function ruleMetadata(): PaneStateResult["rules"] {
  const r = builtinScreenRules.get();
  return r.available ? { available: true, version: r.rules.version, digest: r.rules.digest } : { available: false, reason: r.reason };
}
export function unavailablePaneState(reason: string, state: "unknown" | "stopped" | "starting" = "unknown"): PaneStateResult {
  return { state, hold: reason, busy: false, waiting: null, generation: null, rules: ruleMetadata(), evidence: [{ for: "hold", policy: state, source: "pty-host-client" }] };
}
export function explainPaneSnapshot(snapshot: VtSnapshot): PaneStateResult {
  const hold = snapshotHold(snapshot).hold, busy = snapshotBusy(snapshot), status = snapshotStatus(snapshot), rules = ruleMetadata();
  const unknown = snapshot.recoveryUnknown || !rules.available;
  const state = snapshot.shell ? "shell" : unknown ? "unknown" : status.waiting ? "waiting" : busy ? "busy" : hold ? "held" : "idle";
  const evidence: PaneStateResult["evidence"] = [];
  if (!unknown && !snapshot.shell) {
    const decision = evaluateScreenEvidence(snapshot.rows, snapshot.agent);
    if (decision.match && (status.waiting === (decision.verdict === "waiting"))) evidence.push({ for: "waiting", match: decision.match });
    else if (status.waiting) evidence.push({ for: "waiting", policy: "numbered-choice" });
    if (busy) { const match = matchingScreenRule(snapshot.rows, snapshot.agent, "busy"); if (match) evidence.push({ for: "busy", match }); }
    if (hold === HOLD_ACCOUNT_SETTING || hold === HOLD_USAGE_LIMIT) {
      const match = matchingScreenRule(snapshot.rows, snapshot.agent, hold === HOLD_ACCOUNT_SETTING ? "account-setting" : "usage-limit");
      if (match) evidence.push({ for: "hold", match });
    } else if (hold === HOLD_APPROVAL) {
      if (decision.match) evidence.push({ for: "hold", match: decision.match });
    }
  }
  if (hold && !evidence.some(e => e.for === "hold")) {
    const policies = new Map([[HOLD_SHELL,"shell"],[HOLD_STARTING,"starting"],[HOLD_DRAFT,"draft"],[HOLD_CHOICE,"numbered-choice"],[HOLD_APPROVE_AYA,"approve-aya"],[HOLD_RECOVERY_UNKNOWN,"recovery-screen-unknown"],[HOLD_RULES_UNAVAILABLE,"rules-unavailable"]]);
    evidence.push({for:"hold",policy:policies.get(hold) ?? "pane-hold"});
  }
  return { state, hold, busy, waiting: status.waiting, generation: snapshot.generation, rules, evidence };
}
export function formatPaneState(name: string, result: PaneStateResult, explain: boolean): string {
  const lines = [`${name}: ${result.state}; busy: ${result.busy ? "yes" : "no"}; hold: ${result.hold ?? "none"}`];
  if (!result.rules.available) lines.push(`rules unavailable: ${result.rules.reason}`);
  if (explain) {
    if (result.rules.available) lines.push(`rules: ${result.rules.version} (${result.rules.digest})`);
    if (result.evidence.length === 0) lines.push("No rule matched.");
    for (const e of result.evidence) {
      if (e.match) lines.push(`${e.for} rule: ${e.match.id} (${e.match.kind})`,`source: ${e.match.source}; rules: ${e.match.version} (${e.match.digest})`,`region: ${e.match.region}`,`excerpt: ${e.match.excerpt}`);
      else lines.push(`${e.for}: policy:${e.policy}; source: ${e.source ?? "vt-state"}; no data rule matched for this decision`);
    }
  }
  return lines.join("\n")+"\n";
}
