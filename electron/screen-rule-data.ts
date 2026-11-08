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
  /** Each bundled file's own version and digest (empty when the rules are unavailable). */
  readonly files: readonly { readonly agent: RuleAgent; readonly version: string; readonly digest: string }[];
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
export function parseScreenRuleJson(input: Buffer): unknown {
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
/** One bundled per-agent file, validated but not compiled. */
export interface BuiltinRuleFile {
  readonly agent: RuleAgent; readonly version: string; readonly digest: string;
  readonly rules: readonly { id: string; kind: RuleKind; region: ScreenRegion; pattern: string; flags: string; source: string }[];
}
/** `{schemaVersion, ruleSetVersion, agent, rules}`: the same envelope as a user file, one per agent. Generic is
 *  inherited by every other agent, fixed by the loader, not by the file. */
export function parseScreenRuleFile(input: Buffer, agent: RuleAgent): BuiltinRuleFile {
  const root = object(parseScreenRuleJson(input), ["schemaVersion", "ruleSetVersion", "agent", "rules"]);
  if (root.schemaVersion !== 1 || typeof root.ruleSetVersion !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(root.ruleSetVersion)) fail("version");
  if (root.agent !== agent) fail("agent");
  if (!Array.isArray(root.rules) || root.rules.length > 128) fail("set");
  const rules = root.rules.map(value => {
    const r = object(value, ["id", "kind", "region", "pattern", "flags"]);
    if (typeof r.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(r.id)) fail("rule id/count");
    if (!["prompt", "suppressor", "dialog", "busy", "usage-limit", "account-setting"].includes(r.kind as string) || !["tail", "lastLine", "screen"].includes(r.region as string)) fail("kind/region");
    if (typeof r.pattern !== "string" || typeof r.flags !== "string") fail("pattern/flags");
    if ((r.pattern as string).length === 0 || (r.pattern as string).length > 2048) fail("pattern length");
    const flags = r.flags as string;
    if (!/^[imu]*$/.test(flags) || new Set(flags).size !== flags.length) fail("flags");
    return { id: r.id as string, kind: r.kind as RuleKind, region: r.region as ScreenRegion, pattern: r.pattern as string, flags, source: `builtin/${agent}` };
  });
  return Object.freeze({ agent, version: root.ruleSetVersion, digest: createHash("sha256").update(input).digest("hex"), rules: Object.freeze(rules) });
}
/** The bundle's one identity: the files' own version when they agree, else each agent's; the digest covers every
 *  file's bytes in fixed order, so an edit to any one file changes it. */
export function composeScreenRules(files: Readonly<Record<RuleAgent, BuiltinRuleFile>>): ScreenRuleSet {
  const ids = new Set<string>();
  let count = 0;
  for (const agent of RULE_AGENTS) {
    for (const r of files[agent].rules) {
      if (++count > 256 || ids.has(r.id)) fail("rule id/count");
      ids.add(r.id);
    }
  }
  // No RegExp construction until the entire set passes the closed schema. These bundled patterns are trusted like the TS they replace.
  // No static-complexity lint is a production safety boundary; PR2 must use a killable worker.
  const compiled = {} as Record<RuleAgent, readonly DataScreenRule[]>;
  for (const agent of RULE_AGENTS) {
    const rules = [...(agent === "generic" ? [] : files.generic.rules), ...files[agent].rules];
    if (rules.length > 128) fail("expanded rule count");
    compiled[agent] = Object.freeze(rules.map(r => Object.freeze({ id: r.id, kind: r.kind, region: r.region, source: r.source, pattern: Object.freeze(new RegExp(r.pattern, r.flags)) })));
  }
  const versions = new Set(RULE_AGENTS.map(agent => files[agent].version));
  const hash = createHash("sha256").update("builtin-rules-v2\0");
  for (const agent of RULE_AGENTS) hash.update(`${agent}\0${files[agent].digest}\n`);
  return Object.freeze({
    version: versions.size === 1 ? [...versions][0] : RULE_AGENTS.map(agent => `${agent}:${files[agent].version}`).join(","),
    digest: hash.digest("hex"),
    files: Object.freeze(RULE_AGENTS.map(agent => Object.freeze({ agent, version: files[agent].version, digest: files[agent].digest }))),
    sets: Object.freeze(compiled),
  });
}
export function parseScreenRules(inputs: Readonly<Record<RuleAgent, Buffer>>): ScreenRuleSet {
  const files = {} as Record<RuleAgent, BuiltinRuleFile>;
  for (const agent of RULE_AGENTS) files[agent] = parseScreenRuleFile(inputs[agent], agent);
  return composeScreenRules(files);
}
/** One bounded, non-blocking, no-symlink read of a rule file. */
export function readScreenRuleFile(file: string, io = { openSync, fstatSync, readSync, closeSync }): Buffer {
  const fd = io.openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = io.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_RULE_FILE_BYTES) fail("file type/size");
    const bytes = Buffer.alloc(MAX_RULE_FILE_BYTES + 1);
    let size = 0, count = 0;
    do { count = io.readSync(fd, bytes, size, bytes.length - size, null); size += count; } while (count && size < bytes.length);
    if (size > MAX_RULE_FILE_BYTES) fail("file size");
    return bytes.subarray(0, size);
  } finally { io.closeSync(fd); }
}

export function loadBundledScreenRules(directory = path.join(__dirname, "screen-rules")): ScreenRuleSet {
  const inputs = {} as Record<RuleAgent, Buffer>;
  for (const agent of RULE_AGENTS) inputs[agent] = readScreenRuleFile(path.join(directory, `${agent}.json`));
  return parseScreenRules(inputs);
}
