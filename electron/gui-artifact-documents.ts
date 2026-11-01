import { protocol } from 'electron';
import { randomUUID, createHash } from 'node:crypto';
// A distinct, sandboxed document origin keeps widget JavaScript away from Aya's
// preload and filesystem. It never weakens the application's script policy.
export function registerWidgetScheme() { protocol.registerSchemesAsPrivileged([{ scheme: 'aya-widget', privileges: { standard: true, secure: true, supportFetchAPI: true } }]); }
const documents = new Map<string, { owner: string; html: string }>();
const salts = new Map<string, string>();
export function clearWidgetDocuments(owner: string) {
  for (const [key, value] of documents) if (value.owner === owner) documents.delete(key);
  salts.delete(owner);
}
export function widgetDocument(owner: string, html: string) {
  if (!salts.has(owner)) salts.set(owner, randomUUID());
  const token = createHash('sha256').update(salts.get(owner)!).update(html).digest('hex');
  if (documents.has(token)) return `aya-widget://preview/${token}`;
  const bootstrap = `<script>
  (() => {
    const post = (type, value) => parent.postMessage({type, value}, '*');
    Object.defineProperty(window, 'ayaWidget', { value: Object.freeze({ suggest: text => post('aya:suggest', String(text).slice(0, 4000)) }) });
    addEventListener('DOMContentLoaded', () => {
      const size = () => post('aya:height', Math.ceil(document.documentElement.getBoundingClientRect().height));
      new ResizeObserver(size).observe(document.body); size();
      post('aya:ready', true);
    });
    addEventListener('error', () => post('aya:error', 'This widget encountered an error. You can inspect its source or ask Codex to fix it.'));
  })();
  </script>`;
  documents.set(token, { owner, html: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html{color-scheme:dark}body{margin:0;padding:20px;background:#10151e;color:#dce3ef;font:14px system-ui;box-sizing:border-box}button,input,select{font:inherit}*{box-sizing:border-box}</style>${bootstrap}</head><body>${html}</body></html>` });
  let bytes = 0;
  for (const document of documents.values()) if (document.owner === owner) bytes += Buffer.byteLength(document.html);
  for (const [id, document] of documents) { if (bytes <= 32 * 1024 * 1024) break; if (document.owner === owner && id !== token) { bytes -= Buffer.byteLength(document.html); documents.delete(id); } }
  return `aya-widget://preview/${token}`;
}
export function isWidgetPreviewUrl(raw: string, ownerId: number) {
  try { const url = new URL(raw); return url.protocol === 'aya-widget:' && url.host === 'preview' && documents.get(url.pathname.slice(1))?.owner.startsWith(`${ownerId}:`) === true; } catch { return false; }
}
export function registerWidgetProtocol() {
  protocol.handle('aya-widget', request => {
    const url = new URL(request.url);
    const document = url.host === 'preview' ? documents.get(url.pathname.slice(1)) : undefined;
    if (!document) return new Response('Preview is no longer available.', { status: 404 });
    return new Response(document.html, { headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts",
      'Cache-Control': 'no-store',
    } });
  });
}
