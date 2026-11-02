import { useState, useEffect } from 'react';
export function WorkspaceImage({ path, alt, load }: { path: string; alt: string; load: (path: string) => Promise<unknown> }) {
  const [src, setSrc] = useState(''); const [error, setError] = useState(''); const [attempt, setAttempt] = useState(0);
  useEffect(() => { let active = true; setError(''); void load(path).then(value => { if (active) setSrc(String(value)); }, e => { if (active) setError(String(e)); }); return () => { active = false; }; 
  }, [path, attempt, load]);
  return src ? <img src={src} alt={alt} /> : <span role={error ? 'alert' : 'status'}>{error ? `Cannot display ${path}: ${error}` : 'Loading image…'}{error && <button onClick={() => setAttempt(attempt + 1)}>Retry</button>}</span>;
}
