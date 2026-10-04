// One read-only list of the ssh hosts Aya knows, for Open project > Remote host and Settings > Machines.
// It reads ~/.ssh/config, remote projects and added machines; it connects to nothing and writes nothing.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { isSshTarget, SSH_ALIAS_PATTERN } from "./ssh";

const SSH_INCLUDE_MAX_DEPTH = 16;

export type HostSource = "ssh-config" | "remote-project" | "machine";

export interface KnownHost {
  target: string;
  /** In the order ssh-config, remote-project, machine. */
  sources: HostSource[];
  /** The added machine reached at this target. */
  machineId?: string;
  /** Names of the remote projects on this target. */
  projects?: string[];
}

export interface HostSourcesInput {
  aliases: string[];
  remoteProjects: { name: string; sshTarget: string }[];
  machines: { id: string; ssh: string }[];
}

const SOURCE_ORDER: HostSource[] = ["ssh-config", "remote-project", "machine"];

/** Merged by target, case-insensitively as ssh matches Host names; `user@host` and `host` stay two entries,
 *  since the alias may name another user. Targets ssh could not take are left out. */
export function mergeKnownHosts(input: HostSourcesInput): KnownHost[] {
  const byKey = new Map<string, KnownHost>();
  const add = (target: string, source: HostSource, more: (h: KnownHost) => void = () => {}) => {
    const t = target.trim();
    if (!isSshTarget(t)) return;
    const key = t.toLowerCase();
    let host = byKey.get(key);
    if (!host) {
      host = { target: t, sources: [] };
      byKey.set(key, host);
    }
    if (!host.sources.includes(source)) {
      host.sources.push(source);
      host.sources.sort((a, b) => SOURCE_ORDER.indexOf(a) - SOURCE_ORDER.indexOf(b));
    }
    more(host);
  };
  for (const alias of input.aliases) add(alias, "ssh-config");
  for (const p of input.remoteProjects) {
    add(p.sshTarget, "remote-project", (h) => {
      h.projects = [...(h.projects ?? []), ...(h.projects?.includes(p.name) ? [] : [p.name])];
    });
  }
  for (const m of input.machines) add(m.ssh, "machine", (h) => (h.machineId ??= m.id));
  return [...byKey.values()];
}

function expandHome(p: string, userHome: string): string {
  return p === "~" ? userHome : p.startsWith("~/") ? path.join(userHome, p.slice(2)) : p;
}

async function globFiles(pattern: string): Promise<string[]> {
  if (!/[*?]/.test(pattern)) return [pattern];
  const dir = path.dirname(pattern);
  const re = new RegExp(`^${path.basename(pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
  try {
    return (await fs.readdir(dir)).filter((name) => re.test(name)).sort().map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

/** `Host` aliases from ~/.ssh/config and every file it Includes; wildcard and negated patterns are skipped. */
export async function sshHostAliases(userHome: string): Promise<string[]> {
  const sshDir = path.join(userHome, ".ssh");
  const aliases: string[] = [];
  const seen = new Set<string>();
  const visit = async (file: string, depth: number): Promise<void> => {
    if (depth > SSH_INCLUDE_MAX_DEPTH || seen.has(file)) return;
    seen.add(file);
    let text: string;
    try {
      text = await fs.readFile(file, "utf8");
    } catch {
      return;
    }
    for (const raw of text.split("\n")) {
      const m = /^\s*(\w+)(?:\s*=\s*|\s+)(.*)$/.exec(raw);
      if (!m) continue;
      const keyword = m[1].toLowerCase();
      const values = m[2].replace(/#.*/, "").trim().split(/\s+/).filter(Boolean).map((v) => v.replace(/^"|"$/g, ""));
      if (keyword === "host") {
        for (const v of values) if (SSH_ALIAS_PATTERN.test(v) && !aliases.includes(v)) aliases.push(v);
      } else if (keyword === "include") {
        for (const v of values) {
          const expanded = expandHome(v, userHome);
          const full = path.isAbsolute(expanded) ? expanded : path.join(sshDir, expanded);
          for (const f of await globFiles(full)) await visit(f, depth + 1);
        }
      }
    }
  };
  await visit(path.join(sshDir, "config"), 0);
  return aliases;
}
