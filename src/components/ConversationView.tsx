import { guiRendererRecoveryInProgress } from '../gui-renderer-recovery';
import { conversationSaveDelay } from '../conversation-save-delay';
import { useModalFocus } from './useModalFocus';
import { appendMessageDeltas, createTextDeltaBuffer, scheduleConversationFrame } from '../conversation-deltas';
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type SetStateAction } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { guiSupportedAgent } from '../agentPreset';
import type { GuiProgress } from '../../shared/gui-progress';
import { followUpHint, parseFollowUpPreference, pasteBecomesAttachment, recallStep, sendAction, sendLabel, sentPromptText, stashStep, withQuote, type FollowUpPreference, type Recall } from '../gui-composer';
import { GUI_FOLLOW_UP_STORAGE_KEY, guiStashKey } from '../storage-keys';
import { activityDuration, activityKind, activityPhases, phaseText, shortDuration, type ActivityKind } from '../gui-activity';
import { findStatus, findTextMatches, stepMatch } from '../gui-find';
import { formatElapsed, guiPaneStatus, sameGuiPaneStatus, type GuiPaneStatus } from '../gui-status';
import type { GuiArtifact, GuiArtifactEntry, GuiEvent, GuiApprovalDecision } from '../../shared/codex-gui';
import type { Preset, TerminalState } from '../types';
import './conversation.css';
import { ConversationMarkdown } from './ConversationMarkdown';
import { ArtifactPanel } from './ArtifactPanel';
import { ipcMessage } from './use-async-action';
import { guiCommands, guiCapabilities } from '../../shared/gui-commands.cjs';
const obj = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const str = (value: unknown) => typeof value === 'string' ? value : '';
const goalText = (value: unknown) => { const goal = obj(value); return [str(goal.objective), str(goal.status)].filter(Boolean).join(' · '); };
interface Attachment { id: string; name: string; path: string; image: boolean }
interface QueuedMessage { id: string; text: string; attachments: Attachment[] }
interface ModelOption { id: string; model: string; displayName: string; supportedReasoningEfforts: { reasoningEffort: string }[]; defaultReasoningEffort: string }
interface Activity { id: string; label: string; status: string; output: string; kind?: ActivityKind; startedAt?: number; endedAt?: number }
interface GoalDetails { objective: string; status: string; reason?: string }
interface GuiQuestionOption { label: string; description: string }
interface GuiQuestion { id: string; header: string; question: string; isSecret: boolean; multiSelect: boolean; options: GuiQuestionOption[] }
interface Message { kind?: 'plan'; progress?: GuiProgress; id: string; type: string; text: string; delivery?: 'sending' | 'sent' | 'failed' | 'unconfirmed'; title?: string; goal?: GoalDetails | null; questions?: unknown[]; questionAnswers?: Record<string, string> }
function normalizeQuestions(raw: unknown): GuiQuestion[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item, index) => {
    const q = obj(item);
    const id = str(q.id) || (raw.length === 1 ? 'choice' : str(q.header) || `q_${index}`);
    const header = str(q.header);
    const question = str(q.question) || str(q.title) || str(q.prompt) || 'Question';
    const isSecret = Boolean(q.isSecret);
    const multiSelect = Boolean(q.multiSelect ?? q.is_multi_select);
    const rawOptions = Array.isArray(q.options) ? q.options : [];
    const options: GuiQuestionOption[] = rawOptions
      .map(opt => typeof opt === 'string'
        ? { label: opt.trim(), description: '' }
        : { label: (str(obj(opt).label) || str(obj(opt).value) || str(obj(opt).title)).trim(), description: str(obj(opt).description).trim() })
      .filter(o => o.label.length > 0);
    return { id, header, question, isSecret, multiSelect, options };
  });
}
function parseCallMessageQuestions(id: string, textValue: string): GuiQuestion[] {
  if (!id.startsWith('call_') || !textValue.includes('\n- ')) return [];
  const blocks = textValue.trim().split(/\n{2,}/);
  const parsed: { title: string; options: string[] }[] = [];
  for (const block of blocks) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    const firstBullet = lines.findIndex(l => l.startsWith('- '));
    if (firstBullet <= 0) return [];
    const title = lines.slice(0, firstBullet).join('\n').trim();
    const bulletLines = lines.slice(firstBullet);
    if (!title || !bulletLines.every(l => l.startsWith('- '))) return [];
    const options = bulletLines.map(l => l.slice(2).trim()).filter(Boolean);
    if (!options.length) return [];
    parsed.push({ title, options });
  }
  return normalizeQuestions(parsed);
}
function extractMessageQuestions(m: Message): GuiQuestion[] {
  if (Array.isArray(m.questions) && m.questions.length > 0) return normalizeQuestions(m.questions);
  if (m.type === 'assistant') return parseCallMessageQuestions(m.id, m.text);
  return [];
}
function stripQuestionBulletsFromText(textValue: string, questions: GuiQuestion[]): string {
  if (!questions.length) return textValue;
  let result = textValue;
  for (const q of questions) {
    const block = [q.question, ...q.options.map(o => `- ${o.label}`)].join('\n');
    if (block && result.includes(block)) result = result.replace(block, '');
  }
  return result.trim();
}
type ConversationProps = {
  terminal: TerminalState;
  preset: Preset;
  paneStyle?: CSSProperties;
  hidden?: boolean;
  isActivePane?: boolean;
  onActivatePane?: () => void;
  /** Tells the rest of Aya (status rail, attention centre, sidebar) what this pane is doing. */
  onReportStatus?: (terminalId: string, status: GuiPaneStatus) => void;
  /** Cmd+F opened the find bar for this pane. */
  findOpen?: boolean;
  onCloseFind?: () => void;
};
export const ConversationView = memo(function ConversationView(props: ConversationProps) {
  const [generation, setGeneration] = useState(0);
  return <ConversationSession key={`${props.terminal.id}:${generation}`} {...props} onSwitch={() => setGeneration(n => n + 1)} />;
});
function ConversationSession({ terminal, preset, paneStyle, hidden = false, isActivePane = false, onActivatePane, onReportStatus, findOpen = false, onCloseFind, onSwitch }: ConversationProps & { onSwitch: () => void }) {
  const api = window.ayaGui;
  const guiAgent = guiSupportedAgent(preset) ?? 'codex';
  const agentLabel = guiAgent === 'pi' ? 'Pi' : guiAgent === 'claude' ? 'Claude' : guiAgent === 'antigravity' ? 'Antigravity' : 'Codex';
  const agentBadge = guiAgent === 'pi' ? 'PI' : guiAgent === 'claude' ? 'CLAUDE' : guiAgent === 'antigravity' ? 'ANTIGRAVITY' : 'CODEX';
  const invoke = (action: string, value?: unknown) => { if (!api) return Promise.reject(Error('Conversation GUI is available in the desktop app only.')); return api.invoke(terminal.id, action, value); };
  const [messages, setMessages] = useState<Message[]>([]);
  const [artifacts, setArtifacts] = useState<GuiArtifactEntry[]>([]);
  const [seenArtifactRevisions, setSeenArtifactRevisions] = useState<Record<string, number>>({});
  const markArtifactViewed = useCallback((id: string, revision: number) => setSeenArtifactRevisions(old => (old[id] || 0) >= revision ? old : { ...old, [id]: revision }), []);
  const unreadArtifactCount = artifacts.filter(a => (seenArtifactRevisions[a.id] || 0) < (a.revision || 1)).length;
  const [artifactHistory, setArtifactHistory] = useState<Record<string, GuiArtifactEntry[]>>({});
  const [suggestion, setSuggestion] = useState('');
  const draftRevision = useRef(0);
  const [attachments, setAttachmentValues] = useState<Attachment[]>([]);
  const setAttachments = useCallback((value: SetStateAction<Attachment[]>) => { draftRevision.current++; setAttachmentValues(value); }, []);
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  const [followUp, setFollowUpValue] = useState<FollowUpPreference>(() => { try { return parseFollowUpPreference(localStorage.getItem(GUI_FOLLOW_UP_STORAGE_KEY)); } catch { return 'queue'; } });
  const setFollowUp = (value: FollowUpPreference) => { setFollowUpValue(value); try { localStorage.setItem(GUI_FOLLOW_UP_STORAGE_KEY, value); } catch { /* the choice lasts until reload */ } };
  const [queueHeld, setQueueHeld] = useState(false);
  const [sideQuestion, setSideQuestion] = useState('');
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [effort, setEffort] = useState('');
  const [activities, setActivities] = useState<Activity[]>([]);
  const [plan, setPlan] = useState<{ step: string; status: string }[]>([]);
  const [showJump, setShowJump] = useState(false);
  const follow = useRef(true);
  const scrollViewport = useRef<HTMLDivElement>(null);
  const scrollContent = useRef<HTMLDivElement>(null);
  const dispatching = useRef(false);
  const pendingSnapshot = useRef<Record<string, unknown> | null>(null);
  const lastSnapshotSave = useRef(Date.now());
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushTextDeltas = useRef<() => void>(() => {});
  const eventSequence = useRef(0);
  const receivedEventSequence = useRef(0);
  const composer = useRef<HTMLTextAreaElement>(null);
  const recall = useRef<Recall | null>(null);
  const [planMode, setPlanModeValue] = useState(false);
  const planRef = useRef(false);   // read by dispatch in the same tick that /plan or Implement changes it
  const setPlanMode = (value: boolean | ((old: boolean) => boolean)) => { const next = typeof value === 'function' ? value(planRef.current) : value; planRef.current = next; setPlanModeValue(next); };
  const planWasOn = useRef(false);   // leaving plan mode must be said to Codex once
  const [findQuery, setFindQuery] = useState('');
  const [findIndex, setFindIndex] = useState(-1);
  const [findCount, setFindCount] = useState(0);
  const findInput = useRef<HTMLInputElement>(null);
  const findRanges = useRef<Range[]>([]);
  const messagesRoot = useRef<HTMLDivElement | null>(null);
  const [turnElapsed, setTurnElapsed] = useState<number | null>(null);
  const [lastTurnMs, setLastTurnMs] = useState<number | null>(null);
  const turnStartedAt = useRef<number | null>(null);
  const [stash, setStashValue] = useState<string[]>(() => { try { const saved: unknown = JSON.parse(localStorage.getItem(guiStashKey(terminal.id)) || '[]'); return Array.isArray(saved) ? saved.filter((v): v is string => typeof v === 'string').slice(-20) : []; } catch { return []; } });
  const setStash = (next: string[]) => { setStashValue(next); try { if (next.length) localStorage.setItem(guiStashKey(terminal.id), JSON.stringify(next)); else localStorage.removeItem(guiStashKey(terminal.id)); } catch { /* kept until reload */ } };
  const [quote, setQuote] = useState<{ text: string; left: number; top: number } | null>(null);
  const artifactButton = useRef<HTMLButtonElement>(null);
  const [drawer, setDrawer] = useState(false);
  const [selected, setSelected] = useState('');
  const [prompt, setPromptValue] = useState('');
  const setPrompt = useCallback((value: SetStateAction<string>) => { draftRevision.current++; setPromptValue(value); }, []);
  const [busy, setBusy] = useState(false);
  const [turnOutcome, setTurnOutcome] = useState<'complete' | 'interrupted' | 'failed' | null>(null);
  const [ready, setReady] = useState(false);
  const [restored, setRestored] = useState(false);
  const [connecting, setConnecting] = useState(true);
  const [saveStatus, setSaveStatus] = useState<'loading' | 'saving' | 'saved' | 'error'>('loading');
  const [saveError, setSaveError] = useState('');
  const snapshotRevision = useRef(0);
  const saveAttempt = useRef(0);
  const viewMounted = useRef(true);
  const [error, setError] = useState('');
  const [model, setModel] = useState('Connecting…');
  const [requests, setRequests] = useState<GuiEvent[]>([]);
  const [goal, setGoal] = useState('');
  const [goalDetails, setGoalDetails] = useState<GoalDetails | null>(null);
  const [goalPending, setGoalPending] = useState(false);
  const [side, setSide] = useState('');
  const [importNotice, setImportNotice] = useState('');
  const [history, setHistory] = useState<{ id: string; title: string; updatedAt: number; current: boolean }[] | null>(null);
  const [historyQuery, setHistoryQuery] = useState('');
  const [historyLoading, setHistoryLoading] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const historyRequest = useRef(0);
  const invalidateHistoryRequest = useCallback(() => { historyRequest.current++; }, []);
  const historyStartView = useRef<Record<string, unknown> | null>(null);
  const historyOpen = history !== null;
  const historyDialog = useRef<HTMLDivElement>(null);
  useModalFocus(historyDialog, () => setHistory(null), { enabled: historyOpen });
  const loadHistory = useCallback(async (query: string, offset: number) => {
    if (!api) return;
    const request = ++historyRequest.current;
    const view = historyStartView.current;
    historyStartView.current = null;
    setHistoryLoading(true);
    if (!offset) setHistory([]);
    try {
      const page = await api.invoke(terminal.id, 'history', { historyPage: true, query, offset, ...(view ? { view } : {}) }) as { rows: NonNullable<typeof history>; hasMore: boolean };
      if (request !== historyRequest.current) return;
      setHistory(old => offset ? [...old || [], ...page.rows.filter(row => !old?.some(existing => existing.id === row.id))] : page.rows);
      setHistoryHasMore(page.hasMore);
    } catch (error) { if (request === historyRequest.current) setError(ipcMessage(error)); }
    finally { if (request === historyRequest.current) setHistoryLoading(false); }
  }, [api, terminal.id]);
  const openHistory = async (query = '') => {
    historyStartView.current = pendingSnapshot.current;
    setHistoryQuery(query); setHistory([]); setHistoryHasMore(false); setHistoryLoading(true);
    if (historyOpen && query === historyQuery) await loadHistory(query, 0);
  };
  useEffect(() => {
    if (!historyOpen) return;
    const timer = setTimeout(() => { void loadHistory(historyQuery, 0); }, 150);
    return () => { clearTimeout(timer); invalidateHistoryRequest(); };
  }, [historyOpen, historyQuery, loadHistory, invalidateHistoryRequest]);
  const switchConversation = async (conversationId?: string) => {
    if (busy || requests.length || dispatching.current) throw Error('Stop the current turn and resolve approvals before switching conversations');
    setSwitching(true); setReady(false); setRestored(false);
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = null;
    try { await invoke('switch-conversation', { conversationId, view: pendingSnapshot.current }); pendingSnapshot.current = null; onSwitch(); }
    catch (error) { setSwitching(false); setReady(false); setRestored(true); throw error; }
  };
  const lastGoal = useRef<GoalDetails | null>(null);
  const turnExplanation = useRef('');
  const applyGoal = useCallback((value: unknown) => {
    const data = obj(value), objective = str(data.objective), status = str(data.status) || 'active';
    const previous = lastGoal.current;
    setGoal(objective ? goalText(data) : '');
    if (!objective) setGoalDetails(null);
    if (!objective) {
      if (previous) { lastGoal.current = null; setMessages(old => [...old, { id: crypto.randomUUID(), type: 'goal', title: 'Goal cleared', text: previous.objective, goal: null }]); }
      return;
    }
    const reason = status === 'blocked' ? str(data.reason).trim() || turnExplanation.current || (previous?.status === 'blocked' ? previous.reason : '') || '' : '';
    if (previous?.objective === objective && previous.status === status && (previous.reason || '') === reason) return;
    const next = { objective, status, ...(reason ? { reason } : {}) };
    if (previous?.objective === objective && previous.status === status) {
      lastGoal.current = next; setGoalDetails(next);
      setMessages(old => { const latest = [...old].reverse().find(m => m.type === 'goal'); return old.map(m => m === latest ? { ...m, goal: next } : m); });
      return;
    }
    lastGoal.current = next; setGoalDetails(next);
    const title = !previous || (previous.status === 'complete' && status === 'active') ? 'Goal set' : previous.objective !== objective ? 'Goal updated' : ({ active: 'Goal resumed', paused: 'Goal paused', blocked: 'Goal blocked', complete: 'Goal completed', usageLimited: 'Goal paused · usage limit', budgetLimited: 'Goal paused · token budget' } as Record<string, string>)[status] || `Goal ${status}`;
    setMessages(old => [...old, { id: crypto.randomUUID(), type: 'goal', title, text: objective, goal: next }]);
  }, []);
  const fail = (e: unknown) => setError(ipcMessage(e));
  const persistInFlight = useRef<Promise<void> | null>(null);
  const persistRequested = useRef(false);
  const persistLatest = useCallback(() => {
    persistRequested.current = true;
    if (persistInFlight.current) return persistInFlight.current;
    const write = Promise.resolve().then(async () => {
      while (persistRequested.current && viewMounted.current) {
        persistRequested.current = false;
        if (!api || !pendingSnapshot.current) return;
        const revision = snapshotRevision.current, attempt = ++saveAttempt.current;
        setSaveStatus('saving');
        lastSnapshotSave.current = Date.now();
        try {
          await api.invoke(terminal.id, 'persist', pendingSnapshot.current);
          if (viewMounted.current && attempt === saveAttempt.current && revision === snapshotRevision.current) { setSaveStatus('saved'); setSaveError(''); }
        } catch (e) {
          if (viewMounted.current && attempt === saveAttempt.current && revision === snapshotRevision.current) { setSaveStatus('error'); setSaveError(ipcMessage(e)); }
        }
      }
    }).finally(() => { persistInFlight.current = null; });
    persistInFlight.current = write;
    return write;
  }, [api, terminal.id]);
  const reconnect = async () => {
    if (connecting || ready || busy) return;
    setConnecting(true); setError(''); setQueueHeld(true);
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = null;
    const revision = snapshotRevision.current;
    try {
      const result = await invoke('reconnect', { view: pendingSnapshot.current, unsafeMode: preset.unsafeMode === true });
      setModel(str(obj(result).model)); setReady(true); setImportNotice(old => old === 'Interface recovered. Reconnect the agent to continue.' ? '' : old);
      if (revision === snapshotRevision.current) { setSaveStatus('saved'); setSaveError(''); }
      void invoke('models').then(result => { if (Array.isArray(obj(result).data)) setModels(obj(result).data as ModelOption[]); }).catch(fail);
      composer.current?.focus();
    } catch (e) { fail(e); }
    finally { setConnecting(false); }
  };
  const loadConversationImage = useCallback((path: string) => api ? api.invoke(terminal.id, 'image', path) : Promise.reject(Error('Desktop app required')), [api, terminal.id]);
  const searchArtifactContents = useCallback((query: string): Promise<string[]> => api ? api.invoke(terminal.id, 'artifact-search', query) as Promise<string[]> : Promise.reject(Error('Desktop app required')), [api, terminal.id]);
  const loadArtifactContent = useCallback((id: string, revision?: number): Promise<GuiArtifact> => api ? api.invoke(terminal.id, 'artifact-content', { id, revision }) as Promise<GuiArtifact> : Promise.reject(Error('Desktop app required')), [api, terminal.id]);
  const loadArtifactPreview = useCallback((id: string, revision?: number) => api ? api.invoke(terminal.id, 'artifact-preview', { id, revision }) : Promise.reject(Error('Desktop app required')), [api, terminal.id]);
  const availableCommands = guiCommands(guiAgent);
  const capabilities = guiCapabilities(guiAgent);

  useEffect(() => {
    if (!api) { setError('Conversation GUI requires the Aya desktop app.'); return; }
    let mounted = true; viewMounted.current = true;
    const textDeltas = createTextDeltaBuffer(deltas => {
      eventSequence.current = receivedEventSequence.current;
      const create = (delta: { id: string; text: string }): Message => ({ ...delta, type: 'assistant' });
      setMessages(old => appendMessageDeltas(old, deltas, create));
      // Teardown can run before React commits another frame. Include buffered
      // text in the final snapshot synchronously as well as in visible state.
      const snapshot = pendingSnapshot.current;
      if (snapshot && Array.isArray(snapshot.messages)) pendingSnapshot.current = { ...snapshot, eventSequence: eventSequence.current, messages: appendMessageDeltas(snapshot.messages as Message[], deltas, create) };
    }, scheduleConversationFrame);
    flushTextDeltas.current = textDeltas.flush;
    const off = api.onEvent(terminal.id, event => {
      if (event.method === 'aya/sessionEpoch') { textDeltas.flush(); eventSequence.current = 0; receivedEventSequence.current = 0; return; }
      if (event.method !== 'item/agentMessage/delta' && event.method !== 'item/plan/delta') textDeltas.flush();
      if (event.sequence) { receivedEventSequence.current = Math.max(receivedEventSequence.current, event.sequence); if (event.method !== 'item/agentMessage/delta' && event.method !== 'item/plan/delta') eventSequence.current = receivedEventSequence.current; }
      const p = event.params;
      if (event.method === 'aya/recovered') {
        setBusy(p.running === true); setTurnOutcome(old => p.running ? null : old || 'interrupted'); setRequests(old => p.running ? old : []);
        setImportNotice(p.connected === false ? 'Interface recovered. Reconnect the agent to continue.' : p.truncated ? 'Interface recovered. Some live output could not be retained while the window was unavailable. Saved messages are preserved.' : 'Interface recovered. Your agent connection was preserved.');
      }
      if (event.method === 'aya/session' && typeof p.model === 'string') setModel(p.model);
      if (event.method === 'aya/progress') {
        const progress = p.progress as unknown as GuiProgress;
        setMessages(old => old.some(m => m.progress?.id === progress.id) ? old.map(m => m.progress?.id === progress.id ? { ...m, progress } : m) : [...old, { id: `progress-${progress.id}`, type: 'progress', text: progress.label, progress }]);
      }
      if (event.method === 'aya/widgetSuggestion') setSuggestion(str(p.text));
      if (event.method === 'aya/artifact') { const artifact = p.artifact as unknown as GuiArtifact; setArtifacts(old => old.some(a => a.id === artifact.id) ? old.map(a => a.id === artifact.id ? artifact : a) : [...old, artifact]); setArtifactHistory(old => ({ ...old, [artifact.id]: [...(old[artifact.id] || []).slice(-9), artifact] })); setSelected(old => p.open === true ? artifact.id : old || artifact.id); if (p.open === true) setDrawer(true); }
      if (event.method === "aya/openArtifact") { setSelected(str(p.artifactId)); setDrawer(true); }
      if (event.id !== undefined) setRequests(old => [...old.filter(r => r.id !== event.id), event]);
      if (event.method === 'aya/requestResolved' || event.method === 'serverRequest/resolved') setRequests(old => old.filter(r => r.id !== (p.id ?? p.requestId)));
      if (event.method === 'turn/started') { turnExplanation.current = ''; setBusy(true); setTurnOutcome(null); }
      if (event.method === 'turn/completed') { setBusy(false); setRequests([]); const turn = obj(p.turn); setActivities(old => old.map(a => a.status === 'inProgress' ? { ...a, status: turn.status === 'completed' ? 'completed' : turn.status === 'failed' || turn.error ? 'failed' : 'interrupted' } : a)); if (turn.status !== 'completed') setQueueHeld(true); setTurnOutcome(turn.status === 'interrupted' ? 'interrupted' : turn.status === 'failed' || turn.error ? 'failed' : 'complete'); if (turn.error) fail(obj(turn.error).message); }
      if (event.method === 'aya/disconnected') { setReady(false); setBusy(false); setRequests([]); setQueueHeld(true); setSideQuestion(''); setTurnOutcome('interrupted'); setMessages(old => old.map(m => m.progress?.status === 'running' ? { ...m, progress: { ...m.progress, status: 'paused' } } : m)); setActivities(old => old.map(a => a.status === 'inProgress' ? { ...a, status: 'interrupted' } : a)); fail(p.message); }
      if (event.method === 'error' || event.method === 'aya/notice') fail(p.message || obj(p.error).message);
      if (event.method === 'turn/plan/updated' && Array.isArray(p.plan)) setPlan(p.plan as { step: string; status: string }[]);
      if (event.method === 'item/started' || event.method === 'item/completed') {
        const item = obj(p.item), type = str(item.type);
        if (type === 'agentMessage' && event.method === 'item/started' && Array.isArray(item.questions) && item.questions.length > 0) {
          const qs = item.questions as unknown[];
          setMessages(old => old.some(m => m.id === item.id) ? old.map(m => m.id === item.id ? { ...m, text: str(item.text) || m.text, questions: qs } : m) : [...old, { id: str(item.id), type: 'assistant', text: str(item.text), questions: qs }]);
        }
        if (!['agentMessage', 'userMessage', 'reasoning', 'plan'].includes(type)) {
          const label = type === 'commandExecution' ? str(item.command) || 'Running a command' : type === 'fileChange' ? 'Editing files' : type === 'dynamicToolCall' ? (item.tool === 'aya_open_artifact' ? 'Opening an artifact' : 'Preparing an artifact') : type === 'webSearch' ? 'Searching the web' : type === 'mcpToolCall' ? `Using ${str(item.tool) || 'a connected tool'}` : 'Using a tool';
          const finished = event.method === 'item/completed', now = Date.now();
          setActivities(old => old.some(a => a.id === item.id) ? old.map(a => a.id === item.id ? { ...a, label, status: finished ? str(item.status) || 'completed' : 'inProgress', output: str(item.aggregatedOutput).slice(-100000) || a.output, ...(finished && a.endedAt === undefined ? { endedAt: now } : {}) } : a) : [...old.slice(-49), { id: str(item.id), label, status: finished ? str(item.status) || 'completed' : 'inProgress', output: str(item.aggregatedOutput).slice(-100000), kind: activityKind(type), startedAt: now, ...(finished ? { endedAt: now } : {}) }]);
        }
      }
      if (event.method === 'item/commandExecution/outputDelta') setActivities(old => old.map(a => a.id === p.itemId ? { ...a, output: (a.output + str(p.delta)).slice(-100000) } : a));
      if (event.method === 'thread/goal/updated') applyGoal(p.goal ?? p);
      if (event.method === 'thread/goal/cleared') applyGoal(null);
      if (event.method === 'item/agentMessage/delta' || event.method === 'item/plan/delta') {
        const id = str(p.itemId);
        textDeltas.push(id, str(p.delta));
      }
      if (event.method === 'item/completed') {
        const item = obj(p.item);
        if (item.type === 'agentMessage' && str(item.text).trim()) {
          turnExplanation.current = str(item.text).trim();
          if (lastGoal.current?.status === 'blocked') applyGoal({ ...lastGoal.current, reason: turnExplanation.current });
        }
        if (item.type === 'agentMessage' || item.type === 'plan') {
          const qs = Array.isArray(item.questions) && item.questions.length > 0 ? (item.questions as unknown[]) : undefined;
          setMessages(old => old.some(m => m.id === item.id) ? old.map(m => m.id === item.id ? { ...m, text: str(item.text), ...(qs ? { questions: qs } : {}) } : m) : [...old, { id: str(item.id), type: 'assistant', text: str(item.text), ...(item.type === 'plan' ? { kind: 'plan' as const } : {}), ...(qs ? { questions: qs } : {}) }]);
        }
      }
    });
    void (async () => {
      const saved = obj(await api.invoke(terminal.id, 'load', { cwd: terminal.cwd, configDir: preset.configDir, agent: guiAgent }));
      if (!mounted) return;
      eventSequence.current = Number(saved.eventSequence || 0); receivedEventSequence.current = eventSequence.current;
      setImportNotice(str(saved.importNotice));
      if (Array.isArray(saved.messages)) { setMessages(saved.messages as Message[]); lastGoal.current = [...saved.messages as Message[]].reverse().find(m => m.type === 'goal')?.goal || null; }
      if (Array.isArray(saved.artifacts)) setArtifacts(saved.artifacts as GuiArtifactEntry[]);
      if (saved.seenArtifactRevisions && typeof saved.seenArtifactRevisions === 'object') setSeenArtifactRevisions(saved.seenArtifactRevisions as Record<string, number>);
      if (saved.artifactHistory) setArtifactHistory(saved.artifactHistory as Record<string, GuiArtifactEntry[]>);
      if (typeof saved.prompt === 'string') setPrompt(saved.prompt);
      if (typeof saved.selected === 'string') setSelected(saved.selected);
      if (typeof saved.drawer === 'boolean') setDrawer(saved.drawer);
      if (typeof saved.goal === 'string') {
        setGoal(saved.goal);
        const cut = saved.goal.lastIndexOf(' · ');
        if (saved.goal) { const details = saved.goalDetails as GoalDetails | undefined || { objective: cut >= 0 ? saved.goal.slice(0, cut) : saved.goal, status: cut >= 0 ? saved.goal.slice(cut + 3) : 'active' }; setGoalDetails(details); lastGoal.current = details; }
      }
      if (Array.isArray(saved.activities)) setActivities(saved.activities.slice(-50).map(value => { const activity = obj(value); return { id: str(activity.id), label: str(activity.label), status: activity.status === 'inProgress' && !saved.recoveryRunning ? 'interrupted' : str(activity.status), output: str(activity.output).slice(-100000), ...(typeof activity.kind === 'string' ? { kind: activity.kind as ActivityKind } : {}), ...(typeof activity.startedAt === 'number' ? { startedAt: activity.startedAt } : {}), ...(typeof activity.endedAt === 'number' ? { endedAt: activity.endedAt } : {}) }; }));
      if (Array.isArray(saved.queue)) { setQueue(saved.queue as QueuedMessage[]); setQueueHeld(saved.queue.length > 0); }
      if (Array.isArray(saved.attachments)) setAttachments(saved.attachments as Attachment[]);
      if (typeof saved.selectedModel === 'string') setSelectedModel(saved.selectedModel);
      if (typeof saved.effort === 'string') setEffort(saved.effort);
      if (Array.isArray(saved.plan)) setPlan(saved.plan as { step: string; status: string }[]);
      if (saved.busy) setTurnOutcome('interrupted');
      else if (saved.turnOutcome) setTurnOutcome(saved.turnOutcome as 'complete' | 'interrupted' | 'failed');
      setRestored(true);
      const result = await api.invoke(terminal.id, 'connect', { cwd: terminal.cwd, configDir: preset.configDir, agent: guiAgent, unsafeMode: preset.unsafeMode === true });
      if (mounted) { setReady(obj(result).connected !== false); setModel(str(obj(result).model)); setRestored(true); void api.invoke(terminal.id, 'models').then(result => { if (mounted && Array.isArray(obj(result).data)) setModels(obj(result).data as ModelOption[]); }).catch(() => {}); }
    })().catch(e => { if (mounted) fail(e); }).finally(() => { if (mounted) setConnecting(false); });
    return () => { textDeltas.flush(); mounted = false; viewMounted.current = false; off(); if (persistTimer.current) clearTimeout(persistTimer.current); persistTimer.current = null; void api.invoke(terminal.id, guiRendererRecoveryInProgress() ? 'retain-for-recovery' : 'close', pendingSnapshot.current || undefined).catch(() => {}); };
    // A conversation belongs to a panel; editing its preset affects new panels.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminal.id]);
  useLayoutEffect(() => {
    if (!restored || !api) return;
    pendingSnapshot.current = { eventSequence: eventSequence.current, importNotice, messages, activities, seenArtifactRevisions, prompt, selected, drawer, goal, goalDetails, busy, turnOutcome, queue, attachments, selectedModel, effort, plan };
    snapshotRevision.current++;
    setSaveStatus(old => old === 'error' ? old : 'saving');
    if (persistTimer.current) clearTimeout(persistTimer.current);
    const delay = conversationSaveDelay(busy, lastSnapshotSave.current);
    persistTimer.current = setTimeout(() => { persistTimer.current = null; void persistLatest(); }, delay);
  }, [restored, api, terminal.id, persistLatest, importNotice, messages, activities, artifacts, artifactHistory, seenArtifactRevisions, prompt, selected, drawer, goal, goalDetails, busy, turnOutcome, queue, attachments, selectedModel, effort, plan]);
  useEffect(() => {
    const flush = () => { flushTextDeltas.current(); if (persistTimer.current) clearTimeout(persistTimer.current); persistTimer.current = null; if (pendingSnapshot.current && api) void api.invoke(terminal.id, 'close', pendingSnapshot.current).catch(() => {}); };
    window.addEventListener('pagehide', flush);
    return () => { window.removeEventListener('pagehide', flush); if (persistTimer.current) clearTimeout(persistTimer.current); persistTimer.current = null; };
  }, [api, terminal.id]);
  const scrollToLatest = useCallback(() => {
    const viewport = scrollViewport.current;
    if (viewport && follow.current) {
      viewport.scrollTop = viewport.scrollHeight;
      setShowJump(false);
    }
  }, []);
  useEffect(() => {
    if (busy) {
      if (turnStartedAt.current === null) turnStartedAt.current = Date.now();
      setLastTurnMs(null);
      const tick = () => setTurnElapsed(Date.now() - (turnStartedAt.current ?? Date.now()));
      tick();
      const timer = setInterval(tick, 1000);
      return () => clearInterval(timer);
    }
    if (turnStartedAt.current !== null) { setLastTurnMs(Date.now() - turnStartedAt.current); turnStartedAt.current = null; }
    setTurnElapsed(null);
  }, [busy]);
  useEffect(() => { if (findOpen) { findInput.current?.focus(); findInput.current?.select(); } }, [findOpen]);
  useEffect(() => {
    if (!findOpen || !messagesRoot.current) { paintFind([], -1); findRanges.current = []; setFindCount(0); return; }
    const ranges = collectFindRanges(messagesRoot.current, findQuery);
    findRanges.current = ranges;
    setFindCount(ranges.length);
    const index = ranges.length === 0 ? -1 : Math.min(Math.max(findIndex, 0), ranges.length - 1);
    if (index !== findIndex) setFindIndex(index);
    paintFind(ranges, index);
    ranges[index]?.startContainer.parentElement?.scrollIntoView({ block: 'center' });
    return () => paintFind([], -1);
  }, [findOpen, findQuery, findIndex, messages, activities]);
  const reportedStatus = useRef<GuiPaneStatus | null>(null);
  const turnRanHere = useRef(false);   // a turn restored from disk is history, not news
  useEffect(() => {
    if (!onReportStatus) return;
    const asked = requests.map(request => {
      const questions = normalizeQuestions(request.params.questions);
      return questions.length > 0
        ? { kind: 'question' as const, text: questions[0].question }
        : { kind: 'approval' as const, text: str(request.params.command) || str(request.params.reason) };
    });
    const last = messages[messages.length - 1];
    const lastQuestions = last && last.type === 'assistant' && !busy ? extractMessageQuestions(last) : [];
    const unanswered = lastQuestions.length > 0 && !(last?.questionAnswers && Object.keys(last.questionAnswers).length > 0) ? lastQuestions[0].question : undefined;
    if (busy) turnRanHere.current = true;
    const computed = guiPaneStatus({ agentLabel, ready, busy, requests: asked, ...(unanswered ? { unansweredQuestion: unanswered } : {}), turnOutcome, queueHeld, queued: queue.length });
    const next: GuiPaneStatus = computed !== 'clear' && (computed.level === 'done' || computed.level === 'error') && !turnRanHere.current ? 'clear' : computed;
    if (sameGuiPaneStatus(next, reportedStatus.current)) return;
    reportedStatus.current = next;
    onReportStatus(terminal.id, next);
  }, [onReportStatus, terminal.id, agentLabel, ready, busy, requests, messages, turnOutcome, queueHeld, queue.length]);
  useLayoutEffect(() => { if (!hidden) scrollToLatest(); }, [hidden, messages, activities, side, requests, plan, scrollToLatest]);
  useEffect(() => {
    const observer = new ResizeObserver(scrollToLatest);
    if (scrollViewport.current) observer.observe(scrollViewport.current);
    if (scrollContent.current) observer.observe(scrollContent.current);
    return () => observer.disconnect();
  }, [scrollToLatest]);
  const modelName = (id: string) => models.find(item => item.model === id)?.displayName || id;
  const changeModel = (next: string) => {
    const previous = selectedModel || model;
    if (next === previous) return;
    setSelectedModel(next); setEffort('');
    const reset = effort ? ` Reasoning effort: ${effort} → Default.` : '';
    setMessages(old => [...old, { id: crypto.randomUUID(), type: 'settings', title: 'Model changed', text: `${modelName(previous)} → ${modelName(next)}.${reset} Applies to the next turn.` }]);
  };
  const changeEffort = (next: string) => {
    if (next === effort) return;
    setEffort(next);
    setMessages(old => [...old, { id: crypto.randomUUID(), type: 'settings', title: 'Reasoning effort changed', text: `${effort || 'Default'} → ${next || 'Default'}. Applies to the next turn.` }]);
  };
  const command = async (name: string, argument: string) => {
    if (name === 'resume') { await openHistory(argument); return; }
    if (name === 'new' || name === 'clear') { await switchConversation(); return; }
    if (name === 'model') {
      if (argument) { const option = models.find(item => item.model === argument || item.displayName.toLowerCase() === argument.toLowerCase()); if (!option) throw Error('Unknown model. Choose an available model below the composer.'); changeModel(option.model); }
      composer.current?.closest('section.aya-conversation')?.querySelector<HTMLSelectElement>('[aria-label="Model for next turn"]')?.focus(); return;
    }
    if (name === 'plan') {
      if (!capabilities.plan) throw Error(`${agentLabel} has no plan mode in GUI mode.`);
      const next = argument.trim() ? true : !planMode;
      setPlanMode(next);
      if (argument.trim()) { setPrompt(''); await send(argument.trim()); }
      return;
    }
    if (name === 'status') { setSide(`${agentLabel} · ${model}\n${busy ? 'Working' : ready ? 'Ready' : 'Disconnected'}\nWorkspace: ${terminal.cwd}\nGoal: ${goal || 'None'}\nQueued messages: ${queue.length}`); return; }
    if (name === 'help') { setSide('Available commands:\n\n' + availableCommands.map(item => `- /${item.name} — ${item.description}`).join('\n')); return; }
    if (!['goal', 'btw', 'compact', 'plan'].includes(name)) throw Error(`Unknown GUI command /${name}. Use /help.`);
    if (name === 'btw') {
      if (!capabilities.sideQuestions) throw Error(`${agentLabel} does not support side questions in GUI mode. Send a regular message instead.`);
      if (!argument.trim()) throw Error('Usage: /btw your side question');
      if (sideQuestion) throw Error('A side question is already pending. Close it to cancel before asking another.');
      setSideQuestion(argument);
      setSide(`${busy && !capabilities.sideWhileWorking ? 'Waiting for the current turn to finish…' : 'Answering…'}\n\n${argument}`);
      return;
    }
    if (name === 'goal') setGoalPending(true);
    try {
      const result = await invoke('command', { name, argument });
      if (name === 'goal') applyGoal(argument === 'clear' ? null : obj(result).goal ?? result);
    } finally { if (name === 'goal') setGoalPending(false); }
  };
  useEffect(() => {
    if (!ready || (busy && !capabilities.sideWhileWorking) || !sideQuestion) return;
    let cancelled = false;
    setSide(`Answering…\n\n${sideQuestion}`);
    void invoke('command', { name: 'btw', argument: sideQuestion }).then(result => {
      if (!cancelled) setSide(str(obj(result).text) || `${agentLabel} returned no text for this side question.`);
    }).catch(e => { if (!cancelled) setSide(`Could not answer this side question: ${ipcMessage(e)}\n\n${sideQuestion}`); }).finally(() => { if (!cancelled) setSideQuestion(''); });
    return () => { cancelled = true; };
    // Wait for the current turn, and finish the side answer before dispatching queued messages.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, busy, sideQuestion, capabilities.sideWhileWorking]);
  const dispatch = async (text: string, files: Attachment[] = []) => {
    if (dispatching.current) return false;
    dispatching.current = true;
    setBusy(true); setTurnOutcome(null); setActivities([]); follow.current = true;
    const messageId = crypto.randomUUID();
    setMessages(old => [...old, { id: messageId, type: 'user', delivery: 'sending', text: text + (files.length ? `\n\n${files.map(a => `📎 ${a.name}`).join(' · ')}` : '') }]);
    try {
      await invoke('send', { text, attachmentIds: files.map(a => a.id), model: selectedModel || undefined, effort: effort || undefined, ...(capabilities.plan && (planRef.current || planWasOn.current) ? { plan: planRef.current } : {}) });
      planWasOn.current = planRef.current;
      setMessages(old => old.map(m => m.id === messageId ? { ...m, delivery: 'sent' } : m));
      return true;
    } catch (e) { fail(e); setMessages(old => old.map(m => m.id === messageId ? { ...m, delivery: 'failed' } : m)); setBusy(false); setTurnOutcome('failed'); setQueueHeld(true); return false; }
    finally { dispatching.current = false; }
  };
  useEffect(() => {
    if (!ready || busy || sideQuestion || queueHeld || !queue.length || requests.length || dispatching.current) return;
    const next = queue[0];
    void dispatch(next.text, next.attachments).then(ok => { if (ok) setQueue(old => old.filter(item => item.id !== next.id)); });
    // Queue changes drive dispatch. Model/effort changes apply to the next turn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, busy, sideQuestion, queueHeld, queue, requests.length]);
  const send = async (text: string, opposite = false) => {
    if ((!text.trim() && !attachments.length) || !ready || switching) return;
    setError('');
    try {
      if (text.startsWith('/')) { const revision = draftRevision.current; const [name, ...args] = text.slice(1).split(/\s+/); await command(name, args.join(' ')); if (draftRevision.current === revision) setPrompt(''); return; }
      if (busy || sideQuestion || queue.length) {
        if (sendAction({ mustWait: true, busy, steerSupported: capabilities.steer, preference: followUp, opposite, hasAttachments: attachments.length > 0, isCommand: false }) === 'steer') { await steer(text); return; }
        setQueue(old => [...old, { id: crypto.randomUUID(), text: text || 'Inspect the attached files.', attachments }]); setPrompt(''); setAttachments([]); return;
      }
      if (dispatching.current) return;
      const files = attachments;
      setPrompt(''); setAttachments([]);
      const revision = draftRevision.current;
      if (!await dispatch(text || 'Inspect the attached files.', files) && draftRevision.current === revision) { setPrompt(text); setAttachments(files); }
    } catch (e) { fail(e); }
  };
  const steer = async (text: string, queuedId?: string) => {
    if (!text.trim()) return;
    const revision = draftRevision.current;
    try { await invoke('steer', text); setMessages(old => [...old, { id: crypto.randomUUID(), type: 'user', text: `↳ ${text}` }]); if (queuedId) setQueue(old => old.filter(q => q.id !== queuedId)); else if (draftRevision.current === revision) setPrompt(''); }
    catch (e) { fail(e); }
  };
  const answerMessageQuestions = async (messageId: string, questions: GuiQuestion[], answers: Record<string, string>) => {
    const reply = questions.length === 1
      ? (answers[questions[0].id] || '')
      : questions.map(q => `${q.header || q.question}: ${answers[q.id] || ''}`).join('\n');
    if (!reply.trim()) return;
    setMessages(old => old.map(m => m.id === messageId ? { ...m, questionAnswers: answers } : m));
    if (busy && capabilities.steer) await steer(reply);
    else await send(reply);
  };
  const answerMessageQuestionsRef = useRef(answerMessageQuestions);
  answerMessageQuestionsRef.current = answerMessageQuestions;
  const handleAnswerMessageQuestions = useCallback(
    (messageId: string, questions: GuiQuestion[], answers: Record<string, string>) =>
      answerMessageQuestionsRef.current(messageId, questions, answers),
    [],
  );
  const activityCounts = activities.reduce((counts, activity) => {
    const status = activity.status === 'inProgress' ? 'running'
      : activity.status === 'failed' || activity.status === 'declined' ? 'failed'
      : activity.status === 'interrupted' || activity.status === 'cancelled' ? 'interrupted' : 'completed';
    counts[status]++;
    return counts;
  }, { running: 0, completed: 0, failed: 0, interrupted: 0 });
  const activityPhaseList = activityPhases(activities.map(x => ({ kind: x.kind ?? 'tool', startedAt: x.startedAt, endedAt: x.endedAt })));
  const activitySummary = [`${activities.length} ${activities.length === 1 ? 'action' : 'actions'}`,
    ...Object.entries(activityCounts).filter(([, count]) => count > 0).map(([status, count]) => `${count} ${status}`),
  ].join(' · ');
  const closeArtifacts = () => { setDrawer(false); artifactButton.current?.focus(); };
  return <section
    className={`aya-pane aya-conversation${isActivePane ? ' aya-pane--active-split' : ''}`}
    style={{ ...paneStyle, ...(hidden ? { display: 'none' } : {}) }}
    onMouseDown={() => onActivatePane?.()}
    onDragOver={e => {
      const types = Array.from(e.dataTransfer?.types || []);
      if (!types.includes('Files')) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    }}
    onDrop={e => {
      const files = Array.from(e.dataTransfer?.files || []);
      if (!files.length) return;
      e.preventDefault();
    }}
    onKeyDown={e => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        if (history !== null) {
          setHistory(null);
          composer.current?.focus();
        } else if (suggestion) {
          setSuggestion('');
        } else {
          if (drawer) closeArtifacts();
          if (side || sideQuestion) {
            setSide('');
            setSideQuestion('');
          }
        }
      }
    }}
  >
    <header className="aya-gui-header">
      <div className="aya-gui-heading"><strong>Conversation</strong><small>{model} · <span>Experimental</span></small></div>
      <span className="aya-sr-only" role="status">{connecting ? 'Connecting…' : switching ? 'Switching conversation…' : busy ? `${agentLabel} is working…` : ready ? 'Ready' : 'Disconnected'}</span>
      {!ready && restored && <button type="button" disabled={connecting} onClick={() => void reconnect()}>{connecting ? 'Connecting…' : 'Reconnect'}</button>}
      <button className="aya-gui-icon-button" disabled={!ready || switching} aria-label="Resume a saved conversation" title="Resume a saved conversation" onClick={() => void openHistory().catch(fail)}><span className="aya-gui-icon" aria-hidden="true">history</span></button>
      <button className="aya-gui-icon-button aya-gui-artifact-button" ref={artifactButton} aria-label={`Artifacts${unreadArtifactCount ? ' ' + unreadArtifactCount : ''}`} title={unreadArtifactCount ? `${unreadArtifactCount} unseen artifacts` : 'Artifacts'} aria-expanded={drawer} onClick={() => setDrawer(!drawer)}><span className="aya-gui-icon" aria-hidden="true">deployed_code</span>{unreadArtifactCount > 0 && <b aria-hidden="true">{unreadArtifactCount}</b>}</button>
    </header>
    {restored && <div className="aya-gui-save-state" data-state={saveStatus}><span role="status" aria-label="Conversation save status">{saveStatus === 'saved' ? 'Saved locally' : saveStatus === 'error' ? 'Not saved' : 'Saving…'}</span>{saveError && <><span>{saveError}</span><button type="button" disabled={saveStatus === 'saving'} onClick={() => void persistLatest()}>Retry save</button></>}</div>}
    {history !== null && <div ref={historyDialog} className="aya-session-picker" role="dialog" aria-modal="true" aria-label="Resume conversation" onKeyDown={e => {
      if (e.key === 'Escape') { e.preventDefault(); setHistory(null); composer.current?.focus(); }
      if (e.key === 'Tab') { const nodes = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input')); const first = nodes[0], last = nodes[nodes.length - 1]; if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); } }
    }}>
      <div><strong>Resume conversation</strong><button aria-label="Close conversation picker" onClick={() => { setHistory(null); composer.current?.focus(); }}>×</button></div>
      <input autoFocus aria-label="Search conversations" placeholder="Search saved conversations…" value={historyQuery} onChange={e => setHistoryQuery(e.target.value)} />
      <small>This project and account · Aya history{guiAgent === 'codex' ? ' and Codex history' : ''}. Drafts and artifacts saved in Aya are kept.</small>
      <div className="aya-session-list">{history.map(row => <button key={row.id} disabled={row.current || busy || switching || requests.length > 0} onClick={() => void switchConversation(row.id).catch(fail)}><span>{row.title}</span><small>{row.current ? 'Current conversation' : new Date(row.updatedAt).toLocaleString()}</small></button>)}{historyLoading && <p role="status">Loading conversations…</p>}{!historyLoading && !history.length && <p>No saved conversations match.</p>}{historyHasMore && <button disabled={historyLoading} onClick={() => void loadHistory(historyQuery, history.length)}>Load more conversations</button>}</div>
      <button disabled={busy || switching || requests.length > 0} onClick={() => void switchConversation().catch(fail)}>New conversation</button>
      {busy && <small>Stop the current turn before switching.</small>}
    </div>}
    {importNotice && <div className="aya-gui-import-notice" role="status">{importNotice}<button aria-label="Dismiss history notice" onClick={() => setImportNotice('')}>×</button></div>}
    {goalDetails && <div className="aya-gui-goal" data-status={goalDetails.status}><strong>Goal</strong><span className="aya-gui-goal-objective" title={goalDetails.objective}>{goalDetails.objective}</span><span className="aya-gui-goal-status" role="status" aria-label="Goal status">{({ active: 'Active', paused: 'Paused', blocked: 'Blocked', complete: 'Complete', usageLimited: 'Usage limit', budgetLimited: 'Budget limit' } as Record<string, string>)[goalDetails.status] || goalDetails.status}</span>
      {goalDetails.status !== 'complete' && <button className="aya-gui-icon-button" disabled={goalPending} aria-label={goalDetails.status === 'active' ? 'Pause goal' : 'Resume goal'} title={goalDetails.status === 'active' ? 'Pause goal' : 'Resume goal'} onClick={() => void command('goal', goalDetails.status === 'active' ? 'pause' : 'resume').catch(fail)}><span className="aya-gui-icon" aria-hidden="true">{goalDetails.status === 'active' ? 'pause' : 'play_arrow'}</span></button>}
      <button className="aya-gui-icon-button" disabled={goalPending} aria-label="Clear goal" title="Clear goal" onClick={() => void command('goal', 'clear').catch(fail)}><span className="aya-gui-icon" aria-hidden="true">close</span></button>
    </div>}
    {goalDetails?.status === 'blocked' && <div className="aya-gui-goal-reason" aria-label="Goal block reason"><strong>Why blocked</strong><ReactMarkdown remarkPlugins={[remarkGfm]}>{goalDetails.reason || 'The agent did not provide a reason. Ask it what is blocking this goal.'}</ReactMarkdown></div>}
    <div className="aya-gui-body"><main>{findOpen && <div className="aya-gui-find" role="search"><input ref={findInput} type="search" aria-label="Find in conversation" placeholder="Find in conversation" value={findQuery} onChange={e => { setFindQuery(e.target.value); setFindIndex(0); }} onKeyDown={e => {
        if (e.key === 'Escape') { e.preventDefault(); onCloseFind?.(); composer.current?.focus(); }
        else if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); setFindIndex(stepMatch(findIndex, findCount, e.shiftKey ? -1 : 1)); }
      }} /><small role="status" aria-label="Find results">{findStatus(findQuery, findIndex, findCount)}</small><button type="button" aria-label="Previous match" disabled={!findCount} onClick={() => setFindIndex(stepMatch(findIndex, findCount, -1))}>↑</button><button type="button" aria-label="Next match" disabled={!findCount} onClick={() => setFindIndex(stepMatch(findIndex, findCount, 1))}>↓</button><button type="button" aria-label="Close find" onClick={() => { onCloseFind?.(); composer.current?.focus(); }}>×</button></div>}<div className="aya-gui-scroll-area"><div ref={node => { scrollViewport.current = node; messagesRoot.current = node; }} onMouseUp={() => { const selection = window.getSelection(); const text = selection?.toString() ?? ''; const node = selection?.anchorNode; const inside = node && (node instanceof Element ? node : node.parentElement)?.closest('article.assistant'); if (!selection || selection.isCollapsed || !text.trim() || !inside) { setQuote(null); return; } const rect = selection.getRangeAt(0).getBoundingClientRect(); setQuote({ text, left: Math.max(8, rect.right - 110), top: rect.bottom + 6 }); }} className="aya-gui-messages" aria-label={`Conversation with ${agentLabel}`} onScroll={e => { const node = e.currentTarget; follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80; setShowJump(!follow.current); }}><div ref={scrollContent} className="aya-gui-message-content">
      {!messages.length && <div className="aya-gui-welcome"><h1>Your {agentLabel}, with room to show more.</h1><p>Ask a question, inspect your project, or request a table or image.</p><p>Artifacts stay one click away.</p></div>}
      {messages.map(m => (
        <ConversationMessageItem
          key={m.id}
          message={m}
          agentBadge={agentBadge}
          agentLabel={agentLabel}
          loadConversationImage={loadConversationImage}
          onAnswerMessageQuestions={handleAnswerMessageQuestions}
          onImplementPlan={m.id === messages[messages.length - 1]?.id && !busy && ready ? () => { setPlanMode(false); void send('Implement the plan.'); } : undefined}
        />
      ))}
      {activities.length > 0 && <details className="aya-gui-activity"><summary aria-label="Tool activity"><span className="aya-gui-turn-dot" />{activitySummary}<small>Details</small></summary><div className="aya-gui-activity-list" role="region" aria-label="Tool activity details" tabIndex={0}>{activities.map((a, index) => { const phase = activityPhaseList.find(p => p.index === index); const took = activityDuration(a); return <Fragment key={a.id}>{phase && <div className="aya-gui-activity-phase" role="presentation">{phaseText(phase)}</div>}<details><summary>{a.status === 'inProgress' ? '◌' : a.status === 'failed' || a.status === 'declined' ? '!' : a.status === 'interrupted' ? '■' : '✓'} {a.label}{took !== null && <small className="aya-gui-activity-time"> · {shortDuration(took)}</small>}</summary>{a.output && <pre>{a.output}</pre>}</details></Fragment>; })}</div></details>}
      {(messages.length > 0 || busy || turnOutcome) && <div className="aya-gui-turn-row"><div className="aya-gui-turn-status" role="status" aria-label="Turn status" data-working={busy && requests.length === 0}>
        <span className="aya-gui-turn-dot" aria-hidden="true" />
        {!ready ? 'Disconnected' : requests.length ? 'Waiting for your response' : busy ? `${agentLabel} is working…` : turnOutcome === 'interrupted' ? 'Interrupted' : turnOutcome === 'failed' ? 'Turn failed' : turnOutcome === 'complete' ? 'Turn complete' : 'Ready'}
      </div>{(busy ? turnElapsed : lastTurnMs) !== null && <span className="aya-gui-turn-timer" aria-hidden="true">{busy ? 'Working' : 'Worked'} for {formatElapsed((busy ? turnElapsed : lastTurnMs) ?? 0)}</span>}</div>}
    </div></div>
    {showJump && <button className="aya-gui-jump" onClick={() => { follow.current = true; setShowJump(false); scrollToLatest(); }}>Jump to latest ↓</button>}</div>
    {side && <aside className="aya-gui-side"><button aria-label="Close side question" onClick={() => { setSide(''); setSideQuestion(''); }}>×</button><strong>Side question</strong><ReactMarkdown remarkPlugins={[remarkGfm]}>{side}</ReactMarkdown></aside>}
    {quote && <button type="button" className="aya-gui-quote" style={{ left: quote.left, top: quote.top }} onMouseDown={e => e.preventDefault()} onClick={() => { recall.current = null; setPrompt(old => withQuote(old, quote.text)); setQuote(null); window.getSelection()?.removeAllRanges(); composer.current?.focus(); }}>Quote in composer</button>}
    <form onSubmit={e => { e.preventDefault(); void send(prompt); }}>
      {requests.map((request, index) => <GuiRequest key={request.id} request={request} agentLabel={agentLabel} codex={guiAgent === 'codex'} active={index === 0 && !hidden} promptEmpty={!prompt} respond={value => invoke('respond', { id: request.id, value }).catch(fail)} />)}
      {messages.filter(m => m.progress?.status === 'running').slice(-3).map(m => <TaskProgress key={m.id} progress={m.progress!} compact />)}
      {plan.length > 0 && <details className="aya-gui-plan"><summary>Plan <small>{plan.filter(p => p.status === 'completed').length}/{plan.length}</small></summary><ol>{plan.map((step, i) => <li key={i} data-state={step.status}>{step.status === 'completed' ? '✓' : step.status === 'inProgress' ? '◌' : '○'} {step.step}</li>)}</ol></details>}
      {queue.length > 0 && <div className="aya-gui-queue"><div><strong>{queueHeld ? 'Queue paused' : 'Up next'} <small>{queue.length}</small></strong>{queueHeld && <button type="button" disabled={busy} onClick={() => setQueueHeld(false)}>Resume queue</button>}</div>{queue.map((item, index) => <div className="aya-gui-queued" key={item.id}><textarea aria-label={`Queued message ${index + 1}`} value={item.text} onChange={e => setQueue(old => old.map(q => q.id === item.id ? { ...q, text: e.target.value } : q))} /><div>{item.attachments.length > 0 && <small>{item.attachments.map(a => a.name).join(', ')}</small>}{busy && capabilities.steer && !item.attachments.length && <button type="button" disabled={!item.text.trim()} title="Send into the running turn" onClick={() => void steer(item.text, item.id)}>Steer ↗</button>}{index > 0 && <button type="button" aria-label={`Move queued message ${index + 1} up`} onClick={() => setQueue(old => { const next = [...old]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; return next; })}>↑</button>}<button type="button" aria-label={`Remove queued message ${index + 1}`} onClick={() => setQueue(old => old.filter(q => q.id !== item.id))}>×</button></div></div>)}</div>}
      {suggestion && <div className="aya-widget-suggestion"><div><small>FROM ARTIFACT</small><p>{suggestion}</p></div><button type="button" onClick={() => { setPrompt(old => old ? `${old}\n\n${suggestion}` : suggestion); setSuggestion(''); composer.current?.focus(); }}>Add to message</button><button type="button" aria-label="Dismiss suggestion" onClick={() => setSuggestion('')}>×</button></div>}
      {error && <div role="alert" className="aya-gui-error"><span>{error}</span><button type="button" aria-label="Dismiss error" title="Dismiss error" onClick={() => { setError(''); composer.current?.focus(); }}>×</button></div>}
      {prompt.startsWith('/') && <div className="aya-gui-commands">{availableCommands.filter(item => item.name.startsWith(prompt.slice(1).split(/\s/)[0])).map(item => <button type="button" key={item.name} title={item.description} onClick={() => setPrompt('/' + item.name + ' ')}>/{item.name}</button>)}</div>}
      {attachments.length > 0 && <div className="aya-gui-attachments">{attachments.map(a => <span key={a.id} title={a.path}>📎 {a.name}<button type="button" aria-label={`Remove ${a.name}`} onClick={() => setAttachments(old => old.filter(f => f.id !== a.id))}>×</button></span>)}</div>}
      <textarea
        ref={composer}
        aria-label={`Message ${agentLabel}`}
        placeholder={`Message ${agentLabel}… (/ for commands)`}
        value={prompt}
        onChange={e => setPrompt(e.target.value)}
        onPaste={e => {
          const data = e.clipboardData;
          if (!data || !ready) return;
          const types = Array.from(data.types || []);
          const pasted = types.includes('text/plain') ? data.getData('text/plain') : '';
          if (pasted && pasteBecomesAttachment(pasted, prompt.length)) {
            e.preventDefault();
            void invoke('paste-text', { text: pasted }).then(item => {
              if (item && typeof item === 'object' && 'id' in item) setAttachments(old => [...old, item as Attachment].slice(0, 20));
            }).catch(fail);
            return;
          }
          if (pasted) return;
          const items = Array.from(data.items || []);
          const hasImage = items.some(item => item.type.startsWith('image/')) || types.some(t => t.startsWith('image/'));
          if (!hasImage) return;
          e.preventDefault();
          void invoke('paste-image').then(item => {
            if (item && typeof item === 'object' && 'id' in item) {
              setAttachments(old => [...old, item as Attachment].slice(0, 20));
            }
          }).catch(fail);
        }}
        onKeyDown={e => {
          if (!e.nativeEvent.isComposing) {
            const el = e.currentTarget;
            if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
              const step = stashStep(stash, prompt);
              if (step) { e.preventDefault(); recall.current = null; setPrompt(step.prompt); setStash(step.stash); }
              return;
            }
            if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && el.selectionStart === el.selectionEnd) {
              const up = e.key === 'ArrowUp';
              const atEdge = up ? !prompt.slice(0, el.selectionStart).includes('\n') : !prompt.slice(el.selectionEnd).includes('\n');
              const step = recallStep(messages.filter(m => m.type === 'user').map(m => sentPromptText(m.text)), recall.current, prompt, up ? 'up' : 'down', atEdge);
              if (step) { e.preventDefault(); recall.current = step.recall; setPrompt(step.prompt); return; }
            }
          }
          if (
            e.key === 'Tab' &&
            !e.shiftKey &&
            !e.altKey &&
            !e.ctrlKey &&
            !e.metaKey &&
            !e.nativeEvent.isComposing &&
            prompt.startsWith('/') &&
            !prompt.slice(1).includes(' ')
          ) {
            const matching = availableCommands.filter(item =>
              item.name.startsWith(prompt.slice(1).split(/\s/)[0]),
            );
            if (matching.length > 0) {
              e.preventDefault();
              setPrompt('/' + matching[0].name + ' ');
              return;
            }
          }
          if (e.key === 'Enter' && e.shiftKey && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
            // Cmd/Ctrl+Shift+Enter sends the oldest queued message into the running turn.
            const first = queue[0];
            if (busy && capabilities.steer && first && !first.attachments.length && first.text.trim()) { e.preventDefault(); void steer(first.text, first.id); }
            return;
          }
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void send(prompt, e.metaKey || e.ctrlKey);
          }
        }}
      />
      <div className="aya-gui-compose-footer"><button className="aya-gui-icon-button" type="button" title="Attach files or images" aria-label="Attach files" disabled={!ready} onClick={() => void invoke('pick-attachments').then(files => setAttachments(old => [...old, ...(files as Attachment[])].slice(0, 20))).catch(fail)}><span className="aya-gui-icon" aria-hidden="true">add</span></button>
      {models.length > 0 && <><select aria-label="Model for next turn" title="Model · applies to the next turn" value={selectedModel || model} onChange={e => changeModel(e.target.value)}><option value={model}>{model}</option>{models.filter(m => m.model !== model).map(m => <option key={m.id} value={m.model}>{m.displayName}</option>)}</select>{(models.find(m => m.model === (selectedModel || model))?.supportedReasoningEfforts.length || 0) > 0 && <select aria-label="Reasoning effort" title="Reasoning effort · applies to the next turn" value={effort} onChange={e => changeEffort(e.target.value)}><option value="">Default effort</option>{models.find(m => m.model === (selectedModel || model))?.supportedReasoningEfforts.map(e => <option key={e.reasoningEffort} value={e.reasoningEffort}>{e.reasoningEffort}</option>)}</select>}</>}
      <span className="aya-gui-compose-spacer" />{capabilities.plan && <button type="button" className="aya-gui-plan-toggle" aria-pressed={planMode} title="Plan mode: the agent proposes a plan instead of acting (/plan)" onClick={() => setPlanMode(value => !value)}>Plan{planMode ? ' on' : ''}</button>}{stash.length > 0 && <small className="aya-gui-stash" title="Cmd+S in an empty composer brings the latest one back">Stash {stash.length}</small>}<small className="aya-gui-enter-hint">{busy ? followUpHint(followUp, capabilities.steer) : 'Shift+Enter for a new line'}</small>{busy && capabilities.steer && <button type="button" className="aya-gui-followup" title="What Enter does while the agent works" aria-label={`Enter while working: ${followUp}. Click to switch.`} onClick={() => setFollowUp(followUp === 'steer' ? 'queue' : 'steer')}>Enter: {followUp}</button>}{busy && <><button type="button" className="aya-gui-stop" onClick={() => { setQueueHeld(true); void invoke('interrupt').catch(fail); }}>Stop</button>{capabilities.steer && prompt.trim() && !prompt.startsWith('/') && !attachments.length && <button type="button" onClick={() => void steer(prompt)}>Steer ↗</button>}</>}<button className="aya-gui-send" disabled={!ready || (!prompt.trim() && !attachments.length)}>{sendLabel(sendAction({ mustWait: busy || Boolean(sideQuestion) || queue.length > 0, busy, steerSupported: capabilities.steer, preference: followUp, opposite: false, hasAttachments: attachments.length > 0, isCommand: prompt.startsWith('/') }))}</button></div>
    </form></main>
    {drawer && <ArtifactPanel artifacts={artifacts} selected={selected} history={artifactHistory} seenRevisions={seenArtifactRevisions} visible={!hidden} onViewed={markArtifactViewed} onPreview={loadArtifactPreview} onLoad={loadArtifactContent} onSearch={searchArtifactContents} onSelect={setSelected} onSuggest={setSuggestion} onSave={(id, revision) => invoke('save-artifact', { id, revision })} onOpen={(id, revision) => invoke('open-artifact', { id, revision })} onBrowser={(id, revision) => invoke('open-artifact-browser', { id, revision })} />}
    </div>
  </section>;
}

