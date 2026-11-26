// "Send to several agents": the planning and bookkeeping behind fanning one
// prompt out to several Conversation GUI agents, each in its own worktree.
// Pure helpers plus two small in-memory registries (the message each new pane
// sends once it connects, and the runs Compare can reopen). Both live for this
// renderer session only; the worktrees and branches stay in git.

export const FAN_OUT_MAX_CHOICES = 6;
export const FAN_OUT_OPEN_EVENT = "aya:fan-out";
export const FAN_OUT_COMPARE_EVENT = "aya:fan-out-compare";

export interface FanOutAttachment { id: string; name: string; image: boolean }
/** What the dialog opens with: the composer's draft, and where its files live. */
export interface FanOutDraft {
  projectSlug?: string;
  text?: string;
  /** The pane that owns the attachments (they are copied by id from it). */
  sourceTerminalId?: string;
  attachments?: FanOutAttachment[];
}

export function slugify(text: string, max = 32): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/g, "");
}

/** A short worktree name from the prompt's first words ("Fix the login bug" -> "fix-the-login-bug"). */
export function fanOutSlug(prompt: string): string {
  let slug = "";
  for (const word of prompt.split(/\s+/).map(w => slugify(w, 24)).filter(Boolean).slice(0, 5)) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > 24) break;
    slug = next;
  }
  return slug || "fan-out";
}

/** The worktree name for each chosen preset: `<slug>-<preset>`, and a second
 *  pick of the same preset name gets `-2`, `-3`. Names stay git-safe. */
export function planFanOut<T extends { id: string; name: string }>(slug: string, presets: T[]): { preset: T; name: string }[] {
  const base = slugify(slug, 32) || "fan-out";
  const used = new Set<string>();
  return presets.map(preset => {
    const stem = `${base}-${slugify(preset.name, 24) || slugify(preset.id, 24) || "agent"}`;
    let name = stem;
    for (let n = 2; used.has(name); n++) name = `${stem}-${n}`;
    used.add(name);
    return { preset, name };
  });
}

export type FanOutOutcome<T> =
  | { preset: T; name: string; ok: true; path: string; branch: string; terminalId: string }
  | { preset: T; name: string; ok: false; error: string };

/** One sentence for the status line after a run. */
export function fanOutSummary(outcomes: { ok: boolean }[]): string {
  const started = outcomes.filter(o => o.ok).length, failed = outcomes.length - started;
  const agents = (n: number) => `${n} agent${n === 1 ? "" : "s"}`;
  if (!failed) return `Started ${agents(started)}.`;
  if (!started) return `No agent started: ${agents(failed)} could not get a worktree.`;
  return `Started ${agents(started)}. ${agents(failed)} could not get a worktree.`;
}

export interface FanOutMessage { text: string; attachments: { from: string; ids: string[] } | null }
const pendingMessages = new Map<string, FanOutMessage>();
/** Queue the prompt a new pane sends once its agent connects. */
export function queueFanOutMessage(terminalId: string, message: FanOutMessage): void { pendingMessages.set(terminalId, message); }
/** Take (once) the prompt queued for this pane. */
export function takeFanOutMessage(terminalId: string): FanOutMessage | null {
  const message = pendingMessages.get(terminalId) ?? null;
  pendingMessages.delete(terminalId);
  return message;
}

export interface FanOutRunBranch { terminalId: string; label: string; branch: string; path: string }
export interface FanOutRun { id: string; projectSlug: string; projectDir: string; base: string; baseLabel: string; branches: FanOutRunBranch[] }
const runs = new Map<string, FanOutRun>();
export function recordFanOutRun(run: FanOutRun): void { runs.set(run.id, run); }
export function fanOutRun(id: string): FanOutRun | null { return runs.get(id) ?? null; }
/** The run a pane was started by, so its composer can offer Compare. */
export function fanOutRunForTerminal(terminalId: string): FanOutRun | null {
  for (const run of runs.values()) if (run.branches.some(b => b.terminalId === terminalId)) return run;
  return null;
}

export function requestFanOut(draft: FanOutDraft): void {
  window.dispatchEvent(new CustomEvent<FanOutDraft>(FAN_OUT_OPEN_EVENT, { detail: draft }));
}
export function requestFanOutCompare(runId: string): void {
  window.dispatchEvent(new CustomEvent<{ runId: string }>(FAN_OUT_COMPARE_EVENT, { detail: { runId } }));
}

/** How many files a unified diff changes, counted without splitting it into lines (a branch's diff can be large). */
export function diffFileCount(diff: string): number {
  let count = diff.startsWith("diff --git") ? 1 : 0;
  for (let at = diff.indexOf("\ndiff --git"); at >= 0; at = diff.indexOf("\ndiff --git", at + 1)) count++;
  return count;
}

/** A compare tab's summary: "…" while the diff loads, "no changes", or "3 files". */
export function diffStatsText(files: number | null | undefined): string {
  if (files === null || files === undefined) return "…";
  return files === 0 ? "no changes" : `${files} file${files === 1 ? "" : "s"}`;
}
