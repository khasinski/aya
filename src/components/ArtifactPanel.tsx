import { artifactSearchText, normalizeArtifactSearch } from '../../shared/gui-artifact-search.cjs';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { GuiArtifact, GuiArtifactEntry } from '../../shared/codex-gui';

const normalizeSearch = normalizeArtifactSearch;

export function ArtifactPanel({ artifacts, selected, history, seenRevisions, visible, onViewed, onPreview, onLoad, onSearch, onSelect, onSuggest, onSave, onOpen, onBrowser }: {
  onSearch: (query: string) => Promise<string[]>;
  onLoad: (id: string, revision?: number) => Promise<GuiArtifact>;
  artifacts: GuiArtifactEntry[]; selected: string; history: Record<string, GuiArtifactEntry[]>;
  seenRevisions: Record<string, number>; visible: boolean; onViewed: (id: string, revision: number) => void; onPreview: (id: string, revision?: number) => Promise<unknown>;
  onSelect: (id: string) => void; onSuggest: (text: string) => void; onSave: (id: string, revision?: number) => Promise<unknown>; onOpen: (id: string, revision?: number) => Promise<unknown>; onBrowser: (id: string, revision?: number) => Promise<unknown>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [versionByArtifact, setVersionByArtifact] = useState<Record<string, string>>({});
  const artifact = artifacts.find(a => a.id === selected) || artifacts[0];
  const index = artifacts.findIndex(a => a.id === artifact?.id);
  return <aside className={`aya-gui-artifacts ${expanded ? 'aya-gui-artifacts--expanded' : ''}`} aria-label="Artifacts" onKeyDown={e => {
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); const next = artifacts[index + (e.key === 'ArrowLeft' ? -1 : 1)]; if (next) onSelect(next.id); }
    if (e.key === 'Escape' && expanded) { e.preventDefault(); e.stopPropagation(); setExpanded(false); }
  }}>
    {!artifacts.length ? <div className="aya-artifact-empty"><h3>No artifacts yet</h3><p>Tables, images and widgets created in this conversation will appear here.</p></div> : <>
      <div className="aya-artifact-navigation"><button aria-label="Previous artifact" title="Previous · Alt+←" disabled={index <= 0} onClick={() => onSelect(artifacts[index - 1].id)}>←</button><span role="status" aria-label="Artifact position">{index + 1} of {artifacts.length}</span><button aria-label="Next artifact" title="Next · Alt+→" disabled={index < 0 || index >= artifacts.length - 1} onClick={() => onSelect(artifacts[index + 1].id)}>→</button><button className="aya-artifact-expand" title={expanded ? 'Return to conversation' : 'Expand preview'} aria-label={expanded ? 'Reduce artifacts' : 'Expand artifacts'} aria-pressed={expanded} onClick={() => setExpanded(!expanded)}><span className="aya-gui-icon" aria-hidden="true">{expanded ? 'close_fullscreen' : 'open_in_full'}</span></button></div>
      <ArtifactPicker onSearch={onSearch} artifacts={artifacts} selected={artifact?.id || ''} seenRevisions={seenRevisions} onSelect={onSelect} />
      {artifact && <ArtifactContent key={artifact.id} artifact={artifact} versions={history[artifact.id] || [artifact]} version={versionByArtifact[artifact.id] || 'latest'} onVersion={version => setVersionByArtifact(old => ({ ...old, [artifact.id]: version }))} visible={visible} onViewed={onViewed} onPreview={onPreview} onLoad={onLoad} onSuggest={onSuggest} onSave={onSave} onOpen={onOpen} onBrowser={onBrowser} />}
    </>}
  </aside>;
}

