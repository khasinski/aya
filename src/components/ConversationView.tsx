import { useCallback, useEffect, useRef, useState, type CSSProperties, type SetStateAction } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { guiSupportedAgent } from '../agentPreset';
import type { GuiProgress } from '../../shared/gui-progress';
import type { GuiArtifact, GuiEvent } from '../../shared/codex-gui';
import type { Preset, TerminalState } from '../types';
import './conversation.css';
import { ArtifactPanel } from './ArtifactPanel';
const obj = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const str = (value: unknown) => typeof value === 'string' ? value : '';
const goalText = (value: unknown) => { const goal = obj(value); return [str(goal.objective), str(goal.status)].filter(Boolean).join(' · '); };
interface Attachment { id: string; name: string; path: string; image: boolean }
interface QueuedMessage { id: string; text: string; attachments: Attachment[] }
interface ModelOption { id: string; model: string; displayName: string; supportedReasoningEfforts: { reasoningEffort: string }[]; defaultReasoningEffort: string }
interface Activity { id: string; label: string; status: string; output: string }
interface Message { progress?: GuiProgress; id: string; type: string; text: string; delivery?: 'sending' | 'sent' | 'failed' | 'unconfirmed'; title?: string; goal?: { objective: string; status: string } | null }
type ConversationProps = { terminal: TerminalState; preset: Preset; paneStyle?: CSSProperties; hidden?: boolean };
export function ConversationView(props: ConversationProps) {
  const [generation, setGeneration] = useState(0);
  return <ConversationSession key={`${props.terminal.id}:${generation}`} {...props} onSwitch={() => setGeneration(n => n + 1)} />;
}
function ConversationSession({ terminal, preset, paneStyle, hidden = false, onSwitch }: ConversationProps & { onSwitch: () => void }) {
  const api = window.ayaGui;
  const guiAgent = guiSupportedAgent(preset) ?? 'codex';
  const agentLabel = guiAgent === 'pi' ? 'Pi' : guiAgent === 'claude' ? 'Claude' : guiAgent === 'antigravity' ? 'Antigravity' : 'Codex';
  const agentBadge = guiAgent === 'pi' ? 'PI' : guiAgent === 'claude' ? 'CLAUDE' : guiAgent === 'antigravity' ? 'ANTIGRAVITY' : 'CODEX';
  const invoke = (action: string, value?: unknown) => { if (!api) return Promise.reject(Error('Conversation GUI is available in the desktop app only.')); return api.invoke(terminal.id, action, value); };
  const [messages, setMessages] = useState<Message[]>([]);
  const [artifacts, setArtifacts] = useState<GuiArtifact[]>([]);
  const [artifactHistory, setArtifactHistory] = useState<Record<string, GuiArtifact[]>>({});
  const [suggestion, setSuggestion] = useState('');
  const draftRevision = useRef(0);
  const [attachments, setAttachmentValues] = useState<Attachment[]>([]);
  const setAttachments = useCallback((value: SetStateAction<Attachment[]>) => { draftRevision.current++; setAttachmentValues(value); }, []);
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  const [queueHeld, setQueueHeld] = useState(false);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [effort, setEffort] = useState('');
  const [activities, setActivities] = useState<Activity[]>([]);
  const [plan, setPlan] = useState<{ step: string; status: string }[]>([]);
  const [showJump, setShowJump] = useState(false);
  const follow = useRef(true);
  const dispatching = useRef(false);
  const pendingSnapshot = useRef<Record<string, unknown> | null>(null);
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const artifactButton = useRef<HTMLButtonElement>(null);
  const [drawer, setDrawer] = useState(false);
  const [selected, setSelected] = useState('');
  const [prompt, setPromptValue] = useState('');
  const setPrompt = useCallback((value: SetStateAction<string>) => { draftRevision.current++; setPromptValue(value); }, []);
  const [busy, setBusy] = useState(false);
  const [turnOutcome, setTurnOutcome] = useState<'complete' | 'interrupted' | 'failed' | null>(null);
  const [ready, setReady] = useState(false);
  const [restored, setRestored] = useState(false);
  const [error, setError] = useState('');
  const [model, setModel] = useState('Connecting…');
  const [requests, setRequests] = useState<GuiEvent[]>([]);
  const [goal, setGoal] = useState('');
  const [goalDetails, setGoalDetails] = useState<{ objective: string; status: string } | null>(null);
  const [goalPending, setGoalPending] = useState(false);
  const [side, setSide] = useState('');
  const [importNotice, setImportNotice] = useState('');
  const [history, setHistory] = useState<{ id: string; title: string; updatedAt: number; current: boolean }[] | null>(null);
  const [historyQuery, setHistoryQuery] = useState('');
  const [historyLoading, setHistoryLoading] = useState(false);
  const [switching, setSwitching] = useState(false);
  const openHistory = async (query = '') => {
    setHistoryQuery(query); setHistory([]); setHistoryLoading(true);
    try { setHistory(await invoke('history') as NonNullable<typeof history>); } finally { setHistoryLoading(false); }
  };
  const switchConversation = async (conversationId?: string) => {
    if (busy || requests.length || dispatching.current) throw Error('Stop the current turn and resolve approvals before switching conversations');
    setSwitching(true); setReady(false); setRestored(false);
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = null;
    try { await invoke('switch-conversation', { conversationId, view: pendingSnapshot.current }); pendingSnapshot.current = null; onSwitch(); }
    catch (error) { setSwitching(false); setReady(true); setRestored(true); throw error; }
  };
  const end = useRef<HTMLDivElement>(null);
  const lastGoal = useRef<{ objective: string; status: string } | null>(null);
  const applyGoal = useCallback((value: unknown) => {
    const data = obj(value), objective = str(data.objective), status = str(data.status) || 'active';
    const previous = lastGoal.current;
    setGoal(objective ? goalText(data) : '');
    if (!objective) setGoalDetails(null);
    if (!objective) {
      if (previous) { lastGoal.current = null; setMessages(old => [...old, { id: crypto.randomUUID(), type: 'goal', title: 'Goal cleared', text: previous.objective, goal: null }]); }
      return;
    }
    if (previous?.objective === objective && previous.status === status) return;
    const next = { objective, status }; lastGoal.current = next; setGoalDetails(next);
    const title = !previous ? 'Goal set' : previous.objective !== objective ? 'Goal updated' : ({ active: 'Goal resumed', paused: 'Goal paused', blocked: 'Goal blocked', complete: 'Goal completed', usageLimited: 'Goal paused · usage limit', budgetLimited: 'Goal paused · token budget' } as Record<string, string>)[status] || `Goal ${status}`;
    setMessages(old => [...old, { id: crypto.randomUUID(), type: 'goal', title, text: objective, goal: next }]);
  }, []);
  const fail = (e: unknown) => setError(String(e).replace(/^Error: /, ''));
  useEffect(() => {
    if (!api) { setError('Conversation GUI requires the Aya desktop app.'); return; }
    let mounted = true;
    const off = api.onEvent(terminal.id, event => {
      const p = event.params;
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
      if (event.method === 'turn/started') { setBusy(true); setTurnOutcome(null); }
      if (event.method === 'turn/completed') { setBusy(false); setRequests([]); const turn = obj(p.turn); setActivities(old => old.map(a => a.status === 'inProgress' ? { ...a, status: turn.status === 'completed' ? 'completed' : 'interrupted' } : a)); if (turn.status !== 'completed') setQueueHeld(true); setTurnOutcome(turn.status === 'interrupted' ? 'interrupted' : turn.status === 'failed' || turn.error ? 'failed' : 'complete'); if (turn.error) fail(obj(turn.error).message); }
      if (event.method === 'aya/disconnected') { setReady(false); setBusy(false); fail(p.message); }
      if (event.method === 'error' || event.method === 'aya/notice') fail(p.message || obj(p.error).message);
      if (event.method === 'turn/plan/updated' && Array.isArray(p.plan)) setPlan(p.plan as { step: string; status: string }[]);
      if (event.method === 'item/started' || event.method === 'item/completed') {
        const item = obj(p.item), type = str(item.type);
        if (!['agentMessage', 'userMessage', 'reasoning', 'plan'].includes(type)) {
          const label = type === 'commandExecution' ? str(item.command) || 'Running a command' : type === 'fileChange' ? 'Editing files' : type === 'dynamicToolCall' ? (item.tool === 'aya_open_artifact' ? 'Opening an artifact' : 'Preparing an artifact') : type === 'webSearch' ? 'Searching the web' : type === 'mcpToolCall' ? `Using ${str(item.tool) || 'a connected tool'}` : 'Using a tool';
          setActivities(old => old.some(a => a.id === item.id) ? old.map(a => a.id === item.id ? { ...a, label, status: event.method === 'item/completed' ? str(item.status) || 'completed' : 'inProgress', output: str(item.aggregatedOutput) || a.output } : a) : [...old.slice(-49), { id: str(item.id), label, status: event.method === 'item/completed' ? str(item.status) || 'completed' : 'inProgress', output: str(item.aggregatedOutput) }]);
        }
      }
      if (event.method === 'item/commandExecution/outputDelta') setActivities(old => old.map(a => a.id === p.itemId ? { ...a, output: (a.output + str(p.delta)).slice(-100000) } : a));
      if (event.method === 'thread/goal/updated') applyGoal(p.goal ?? p);
      if (event.method === 'thread/goal/cleared') applyGoal(null);
      if (event.method === 'item/agentMessage/delta' || event.method === 'item/plan/delta') {
        const id = str(p.itemId);
        setMessages(old => old.some(m => m.id === id) ? old.map(m => m.id === id ? { ...m, text: m.text + str(p.delta) } : m) : [...old, { id, type: 'assistant', text: str(p.delta) }]);
      }
      if (event.method === 'item/completed') {
        const item = obj(p.item);
        if (item.type === 'agentMessage' || item.type === 'plan') setMessages(old => old.some(m => m.id === item.id) ? old.map(m => m.id === item.id ? { ...m, text: str(item.text) } : m) : [...old, { id: str(item.id), type: 'assistant', text: str(item.text) }]);
      }
    });
    void (async () => {
      const saved = obj(await api.invoke(terminal.id, 'load', { cwd: terminal.cwd, configDir: preset.configDir, agent: guiAgent }));
      if (!mounted) return;
      setImportNotice(str(saved.importNotice));
      if (Array.isArray(saved.messages)) { setMessages(saved.messages as Message[]); lastGoal.current = [...saved.messages as Message[]].reverse().find(m => m.type === 'goal')?.goal || null; }
      if (Array.isArray(saved.artifacts)) setArtifacts(saved.artifacts as GuiArtifact[]);
      if (saved.artifactHistory) setArtifactHistory(saved.artifactHistory as Record<string, GuiArtifact[]>);
      if (typeof saved.prompt === 'string') setPrompt(saved.prompt);
      if (typeof saved.selected === 'string') setSelected(saved.selected);
      if (typeof saved.drawer === 'boolean') setDrawer(saved.drawer);
      if (typeof saved.goal === 'string') {
        setGoal(saved.goal);
        const cut = saved.goal.lastIndexOf(' · ');
        if (saved.goal) { const details = saved.goalDetails as { objective: string; status: string } | undefined || { objective: cut >= 0 ? saved.goal.slice(0, cut) : saved.goal, status: cut >= 0 ? saved.goal.slice(cut + 3) : 'active' }; setGoalDetails(details); lastGoal.current = details; }
      }
      if (Array.isArray(saved.queue)) { setQueue(saved.queue as QueuedMessage[]); setQueueHeld(saved.queue.length > 0); }
      if (Array.isArray(saved.attachments)) setAttachments(saved.attachments as Attachment[]);
      if (typeof saved.selectedModel === 'string') setSelectedModel(saved.selectedModel);
      if (typeof saved.effort === 'string') setEffort(saved.effort);
      if (Array.isArray(saved.plan)) setPlan(saved.plan as { step: string; status: string }[]);
      if (saved.busy) setTurnOutcome('interrupted');
      else if (saved.turnOutcome) setTurnOutcome(saved.turnOutcome as 'complete' | 'interrupted' | 'failed');
      const result = await api.invoke(terminal.id, 'connect', { cwd: terminal.cwd, configDir: preset.configDir, agent: guiAgent });
      if (mounted) { setReady(true); setModel(str(obj(result).model)); setRestored(true); void api.invoke(terminal.id, 'models').then(result => { if (mounted && Array.isArray(obj(result).data)) setModels(obj(result).data as ModelOption[]); }).catch(() => {}); }
    })().catch(fail);
    return () => { mounted = false; off(); if (persistTimer.current) clearTimeout(persistTimer.current); persistTimer.current = null; void api.invoke(terminal.id, 'close', pendingSnapshot.current || undefined).catch(() => {}); };
    // A conversation belongs to a panel; editing its preset affects new panels.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminal.id]);
  useEffect(() => {
    if (!restored || !api) return;
    pendingSnapshot.current = { importNotice, messages, artifacts, artifactHistory, prompt, selected, drawer, goal, goalDetails, busy, turnOutcome, queue, attachments, selectedModel, effort, plan };
    if (persistTimer.current) return;
    persistTimer.current = setTimeout(() => { persistTimer.current = null; void api.invoke(terminal.id, 'persist', pendingSnapshot.current).catch(fail); }, 250);
  }, [restored, api, terminal.id, importNotice, messages, artifacts, artifactHistory, prompt, selected, drawer, goal, goalDetails, busy, turnOutcome, queue, attachments, selectedModel, effort, plan]);
  useEffect(() => {
    const flush = () => { if (persistTimer.current) clearTimeout(persistTimer.current); persistTimer.current = null; if (pendingSnapshot.current && api) void api.invoke(terminal.id, 'close', pendingSnapshot.current).catch(() => {}); };
    window.addEventListener('pagehide', flush);
    return () => { window.removeEventListener('pagehide', flush); if (persistTimer.current) clearTimeout(persistTimer.current); persistTimer.current = null; };
  }, [api, terminal.id]);
  useEffect(() => { if (!hidden && follow.current) end.current?.scrollIntoView({ block: 'end' }); }, [messages, requests, hidden, busy, turnOutcome, ready]);
  const command = async (name: string, argument: string) => {
    if (name === 'resume') { await openHistory(argument); return; }
    if (name === 'new' || name === 'clear') { await switchConversation(); return; }
    if (name === 'model') {
      if (argument) { const option = models.find(item => item.model === argument || item.displayName.toLowerCase() === argument.toLowerCase()); if (!option) throw Error('Unknown model. Choose an available model below the composer.'); setSelectedModel(option.model); setEffort(''); }
      composer.current?.closest('section.aya-conversation')?.querySelector<HTMLSelectElement>('[aria-label="Model for next turn"]')?.focus(); return;
    }
    if (name === 'status') { setSide(`${agentLabel} · ${model}\n${busy ? 'Working' : ready ? 'Ready' : 'Disconnected'}\nWorkspace: ${terminal.cwd}\nGoal: ${goal || 'None'}\nQueued messages: ${queue.length}`); return; }
    if (name === 'help') { setSide('Available commands: /resume [search] — choose a saved Aya conversation; /new or /clear — start a new conversation (history is kept); /goal — manage the goal; /btw — ask a side question after a turn; /compact — compact context; /model [name] — choose a model; /status — inspect session status. Model and reasoning controls are below the composer. Commands depend on the selected harness; terminal-only commands are not forwarded as prompts.'); return; }
    if (!['goal', 'btw', 'compact'].includes(name)) throw Error(`Unknown GUI command /${name}. Use /help.`);
    if (name === 'goal') setGoalPending(true);
    try {
      const result = await invoke('command', { name, argument });
      if (name === 'btw') setSide(str(obj(result).text) || `${agentLabel} returned no text for this side question.`);
      else if (name === 'goal') applyGoal(argument === 'clear' ? null : obj(result).goal ?? result);
    } finally { if (name === 'goal') setGoalPending(false); }
  };
  const dispatch = async (text: string, files: Attachment[] = []) => {
    if (dispatching.current) return false;
    dispatching.current = true;
    setBusy(true); setTurnOutcome(null); setActivities([]); follow.current = true;
    const messageId = crypto.randomUUID();
    setMessages(old => [...old, { id: messageId, type: 'user', delivery: 'sending', text: text + (files.length ? `\n\n${files.map(a => `📎 ${a.name}`).join(' · ')}` : '') }]);
    try {
      await invoke('send', { text, attachmentIds: files.map(a => a.id), model: selectedModel || undefined, effort: effort || undefined });
      setMessages(old => old.map(m => m.id === messageId ? { ...m, delivery: 'sent' } : m));
      return true;
    } catch (e) { fail(e); setMessages(old => old.map(m => m.id === messageId ? { ...m, delivery: 'failed' } : m)); setBusy(false); setTurnOutcome('failed'); setQueueHeld(true); return false; }
    finally { dispatching.current = false; }
  };
  useEffect(() => {
    if (!ready || busy || queueHeld || !queue.length || requests.length || dispatching.current) return;
    const next = queue[0];
    void dispatch(next.text, next.attachments).then(ok => { if (ok) setQueue(old => old.filter(item => item.id !== next.id)); });
    // Queue changes drive dispatch. Model/effort changes apply to the next turn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, busy, queueHeld, queue, requests.length]);
  const send = async (text: string) => {
    if ((!text.trim() && !attachments.length) || !ready || switching) return;
    setError('');
    try {
      if (text.startsWith('/')) { const revision = draftRevision.current; const [name, ...args] = text.slice(1).split(/\s+/); await command(name, args.join(' ')); if (draftRevision.current === revision) setPrompt(''); return; }
      if (busy || queue.length) {
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
  const closeArtifacts = () => { setDrawer(false); artifactButton.current?.focus(); };
  return <section className="aya-pane aya-conversation" style={{ ...paneStyle, ...(hidden ? { display: 'none' } : {}) }} onKeyDown={e => { if (e.key === 'Escape' && !e.defaultPrevented) { if (history !== null) { setHistory(null); composer.current?.focus(); } else if (suggestion) setSuggestion(''); else { closeArtifacts(); setSide(''); } } }}>
    <header><div><strong>Conversation</strong><small>{model} · <span>Experimental</span></small></div><span role="status">{switching ? 'Switching conversation…' : busy ? `${agentLabel} is working…` : ready ? 'Ready' : 'Disconnected'}</span><button disabled={!ready || switching} title="Resume a saved conversation" onClick={() => void openHistory().catch(fail)}><span className="aya-gui-icon" aria-hidden="true">history</span></button><button ref={artifactButton} aria-expanded={drawer} onClick={() => setDrawer(!drawer)}>Artifacts {artifacts.length > 0 && <b>{artifacts.length}</b>}</button></header>
    {history !== null && <div className="aya-session-picker" role="dialog" aria-label="Resume conversation" onKeyDown={e => {
      if (e.key === 'Escape') { e.preventDefault(); setHistory(null); composer.current?.focus(); }
      if (e.key === 'Tab') { const nodes = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input')); const first = nodes[0], last = nodes[nodes.length - 1]; if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); } }
    }}>
      <div><strong>Resume conversation</strong><button aria-label="Close conversation picker" onClick={() => { setHistory(null); composer.current?.focus(); }}>×</button></div>
      <input autoFocus aria-label="Search conversations" placeholder="Search saved conversations…" value={historyQuery} onChange={e => setHistoryQuery(e.target.value)} />
      <small>This project and account · Aya history{guiAgent === 'codex' ? ' and Codex history' : ''}. Drafts and artifacts saved in Aya are kept.</small>
      <div className="aya-session-list">{historyLoading ? <p role="status">Loading conversations…</p> : history.filter(row => row.title.toLowerCase().includes(historyQuery.toLowerCase())).map(row => <button key={row.id} disabled={row.current || busy || switching || requests.length > 0} onClick={() => void switchConversation(row.id).catch(fail)}><span>{row.title}</span><small>{row.current ? 'Current conversation' : new Date(row.updatedAt).toLocaleString()}</small></button>)}{!historyLoading && !history.some(row => row.title.toLowerCase().includes(historyQuery.toLowerCase())) && <p>No saved conversations match.</p>}</div>
      <button disabled={busy || switching || requests.length > 0} onClick={() => void switchConversation().catch(fail)}>New conversation</button>
      {busy && <small>Stop the current turn before switching.</small>}
    </div>}
    {importNotice && <div className="aya-gui-import-notice" role="status">{importNotice}<button aria-label="Dismiss history notice" onClick={() => setImportNotice('')}>×</button></div>}
    {goalDetails && <div className="aya-gui-goal" data-status={goalDetails.status}><strong>Goal</strong><span className="aya-gui-goal-objective" title={goalDetails.objective}>{goalDetails.objective}</span><span className="aya-gui-goal-status" role="status" aria-label="Goal status">{({ active: 'Active', paused: 'Paused', blocked: 'Blocked', complete: 'Complete', usageLimited: 'Usage limit', budgetLimited: 'Budget limit' } as Record<string, string>)[goalDetails.status] || goalDetails.status}</span>
      {goalDetails.status !== 'complete' && <button className="aya-gui-icon-button" disabled={goalPending} aria-label={goalDetails.status === 'active' ? 'Pause goal' : 'Resume goal'} title={goalDetails.status === 'active' ? 'Pause goal' : 'Resume goal'} onClick={() => void command('goal', goalDetails.status === 'active' ? 'pause' : 'resume').catch(fail)}><span className="aya-gui-icon" aria-hidden="true">{goalDetails.status === 'active' ? 'pause' : 'play_arrow'}</span></button>}
      <button className="aya-gui-icon-button" disabled={goalPending} aria-label="Clear goal" title="Clear goal" onClick={() => void command('goal', 'clear').catch(fail)}><span className="aya-gui-icon" aria-hidden="true">close</span></button>
    </div>}
    <div className="aya-gui-body"><main><div className="aya-gui-messages" aria-label={`Conversation with ${agentLabel}`} onScroll={e => { const node = e.currentTarget; follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80; setShowJump(!follow.current); }}>
      {!messages.length && <div className="aya-gui-welcome"><h1>Your {agentLabel}, with room to show more.</h1><p>Ask a question, inspect your project, or request a table or image.</p><p>Artifacts stay one click away.</p></div>}
      {messages.map(m => m.type === 'progress' && m.progress ? m.progress.status === 'running' ? null : <TaskProgress key={m.id} progress={m.progress} /> : m.type === 'goal' ? <article className="aya-gui-goal-message" key={m.id} aria-label={m.title}><span aria-hidden="true">◎</span><div><strong>{m.title}</strong><p>{m.text}</p></div></article> : <article key={m.id} className={m.type}><small>{m.type === 'user' ? `YOU${m.delivery === 'sending' ? ' · Sending…' : m.delivery === 'failed' ? ' · Not sent' : m.delivery === 'unconfirmed' ? ' · Delivery unconfirmed' : ''}` : agentBadge}</small><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ img: ({ src, alt }) => <WorkspaceImage path={String(src || '')} alt={alt || 'Image'} load={path => invoke('image', path)} />, a: ({ children }) => <span>{children}</span> }}>{m.text}</ReactMarkdown></article>)}
      {requests.map(request => <GuiRequest key={request.id} request={request} agentLabel={agentLabel} respond={value => invoke('respond', { id: request.id, value }).catch(fail)} />)}
      {activities.length > 0 && <details className="aya-gui-activity"><summary><span className="aya-gui-turn-dot" />{busy ? [...activities].reverse().find(a => a.status === 'inProgress')?.label || 'Finishing up' : `${activities.length} ${activities.length === 1 ? 'action' : 'actions'}`}<small>Details</small></summary>{activities.map(a => <details key={a.id}><summary>{a.status === 'inProgress' ? '◌' : a.status === 'failed' || a.status === 'declined' ? '!' : a.status === 'interrupted' ? '■' : '✓'} {a.label}</summary>{a.output && <pre>{a.output}</pre>}</details>)}</details>}
      {(messages.length > 0 || busy || turnOutcome) && <div className="aya-gui-turn-status" role="status" aria-label="Turn status" data-working={busy && requests.length === 0}>
        <span className="aya-gui-turn-dot" aria-hidden="true" />
        {!ready ? 'Disconnected' : requests.length ? 'Waiting for your response' : busy ? `${agentLabel} is working…` : turnOutcome === 'interrupted' ? 'Interrupted' : turnOutcome === 'failed' ? 'Turn failed' : turnOutcome === 'complete' ? 'Turn complete' : 'Ready'}
      </div>}
      <div ref={end} />
    </div>
    {showJump && <button className="aya-gui-jump" onClick={() => { follow.current = true; setShowJump(false); end.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }); }}>Jump to latest ↓</button>}
    {side && <aside className="aya-gui-side"><button aria-label="Close side question" onClick={() => setSide('')}>×</button><strong>Side question</strong><ReactMarkdown remarkPlugins={[remarkGfm]}>{side}</ReactMarkdown></aside>}
    <form onSubmit={e => { e.preventDefault(); void send(prompt); }}>
      {messages.filter(m => m.progress?.status === 'running').slice(-3).map(m => <TaskProgress key={m.id} progress={m.progress!} compact />)}
      {plan.length > 0 && <details className="aya-gui-plan"><summary>Plan <small>{plan.filter(p => p.status === 'completed').length}/{plan.length}</small></summary><ol>{plan.map((step, i) => <li key={i} data-state={step.status}>{step.status === 'completed' ? '✓' : step.status === 'inProgress' ? '◌' : '○'} {step.step}</li>)}</ol></details>}
      {queue.length > 0 && <div className="aya-gui-queue"><div><strong>{queueHeld ? 'Queue paused' : 'Up next'} <small>{queue.length}</small></strong>{queueHeld && <button type="button" disabled={busy} onClick={() => setQueueHeld(false)}>Resume queue</button>}</div>{queue.map((item, index) => <div className="aya-gui-queued" key={item.id}><textarea aria-label={`Queued message ${index + 1}`} value={item.text} onChange={e => setQueue(old => old.map(q => q.id === item.id ? { ...q, text: e.target.value } : q))} /><div>{item.attachments.length > 0 && <small>{item.attachments.map(a => a.name).join(', ')}</small>}{busy && !item.attachments.length && <button type="button" disabled={!item.text.trim()} title="Send into the running turn" onClick={() => void steer(item.text, item.id)}>Steer ↗</button>}{index > 0 && <button type="button" aria-label={`Move queued message ${index + 1} up`} onClick={() => setQueue(old => { const next = [...old]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; return next; })}>↑</button>}<button type="button" aria-label={`Remove queued message ${index + 1}`} onClick={() => setQueue(old => old.filter(q => q.id !== item.id))}>×</button></div></div>)}</div>}
      {suggestion && <div className="aya-widget-suggestion"><div><small>FROM ARTIFACT</small><p>{suggestion}</p></div><button type="button" onClick={() => { setPrompt(old => old ? `${old}\n\n${suggestion}` : suggestion); setSuggestion(''); composer.current?.focus(); }}>Add to message</button><button type="button" aria-label="Dismiss suggestion" onClick={() => setSuggestion('')}>×</button></div>}
      {error && <p role="alert" className="aya-gui-error">{error}</p>}
      {prompt.startsWith('/') && <div className="aya-gui-commands">{['resume', 'new', 'help', 'model', 'status', 'goal', 'btw', 'compact'].filter(name => name.startsWith(prompt.slice(1).split(/\s/)[0])).map(name => <button type="button" key={name} onClick={() => setPrompt('/' + name + ' ')}>/{name}</button>)}<small>/btw requires a completed turn in this experimental version.</small></div>}
      {attachments.length > 0 && <div className="aya-gui-attachments">{attachments.map(a => <span key={a.id} title={a.path}>📎 {a.name}<button type="button" aria-label={`Remove ${a.name}`} onClick={() => setAttachments(old => old.filter(f => f.id !== a.id))}>×</button></span>)}</div>}
      <textarea ref={composer} aria-label={`Message ${agentLabel}`} placeholder={`Message ${agentLabel}… (/ for commands)`} value={prompt} onChange={e => setPrompt(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(prompt); } }} />
      <div className="aya-gui-compose-footer"><button type="button" title="Attach files or images" aria-label="Attach files" disabled={!ready} onClick={() => void invoke('pick-attachments').then(files => setAttachments(old => [...old, ...(files as Attachment[])].slice(0, 20))).catch(fail)}>＋</button>
      {models.length > 0 && <><select aria-label="Model for next turn" title="Model · applies to the next turn" value={selectedModel || model} onChange={e => { setSelectedModel(e.target.value); setEffort(''); }}><option value={model}>{model}</option>{models.filter(m => m.model !== model).map(m => <option key={m.id} value={m.model}>{m.displayName}</option>)}</select>{(models.find(m => m.model === (selectedModel || model))?.supportedReasoningEfforts.length || 0) > 0 && <select aria-label="Reasoning effort" title="Reasoning effort · applies to the next turn" value={effort} onChange={e => setEffort(e.target.value)}><option value="">Default effort</option>{models.find(m => m.model === (selectedModel || model))?.supportedReasoningEfforts.map(e => <option key={e.reasoningEffort} value={e.reasoningEffort}>{e.reasoningEffort}</option>)}</select>}</>}
      <span className="aya-gui-compose-spacer" /><small className="aya-gui-enter-hint">Shift+Enter for a new line</small>{busy && <><button type="button" className="aya-gui-stop" onClick={() => { setQueueHeld(true); void invoke('interrupt').catch(fail); }}>Stop</button>{prompt.trim() && !prompt.startsWith('/') && !attachments.length && <button type="button" onClick={() => void steer(prompt)}>Steer ↗</button>}</>}<button className="aya-gui-send" disabled={!ready || (!prompt.trim() && !attachments.length)}>{busy && !prompt.startsWith('/') ? 'Queue ↑' : 'Send ↑'}</button></div>
    </form></main>
    {drawer && <ArtifactPanel artifacts={artifacts} selected={selected} history={artifactHistory} onSelect={setSelected} onSuggest={setSuggestion} onSave={(id, revision) => invoke('save-artifact', { id, revision })} onOpen={(id, revision) => invoke('open-artifact', { id, revision })} onBrowser={(id, revision) => invoke('open-artifact-browser', { id, revision })} />}
    </div>
  </section>;
}
function TaskProgress({ progress, compact = false }: { progress: GuiProgress; compact?: boolean }) {
  const percent = Math.round(progress.current / progress.total * 100);
  const label = ({ running: 'In progress', complete: 'Complete', paused: 'Paused', failed: 'Stopped' })[progress.status];
  return <div className={`aya-task-progress ${compact ? 'aya-task-progress--compact' : ''}`} data-status={progress.status}>
    <div className="aya-task-progress-heading"><strong>{progress.label}</strong><span>{progress.current.toLocaleString()} / {progress.total.toLocaleString()}<small>{label}</small></span></div>
    <div className="aya-task-progress-track" role="progressbar" aria-label={progress.label} aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.current} aria-valuetext={`${progress.current} of ${progress.total} · ${label}`}><span style={{ width: `${percent}%` }} /></div>
    {progress.detail && <p>{progress.detail}</p>}
  </div>;
}
function WorkspaceImage({ path, alt, load }: { path: string; alt: string; load: (path: string) => Promise<unknown> }) {
  const [src, setSrc] = useState(''); const [error, setError] = useState(''); const [attempt, setAttempt] = useState(0);
  useEffect(() => { let active = true; setError(''); void load(path).then(value => { if (active) setSrc(String(value)); }, e => { if (active) setError(String(e)); }); return () => { active = false; }; /* stable path identifies image */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, attempt]);
  return src ? <img src={src} alt={alt} /> : <span role={error ? 'alert' : 'status'}>{error ? `Cannot display ${path}: ${error}` : 'Loading image…'}{error && <button onClick={() => setAttempt(attempt + 1)}>Retry</button>}</span>;
}
function GuiRequest({ request, agentLabel, respond }: { request: GuiEvent; agentLabel: string; respond: (value: unknown) => Promise<unknown> }) {
  const questions = Array.isArray(request.params.questions) ? request.params.questions.map(obj) : [];
  const [answers, setAnswers] = useState<Record<string, string>>({}); const [sending, setSending] = useState(false);
  const submit = async (value: unknown) => { setSending(true); try { await respond(value); } finally { setSending(false); } };
  return <section className="aya-gui-request"><strong>{questions.length ? `${agentLabel} has a question` : 'Approval required'}</strong>{questions.length ? questions.map(q => <label key={str(q.id)}>{str(q.question)}<input type={q.isSecret ? 'password' : 'text'} value={answers[str(q.id)] || ''} onChange={e => setAnswers(old => ({ ...old, [str(q.id)]: e.target.value }))} />{Array.isArray(q.options) && q.options.map(obj).map(o => <button key={str(o.label)} onClick={() => setAnswers(old => ({ ...old, [str(q.id)]: str(o.label) }))}>{str(o.label)}</button>)}</label>) : <pre>{str(request.params.command) || str(request.params.reason) || JSON.stringify(request.params, null, 2)}</pre>}{questions.length ? <button disabled={sending || questions.some(q => !answers[str(q.id)]?.trim())} onClick={() => void submit({ answers })}>Send answer</button> : <><button disabled={sending} onClick={() => void submit({ decision: 'accept' })}>Allow once</button><button disabled={sending} onClick={() => void submit({ decision: 'decline' })}>Decline</button></>}</section>;
}
