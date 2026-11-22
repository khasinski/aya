import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { workspaceLink } from '../../shared/workspace-link.cjs';
import { isInlineImage } from '../conversation-images';
import { useModalFocus } from './useModalFocus';
export function WorkspaceImage({ path, alt, load }: { path: string; alt: string; load: (path: string) => Promise<unknown> }) {
  // A new source gets fresh loading/error state before its first paint.
  return <ImageSource key={path} path={path} alt={alt} load={load} />;
}

function ImageSource({ path, alt, load }: { path: string; alt: string; load: (path: string) => Promise<unknown> }) {
  const [src, setSrc] = useState('');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setSrc(''); setError('');
    void Promise.resolve().then(() => {
      if (isInlineImage(path)) return path;
      const local = workspaceLink(path);
      if (!local) throw Error('Use an image inside the workspace or an embedded data image.');
      return load(local.path);
    }).then(
      value => { if (active) setSrc(String(value)); },
      e => { if (active) setError(String(e)); },
    );
    return () => { active = false; };
  }, [path, attempt, load]);
  return src && !error ? <ConversationImage src={src} alt={alt} onError={() => setError('Image could not be decoded')} /> : <span role={error ? 'alert' : 'status'}>{error ? `Cannot display ${path.startsWith('data:') ? alt : path}: ${error}` : 'Loading image…'}{error && <button type="button" onClick={() => setAttempt(value => value + 1)}>Retry</button>}</span>;
}

export function ConversationImage({ src, alt, onError }: { src: string; alt: string; onError?: () => void }) {
  const [expanded, setExpanded] = useState(false);
  return <span className="aya-chat-image">
    <button type="button" className="aya-chat-image-open" aria-label={`Enlarge image: ${alt}`} onClick={() => setExpanded(true)}><img src={src} alt={alt} onError={onError} /></button>
    {expanded && <ImagePreview src={src} alt={alt} close={() => setExpanded(false)} />}
  </span>;
}

function ImagePreview({ src, alt, close }: { src: string; alt: string; close: () => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  useModalFocus(dialog, close);
  return createPortal(<div className="aya-file-preview-backdrop" onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <div ref={dialog} className="aya-file-preview aya-chat-image-preview" role="dialog" aria-modal="true" aria-label={alt}>
      <header><strong>{alt}</strong><button type="button" aria-label="Close image preview" onClick={close}>×</button></header>
      <img src={src} alt={alt} />
    </div>
  </div>, document.body);
}
