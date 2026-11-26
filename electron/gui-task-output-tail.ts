// Tails the output file Claude Code writes for a running shell task, so a subagent's command output shows while it
// runs (stream-json only carries it in the tool result, after the command ends).
// Ported from T3 Code's ClaudeTaskOutputTail.ts (MIT, https://github.com/pingdotgg/t3code); Claude's file layout is
// private and can change, so every failure just leaves the live output out.
import { open, readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';

export const TASK_OUTPUT_POLL_MS = 250;
/** Give up looking when Claude never writes the file (40 polls, about 10 s). */
const MAX_LOCATE_ATTEMPTS = 40;
/** A fast writer is skipped ahead: only the tail is shown. */
export const TASK_OUTPUT_MAX_READ_BYTES = 256 * 1024;

/** Claude Code's per-user temp root, `<tmp>/claude-<uid>`, or undefined where there is no uid (Windows). */
export function claudeTaskOutputRoot(env: NodeJS.ProcessEnv, cwd: string, platform: NodeJS.Platform = process.platform, uid: number | null = process.getuid?.() ?? null): string | undefined {
  if (uid === null) return undefined;
  // Claude's macOS build uses /tmp and ignores the TMPDIR launchd sets; its other builds use os.tmpdir().
  // A relative value is relative to Claude's working directory.
  const fallback = platform === 'darwin' ? '/tmp' : env.TMPDIR || env.TMP || env.TEMP || '/tmp';
  return path.resolve(cwd, env.CLAUDE_CODE_TMPDIR?.trim() || fallback, `claude-${uid}`);
}

/** The project directory a session's task file was found in, so its other tasks skip the scan. */
const sessionProjects = new Map<string, string>();

/** `<root>/<project>/<session>/tasks/<task>.output`. The project directory is Claude's slug of the working
 *  directory; it is tried first (with the one this session's earlier tasks were found in), then, when `scan`, every
 *  project directory that holds the session, since the slug rules are Claude's own. */
export async function locateClaudeTaskOutput(root: string, cwd: string, sessionId: string, taskId: string, scan = true): Promise<string | null> {
  const exists = async (file: string, directory = false) => { try { const info = await stat(file); return directory ? info.isDirectory() : info.isFile(); } catch { return false; } };
  const inProject = (project: string) => path.join(root, project, sessionId, 'tasks', `${taskId}.output`);
  const key = `${root}\0${sessionId}`, known = sessionProjects.get(key);
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  for (const project of new Set([known, slug].filter((p): p is string => !!p))) if (await exists(inProject(project))) { sessionProjects.set(key, project); return inProject(project); }
  if (!scan) return null;
  let projects: string[] = [];
  try { projects = await readdir(root); } catch { return null; }
  for (const project of projects) {
    if (project === slug || project === known || !await exists(path.join(root, project, sessionId), true)) continue;
    if (sessionProjects.size > 200) sessionProjects.clear();
    sessionProjects.set(key, project);
    if (await exists(inProject(project))) return inProject(project);
  }
  return null;
}

/** Whether the locate attempt numbered `attempt` (from 1) scans every project directory: 1, 2, 4, 8… */
export const scansOnAttempt = (attempt: number) => (attempt & (attempt - 1)) === 0;

export interface TaskOutputTailOptions {
  /** The file when Claude named it; otherwise it is looked for under `root`. */
  file?: string;
  root?: string;
  cwd: string;
  sessionId: string;
  taskId: string;
  onChunk: (chunk: string) => void;
  pollMs?: number;
}

/** Polls one task's output file and reports what was appended. `stop()` reads once more, then ends. */
export class TaskOutputTail {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private file: string | null;
  private offset = 0;
  private decoder = new TextDecoder('utf-8', { fatal: false });
  private attempts = 0;
  private ended = false;
  private stopping = false;
  private running: Promise<void> | null = null;

  constructor(private readonly options: TaskOutputTailOptions) {
    this.file = options.file || null;
    this.schedule();
  }

  get active() { return !this.ended; }

  private schedule() {
    if (this.ended || this.stopping) return;
    this.timer = setTimeout(() => { this.timer = null; this.running = this.poll().finally(() => { this.running = null; this.schedule(); }); }, this.options.pollMs ?? TASK_OUTPUT_POLL_MS);
    this.timer.unref?.();
  }

  private async poll() {
    if (!this.file) {
      if (!this.options.root || ++this.attempts > MAX_LOCATE_ATTEMPTS) { this.dispose(); return; }
      // The slug (and the session's known project) every poll, the full scan with back-off.
      this.file = await locateClaudeTaskOutput(this.options.root, this.options.cwd, this.options.sessionId, this.options.taskId, scansOnAttempt(this.attempts));
      if (!this.file) return;
    }
    let size: number;
    try { size = (await stat(this.file)).size; } catch { return; }
    if (size < this.offset) { this.offset = 0; this.decoder = new TextDecoder('utf-8', { fatal: false }); }
    if (size <= this.offset) return;
    const start = size - this.offset > TASK_OUTPUT_MAX_READ_BYTES ? size - TASK_OUTPUT_MAX_READ_BYTES : this.offset;
    let bytes: Buffer;
    try {
      const handle = await open(this.file, 'r');
      try {
        bytes = Buffer.alloc(size - start);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, start);
        bytes = bytes.subarray(0, bytesRead);
      } finally { await handle.close(); }
    } catch { return; }
    // Skipped output must not splice two unrelated lines together, nor start inside a UTF-8 character.
    const skipped = start > this.offset;
    let first = 0;
    if (skipped) {
      this.decoder = new TextDecoder('utf-8', { fatal: false });
      while (first < bytes.length && (bytes[first]! & 0xc0) === 0x80) first++;
    }
    this.offset = start + bytes.length;
    const chunk = (skipped ? '\n' : '') + this.decoder.decode(bytes.subarray(first), { stream: true });
    if (chunk && !this.ended) this.options.onChunk(chunk);
  }

  /** Reads what the task wrote last, then ends. */
  async stop() {
    if (this.ended || this.stopping) return;
    this.stopping = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    await this.running;
    if (this.ended) return;
    if (this.file) await this.poll();
    const rest = this.decoder.decode();
    this.dispose();
    if (rest) this.options.onChunk(rest);
  }

  /** Ends at once, without a last read. */
  dispose() {
    this.ended = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }
}
