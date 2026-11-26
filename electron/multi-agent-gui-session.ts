import { GuiProtocolWriter } from './gui-protocol-writer';
import { GuiJsonLines, skipMalformedLine } from './gui-json-lines';
import { claudeChromeCommand } from './claude-chrome';
import { TaskOutputTail, claudeTaskOutputRoot } from './gui-task-output-tail';
import { formatClaudeUsage } from './claude-usage';
import { ClaudeUsageLimitTracker, claudeLimitMessage } from './gui-usage-limit';
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { realpath, stat, readFile, mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { AYA_HOME } from './paths';
import { PROGRESS_TOOL, progressUpdate } from './gui-progress';
import { PRESENT_TOOL, OPEN_ARTIFACT_TOOL, presentArtifact, workspaceImage } from './gui-artifact-tools';
import { claudeContextUsage, claudeSkills, cleanPromptSuggestion, type GuiSkill } from './gui-composer-assist';
import type { CodexGuiSession } from './codex-gui-session';
import type { GuiProgress } from '../shared/gui-progress';
import type { GuiArtifact, GuiEvent } from '../shared/codex-gui';
import { claudeDeclineMessage, claudePermissionMode, fromClaudePermissionMode, guiPermissionModeLabel, pendingApprovalsNotice, type GuiPermissionMode } from '../shared/gui-permission-mode.cjs';
import { insideDirectory, type EditSendInfo, type EditTarget } from './gui-edit-from-here';

const execFileAsync = promisify(execFile);
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const text = (value: unknown) => (typeof value === 'string' ? value : '');

export type GuiAgentKind = 'codex' | 'pi' | 'claude' | 'antigravity';

export type GuiSessionInstance = Pick<
  CodexGuiSession,
  | 'cwd'
  | 'running'
  | 'pid'
  | 'connect'
  | 'restoreProgress'
  | 'restoreArtifacts'
  | 'command'
  | 'models'
  | 'steer'
  | 'send'
  | 'interrupt'
  | 'respond'
  | 'close'
> & Partial<Pick<CodexGuiSession, 'listConversations' | 'readConversation' | 'stopSubagent' | 'setPermissionMode' | 'editFromHere' | 'skills' | 'setPromptSuggestions'>> & {
  /** Files a Claude checkpoint rewind would restore, or null when it cannot. */
  previewFileRewind?(target: EditTarget): Promise<string[] | null>;
  rewindFiles?(target: EditTarget): Promise<void>;
};

const STRIPPED_AYA_ENV = [
  'ELECTRON_RUN_AS_NODE',
  'AYA_SOCKET',
  'AYA_TERMINAL_ID',
  'AYA_PRESET_ID',
  'AYA_PROJECT_SLUG',
  'AYA_PROJECT_DIR',
  'AYA_VIA',
  'AYA_REMOTE_SOCKET',
] as const;

export function buildGuiDeveloperInstructions(agentName: string): string {
  return `You are displayed inside Aya GUI, a local graphical frontend for ${agentName}. Respond in the user’s language. You own the normal ${agentName} tool loop, context and sandbox. Use Markdown freely. Messages support syntax-highlighted fenced code blocks (include the language), inline images with ![description](workspace-relative-or-absolute-path) or base64 data image URLs, and Mermaid fenced blocks for diagrams and charts (flowchart, sequenceDiagram, pie, xychart-beta). Prefer these inline formats for visuals that belong in the conversation; no artifact tool is needed. Never draw charts, tables or diagrams as ASCII art. Local images must be inside the selected workspace (PNG/JPEG/WebP/GIF/SVG, up to 8 MiB); remote image URLs are not loaded. Use aya_present for standalone artifacts, metrics and interactive HTML. Set open=true when you want to show a newly created artifact immediately; use aya_open_artifact with its returned artifactId to reopen an existing one. Use HTML widgets for interactive visuals, forms, charts and mockups; use local PNG/JPEG/WebP/SVG files for graphics. Widgets are self-contained and cannot access the network or files. Widget row clicks arrive as user follow-ups. For measurable tasks use aya_progress with a label, actual completed units, total units and optional stage detail. Reuse its returned progressId for updates instead of creating new bars. Do not invent progress for tasks without measurable units. Do not start subagents unless the user requests delegation.`;
}

async function encodeImageAttachment(file: string): Promise<{ data: string; mimeType: string }> {
  const resolved = await realpath(file);
  const info = await stat(resolved);
  if (!info.isFile() || info.size > 8 * 1024 * 1024) {
    throw Error('Attached image must be a regular file under 8 MB');
  }
  const bytes = await readFile(resolved);
  const mimeType = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? 'image/png'
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      ? 'image/jpeg'
      : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
        ? 'image/webp'
        : 'image/png';
  return { data: bytes.toString('base64'), mimeType };
}

abstract class BaseManagedGuiSession implements GuiSessionInstance {
  protected child: ChildProcessWithoutNullStreams | null = null;
  protected writer: GuiProtocolWriter | null = null;
  protected requests = new Map<
    string | number,
    {
      method: string;
      params: Record<string, unknown>;
      resolve?: (value: { decision?: 'accept' | 'decline'; answers?: Record<string, string>; note?: string }) => void;
    }
  >();
  protected artifactIds = new Set<string>();
  protected artifactRevisions = new Map<string, number>();
  protected progresses = new Map<string, GuiProgress>();
  protected goalState: { objective: string; status: string } | null = null;
  protected threadId = '';
  protected busy = false;
  get running() { return this.busy; }
  /** Ends the requests of the turn that just ended. A subagent's request outlives it: a background subagent keeps
   *  running, and its agent still waits for the answer. */
  protected clearTurnRequests() {
    for (const [id, request] of this.requests) if (!text(request.params.subagent)) this.requests.delete(id);
  }
  get pid() { return this.child?.pid; }
  protected closing = false;
  protected stderr = '';
  cwd = '';

  constructor(
    protected readonly emit: (event: GuiEvent) => void,
    protected readonly agentLabel: string,
  ) {}

  restoreProgress(progresses: GuiProgress[]) {
    for (const progress of progresses) this.progresses.set(progress.id, progress);
  }

  restoreArtifacts(artifacts: Pick<GuiArtifact, 'id' | 'revision'>[]) {
    for (const artifact of artifacts) {
      this.artifactIds.add(artifact.id);
      this.artifactRevisions.set(artifact.id, artifact.revision || 1);
    }
  }

  protected cleanEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
    for (const key of STRIPPED_AYA_ENV) delete env[key];
    return env;
  }

  protected async executeAyaTool(
    toolName: string,
    rawArgs: unknown,
  ): Promise<{ success: boolean; text: string }> {
    const normalized = toolName.replace(/^mcp__aya__/, '').replace(/^mcp_aya_/, '');
    const args = object(rawArgs);
    if (normalized === 'aya_progress') {
      try {
        const previous = this.progresses.get(text(args.progressId));
        const progress = progressUpdate(args, previous);
        this.progresses.set(progress.id, progress);
        this.emit({ method: 'aya/progress', params: { progress } });
        return {
          success: true,
          text: JSON.stringify({
            progressId: progress.id,
            current: progress.current,
            total: progress.total,
            status: progress.status,
          }),
        };
      } catch (error) {
        return { success: false, text: String(error) };
      }
    }
    if (normalized === 'aya_present') {
      try {
        if (args.open !== undefined && typeof args.open !== 'boolean') {
          throw Error('open must be a boolean');
        }
        const artifact = await presentArtifact(this.cwd, args);
        if (args.artifactId !== undefined) {
          if (typeof args.artifactId !== 'string' || !this.artifactIds.has(args.artifactId)) {
            throw Error('Cannot update an unknown artifactId');
          }
          artifact.id = args.artifactId;
        }
        artifact.revision = (this.artifactRevisions.get(artifact.id) || 0) + 1;
        this.artifactRevisions.set(artifact.id, artifact.revision);
        this.artifactIds.add(artifact.id);
        this.emit({ method: 'aya/artifact', params: { artifact, open: args.open === true } });
        return {
          success: true,
          text: `Created artifact: ${artifact.title}. artifactId: ${artifact.id}. The user can inspect the artifact and ask follow-ups.`,
        };
      } catch (error) {
        return { success: false, text: String(error) };
      }
    }
    if (normalized === 'aya_open_artifact') {
      const artifactId = text(args.artifactId);
      const success = this.artifactIds.has(artifactId);
      if (success) this.emit({ method: 'aya/openArtifact', params: { artifactId } });
      return {
        success,
        text: success
          ? `Opened artifact ${artifactId} in Aya.`
          : 'Unknown artifactId. Use an ID returned by aya_present in this session.',
      };
    }
    return { success: false, text: `Unsupported Aya tool: ${toolName}` };
  }

  protected pauseRunningProgressOnTurnEnd(failed = false) {
    for (const [id, previous] of this.progresses) {
      if (previous.status === 'running') {
        const progress: GuiProgress = {
          ...previous,
          status: failed ? 'failed' : 'paused',
          detail: previous.detail || 'Turn ended before this task was marked complete',
        };
        this.progresses.set(id, progress);
        this.emit({ method: 'aya/progress', params: { progress } });
      }
    }
  }

  protected handleGoalCommand(argument: string): Record<string, unknown> {
    if (argument === 'clear') {
      this.goalState = null;
      this.emit({ method: 'thread/goal/cleared', params: {} });
      return {};
    }
    if (!argument) {
      return { goal: this.goalState };
    }
    if (argument === 'pause' || argument === 'resume') {
      this.goalState = {
        objective: this.goalState?.objective || 'Current goal',
        status: argument === 'pause' ? 'paused' : 'active',
      };
    } else {
      this.goalState = { objective: argument, status: 'active' };
    }
    this.emit({ method: 'thread/goal/updated', params: { goal: this.goalState } });
    return { goal: this.goalState };
  }

  protected checkGoalCompletionInText(responseText: string) {
    if (
      this.goalState &&
      this.goalState.status === 'active' &&
      (responseText.includes('<!-- GOAL_COMPLETE -->') || /\bgoal is complete\b/i.test(responseText))
    ) {
      this.goalState = { ...this.goalState, status: 'complete' };
      this.emit({ method: 'thread/goal/updated', params: { goal: this.goalState } });
    }
  }

  async respond(
    id: string | number,
    value: { decision?: 'accept' | 'decline'; answers?: Record<string, string>; note?: string },
  ) {
    const request = this.requests.get(id);
    if (!request) throw Error('This request has already ended');
    if (request.method !== 'item/tool/requestUserInput') {
      if (value.decision !== 'accept' && value.decision !== 'decline') {
        throw Error('Choose accept or decline');
      }
    }
    this.requests.delete(id);
    request.resolve?.(value);
    this.emit({ method: 'aya/requestResolved', params: { id } });
  }

  close() {
    this.closing = true;
    this.writer?.close(); this.writer = null;
    const child = this.child;
    this.child = null;
    this.failSession('Session closed');
    this.terminate(child);
  }

  protected terminate(child: ChildProcessWithoutNullStreams | null) {
    if (child?.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill();
      }
      const timer = setTimeout(() => {
        try {
          if (child.exitCode === null && child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* already stopped */
        }
      }, 1500);
      timer.unref();
      child.once('exit', () => clearTimeout(timer));
    }
  }

  protected abstract failSession(message: string): void;
  abstract connect(
    cwd: string,
    model: string,
    configDir?: string,
    resumeThreadId?: string,
    unsafeMode?: boolean,
    permissionMode?: GuiPermissionMode,
  ): Promise<{ threadId: string; model: string; permissionMode?: GuiPermissionMode }>;
  abstract command(name: string, argument: string): Promise<Record<string, unknown>>;
  abstract models(): Promise<Record<string, unknown>>;
  abstract steer(prompt: string): Promise<Record<string, unknown>>;
  abstract send(
    prompt: string,
    options?: { model?: string; effort?: string; images?: string[] },
  ): Promise<EditSendInfo | void>;
  abstract interrupt(): Promise<void>;
}

