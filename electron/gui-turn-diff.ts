// Per-turn diffs for Conversation GUI panes. At the start and the end of every turn Aya records the working tree as a
// git tree object, built in a private temporary index (`GIT_INDEX_FILE`), so the user's index, stash list, refs and
// files are never touched. The diff between the two trees is what the agent changed in that turn, without edits made
// before it or a pull/rebase done between turns. Idea after T3 Code's checkpoints (MIT); T3 keeps them as hidden refs,
// Aya keeps the tree ids in the conversation instead and says so when git has since pruned them.
import { spawn } from 'node:child_process';
import { copyFile,mkdtemp,rm,stat,utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

/** A snapshot slower than this is abandoned; the repository is then skipped for the rest of the session. */
export const SNAPSHOT_TIME_LIMIT_MS = 3000;
const DIFF_TIMEOUT_MS = 8000;
const DIFF_MAX_BYTES = 5_000_000;
const TRUNCATED_MARKER = '[Diff shortened to stay within the 5 MB limit.]';
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export interface WorkingTreeSnapshot { root: string; tree: string; head: string | null }
export interface TurnDiffFile { path: string; additions: number | null; deletions: number | null }
/** What the conversation keeps for one finished turn: enough to show its diff again after a restart. */
export interface TurnDiffSummary { id: string; turnId: string; root: string; start: string; end: string; startHead: string | null; files: TurnDiffFile[] }
export interface DiffCommit { sha: string; short: string; subject: string; author: string; date: string }

interface GitResult { code: number | null; stdout: string; truncated: boolean; timedOut: boolean }

function git(cwd: string, args: string[], options: { env?: NodeJS.ProcessEnv; timeoutMs?: number; maxBytes?: number; input?: string } = {}): Promise<GitResult> {
  return new Promise(resolve => {
    const child = spawn('git', ['-c', 'core.quotePath=false', ...args], { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', ...options.env }, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const chunks: Buffer[] = []; let bytes = 0, truncated = false, timedOut = false, settled = false;
    const max = options.maxBytes ?? DIFF_MAX_BYTES;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, options.timeoutMs ?? DIFF_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      if (truncated) return;
      if (bytes + chunk.length > max) { chunks.push(chunk.subarray(0, max - bytes)); bytes = max; truncated = true; child.kill('SIGKILL'); return; }
      chunks.push(chunk); bytes += chunk.length;
    });
    const done = (code: number | null) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ code, stdout: Buffer.concat(chunks).toString('utf8'), truncated, timedOut }); };
    child.on('error', () => done(null));
    child.on('close', code => done(code));
  });
}

const ok = (result: GitResult) => result.code === 0 && !result.timedOut;

