// Main validates data only. User patterns are compiled/evaluated by the worker.
import * as fs from "node:fs";
import * as path from "node:path";
import {createHash} from "node:crypto";
import {MAX_RULE_FILE_BYTES, RULE_AGENTS, parseScreenRuleJson} from "./screen-rule-data";
import type {RuleAgent, RuleKind, ScreenRegion, ScreenRuleSet} from "./screen-rule-data";

export interface UserScreenRule {
  readonly id: string; readonly kind: RuleKind; readonly region: ScreenRegion;
  readonly pattern: string; readonly flags: string; readonly source: string;
  readonly version: string;
}
export interface UserRuleManifest {
  readonly digest: string;
  readonly sets: Readonly<Record<RuleAgent, readonly UserScreenRule[]>>;
  readonly files: readonly {source: string; version: string; digest: string}[];
}
export const MAX_USER_DIRECTORY_ENTRIES = 256;
function fail(reason: string): never { throw new Error(`User screen rules unavailable: ${reason}`); }
function closed(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail("invalid object");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== fields.length || fields.some(key => !Object.hasOwn(record, key))) fail("unexpected or missing fields");
  return record;
}
function label(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9._-]{1,80}$/.test(value); }
export function parseUserRuleFile(bytes: Buffer, agent: RuleAgent): {version: string; rules: readonly UserScreenRule[]} {
  const root = closed(parseScreenRuleJson(bytes), ["schemaVersion", "ruleSetVersion", "agent", "rules"]);
  if (root.schemaVersion !== 1 || root.agent !== agent || !label(root.ruleSetVersion)) fail("invalid file version or agent");
  if (!Array.isArray(root.rules) || root.rules.length > 128) fail("rule count");
  const version = root.ruleSetVersion;
  const ids = new Set<string>();
  const rules = root.rules.map(value => {
    const r = closed(value, ["id", "kind", "region", "pattern", "flags"]);
    if (typeof r.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(r.id) || ids.has(r.id)) fail("invalid or duplicate rule id");
    ids.add(r.id);
    if (!["prompt", "suppressor", "dialog", "busy", "usage-limit", "account-setting"].includes(r.kind as string) || !["tail", "lastLine", "screen"].includes(r.region as string)) fail("invalid kind or region");
    if (typeof r.pattern !== "string" || !r.pattern.length || r.pattern.length > 2048) fail("pattern length");
    if (typeof r.flags !== "string" || !/^[imu]*$/.test(r.flags) || new Set(r.flags).size !== r.flags.length) fail("invalid flags");
    return Object.freeze({id:r.id,kind:r.kind as RuleKind,region:r.region as ScreenRegion,pattern:r.pattern,flags:r.flags,source:`user/${agent}.json`,version});
  });
  return {version,rules:Object.freeze(rules)};
}
function sameFile(a: fs.Stats, b: fs.Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.nlink === b.nlink && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function privateEntry(stat: fs.Stats, directory: boolean): void {
  if ((directory ? !stat.isDirectory() : !stat.isFile()) || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== (directory ? 0o700 : 0o600) || (!directory && stat.nlink !== 1)) fail("unsafe directory or file metadata");
}
/** Bounded descriptor read, including files growing after the initial stat. */
export function readUserRuleFile(file: string, io = fs): Buffer {
  const fd = io.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = io.fstatSync(fd); privateEntry(before, false);
    if (before.size > MAX_RULE_FILE_BYTES) fail("file size");
    const bytes = Buffer.alloc(MAX_RULE_FILE_BYTES + 1); let size = 0, count = 0;
    do { count = io.readSync(fd, bytes, size, bytes.length - size, null); size += count; } while (count && size < bytes.length);
    if (size > MAX_RULE_FILE_BYTES) fail("file size");
    const after = io.fstatSync(fd), named = io.lstatSync(file);
    if (size !== before.size || !sameFile(before, after) || !sameFile(after, named)) fail("file changed while reading");
    return bytes.subarray(0, size);
  } finally { io.closeSync(fd); }
}
/** No directory creation, no regex compilation, no arbitrary imports.
 * Directory identity rechecks are accident guards, not protection from a
 * same-UID writer (who can also edit these additive rules directly). Child
 * paths always receive the complete private-file/type/bounded-read checks. */
export function readUserScreenRules(directory: string, builtin: ScreenRuleSet): UserRuleManifest | null {
  let initial: fs.Stats;
  try { initial = fs.lstatSync(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  privateEntry(initial, true);
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK | fs.constants.O_DIRECTORY);
  try {
    const before = fs.fstatSync(fd); privateEntry(before, true);
    if (initial.dev !== before.dev || initial.ino !== before.ino) fail("directory changed");
    const names = new Set<string>(), handle = fs.opendirSync(directory);
    try {
      let entry: fs.Dirent | null, count = 0;
      while ((entry = handle.readSync())) {
        if (++count > MAX_USER_DIRECTORY_ENTRIES) fail("directory entry count");
        if (!entry.name.endsWith(".json")) continue;
        if (!RULE_AGENTS.some(agent => entry!.name === `${agent}.json`)) fail("unknown JSON filename");
        names.add(entry.name);
      }
    } finally { handle.closeSync(); }
    const authored = Object.fromEntries(RULE_AGENTS.map(agent => [agent, []])) as unknown as Record<RuleAgent, readonly UserScreenRule[]>;
    const builtinIds = new Set(RULE_AGENTS.flatMap(agent => builtin.sets[agent].map(rule => rule.id)));
    const ids = new Set<string>(), files: {source:string;version:string;digest:string}[] = [], hash = createHash("sha256").update("additive-user-rules-v1\0");
    let total = builtinIds.size;
    for (const agent of RULE_AGENTS) {
      const name = `${agent}.json`; if (!names.has(name)) continue;
      const bytes = readUserRuleFile(path.join(directory, name)), parsed = parseUserRuleFile(bytes, agent);
      for (const rule of parsed.rules) {
        if (builtinIds.has(rule.id) || ids.has(rule.id)) fail("rule id collides with another user or built-in rule");
        ids.add(rule.id); if (++total > 256) fail("aggregate authored rule count");
      }
      authored[agent] = parsed.rules;
      files.push(Object.freeze({source:`user/${name}`,version:parsed.version,digest:createHash("sha256").update(bytes).digest("hex")}));
      hash.update(name).update("\0").update(bytes).update("\0");
    }
    const sets = {} as Record<RuleAgent, readonly UserScreenRule[]>;
    for (const agent of RULE_AGENTS) {
      // Specific user rules precede generic; built-ins are evaluated separately.
      const rules = agent === "generic" ? authored.generic : [...authored[agent], ...authored.generic];
      if (builtin.sets[agent].length + rules.length > 128) fail("effective rule count");
      sets[agent] = Object.freeze(rules);
    }
    const after = fs.fstatSync(fd), named = fs.lstatSync(directory);
    privateEntry(after, true); privateEntry(named, true);
    if (before.dev !== after.dev || before.ino !== after.ino || after.dev !== named.dev || after.ino !== named.ino) fail("directory changed while reading");
    return files.length ? Object.freeze({digest:hash.digest("hex"),sets:Object.freeze(sets),files:Object.freeze(files)}) : null;
  } finally { fs.closeSync(fd); }
}
