// The Host aliases in ~/.ssh/config, for `aya machines hosts` and Settings > Machines; it connects to nothing and writes nothing.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { SSH_ALIAS_PATTERN } from "./ssh";

const SSH_INCLUDE_MAX_DEPTH = 16;
const SSH_CONFIG_MAX_BYTES = 1024 * 1024;

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
      // Only regular files of sane size: an `Include /dev/zero` or a huge file must not eat Aya's memory.
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > SSH_CONFIG_MAX_BYTES) return;
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