/** The repository that holds `cwd`: its top level, the path of `cwd` inside it, and its index file. Null outside git. */
export async function repositoryOf(cwd: string): Promise<{ root: string; prefix: string; index: string } | null> {
  const result = await git(cwd, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-path', 'index', '--path-format=relative', '--show-prefix'], { timeoutMs: 2000, maxBytes: 64 * 1024 });
  if (!ok(result)) return null;
  const [root, index, prefix = ''] = result.stdout.split('\n');
  return root && index ? { root, index, prefix } : null;
}

/** Record the working tree (tracked and untracked files, minus ignored ones) as a tree object. Null when `cwd` is not
 *  in a git repository, or when it takes longer than `timeLimitMs`. */
export async function snapshotWorkingTree(cwd: string, timeLimitMs = SNAPSHOT_TIME_LIMIT_MS): Promise<WorkingTreeSnapshot | null> {
  const deadline = Date.now() + timeLimitMs;
  const left = () => Math.max(1, deadline - Date.now());
  const repo = await repositoryOf(cwd);
  if (!repo) return null;
  const dir = await mkdtemp(path.join(tmpdir(), 'aya-turn-'));
  try {
    const index = path.join(dir, 'index');
    // Starting from a copy of the real index lets `git add` skip files whose stat data is unchanged. The copy keeps the
    // original modification time, or every entry would look racily clean and be hashed again.
    const existing = await stat(repo.index).catch(() => null);
    if (existing) { await copyFile(repo.index, index); await utimes(index, existing.atime, existing.mtime); }
    const env = { GIT_INDEX_FILE: index };
    const config = ['-c', 'core.splitIndex=false', '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false'];
    if (!ok(await git(repo.root, [...config, 'add', '-A', '--', '.'], { env, timeoutMs: left(), maxBytes: 64 * 1024 }))) return null;
    const tree = await git(repo.root, [...config, 'write-tree'], { env, timeoutMs: left(), maxBytes: 1024 });
    if (!ok(tree) || !OBJECT_ID.test(tree.stdout.trim())) return null;
    const head = await git(repo.root, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { timeoutMs: left(), maxBytes: 1024 });
    return { root: repo.root, tree: tree.stdout.trim(), head: ok(head) && OBJECT_ID.test(head.stdout.trim()) ? head.stdout.trim() : null };
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const finishDiff = (result: GitResult) => result.truncated ? `${result.stdout.slice(0, result.stdout.lastIndexOf('\n') + 1)}${TRUNCATED_MARKER}` : result.stdout.trimEnd();

/** Files that differ between two trees, with added and removed line counts (null for binary files). */
export async function changedFiles(cwd: string, from: string, to: string): Promise<TurnDiffFile[]> {
  const result = await git(cwd, ['diff', '--no-ext-diff', '--no-renames', '--numstat', '-z', from, to, '--']);
  if (!ok(result)) throw Error('Aya could not compare the snapshots.');
  return result.stdout.split('\0').filter(Boolean).map(record => {
    const [added, removed, ...file] = record.split('\t');
    return { path: file.join('\t'), additions: added === '-' ? null : Number(added), deletions: removed === '-' ? null : Number(removed) };
  });
}

/** The unified diff between two snapshot trees. Throws a readable message when git no longer has them. */
export async function diffSnapshots(cwd: string, from: string, to: string): Promise<string> {
  if (!OBJECT_ID.test(from) || !OBJECT_ID.test(to)) throw Error('Invalid snapshot');
  const exists = await git(cwd, ['cat-file', '-e', `${from}^{tree}`], { timeoutMs: 2000 }).then(async first => ok(first) && ok(await git(cwd, ['cat-file', '-e', `${to}^{tree}`], { timeoutMs: 2000 })));
  if (!exists) throw Error('This turn\'s snapshot is no longer in the repository (git may have pruned it).');
  const result = await git(cwd, ['diff', '--no-ext-diff', '--no-color', '-M', from, to, '--']);
  if (result.code !== 0 && !result.truncated) throw Error(result.timedOut ? 'The diff took too long to build.' : 'Aya could not build the diff.');
  return finishDiff(result);
}

async function revision(cwd: string, ref: string): Promise<string | null> {
  const result = await git(cwd, ['rev-parse', '--verify', '-q', '--end-of-options', `${ref}^{commit}`], { timeoutMs: 2000, maxBytes: 1024 });
  return ok(result) && OBJECT_ID.test(result.stdout.trim()) ? result.stdout.trim() : null;
}

/** Commits of this branch: those not on the default branch (origin/HEAD, main or master), or, when HEAD is on the
 *  default branch itself, those made since `since` (the HEAD the conversation's first recorded turn started at). */
export async function listBranchCommits(cwd: string, since: string | null, limit = 100): Promise<{ base: string | null; label: string; commits: DiffCommit[] }> {
  const head = await revision(cwd, 'HEAD');
  if (!head) return { base: null, label: '', commits: [] };
  const originHead = await git(cwd, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], { timeoutMs: 2000, maxBytes: 1024 });
  const candidates = [...(ok(originHead) && originHead.stdout.trim() ? [originHead.stdout.trim()] : []), 'origin/main', 'origin/master', 'main', 'master'];
  let base: string | null = null, label = '';
  for (const name of candidates) {
    if (!await revision(cwd, name)) continue;
    const mergeBase = await git(cwd, ['merge-base', 'HEAD', name], { timeoutMs: 2000, maxBytes: 1024 });
    const found = mergeBase.stdout.trim();
    if (ok(mergeBase) && found && found !== head) { base = found; label = `Commits not on ${name}`; }
    break;
  }
  if (!base && since && OBJECT_ID.test(since) && since !== head) {
    const ancestor = await git(cwd, ['merge-base', '--is-ancestor', since, 'HEAD'], { timeoutMs: 2000 });
    if (ok(ancestor)) { base = since; label = 'Commits made during this conversation'; }
  }
  if (!base) return { base: null, label: '', commits: [] };
  const log = await git(cwd, ['log', `--max-count=${limit}`, '--format=%H%x1f%h%x1f%s%x1f%an%x1f%cI%x1e', `${base}..HEAD`, '--'], { maxBytes: 1_000_000 });
  if (!ok(log)) return { base, label, commits: [] };
  const commits = log.stdout.split('\x1e').map(row => row.trim()).filter(Boolean).map(row => {
    const [sha, short, subject, author, date] = row.split('\x1f');
    return { sha, short, subject, author, date };
  });
  return { base, label, commits };
}

/** One commit's own changes (against its first parent). */
export async function commitDiff(cwd: string, sha: string): Promise<string> {
  if (!OBJECT_ID.test(sha) || !await revision(cwd, sha)) throw Error('That commit is not in this repository.');
  const result = await git(cwd, ['show', '--format=', '--patch', '--no-color', '--no-ext-diff', '-M', '--diff-merges=first-parent', sha, '--']);
  if (result.code !== 0 && !result.truncated) throw Error('Aya could not read that commit.');
  return finishDiff(result);
}

let nextSummaryId = 0;

/** Start and end snapshots of the running turn of every GUI pane. */
export class GuiTurnDiffs {
  private active = new Map<string, Promise<WorkingTreeSnapshot | null>>();
  /** Repositories whose snapshot was too slow; they are not snapshotted again until Aya restarts. */
  private slow = new Set<string>();

  private async take(cwd: string) {
    const repo = await repositoryOf(cwd).catch(() => null);
    if (!repo || this.slow.has(repo.root)) return null;
    const started = Date.now();
    const snapshot = await snapshotWorkingTree(cwd).catch(() => null);
    if (!snapshot && Date.now() - started >= SNAPSHOT_TIME_LIMIT_MS - 50) this.slow.add(repo.root);
    return snapshot;
  }

  /** Called before a message that starts a turn goes to the agent, so the snapshot cannot include its first edit. */
  async beginTurn(key: string, cwd: string) {
    if (this.active.has(key)) return;
    const pending = this.take(cwd);
    this.active.set(key, pending);
    await pending;
  }

  /** The tree the running turn started from, if any. */
  async currentStart(key: string) { return this.active.get(key) ?? null; }

  /** Watch a pane's events: a turn the agent started by itself gets a (late) start snapshot, and a finished turn that
   *  changed files is reported with an `aya/turnDiff` event. */
  observe(key: string, cwd: string, payload: { method?: string; params?: Record<string, unknown> }, emit: (event: { method: string; params: Record<string, unknown> }) => void) {
    if (payload.method === 'aya/disconnected') { this.active.delete(key); return; }
    if (payload.method === 'turn/started' && !this.active.has(key)) this.active.set(key, this.take(cwd));
    if (payload.method !== 'turn/completed') return;
    const pending = this.active.get(key);
    if (!pending) return;
    this.active.delete(key);
    const turn = payload.params?.turn && typeof payload.params.turn === 'object' ? payload.params.turn as Record<string, unknown> : {};
    void (async () => {
      const start = await pending;
      if (!start) return;
      const end = await this.take(cwd);
      if (!end || end.tree === start.tree) return;
      const files = await changedFiles(start.root, start.tree, end.tree).catch(() => []);
      if (!files.length) return;
      const summary: TurnDiffSummary = { id: `turn-diff-${Date.now().toString(36)}-${++nextSummaryId}`, turnId: typeof turn.id === 'string' ? turn.id : '', root: start.root, start: start.tree, end: end.tree, startHead: start.head, files };
      emit({ method: 'aya/turnDiff', params: { turnDiff: summary } });
    })().catch(() => {});
  }

  forget(key: string) { this.active.delete(key); }
}

/** The `codex-gui` IPC actions behind the diff viewer. `cwd` comes from the main process's record of the pane. */
export async function handleGuiDiffAction(diffs: GuiTurnDiffs, key: string, cwd: string, action: string, value: unknown): Promise<unknown> {
  const request = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const repo = await repositoryOf(cwd);
  if (!repo) throw Error('This folder is not in a git repository.');
  const where = { root: repo.root, prefix: repo.prefix };
  if (action === 'diff-turn') {
    const start = typeof request.start === 'string' ? request.start : null;
    const end = typeof request.end === 'string' ? request.end : null;
    if (start && end) return { ...where, diff: await diffSnapshots(repo.root, start, end) };
    // The running turn: from its start snapshot to the working tree now.
    const current = await (await diffs.currentStart(key));
    if (!current) throw Error('No snapshot was recorded for the current turn.');
    const now = await snapshotWorkingTree(cwd);
    if (!now) throw Error('Aya could not record the working tree in time.');
    return { ...where, start: current.tree, startHead: current.head, diff: await diffSnapshots(repo.root, current.tree, now.tree) };
  }
  if (action === 'diff-commits') return { ...where, ...await listBranchCommits(repo.root, typeof request.since === 'string' ? request.since : null) };
  if (action === 'diff-commit') return { ...where, diff: await commitDiff(repo.root, String(request.sha || '')) };
  throw Error('Unknown diff action');
}
