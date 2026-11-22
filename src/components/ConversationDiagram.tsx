import { memo, useEffect, useState } from 'react';
import { ConversationCodeBlock } from './ConversationCodeBlock';
import { ConversationImage } from './WorkspaceImage';

let renderer: Promise<typeof import('mermaid')['default']> | undefined;
let nextId = 0;
const cache = new Map<string, Promise<string>>();
function renderDiagram(source: string): Promise<string> {
  const cached = cache.get(source);
  if (cached) return cached;
  const result = (async () => {
    renderer ??= import('mermaid').then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false, securityLevel: 'strict', theme: 'neutral',
        suppressErrorRendering: true, maxTextSize: 50_000, maxEdges: 500,
        htmlLabels: false,
        secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'suppressErrorRendering', 'dompurifyConfig', 'htmlLabels', 'flowchart'],
        flowchart: { htmlLabels: false },
      });
      return mermaid;
    });
    const mermaid = await renderer;
    const container = document.createElement('div');
    container.style.cssText = 'position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none';
    container.setAttribute('aria-hidden', 'true');
    document.body.append(container);
    try {
      const { svg } = await mermaid.render(`aya-diagram-${++nextId}`, source, container);
      // SVG used as an image cannot execute scripts, follow links or load
      // external subresources. Never mount generated markup in the chat DOM.
      const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
      const root = document.documentElement;
      // Mermaid's percentage width works in the DOM, but an <img> needs an
      // intrinsic size. Otherwise a two-node graph expands to the pane width.
      const bounds = root.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
      if (bounds?.length === 4 && bounds.every(Number.isFinite) && bounds[2] > 0 && bounds[3] > 0) {
        root.setAttribute('width', String(Math.ceil(bounds[2])));
        root.setAttribute('height', String(Math.ceil(bounds[3])));
      }
      // The neutral diagram palette needs the same paper in an enlarged
      // preview, including when the rest of Aya uses a dark theme.
      root.setAttribute('style', `${root.getAttribute('style') || ''};background-color:#fff`);
      return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(root))}`;
    } finally { container.remove(); }
  })();
  cache.set(source, result);
  if (cache.size > 32) cache.delete(cache.keys().next().value!);
  void result.catch(() => { if (cache.get(source) === result) cache.delete(source); });
  return result;
}

export const ConversationDiagram = memo(function ConversationDiagram({ source }: { source: string }) {
  return <DiagramSource key={source} source={source} />;
});

function DiagramSource({ source }: { source: string }) {
  const [image, setImage] = useState('');
  const [error, setError] = useState('');
  const [showSource, setShowSource] = useState(false);
  useEffect(() => {
    let active = true;
    // Avoid parsing every token while a fenced block is still streaming.
    const timer = setTimeout(() => {
      if (source.length > 50_000) { setError('Diagram is too large to preview.'); return; }
      void renderDiagram(source).then(
        value => { if (active) setImage(value); },
        () => { if (active) setError('Cannot preview this Mermaid diagram. The source is shown below.'); },
      );
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [source]);
  return <div className="aya-chat-diagram">
    <div className="aya-chat-block-toolbar"><span>Mermaid</span>{!error && <button type="button" aria-expanded={showSource} onClick={() => setShowSource(value => !value)}>{showSource ? 'Hide source' : 'Show source'}</button>}</div>
    {error ? <p role="status">{error}</p> : image ? <div className="aya-chat-diagram-preview"><ConversationImage src={image} alt="Mermaid diagram" /></div> : <p role="status">Rendering diagram…</p>}
    {(showSource || error) && <ConversationCodeBlock source={source} language="mermaid" />}
  </div>;
}
