import { ipcMain } from 'electron';
import * as path from 'node:path';
import type { GuiArtifact } from '../shared/codex-gui';
import { isWidgetPreviewUrl } from './gui-artifact-documents';
const previews = new Map<number, { owner: Electron.WebContents; panel: string }>();
let registered = false;
const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export function openArtifactWindow(artifact: GuiArtifact, owner: Electron.WebContents, panel: string, createWindow: (options: Electron.BrowserWindowConstructorOptions) => Electron.BrowserWindow) {
  if (!registered) {
    registered = true;
    ipcMain.on('artifact-preview:suggest', (event, text: unknown) => {
      const preview = previews.get(event.sender.id);
      if (!preview || event.senderFrame !== event.sender.mainFrame || typeof text !== 'string' || !text.trim() || text.length > 4000 || preview.owner.isDestroyed()) return;
      preview.owner.send('codex-gui:event', preview.panel, { method: 'aya/widgetSuggestion', params: { text } });
    });
  }
  const win = createWindow({ width: 1100, height: 800, acceptFirstMouse: true, minWidth: 480, minHeight: 360, title: artifact.title, show: process.env.AYA_E2E_HEADLESS !== '1', backgroundColor: '#10151e', webPreferences: { preload: path.join(__dirname, 'artifact-preview-preload.bundle.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
  previews.set(win.webContents.id, { owner, panel });
  const contentsId = win.webContents.id;
  win.once('closed', () => previews.delete(contentsId));
  owner.once('destroyed', () => { if (!win.isDestroyed()) win.close(); });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('will-frame-navigate', event => { if (event.isMainFrame || !isWidgetPreviewUrl(event.url, owner.id)) event.preventDefault(); });
  const content = artifact.kind === 'html' ? `<iframe title="${escape(artifact.title)}" src="${escape(artifact.previewUrl || '')}" sandbox="allow-scripts"></iframe>` : artifact.kind === 'image' ? `<main><img alt="${escape(artifact.title)}" src="${escape(artifact.dataUrl)}"></main>` : '';
  const document = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src aya-widget:; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'"><title>${escape(artifact.title)}</title><style>html,body{height:100%;margin:0;background:#10151e;color:#dce3ef;font:13px system-ui}body{display:flex;flex-direction:column}header{padding:14px 20px;border-bottom:1px solid #2a3345;display:flex;gap:12px;align-items:center}header small{color:#8190a8;margin-left:auto}iframe{flex:1;width:100%;border:0}main{overflow:auto;display:grid;place-items:center;flex:1}img{max-width:100%;object-fit:contain}#feedback{font-size:12px;color:#b9a6f7}</style><script>document.documentElement.dataset.previewReady='true';addEventListener('message',event=>{const frame=document.querySelector('iframe');if(event.source===frame?.contentWindow&&event.data?.type==='aya:suggest'&&typeof event.data.value==='string'){window.artifactPreview.suggest(event.data.value);const feedback=document.querySelector('#feedback');if(feedback)feedback.textContent='Suggestion ready in Aya';}});</script></head><body><header><strong>${escape(artifact.title)}</strong><span id="feedback" role="status"></span><small>Aya · Artifact preview</small></header>${content}</body></html>`;
  void win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(document));
  return win;
}
