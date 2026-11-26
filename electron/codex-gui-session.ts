import { GuiProtocolWriter } from './gui-protocol-writer';
import { GuiJsonLines, skipMalformedLine } from './gui-json-lines';
import { PROGRESS_TOOL, progressUpdate } from './gui-progress';
import type { GuiProgress } from '../shared/gui-progress';
import { CODEX_PROMPT_SUGGESTION_PROMPT, cleanPromptSuggestion, codexContextUsage, codexSkills, type GuiSkill } from './gui-composer-assist';
// Development PoC: Codex owns the agent loop and policies; Aya owns presentation.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import type { GuiEvent, GuiArtifact, GuiApprovalDecision } from '../shared/codex-gui';
import { codexPermissionPolicy, initialGuiPermissionMode, pendingApprovalsNotice, type GuiPermissionMode } from '../shared/gui-permission-mode.cjs';
import type { EditSendInfo, EditTarget } from './gui-edit-from-here';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === 'string' ? value : '';
const receivers = (item: Record<string, unknown> | undefined): string[] => Array.isArray(item?.receiverThreadIds) ? item.receiverThreadIds.filter((thread): thread is string => typeof thread === 'string') : [];
/** Codex's `subAgentActivity` item of kind `started`, shown as the spawnAgent call older Codex reported. It carries no
 *  task, so the agent's path names it ("/root/run_tests" → "run tests"). Other kinds return null. */
function subagentActivitySpawn(item: Record<string, unknown>, senderThreadId: string): Record<string, unknown> | null {
  if (item.kind !== 'started' || !text(item.id)) return null;
  const thread = text(item.agentThreadId), name = text(item.agentPath).split('/').filter(Boolean).at(-1)?.replace(/_/g, ' ') ?? '';
  return { type: 'collabAgentToolCall', tool: 'spawnAgent', id: text(item.id), status: item.completedAtMs ? 'completed' : 'inProgress', senderThreadId, receiverThreadIds: thread ? [thread] : [], prompt: name, model: item.model ?? null, agentsStates: {} };
}
import { PRESENT_TOOL, OPEN_ARTIFACT_TOOL, presentArtifact } from './gui-artifact-tools';
export { PRESENT_TOOL, OPEN_ARTIFACT_TOOL, workspaceImage, presentArtifact } from './gui-artifact-tools';