const ASK_USER_QUESTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['questions'],
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['question'],
        properties: {
          id: { type: 'string' },
          header: { type: 'string' },
          question: { type: 'string' },
          multiSelect: { type: 'boolean' },
          options: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['label'],
              properties: {
                label: { type: 'string' },
                description: { type: 'string' },
              },
            },
          },
        },
      },
    },
  },
};

const PI_GUI_EXTENSION_SOURCE = `export default function ayaPiGuiExtension(pi) {
  const developerNote = ${JSON.stringify(buildGuiDeveloperInstructions('Pi'))};
  pi.on("before_agent_start", async (event) => {
    if (typeof event.systemPrompt === "string" && !event.systemPrompt.includes("aya_present")) {
      return { systemPrompt: event.systemPrompt + "\\n\\n" + developerNote };
    }
  });
  for (const spec of [
    ${JSON.stringify({ name: PRESENT_TOOL.name, label: 'Aya Present', description: PRESENT_TOOL.description, parameters: PRESENT_TOOL.inputSchema })},
    ${JSON.stringify({ name: OPEN_ARTIFACT_TOOL.name, label: 'Aya Open Artifact', description: OPEN_ARTIFACT_TOOL.description, parameters: OPEN_ARTIFACT_TOOL.inputSchema })},
    ${JSON.stringify({ name: PROGRESS_TOOL.name, label: 'Aya Progress', description: PROGRESS_TOOL.description, parameters: PROGRESS_TOOL.inputSchema })},
    ${JSON.stringify({ name: 'ask_user_question', label: 'Ask User Question', description: 'Ask the user one or more clarifying questions with optional choices in Aya GUI.', parameters: ASK_USER_QUESTION_SCHEMA })}
  ]) {
    pi.registerTool({
      name: spec.name,
      label: spec.label,
      description: spec.description,
      parameters: spec.parameters,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const raw = await ctx.ui.input("__aya_tool__:" + spec.name, JSON.stringify(params || {}));
        let parsed = { success: true, text: raw || "OK" };
        try { parsed = JSON.parse(raw || "{}"); } catch {}
        if (parsed && parsed.success === false) {
          throw new Error(parsed.text || "Aya tool failed");
        }
        return {
          content: [{ type: "text", text: (parsed && parsed.text) || raw || "OK" }],
          details: {}
        };
      }
    });
  }
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash" || event.toolName === "powershell") {
      if (process.env.AYA_PI_SKIP_PERMISSIONS === "1") return;
      const cmd = (event.input && event.input.command) ? String(event.input.command) : event.toolName;
      const ok = await ctx.ui.confirm("Approval required", cmd);
      if (!ok) return { block: true, reason: "Declined by user in Aya GUI" };
    }
  });
}
`;

async function ensurePiExtensionFile(): Promise<string> {
  const dir = path.join(AYA_HOME, 'pi-gui');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'aya-pi-gui-extension.mjs');
  await writeFile(file, PI_GUI_EXTENSION_SOURCE, 'utf8');
  return file;
}

