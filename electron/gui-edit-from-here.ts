// "Edit from here" in the Conversation GUI: Aya-side workspace snapshots for
// git worktree panes, and the checks that keep a file revert inside the pane's cwd.
// Idea after T3 Code's checkpoints (MIT); no code copied.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { snapshotWorkingTree } from './gui-turn-diff';

interface GitResult { stdout: string }
function git(cwd: string, args: string[], env: Record<string, string> = {}, input?: string): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, { cwd, env: { ...process.env, ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 64 * 1024 * 1024, timeout: 30000 }, (error, stdout) => {
      if (error) reject(error); else resolve({ stdout: String(stdout) });
    });
    if (input !== undefined) child.stdin?.end(input);
  });
}

export interface SnapshotWorkspace { top: string; prefix: string; cwd: string }
const support = new Map<string, { at: number; value: SnapshotWorkspace | null }>();

/** A snapshot is offered only in a linked git worktree: there a revert cannot
 *  clobber the main checkout the user edits by hand. */
export async function snapshotWorkspace(cwd: string): Promise<SnapshotWorkspace | null> {
  const cached = support.get(cwd);
  if (cached && Date.now() - cached.at < 60000) return cached.value;
  let value: SnapshotWorkspace | null = null;
  try {
    const real = await realpath(cwd);
    const [top, prefix, gitDir, commonDir] = (await git(real, ['rev-parse', '--show-toplevel', '--show-prefix', '--git-dir', '--git-common-dir'])).stdout.split('\n');
    if (top && gitDir && commonDir && path.resolve(real, gitDir) !== path.resolve(real, commonDir)) value = { top: await realpath(top), prefix, cwd: real };
  } catch { value = null; }
  support.set(cwd, { at: Date.now(), value });
  return value;
}

/** The working tree (tracked and untracked, ignored and very large files excluded) as a git tree, written through a
 *  temporary index so the user's index and refs stay untouched (gui-turn-diff.ts). A send's checkpoint is the turn's
 *  start snapshot; this one is for the revert, which the user waits for. */
async function workingTree(ws: SnapshotWorkspace): Promise<string> {
  const snapshot = await snapshotWorkingTree(ws.cwd, 30000);
  if (!snapshot) throw Error('Aya could not record the working tree');
  return snapshot.tree;
}

export async function takeWorkspaceSnapshot(cwd: string): Promise<string | undefined> {
  const ws = await snapshotWorkspace(cwd);
  if (!ws) return undefined;
  try { return await workingTree(ws); } catch { return undefined; }
}

/** The tree `checkpoint` recorded (the turn's start snapshot), when cwd is a linked worktree and the tree is its own. */
export async function workspaceCheckpoint(cwd: string, checkpoint: () => Promise<{ root: string; tree: string } | null>): Promise<string | undefined> {
  const ws = await snapshotWorkspace(cwd);
  if (!ws) return undefined;
  const snapshot = await checkpoint().catch(() => null);
  if (!snapshot) return undefined;
  return await realpath(snapshot.root).catch(() => snapshot.root) === ws.top ? snapshot.tree : undefined;
}

export async function snapshotAvailable(cwd: string, tree: unknown): Promise<boolean> {
  if (typeof tree !== 'string' || !/^[0-9a-f]{40,64}$/.test(tree)) return false;
  const ws = await snapshotWorkspace(cwd);
  if (!ws) return false;
  try { return (await git(ws.top, ['cat-file', '-t', tree])).stdout.trim() === 'tree'; } catch { return false; }
}

/** True when target lies inside root (both already absolute). */
export function insideDirectory(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Paths whose content changed between two trees, restricted to the workspace prefix. Gitlinks are skipped. */
export function parseRawDiff(output: string, prefix: string): { path: string; status: string }[] {
  const parts = output.split('\0');
  const changes: { path: string; status: string }[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i].replace(/^\n/, ''), file = parts[i + 1];
    const match = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*$/.exec(meta);
    if (!match || !file) continue;
    if (match[1] === '160000' || match[2] === '160000') continue;
    if (prefix && !file.startsWith(prefix)) continue;
    if (file.split('/').includes('..')) continue;
    changes.push({ path: file, status: match[3] });
  }
  return changes;
}

/** Put the files under cwd back to the snapshot: files added since are removed,
 *  changed and deleted ones are written back. Ignored files are left alone. */
export async function restoreWorkspaceSnapshot(cwd: string, tree: string): Promise<{ restored: number; removed: number }> {
  if (!await snapshotAvailable(cwd, tree)) throw Error('The saved snapshot for this message is no longer available');
  const ws = (await snapshotWorkspace(cwd))!;
  const current = await workingTree(ws);
  const raw = (await git(ws.top, ['diff-tree', '-r', '-z', '--raw', '--no-renames', tree, current, '--', ws.prefix || '.'])).stdout;
  const changes = parseRawDiff(raw, ws.prefix);
  const removed = changes.filter(c => c.status === 'A'), restored = changes.filter(c => c.status !== 'A');
  for (const change of removed) {
    const file = path.join(ws.top, change.path);
    if (!insideDirectory(ws.cwd, file)) continue;
    try { if (!(await lstat(file)).isDirectory()) await unlink(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    for (let dir = path.dirname(file); insideDirectory(ws.cwd, dir) && dir !== ws.cwd; dir = path.dirname(dir)) {
      try { await rmdir(dir); } catch { break; }
    }
  }
  if (restored.length) {
    const index = path.join(tmpdir(), `aya-restore-${randomUUID()}.index`);
    try {
      const env = { GIT_INDEX_FILE: index };
      await git(ws.top, ['read-tree', tree], env);
      for (const change of restored) await mkdir(path.dirname(path.join(ws.top, change.path)), { recursive: true });
      await git(ws.top, ['checkout-index', '-f', '-z', '--stdin'], env, restored.filter(c => insideDirectory(ws.cwd, path.join(ws.top, c.path))).map(c => c.path).join('\0') + '\0');
    } finally { await unlink(index).catch(() => {}); }
  }
  return { restored: restored.length, removed: removed.length };
}

/** What a sent user message records so the conversation can later be rewound to just before it. */
export interface EditSendInfo { claudeUser?: string; codexTurn?: string }
/** Where to rewind: the message's own ids, and for Claude the transcript head before it (null: the first message). */
export interface EditTarget extends EditSendInfo { resumeAt?: string | null; snapshot?: string }
