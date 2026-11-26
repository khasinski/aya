// Pure helpers behind "Changes in this turn" and "Open diff" in a Conversation GUI pane (snapshots are taken by
// electron/gui-turn-diff.ts).

export interface TurnDiffFile { path: string; additions: number | null; deletions: number | null }
/** A finished turn that changed files: the snapshot trees it started and ended at. */
export interface TurnDiffSummary { id: string; turnId: string; root: string; start: string; end: string; startHead: string | null; files: TurnDiffFile[] }

const obj = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const str = (value: unknown) => typeof value === 'string' ? value : '';

export function isTurnDiffSummary(value: unknown): value is TurnDiffSummary {
  const v = obj(value);
  return typeof v.id === 'string' && typeof v.start === 'string' && typeof v.end === 'string' && Array.isArray(v.files);
}

/** Files a `fileChange` activity edited: Codex lists `changes`, Claude's Edit/Write calls carry one change, and Pi
 *  and Antigravity put the path in `command`. */
export function fileChangePaths(item: Record<string, unknown>): string[] {
  if (item.type !== 'fileChange') return [];
  const changes = Array.isArray(item.changes) ? item.changes.map(change => str(obj(change).path)).filter(Boolean) : [];
  if (changes.length) return [...new Set(changes)];
  const named = str(item.path) || str(item.command);
  return named && named !== str(item.tool) && !/\s/.test(named.trim()) ? [named.trim()] : [];
}

/** A file path as it appears in the diff (`b/<path>`): relative to the repository root. Agents report absolute paths
 *  or paths relative to the pane's folder (`cwd`, which is `prefix` inside the repository). */
export function repoRelativePath(file: string, where: { root: string; prefix: string; cwd: string }): string {
  const trim = (value: string) => value.replace(/\/+$/, '');
  const root = trim(where.root), cwd = trim(where.cwd), prefix = where.prefix.replace(/^\/+/, '');
  if (file.startsWith(root + '/')) return file.slice(root.length + 1);
  if (file.startsWith(cwd + '/')) return prefix + file.slice(cwd.length + 1);
  // macOS reports /private/var/... for /var/...; compare without that prefix.
  const plain = (value: string) => value.replace(/^\/private(?=\/)/, '');
  if (plain(file).startsWith(plain(root) + '/')) return plain(file).slice(plain(root).length + 1);
  if (file.startsWith('/')) return file;
  return prefix + file.replace(/^\.\//, '');
}

export function turnDiffSummaryText(files: readonly TurnDiffFile[]): string {
  const added = files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const removed = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
  return `${files.length} ${files.length === 1 ? 'file' : 'files'} changed · +${added} −${removed}`;
}

/** The diff viewer's choices: "turn:<id>", "current" (the running turn so far) or "commit:<sha>". */
export type DiffSource = { kind: 'turn'; summary: TurnDiffSummary } | { kind: 'current' } | { kind: 'commit'; sha: string };

export function parseDiffSourceId(id: string, turns: readonly TurnDiffSummary[]): DiffSource | null {
  if (id === 'current') return { kind: 'current' };
  if (id.startsWith('turn:')) { const summary = turns.find(turn => turn.id === id.slice(5)); return summary ? { kind: 'turn', summary } : null; }
  if (id.startsWith('commit:') && /^[0-9a-f]{40,64}$/.test(id.slice(7))) return { kind: 'commit', sha: id.slice(7) };
  return null;
}

/** The turn summaries in a conversation's messages. The previous list comes back unchanged while the summaries are
 *  the same, so a streamed message does not hand the open diff viewer a new list (and a re-render) every frame. */
export function turnDiffsOf(messages: readonly { type: string; turnDiff?: TurnDiffSummary }[], previous: readonly TurnDiffSummary[] = []): readonly TurnDiffSummary[] {
  const next = messages.flatMap(m => m.type === 'turnDiff' && m.turnDiff ? [m.turnDiff] : []);
  return next.length === previous.length && next.every((summary, index) => summary === previous[index]) ? previous : next;
}
