import { useEffect, useMemo, useRef, useState } from 'react';
import type { GuiArtifact } from '../../shared/codex-gui';

export function ArtifactPanel({ artifacts, selected, history, onSelect, onSuggest, onSave, onOpen, onBrowser }: {
  artifacts: GuiArtifact[]; selected: string; history: Record<string, GuiArtifact[]>;
  onSelect: (id: string) => void; onSuggest: (text: string) => void; onSave: (id: string, revision?: number) => Promise<unknown>; onOpen: (id: string, revision?: number) => Promise<unknown>; onBrowser: (id: string, revision?: number) => Promise<unknown>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState('');
  const [versionByArtifact, setVersionByArtifact] = useState<Record<string, string>>({});
  const searchable = useMemo(() => artifacts.map(a => {
    const content = a.kind === 'html' ? a.html.replace(/<[^>]*>/g, ' ') : a.kind === 'table' ? a.columns.join(' ') + ' ' + a.rows.flat().join(' ') : a.kind === 'metric' ? a.value + ' ' + a.description : a.path;
    return { artifact: a, text: `${a.title} ${content}`.toLocaleLowerCase() };
  }), [artifacts]);
  const filtered = searchable.filter(item => item.text.includes(query.trim().toLocaleLowerCase())).map(item => item.artifact);
  const index = filtered.findIndex(a => a.id === selected);
  useEffect(() => { if (query && filtered.length && !filtered.some(a => a.id === selected)) onSelect(filtered[0].id); }, [query, filtered, selected, onSelect]);
  const artifact = artifacts.find(a => a.id === selected);
  return <aside className={`aya-gui-artifacts ${expanded ? 'aya-gui-artifacts--expanded' : ''}`} aria-label="Artifacts" onKeyDown={e => { if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); const next = filtered[index + (e.key === 'ArrowLeft' ? -1 : 1)]; if (next) onSelect(next.id); } if (e.key === 'Escape' && query) { e.preventDefault(); e.stopPropagation(); setQuery(''); } else if (e.key === 'Escape' && expanded) { e.preventDefault(); e.stopPropagation(); setExpanded(false); } }}>

    {!artifacts.length ? <div className="aya-artifact-empty"><span>◇</span><h3>Something worth showing.</h3><p>Widgets, graphics and tables will appear here as Codex creates them.</p></div> : <>
      <div className="aya-artifact-navigation"><button aria-label="Previous artifact" title="Previous · Alt+←" disabled={index <= 0} onClick={() => onSelect(filtered[index - 1].id)}>←</button><span role="status" aria-label="Artifact position">{filtered.length ? `${index + 1} of ${filtered.length}` : 'No matches'}</span><button aria-label="Next artifact" title="Next · Alt+→" disabled={index < 0 || index >= filtered.length - 1} onClick={() => onSelect(filtered[index + 1].id)}>→</button><button className="aya-artifact-expand" title={expanded ? 'Return to conversation' : 'Expand preview'} aria-label={expanded ? 'Reduce artifacts' : 'Expand artifacts'} aria-pressed={expanded} onClick={() => setExpanded(!expanded)}><span className="aya-gui-icon" aria-hidden="true">{expanded ? 'close_fullscreen' : 'open_in_full'}</span></button><div className="aya-artifact-search"><input type="search" aria-label="Search artifacts" placeholder="Search artifacts…" value={query} onChange={e => setQuery(e.target.value)} />{query && <button aria-label="Clear artifact search" onClick={() => setQuery('')}>×</button>}</div></div>
      {filtered.length ? <><label className="aya-artifact-picker"><span className="aya-sr-only">Selected artifact</span><select aria-label="Selected artifact" value={selected} onChange={e => onSelect(e.target.value)}>{filtered.map(a => <option key={a.id} value={a.id}>{a.title}</option>)}</select></label>{artifact && <ArtifactContent key={artifact.id} artifact={artifact} versions={history[artifact.id] || [artifact]} version={versionByArtifact[artifact.id] || 'latest'} onVersion={version => setVersionByArtifact(old => ({ ...old, [artifact.id]: version }))} onSuggest={onSuggest} onSave={onSave} onOpen={onOpen} onBrowser={onBrowser} />}</> : <div className="aya-artifact-empty"><h3>No matching artifacts</h3><p>Try a title, a phrase or a value from a table.</p><button onClick={() => setQuery('')}>Clear search</button></div>}
    </>}

  </aside>;
}
function ArtifactContent({ artifact, versions, version, onVersion, onSuggest, onSave, onOpen, onBrowser }: { artifact: GuiArtifact; versions: GuiArtifact[]; version: string; onVersion: (value: string) => void; onSuggest: (text: string) => void; onSave: (id: string, revision?: number) => Promise<unknown>; onOpen: (id: string, revision?: number) => Promise<unknown>; onBrowser: (id: string, revision?: number) => Promise<unknown> }) {
  const [source, setSource] = useState(false);
  const [filter, setFilter] = useState('');
  const [saveStatus, setSaveStatus] = useState('');
  const a = version === 'latest' ? artifact : versions.find(v => String(v.revision) === version) || artifact;
  useEffect(() => { if (!saveStatus) return; const timer = setTimeout(() => setSaveStatus(''), 2500); return () => clearTimeout(timer); }, [saveStatus]);
  const save = async () => { try { if (await onSave(a.id, a.revision)) setSaveStatus('Saved'); } catch { setSaveStatus('Could not save. Try again.'); } };
  return <div className="aya-artifact-content">
    <div className="aya-artifact-caption"><div><small>{a.kind === 'html' ? 'INTERACTIVE WIDGET' : a.kind === 'image' ? 'GRAPHIC' : a.kind.toUpperCase()}</small><h3>{a.title}</h3></div><span className="aya-artifact-revision" key={artifact.revision}>v{a.revision || 1}</span></div>
    <div className="aya-artifact-toolbar">
      {a.kind === 'html' && <div className="aya-artifact-segments"><button aria-pressed={!source} onClick={() => setSource(false)}>Preview</button><button aria-pressed={source} onClick={() => setSource(true)}>Source</button></div>}
      {versions.length > 1 && <select aria-label="Artifact version" value={version} onChange={e => onVersion(e.target.value)}><option value="latest">Latest · v{artifact.revision}</option>{versions.slice(0, -1).reverse().map(v => <option key={v.revision} value={String(v.revision)}>Version {v.revision}</option>)}</select>}
      {(a.kind === 'html' || a.kind === 'image') && <div className="aya-artifact-actions"><button title="Open this version in a new window" onClick={() => void onOpen(a.id, a.revision).catch(() => setSaveStatus('Could not open preview. Try again.'))}>Open window ↗</button><button title="Open in your system browser" onClick={() => void onBrowser(a.id, a.revision).catch(() => setSaveStatus('Could not open browser. Try again.'))}>Open in browser</button><button className="aya-artifact-save" onClick={() => void save()} title="Save this version to file">Save ↓</button></div>}
    </div>
    {saveStatus && <p role="status" className="aya-artifact-feedback">{saveStatus}</p>}
    {a.kind === 'html' ? source ? <pre className="aya-widget-source"><code>{a.html}</code></pre> : <HtmlWidget artifact={a} onSuggest={onSuggest} /> : a.kind === 'image' ? <Graphic artifact={a} /> : a.kind === 'metric' ? <div className="aya-artifact-metric"><strong>{a.value}</strong><p>{a.description}</p></div> : <>
      <input className="aya-artifact-filter" aria-label="Filter rows" placeholder="Filter rows…" value={filter} onChange={e => setFilter(e.target.value)} />
      <div className="aya-gui-table"><table><thead><tr>{a.columns.map((c, i) => <th key={i}>{c}</th>)}<th /></tr></thead><tbody>{a.rows.filter(row => row.join(' ').toLowerCase().includes(filter.toLowerCase())).map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}<td><button title="Prepare a follow-up about this row" onClick={() => onSuggest(`Discuss this row from “${a.title}”: ${a.columns.map((c, j) => `${c}: ${row[j]}`).join('; ')}`)} aria-label="Discuss row" className="aya-gui-icon-button"><span className="aya-gui-icon" aria-hidden="true">chat_bubble_outline</span></button></td></tr>)}</tbody></table></div>
    </>}
  </div>;
}
function HtmlWidget({ artifact, onSuggest }: { artifact: Extract<GuiArtifact, { kind: 'html' }>; onSuggest: (text: string) => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(360);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || !event.data || typeof event.data !== 'object') return;
      const { type, value } = event.data;
      if (type === 'aya:ready') setLoaded(true);
      if (type === 'aya:error') setError('This widget encountered an error. Ask Codex to fix it or inspect Source.');
      if (type === 'aya:height' && typeof value === 'number' && Number.isFinite(value)) setHeight(Math.max(280, Math.min(1200, value)));
      if (type === 'aya:suggest' && typeof value === 'string' && value.trim() && value.length <= 4000) onSuggest(value);
    };
    window.addEventListener('message', receive);
    const timer = setTimeout(() => { if (!frame.current) return; setLoaded(true); }, 5000);
    return () => { window.removeEventListener('message', receive); clearTimeout(timer); };
  }, [onSuggest, artifact.previewUrl, attempt]);
  return <div className="aya-widget-shell">
    {!loaded && <div className="aya-widget-loading" role="status">Preparing preview<span>…</span></div>}
    {error && <div className="aya-widget-error" role="alert">{error}<button onClick={() => { setError(''); setLoaded(false); setAttempt(attempt + 1); }}>Reload preview</button></div>}
    <iframe key={`${artifact.previewUrl}:${attempt}`} ref={frame} title={artifact.title} src={artifact.previewUrl} sandbox="allow-scripts" allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'" referrerPolicy="no-referrer" style={{ height, visibility: loaded ? 'visible' : 'hidden' }} />
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
