// Whether a pane's `aya` calls reach Aya's socket, by how its CLI was launched. Each rule is a measurement:
// docs/teams.md, "States a team depends on" (codex-cli 0.158.0, opencode 1.18.30, Claude Code 2.1.284, grok 1.0.44).

import * as path from "node:path";
import { firstPositional, NO_DAEMON, NON_TUI, VALUE_OPTIONS } from "./codex-daemon";
import { isShellCommand, shellQuote } from "./pane-command";
import { cdLead, envWithAssignments, expandWord, shellTokens, splitProgram, unquoteWord } from "./shell-words";
import type { LaunchReach } from "./types";
import { CLAUDE_CONFIG_DIRNAME, CLAUDE_SETTINGS_FILENAME, CODEX_CONFIG_FILENAME, CODEX_DIRNAME } from "./constants";

/** `mode` is the verdict on the config at launch: a later edit does not change what the process read. */
export interface PaneLaunch {
  command: string;
  cwd: string;
  added?: string[];
  mode?: LaunchMode;
}

export interface LaunchMode {
  cli: string;
  mode: string;
  reach: LaunchReach;
  why: string | null;
  /** Arguments that would make it reach; empty when none do. */
  fix: string[];
  /** Aya may add `fix` to a pane it opens for a role. It never lifts a read-only choice,
   *  but Codex's network switch widens the sandbox from Aya's socket to every host. */
  autoFix: boolean;
  /** Shown, never held. */
  todo?: string;
  /** Shown, never held. */
  note?: string;
}

/** Lowest precedence first. */
export interface LaunchFiles {
  codex: string[];
  opencode: string[];
  claude: string[];
}

/** `socket` has symlinks resolved (Claude Code matches it as written). Codex reads `codexProject` only when
 *  `codexTrusted`; `opencodeContent` is OpenCode's highest layer. */
export type LaunchConfig = LaunchFiles & {
  socket: string;
  codexProfile?: string | null;
  codexProject?: string[];
  codexTrusted?: boolean;
  opencodeContent?: string | null;
  claudeSettingsUnread?: boolean;
};

const reaches = (cli: string, mode: string): LaunchMode => ({ cli, mode, reach: "reaches", why: null, fix: [], autoFix: false });
const unknown = (cli: string, mode: string, why: string, todo?: string): LaunchMode => ({ cli, mode, reach: "unknown", why, fix: [], autoFix: false, todo });
const blocked = (cli: string, mode: string, why: string, fix: string[], autoFix: boolean): LaunchMode => ({ cli, mode, reach: "blocked", why, fix, autoFix });

function parse(command: string): { assignments: string[]; name: string; head: string; tail: string; rawWords: string[]; words: string[] } {
  const { lead, assignments, program } = splitProgram(command);
  const [binary = "", ...args] = shellTokens(program);
  return {
    assignments,
    name: unquoteWord(binary).split("/").pop() ?? "",
    head: lead + binary,
    tail: program.slice(binary.length),
    rawWords: args,
    words: args.map((w) => unquoteWord(w)),
  };
}

/** Every value given to one of `names`, as `--name value` or `--name=value`. */
function optionValues(words: string[], names: string[], valueOptions: ReadonlySet<string> = new Set()): string[] {
  const values: string[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const eq = words[i].startsWith("--") ? words[i].indexOf("=") : -1;
    if (eq > 0) {
      if (names.includes(words[i].slice(0, eq))) values.push(words[i].slice(eq + 1));
    } else if (names.includes(words[i]) || valueOptions.has(words[i])) {
      if (names.includes(words[i]) && i + 1 < words.length) values.push(words[i + 1]);
      i += 1;
    }
  }
  return values;
}