export class PiGuiSession extends BaseManagedGuiSession {
  private pending = new Map<
    string,
    {
      resolve: (value: Record<string, unknown>) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private nextId = 0;
  private turnId: string | null = null;
  private currentItemId = '';
  private currentAssistantText = '';
  private interruptRequested = false;
  private modelProviders = new Map<string, string>();

  constructor(
    emit: (event: GuiEvent) => void,
    private readonly executable = 'pi',
    private readonly customArgs?: string[],
  ) {
    super(emit, 'Pi');
  }

  private write(value: unknown) {
    if (!this.child || this.child.stdin.destroyed) throw Error('Pi is disconnected');
    if (!this.writer) throw Error(`${this.agentLabel} is disconnected`); this.writer.write(value);
  }

  private rpc(type: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = `pi-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error(`${type} response timed out; the agent may still be working`));
      }, 60000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, type, ...payload });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : Error(String(error)));
      }
    });
  }

  protected failSession(message: string) {
    this.writer?.close(); this.writer = null;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(Error(message));
    }
    this.pending.clear();
    this.requests.clear();
    this.busy = false;
    this.interruptRequested = false;
    this.turnId = null;
    if (!this.closing) this.emit({ method: 'aya/disconnected', params: { message } });
  }

  async connect(cwd: string, model: string, configDir?: string, resumeThreadId?: string, unsafeMode = false) {
    if (this.child) throw Error('Start a new window for a separate session');
    this.cwd = await realpath(cwd);
    if (!(await stat(this.cwd)).isDirectory()) throw Error('Workspace must be a directory');
    const extPath = await ensurePiExtensionFile();
    const args = this.customArgs ?? [
      '--mode',
      'rpc',
      '--extension',
      extPath,
      ...(resumeThreadId ? ['--session', resumeThreadId] : []),
    ];
    const env = this.cleanEnv({
      ...(configDir ? { PI_CODING_AGENT_DIR: configDir } : {}),
      AYA_PI_SKIP_PERMISSIONS: unsafeMode ? '1' : '0',
    });
    if (!this.customArgs) {
      const { stdout } = await execFileAsync(this.executable, ['--version'], { cwd: this.cwd, env, timeout: 10000 });
      const version = stdout.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
      if (!version || (Number(version[1]) === 0 && (Number(version[2]) < 80 || (Number(version[2]) === 80 && Number(version[3]) < 4)))) {
        throw Error('Pi GUI requires Pi 0.80.4 or newer with agent_settled RPC events. Update Pi before reconnecting.');
      }
    }
    this.child = spawn(this.executable, args, {
      cwd: this.cwd,
      env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdin.on('error', () => {});
    this.writer = new GuiProtocolWriter(this.child.stdin, this.agentLabel, message => { this.failSession(message); this.close(); });
    this.child.stderr.on('data', (data) => {
      this.stderr = (this.stderr + String(data)).slice(-4000);
    });
    this.child.stdout.setEncoding('utf8');
    const frames = new GuiJsonLines(undefined, skipMalformedLine(this.agentLabel));
    this.child.stdout.on('data', data => {
      try {
        frames.push(String(data), message => {
          void this.receive(message).catch(error => { this.failSession(String(error)); this.close(); });
        });
      } catch (error) {
        this.failSession(`Pi: ${error instanceof Error ? error.message : String(error)}`);
        this.close();
      }
    });
    this.child.once('error', (error) => this.failSession(`Cannot start Pi: ${error.message}`));
    this.child.once('exit', (code) =>
      this.failSession(`Pi stopped (${code ?? 'signal'}). ${this.stderr}`),
    );
    try {
      const state = await this.rpc('get_state', {
        ...(resumeThreadId ? { sessionId: resumeThreadId } : {}),
        cwd: this.cwd,
      });
      const data = object(state.data);
      const modelObj = object(data.model);
      if (text(modelObj.id) && text(modelObj.provider)) {
        this.modelProviders.set(text(modelObj.id), text(modelObj.provider));
      }
      this.threadId = text(data.sessionId) || resumeThreadId || randomUUID();
      const resolvedModel = text(modelObj.id) || text(data.model) || model || 'Pi default';
      return { threadId: this.threadId, model: resolvedModel };
    } catch (error) {
      this.close();
      throw error;
    }
  }

  async models() {
    const res = await this.rpc('get_available_models');
    const rawModels = Array.isArray(object(res.data).models)
      ? (object(res.data).models as unknown[])
      : [];
    const data = rawModels.map((item) => {
      const m = object(item);
      const id = text(m.id) || text(m.model);
      const provider = text(m.provider);
      if (id && provider) this.modelProviders.set(id, provider);
      const efforts: { reasoningEffort: string }[] = [];
      if (Array.isArray(m.supportedReasoningEfforts)) {
        for (const e of m.supportedReasoningEfforts) {
          const re = text(object(e).reasoningEffort);
          if (re) efforts.push({ reasoningEffort: re });
        }
      } else if (m.reasoning) {
        const map = object(m.thinkingLevelMap);
        for (const level of ['low', 'medium', 'high', 'max']) {
          if (!(level in map) || map[level] !== null) {
            efforts.push({ reasoningEffort: level });
          }
        }
      }
      return {
        id,
        model: id,
        displayName: text(m.name) || text(m.displayName) || id,
        supportedReasoningEfforts: efforts,
        defaultReasoningEffort: text(m.defaultReasoningEffort) || (efforts[0]?.reasoningEffort ?? 'high'),
      };
    });
    return { data };
  }

  async command(name: string, argument: string): Promise<Record<string, unknown>> {
    if (!this.threadId) throw Error('Connect to Pi first');
    if (name === 'goal') return this.handleGoalCommand(argument);
    if (name === 'compact') {
      return this.rpc('compact', argument.trim() ? { customInstructions: argument.trim() } : {});
    }
    if (name === 'btw') throw Error('Pi does not support side questions through its RPC interface. Send a regular message instead.');
    throw Error(
      `Unsupported command /${name}. Use /help to see the commands available in GUI mode.`,
    );
  }

  async steer(prompt: string) {
    if (!this.busy || !this.turnId) throw Error('There is no active turn to steer');
    if (!prompt.trim() || prompt.length > 100000) {
      throw Error('Message must contain 1–100000 characters');
    }
    return this.rpc('steer', { message: prompt });
  }

  async send(
    prompt: string,
    options: { model?: string; effort?: string; images?: string[] } = {},
  ) {
    if (!this.threadId) throw Error('Connect to Pi first');
    if (this.busy) throw Error('Pi is working; stop the current turn first');
    if (!prompt.trim() || prompt.length > 100000) {
      throw Error('Prompt must contain 1–100000 characters');
    }
    this.busy = true;
    this.interruptRequested = false;
    this.turnId = `turn-${++this.nextId}`;
    this.currentItemId = `msg-${this.nextId}`;
    this.currentAssistantText = '';
    try {
      if (options.model) {
        const provider = this.modelProviders.get(options.model) || 'default';
        await this.rpc('set_model', { provider, modelId: options.model });
      }
      if (options.effort) {
        await this.rpc('set_thinking_level', { level: options.effort });
      }
      const images = await Promise.all(
        (options.images || []).map(async (imgPath) => {
          const encoded = await encodeImageAttachment(imgPath);
          return { type: 'image', data: encoded.data, mimeType: encoded.mimeType, path: imgPath };
        }),
      );
      const response = await this.rpc('prompt', {
        message: prompt,
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
        ...(images.length ? { images } : {}),
      });
      if (object(response.data).disposition === 'handled' && this.busy) {
        const id = this.turnId; this.busy = false; this.turnId = null;
        this.emit({ method: 'turn/completed', params: { turn: { id, status: 'completed' } } });
      }
    } catch (error) {
      this.busy = false;
      this.turnId = null;
      throw error;
    }
  }

  async interrupt() {
    if (this.busy) {
      this.interruptRequested = true;
      try { await this.rpc('abort'); } catch (error) { this.interruptRequested = false; throw error; }
    }
  }

  private async receive(raw: unknown) {
    const message = object(raw);
    const type = text(message.type);
    if (type === 'response' && typeof message.id === 'string') {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.success === false) {
        entry.reject(Error(text(message.error) || 'Pi RPC command failed'));
      } else {
        entry.resolve(message);
      }
      return;
    }

    if (type === 'extension_ui_request') {
      const id = (typeof message.id === 'string' || typeof message.id === 'number')
        ? message.id
        : randomUUID();
      const method = text(message.method);
      const title = text(message.title);
      if (method === 'input' && title.startsWith('__aya_tool__:')) {
        const toolName = title.slice('__aya_tool__:'.length);
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = object(JSON.parse(text(message.placeholder) || '{}'));
        } catch {
          parsedArgs = object(message.params);
        }
        if (toolName === 'ask_user_question') {
          const rawQuestions = Array.isArray(parsedArgs.questions) ? parsedArgs.questions : [];
          const questions = rawQuestions.map((q, idx) => {
            const qObj = object(q);
            return {
              ...qObj,
              id: text(qObj.id) || (rawQuestions.length === 1 ? 'choice' : `q_${idx}`),
              question: text(qObj.question) || text(qObj.title) || 'Question',
              multiSelect: Boolean(qObj.multiSelect ?? qObj.is_multi_select),
              options: Array.isArray(qObj.options) ? qObj.options : [],
            };
          });
          this.requests.set(id, {
            method: 'item/tool/requestUserInput',
            params: { questions },
            resolve: (val) => {
              const firstKey = text(object(questions[0]).id) || 'choice';
              const answer = questions.length <= 1 ? text(val.answers?.[firstKey]) : '';
              this.write({
                type: 'extension_ui_response',
                id,
                value: answer || JSON.stringify(val.answers || {}),
              });
            },
          });
          this.emit({ method: 'item/tool/requestUserInput', params: { questions }, id });
          return;
        }
        const outcome = await this.executeAyaTool(toolName, parsedArgs);
        this.write({ type: 'extension_ui_response', id, value: JSON.stringify(outcome) });
        return;
      }
      if (method === 'confirm') {
        const commandText = text(message.message) || title || 'Confirm tool execution';
        this.requests.set(id, {
          method: 'item/commandExecution/requestApproval',
          params: { command: commandText, reason: title },
          resolve: (val) => {
            this.write({
              type: 'extension_ui_response',
              id,
              confirmed: val.decision === 'accept',
            });
          },
        });
        this.emit({
          method: 'item/commandExecution/requestApproval',
          params: { command: commandText, reason: title },
          id,
        });
        return;
      }
      return;
    }

    if (type === 'agent_start' || type === 'turn_start') {
      if (!this.turnId) this.turnId = `turn-${++this.nextId}`;
      if (!this.currentItemId) this.currentItemId = `msg-${this.nextId}`;
      this.busy = true;
      this.emit({ method: 'turn/started', params: { turn: { id: this.turnId } } });
      return;
    }

    if (type === 'message_update') {
      const evt = object(message.assistantMessageEvent);
      if (text(evt.type) === 'text_delta' && text(evt.delta)) {
        const delta = text(evt.delta);
        this.currentAssistantText += delta;
        const itemId = this.currentItemId || 'answer';
        this.emit({ method: 'item/agentMessage/delta', params: { itemId, delta } });
      }
      return;
    }

    if (type === 'message_end') {
      const msg = object(message.message);
      if (text(msg.role) === 'assistant') {
        let finalText = this.currentAssistantText;
        if (!finalText && Array.isArray(msg.content)) {
          finalText = msg.content
            .map((part) => text(object(part).text))
            .filter(Boolean)
            .join('');
        } else if (!finalText && typeof msg.content === 'string') {
          finalText = msg.content;
        }
        if (finalText) {
          const itemId = this.currentItemId || 'answer';
          this.checkGoalCompletionInText(finalText);
          this.emit({
            method: 'item/completed',
            params: { item: { id: itemId, type: 'agentMessage', text: finalText } },
          });
        }
      }
      return;
    }

    if (type === 'tool_execution_start') {
      const toolName = text(message.toolName);
      const args = object(message.args);
      const itemId = text(message.toolCallId) || `tool-${++this.nextId}`;
      const itemType =
        toolName === 'bash' || toolName === 'powershell'
          ? 'commandExecution'
          : toolName === 'edit' || toolName === 'write'
            ? 'fileChange'
            : toolName.startsWith('aya_')
              ? 'dynamicToolCall'
              : 'mcpToolCall';
      this.emit({
        method: 'item/started',
        params: {
          item: {
            id: itemId,
            type: itemType,
            tool: toolName,
            command: text(args.command) || text(args.path) || toolName,
            status: 'inProgress',
          },
        },
      });
      return;
    }

    if (type === 'tool_execution_update') {
      const itemId = text(message.toolCallId);
      const partial = object(message.partialResult);
      const delta =
        text(message.delta) ||
        (Array.isArray(partial.content)
          ? partial.content.map((c) => text(object(c).text)).join('')
          : '');
      if (itemId && delta) {
        this.emit({ method: 'item/commandExecution/outputDelta', params: { itemId, delta } });
      }
      return;
    }

    if (type === 'tool_execution_end') {
      const toolName = text(message.toolName);
      const itemId = text(message.toolCallId) || 'tool';
      const result = object(message.result);
      const output = Array.isArray(result.content)
        ? result.content.map((c) => text(object(c).text)).join('')
        : text(result.output);
      const itemType =
        toolName === 'bash' || toolName === 'powershell'
          ? 'commandExecution'
          : toolName === 'edit' || toolName === 'write'
            ? 'fileChange'
            : toolName.startsWith('aya_')
              ? 'dynamicToolCall'
              : 'mcpToolCall';
      this.emit({
        method: 'item/completed',
        params: {
          item: {
            id: itemId,
            type: itemType,
            tool: toolName,
            status: message.isError ? 'failed' : 'completed',
            aggregatedOutput: output,
          },
        },
      });
      return;
    }

    if (type === 'agent_settled') {
      const aborted = message.aborted === true || this.interruptRequested;
      this.interruptRequested = false;
      this.pauseRunningProgressOnTurnEnd(false);
      const finishedTurnId = this.turnId || 'turn';
      this.busy = false;
      this.turnId = null;
      this.requests.clear();
      this.emit({
        method: 'turn/completed',
        params: { turn: { id: finishedTurnId, status: aborted ? 'interrupted' : 'completed' } },
      });
      return;
    }

    if (text(message.method).startsWith('fixture/')) {
      this.emit({ method: text(message.method), params: object(message.params) });
    }
  }
}

/** Claude Code's subagent tool: `Agent`, called `Task` in older versions. */
const CLAUDE_AGENT_TOOLS = new Set(['Agent', 'Task']);
const CLAUDE_EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

interface ClaudeSubagent {
  /** Claude's agent ID (`task_id`; `agent_id` in the agent's permission requests). */
  taskId: string;
  description: string;
  prompt: string;
  subagentType: string;
  /** Runs past the end of the turn that started it. */
  background: boolean;
  done: boolean;
  output: string;
}

/** One line of a subagent's progress: "Read: src/main.ts", "Bash: Run the tests". */
function subagentToolLine(name: string, input: Record<string, unknown>): string {
  const detail = text(input.description) || text(input.command) || text(input.file_path) || text(input.path) || text(input.pattern) || text(input.url) || text(input.query);
  const line = detail.replace(/\s+/g, ' ').trim();
  return `${name}${line ? `: ${line.length > 160 ? `${line.slice(0, 159)}…` : line}` : ''}`;
}

export class ClaudeGuiSession extends BaseManagedGuiSession {
  private pendingControl = new Map<
    string,
    {
      resolve: (value: Record<string, unknown>) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private nextId = 0;
  private turnId: string | null = null;
  private currentItemId = '';
  private currentAssistantText = '';
  private cachedModels: Record<string, unknown>[] = [];
  private handledQuestionToolIds = new Set<string>();
  private pendingAssistantQuestions: unknown[] | null = null;
  private chromeCommandPending = false;
  /** Subagents started with the Agent tool, by that tool call's ID. Reported as Codex `collabAgentToolCall` items. */
  private agents = new Map<string, ClaudeSubagent>();
  /** Live output of the shell commands subagents run, by Claude's shell task ID. */
  private taskTails = new Map<string, { agentId: string; tail: TaskOutputTail }>();
  private claudeEnv: NodeJS.ProcessEnv = {};
  /** The usage limits Claude reported during the current turn. */
  private usageLimits = new ClaudeUsageLimitTracker();
  /** Tool calls of the current turn still waiting for their result, so a failed one can be reported as failed. */
  private openTools = new Map<string, Record<string, unknown>>();
  private permissionMode: GuiPermissionMode = 'supervised';
  /** The transcript head: uuid of the last top-level assistant message, the cut point for --resume-session-at. */
  private lastAssistantUuid = '';
  private launchOptions: { configDir?: string; unsafeMode: boolean; model: string; permissionMode?: GuiPermissionMode } = { unsafeMode: false, model: '' };
  private promptSuggestions = false;
  private skillList: GuiSkill[] = [];
  private contextUsagePending = false;

  constructor(
    emit: (event: GuiEvent) => void,
    private readonly executable = 'claude',
    private readonly customArgs?: string[],
  ) {
    super(emit, 'Claude');
  }

  private write(value: unknown) {
    if (!this.child || this.child.stdin.destroyed) throw Error('Claude is disconnected');
    if (!this.writer) throw Error(`${this.agentLabel} is disconnected`); this.writer.write(value);
  }

  private controlRequest(
    subtype: string,
    payload: Record<string, unknown> = {},
    timeoutMs = 60000,
  ): Promise<Record<string, unknown>> {
    const requestId = `claude-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingControl.delete(requestId);
        reject(Error(`${subtype} response timed out; the agent may still be working`));
      }, timeoutMs);
      timer.unref();
      this.pendingControl.set(requestId, { resolve, reject, timer });
      try {
        this.write({
          type: 'control_request',
          request_id: requestId,
          request: { subtype, ...payload },
        });
      } catch (error) {
        clearTimeout(timer);
        this.pendingControl.delete(requestId);
        reject(error instanceof Error ? error : Error(String(error)));
      }
    });
  }

  protected failSession(message: string) {
    this.writer?.close(); this.writer = null;
    for (const entry of this.pendingControl.values()) {
      clearTimeout(entry.timer);
      entry.reject(Error(message));
    }
    this.pendingControl.clear();
    this.requests.clear();
    this.agents.clear();
    for (const { tail } of this.taskTails.values()) tail.dispose();
    this.taskTails.clear();
    this.busy = false;
    this.turnId = null;
    if (!this.closing) this.emit({ method: 'aya/disconnected', params: { message } });
  }

  /** A turn's per-turn state starts empty, whether the user sent it or Claude started it. */
  private beginTurn() {
    this.busy = true;
    this.turnId = `turn-${++this.nextId}`;
    this.currentItemId = `msg-${randomUUID()}`;
    this.currentAssistantText = '';
    this.handledQuestionToolIds.clear();
    this.pendingAssistantQuestions = null;
    this.usageLimits.reset();
    this.openTools.clear();
  }

  /** Claude starts a turn by itself when a background subagent reports back. Without its own turn, its answer would
   *  be appended to the previous reply and its result would replace that reply's text. */
  private ensureTurn() {
    if (this.busy) return;
    this.beginTurn();
    this.emit({ method: 'turn/started', params: { turn: { id: this.turnId } } });
  }

  private reportAgent(id: string, method: 'item/started' | 'item/completed', status?: string) {
    const agent = this.agents.get(id);
    if (!agent) return;
    this.emit({
      method,
      params: {
        item: {
          id,
          type: 'collabAgentToolCall',
          tool: 'spawnAgent',
          senderThreadId: this.threadId,
          receiverThreadIds: agent.taskId ? [agent.taskId] : [],
          agentsStates: {},
          ...(agent.description ? { description: agent.description } : {}),
          ...(agent.prompt ? { prompt: agent.prompt } : {}),
          ...(agent.subagentType ? { subagentType: agent.subagentType } : {}),
          ...(agent.background ? { background: true } : {}),
          ...(agent.output ? { aggregatedOutput: agent.output } : {}),
          status: status ?? 'inProgress',
        },
      },
    });
  }

  /** Appends to a subagent's output: a line of progress, or (`raw`) what its command printed. */
  private agentOutput(id: string, line: string, raw = false) {
    const agent = this.agents.get(id);
    if (!agent || agent.done || !line) return;
    const delta = (!raw && agent.output && !agent.output.endsWith('\n') ? '\n' : '') + line;
    agent.output = (agent.output + delta).slice(-100000);
    this.emit({ method: 'item/commandExecution/outputDelta', params: { itemId: id, delta } });
  }

  private finishAgent(id: string, status: string, report: string) {
    const agent = this.agents.get(id);
    if (!agent || agent.done) return;
    for (const [taskId, entry] of this.taskTails) if (entry.agentId === id) { entry.tail.dispose(); this.taskTails.delete(taskId); }
    if (report.trim()) agent.output = (agent.output ? `${agent.output}${agent.output.endsWith('\n') ? '\n' : '\n\n'}${report.trim()}` : report.trim()).slice(-100000);
    agent.done = true;
    // A stopped subagent's questions and approvals have no one waiting for them any more.
    for (const [requestId, request] of this.requests) {
      if (agent.taskId && request.params.subagentTaskId === agent.taskId) { this.requests.delete(requestId); this.emit({ method: 'aya/requestResolved', params: { id: requestId } }); }
    }
    this.reportAgent(id, 'item/completed', status);
    // The finished row has its output; only the last 100 finished agents are kept, without it, for late events.
    agent.output = '';
    for (const [agentId, entry] of this.agents) { if (this.agents.size <= 100) break; if (entry.done) this.agents.delete(agentId); }
  }

  /** Streams what a shell command a subagent runs prints, from the file Claude writes it to. */
  private tailSubagentTask(agentId: string, message: Record<string, unknown>) {
    const taskId = text(message.task_id);
    const root = claudeTaskOutputRoot(this.claudeEnv, this.cwd);
    if (!taskId || this.taskTails.has(taskId) || (!root && !text(message.output_file))) return;
    let first = true;
    const tail = new TaskOutputTail({
      ...(text(message.output_file) ? { file: text(message.output_file) } : {}),
      ...(root ? { root } : {}),
      cwd: this.cwd,
      sessionId: text(message.session_id) || this.threadId,
      taskId,
      onChunk: chunk => {
        const output = this.agents.get(agentId)?.output || '';
        this.agentOutput(agentId, (first && output && !output.endsWith('\n') ? '\n' : '') + chunk, true);
        first = false;
      },
    });
    this.taskTails.set(taskId, { agentId, tail });
  }

  /** Stops one subagent; Claude reports it stopped and may then continue by itself. */
  async stopSubagent(id: string) {
    const agent = this.agents.get(id);
    if (!agent || agent.done) return;
    if (!agent.taskId) throw Error('This subagent has not started yet');
    try { await this.controlRequest('stop_task', { task_id: agent.taskId }, 15000); }
    catch (error) {
      // It finished while the stop was on its way: its own report ends the row.
      if (agent.done || /not running|no task found/i.test(error instanceof Error ? error.message : String(error))) return;
      throw error;
    }
    this.finishAgent(id, 'interrupted', '');
  }

  /** "Subagent: Read the config" for an approval or question a subagent asks; empty for the main agent. */
  private subagentOf(agentId: string): string {
    if (!agentId) return '';
    for (const agent of this.agents.values()) {
      if (agent.taskId === agentId) return agent.description ? `Subagent: ${agent.description}` : 'A subagent';
    }
    return 'A subagent';
  }

  async connect(cwd: string, model: string, configDir?: string, resumeThreadId?: string, unsafeMode = false, permissionMode?: GuiPermissionMode) {
    if (this.child) throw Error('Start a new window for a separate session');
    this.cwd = await realpath(cwd);
    if (!(await stat(this.cwd)).isDirectory()) throw Error('Workspace must be a directory');
    this.threadId = resumeThreadId || randomUUID();
    this.launchOptions = { configDir, unsafeMode, model, permissionMode };
    return this.launch(resumeThreadId ? ['--resume', resumeThreadId] : ['--session-id', this.threadId]);
  }

  private async launch(sessionArgs: string[]) {
    const { configDir, unsafeMode, model, permissionMode } = this.launchOptions;
    // Full access needs bypassPermissions, which Claude only allows mid-session when launched with the allow flag.
    const fullAccess = permissionMode ? permissionMode === 'full-access' : unsafeMode;
    const args = [...(this.customArgs ?? [
      '--output-format',
      'stream-json',
      '--verbose',
      '--input-format',
      'stream-json',
      '--include-partial-messages',
      '--permission-prompt-tool=stdio',
      '--chrome',
      ...sessionArgs,
    ]), ...(fullAccess ? ['--dangerously-skip-permissions'] : ['--allow-dangerously-skip-permissions'])];
    // Explicitly setting even ~/.claude changes Claude's macOS Keychain account.
    // Match the terminal preset: only override the environment for a custom directory.
    const claudeDir = configDir?.trim().replace(/^(?:~|\$HOME)(?=\/|$)/, homedir());
    const customDir = claudeDir && path.resolve(claudeDir) !== path.join(homedir(), '.claude');
    // File checkpoints let "Edit from here" restore what Claude's edit tools changed (rewind_files).
    const env = this.cleanEnv({ CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: 'true', ...(customDir ? { CLAUDE_CONFIG_DIR: claudeDir } : {}) });
    this.claudeEnv = env;
    const child = spawn(this.executable, args, {
      cwd: this.cwd,
      env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdin.on('error', () => {});
    this.writer = new GuiProtocolWriter(child.stdin, this.agentLabel, message => { if (this.child !== child) return; this.failSession(message); this.close(); });
    child.stderr.on('data', (data) => {
      this.stderr = (this.stderr + String(data)).slice(-4000);
    });
    child.stdout.setEncoding('utf8');
    const frames = new GuiJsonLines(undefined, skipMalformedLine(this.agentLabel));
    child.stdout.on('data', data => {
      if (this.child !== child) return;
      try {
        frames.push(String(data), message => {
          // A reply still on its way from a Claude that Edit from here replaced must not end the new one.
          void this.receive(message).catch(error => { if (this.child !== child) return; this.failSession(String(error)); this.close(); });
        });
      } catch (error) {
        this.failSession(`Claude: ${error instanceof Error ? error.message : String(error)}`);
        this.close();
      }
    });
    child.once('error', (error) => { if (this.child === child) this.failSession(`Cannot start Claude: ${error.message}`); });
    child.once('exit', (code) => {
      if (this.child === child) this.failSession(`Claude stopped (${code ?? 'signal'}). ${this.stderr}`);
    });
    try {
      const initRes = await this.controlRequest('initialize', {
        sdkMcpServers: ['aya'],
        appendSystemPrompt: buildGuiDeveloperInstructions('Claude'),
        promptSuggestions: this.promptSuggestions,
      });
      const responseObj = object(initRes.response);
      this.skillList = claudeSkills(responseObj.commands);
      void this.refreshContextUsage();
      if (Array.isArray(responseObj.models)) {
        this.cachedModels = (responseObj.models as unknown[]).map((raw) => {
          const m = object(raw);
          const id = text(m.value) || text(m.id) || text(m.model);
          return {
            id,
            model: id,
            displayName: text(m.displayName) || text(m.label) || id,
            supportedReasoningEfforts: [
              { reasoningEffort: 'low' },
              { reasoningEffort: 'medium' },
              { reasoningEffort: 'high' },
            ],
            defaultReasoningEffort: 'high',
          };
        });
      }
      if (text(responseObj.session_id)) {
        this.threadId = text(responseObj.session_id);
      }
      // A pane with no choice yet keeps the mode Claude starts in, which its settings may set.
      this.permissionMode = fromClaudePermissionMode(responseObj.current_permission_mode) ?? (fullAccess ? 'full-access' : 'supervised');
      if (permissionMode && permissionMode !== this.permissionMode) {
        try { await this.setPermissionMode(permissionMode); }
        catch (error) {
          this.emit({ method: 'aya/notice', params: { message: `Claude could not switch to ${guiPermissionModeLabel(permissionMode)}: ${error instanceof Error ? error.message : String(error)}. This conversation uses ${guiPermissionModeLabel(this.permissionMode)}.` } });
        }
      }
      const activeModel =
        text(responseObj.model) ||
        text(this.cachedModels[0]?.model) ||
        model ||
        'Claude default';
      return { threadId: this.threadId, model: activeModel, permissionMode: this.permissionMode };
    } catch (error) {
      this.close();
      throw error;
    }
  }

  async models() {
    return { data: this.cachedModels };
  }

  /** Takes effect at once, even mid-turn; Claude refuses Full access when its settings disable bypass mode. */
  async setPermissionMode(mode: GuiPermissionMode) {
    if (!this.threadId) throw Error('Connect to Claude first');
    await this.controlRequest('set_permission_mode', { mode: claudePermissionMode(mode) }, 10000);
    this.permissionMode = mode;
    // Claude asked before the switch; what the new mode would not have asked about is answered for it.
    let waiting = 0;
    for (const [id, request] of [...this.requests]) {
      if (request.method === 'item/tool/requestUserInput') continue;
      const allowed = !request.params.subagent && (mode === 'full-access' || (mode === 'auto-accept-edits' && CLAUDE_EDIT_TOOLS.has(text(request.params.tool))));
      if (allowed) await this.respond(id, { decision: 'accept' }); else waiting++;
    }
    if (waiting) this.emit({ method: 'aya/notice', params: { message: pendingApprovalsNotice(waiting, mode) } });
  }

  /** Takes effect for suggestions shown now; Claude generates them only when this was on at connect. */
  setPromptSuggestions(enabled: boolean) { this.promptSuggestions = enabled; }

  async skills() { return this.skillList; }

  /** Asked once per turn end (and at connect), never while a request is already out. */
  private async refreshContextUsage() {
    if (this.contextUsagePending) return;
    this.contextUsagePending = true;
    try {
      const usage = claudeContextUsage((await this.controlRequest('get_context_usage', { detail: 'summary' }, 10000)).response);
      if (usage) this.emit({ method: 'aya/contextUsage', params: { ...usage } });
    } catch { /* older Claude Code: the meter stays hidden */ }
    finally { this.contextUsagePending = false; }
  }

  async command(name: string, argument: string): Promise<Record<string, unknown>> {
    if (!this.threadId) throw Error('Connect to Claude first');
    if (name === 'usage') {
      if (argument.trim()) throw Error('Usage: /usage');
      let response: Record<string, unknown>;
      try { response = await this.controlRequest('get_usage', { skip_behaviors: true }, 10000); }
      catch (error) { throw Error(`Could not read Claude usage: ${error instanceof Error ? error.message : String(error)}. If unsupported, update Claude Code and reconnect.`); }
      return { text: formatClaudeUsage(response.response) };
    }
    if (name === 'chrome') {
      if (this.busy && !['', 'status'].includes(argument.trim().toLowerCase())) throw Error('Stop the current turn before changing the Chrome connection.');
      if (this.chromeCommandPending) throw Error('Wait for the Chrome command to finish.');
      this.chromeCommandPending = true;
      try {
        return await claudeChromeCommand(argument, async (subtype, payload) =>
          object((await this.controlRequest(subtype, payload, subtype === 'get_chrome_dialog' ? 10000 : 60000)).response));
      } finally { this.chromeCommandPending = false; }
    }
    if (name === 'goal') return this.handleGoalCommand(argument);
    if (name === 'compact') {
      await this.send(`/compact ${argument}`.trim());
      return {};
    }
    if (name === 'btw') {
      if (this.busy) {
        throw Error('Side questions currently require a completed turn. Wait for Claude or stop it first.');
      }
      if (!argument.trim()) throw Error('Usage: /btw your side question');
      const res = await this.controlRequest('side_question', { question: argument });
      const inner = object(res.response);
      return {
        text: text(inner.response) || text(inner.answer) || text(inner.text) || '',
      };
    }
    throw Error(
      `Unsupported command /${name}. Use /goal, /btw, /compact, /chrome or /usage. Other CLI commands remain available in Terminal mode.`,
    );
  }

  async steer(prompt: string) {
    if (!this.busy || !this.turnId) throw Error('There is no active turn to steer');
    if (!prompt.trim() || prompt.length > 100000) {
      throw Error('Message must contain 1–100000 characters');
    }
    this.write({
      type: 'user',
      session_id: this.threadId,
      steer: true,
      message: { role: 'user', content: [{ type: 'text', text: prompt }] },
      parent_tool_use_id: null,
    });
    return { turnId: this.turnId };
  }

  async send(
    prompt: string,
    options: { model?: string; effort?: string; images?: string[] } = {},
  ) {
    if (!this.threadId) throw Error('Connect to Claude first');
    if (this.busy) throw Error('Claude is working; stop the current turn first');
    if (this.chromeCommandPending) throw Error('Wait for the Chrome command to finish before sending a message.');
    if (!prompt.trim() || prompt.length > 100000) {
      throw Error('Prompt must contain 1–100000 characters');
    }
    this.beginTurn();
    try {
      if (options.model) {
        await this.controlRequest('set_model', { model: options.model });
      }
      const content: Record<string, unknown>[] = [{ type: 'text', text: prompt }];
      for (const imgPath of options.images || []) {
        const encoded = await encodeImageAttachment(imgPath);
        content.push({
          type: 'image',
          path: imgPath,
          source: { type: 'base64', media_type: encoded.mimeType, data: encoded.data },
        });
      }
      this.emit({ method: 'turn/started', params: { turn: { id: this.turnId } } });
      // Claude keeps this uuid in its transcript; Edit from here rewinds files to it.
      const claudeUser = randomUUID();
      this.write({
        type: 'user',
        uuid: claudeUser,
        session_id: this.threadId,
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
        message: { role: 'user', content },
        parent_tool_use_id: null,
      });
      return { claudeUser };
    } catch (error) {
      this.busy = false;
      this.turnId = null;
      throw error;
    }
  }

  /** Stops the turn and every subagent, including background ones that outlived their turn: Claude's interrupt stops
   *  them too (it spares them only for a client that declares its own per-task stop), and an older Claude that does
   *  not is sent a stop for each one still running. */
  async previewFileRewind(target: EditTarget): Promise<string[] | null> {
    if (this.busy) throw Error('Stop the current turn first');
    if (!target.claudeUser) return null;
    try {
      const result = object((await this.controlRequest('rewind_files', { user_message_id: target.claudeUser, dry_run: true }, 20000)).response);
      if (result.canRewind !== true) return null;
      const files = Array.isArray(result.filesChanged) ? result.filesChanged.filter((f): f is string => typeof f === 'string') : [];
      return files.every(file => insideDirectory(this.cwd, path.resolve(this.cwd, file))) ? files : null;
    } catch { return null; }
  }

  async rewindFiles(target: EditTarget) {
    const files = await this.previewFileRewind(target);
    if (!files) throw Error('Claude has no file checkpoint for this message inside the workspace');
    const result = object((await this.controlRequest('rewind_files', { user_message_id: target.claudeUser })).response);
    if (result.canRewind !== true) throw Error(text(result.error) || 'Claude could not restore the files');
  }

  /** Restart Claude on its transcript cut just before the message: --resume-session-at the previous
   *  assistant message, forked into a new session so the dropped turns never come back on resume. */
  async editFromHere(target: EditTarget) {
    if (this.busy) throw Error('Stop the current turn first');
    if (target.resumeAt !== null && !target.resumeAt) throw Error('This message cannot be edited: Claude did not report where its turn began');
    const previous = this.threadId, next = randomUUID();
    const child = this.child;
    this.closing = true;
    this.writer?.close(); this.writer = null; this.child = null;
    this.failSession('Restarting Claude');
    this.terminate(child);
    this.closing = false; this.stderr = '';
    this.threadId = next;
    this.lastAssistantUuid = target.resumeAt || '';
    // The restarted Claude keeps the pane's current permission mode.
    this.launchOptions = { ...this.launchOptions, permissionMode: this.permissionMode };
    try {
      const result = await this.launch(target.resumeAt ? ['--resume', previous, '--resume-session-at', target.resumeAt, '--fork-session', '--session-id', next] : ['--session-id', next]);
      this.emit({ method: 'aya/session', params: { threadId: this.threadId, model: result.model } });
      return { threadId: this.threadId };
    } catch (error) {
      this.closing = false;
      this.emit({ method: 'aya/disconnected', params: { message: `Claude could not restart at the earlier message: ${error instanceof Error ? error.message : String(error)}` } });
      throw error;
    }
  }

  async interrupt() {
    const running = [...this.agents].filter(([, agent]) => !agent.done).map(([id]) => id);
    if (!this.busy && !running.length) return;
    // Idle, an older Claude may refuse the interrupt; its subagents are still stopped one by one.
    try { await this.controlRequest('interrupt'); } catch (error) { if (this.busy) throw error; }
    // A subagent whose stop failed (an older Claude, a timeout) keeps its row: it still runs, and reports when it ends.
    await Promise.all(running.map(id => this.stopSubagent(id).catch(() => {})));
  }

  private async receive(raw: unknown) {
    const message = object(raw);
    const type = text(message.type);

    if (type === 'control_response') {
      const resp = object(message.response);
      const reqId = text(resp.request_id);
      const entry = this.pendingControl.get(reqId);
      if (!entry) return;
      this.pendingControl.delete(reqId);
      clearTimeout(entry.timer);
      if (text(resp.subtype) === 'error') {
        entry.reject(Error(text(resp.error) || 'Claude control request failed'));
      } else {
        entry.resolve(resp);
      }
      return;
    }

    // Claude withdrew a request it sent (a tool call that was cancelled while it waited for an answer).
    if (type === 'control_cancel_request') {
      const id = text(message.request_id);
      if (this.requests.delete(id)) this.emit({ method: 'aya/requestResolved', params: { id } });
      return;
    }

    if (type === 'control_request') {
      const reqId = text(message.request_id) || randomUUID();
      const req = object(message.request);
      const subtype = text(req.subtype);

      if (subtype === 'mcp_message' && text(req.server_name) === 'aya') {
        const owner = this.child;
        const mcpMsg = object(req.message);
        const mcpMethod = text(mcpMsg.method);
        const mcpId = mcpMsg.id ?? null;
        let mcpResponse: Record<string, unknown>;
        if (mcpMethod === 'initialize') {
          mcpResponse = {
            jsonrpc: '2.0',
            id: mcpId,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'aya', version: '0.1.0' },
            },
          };
        } else if (mcpMethod === 'notifications/initialized') {
          mcpResponse = { jsonrpc: '2.0', result: {} };
        } else if (mcpMethod === 'tools/list') {
          mcpResponse = {
            jsonrpc: '2.0',
            id: mcpId,
            result: {
              tools: [PRESENT_TOOL, OPEN_ARTIFACT_TOOL, PROGRESS_TOOL].map((t) => ({
                name: t.name,
                description: t.description,
                inputSchema: t.inputSchema,
              })),
            },
          };
        } else if (mcpMethod === 'tools/call') {
          const callParams = object(mcpMsg.params);
          const toolName = text(callParams.name);
          const outcome = await this.executeAyaTool(toolName, callParams.arguments);
          mcpResponse = {
            jsonrpc: '2.0',
            id: mcpId,
            result: {
              content: [{ type: 'text', text: outcome.text }],
              isError: !outcome.success,
            },
          };
        } else {
          mcpResponse = {
            jsonrpc: '2.0',
            id: mcpId,
            error: { code: -32601, message: `Unsupported MCP method: ${mcpMethod}` },
          };
        }
        // The tool ran while Claude was restarted (Edit from here): the Claude that asked is gone.
        if (this.child !== owner) return;
        this.write({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: reqId,
            response: { mcp_response: mcpResponse },
          },
        });
        return;
      }

      if (subtype === 'can_use_tool') {
        const toolName = text(req.tool_name);
        const input = object(req.input);
        const toolUseId = text(req.tool_use_id) || reqId;
        const subagent = this.subagentOf(text(req.agent_id));
        const origin = subagent ? { subagent, subagentTaskId: text(req.agent_id) } : {};
        if (toolName.startsWith('mcp__aya__') || toolName.startsWith('aya_')) {
          this.write({
            type: 'control_response',
            response: {
              subtype: 'success',
              request_id: reqId,
              response: { behavior: 'allow', updatedInput: input, toolUseID: toolUseId },
            },
          });
          return;
        }
        if (toolName === 'AskUserQuestion') {
          this.handledQuestionToolIds.add(toolUseId);
          const rawQuestions = Array.isArray(input.questions) ? input.questions : [];
          const questions = rawQuestions.map((q, idx) => {
            const qObj = object(q);
            return {
              ...qObj,
              id: text(qObj.id) || (rawQuestions.length === 1 ? 'choice' : text(qObj.header) || `q_${idx}`),
              header: text(qObj.header),
              question: text(qObj.question) || text(qObj.title) || 'Question',
              multiSelect: Boolean(qObj.multiSelect ?? qObj.is_multi_select),
              options: Array.isArray(qObj.options) ? qObj.options : [],
            };
          });
          this.requests.set(reqId, {
            method: 'item/tool/requestUserInput',
            params: { questions, ...origin },
            resolve: (val) => {
              const rawAnswers = val.answers || {};
              const resolvedAnswers: Record<string, string> = { ...rawAnswers };
              for (const q of questions) {
                const ans =
                  text(rawAnswers[q.id]) ||
                  text(rawAnswers[q.question]) ||
                  (q.header ? text(rawAnswers[q.header]) : '');
                if (ans) {
                  resolvedAnswers[q.id] = ans;
                  resolvedAnswers[q.question] = ans;
                  if (q.header) resolvedAnswers[q.header] = ans;
                }
              }
              this.write({
                type: 'control_response',
                response: {
                  subtype: 'success',
                  request_id: reqId,
                  response: {
                    behavior: 'allow',
                    updatedInput: { ...input, answers: resolvedAnswers },
                    toolUseID: toolUseId,
                  },
                },
              });
            },
          });
          this.emit({ method: 'item/tool/requestUserInput', params: { questions, ...origin }, id: reqId });
          return;
        }
        const commandText =
          text(input.command) || text(input.file_path) || text(input.path) || toolName;
        this.requests.set(reqId, {
          method: 'item/commandExecution/requestApproval',
          params: { command: commandText, reason: text(req.decision_reason) || `Run ${toolName}`, tool: toolName, ...origin },
          resolve: (val) => {
            if (val.decision === 'accept') {
              this.write({
                type: 'control_response',
                response: {
                  subtype: 'success',
                  request_id: reqId,
                  response: { behavior: 'allow', updatedInput: input, toolUseID: toolUseId },
                },
              });
            } else {
              this.write({
                type: 'control_response',
                response: {
                  subtype: 'success',
                  request_id: reqId,
                  response: {
                    behavior: 'deny',
                    message: claudeDeclineMessage(val.note),
                    toolUseID: toolUseId,
                  },
                },
              });
            }
          },
        });
        this.emit({
          method: 'item/commandExecution/requestApproval',
          params: { command: commandText, reason: text(req.decision_reason) || `Run ${toolName}`, ...origin },
          id: reqId,
        });
        return;
      }
      return;
    }

    if (type === 'rate_limit_event' || (type === 'assistant' && text(message.error) === 'rate_limit')) this.usageLimits.observe(message);
    if (type === 'rate_limit_event') return;
    // Claude reports its mode when it changes, including the switches it makes by itself.
    if (type === 'system' && text(message.subtype) === 'status' && 'permissionMode' in message) {
      const mode = fromClaudePermissionMode(message.permissionMode);
      if (mode && mode !== this.permissionMode) { this.permissionMode = mode; this.emit({ method: 'aya/permissionMode', params: { mode } }); }
      return;
    }

    if (type === 'prompt_suggestion') {
      const suggestion = cleanPromptSuggestion(message.suggestion);
      if (suggestion && this.promptSuggestions && !this.busy) this.emit({ method: 'aya/promptSuggestion', params: { text: suggestion } });
      return;
    }

    if (type === 'system' && text(message.subtype) === 'commands_changed') {
      this.skillList = claudeSkills(message.commands);
      this.emit({ method: 'aya/skillsChanged', params: {} });
      return;
    }

    if (type === 'system' && text(message.subtype) === 'init') {
      if (text(message.session_id)) this.threadId = text(message.session_id);
      this.emit({ method: 'aya/session', params: { threadId: this.threadId, ...(text(message.model) ? { model: text(message.model) } : {}) } });
      return;
    }

    // Subagent lifecycle. Background shell tasks report through the same events; only Agent calls are tracked.
    if (type === 'system' && ['task_started', 'task_notification'].includes(text(message.subtype))) {
      // A shell command a subagent runs: tail what it prints into the subagent's output while it runs.
      const parentTask = text(message.parent_task_id);
      const owner = parentTask ? [...this.agents].find(([, agent]) => agent.taskId === parentTask && !agent.done)?.[0] : undefined;
      if (text(message.subtype) === 'task_started' && owner && text(message.task_type) === 'local_bash') { this.tailSubagentTask(owner, message); return; }
      const tailed = this.taskTails.get(text(message.task_id));
      if (tailed && text(message.subtype) === 'task_notification') {
        this.taskTails.delete(text(message.task_id));
        void tailed.tail.stop();
        return;
      }
      const id = text(message.tool_use_id) || [...this.agents].find(([, agent]) => agent.taskId === text(message.task_id))?.[0] || '';
      const agent = this.agents.get(id);
      if (!agent) return;
      if (text(message.subtype) === 'task_started') {
        agent.taskId = text(message.task_id) || agent.taskId;
        agent.description ||= text(message.description);
        agent.subagentType ||= text(message.subagent_type);
        agent.prompt ||= text(message.prompt);
        if (message.is_backgrounded === true) agent.background = true;
        if (!agent.done) this.reportAgent(id, 'item/started');
      } else {
        const status = text(message.status);
        this.finishAgent(id, status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'interrupted', text(message.summary));
      }
      return;
    }

    // A subagent's own messages carry the Agent call's ID; they are its progress, never the conversation's reply.
    const parentToolUseId = text(message.parent_tool_use_id);
    if (parentToolUseId && (type === 'stream_event' || type === 'assistant' || type === 'user')) {
      if (type === 'assistant') {
        const content = object(message.message).content;
        for (const block of Array.isArray(content) ? content : []) {
          const b = object(block);
          if (text(b.type) === 'tool_use') this.agentOutput(parentToolUseId, subagentToolLine(text(b.name), object(b.input)));
        }
      }
      return;
    }

    if (type === 'user') {
      // An Agent call's result. A background agent's result only says it was launched; its report comes later.
      const content = object(message.message).content;
      for (const block of Array.isArray(content) ? content : []) {
        const b = object(block);
        const id = text(b.tool_use_id);
        const agent = this.agents.get(id);
        const tool = text(b.type) === 'tool_result' ? this.openTools.get(id) : undefined;
        if (tool) {
          this.openTools.delete(id);
          this.emit({ method: 'item/completed', params: { item: { ...tool, status: b.is_error === true ? 'failed' : 'completed' } } });
        }
        if (text(b.type) !== 'tool_result' || !agent || agent.done) continue;
        const result = Array.isArray(b.content) ? b.content.map(part => text(object(part).text)).join('\n') : text(b.content);
        if (agent.background || /^Async agent launched/.test(result)) {
          if (!agent.background) { agent.background = true; this.reportAgent(id, 'item/started'); }
          continue;
        }
        this.finishAgent(id, b.is_error === true ? 'failed' : 'completed', result);
      }
      return;
    }

    if (type === 'stream_event') {
      this.ensureTurn();
      const evt = object(message.event);
      const evtType = text(evt.type);
      if (evtType === 'content_block_delta') {
        const deltaObj = object(evt.delta);
        if (text(deltaObj.type) === 'text_delta' && text(deltaObj.text)) {
          const delta = text(deltaObj.text);
          this.currentAssistantText += delta;
          this.emit({
            method: 'item/agentMessage/delta',
            params: { itemId: this.currentItemId || 'answer', delta },
          });
        }
      } else if (evtType === 'content_block_start') {
        const block = object(evt.content_block);
        if (text(block.type) === 'tool_use') {
          const toolName = text(block.name);
          const id = text(block.id) || `tool-${++this.nextId}`;
          if (CLAUDE_AGENT_TOOLS.has(toolName)) {
            this.agents.set(id, { taskId: '', description: '', prompt: '', subagentType: '', background: false, done: false, output: '' });
            this.reportAgent(id, 'item/started');
            return;
          }
          const item = { id, type: toolName === 'Bash' ? 'commandExecution' : CLAUDE_EDIT_TOOLS.has(toolName) ? 'fileChange' : 'mcpToolCall', tool: toolName, command: toolName };
          this.openTools.set(id, item);
          this.emit({ method: 'item/started', params: { item: { ...item, status: 'inProgress' } } });
        }
      }
      return;
    }

    if (type === 'assistant') {
      this.ensureTurn();
      if (text(message.uuid) && !message.parent_tool_use_id) this.lastAssistantUuid = text(message.uuid);
      const msg = object(message.message);
      if (Array.isArray(msg.content)) {
        for (const rawBlock of msg.content) {
          const b = object(rawBlock);
          const agent = text(b.type) === 'tool_use' ? this.agents.get(text(b.id)) : undefined;
          if (agent && !agent.done) {
            const input = object(b.input);
            agent.description ||= text(input.description);
            agent.prompt ||= text(input.prompt);
            agent.subagentType ||= text(input.subagent_type);
            this.reportAgent(text(b.id), 'item/started');
          }
          // The full input arrives with the message: name the edited file so the activity log can open its diff.
          const editedFile = text(b.type) === 'tool_use' && CLAUDE_EDIT_TOOLS.has(text(b.name)) ? text(object(b.input).file_path) || text(object(b.input).notebook_path) : '';
          if (editedFile) {
            const item = { id: text(b.id), type: 'fileChange', tool: text(b.name), command: text(b.name), changes: [{ path: editedFile }] };
            if (this.openTools.has(item.id)) this.openTools.set(item.id, item);
            this.emit({ method: 'item/started', params: { item: { ...item, status: 'inProgress' } } });
          }
          if (text(b.type) === 'tool_use' && text(b.name) === 'AskUserQuestion') {
            const toolId = text(b.id);
            if (!toolId || !this.handledQuestionToolIds.has(toolId)) {
              const qs = Array.isArray(object(b.input).questions) ? (object(b.input).questions as unknown[]) : [];
              if (qs.length > 0) this.pendingAssistantQuestions = qs;
            }
          }
        }
        const fullText = msg.content
          .filter((b) => text(object(b).type) === 'text')
          .map((b) => text(object(b).text))
          .join('');
        if (fullText && !this.currentAssistantText) {
          this.currentAssistantText = fullText;
          this.emit({
            method: 'item/agentMessage/delta',
            params: { itemId: this.currentItemId || 'answer', delta: fullText },
          });
        }
      }
      return;
    }

    if (type === 'result') {
      // A result outside any turn ends a turn Claude started without streaming; one with nothing to show is ignored.
      if (!this.busy) {
        if (!text(message.result)) return;
        this.ensureTurn();
      }
      const finalText = text(message.result) || this.currentAssistantText;
      const pendingQuestions = this.pendingAssistantQuestions;
      this.pendingAssistantQuestions = null;
      if (finalText || (pendingQuestions && pendingQuestions.length > 0)) {
        const itemId = this.currentItemId || 'answer';
        if (finalText) this.checkGoalCompletionInText(finalText);
        this.emit({
          method: 'item/completed',
          params: {
            item: {
              id: itemId,
              type: 'agentMessage',
              text: finalText,
              ...(pendingQuestions && pendingQuestions.length > 0
                ? { questions: pendingQuestions, delivery: 'async' }
                : {}),
            },
          },
        });
      }
      const isInterrupted = text(message.subtype) === 'interrupted' || text(message.terminal_reason) === 'aborted_streaming';
      const isError = message.is_error === true && !isInterrupted;
      const usageLimit = isError ? this.usageLimits.limitFor(message) : null;
      this.pauseRunningProgressOnTurnEnd(isError);
      const finishedTurnId = this.turnId || 'turn';
      this.busy = false;
      this.turnId = null;
      this.clearTurnRequests();
      void this.refreshContextUsage();
      this.emit({
        method: 'turn/completed',
        params: {
          turn: {
            id: finishedTurnId,
            status: isInterrupted ? 'interrupted' : isError ? 'failed' : 'completed',
            ...(this.lastAssistantUuid ? { ayaHead: this.lastAssistantUuid } : {}),
            ...(usageLimit
              ? { error: { message: claudeLimitMessage(usageLimit, text(message.result)), usageLimit } }
              : isError && text(message.error)
              ? { error: { message: text(message.error) } }
              : {}),
          },
        },
      });
      return;
    }

    if (text(message.method).startsWith('fixture/')) {
      this.emit({ method: text(message.method), params: object(message.params) });
    }
  }
}

