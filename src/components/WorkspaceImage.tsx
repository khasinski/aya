import { useEffect,useState } from 'react';
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
    void Promise.resolve().then(() => load(path)).then(
      value => { if (active) setSrc(String(value)); },
      e => { if (active) setError(String(e)); },
    );
    return () => { active = false; };
  }, [path, attempt, load]);
  return src && !error ? <img src={src} alt={alt} onError={() => setError('Image could not be decoded')} /> : <span role={error ? 'alert' : 'status'}>{error ? `Cannot display ${path}: ${error}` : 'Loading image…'}{error && <button type="button" onClick={() => setAttempt(value => value + 1)}>Retry</button>}</span>;
}