// Codex's default sandbox, and the config table that holds its network switch.
const WORKSPACE_WRITE = "workspace-write";
const WORKSPACE_WRITE_TABLE = "sandbox_workspace_write";
const CODEX_NETWORK_ON = ["-c", `${WORKSPACE_WRITE_TABLE}.network_access=true`];
const CODEX_BYPASS = ["--dangerously-bypass-approvals-and-sandbox", "--yolo"];
const CODEX_FULL_AUTO = "--full-auto";
const CODEX_SANDBOX_OPTIONS = ["-s", "--sandbox"];
const CODEX_APPROVAL_OPTIONS = ["-a", "--ask-for-approval"];
const CODEX_FULL_ACCESS = "danger-full-access";
const CODEX_NEVER_ASK = "never";
/** What a role's Codex pane runs with, unless its preset picks a sandbox or approval policy itself. */
const CODEX_TEAM_ARGS = [CODEX_SANDBOX_OPTIONS[0], CODEX_FULL_ACCESS, CODEX_APPROVAL_OPTIONS[0], CODEX_NEVER_ASK];
const CODEX_PRESET_DECIDES = `Codex's sandbox and approvals are as the preset sets them, not ${CODEX_TEAM_ARGS.join(" ")}, so it may stop for approvals on git and aya`;

interface CodexSandbox {
  sandbox?: string;
  network?: boolean;
  trust?: Record<string, string>;
  profile?: string;
  /** Legacy `[profiles.<name>]`, kept so that its settings never count as the top level's. */
  profiles?: Record<string, CodexSandbox>;
  approval?: string;
  /** A setting that decides the mode in a form Aya does not read. */
  unread?: boolean;
}

/** A one-line TOML string (or, from `-c`, a bare word); null for any other form. */
function tomlString(value: string, bare: boolean): string | null {
  const quoted = /^"([^"\\]*)"$|^'([^']*)'$/.exec(value);
  if (quoted) return quoted[1] ?? quoted[2];
  return bare && /^[\w.-]+$/.test(value) ? value : null;
}

function keyParts(text: string): { parts: string[]; rest: string } | null {
  const parts: string[] = [];
  let rest = text;
  for (;;) {
    const m = /^\s*(?:"([^"]*)"|'([^']*)'|([\w-]+))\s*/.exec(rest);
    if (!m) return null;
    parts.push(m[1] ?? m[2] ?? m[3]);
    rest = rest.slice(m[0].length);
    if (rest[0] !== ".") return { parts, rest };
    rest = rest.slice(1);
  }
}

interface ValueState {
  depth: number;
  multi: string | null;
}

