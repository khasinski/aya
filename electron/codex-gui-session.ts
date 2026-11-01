import { PROGRESS_TOOL, progressUpdate } from './gui-progress';
import type { GuiProgress } from '../shared/gui-progress';
// Development PoC: Codex owns the agent loop and policies; Aya owns presentation.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import type { GuiEvent, GuiArtifact, GuiApprovalDecision } from '../shared/codex-gui';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === 'string' ? value : '';
import { PRESENT_TOOL, OPEN_ARTIFACT_TOOL, presentArtifact } from './gui-artifact-tools';
export { PRESENT_TOOL, OPEN_ARTIFACT_TOOL, workspaceImage, presentArtifact } from './gui-artifact-tools';

export class CodexGuiSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private requests = new Map<string | number, { method: string; params: Record<string, unknown> }>();
  private nextId = 0;
  private turnId: string | null = null;
  private threadId = '';
  private busy = false;
  get running() { return this.busy; }
  private closing = false;
  private artifactIds = new Set<string>();
  private artifactRevisions = new Map<string, number>();
  private progresses = new Map<string, GuiProgress>();
  private buffer = '';
  private stderr = '';
  cwd = '';
  constructor(private readonly emit: (event: GuiEvent) => void, private readonly executable = 'codex', private readonly args = ['app-server', '--listen', 'stdio://']) {}
  private write(value: unknown) { if (!this.child || this.child.stdin.destroyed) throw Error('Codex is disconnected'); this.child.stdin.write(JSON.stringify(value) + '\n'); }
  private rpc(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error(`${method} timed out`)); }, 60000); timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  private fail(message: string) {
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(Error(message)); }
    this.pending.clear(); this.requests.clear(); this.busy = false; this.turnId = null;
    if (!this.closing) this.emit({ method: 'aya/disconnected', params: { message } });
  }
  async connect(cwd: string, model: string, configDir?: string, resumeThreadId?: string, unsafeMode = false) {
    if (this.child) throw Error('Start a new window for a separate PoC session');
    this.cwd = await realpath(cwd);
    if (!(await stat(this.cwd)).isDirectory()) throw Error('Workspace must be a directory');
    const env = { ...process.env };
    if (configDir) env.CODEX_HOME = configDir;
    for (const key of ['ELECTRON_RUN_AS_NODE', 'AYA_SOCKET', 'AYA_TERMINAL_ID', 'AYA_PRESET_ID', 'AYA_PROJECT_SLUG', 'AYA_PROJECT_DIR', 'AYA_VIA', 'AYA_REMOTE_SOCKET']) delete env[key];
    this.child = spawn(this.executable, this.args, { cwd: this.cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdin.on('error', () => {});
    this.child.stderr.on('data', data => { this.stderr = (this.stderr + String(data)).slice(-4000); });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', data => {
      this.buffer += String(data);
      if (this.buffer.length > 16 * 1024 * 1024) { this.fail('Codex protocol frame exceeded 16 MB'); this.close(); return; }
      let at: number;
      while ((at = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, at); this.buffer = this.buffer.slice(at + 1);
        if (!line.trim()) continue;
        try { void this.receive(JSON.parse(line)).catch(error => this.fail(String(error))); }
        catch { this.fail('Malformed JSON from Codex'); this.close(); }
      }
    });
    this.child.once('error', error => this.fail(`Cannot start Codex: ${error.message}`));
    this.child.once('exit', code => this.fail(`Codex stopped (${code ?? 'signal'}). ${this.stderr}`));
    try {
      await this.rpc('initialize', { clientInfo: { name: 'aya_gui_poc', title: 'Aya GUI PoC', version: '0.1.0' }, capabilities: { experimentalApi: true } });
      this.write({ method: 'initialized', params: {} });
      const result = await this.rpc(resumeThreadId ? 'thread/resume' : 'thread/start', {
        ...(resumeThreadId ? { threadId: resumeThreadId, excludeTurns: true } : {}),
        cwd: this.cwd, ...(model ? { model } : {}), sandbox: unsafeMode ? 'danger-full-access' : 'workspace-write', approvalPolicy: unsafeMode ? 'never' : 'on-request', approvalsReviewer: 'user',
        ...(resumeThreadId ? {} : { dynamicTools: [PRESENT_TOOL, OPEN_ARTIFACT_TOOL, PROGRESS_TOOL] }),
        developerInstructions: 'You are displayed inside Aya GUI, a local graphical frontend for Codex. Respond in the user’s language. You own the normal Codex tool loop, context and sandbox. Use Markdown freely. For useful tables, metrics and local images, use aya_present to create artifacts. Set open=true when you want to show a newly created artifact immediately; use aya_open_artifact with its returned artifactId to reopen an existing one. Use HTML widgets for interactive visuals, forms, charts and mockups; use local PNG/JPEG/WebP/SVG files for graphics. Widgets are self-contained and cannot access the network or files. Widget row clicks arrive as user follow-ups. For measurable tasks use aya_progress with a label, actual completed units, total units and optional stage detail. Reuse its returned progressId for updates instead of creating new bars. Do not invent progress for tasks without measurable units. Do not start subagents unless the user requests delegation.',
      });
      this.threadId = text(object(result.thread).id);
      if (!this.threadId) throw Error('Codex did not return a thread ID');
      return { threadId: this.threadId, model: text(result.model) || model || 'Codex default' };
    } catch (error) { this.close(); throw error; }
  }
  async listConversations() {
    const result = await this.rpc('thread/list', { cwd: this.cwd, limit: 100, sortKey: 'updated_at' });
    return (Array.isArray(result.data) ? result.data : []).map(object).filter(row => row.cwd === this.cwd && typeof row.id === 'string').map(row => ({ id: 'codex:' + text(row.id), title: text(row.name) || text(row.preview) || 'Untitled conversation', updatedAt: Number(row.updatedAt) * 1000, current: row.id === this.threadId }));
  }
  async readConversation(id: string) {
    const result = await this.rpc('thread/read', { threadId: id, includeTurns: true });
    const thread = object(result.thread);
    if (thread.cwd !== this.cwd || thread.id !== id) throw Error('Conversation does not belong to this workspace');
    const messages: { id: string; type: string; text: string }[] = [];
    for (const turn of Array.isArray(thread.turns) ? thread.turns : []) for (const raw of Array.isArray(object(turn).items) ? object(turn).items as unknown[] : []) {
      const item = object(raw);
      if (item.type === 'agentMessage') messages.push({ id: text(item.id), type: 'assistant', text: text(item.text) });
      if (item.type === 'userMessage') messages.push({ id: text(item.id), type: 'user', text: (Array.isArray(item.content) ? item.content : []).map(object).filter(part => part.type === 'text').map(part => text(part.text)).join('\n') });
    }
    return { threadId: id, view: { messages: messages.slice(-500), importNotice: 'Resumed from Codex history. This conversation keeps its original tool configuration. Start a new conversation for the latest Aya widget and progress tools.' } };
  }
  restoreProgress(progresses: GuiProgress[]) { for (const progress of progresses) this.progresses.set(progress.id, progress); }
  restoreArtifacts(artifacts: GuiArtifact[]) {
    for (const artifact of artifacts) { this.artifactIds.add(artifact.id); this.artifactRevisions.set(artifact.id, artifact.revision || 1); }
  }
  async command(name: string, argument: string) {
    if (!this.threadId) throw Error('Connect to Codex first');
    if (name === 'goal') {
      const params: Record<string, unknown> = { threadId: this.threadId, origin: 'user' };
      if (argument === 'clear') return this.rpc('thread/goal/clear', params);
      if (!argument) return this.rpc('thread/goal/get', params);
      if (argument === 'pause' || argument === 'resume') params.status = argument === 'pause' ? 'paused' : 'active';
      else params.objective = argument;
      return this.rpc('thread/goal/set', params);
    }
    if (name === 'compact') return this.rpc('thread/compact/start', { threadId: this.threadId });
    if (name === 'btw') {
      if (this.busy) throw Error('Side questions currently require a completed turn. Wait for Codex or stop it first.');
      if (!argument.trim()) throw Error('Usage: /btw your side question');
      const result = await this.rpc('thread/read', { threadId: this.threadId, includeTurns: true });
      const turns = object(result.thread).turns;
      const last = Array.isArray(turns) ? object(turns.at(-1)) : {};
      if (!text(last.id)) throw Error('Send a message before asking a side question.');
      return this.rpc('thread/sample', { threadId: this.threadId, expectedTurnId: text(last.id), prompt: argument });
    }
    throw Error(`Unsupported command /${name}. Use /goal, /btw or /compact. Other CLI commands remain available in Terminal mode.`);
  }
  async models() { return this.rpc('model/list', { limit: 100 }); }
  async steer(prompt: string) {
    if (!this.busy || !this.turnId) throw Error('There is no active turn to steer');
    if (!prompt.trim() || prompt.length > 100000) throw Error('Message must contain 1–100000 characters');
    return this.rpc('turn/steer', { threadId: this.threadId, expectedTurnId: this.turnId, input: [{ type: 'text', text: prompt, text_elements: [] }] });
  }
  async send(prompt: string, options: { model?: string; effort?: string; images?: string[] } = {}) {
    if (!this.threadId) throw Error('Connect to Codex first');
    if (this.busy) throw Error('Codex is working; stop the current turn first');
    if (!prompt.trim() || prompt.length > 100000) throw Error('Prompt must contain 1–100000 characters');
    this.busy = true;
    try {
      const result = await this.rpc('turn/start', { threadId: this.threadId, ...(options.model ? { model: options.model } : {}), ...(options.effort ? { effort: options.effort } : {}), input: [{ type: 'text', text: prompt, text_elements: [] }, ...(options.images || []).map(file => ({ type: 'localImage', path: file }))] });
      if (this.busy) this.turnId = text(object(result.turn).id) || this.turnId;
    } catch (error) { this.busy = false; throw error; }
  }
  async interrupt() {
    if (this.turnId) await this.rpc('turn/interrupt', { threadId: this.threadId, turnId: this.turnId });
  }
  async respond(id: string | number, value: { decision?: GuiApprovalDecision; answers?: Record<string, string> }) {
    const request = this.requests.get(id);
    if (!request) throw Error('This request has already ended');
    let result: unknown;
    if (request.method === 'item/tool/requestUserInput') {
      const questions = Array.isArray(request.params.questions) ? request.params.questions : [];
      result = { answers: Object.fromEntries(questions.map(q => { const question = object(q), key = text(question.id); return [key, { answers: [text(value.answers?.[key])] }]; })) };
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
    const message = object(raw), method = text(message.method), params = object(message.params);
    if (!method && typeof message.id === 'number') {
      const entry = this.pending.get(message.id); if (!entry) return;
      this.pending.delete(message.id); clearTimeout(entry.timer);
      if (message.error) entry.reject(Error(text(object(message.error).message) || 'Codex request failed'));
      else entry.resolve(object(message.result));
      return;
    }
    if (!method) return;
    const hasId = typeof message.id === 'number' || typeof message.id === 'string';
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
        this.requests.set(id, { method, params }); this.emit({ method, params, id }); return;
      }
      this.write({ id, error: { code: -32601, message: `Aya PoC does not support ${method}` } });
      this.emit({ method: 'aya/notice', params: { message: `Unsupported Codex request: ${method}` } });
      return;
    }
    if (method === 'turn/started') this.turnId = text(object(params.turn).id);
    if (method === 'turn/completed') {
      for (const [id, previous] of this.progresses) if (previous.status === 'running') {
        const progress: GuiProgress = { ...previous, status: object(params.turn).status === 'failed' ? 'failed' : 'paused', detail: previous.detail || 'Turn ended before this task was marked complete' };
        this.progresses.set(id, progress); this.emit({ method: 'aya/progress', params: { progress } });
      }
      this.busy = false; this.turnId = null; this.requests.clear(); }
    if (method === 'serverRequest/resolved' && (typeof params.requestId === 'string' || typeof params.requestId === 'number')) this.requests.delete(params.requestId);
    this.emit({ method, params });
  }
  close() {
    this.closing = true;
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

