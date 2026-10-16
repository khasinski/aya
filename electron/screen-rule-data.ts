// Main-only bundled data loader. No host import, user file discovery or reload.
import { createHash } from "node:crypto";
import { readSync, openSync, fstatSync, closeSync, constants } from "node:fs";
import * as path from "node:path";
import { TextDecoder } from "node:util";
export const MAX_RULE_FILE_BYTES = 64 * 1024;
export const RULE_AGENTS = ["generic", "claude", "codex", "opencode", "grok", "antigravity"] as const;
export type RuleAgent = typeof RULE_AGENTS[number];
export type RuleKind = "prompt" | "suppressor" | "dialog" | "busy" | "usage-limit" | "account-setting";
export type ScreenRegion = "tail" | "lastLine" | "screen";
export interface DataScreenRule {
  readonly id: string; readonly kind: RuleKind; readonly region: ScreenRegion;
  readonly pattern: RegExp; readonly source: string;
}
export interface ScreenRuleSet {
  readonly version: string; readonly digest: string;
  readonly sets: Readonly<Record<RuleAgent, readonly DataScreenRule[]>>;
}
function fail(reason: string): never { throw new Error(`Invalid screen rule data: ${reason}`); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail("object");
  const obj = value as Record<string, unknown>;
  if (Object.keys(obj).length !== keys.length || keys.some(k => !Object.hasOwn(obj, k))) fail("closed fields");
  return obj;
}
// Bound raw input before parsing; detect duplicate decoded keys (including
// escaped spellings). JSON.parse remains the authority on JSON grammar.
function parseRaw(input: Buffer): unknown {
  if (input.length > MAX_RULE_FILE_BYTES) fail("file size");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(input);
  const stack: (Set<string> | null)[] = [];
  let tokens = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "{" || c === "[") { stack.push(c === "{" ? new Set() : null); if (stack.length > 8) fail("depth"); }
    else if (c === "}" || c === "]") stack.pop();
    else if (c === '"') {
      const start = i++; while (i < text.length && text[i] !== '"') { if (text[i] === "\\") i++; i++; }
      const end = i + 1; let next = end; while (/\s/.test(text[next] ?? "") && next < text.length) next++;
      if (text[next] === ":") {
        const key = JSON.parse(text.slice(start, end)) as string, keys = stack.at(-1);
        if (!keys || keys.has(key)) fail("duplicate key"); keys.add(key);
      }
      if (++tokens > 8192) fail("tokens");
    }
  }
  return JSON.parse(text) as unknown;
}
export function parseScreenRules(input: Buffer): ScreenRuleSet {
  const root = object(parseRaw(input), ["schemaVersion", "ruleSetVersion", "sets"]);
  if (root.schemaVersion !== 1 || typeof root.ruleSetVersion !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(root.ruleSetVersion)) fail("version");
  const sets = object(root.sets, RULE_AGENTS);
  let count = 0;
  const ids = new Set<string>();
  const authored = {} as Record<RuleAgent, { id: string; kind: RuleKind; region: ScreenRegion; pattern: string; flags: string; source: string }[]>;
  for (const agent of RULE_AGENTS) {
    const set = object(sets[agent], ["extends", "rules"]);
    if (set.extends !== (agent === "generic" ? null : "generic") || !Array.isArray(set.rules) || set.rules.length > 128) fail("set");
    authored[agent] = set.rules.map(value => {
      const r = object(value, ["id", "kind", "region", "pattern", "flags"]);
      if (++count > 256 || typeof r.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(r.id) || ids.has(r.id)) fail("rule id/count");
      ids.add(r.id);
      if (!["prompt", "suppressor", "dialog", "busy", "usage-limit", "account-setting"].includes(r.kind as string) || !["tail", "lastLine", "screen"].includes(r.region as string)) fail("kind/region");
      if (typeof r.pattern !== "string" || typeof r.flags !== "string") fail("pattern/flags");
      if ((r.pattern as string).length === 0 || (r.pattern as string).length > 2048) fail("pattern length");
      const flags = r.flags as string;
      if (!/^[imu]*$/.test(flags) || new Set(flags).size !== flags.length) fail("flags");
      return { id: r.id as string, kind: r.kind as RuleKind, region: r.region as ScreenRegion, pattern: r.pattern as string, flags: r.flags as string, source: `builtin/${agent}` };
    });
  }
  // No RegExp construction until the entire set passes the closed schema. These bundled patterns are trusted like the TS they replace.
  // No static-complexity lint is a production safety boundary; PR2 must use a killable worker.
  const compiled = {} as Record<RuleAgent, readonly DataScreenRule[]>;
  for (const agent of RULE_AGENTS) {
    const rules = [...(agent === "generic" ? [] : authored.generic), ...authored[agent]];
    if (rules.length > 128) fail("expanded rule count");
    compiled[agent] = Object.freeze(rules.map(r => Object.freeze({ id: r.id, kind: r.kind, region: r.region, source: r.source, pattern: Object.freeze(new RegExp(r.pattern, r.flags)) })));
  }
  return Object.freeze({ version: root.ruleSetVersion as string, digest: createHash("sha256").update(input).digest("hex"), sets: Object.freeze(compiled) });
}
export function loadScreenRulesFile(file: string, io = { openSync, fstatSync, readSync, closeSync }): ScreenRuleSet {
  const fd = io.openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = io.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_RULE_FILE_BYTES) fail("file type/size");
    const bytes = Buffer.alloc(MAX_RULE_FILE_BYTES + 1);
    let size = 0, count = 0;
    do { count = io.readSync(fd, bytes, size, bytes.length - size, null); size += count; } while (count && size < bytes.length);
    if (size > MAX_RULE_FILE_BYTES) fail("file size");
    return parseScreenRules(bytes.subarray(0, size));
  } finally { io.closeSync(fd); }
}

export function loadBundledScreenRules(): ScreenRuleSet {
  return loadScreenRulesFile(path.join(__dirname, "screen-rules", "builtin.json"));
}