/** `line` without its comment; `state` tracks brackets and multi-line strings across lines. */
function scanValue(state: ValueState, line: string): string {
  let out = "";
  for (let i = 0; i < line.length; i += 1) {
    const rest = line.slice(i);
    if (state.multi) {
      if (rest.startsWith(state.multi)) {
        out += state.multi;
        i += 2;
        state.multi = null;
      } else out += line[i];
    } else if (rest.startsWith('"""') || rest.startsWith("'''")) {
      state.multi = rest.slice(0, 3);
      out += state.multi;
      i += 2;
    } else if (line[i] === '"' || line[i] === "'") {
      const end = rest.slice(1).search(line[i] === '"' ? /(?<!\\)"/ : /'/);
      if (end < 0) return out + rest;
      out += rest.slice(0, end + 2);
      i += end + 1;
    } else if (line[i] === "#") {
      return out;
    } else {
      if ("[{".includes(line[i])) state.depth += 1;
      if ("]}".includes(line[i])) state.depth -= 1;
      out += line[i];
    }
  }
  return out;
}

/** The top-level items of an inline table `{ a = 1, b.c = "x" }`; null when it is not one. */
function inlineItems(value: string): string[] | null {
  if (!value.startsWith("{") || !value.endsWith("}")) return null;
  const items: string[] = [];
  let depth = 0;
  let from = 1;
  for (let i = 1; i < value.length - 1; i += 1) {
    const c = value[i];
    if (c === '"' || c === "'") {
      const end = value.indexOf(c, i + 1);
      if (end < 0) return null;
      i = end;
    } else if (c === "[" || c === "{") depth += 1;
    else if (c === "]" || c === "}") depth -= 1;
    else if (c === "," && depth === 0) {
      items.push(value.slice(from, i));
      from = i + 1;
    }
  }
  const last = value.slice(from, -1);
  if (last.trim()) items.push(last);
  return depth === 0 ? items : null;
}

function absorbProfile(out: CodexSandbox, name: string): CodexSandbox {
  out.profiles ??= {};
  return (out.profiles[name] ??= {});
}

function absorb(out: CodexSandbox, key: string[], raw: string, bare: boolean): void {
  const value = raw.trim();
  if (value.startsWith("{")) {
    const items = inlineItems(value);
    if (!items) out.unread = true;
    for (const item of items ?? []) {
      const at = keyParts(item);
      if (!at || !at.rest.startsWith("=")) out.unread = true;
      else absorb(out, [...key, ...at.parts], at.rest.slice(1), bare);
    }
    return;
  }
  const last = key.at(-1);
  if (key.length === 1 && key[0] === "sandbox_mode") {
    const mode = tomlString(value, bare);
    if (mode === null) out.unread = true;
    else out.sandbox = mode;
  } else if (key.length === 2 && key[0] === WORKSPACE_WRITE_TABLE && last === "network_access") {
    if (value === "true" || value === "false") out.network = value === "true";
    else out.unread = true;
  } else if (key.length === 3 && key[0] === "projects" && last === "trust_level") {
    const trust = tomlString(value, bare);
    if (trust === null) out.unread = true;
    else out.trust = { ...out.trust, [key[1]]: trust };
  } else if (key[0] === "projects" ? key.length <= 2 : key.length === 1 && key[0] === WORKSPACE_WRITE_TABLE) {
    out.unread = true;
  } else if (key.length === 1 && key[0] === "approval_policy") {
    const policy = tomlString(value, bare);
    if (policy !== null) out.approval = policy;
  } else if (key.length === 1 && key[0] === "profile") {
    const name = tomlString(value, bare);
    if (name === null) out.unread = true;
    else out.profile = name;
  } else if (key[0] === "profiles" && key.length > 2) {
    absorb(absorbProfile(out, key[1]), key.slice(2), raw, bare);
  }
}

function codexToml(text: string | null): CodexSandbox {
  const out: CodexSandbox = {};
  let table: string[] = [];
  const state: ValueState = { depth: 0, multi: null };
  let pending: { key: string[]; value: string } | null = null;
  for (const raw of (text ?? "").split("\n")) {
    const line = scanValue(state, raw).trim();
    if (pending) {
      pending.value += ` ${line}`;
    } else if (!line) {
      continue;
    } else if (line.startsWith("[[")) {
      if (/sandbox|projects|profiles/.test(line)) out.unread = true;
      table = [];
      continue;
    } else if (line.startsWith("[")) {
      const at = keyParts(line.replace(/^\[/, "").replace(/\]$/, ""));
      if (!at || at.rest || !line.endsWith("]")) out.unread = true;
      table = at?.parts ?? [];
      if (table[0] === "profiles" && table.length > 1) absorbProfile(out, table[1]);
      continue;
    } else {
      const at = keyParts(line);
      if (!at || !at.rest.startsWith("=")) {
        out.unread = true;
        continue;
      }
      pending = { key: [...table, ...at.parts], value: at.rest.slice(1) };
    }
    if (pending && state.depth <= 0 && state.multi === null) {
      absorb(out, pending.key, pending.value, false);
      pending = null;
      state.depth = 0;
    }
  }
  if (pending) out.unread = true;
  return out;
}

function codexOverrides(pairs: [string, string][]): CodexSandbox {
  const out: CodexSandbox = {};
  for (const [key, value] of pairs) {
    const at = keyParts(key);
    if (at && !at.rest) absorb(out, at.parts, value, true);
    else if (/sandbox_mode|network_access|sandbox_workspace_write/.test(key)) out.unread = true;
  }
  return out;
}

/** Codex ignores a project's config unless the user's own config trusts one of `candidates`. */
export function codexTrusts(userTexts: string[], candidates: string[]): boolean {
  const trust = userTexts.reduce<Record<string, string>>((all, text) => ({ ...all, ...codexToml(text).trust }), {});
  return candidates.some((dir) => trust[dir] === "trusted");
}

/** Why Codex 0.159 refuses to start (measured): a legacy `profile` key in the user's files, or `[profiles.x]` in
 *  config.toml beside `-p x`. A trusted project's are ignored with a warning, and a profile file may hold its own table. */
function legacyProfile(words: string[], configs: CodexSandbox[], profileFile: CodexSandbox[]): string | null {
  if ([...configs, ...profileFile].some((l) => l.profile !== undefined)) return "legacy `profile` config is no longer supported";
  const selected = optionValues(words, ["-p", "--profile"], VALUE_OPTIONS).at(-1);
  return selected !== undefined && configs.some((l) => l.profiles?.[selected]) ? `--profile ${selected} cannot be used while config.toml contains legacy [profiles.${selected}]` : null;
}

function codexCli(words: string[]): CodexSandbox {
  const overrides = optionValues(words, ["-c", "--config"], VALUE_OPTIONS).map((kv): [string, string] => {
    const eq = kv.indexOf("=");
    return eq < 0 ? [kv, ""] : [kv.slice(0, eq).trim(), kv.slice(eq + 1)];
  });
  const cli = codexOverrides(overrides);
  cli.sandbox = optionValues(words, CODEX_SANDBOX_OPTIONS, VALUE_OPTIONS).at(-1) ?? cli.sandbox;
  cli.approval = optionValues(words, CODEX_APPROVAL_OPTIONS, VALUE_OPTIONS).at(-1) ?? cli.approval;
  return cli;
}

/** The command line picks Codex's sandbox or approval policy itself. */
function codexPresetDecides(words: string[]): boolean {
  const cli = codexCli(words);
  return cli.sandbox !== undefined || cli.approval !== undefined || [...CODEX_BYPASS, CODEX_FULL_AUTO].some((flag) => words.includes(flag));
}

function codexMode(words: string[], config: LaunchConfig): LaunchMode {
  const sub = firstPositional(words);
  if (sub !== undefined && NON_TUI.has(sub)) return unknown("codex", `codex ${sub}`, `codex ${sub} is not an interactive session`);
  if (optionValues(words, ["--remote"], VALUE_OPTIONS).length) {
    return unknown("codex", "remote app server", "its commands run on a remote app server");
  }
  const cli = codexCli(words);
  const user = config.codex.map(codexToml);
  const profileFile = config.codexProfile == null ? [] : [codexToml(config.codexProfile)];
  const files = [...user, ...profileFile];
  const project = (config.codexProject ?? []).map(codexToml);
  const bypass = CODEX_BYPASS.some((flag) => words.includes(flag));
  const legacy = legacyProfile(words, [...user, cli], profileFile);
  if (legacy) {
    return unknown("codex", "legacy profile setting", `this Codex version cannot start with that profile setting: ${legacy}`, "remove it from Codex's config.toml, then restart the pane");
  }
  if (!bypass && [...files, ...project, cli].some((l) => l.unread)) {
    return unknown("codex", "unread config", "Codex config in a form Aya does not read (a sandbox setting it cannot parse), so it cannot tell what applies", "fix that setting, then restart it");
  }
  const decides = (l: CodexSandbox) =>
    (l.sandbox !== undefined && cli.sandbox === undefined) || (l.network !== undefined && cli.network === undefined && (cli.sandbox ?? WORKSPACE_WRITE) === WORKSPACE_WRITE);
  if (!bypass && !config.codexTrusted && project.some(decides)) {
    return unknown("codex", "untrusted project config", "the project's .codex/config.toml applies only once the project is trusted, and it is not marked trusted in Codex's config.toml", "trust the project in Codex, then restart the pane");
  }
  // Measured: the command line over the project's config over the user's.
  const layers = [...files, ...(config.codexTrusted ? project : []), cli];
  const sandbox = layers.reduce<string | undefined>((v, l) => l.sandbox ?? v, undefined) ?? WORKSPACE_WRITE;
  const network = layers.reduce<boolean>((v, l) => l.network ?? v, false);
  const mode = bypass ? "no sandbox" : `sandbox ${sandbox}${sandbox === WORKSPACE_WRITE && network ? " + network" : ""}`;
  const presetDecides = codexPresetDecides(words);
  if (!bypass && sandbox === WORKSPACE_WRITE && !network) {
    // The network switch is neither a sandbox nor an approval choice, so a preset that made those keeps them.
    return blocked("codex", mode, "Codex sandbox workspace-write blocks the socket", presetDecides ? CODEX_NETWORK_ON : CODEX_TEAM_ARGS, true);
  }
  if (!bypass && sandbox === "read-only") {
    return blocked("codex", mode, "Codex sandbox read-only blocks the socket", CODEX_TEAM_ARGS, false);
  }
  if (!bypass && sandbox !== WORKSPACE_WRITE && sandbox !== CODEX_FULL_ACCESS) {
    return unknown("codex", mode, `Codex sandbox ${sandbox} is not measured`);
  }
  if (!words.includes(NO_DAEMON)) {
    return blocked("codex", `${mode}, shared daemon`, "Codex runs on its shared daemon (no --no-daemon), so its aya calls can speak as another Codex pane; update Codex to one with --no-daemon", [], false);
  }
  const approval = layers.reduce<string | undefined>((v, l) => l.approval ?? v, undefined);
  // `untrusted` runs only Codex's own list of read-only commands without asking; aya is not on it.
  if (!bypass && approval === "untrusted") {
    const note = "Codex's approval policy untrusted asks before each command it runs, so each aya call this role makes waits for you to approve it in its pane; restart it with -a on-request to let them run";
    return { ...reaches("codex", `${mode}, approval untrusted`), note };
  }
  if (bypass || (sandbox === CODEX_FULL_ACCESS && approval === CODEX_NEVER_ASK)) return reaches("codex", mode);
  if (presetDecides) return { ...reaches("codex", mode), note: CODEX_PRESET_DECIDES };
  // Measured on 0.160: git cannot write .git/index.lock there, and aya team send waits for an approval.
  if (sandbox === WORKSPACE_WRITE) {
    return { ...reaches("codex", mode), note: `Codex sandbox workspace-write will stop for approvals on git and aya; open a new pane for it, or restart this one with ${formatArgs(CODEX_TEAM_ARGS)}` };
  }
  return reaches("codex", mode);
}

const OPENCODE_COMMANDS = new Set([
  "completion", "acp", "mcp", "attach", "run", "debug", "providers", "auth", "agent", "upgrade", "uninstall",
  "serve", "web", "models", "stats", "export", "import", "github", "pr", "session", "plugin", "plug", "db",
]);
const OPENCODE_VALUE_OPTIONS = new Set([
  "-m", "--model", "-s", "--session", "--prompt", "--agent", "--port", "--hostname", "--log-level", "--mdns-domain", "--cors", "--replay-limit",
]);

const OPENCODE_DEFAULT_AGENT = "build";

function defaultAgent(text: string): string | undefined {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  return /"default_agent"\s*:\s*"([^"]+)"/.exec(code)?.[1];
}

