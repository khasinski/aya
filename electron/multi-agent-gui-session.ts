import { GuiProtocolWriter } from './gui-protocol-writer';
import { GuiJsonLines } from './gui-json-lines';
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { realpath, stat, readFile, mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { AYA_HOME } from './paths';
import { PROGRESS_TOOL, progressUpdate } from './gui-progress';
import { PRESENT_TOOL, OPEN_ARTIFACT_TOOL, presentArtifact, workspaceImage } from './gui-artifact-tools';
import type { CodexGuiSession } from './codex-gui-session';
import type { GuiProgress } from '../shared/gui-progress';
import type { GuiArtifact, GuiEvent } from '../shared/codex-gui';

const execFileAsync = promisify(execFile);
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const text = (value: unknown) => (typeof value === 'string' ? value : '');

export type GuiAgentKind = 'codex' | 'pi' | 'claude' | 'antigravity';

export type GuiSessionInstance = Pick<
  CodexGuiSession,
  | 'cwd'
  | 'running'
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
> & Partial<Pick<CodexGuiSession, 'listConversations' | 'readConversation'>>;

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
  return `You are displayed inside Aya GUI, a local graphical frontend for ${agentName}. Respond in the user’s language. You own the normal ${agentName} tool loop, context and sandbox. Use Markdown freely. For useful tables, metrics and local images, use aya_present to create artifacts. Set open=true when you want to show a newly created artifact immediately; use aya_open_artifact with its returned artifactId to reopen an existing one. Use HTML widgets for interactive visuals, forms, charts and mockups; use local PNG/JPEG/WebP/SVG files for graphics. Widgets are self-contained and cannot access the network or files. Widget row clicks arrive as user follow-ups. For measurable tasks use aya_progress with a label, actual completed units, total units and optional stage detail. Reuse its returned progressId for updates instead of creating new bars. Do not invent progress for tasks without measurable units. Do not start subagents unless the user requests delegation.`;
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
      resolve?: (value: { decision?: 'accept' | 'decline'; answers?: Record<string, string> }) => void;
    }
  >();
  protected artifactIds = new Set<string>();
  protected artifactRevisions = new Map<string, number>();
  protected progresses = new Map<string, GuiProgress>();
  protected goalState: { objective: string; status: string } | null = null;
  protected threadId = '';
  protected busy = false;
  get running() { return this.busy; }
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
    value: { decision?: 'accept' | 'decline'; answers?: Record<string, string> },
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
  ): Promise<{ threadId: string; model: string }>;
  abstract command(name: string, argument: string): Promise<Record<string, unknown>>;
  abstract models(): Promise<Record<string, unknown>>;
  abstract steer(prompt: string): Promise<Record<string, unknown>>;
  abstract send(
    prompt: string,
    options?: { model?: string; effort?: string; images?: string[] },
  ): Promise<void>;
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
    const frames = new GuiJsonLines();
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
  ): Promise<Record<string, unknown>> {
    const requestId = `claude-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingControl.delete(requestId);
        reject(Error(`${subtype} response timed out; the agent may still be working`));
      }, 60000);
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
    this.busy = false;
    this.turnId = null;
    if (!this.closing) this.emit({ method: 'aya/disconnected', params: { message } });
  }

  async connect(cwd: string, model: string, configDir?: string, resumeThreadId?: string, unsafeMode = false) {
    if (this.child) throw Error('Start a new window for a separate session');
    this.cwd = await realpath(cwd);
    if (!(await stat(this.cwd)).isDirectory()) throw Error('Workspace must be a directory');
    this.threadId = resumeThreadId || randomUUID();
    const args = [...(this.customArgs ?? [
      '--output-format',
      'stream-json',
      '--verbose',
      '--input-format',
      'stream-json',
      '--include-partial-messages',
      '--permission-prompt-tool=stdio',
      ...(resumeThreadId ? ['--resume', resumeThreadId] : ['--session-id', this.threadId]),
    ]), ...(unsafeMode ? ['--dangerously-skip-permissions'] : [])];
    // Explicitly setting even ~/.claude changes Claude's macOS Keychain account.
    // Match the terminal preset: only override the environment for a custom directory.
    const claudeDir = configDir?.trim().replace(/^(?:~|\$HOME)(?=\/|$)/, homedir());
    const customDir = claudeDir && path.resolve(claudeDir) !== path.join(homedir(), '.claude');
    const env = this.cleanEnv(customDir ? { CLAUDE_CONFIG_DIR: claudeDir } : {});
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
    const frames = new GuiJsonLines();
    this.child.stdout.on('data', data => {
      try {
        frames.push(String(data), message => {
          void this.receive(message).catch(error => { this.failSession(String(error)); this.close(); });
        });
      } catch (error) {
        this.failSession(`Claude: ${error instanceof Error ? error.message : String(error)}`);
        this.close();
      }
    });
    this.child.once('error', (error) => this.failSession(`Cannot start Claude: ${error.message}`));
    this.child.once('exit', (code) =>
      this.failSession(`Claude stopped (${code ?? 'signal'}). ${this.stderr}`),
    );
    try {
      const initRes = await this.controlRequest('initialize', {
        sdkMcpServers: ['aya'],
        appendSystemPrompt: buildGuiDeveloperInstructions('Claude'),
      });
      const responseObj = object(initRes.response);
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
      const activeModel =
        text(responseObj.model) ||
        text(this.cachedModels[0]?.model) ||
        model ||
        'Claude default';
      return { threadId: this.threadId, model: activeModel };
    } catch (error) {
      this.close();
      throw error;
    }
  }

  async models() {
    return { data: this.cachedModels };
  }

  async command(name: string, argument: string): Promise<Record<string, unknown>> {
    if (!this.threadId) throw Error('Connect to Claude first');
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
      `Unsupported command /${name}. Use /goal, /btw or /compact. Other CLI commands remain available in Terminal mode.`,
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
    if (!prompt.trim() || prompt.length > 100000) {
      throw Error('Prompt must contain 1–100000 characters');
    }
    this.busy = true;
    this.turnId = `turn-${++this.nextId}`;
    this.currentItemId = `msg-${this.nextId}`;
    this.currentAssistantText = '';
    this.handledQuestionToolIds.clear();
    this.pendingAssistantQuestions = null;
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
      this.write({
        type: 'user',
        session_id: this.threadId,
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
        message: { role: 'user', content },
        parent_tool_use_id: null,
      });
    } catch (error) {
      this.busy = false;
      this.turnId = null;
      throw error;
    }
  }

  async interrupt() {
    if (this.busy) {
      await this.controlRequest('interrupt');
    }
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

    if (type === 'control_request') {
      const reqId = text(message.request_id) || randomUUID();
      const req = object(message.request);
      const subtype = text(req.subtype);

      if (subtype === 'mcp_message' && text(req.server_name) === 'aya') {
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
            params: { questions },
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
          this.emit({ method: 'item/tool/requestUserInput', params: { questions }, id: reqId });
          return;
        }
        const commandText =
          text(input.command) || text(input.file_path) || text(input.path) || toolName;
        this.requests.set(reqId, {
          method: 'item/commandExecution/requestApproval',
          params: { command: commandText, reason: text(req.decision_reason) || `Run ${toolName}` },
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
                    message: 'User declined in Aya GUI',
                    toolUseID: toolUseId,
                  },
                },
              });
            }
          },
        });
        this.emit({
          method: 'item/commandExecution/requestApproval',
          params: { command: commandText, reason: text(req.decision_reason) || `Run ${toolName}` },
          id: reqId,
        });
        return;
      }
      return;
    }

    if (type === 'system' && text(message.subtype) === 'init') {
      if (text(message.session_id)) this.threadId = text(message.session_id);
      this.emit({ method: 'aya/session', params: { threadId: this.threadId, ...(text(message.model) ? { model: text(message.model) } : {}) } });
      return;
    }

    if (type === 'stream_event') {
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
          this.emit({
            method: 'item/started',
            params: {
              item: {
                id,
                type: toolName === 'Bash' ? 'commandExecution' : 'mcpToolCall',
                tool: toolName,
                command: toolName,
                status: 'inProgress',
              },
            },
          });
        }
      }
      return;
    }

    if (type === 'assistant') {
      const msg = object(message.message);
      if (Array.isArray(msg.content)) {
        for (const rawBlock of msg.content) {
          const b = object(rawBlock);
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
            ...(isError && text(message.error)
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
    const frames = new GuiJsonLines();
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