/** The ranges of `query` in the text shown under `root`, skipping text that is not laid out (a closed <details>). */
function collectFindRanges(root: HTMLElement, query: string): Range[] {
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    for (const m of findTextMatches(node.nodeValue ?? '', query)) {
      const range = document.createRange();
      range.setStart(node, m.start); range.setEnd(node, m.start + m.length);
      if (range.getClientRects().length > 0) ranges.push(range);
    }
  }
  return ranges;
}
function paintFind(ranges: Range[], current: number) {
  if (typeof CSS === 'undefined' || !('highlights' in CSS)) return;
  CSS.highlights.delete('aya-find'); CSS.highlights.delete('aya-find-current');
  if (!ranges.length) return;
  CSS.highlights.set('aya-find', new Highlight(...ranges.filter((_, i) => i !== current)));
  if (ranges[current]) CSS.highlights.set('aya-find-current', new Highlight(ranges[current]));
}

/** A plan the agent proposed in plan mode: collapsed when long, copyable, with a button that carries it out. */
function PlanCard({ text, loadImage, onImplement }: { text: string; loadImage: (path: string) => Promise<unknown>; onImplement?: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const lines = text.split('\n');
  const long = lines.length > 14 || text.length > 900;
  const shown = long && !expanded ? lines.slice(0, 10).join('\n') + '\n\n…' : text;
  return <article className="aya-gui-plan-card assistant" aria-label="Proposed plan">
    <header><strong>Proposed plan</strong>
      <button type="button" onClick={() => { void navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {}); }}>{copied ? 'Copied' : 'Copy'}</button>
    </header>
    <ConversationMarkdown text={shown} loadImage={loadImage} />
    <footer>
      {long && <button type="button" onClick={() => setExpanded(value => !value)}>{expanded ? 'Show less' : 'Show all'}</button>}
      {onImplement && <button type="button" className="aya-gui-send" onClick={onImplement}>Implement this plan</button>}
    </footer>
  </article>;
}
const ConversationMessageItem = memo(function ConversationMessageItem({
  message: m,
  agentBadge,
  agentLabel,
  loadConversationImage,
  onAnswerMessageQuestions,
  onImplementPlan,
}: {
  message: Message;
  agentBadge: string;
  agentLabel: string;
  loadConversationImage: (path: string) => Promise<unknown>;
  onAnswerMessageQuestions: (
    messageId: string,
    questions: GuiQuestion[],
    answers: Record<string, string>,
  ) => Promise<void>;
  onImplementPlan?: () => void;
}) {
  if (m.kind === 'plan') return <PlanCard text={m.text} loadImage={loadConversationImage} onImplement={onImplementPlan} />;
  if (m.type === 'progress' && m.progress) {
    return m.progress.status === 'running' ? null : <TaskProgress progress={m.progress} />;
  }
  if (m.type === 'goal' || m.type === 'settings') {
    return (
      <article
        className={`aya-gui-goal-message${m.type === 'settings' ? ' aya-gui-settings-message' : ''}`}
        aria-label={m.title}
      >
        <span aria-hidden="true">{m.type === 'settings' ? '⚙' : '◎'}</span>
        <div>
          <strong>{m.title}</strong>
          <p>{m.text}</p>
          {m.goal?.status === 'blocked' && (
            <p className="aya-gui-goal-history-reason">
              {m.goal.reason || 'The agent did not provide a reason. Ask it what is blocking this goal.'}
            </p>
          )}
        </div>
      </article>
    );
  }
  const msgQuestions = m.type === 'assistant' ? extractMessageQuestions(m) : [];
  const displayText =
    msgQuestions.length > 0 ? stripQuestionBulletsFromText(m.text, msgQuestions) : m.text;
  return (
    <article className={m.type}>
      <small>
        {m.type === 'user'
          ? `YOU${
              m.delivery === 'sending'
                ? ' · Sending…'
                : m.delivery === 'failed'
                  ? ' · Not sent'
                  : m.delivery === 'unconfirmed'
                    ? ' · Delivery unconfirmed'
                    : ''
            }`
          : agentBadge}
      </small>
      {(!msgQuestions.length || displayText) && (
        <ConversationMarkdown text={displayText} loadImage={loadConversationImage} />
      )}
      {msgQuestions.length > 0 && (
        <GuiQuestionCard
          questions={msgQuestions}
          agentLabel={agentLabel}
          initialAnswers={m.questionAnswers}
          onSubmit={answers => onAnswerMessageQuestions(m.id, msgQuestions, answers)}
        />
      )}
    </article>
  );
});
function TaskProgress({ progress, compact = false }: { progress: GuiProgress; compact?: boolean }) {
  const percent = Math.round(progress.current / progress.total * 100);
  const label = ({ running: 'In progress', complete: 'Complete', paused: 'Paused', failed: 'Stopped' })[progress.status];
  return <div className={`aya-task-progress ${compact ? 'aya-task-progress--compact' : ''}`} data-status={progress.status}>
    <div className="aya-task-progress-heading"><strong>{progress.label}</strong><span>{progress.current.toLocaleString()} / {progress.total.toLocaleString()}<small>{label}</small></span></div>
    <div className="aya-task-progress-track" role="progressbar" aria-label={progress.label} aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.current} aria-valuetext={`${progress.current} of ${progress.total} · ${label}`}><span style={{ width: `${percent}%` }} /></div>
    {progress.detail && <p>{progress.detail}</p>}
  </div>;
}
function GuiQuestionCard({
  questions,
  agentLabel,
  isRequest = false,
  initialAnswers,
  onSubmit,
}: {
  questions: GuiQuestion[];
  agentLabel: string;
  isRequest?: boolean;
  initialAnswers?: Record<string, string>;
  onSubmit: (answers: Record<string, string>) => Promise<unknown>;
}) {
  const [selectedOptions, setSelectedOptions] = useState<Record<string, string[]>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const answered = Boolean(initialAnswers && Object.keys(initialAnswers).length > 0);
  const toggleOption = (qId: string, label: string, multiSelect: boolean) => {
    if (answered || sending) return;
    setSelectedOptions(old => {
      const current = old[qId] || [];
      const exists = current.includes(label);
      const next = multiSelect
        ? (exists ? current.filter(item => item !== label) : [...current, label])
        : (exists ? [] : [label]);
      return { ...old, [qId]: next };
    });
  };
  const composeAnswer = (q: GuiQuestion): string => {
    if (initialAnswers?.[q.id]) return initialAnswers[q.id];
    const chosen = (selectedOptions[q.id] || []).join(', ');
    const note = (notes[q.id] || '').trim();
    if (chosen && note) return `${chosen} — ${note}`;
    return chosen || note;
  };
  const canSubmit = !answered && !sending && questions.every(q => composeAnswer(q).trim().length > 0);
  const handleSubmit = async () => {
    if (!canSubmit) return;
    const answers = Object.fromEntries(questions.map(q => [q.id, composeAnswer(q).trim()]));
    setSending(true);
    try { await onSubmit(answers); }
    finally { setSending(false); }
  };
  const flat = questions.flatMap(q => q.options.map(o => ({ q, o })));
  return <section className={`${isRequest ? 'aya-gui-request ' : ''}aya-gui-question-card`} data-answered={answered} onKeyDown={e => {
    // 1-9 pick an option when the focus is not in a text field.
    if (answered || sending || e.metaKey || e.ctrlKey || e.altKey || e.nativeEvent.isComposing) return;
    if ((e.target as HTMLElement).closest('input,textarea')) return;
    const n = /^[1-9]$/.test(e.key) ? Number(e.key) - 1 : -1;
    if (n >= 0 && flat[n]) { e.preventDefault(); toggleOption(flat[n].q.id, flat[n].o.label, flat[n].q.multiSelect); }
  }}>
    <div className="aya-gui-question-card-header">
      <strong>{`${agentLabel} has a question`}</strong>
      {answered && <small>Answered</small>}
    </div>
    {questions.map(q => {
      const submittedValue = initialAnswers?.[q.id] || '';
      const activeList = selectedOptions[q.id] || [];
      return <div key={q.id} className="aya-gui-question-item">
        {q.header && <span className="aya-gui-question-header">{q.header}</span>}
        <p className="aya-gui-question-title">{q.question}</p>
        {q.options.length > 0 && <div className="aya-gui-question-options" role="group" aria-label={q.question}>
          {q.options.map(o => {
            const isSelected = answered
              ? (submittedValue === o.label || submittedValue.startsWith(`${o.label} — `) || submittedValue.split(', ').includes(o.label))
              : activeList.includes(o.label);
            return <button
              type="button"
              key={o.label}
              className="aya-gui-question-option"
              aria-pressed={isSelected}
              disabled={answered || sending}
              onClick={() => toggleOption(q.id, o.label, q.multiSelect)}
            >
              <span className="aya-gui-question-check" aria-hidden="true">{q.multiSelect ? (isSelected ? '☑' : '☐') : (isSelected ? '●' : '○')}</span>
              {!answered && flat.findIndex(f => f.q === q && f.o === o) < 9 && <kbd className="aya-gui-question-key" aria-hidden="true">{flat.findIndex(f => f.q === q && f.o === o) + 1}</kbd>}
              <span className="aya-gui-question-option-body">
                <strong>{o.label}</strong>
                {o.description && <small>{o.description}</small>}
              </span>
            </button>;
          })}
        </div>}
        {answered ? (
          <div className="aya-gui-question-answered"><strong>Your answer:</strong> <span>{submittedValue}</span></div>
        ) : (
          <input
            type={q.isSecret ? 'password' : 'text'}
            className="aya-gui-question-input"
            aria-label={q.question}
            placeholder={
              q.options.length === 0
                ? 'Type your answer…'
                : activeList.length > 0
                  ? 'Add details or notes (optional)…'
                  : 'Or type your own answer / additional details…'
            }
            disabled={sending}
            value={notes[q.id] || ''}
            onChange={e => setNotes(old => ({ ...old, [q.id]: e.target.value }))}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && canSubmit) {
                e.preventDefault();
                void handleSubmit();
              }
            }}
          />
        )}
      </div>;
    })}
    {!answered && <div className="aya-gui-question-footer">
      <button type="button" className="aya-gui-send" disabled={!canSubmit} onClick={() => void handleSubmit()}>Send answer</button>
    </div>}
  </section>;
}
function GuiRequest({ request, agentLabel, codex, active, promptEmpty, respond }: { request: GuiEvent; agentLabel: string; codex: boolean; /** The first pending request of a visible pane answers the keyboard shortcuts. */ active: boolean; /** Cmd+Backspace declines only when it cannot be deleting text. */ promptEmpty: boolean; respond: (value: unknown) => Promise<unknown> }) {
  const decisions: GuiApprovalDecision[] = codex && Array.isArray(request.params.availableDecisions)
    ? request.params.availableDecisions as GuiApprovalDecision[]
    : ['accept', ...(codex ? ['acceptForSession' as const] : []), ...(codex && Array.isArray(request.params.proposedExecpolicyAmendment) ? [{ acceptWithExecpolicyAmendment: { execpolicy_amendment: request.params.proposedExecpolicyAmendment as string[] } }] : []), 'decline'];
  const decisionLabel = (decision: GuiApprovalDecision) => {
    if (decision === 'accept') return 'Allow once';
    if (decision === 'acceptForSession') return 'Allow for this session';
    if (decision === 'decline') return 'Decline';
    if (decision === 'cancel') return 'Cancel';
    if ('acceptWithExecpolicyAmendment' in decision) return `Always allow: ${decision.acceptWithExecpolicyAmendment.execpolicy_amendment.join(' ')}`;
    return `${decision.applyNetworkPolicyAmendment.network_policy_amendment.action === 'allow' ? 'Always allow' : 'Block'} host: ${decision.applyNetworkPolicyAmendment.network_policy_amendment.host}`;
  };
  const questions = normalizeQuestions(request.params.questions);
  const [sending, setSending] = useState(false);
  const submit = async (value: unknown) => { setSending(true); try { await respond(value); } finally { setSending(false); } };
  const isApproval = questions.length === 0;
  const canAllow = decisions.includes('accept'), canDecline = decisions.includes('decline');
  useEffect(() => {
    if (!active || !isApproval) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.isComposing || sending) return;
      if (e.key === 'Enter' && canAllow) { e.preventDefault(); void submit({ decision: 'accept' }); }
      else if (e.key === 'Backspace' && canDecline && promptEmpty) { e.preventDefault(); void submit({ decision: 'decline' }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  if (questions.length > 0) return <GuiQuestionCard questions={questions} agentLabel={agentLabel} isRequest onSubmit={answers => submit({ answers })} />;
  return <section className="aya-gui-request" role="group" aria-label="Approval required"><strong>Approval required</strong><pre>{str(request.params.command) || str(request.params.reason) || JSON.stringify(request.params, null, 2)}</pre><div className="aya-gui-request-actions">{decisions.map((decision, index) => <button key={index} disabled={sending} data-primary={decision === 'accept' || undefined} aria-keyshortcuts={decision === 'accept' ? 'Control+Enter Meta+Enter' : decision === 'decline' && promptEmpty ? 'Control+Backspace Meta+Backspace' : undefined} onClick={() => void submit({ decision })}>{decisionLabel(decision)}</button>)}</div>{active && (canAllow || canDecline) && <small className="aya-gui-request-hint">{canAllow ? '⌘↵ allow once' : ''}{canAllow && canDecline && promptEmpty ? ' · ' : ''}{canDecline && promptEmpty ? '⌘⌫ decline' : ''}</small>}</section>;
}