function opencodeMode(command: string, words: string[], config: LaunchConfig): LaunchMode {
  const sub = firstPositional(words, OPENCODE_VALUE_OPTIONS);
  if (sub !== undefined && OPENCODE_COMMANDS.has(sub)) return unknown("opencode", `opencode ${sub}`, `opencode ${sub} is not an interactive session`);
  const explicit = optionValues(words, ["--agent"], OPENCODE_VALUE_OPTIONS).at(-1);
  const content = paneEnv({}, parse(command).assignments).OPENCODE_CONFIG_CONTENT ?? config.opencodeContent ?? "";
  const configured = [...config.opencode, content].reduce<string | undefined>((agent, text) => defaultAgent(text) ?? agent, undefined);
  const agent = explicit ?? configured ?? OPENCODE_DEFAULT_AGENT;
  const mode = `agent ${agent}`;
  if (agent === OPENCODE_DEFAULT_AGENT) return reaches("opencode", mode);
  if (agent === "plan") {
    return blocked("opencode", mode, "OpenCode's plan agent is read-only (edits denied), so the role never does its work", ["--agent", OPENCODE_DEFAULT_AGENT], explicit === undefined);
  }
  return unknown("opencode", mode, `OpenCode agent ${agent}: its permissions are not measured`);
}

