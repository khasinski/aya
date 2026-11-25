import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import type { GuiEvent } from '../../shared/codex-gui';
import { assistSupported, contextMeterText, contextUsageFromParams, filterSkills, insertSkill, parseSuggestionsPreference, skillQueryAt, type GuiAssistAgent, type GuiContextUsage, type GuiSkill, type SkillQuery } from '../gui-composer-assist';
import { GUI_PROMPT_SUGGESTIONS_STORAGE_KEY } from '../storage-keys';

/** The suggested next prompt, the context meter and the skills picker of one conversation pane. */
export function useComposerAssist({ agent, ready, prompt, setPrompt, composer, invoke, commands }: {
  agent: GuiAssistAgent;
  ready: boolean;
  prompt: string;
  setPrompt: (value: string) => void;
  composer: RefObject<HTMLTextAreaElement | null>;
  invoke: (action: string, value?: unknown) => Promise<unknown>;
  commands: { name: string }[];
}) {
  const supported = assistSupported(agent);
  const [suggestionsOn, setSuggestionsOnValue] = useState(() => { try { return parseSuggestionsPreference(localStorage.getItem(GUI_PROMPT_SUGGESTIONS_STORAGE_KEY)); } catch { return true; } });
  const suggestionsRef = useRef(suggestionsOn);
  const [nextPrompt, setNextPrompt] = useState('');
  const [usage, setUsage] = useState<GuiContextUsage | null>(null);
  const [skills, setSkills] = useState<GuiSkill[]>([]);
  const [skillsRevision, setSkillsRevision] = useState(0);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const promptRef = useRef(prompt);
  promptRef.current = prompt;
  const invokeRef = useRef(invoke);
  invokeRef.current = invoke;
  // Typing hides the suggestion until the next turn ends.
  useEffect(() => { if (prompt) setNextPrompt(''); }, [prompt]);
  // A replaced value (fill, recall, a snippet) moves the caret without a select event.
  useEffect(() => { const el = composer.current; setCaret(el && el.value === prompt ? el.selectionStart : prompt.length); }, [prompt, composer]);
  useEffect(() => {
    if (!ready || !supported) return;
    let live = true;
    void invokeRef.current('skills').then(list => { if (live && Array.isArray(list)) setSkills(list as GuiSkill[]); }).catch(() => {});
    return () => { live = false; };
  }, [ready, supported, skillsRevision]);
  const handleEvent = useCallback((event: GuiEvent) => {
    const p = event.params;
    if (event.method === 'aya/promptSuggestion' && typeof p.text === 'string' && suggestionsRef.current && !promptRef.current) setNextPrompt(p.text);
    if (event.method === 'aya/contextUsage') { const next = contextUsageFromParams(p); if (next) setUsage(next); }
    if (event.method === 'aya/skillsChanged') setSkillsRevision(n => n + 1);
    if (event.method === 'turn/started' || event.method === 'aya/disconnected' || event.method === 'aya/sessionEpoch') setNextPrompt('');
  }, []);
  const setSuggestionsOn = (value: boolean) => {
    suggestionsRef.current = value; setSuggestionsOnValue(value);
    if (!value) setNextPrompt('');
    try { localStorage.setItem(GUI_PROMPT_SUGGESTIONS_STORAGE_KEY, value ? '1' : '0'); } catch { /* the choice lasts until reload */ }
    if (ready) void invokeRef.current('prompt-suggestions', value).catch(() => {});
  };
  const place = (next: { prompt: string; caret: number }) => {
    setPrompt(next.prompt); setCaret(next.caret); setActive(0);
    requestAnimationFrame(() => { composer.current?.focus(); composer.current?.setSelectionRange(next.caret, next.caret); });
  };
  const at = Math.min(caret, prompt.length);
  const query: SkillQuery | null = supported && dismissed !== prompt ? skillQueryAt(prompt, at) : null;
  const matches = query ? filterSkills(skills, query.query) : [];
  const slashToken = prompt.startsWith('/') && !/\s/.test(prompt.slice(1)) ? prompt.slice(1) : null;
  const slashSkills = supported && prompt.startsWith('/') ? filterSkills(skills, prompt.slice(1).split(/\s/)[0], 6, true) : [];
  const pick = (skill: GuiSkill, from: SkillQuery | null = query) => place(insertSkill(agent, prompt, from, skill.name));
  const pickSlash = (skill: GuiSkill) => pick(skill, { start: 0, end: 1 + prompt.slice(1).split(/\s/)[0].length, query: '' });
  const showSuggestion = supported && suggestionsOn && !!nextPrompt && !prompt;
  /** Returns true when the key was the picker's or the suggestion's. */
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (e.nativeEvent.isComposing || e.altKey || e.metaKey || e.ctrlKey) return false;
    if (query && matches.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setActive(i => (i + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length); return true; }
      if ((e.key === 'Tab' || e.key === 'Enter') && !e.shiftKey) { e.preventDefault(); pick(matches[Math.min(active, matches.length - 1)]); return true; }
      if (e.key === 'Escape') { e.preventDefault(); setDismissed(prompt); return true; }
    }
    if (e.key === 'Tab' && !e.shiftKey && slashToken !== null && slashSkills.length && !commands.some(command => command.name.startsWith(slashToken))) { e.preventDefault(); pickSlash(slashSkills[0]); return true; }
    if (e.key === 'Tab' && !e.shiftKey && showSuggestion) { e.preventDefault(); place({ prompt: nextPrompt, caret: nextPrompt.length }); return true; }
    return false;
  };
  const sigil = agent === 'claude' ? '/' : '$';
  const menu = query && (matches.length || !query.query) ? <div className="aya-gui-skills" role="listbox" aria-label="Skills">
    {matches.length ? matches.map((skill, index) => <button type="button" role="option" aria-selected={index === Math.min(active, matches.length - 1)} key={skill.name} title={skill.description} onMouseDown={e => e.preventDefault()} onClick={() => pick(skill)}><b>{sigil}{skill.name}</b>{skill.argumentHint && <i> {skill.argumentHint}</i>}<small>{skill.description}</small></button>)
      : <small className="aya-gui-skills-empty">{skills.length ? 'No matching skill.' : 'No skills found for this agent.'}</small>}
  </div> : null;
  const slashMenuItems = slashSkills.map(skill => <button type="button" key={`skill:${skill.name}`} className="aya-gui-skill-command" title={skill.description} onClick={() => pickSlash(skill)}>{sigil}{skill.name}<small> skill</small></button>);
  return {
    supported, suggestionsOn, setSuggestionsOn, nextPrompt: showSuggestion ? nextPrompt : '', usage, skills, handleEvent, onKeyDown,
    onCaret: (value: number) => setCaret(value),
    placeholder: (fallback: string) => showSuggestion ? nextPrompt : fallback,
    menu, slashMenuItems,
  };
}

export function ContextMeter({ usage }: { usage: GuiContextUsage | null }) {
  if (!usage) return null;
  const { label, title, percent } = contextMeterText(usage);
  return <span className="aya-gui-context-meter" role={percent === null ? 'status' : 'meter'} aria-label="Context window used" aria-valuemin={percent === null ? undefined : 0} aria-valuemax={percent === null ? undefined : 100} aria-valuenow={percent ?? undefined} title={title} data-level={percent === null ? undefined : percent >= 90 ? 'high' : percent >= 70 ? 'warn' : 'ok'}>
    {percent !== null && <span className="aya-gui-context-meter-bar" aria-hidden="true"><span style={{ width: `${percent}%` }} /></span>}
    <span className="aya-gui-context-meter-label">{label}</span>
  </span>;
}
