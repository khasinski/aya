// The marked brief section in a file Aya edits in place (Antigravity's rule, Codex's
// AGENTS.md of earlier versions), without touching the user's own text.

import { promises as fs } from "node:fs";
import { writeFileAtomic } from "./atomic-write";
import { BRIEF_BEGIN, briefMarkersIntact, withoutBriefSection } from "./agent-brief";

/** Rewrites `file` only when `change` alters it; a symlink is edited at its target so the link survives. */
export async function rewriteIfChanged(
  file: string,
  change: (content: string) => string,
): Promise<void> {
  let linked = false;
  try {
    linked = (await fs.lstat(file)).isSymbolicLink();
  } catch {
    // no file yet
  }
  const real = linked ? await fs.realpath(file).catch(() => file) : file;
  let content: string | null = null;
  try {
    content = await fs.readFile(real, "utf-8");
  } catch {
    // no file yet
  }
  if (content !== null && content.includes(BRIEF_BEGIN) && !briefMarkersIntact(content)) {
    console.warn(
      `[aya] left ${file} untouched: its aya brief markers are damaged; delete the aya:brief lines to reset`,
    );
    return;
  }
  const next = change(content ?? "");
  if (next === (content ?? "")) return;
  if (!next && content !== null) {
    // The file held nothing but our section: we created it, so it goes -
    // unless it is a link's target, which the user owns; empty it instead.
    if (linked) await fs.writeFile(real, "");
    else await fs.rm(file, { force: true });
    return;
  }
  if (linked) await fs.writeFile(real, next);
  else await writeFileAtomic(file, next);
}

/** Codex now gets its brief at launch, so the AGENTS.md files in `registry` lose Aya's old section once and the list
 *  goes; an unreadable list or a failed rewrite keeps the list for the next start. */
export async function dropCodexBriefSections(
  registry: string,
  rewrite: (file: string, change: (content: string) => string) => Promise<void> = rewriteIfChanged,
): Promise<void> {
  let files: unknown;
  try {
    files = JSON.parse(await fs.readFile(registry, "utf-8"));
  } catch {
    return;
  }
  if (!Array.isArray(files)) return;
  try {
    for (const file of files.filter((f): f is string => typeof f === "string")) await rewrite(file, withoutBriefSection);
  } catch (err) {
    console.warn("[aya] could not remove an old aya brief from a Codex AGENTS.md:", err);
    return;
  }
  await fs.rm(registry, { force: true });
}