interface ClaudeSandbox {
  permissions?: { defaultMode?: unknown };
  sandbox?: { enabled?: unknown; network?: { allowUnixSockets?: unknown; allowAllUnixSockets?: unknown } };
}

// Measured on 2.1.285: an entry that is a directory holding the socket (any ancestor) is allowed like the socket.
function holdsSocket(entry: unknown, socket: string): boolean {
  if (typeof entry !== "string") return false;
  const dir = entry.replace(/\/+$/, "");
  return dir !== "" && (dir === socket || socket.startsWith(`${dir}/`));
}

function claudeMode(words: string[], config: LaunchConfig): LaunchMode {
  const chosen = optionValues(words, ["--permission-mode"]).at(-1);
  if (chosen === "plan") {
    return unknown("claude", "plan mode", "Claude Code's plan mode may not act on the role's work (measured: it refused 1 of 2 runs)", "restart it without --permission-mode plan");
  }
  if (config.claudeSettingsUnread) {
    return unknown("claude", "settings unreadable", "could not read the file --settings names", "fix that path, then restart it");
  }
  const settings = optionValues(words, ["--settings"]).at(-1);
  const inline = settings?.trim().startsWith("{") ? [settings] : [];
  let layers: ClaudeSandbox[];
  try {
    layers = [...config.claude, ...inline].map((text) => (text.trim() ? (JSON.parse(text) as ClaudeSandbox) : {}));
  } catch {
    return unknown("claude", "settings unreadable", "could not read Claude Code's settings", "fix that file, then restart it");
  }
  const defaultMode = layers.reduce<unknown>((mode, l) => l?.permissions?.defaultMode ?? mode, undefined);
  if (defaultMode === "plan" && chosen === undefined && !words.includes("--dangerously-skip-permissions")) {
    return blocked("claude", "plan mode", "Claude Code's default is plan mode, which does not act on the role's work", ["--permission-mode", "default"], false);
  }
  const enabled = layers.reduce((on, l) => (typeof l?.sandbox?.enabled === "boolean" ? l.sandbox.enabled : on), false);
  if (!enabled) return reaches("claude", "no sandbox");
  const allowed = layers.some((l) => {
    const network = l?.sandbox?.network;
    return network?.allowAllUnixSockets === true || (Array.isArray(network?.allowUnixSockets) && network.allowUnixSockets.some((entry) => holdsSocket(entry, config.socket)));
  });
  if (allowed) return reaches("claude", "sandbox on, Aya's socket allowed");
  const allowSocket = JSON.stringify({ sandbox: { network: { allowUnixSockets: [config.socket] } } });
  return blocked("claude", "sandbox on", "Claude Code's sandbox is on and does not allow Aya's socket", ["--settings", allowSocket], settings === undefined);
}