function ArtifactPicker({ artifacts, selected, seenRevisions, onSelect, onSearch }: { onSearch: (query: string) => Promise<string[]>; artifacts: GuiArtifactEntry[]; selected: string; seenRevisions: Record<string, number>; onSelect: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const listId = useId();
  const searchable = useMemo(() => artifacts.map(artifact => ({ artifact, text: 'deferred' in artifact ? normalizeSearch(artifact.title) : artifactSearchText(artifact) })), [artifacts]);
  const [matches, setMatches] = useState<{ query: string; ids: string[] } | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [selectQuery, setSelectQuery] = useState<string | null>(null);
  useEffect(() => {
    if (!open || !query.trim() || !artifacts.some(artifact => 'deferred' in artifact)) { setSearching(false); return; }
    let current = true; setSearching(true); setSearchError(false);
    const timer = setTimeout(() => {
      void onSearch(query).then(ids => { if (current) setMatches({ query, ids }); }, () => { if (current) setSearchError(true); }).finally(() => { if (current) setSearching(false); });
    }, 150);
    return () => { current = false; clearTimeout(timer); void onSearch('').catch(() => {}); };
  }, [open, query, artifacts, onSearch]);
  const tokens = normalizeSearch(query).trim().split(/\s+/).filter(Boolean);
  const remoteMatches = new Set(matches?.query === query ? matches.ids : []);
  const filtered = searchable.filter(item => tokens.every(token => item.text.includes(token)) || remoteMatches.has(item.artifact.id)).map(item => item.artifact);
  useEffect(() => {
    if (selectQuery === null || selectQuery !== query || matches?.query !== query || searching) return;
    setSelectQuery(null);
    const chosen = filtered[active];
    if (chosen) { onSelect(chosen.id); setOpen(false); setQuery(''); setActive(0); trigger.current?.focus(); }
  }, [selectQuery, query, matches, searching, filtered, active, onSelect]);
  const close = () => { setSelectQuery(null); setOpen(false); setQuery(''); setActive(0); };
  const choose = (id: string) => { onSelect(id); close(); trigger.current?.focus(); };
  useEffect(() => { if (open) search.current?.focus(); }, [open]);
  useEffect(() => {
    if (!open) return;
    const row = root.current?.querySelector<HTMLElement>('[data-active="true"]');
    const list = row?.parentElement;
    if (!row || !list) return;
    if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
  }, [open, active, query]);
  return <div className="aya-artifact-picker" ref={root} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) close(); }} onKeyDown={e => {
    if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); close(); trigger.current?.focus(); }
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && open) { e.preventDefault(); setActive(old => Math.max(0, Math.min(filtered.length - 1, old + (e.key === 'ArrowDown' ? 1 : -1)))); }
    if (e.key === 'Enter' && open && e.target === search.current) { e.preventDefault(); if (query.trim() && artifacts.some(artifact => 'deferred' in artifact) && (searching || matches?.query !== query)) setSelectQuery(query); else if (filtered[active]) choose(filtered[active].id); }
  }}>
    <button ref={trigger} type="button" role="combobox" aria-label="Selected artifact" aria-expanded={open} aria-haspopup="listbox" aria-controls={open ? listId : undefined} onClick={() => { if (open) close(); else { setActive(0); setOpen(true); } }} onKeyDown={e => { if (e.key === 'ArrowDown' && !open) { e.preventDefault(); setOpen(true); } }}><span>{artifacts.find(a => a.id === selected)?.title || 'Choose an artifact'}</span><span aria-hidden="true">⌄</span></button>
    {open && <div className="aya-artifact-picker-menu">
      <div className="aya-artifact-search"><input ref={search} type="search" aria-controls={listId} aria-activedescendant={filtered[active] ? `${listId}-${active}` : undefined} aria-label="Search artifacts" placeholder="Search artifacts…" value={query} onChange={e => { setSelectQuery(null); setQuery(e.target.value); setActive(0); }} />{query && <button type="button" aria-label="Clear artifact search" onClick={() => { setQuery(''); setActive(0); search.current?.focus(); }}>×</button>}</div>
      <div id={listId} role="listbox" aria-label="Artifacts" className="aya-artifact-options">{filtered.map((a, i) => {
        const unread = (seenRevisions[a.id] || 0) < (a.revision || 1);
        return <button type="button" role="option" id={`${listId}-${i}`} aria-selected={a.id === selected} data-active={i === active} className={unread ? 'aya-artifact-unread' : ''} key={a.id} onMouseEnter={() => setActive(i)} onClick={() => choose(a.id)}><span>{a.title}</span>{unread && <small>New</small>}{a.id === selected && <span aria-hidden="true">✓</span>}</button>;
      })}</div>
      {searching && <div role="status">Searching artifact contents…</div>}
      {searchError && <div role="alert">Could not search artifact contents. Change the search to retry.</div>}
      {!filtered.length && !searching && <div className="aya-artifact-no-matches">No matching artifacts</div>}
    </div>}
  </div>;
}
function ArtifactContent({ artifact, versions, version, onVersion, visible, onViewed, onPreview, onLoad, onSuggest, onSave, onOpen, onBrowser }: { artifact: GuiArtifactEntry; onLoad: (id: string, revision?: number) => Promise<GuiArtifact>; versions: GuiArtifactEntry[]; version: string; onVersion: (value: string) => void; visible: boolean; onViewed: (id: string, revision: number) => void; onPreview: (id: string, revision?: number) => Promise<unknown>; onSuggest: (text: string) => void; onSave: (id: string, revision?: number) => Promise<unknown>; onOpen: (id: string, revision?: number) => Promise<unknown>; onBrowser: (id: string, revision?: number) => Promise<unknown> }) {
  const [source, setSource] = useState(false);
  const [filter, setFilter] = useState('');
  const [saveStatus, setSaveStatus] = useState('');
  const entry = version === 'latest' ? artifact : versions.find(v => String(v.revision) === version) || artifact;
  const contentKey = `${entry.id}:${entry.revision || 1}:${'deferred' in entry ? entry.$ayaArtifact : 'live'}`;
  const [content, setContent] = useState<{ key: string; artifact: GuiArtifact } | null>(null);
  const [loadError, setLoadError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const a = 'deferred' in entry ? content?.key === contentKey ? content.artifact : null : entry;
  useEffect(() => {
    if (!('deferred' in entry) || !visible) return;
    let current = true; setLoadError('');
    void onLoad(entry.id, entry.revision).then(artifact => { if (current) setContent({ key: contentKey, artifact }); }, error => { if (current) setLoadError(error instanceof Error ? error.message : String(error)); });
    return () => { current = false; };
  }, [entry, contentKey, visible, loadAttempt, onLoad]);
  useEffect(() => { if (visible && a) onViewed(a.id, a.revision || 1); }, [visible, a, onViewed]);
  useEffect(() => { if (saveStatus !== 'Saved') return; const timer = setTimeout(() => setSaveStatus(''), 2500); return () => clearTimeout(timer); }, [saveStatus]);
  const save = async () => { if (!a) return; setSaveStatus(''); try { if (await onSave(a.id, a.revision)) setSaveStatus('Saved'); } catch { setSaveStatus('Could not save. Try again.'); } };
  if (!a) return <div className="aya-artifact-content"><h3>{entry.title}</h3>{loadError ? <div role="alert">{loadError}<button onClick={() => setLoadAttempt(attempt => attempt + 1)}>Retry loading artifact</button></div> : <p role="status">Loading artifact…</p>}</div>;
  const matchingRows = a.kind === 'table' ? a.rows.filter(row => row.join(' ').toLowerCase().includes(filter.toLowerCase())) : [];
  return <div className="aya-artifact-content">
    <div className="aya-artifact-caption"><div><small>{a.kind === 'html' ? 'INTERACTIVE WIDGET' : a.kind === 'image' ? 'GRAPHIC' : a.kind.toUpperCase()}</small><h3>{a.title}</h3></div><span className="aya-artifact-revision" key={artifact.revision}>v{a.revision || 1}</span></div>
    <div className="aya-artifact-toolbar">
      {a.kind === 'html' && <div className="aya-artifact-segments"><button aria-pressed={!source} onClick={() => setSource(false)}>Preview</button><button aria-pressed={source} onClick={() => setSource(true)}>Source</button></div>}
      {versions.length > 1 && <select aria-label="Artifact version" value={version} onChange={e => onVersion(e.target.value)}><option value="latest">Latest · v{artifact.revision}</option>{versions.slice(0, -1).reverse().map(v => <option key={v.revision} value={String(v.revision)}>Version {v.revision}</option>)}</select>}
      {(a.kind === 'html' || a.kind === 'image') && <div className="aya-artifact-actions"><button title="Open this version in a new window" onClick={() => { setSaveStatus(''); void onOpen(a.id, a.revision).catch(() => setSaveStatus('Could not open preview. Try again.')); }}>Open window ↗</button><button title="Open in your system browser" onClick={() => { setSaveStatus(''); void onBrowser(a.id, a.revision).catch(() => setSaveStatus('Could not open browser. Try again.')); }}>Open in browser</button><button className="aya-artifact-save" onClick={() => void save()} title="Save this version to file">Save ↓</button></div>}
    </div>
    {saveStatus && <p role="status" className="aya-artifact-feedback">{saveStatus}</p>}
    {a.kind === 'html' ? source ? <pre className="aya-widget-source"><code>{a.html}</code></pre> : <HtmlWidget artifact={a} onSuggest={onSuggest} onPreview={onPreview} /> : a.kind === 'image' ? <Graphic artifact={a} /> : a.kind === 'metric' ? <div className="aya-artifact-metric"><strong>{a.value}</strong><p>{a.description}</p></div> : <>
      <input className="aya-artifact-filter" aria-label="Filter rows" placeholder="Filter rows…" value={filter} onChange={e => setFilter(e.target.value)} />
      <div className="aya-gui-table"><table><thead><tr>{a.columns.map((c, i) => <th key={i}>{c}</th>)}<th /></tr></thead><tbody>{matchingRows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}<td><button title="Prepare a message about this row. You can review and edit it before sending." onClick={() => onSuggest(`Discuss this row from “${a.title}”: ${a.columns.map((c, j) => `${c}: ${row[j]}`).join('; ')}`)} aria-label="Discuss row" className="aya-gui-icon-button"><span className="aya-gui-icon" aria-hidden="true">chat_bubble_outline</span></button></td></tr>)}{!matchingRows.length && <tr><td colSpan={a.columns.length + 1} role="status">{a.rows.length ? 'No matching rows' : 'No rows to display'}</td></tr>}</tbody></table></div>
    </>}
  </div>;
}
const PREVIEW_TIMEOUT_MESSAGE = "Preview did not finish loading. Reload it to try again.";
function HtmlWidget({ artifact, onSuggest, onPreview }: { artifact: Extract<GuiArtifact, { kind: 'html' }>; onSuggest: (text: string) => void; onPreview: (id: string, revision?: number) => Promise<unknown> }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [height, setHeight] = useState(360);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setLoaded(false); setError(''); setPreviewUrl('');
    void onPreview(artifact.id, artifact.revision).then(url => { if (active) setPreviewUrl(String(url)); }, () => { if (active) setError('Preview could not be loaded. Try again.'); });
    return () => { active = false; };
  }, [artifact.id, artifact.revision, attempt, onPreview]);
  useEffect(() => {
    if (!previewUrl) return;
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || !event.data || typeof event.data !== 'object') return;
      const { type, value } = event.data;
      if (type === 'aya:ready') { clearTimeout(timer); setLoaded(true); setError(previous => previous === PREVIEW_TIMEOUT_MESSAGE ? '' : previous); }
      if (type === 'aya:error') setError('This widget encountered an error. Ask Codex to fix it or inspect Source.');
      if (type === 'aya:height' && typeof value === 'number' && Number.isFinite(value)) setHeight(Math.max(280, Math.min(1200, value)));
      if (type === 'aya:suggest' && typeof value === 'string' && value.trim() && value.length <= 4000) onSuggest(value);
    };
    window.addEventListener('message', receive);
    const timer = setTimeout(() => { if (frame.current) setError(previous => previous || PREVIEW_TIMEOUT_MESSAGE); }, 5000);
    return () => { window.removeEventListener('message', receive); clearTimeout(timer); };
  }, [onSuggest, previewUrl, attempt]);
  return <div className="aya-widget-shell">
    {!loaded && !error && <div className="aya-widget-loading" role="status">Preparing preview<span>…</span></div>}
    {error && <div className="aya-widget-error" role="alert">{error}<button onClick={() => { setError(''); setLoaded(false); setAttempt(attempt + 1); }}>Reload preview</button></div>}
    {previewUrl && <iframe key={`${artifact.id}:${artifact.revision}:${previewUrl}:${attempt}`} ref={frame} title={artifact.title} src={previewUrl} sandbox="allow-scripts" allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'" referrerPolicy="no-referrer" style={{ height, visibility: loaded ? 'visible' : 'hidden' }} />}
    <div className="aya-widget-footnote">Interactive preview <span>·</span> Actions prepare a message for you to review</div>
  </div>;
}
function Graphic({ artifact }: { artifact: Extract<GuiArtifact, { kind: 'image' }> }) {
  const [zoom, setZoom] = useState(1);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [error, setError] = useState(false);
  return <div className="aya-graphic" onKeyDown={e => { if (e.key === '+' || e.key === '=') { e.preventDefault(); setZoom(z => Math.min(4, z + .25)); } if (e.key === '-') { e.preventDefault(); setZoom(z => Math.max(.25, z - .25)); } if (e.key === '0') setZoom(1); }}>
    <div className="aya-graphic-tools"><button aria-label="Zoom out" disabled={zoom <= .25} onClick={() => setZoom(z => Math.max(.25, z - .25))}>−</button><span>{Math.round(zoom * 100)}%</span><button aria-label="Zoom in" disabled={zoom >= 4} onClick={() => setZoom(z => Math.min(4, z + .25))}>+</button><button onClick={() => setZoom(1)} title="Fit · 0">Fit</button></div>
    <div className="aya-graphic-viewport" style={{ cursor: zoom > 1 ? 'grab' : 'default' }} onDoubleClick={() => setZoom(z => z === 1 ? 2 : 1)} onPointerDown={e => { if (zoom <= 1 || e.button !== 0) return; drag.current = { x: e.clientX, y: e.clientY, left: e.currentTarget.scrollLeft, top: e.currentTarget.scrollTop }; e.currentTarget.setPointerCapture(e.pointerId); e.currentTarget.style.cursor = 'grabbing'; }} onPointerMove={e => { if (!drag.current) return; e.currentTarget.scrollLeft = drag.current.left - (e.clientX - drag.current.x); e.currentTarget.scrollTop = drag.current.top - (e.clientY - drag.current.y); }} onPointerUp={e => { drag.current = null; e.currentTarget.style.cursor = zoom > 1 ? 'grab' : 'default'; }} onPointerCancel={() => { drag.current = null; }} tabIndex={0} aria-label="Graphic preview. Double-click or use plus and minus to zoom. Drag or use arrow keys to pan.">{error ? <p role="alert">This image could not be decoded.</p> : <img style={{ width: `${zoom * 100}%`, maxWidth: 'none', maxHeight: 'none' }} src={artifact.dataUrl} alt={artifact.title} onError={() => setError(true)} draggable={false} />}</div>
    <small className="aya-graphic-path" title={artifact.path}>{artifact.path}</small>
  </div>;
}