export class AntigravityGuiSession extends BaseManagedGuiSession {
  private initWaiter: {
    resolve: (value: { threadId: string; model: string }) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private nextId = 0;
  private turnId: string | null = null;
  private currentItemId = '';
  private currentAssistantText = '';
  private configDir?: string;
  private currentModel = '';
  private currentEffort = '';
  private executedStepTools = new Set<number>();
  private pendingAssistantQuestions: unknown[] | null = null;

  constructor(
    emit: (event: GuiEvent) => void,
    private readonly executable = 'agy',
    private readonly customArgs?: string[],
  ) {
    super(emit, 'Antigravity');
  }

  private write(value: unknown) {
    if (!this.child || this.child.stdin.destroyed) throw Error('Antigravity is disconnected');
    if (!this.writer) throw Error(`${this.agentLabel} is disconnected`); this.writer.write(value);
  }

  protected failSession(message: string) {
    this.writer?.close(); this.writer = null;
    if (this.initWaiter) {
      clearTimeout(this.initWaiter.timer);
      this.initWaiter.reject(Error(message));
      this.initWaiter = null;
    }
    this.requests.clear();
    this.busy = false;
    this.turnId = null;
    if (!this.closing) this.emit({ method: 'aya/disconnected', params: { message } });
  }

  async connect(cwd: string, model: string, configDir?: string, resumeThreadId?: string, unsafeMode = false) {
    if (this.child) throw Error('Start a new window for a separate session');
    this.cwd = await realpath(cwd);
    if (!(await stat(this.cwd)).isDirectory()) throw Error('Workspace must be a directory');
    this.configDir = configDir;
    this.currentModel = model;
    this.threadId = resumeThreadId || randomUUID();
    const args = [...(this.customArgs ?? [
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      ...(model ? ['--model', model] : []),
      ...(this.currentEffort ? ['--effort', this.currentEffort] : []),
      ...(resumeThreadId ? ['--conversation', resumeThreadId] : []),
    ]), ...(unsafeMode ? ['--dangerously-skip-permissions'] : [])];
    const env = this.cleanEnv(configDir ? { ANTIGRAVITY_GEMINI_DIR: configDir } : {});
    this.child = spawn(this.executable, args, {
      cwd: this.cwd,
      env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdin.on('error', () => {});
    this.writer = new GuiProtocolWriter(this.child.stdin, this.agentLabel, message => { this.failSession(message); this.close(); });
    this.child.stderr.on('data', (data) => {
      this.stderr = (this.stderr + String(data)).slice(-4000);
    });
    this.child.stdout.setEncoding('utf8');
    const frames = new GuiJsonLines(undefined, skipMalformedLine(this.agentLabel));
    this.child.stdout.on('data', data => {
      try {
        frames.push(String(data), message => {
          void this.receive(message).catch(error => { this.failSession(String(error)); this.close(); });
        });
      } catch (error) {
        this.failSession(`Antigravity: ${error instanceof Error ? error.message : String(error)}`);
        this.close();
      }
    });
    this.child.once('error', (error) =>
      this.failSession(`Cannot start Antigravity: ${error.message}`),
    );
    this.child.once('exit', (code) =>
      this.failSession(`Antigravity stopped (${code ?? 'signal'}). ${this.stderr}`),
    );

    return new Promise<{ threadId: string; model: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.initWaiter) {
          this.initWaiter = null;
          resolve({
            threadId: this.threadId,
            model: this.currentModel || 'Antigravity default',
          });
        }
      }, 300);
      timer.unref();
      this.initWaiter = { resolve, reject, timer };
    });
  }

  async models() {
    try {
      const args = this.customArgs
        ? [...this.customArgs, '--output-format', 'json', 'models']
        : ['--output-format', 'json', 'models'];
      const { stdout } = await execFileAsync(this.executable, args, {
        cwd: this.cwd || process.cwd(),
        env: this.cleanEnv(this.configDir ? { ANTIGRAVITY_GEMINI_DIR: this.configDir } : {}),
        timeout: 10000,
      });
      const parsed = object(JSON.parse(stdout.trim().split('\n').pop() || '{}'));
      const cmdData = object(object(parsed.command).data);
      const rawModels = Array.isArray(cmdData.models)
        ? (cmdData.models as unknown[])
        : Array.isArray(parsed.data)
          ? (parsed.data as unknown[])
          : [];
      if (rawModels.length > 0) {
        return {
          data: rawModels.map((item) => {
            const m = object(item);
            const id = text(m.id) || text(m.model);
            return {
              id,
              model: id,
              displayName: text(m.label) || text(m.displayName) || id,
              supportedReasoningEfforts: [
                { reasoningEffort: 'low' },
                { reasoningEffort: 'medium' },
                { reasoningEffort: 'high' },
                { reasoningEffort: 'max' },
              ],
              defaultReasoningEffort: 'high',
            };
          }),
        };
      }
    } catch {
      /* fallback to default Antigravity models */
    }
    return {
      data: [
        {
          id: 'gemini-3.1-pro-high',
          model: 'gemini-3.1-pro-high',
          displayName: 'Gemini 3.1 Pro (High)',
          supportedReasoningEfforts: [
            { reasoningEffort: 'low' },
            { reasoningEffort: 'medium' },
            { reasoningEffort: 'high' },
            { reasoningEffort: 'max' },
          ],
          defaultReasoningEffort: 'high',
        },
        {
          id: 'claude-sonnet-4-6',
          model: 'claude-sonnet-4-6',
          displayName: 'Claude Sonnet 4.6',
          supportedReasoningEfforts: [
            { reasoningEffort: 'low' },
            { reasoningEffort: 'medium' },
            { reasoningEffort: 'high' },
          ],
          defaultReasoningEffort: 'high',
        },
      ],
    };
  }

  async command(name: string, argument: string): Promise<Record<string, unknown>> {
    if (!this.threadId) throw Error('Connect to Antigravity first');
    if (name === 'goal') return this.handleGoalCommand(argument);
    if (name === 'compact') {
      await this.send(`/compact ${argument}`.trim());
      return {};
    }
    if (name === 'btw') throw Error('Antigravity does not support side questions through its headless protocol. Send a regular message instead.');
    throw Error(
      `Unsupported command /${name}. Use /help to see the commands available in GUI mode.`,
    );
  }

  async steer(_prompt: string): Promise<Record<string, unknown>> {
    throw Error('Antigravity does not support steering through its headless protocol. Queue a message for the next turn instead.');
  }

  async send(
    prompt: string,
    options: { model?: string; effort?: string; images?: string[] } = {},
  ) {
    if (!this.threadId) throw Error('Connect to Antigravity first');
    if (this.busy) throw Error('Antigravity is working; stop the current turn first');
    if (!prompt.trim() || prompt.length > 100000) {
      throw Error('Prompt must contain 1–100000 characters');
    }
    this.busy = true;
    this.turnId = `turn-${++this.nextId}`;
    this.currentItemId = `msg-${this.nextId}`;
    this.currentAssistantText = '';
    this.executedStepTools.clear();
    this.pendingAssistantQuestions = null;
    if (options.model) this.currentModel = options.model;
    if (options.effort) this.currentEffort = options.effort;
    try {
      this.emit({ method: 'turn/started', params: { turn: { id: this.turnId } } });
      this.write({
        event: 'user',
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
        ...(options.images?.length ? { images: options.images } : {}),
        message: {
          role: 'user',
          content: prompt,
        },
      });
    } catch (error) {
      this.busy = false;
      this.turnId = null;
      throw error;
    }
  }

  async interrupt() {
    if (this.busy) {
      const pid = this.child?.pid;
      if (!pid) throw Error('Antigravity is disconnected');
      try {
        process.kill(-pid, 'SIGINT');
      } catch {
        try {
          this.child?.kill('SIGINT');
        } catch {
          // Process already exited.
        }
      }
    }
  }

  private async receive(raw: unknown) {
    const message = object(raw);
    const evtName = text(message.event);

    if (evtName === 'init') {
      const convId = text(message.conversation_id) || this.threadId;
      this.threadId = convId;
      const initObj = object(message.init);
      const initModel = text(initObj.model) || this.currentModel || 'Antigravity default';
      this.currentModel = initModel;
      this.emit({ method: 'aya/session', params: { threadId: this.threadId, model: initModel } });
      if (this.initWaiter) {
        clearTimeout(this.initWaiter.timer);
        const waiter = this.initWaiter;
        this.initWaiter = null;
        waiter.resolve({ threadId: this.threadId, model: initModel });
      }
      return;
    }

    if (evtName === 'step_update') {
      const step = object(message.step_update);
      const stepIndex = typeof step.step_index === 'number' ? step.step_index : ++this.nextId;
      const state = text(step.state);
      const stepType = text(step.step_type);

      if (stepType === 'agent_response') {
        const delta = text(step.text_delta);
        if (delta) {
          this.currentAssistantText += delta;
          this.emit({
            method: 'item/agentMessage/delta',
            params: { itemId: this.currentItemId || 'answer', delta },
          });
        }
        return;
      }

      if (stepType === 'tool') {
        const toolInfo = object(step.tool_info);
        const toolName = text(step.tool_name) || text(toolInfo.name);
        const params = object(toolInfo.parameters);

        const normalized = toolName.replace(/^mcp__aya__/, '').replace(/^mcp_aya_/, '');
        if (
          ['aya_present', 'aya_open_artifact', 'aya_progress'].includes(normalized) &&
          !this.executedStepTools.has(stepIndex)
        ) {
          this.executedStepTools.add(stepIndex);
          const outcome = await this.executeAyaTool(normalized, params);
          try {
            this.write({
              event: 'tool_result',
              step_index: stepIndex,
              tool_name: normalized,
              success: outcome.success,
              text: outcome.text,
            });
          } catch {
            /* real agy ignores unknown stream events or handles MCP natively */
          }
          return;
        }

        if (toolName === 'ask_question' && state === 'ACTIVE') {
          const reqId = `agy-q-${stepIndex}`;
          const rawQuestions = Array.isArray(params.questions) ? params.questions : [];
          const questions = rawQuestions.map((q, idx) => {
            const qObj = object(q);
            return {
              ...qObj,
              id: text(qObj.id) || (rawQuestions.length === 1 ? 'choice' : `q_${idx}`),
              question: text(qObj.question) || text(qObj.title) || 'Question',
              multiSelect: Boolean(qObj.is_multi_select ?? qObj.multiSelect),
              options: Array.isArray(qObj.options) ? qObj.options : [],
            };
          });
          this.pendingAssistantQuestions = questions;
          this.requests.set(reqId, {
            method: 'item/tool/requestUserInput',
            params: { questions },
            resolve: (val) => {
              this.pendingAssistantQuestions = null;
              const firstKey = text(object(questions[0]).id) || 'choice';
              const answer = text(val.answers?.[firstKey]);
              try {
                this.write({
                  event: 'question_response',
                  step_index: stepIndex,
                  answers: val.answers || {},
                  answer,
                });
              } catch {
                /* ignore */
              }
            },
          });
          this.emit({ method: 'item/tool/requestUserInput', params: { questions }, id: reqId });
          return;
        }

        const itemId = `step-${stepIndex}`;
        const itemType =
          toolName === 'run_command'
            ? 'commandExecution'
            : toolName === 'write_to_file' || toolName === 'replace_file_content'
              ? 'fileChange'
              : 'mcpToolCall';
        const commandLabel =
          text(params.CommandLine) ||
          text(params.TargetFile) ||
          text(params.Path) ||
          toolName;
        this.emit({
          method: state === 'ACTIVE' ? 'item/started' : 'item/completed',
          params: {
            item: {
              id: itemId,
              type: itemType,
              tool: toolName,
              command: commandLabel,
              status: state === 'ACTIVE' ? 'inProgress' : state === 'ERROR' ? 'failed' : 'completed',
            },
          },
        });
        return;
      }
      return;
    }

    if (evtName === 'result') {
      const res = object(message.result);
      const denied = Array.isArray(res.denied_actions) ? res.denied_actions : [];
      const deniedText = denied.map(action => text(object(action).display_name) || text(object(action).action)).filter(Boolean).join(', ');
      const permissionError = denied.length ? `Antigravity denied ${deniedText || 'a tool action'}. Its headless protocol cannot prompt for permission. Configure an allow rule in Antigravity, or enable skip permissions in this preset and reconnect.` : '';

      const finalText = text(res.response) || this.currentAssistantText;
      const pendingQuestions = this.pendingAssistantQuestions;
      this.pendingAssistantQuestions = null;
      if (finalText || (pendingQuestions && pendingQuestions.length > 0)) {
        const itemId = this.currentItemId || 'answer';
        if (finalText) this.checkGoalCompletionInText(finalText);
        this.emit({
          method: 'item/completed',
          params: {
            item: {
              id: itemId,
              type: 'agentMessage',
              text: finalText,
              ...(pendingQuestions && pendingQuestions.length > 0
                ? { questions: pendingQuestions, delivery: 'async' }
                : {}),
            },
          },
        });
      }
      const isInterrupted = text(res.finished_reason) === 'interrupted' || text(res.status) === 'INTERRUPTED';
      const isError = (text(res.status) === 'ERROR' || denied.length > 0) && !isInterrupted;
      this.pauseRunningProgressOnTurnEnd(isError);
      const finishedTurnId = this.turnId || 'turn';
      this.busy = false;
      this.turnId = null;
      this.requests.clear();
      this.emit({
        method: 'turn/completed',
        params: {
          turn: {
            id: finishedTurnId,
            status: isInterrupted ? 'interrupted' : isError ? 'failed' : 'completed',
            ...(isError && (permissionError || text(res.error)) ? { error: { message: permissionError || text(res.error) } } : {}),
          },
        },
      });
      return;
    }

    if (text(message.method).startsWith('fixture/')) {
      this.emit({ method: text(message.method), params: object(message.params) });
    }
  }
}

export { workspaceImage, presentArtifact };