function grokMode(words: string[]): LaunchMode {
  const profile = optionValues(words, ["--sandbox"]).at(-1);
  return reaches("grok", profile === undefined ? "default" : `sandbox ${profile}`);
}

export function launchMode(command: string, config: LaunchConfig): LaunchMode {
  const lead = cdLead(command);
  if (lead) return launchMode(command.slice(lead.at), config);
  if (isShellCommand(command)) return unknown("shell", "shell", "a shell runs whatever is typed into it");
  const { name, words } = parse(command);
  if (name === "codex") return codexMode(words, config);
  if (name === "opencode") return opencodeMode(command, words, config);
  if (name === "claude") return claudeMode(words, config);
  if (name === "grok") return grokMode(words);
  return unknown(name, name, `Aya reads the launch flags of claude, codex, opencode and grok run directly (a cd <dir> && in front is fine), not of ${name}`);
}

const CLAUDE_MANAGED_SETTINGS = "/Library/Application Support/ClaudeCode/managed-settings.json";

function paneEnv(baseEnv: Record<string, string | undefined>, assignments: string[]): Record<string, string | undefined> {
  try {
    return envWithAssignments(baseEnv, assignments);
  } catch {
    return baseEnv; // An assignment that runs code: the pane's own settings are unknown, the defaults apply.
  }
}

/** The file `--settings` names, with `~` and `$VAR` expanded from the pane's env; `unresolved`
 *  when that cannot be done (then no file can be said to be read); null for none or inline JSON. */
export function claudeSettingsFile(command: string, baseEnv: Record<string, string | undefined>, dirs: string[]): { file: string } | { unresolved: string } | null {
  if (isShellCommand(command)) return null;
  const { assignments, name, rawWords } = parse(command);
  if (name !== "claude") return null;
  const raw = optionValues(rawWords, ["--settings"]).at(-1);
  if (raw === undefined) return null;
  const env = paneEnv(baseEnv, assignments);
  let value: string;
  try {
    value = expandWord(raw, env);
  } catch {
    return { unresolved: raw };
  }
  // What claudeMode reads as inline JSON is the literal word; one the env turns into JSON it cannot see.
  if (value.trim().startsWith("{")) return unquoteWord(raw).trim().startsWith("{") ? null : { unresolved: raw };
  if (!value || value.startsWith("~")) return { unresolved: raw };
  return { file: path.resolve(dirs.at(-1) ?? env.HOME ?? "", value) };
}

