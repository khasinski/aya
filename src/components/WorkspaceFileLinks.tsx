import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useModalFocus } from './useModalFocus';
import { ipcMessage } from './use-async-action';
interface Preview { path: string; line: number; firstLine: number; totalLines: number; lines: string[] }
const FileLinks = createContext<((href: string) => void) | null>(null);
export const useWorkspaceFileLink = () => useContext(FileLinks);
export function WorkspaceFileLinks({ terminalId, children }: { terminalId: string; children: ReactNode }) {
  const [request, setRequest] = useState<{ href: string; preview?: Preview; error?: string } | null>(null);
  const generation = useRef(0);
  const close = () => { generation.current++; setRequest(null); };
  const open = useCallback((href: string) => {
    const current = ++generation.current;
    setRequest({ href });
    const api = window.ayaGui;
    void (api ? api.invoke(terminalId, 'read-linked-file', href) : Promise.reject(Error('File previews require the desktop app'))).then(
      value => { if (generation.current === current) setRequest({ href, preview: value as Preview }); },
      error => { if (generation.current === current) setRequest({ href, error: ipcMessage(error) }); },
    );
  }, [terminalId]);
  return <FileLinks.Provider value={open}>{children}{request && <WorkspaceFileDialog request={request} close={close} open={open} />}</FileLinks.Provider>;
}

function WorkspaceFileDialog({ request, close, open }: {
  request: { href: string; preview?: Preview; error?: string };
  close: () => void;
  open: (href: string) => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  useModalFocus(dialog, close);
  return createPortal(
    <div className="aya-file-preview-backdrop" onClick={e => { if (e.target === e.currentTarget) close(); }}>
      <div ref={dialog} className="aya-file-preview" role="dialog" aria-modal="true" aria-label="Workspace file preview">
        <header><strong>{request.preview?.path || request.href}</strong><button type="button" aria-label="Close file preview" onClick={close}>×</button></header>
        {request.error ? <p role="alert">{request.error}<button type="button" onClick={() => open(request.href)}>Retry</button></p> : !request.preview ? <p role="status">Loading file…</p> : <>
          <p>Line {request.preview.line} of {request.preview.totalLines} · read-only excerpt</p>
          <pre>{request.preview.lines.map((text, i) => {
            const line = request.preview!.firstLine + i;
            return <div key={line} data-selected={line === request.preview!.line} ref={line === request.preview!.line ? node => { node?.scrollIntoView({ block: 'center' }); } : undefined}><span aria-hidden="true">{line.toString().padStart(5)} </span>{text || ' '}</div>;
          })}</pre>
        </>}
      </div>
    </div>, document.body);
}