export class CodexGuiSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private writer: GuiProtocolWriter | null = null;
  private pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private requests = new Map<string | number, { method: string; params: Record<string, unknown> }>();
  private nextId = 0;
  private turnId: string | null = null;
  private startingTurn: Promise<Record<string, unknown>> | null = null;
  private threadId = '';
  private model = '';
  /** Side chats running on forked threads: their notifications never reach the conversation. */
  private sideThreads = new Map<string, { text: string; done: (error?: Error) => void }>();
  /** Spawned subagents' threads and what each was asked to do, from the main thread's collab calls. */
  private subagentThreads = new Map<string, string>();
  /** Spawn calls by item ID, and the running turn of each subagent thread: a spawn call ends at once, but its row
   *  runs (and can be stopped) for as long as its agent's turn does. */
  private subagentSpawns = new Map<string, Record<string, unknown>>();
  private childTurns = new Map<string, string>();
  /** The files of recent file change items by item ID, for their approval requests. */
  private fileChanges = new Map<string, string[]>();
  private busy = false;
  /** The pane's mode, and the one Codex last received; a change goes with the next turn/start. */
  private permissionMode: GuiPermissionMode = 'auto-accept-edits';
  private appliedPermissionMode: GuiPermissionMode = 'auto-accept-edits';
  private samplingEpoch = 0;
  private samplingWaiters = new Set<() => void>();
  get running() { return this.busy; }
  /** The agent process: servers it starts are listed under it (agent-servers.ts). */
  get pid() { return this.child?.pid; }
  private closing = false;
  private artifactIds = new Set<string>();
  private artifactRevisions = new Map<string, number>();
  private progresses = new Map<string, GuiProgress>();
  private stderr = '';
  private promptSuggestions = false;
  private skillList: Promise<GuiSkill[]> | null = null;
  private skillsChanged = false;
  cwd = '';
  constructor(private readonly emit: (event: GuiEvent) => void, private readonly executable = 'codex', private readonly args = ['app-server', '--listen', 'stdio://']) {}
  private write(value: unknown) { if (!this.child || this.child.stdin.destroyed) throw Error('Codex is disconnected'); if (!this.writer) throw Error('Codex is disconnected'); this.writer.write(value); }
  private rpc(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error(`${method} response timed out; the agent may still be working`)); }, 60000); timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  private fail(message: string) {
    this.writer?.close(); this.writer = null;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(Error(message)); }
    this.pending.clear(); this.requests.clear(); this.busy = false; this.turnId = null;
    this.subagentSpawns.clear(); this.childTurns.clear();
    for (const wake of this.samplingWaiters) wake();
    if (!this.closing) this.emit({ method: 'aya/disconnected', params: { message } });
  }
  async connect(cwd: string, model: string, configDir?: string, resumeThreadId?: string, unsafeMode = false, permissionMode?: GuiPermissionMode): Promise<{ threadId: string; model: string; permissionMode?: GuiPermissionMode }> {
    if (this.child) throw Error('Start a new window for a separate PoC session');
    this.permissionMode = this.appliedPermissionMode = permissionMode ?? initialGuiPermissionMode('codex', unsafeMode);
    const policy = codexPermissionPolicy(this.permissionMode);
    this.cwd = await realpath(cwd);
    if (!(await stat(this.cwd)).isDirectory()) throw Error('Workspace must be a directory');
    const env = { ...process.env };
    if (configDir) env.CODEX_HOME = configDir;
    for (const key of ['ELECTRON_RUN_AS_NODE', 'AYA_SOCKET', 'AYA_TERMINAL_ID', 'AYA_PRESET_ID', 'AYA_PROJECT_SLUG', 'AYA_PROJECT_DIR', 'AYA_VIA', 'AYA_REMOTE_SOCKET']) delete env[key];
    this.child = spawn(this.executable, this.args, { cwd: this.cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdin.on('error', () => {});
    this.writer = new GuiProtocolWriter(this.child.stdin, 'Codex', message => { this.fail(message); this.close(); });
    this.child.stderr.on('data', data => { this.stderr = (this.stderr + String(data)).slice(-4000); });
    this.child.stdout.setEncoding('utf8');
    const frames = new GuiJsonLines(undefined, skipMalformedLine('Codex'));
    this.child.stdout.on('data', data => {
      try {
        frames.push(String(data), message => {
          void this.receive(message).catch(error => { this.fail(String(error)); this.close(); });
        });
      } catch (error) {
        this.fail(`Codex: ${error instanceof Error ? error.message : String(error)}`);
        this.close();
      }
    });
    this.child.once('error', error => this.fail(`Cannot start Codex: ${error.message}`));
    this.child.once('exit', code => this.fail(`Codex stopped (${code ?? 'signal'}). ${this.stderr}`));
    try {
      await this.rpc('initialize', { clientInfo: { name: 'aya_gui_poc', title: 'Aya GUI PoC', version: '0.1.0' }, capabilities: { experimentalApi: true } });
      this.write({ method: 'initialized', params: {} });
      // Resume can stream notifications before its RPC response. The saved ID
      // is already known, so filter other threads from the start of the resume.
      if (resumeThreadId) this.threadId = resumeThreadId;
      const result = await this.rpc(resumeThreadId ? 'thread/resume' : 'thread/start', {
        ...(resumeThreadId ? { threadId: resumeThreadId, excludeTurns: true } : {}),
        cwd: this.cwd, ...(model ? { model } : {}), sandbox: policy.sandbox, approvalPolicy: policy.approvalPolicy, approvalsReviewer: policy.approvalsReviewer,
        ...(resumeThreadId ? {} : { dynamicTools: [PRESENT_TOOL, OPEN_ARTIFACT_TOOL, PROGRESS_TOOL] }),
        developerInstructions: 'You are displayed inside Aya GUI, a local graphical frontend for Codex. Respond in the user’s language. You own the normal Codex tool loop, context and sandbox. Use Markdown freely. Messages support syntax-highlighted fenced code blocks (include the language), inline images with ![description](workspace-relative-or-absolute-path) or base64 data image URLs, and Mermaid fenced blocks for diagrams and charts (flowchart, sequenceDiagram, pie, xychart-beta). Prefer these inline formats for visuals that belong in the conversation; no artifact tool is needed. Local images must be inside the selected workspace (PNG/JPEG/WebP/GIF/SVG, up to 8 MiB); remote image URLs are not loaded. Use aya_present for standalone artifacts, metrics and interactive HTML. Set open=true when you want to show a newly created artifact immediately; use aya_open_artifact with its returned artifactId to reopen an existing one. Use HTML widgets for interactive visuals, forms, charts and mockups; use local PNG/JPEG/WebP/SVG files for graphics. Widgets are self-contained and cannot access the network or files. Widget row clicks arrive as user follow-ups. For measurable tasks use aya_progress with a label, actual completed units, total units and optional stage detail. Reuse its returned progressId for updates instead of creating new bars. Do not invent progress for tasks without measurable units. Do not start subagents unless the user requests delegation.',
      });
      this.threadId = text(object(result.thread).id);
      this.model = text(result.model);
      if (!this.threadId) throw Error('Codex did not return a thread ID');
      return { threadId: this.threadId, model: text(result.model) || model || 'Codex default', permissionMode: this.permissionMode };
    } catch (error) { this.close(); throw error; }
  }
  async listConversations() {
    const result = await this.rpc('thread/list', { cwd: this.cwd, limit: 100, sortKey: 'updated_at' });
    return (Array.isArray(result.data) ? result.data : []).map(object).filter(row => row.cwd === this.cwd && typeof row.id === 'string').map(row => ({ id: 'codex:' + text(row.id), title: text(row.name) || text(row.preview) || 'Untitled conversation', updatedAt: Number(row.updatedAt) * 1000, current: row.id === this.threadId }));
  }
  async readConversation(id: string) {
    const result = await this.rpc('thread/read', { threadId: id, includeTurns: false });
    const thread = object(result.thread);
    if (thread.cwd !== this.cwd || thread.id !== id) throw Error('Conversation does not belong to this workspace');
    const messages: { id: string; type: string; text: string; questions?: unknown[] }[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    // Summaries omit bulky tool output. Read newest turns first and retain only
    // the same 500-message window the GUI displays, without hydrating the full rollout.
    for (let page = 0; page < 50 && messages.length < 500; page++) {
      const result = await this.rpc('thread/turns/list', { threadId: id, limit: 10, sortDirection: 'desc', itemsView: 'summary', ...(cursor ? { cursor } : {}) });
      for (const turn of Array.isArray(result.data) ? result.data : []) {
        const items = object(turn).items;
        for (const raw of (Array.isArray(items) ? [...items].reverse() : [])) {
          const item = object(raw);
          if (item.type === 'agentMessage') messages.push({ id: text(item.id), type: 'assistant', text: text(item.text), ...(Array.isArray(item.questions) && item.questions.length ? { questions: item.questions } : {}) });
          if (item.type === 'userMessage') messages.push({ id: text(item.id), type: 'user', text: (Array.isArray(item.content) ? item.content : []).map(object).filter(part => part.type === 'text').map(part => text(part.text)).join('\n') });
          if (messages.length >= 500) break;
        }
        if (messages.length >= 500) break;
      }
      cursor = text(result.nextCursor) || undefined;
      if (!cursor || seen.has(cursor)) break;
      seen.add(cursor);
    }
    messages.reverse();
    return { threadId: id, view: { messages: messages.slice(-500), importNotice: 'Resumed from Codex history. This conversation keeps its original tool configuration. Start a new conversation for the latest Aya widget and progress tools.' } };
  }
  restoreProgress(progresses: GuiProgress[]) { for (const progress of progresses) this.progresses.set(progress.id, progress); }
  restoreArtifacts(artifacts: Pick<GuiArtifact, 'id' | 'revision'>[]) {
    for (const artifact of artifacts) { this.artifactIds.add(artifact.id); this.artifactRevisions.set(artifact.id, artifact.revision || 1); }
  }
  async command(name: string, argument: string) {
    if (!this.threadId) throw Error('Connect to Codex first');
    if (name === 'goal') {
      const params: Record<string, unknown> = { threadId: this.threadId, origin: 'user' };
      if (argument === 'clear') return this.rpc('thread/goal/clear', params);
      if (!argument) return this.rpc('thread/goal/get', params);
      if (argument === 'pause' || argument === 'resume') params.status = argument === 'pause' ? 'paused' : 'active';
      else { params.objective = argument; params.status = 'active'; }
      return this.rpc('thread/goal/set', params);
    }
    if (name === 'compact') return this.rpc('thread/compact/start', { threadId: this.threadId });
    if (name === 'btw') {
      if (!argument.trim()) throw Error('Usage: /btw your side question');
      if (this.busy) return this.sideQuestionWhileWorking(argument);
      // turn/completed can arrive before the sampling source becomes idle.
      // Automatic goal turns can also start between listing the source and sampling it.
      const deadline = Date.now() + 30000;
      let sourceTurnId = "", sourceEpoch = -1, retryDelay = 200;
      while (Date.now() < deadline) {
        if (!this.child || this.closing) throw Error('Codex is disconnected');
        if (!this.busy) {
          if (sourceEpoch !== this.samplingEpoch) {
            const queriedEpoch = this.samplingEpoch;
            const result = await this.rpc('thread/turns/list', { threadId: this.threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
            const last = Array.isArray(result.data) ? object(result.data[0]) : {};
            sourceTurnId = text(last.id); sourceEpoch = queriedEpoch;
            if (!sourceTurnId) throw Error('Send a message before asking a side question.');
          }
          if (!this.busy && sourceEpoch === this.samplingEpoch) {
            try { return await this.rpc('thread/sample', { threadId: this.threadId, expectedTurnId: sourceTurnId, prompt: argument }); }
            catch (error) {
              if (!/sample source must be idle/i.test(error instanceof Error ? error.message : String(error))) throw error;
            }
          }
        }
        // A real running turn wakes us through notifications. Sampling readiness
        // itself has no event, so only that narrow race uses bounded backoff.
        await new Promise<void>(resolve => {
          const wake = () => { clearTimeout(timer); this.samplingWaiters.delete(wake); resolve(); };
          const timer = setTimeout(wake, this.busy ? Math.max(0, deadline - Date.now()) : retryDelay);
          this.samplingWaiters.add(wake);
        });
        retryDelay = Math.min(1000, retryDelay * 2);
      }
      throw Error('Codex is still working and could not answer the side question yet. Stop the current turn or pause the goal, then try /btw again.');
    }
    throw Error(`Unsupported command /${name}. Use /goal, /btw or /compact. Other CLI commands remain available in Terminal mode.`);
  }
  async models() { return this.rpc('model/list', { limit: 100 }); }
  /** Codex takes a mode with a turn; the running turn keeps the one it started with. What the turn asked before the
   *  switch and the new mode would not have asked about is answered for it: everything for Full access, a file change
   *  inside the workspace for Auto-accept edits. */
  async setPermissionMode(mode: GuiPermissionMode) {
    this.permissionMode = mode;
    let waiting = 0;
    for (const [id, request] of [...this.requests]) {
      if (request.method === 'item/tool/requestUserInput') continue;
      const files = Array.isArray(request.params.files) ? request.params.files : [];
      const allowed = !request.params.subagent && (mode === 'full-access' || (mode === 'auto-accept-edits' && request.method === 'item/fileChange/requestApproval' && files.length > 0 && files.every(file => typeof file === 'string' && !file.startsWith('/'))));
      try { if (allowed) { await this.respond(id, { decision: 'accept' }); continue; } } catch { /* this request offers no plain accept */ }
      waiting++;
    }
    if (waiting) this.emit({ method: 'aya/notice', params: { message: pendingApprovalsNotice(waiting, mode) } });
  }
  setPromptSuggestions(enabled: boolean) { this.promptSuggestions = enabled; }
  /** Cached until Codex reports `skills/changed`; a failed list is asked again next time. */
  async skills(): Promise<GuiSkill[]> {
    if (!this.skillList || this.skillsChanged) {
      const forceReload = this.skillsChanged; this.skillsChanged = false;
      this.skillList = this.rpc('skills/list', { cwds: [this.cwd], ...(forceReload ? { forceReload } : {}) }).then(codexSkills);
    }
    const listing = this.skillList;
    try { return await listing; } catch (error) { if (this.skillList === listing) this.skillList = null; throw error; }
  }
  /** Codex has no native next-prompt suggestion: sample one from the finished turn, as T3 Code does. Best effort. */
  private async suggestNextPrompt(turnId: string) {
    const epoch = this.samplingEpoch;
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (!this.promptSuggestions || this.busy || epoch !== this.samplingEpoch || !this.child) return;
      try {
        const result = await this.rpc('thread/sample', { threadId: this.threadId, expectedTurnId: turnId, prompt: CODEX_PROMPT_SUGGESTION_PROMPT, effort: 'low' });
        const suggestion = cleanPromptSuggestion(result.text);
        if (suggestion && this.promptSuggestions && !this.busy && epoch === this.samplingEpoch) this.emit({ method: 'aya/promptSuggestion', params: { text: suggestion } });
        return;
      } catch (error) {
        // turn/completed can arrive before the sampling source is idle (see /btw).
        if (!/must be idle/i.test(error instanceof Error ? error.message : String(error))) return;
        await new Promise(resolve => setTimeout(resolve, 250 * attempt));
      }
    }
  }
  async steer(prompt: string) {
    if (!prompt.trim() || prompt.length > 100000) throw Error('Message must contain 1–100000 characters');
    if (this.busy && !this.turnId && this.startingTurn) await this.startingTurn;
    if (!this.busy || !this.turnId) throw Error('There is no active turn to steer');
    return this.rpc('turn/steer', { threadId: this.threadId, expectedTurnId: this.turnId, input: [{ type: 'text', text: prompt, text_elements: [] }] });
  }
  async send(prompt: string, options: { model?: string; effort?: string; plan?: boolean; images?: string[] } = {}): Promise<EditSendInfo | void> {
    if (!this.threadId) throw Error('Connect to Codex first');
    if (this.busy) throw Error('Codex is working; stop the current turn first');
    if (!prompt.trim() || prompt.length > 100000) throw Error('Prompt must contain 1–100000 characters');
    this.busy = true;
    const startedAtEpoch = this.samplingEpoch;
    const mode = options.plan === undefined ? null : { mode: options.plan ? 'plan' : 'default', settings: { model: options.model || this.model, reasoning_effort: null, developer_instructions: null } };
    // A mode overrides the thread's settings for this and later turns, so it is sent only when it changed.
    const permissionMode = this.permissionMode, policy = permissionMode === this.appliedPermissionMode ? null : codexPermissionPolicy(permissionMode);
    const starting = this.rpc('turn/start', { threadId: this.threadId, ...(mode ? { collaborationMode: mode } : {}), ...(policy ? { approvalPolicy: policy.approvalPolicy, approvalsReviewer: policy.approvalsReviewer, sandboxPolicy: policy.sandboxPolicy } : {}), ...(options.model ? { model: options.model } : {}), ...(options.effort ? { effort: options.effort } : {}), input: [{ type: 'text', text: prompt, text_elements: [] }, ...(options.images || []).map(file => ({ type: 'localImage', path: file }))] });
    this.startingTurn = starting;
    try {
      const result = await starting;
      this.appliedPermissionMode = permissionMode;
      if (this.busy && !this.turnId) this.turnId = text(object(result.turn).id) || this.turnId;
      const codexTurn = text(object(result.turn).id);
      return codexTurn ? { codexTurn } : undefined;
    } catch (error) { if (this.samplingEpoch === startedAtEpoch) this.busy = false; throw error; }
    finally { if (this.startingTurn === starting) this.startingTurn = null; }
  }
  /** Answers a side question while a turn runs: fork the thread through its last finished turn into an ephemeral,
   *  read-only copy, ask it there, and drop it. The running turn is untouched. */
  private async sideQuestionWhileWorking(question: string): Promise<{ text: string; sourceTurnId: string }> {
    const listed = await this.rpc('thread/turns/list', { threadId: this.threadId, limit: 5, sortDirection: 'desc', itemsView: 'notLoaded' });
    const finished = (Array.isArray(listed.data) ? listed.data : []).map(object).find(turn => text(turn.id) && text(turn.id) !== this.turnId && text(turn.status) !== 'inProgress');
    const sourceTurnId = text(finished?.id);
    if (!sourceTurnId) throw Error('There is no finished turn to ask about yet. Wait for the first answer, then try /btw again.');
    const forked = await this.rpc('thread/fork', { threadId: this.threadId, lastTurnId: sourceTurnId, ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never', excludeTurns: true });
    const sideId = text(object(forked.thread).id);
    if (!sideId) throw Error('Codex did not return a side thread');
    const side = { text: '', done: (_error?: Error) => {} };
    const finishedTurn = new Promise<void>((resolve, reject) => { side.done = error => (error ? reject(error) : resolve()); });
    this.sideThreads.set(sideId, side);
    const timer = setTimeout(() => side.done(Error('The side question timed out')), 120000);
    try {
      await this.rpc('turn/start', { threadId: sideId, input: [{ type: 'text', text: `Answer this side question briefly from the conversation so far, without using tools: ${question}`, text_elements: [] }] });
      await finishedTurn;
      return { text: side.text, sourceTurnId };
    } finally {
      clearTimeout(timer);
      this.sideThreads.delete(sideId);
      void this.rpc('thread/unsubscribe', { threadId: sideId }).catch(() => {});
    }
  }
  /** Edit from here: drop the message's turn and every later one from the thread's history (files are untouched). */
  async editFromHere(target: EditTarget) {
    if (this.busy) throw Error('Stop the current turn first');
    if (!target.codexTurn) throw Error('This message cannot be edited: Codex did not report its turn');
    await this.rpc('thread/revert', { threadId: this.threadId, beforeTurnId: target.codexTurn });
    return { threadId: this.threadId };
  }
  /** Stops the turn and every subagent still running, including one that outlived it. */
  async interrupt() {
    if (this.busy && !this.turnId && this.startingTurn) await this.startingTurn;
    const children = [...this.childTurns].map(([threadId, turnId]) => this.rpc('turn/interrupt', { threadId, turnId }).catch(() => {}));
    await Promise.all([...(this.turnId ? [this.rpc('turn/interrupt', { threadId: this.threadId, turnId: this.turnId })] : []), ...children]);
  }
  /** Stops one spawned subagent by interrupting its thread's turn; its row ends when that turn does. */
  async stopSubagent(itemId: string) {
    const threads = receivers(this.subagentSpawns.get(itemId)).filter(thread => this.childTurns.has(thread));
    if (!threads.length) throw Error('This subagent is not running');
    await Promise.all(threads.map(threadId => this.rpc('turn/interrupt', { threadId, turnId: this.childTurns.get(threadId)! })));
  }
  private spawnRunning(item: Record<string, unknown>) { return receivers(item).some(thread => this.childTurns.has(thread)); }
  /** A subagent's turn started or ended: its spawn call's row runs, or ends with that turn. */
  private childTurnChanged(thread: string, method: string, turn: Record<string, unknown>) {
    if (method === 'turn/started') this.childTurns.set(thread, text(turn.id));
    else {
      this.childTurns.delete(thread);
      // Nobody waits for what the subagent asked once its turn is over.
      for (const [id, request] of this.requests) if (text(request.params.threadId) === thread) { this.requests.delete(id); this.emit({ method: 'aya/requestResolved', params: { id } }); }
    }
    for (const item of this.subagentSpawns.values()) {
      if (!receivers(item).includes(thread)) continue;
      if (method === 'turn/started') this.emit({ method: 'item/started', params: { threadId: this.threadId, item: { ...item, status: 'inProgress', background: true } } });
      else if (!this.spawnRunning(item)) this.emit({ method: 'item/completed', params: { threadId: this.threadId, item: { ...item, status: turn.status === 'interrupted' ? 'interrupted' : turn.status === 'failed' ? 'failed' : 'completed', background: true } } });
    }
  }
  async respond(id: string | number, value: { decision?: GuiApprovalDecision; answers?: Record<string, string>; note?: string }) {
    const request = this.requests.get(id);
    if (!request) throw Error('This request has already ended');
    let result: unknown;
    if (request.method === 'item/tool/requestUserInput') {
      const questions = Array.isArray(request.params.questions) ? request.params.questions : [];
      result = { answers: Object.fromEntries(questions.map((q, idx) => { const question = object(q), key = text(question.id) || (questions.length === 1 ? 'choice' : `q_${idx}`); return [key, { answers: [text(value.answers?.[key])] }]; })) };
    } else if (request.method === 'item/permissions/requestApproval') {
      if (!['accept', 'acceptForSession', 'decline'].includes(String(value.decision))) throw Error('Invalid permission decision');
      result = { permissions: value.decision === 'accept' || value.decision === 'acceptForSession' ? request.params.permissions : {}, scope: value.decision === 'acceptForSession' ? 'session' : 'turn' };
    } else {
const available = Array.isArray(request.params.availableDecisions) ? request.params.availableDecisions : [
        'accept', 'acceptForSession', 'decline', 'cancel',
        ...(Array.isArray(request.params.proposedExecpolicyAmendment) ? [{ acceptWithExecpolicyAmendment: { execpolicy_amendment: request.params.proposedExecpolicyAmendment } }] : []),
        ...(Array.isArray(request.params.proposedNetworkPolicyAmendments) ? request.params.proposedNetworkPolicyAmendments.map(amendment => ({ applyNetworkPolicyAmendment: { network_policy_amendment: amendment } })) : []),
      ];
      if (!available.some(decision => JSON.stringify(decision) === JSON.stringify(value.decision))) throw Error('This approval decision is not available');
      result = { decision: value.decision };
    }
    this.requests.delete(id); this.write({ id, result });
    this.emit({ method: 'aya/requestResolved', params: { id } });
  }
  private async receive(raw: unknown) {
    const message = object(raw), method = text(message.method);
    let params = object(message.params);
    // A file change's approval names only its item: remember which files each change edits, so the request can say.
    const changed = object(params.item);
    if (changed.type === 'fileChange' && text(changed.id) && Array.isArray(changed.changes)) {
      const files = changed.changes.map(change => text(object(change).path)).filter(Boolean);
      this.fileChanges.delete(text(changed.id)); this.fileChanges.set(text(changed.id), files);
      if (this.fileChanges.size > 100) this.fileChanges.delete(this.fileChanges.keys().next().value!);
    }
    if (!method && typeof message.id === 'number') {
      const entry = this.pending.get(message.id); if (!entry) return;
      this.pending.delete(message.id); clearTimeout(entry.timer);
      if (message.error) entry.reject(Error(text(object(message.error).message) || 'Codex request failed'));
      else entry.resolve(object(message.result));
      return;
    }
    if (!method) return;
    const hasId = typeof message.id === 'number' || typeof message.id === 'string';
    const sideThread = this.sideThreads.get(text(params.threadId));
    if (sideThread) {
      // A forked side chat runs read-only and never asks; anything it does ask is refused, and none of it is shown.
      if (hasId) { this.write({ id: message.id, error: { code: -32000, message: 'Side questions cannot use tools or ask for approval' } }); return; }
      const item = object(params.item);
      if (method === 'item/completed' && item.type === 'agentMessage' && text(item.text)) sideThread.text = text(item.text);
      if (method === 'turn/completed') sideThread.done(object(params.turn).status === 'failed' ? Error(text(object(object(params.turn).error).message) || 'The side question failed') : undefined);
      return;
    }
    if (hasId) {
      const id = message.id as string | number;
      if (method === 'item/tool/call' && params.tool === 'aya_progress') {
        try {
          const args = object(params.arguments), previous = this.progresses.get(text(args.progressId));
          const progress = progressUpdate(args, previous);
          this.progresses.set(progress.id, progress);
          this.emit({ method: 'aya/progress', params: { progress } });
          this.write({ id, result: { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ progressId: progress.id, current: progress.current, total: progress.total, status: progress.status }) }] } });
        } catch (error) { this.write({ id, result: { success: false, contentItems: [{ type: 'inputText', text: String(error) }] } }); }
        return;
      }
      if (method === 'item/tool/call' && params.tool === 'aya_present') {
        try {
          const args = object(params.arguments);
          if (args.open !== undefined && typeof args.open !== 'boolean') throw Error('open must be a boolean');
          const artifact = await presentArtifact(this.cwd, args);
          if (args.artifactId !== undefined) {
            if (typeof args.artifactId !== 'string' || !this.artifactIds.has(args.artifactId)) throw Error('Cannot update an unknown artifactId');
            artifact.id = args.artifactId;
          }
          artifact.revision = (this.artifactRevisions.get(artifact.id) || 0) + 1;
          this.artifactRevisions.set(artifact.id, artifact.revision);
          this.artifactIds.add(artifact.id);
          this.emit({ method: 'aya/artifact', params: { artifact, open: args.open === true } });
          this.write({ id, result: { success: true, contentItems: [{ type: 'inputText', text: `Created artifact: ${artifact.title}. artifactId: ${artifact.id}. The user can inspect the artifact and ask follow-ups.` }] } });
        } catch (error) { this.write({ id, result: { success: false, contentItems: [{ type: 'inputText', text: String(error) }] } }); }
        return;
      }
      if (method === 'item/tool/call' && params.tool === 'aya_open_artifact') {
        const artifactId = text(object(params.arguments).artifactId);
        const success = this.artifactIds.has(artifactId);
        if (success) this.emit({ method: 'aya/openArtifact', params: { artifactId } });
        this.write({ id, result: { success, contentItems: [{ type: 'inputText', text: success ? `Opened artifact ${artifactId} in Aya.` : 'Unknown artifactId. Use an ID returned by aya_present in this session.' }] } });
        return;
      }
      if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput'].includes(method)) {
        // A subagent's request is marked so the main turn's end does not drop it while that agent still waits.
        const thread = text(params.threadId), task = this.subagentThreads.get(thread);
        const files = method === 'item/fileChange/requestApproval' ? this.fileChanges.get(text(params.itemId)) : undefined;
        if (files?.length) params = { ...params, files: files.map(file => file.startsWith(this.cwd + '/') ? file.slice(this.cwd.length + 1) : file) };
        const request = { method, params: thread && this.threadId && thread !== this.threadId ? { ...params, subagent: task ? `Subagent: ${task}` : 'A subagent' } : params };
        this.requests.set(id, request); this.emit({ ...request, id }); return;
      }
      this.write({ id, error: { code: -32601, message: `Aya PoC does not support ${method}` } });
      this.emit({ method: 'aya/notice', params: { message: `Unsupported Codex request: ${method}` } });
      return;
    }
    // App-server can also publish notifications for a spawned agent's thread.
    // Those turns must not change this pane's active turn or its conversation.
    // Server requests above still need their own replies regardless of origin.
    if (/^(?:turn\/|item\/|thread\/goal\/)/.test(method) && this.threadId && typeof params.threadId === 'string' && params.threadId !== this.threadId) {
      if (method === 'turn/started' || method === 'turn/completed') this.childTurnChanged(params.threadId, method, object(params.turn));
      return;
    }
    if (object(params.item).type === 'subAgentActivity') {
      // Newer Codex reports a subagent as activity items instead of a spawnAgent call. Its start becomes the spawn
      // row; the other kinds are left out, as the row follows the subagent's own turns.
      const spawn = subagentActivitySpawn(object(params.item), this.threadId);
      if (!spawn) return;
      params = { ...params, item: spawn };
    }
    const item = object(params.item);
    if (item.type === 'collabAgentToolCall' && item.tool === 'spawnAgent' && Array.isArray(item.receiverThreadIds)) {
      const task = text(item.prompt).trim().split('\n')[0]!.slice(0, 80);
      for (const thread of item.receiverThreadIds) if (typeof thread === 'string') this.subagentThreads.set(thread, task);
    }
    if (item.type === 'collabAgentToolCall' && item.tool === 'spawnAgent' && text(item.id)) {
      this.subagentSpawns.delete(text(item.id)); this.subagentSpawns.set(text(item.id), item);
      if (this.subagentSpawns.size > 100) this.subagentSpawns.delete(this.subagentSpawns.keys().next().value!);
      // The call ended, but the agent it started still works: its row keeps running.
      if (method === 'item/completed' && this.spawnRunning(item)) { this.emit({ method: 'item/started', params: { ...params, item: { ...item, status: 'inProgress', background: true } } }); return; }
    }
    if (method === 'turn/started') { this.samplingEpoch++; this.turnId = text(object(params.turn).id); this.busy = true; }
    if (method === 'turn/completed') {
      if (this.turnId && text(object(params.turn).id) && object(params.turn).id !== this.turnId) return;
      this.samplingEpoch++;
      for (const wake of this.samplingWaiters) wake();
      for (const [id, previous] of this.progresses) if (previous.status === 'running') {
        const progress: GuiProgress = { ...previous, status: object(params.turn).status === 'failed' ? 'failed' : 'paused', detail: previous.detail || 'Turn ended before this task was marked complete' };
        this.progresses.set(id, progress); this.emit({ method: 'aya/progress', params: { progress } });
      }
      this.busy = false; this.turnId = null;
      for (const [id, request] of this.requests) if (!request.params.subagent) this.requests.delete(id);
      const finished = text(object(params.turn).id);
      if (finished && object(params.turn).status === 'completed' && this.promptSuggestions) void this.suggestNextPrompt(finished);
    }
    if (method === 'thread/tokenUsage/updated' && (!this.threadId || params.threadId === undefined || params.threadId === this.threadId)) {
      const usage = codexContextUsage(params);
      if (usage) this.emit({ method: 'aya/contextUsage', params: { ...usage } });
    }
    if (method === 'skills/changed') { this.skillsChanged = true; this.emit({ method: 'aya/skillsChanged', params: {} }); }
    if (method === 'serverRequest/resolved' && (typeof params.requestId === 'string' || typeof params.requestId === 'number')) this.requests.delete(params.requestId);
    this.emit({ method, params });
  }
  close() {
    this.closing = true;
    this.writer?.close(); this.writer = null;
    const child = this.child; this.child = null;
    this.fail('Session closed');
    if (child?.pid) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill(); }
      const timer = setTimeout(() => { try { if (child.exitCode === null && child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* already stopped */ } }, 1500);
      timer.unref(); child.once('exit', () => clearTimeout(timer));
    }
  }
}
export { PiGuiSession, ClaudeGuiSession, AntigravityGuiSession, type GuiAgentKind, type GuiSessionInstance } from './multi-agent-gui-session';