/** `dirs` run from the repository root to the pane's cwd. */
export function launchFiles(command: string, baseEnv: Record<string, string | undefined>, dirs: string[]): LaunchFiles {
  const files: LaunchFiles = { codex: [], opencode: [], claude: [] };
  if (isShellCommand(command)) return files;
  const { assignments, name, words } = parse(command);
  const env = paneEnv(baseEnv, assignments);
  const home = env.HOME ?? "";
  const cwd = dirs.at(-1) ?? home;
  if (name === "codex") {
    const codexHome = env.CODEX_HOME ?? path.join(home, CODEX_DIRNAME);
    const profile = optionValues(words, ["-p", "--profile"], VALUE_OPTIONS).at(-1);
    files.codex = [
      path.join(codexHome, CODEX_CONFIG_FILENAME),
      ...(profile ? [path.join(codexHome, `${profile}.${CODEX_CONFIG_FILENAME}`)] : []),
      ...dirs.map((dir) => path.join(dir, CODEX_DIRNAME, CODEX_CONFIG_FILENAME)),
    ];
  } else if (name === "opencode") {
    const configDir = path.join(env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "opencode");
    const inDir = (dir: string) => [path.join(dir, "opencode.json"), path.join(dir, "opencode.jsonc")];
    files.opencode = [
      ...inDir(configDir),
      ...(env.OPENCODE_CONFIG ? [env.OPENCODE_CONFIG] : []),
      ...dirs.flatMap((dir) => [...inDir(dir), ...inDir(path.join(dir, ".opencode"))]),
    ];
  } else if (name === "claude") {
    const cli = claudeSettingsFile(command, baseEnv, dirs);
    const cliFile = cli && "file" in cli ? [cli.file] : [];
    files.claude = [
      path.join(env.CLAUDE_CONFIG_DIR ?? path.join(home, CLAUDE_CONFIG_DIRNAME), CLAUDE_SETTINGS_FILENAME),
      path.join(cwd, CLAUDE_CONFIG_DIRNAME, CLAUDE_SETTINGS_FILENAME),
      path.join(cwd, CLAUDE_CONFIG_DIRNAME, "settings.local.json"),
      ...cliFile,
      CLAUDE_MANAGED_SETTINGS,
    ];
  }
  return files;
}

const formatArgs = (args: string[]): string => args.map((a) => (/^[\w./:=,@+-]+$/.test(a) ? a : shellQuote(a))).join(" ");

export function withLaunchArgs(command: string, args: string[]): string {
  if (!args.length) return command;
  const at = cdLead(command)?.at ?? 0;
  if (at) return command.slice(0, at) + withLaunchArgs(command.slice(at), args);
  const { head, tail } = parse(command);
  return `${head} ${formatArgs(args)}${tail}`;
}

function programWords(command: string): string[] {
  const lead = cdLead(command);
  return lead ? programWords(command.slice(lead.at)) : parse(command).words;
}

export function teamLaunch(command: string, config: LaunchConfig): { args: string[] } | { refused: string } {
  const first = launchMode(command, config);
  // A read-only config.toml is a choice Aya never lifts, so it stays refused.
  const kept = first.reach === "blocked" && !first.autoFix;
  const args = first.cli === "codex" && first.reach !== "unknown" && !kept && !codexPresetDecides(programWords(command)) ? [...CODEX_TEAM_ARGS] : [];
  const tried = new Set<string>();
  for (;;) {
    const mode = launchMode(withLaunchArgs(command, args), config);
    if (mode.reach !== "blocked") return { args };
    if (!mode.autoFix || tried.has(mode.why ?? "")) {
      return { refused: mode.fix.length ? `${mode.why}; pick a preset that allows it (one that runs ${mode.cli} with ${formatArgs(mode.fix)})` : `${mode.why}` };
    }
    tried.add(mode.why ?? "");
    args.push(...mode.fix);
  }
}

export function cantReach(mode: LaunchMode): string | null {
  if (mode.reach !== "blocked") return null;
  const fix = formatArgs(mode.fix);
  if (mode.autoFix) return `can't reach Aya: ${mode.why}; open a new pane for it, or restart this one with ${fix}`;
  return mode.fix.length ? `can't reach Aya: ${mode.why}; restart it with ${fix}` : `can't reach Aya: ${mode.why}`;
}

/** The host did not answer, as opposed to null: no record. */
export const LAUNCH_UNREACHABLE = "unreachable";
/** The host has accepted the pane's spawn and is still in its preflight: the record comes once it ends. */
export const LAUNCH_STARTING = "starting";
export const LAUNCH_UNSUPPORTED = "unsupported";

/** null when the pane is not there (yet) or was not recorded. */
export type LaunchAnswer = PaneLaunch | typeof LAUNCH_UNREACHABLE | typeof LAUNCH_STARTING | typeof LAUNCH_UNSUPPORTED | null;

export const NO_LAUNCH_RECORD = "Aya has no record of how this pane was launched, so it cannot tell whether it reaches Aya; restart it";
const LAUNCH_ASK_FAILED = "Aya could not ask its terminal host how this pane was launched, so it cannot tell whether it reaches Aya; try again";
const LAUNCH_STILL_STARTING = "Aya does not know yet how this pane was launched, because it is still starting, so it cannot tell whether it reaches Aya; try again";
const LAUNCH_HOST_OLD = "Aya's terminal host is older than this Aya and does not record how panes are launched, so it cannot tell whether it reaches Aya; restart Aya's terminals";

export function launchBlockOf(launch: LaunchAnswer): string | null {
  if (launch === LAUNCH_UNREACHABLE) return LAUNCH_ASK_FAILED;
  if (launch === LAUNCH_STARTING) return LAUNCH_STILL_STARTING;
  if (launch === LAUNCH_UNSUPPORTED) return LAUNCH_HOST_OLD;
  if (!launch?.mode) return NO_LAUNCH_RECORD;
  return cantReach(launch.mode);
}

/** Only a measured can't reach holds a team; a pane Aya has no verdict for is typed into. */
export const launchHoldOf = (launch: LaunchAnswer): string | null => (typeof launch === "object" && launch?.mode ? cantReach(launch.mode) : null);

const CANNOT_TELL = new Set([NO_LAUNCH_RECORD, LAUNCH_ASK_FAILED, LAUNCH_STILL_STARTING, LAUNCH_HOST_OLD]);
const MAY_NOT_REACH = "may not reach Aya";
const NOTE_SEPARATOR = "; ";

/** Whether Aya cannot tell that a pane reaches it: no verdict yet (`block`), or an unknown one not settled (`note`). */
export const launchUnsure = (block: string | null, note: string | null): boolean =>
  (block !== null && CANNOT_TELL.has(block)) || (note?.split(NOTE_SEPARATOR).some((part) => part.startsWith(MAY_NOT_REACH)) ?? false);

/** The launch answer may still change: no pane at the host yet, or the host did not answer. */
export const launchPending = (block: string | null): boolean => block === NO_LAUNCH_RECORD || block === LAUNCH_ASK_FAILED;

/** The host's spawn preflight takes as long as the user's shell startup. */
export const launchStarting = (block: string | null): boolean => block === LAUNCH_STILL_STARTING;

/** `reached`: its running process has called aya (reached-aya.ts), so an unknown verdict is no longer noted. */
export function launchNoteOf(launch: LaunchAnswer, reached = false): string | null {
  if (typeof launch !== "object" || launch === null) return null;
  const widened = launch.added?.includes(CODEX_NETWORK_ON[1])
    ? `Aya opened it with -c ${CODEX_NETWORK_ON[1]} so it reaches Aya; Codex's sandbox then lets its commands reach every network host, not only Aya's socket`
    : launch.added?.includes(CODEX_FULL_ACCESS)
      ? `Aya opened it with ${formatArgs(CODEX_TEAM_ARGS)} so git and aya never wait for an approval; Codex then runs its commands without a sandbox`
      : null;
  const mode = launch.mode;
  const unsure = mode?.reach === "unknown" && !reached ? `${MAY_NOT_REACH}: ${mode.why}${mode.todo ? `; ${mode.todo}` : ""}` : null;
  const notes = [widened, mode?.note ?? null, unsure].filter((n): n is string => n !== null);
  return notes.length ? notes.join(NOTE_SEPARATOR) : null;
}
