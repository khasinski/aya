import { WidgetDocumentCache } from "./widget-document-cache";
import { protocol } from 'electron';
import { randomUUID, createHash } from 'node:crypto';
import { artifactMediaResponse, mediaUrls, validArtifactMedia } from './gui-artifact-media';
import type { GuiArtifactMedia } from '../shared/codex-gui';
// A distinct, sandboxed document origin keeps widget JavaScript away from Aya's
// preload and filesystem. It never weakens the application's script policy.
export function registerWidgetScheme() { protocol.registerSchemesAsPrivileged([{ scheme: 'aya-widget', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]); }
const documents = new WidgetDocumentCache();
const salts = new Map<string, string>();
export function clearWidgetDocuments(owner: string) {
  documents.clearOwner(owner);
  salts.delete(owner);
}
export function widgetDocument(owner: string, html: string, media: readonly GuiArtifactMedia[] = []) {
  if (!validArtifactMedia(media)) throw Error('Invalid artifact media');
  if (!salts.has(owner)) salts.set(owner, randomUUID());
  const token = createHash('sha256').update(salts.get(owner)!).update(html).update(JSON.stringify(media)).digest('hex');
  if (documents.get(token)) return `aya-widget://preview/${token}`;
  const url = (hash: string) => 'aya-widget://preview/' + token + '/media/' + hash;
  html = mediaUrls(html, hash => { if (!media.some(m => m.hash === hash)) throw Error('Missing artifact media'); return url(hash); });
  const urls = JSON.stringify(Object.fromEntries(media.map(m => [m.name, url(m.hash)]))).replace(/</g, '\\u003c');
  const bootstrap = `<script>
  (() => {
    const post = (type, value) => parent.postMessage({type, value}, '*');
    const assets = ${urls};
    Object.defineProperty(window, 'ayaWidget', { value: Object.freeze({ asset: name => { if (!Object.hasOwn(assets, name)) throw Error('Unknown artifact media: ' + name); return assets[name]; }, suggest: text => post('aya:suggest', String(text).slice(0, 4000)) }) });
    const failures = new WeakMap();
    const mediaError = (element, message) => {
      if (!element || failures.has(element)) return;
      const notice = document.createElement('p'); notice.setAttribute('role', 'alert'); notice.textContent = message;
      notice.style.cssText = 'padding:12px;border:1px solid #a46a35;border-radius:6px;color:#ffc98b;background:#261d14;font:13px system-ui';
      if (element === document.body) element.prepend(notice); else element.after(notice); failures.set(element, notice);
    };
    addEventListener('error', event => {
      const element = event.target;
      if (element instanceof HTMLSourceElement && element.parentElement instanceof HTMLMediaElement) { const player = element.parentElement; setTimeout(() => { if (!player.readyState && player.networkState === 3) mediaError(player, 'No playable media source. Use a local MP4 (H.264/AAC) or WebM (VP8/VP9) file.'); }, 200); }
      if (element instanceof HTMLMediaElement) mediaError(element, 'This video or audio could not be played. The file may be missing or the codec unsupported. Try MP4 (H.264/AAC) or WebM (VP8/VP9).');
    }, true);
    addEventListener('loadeddata', event => { const notice = failures.get(event.target); if (notice) { notice.remove(); failures.delete(event.target); } }, true);
    addEventListener('securitypolicyviolation', event => {
      if (event.effectiveDirective !== 'media-src' && event.effectiveDirective !== 'frame-src') return;
      const kind = event.effectiveDirective === 'frame-src' ? 'External video players are unavailable in artifacts.' : 'This media URL is blocked.';
      mediaError(document.body, kind + ' Use a local MP4 or WebM file with <video controls src="./clip.mp4">.');
    });
    addEventListener('DOMContentLoaded', () => {
      const size = () => post('aya:height', Math.ceil(document.documentElement.getBoundingClientRect().height));
      new ResizeObserver(size).observe(document.body); size();
      post('aya:ready', true);
    });
    addEventListener('error', () => post('aya:error', 'This widget encountered an error. You can inspect its source or ask Codex to fix it.'));
  })();
  </script>`;
  documents.set(token, owner, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html{color-scheme:dark}body{margin:0;padding:20px;background:#10151e;color:#dce3ef;font:14px system-ui;box-sizing:border-box}button,input,select{font:inherit}video{max-width:100%;height:auto}*{box-sizing:border-box}</style>${bootstrap}</head><body>${html}</body></html>`, media);
  return `aya-widget://preview/${token}`;
}
export function isWidgetPreviewUrl(raw: string, ownerId: number) {
  try { const url = new URL(raw); return url.protocol === 'aya-widget:' && url.host === 'preview' && documents.get(url.pathname.slice(1))?.owner.startsWith(`${ownerId}:`) === true; } catch { return false; }
}
export function registerWidgetProtocol() {
  protocol.handle('aya-widget', async request => {
    const url = new URL(request.url);
    const mediaPath = /^\/([a-f0-9]{64})\/media\/([a-f0-9]{64})$/.exec(url.pathname);
    if (url.host === 'preview' && mediaPath) {
      const document = documents.get(mediaPath[1]);
      const media = document?.media.find(m => m.hash === mediaPath[2]);
      if (!media) return new Response('Media is not available to this artifact.', { status: 404 });
      try { return await artifactMediaResponse(request, media); }
      catch { return new Response('Artifact media is missing or damaged.', { status: 404 }); }
    }
    const document = url.host === 'preview' ? documents.get(url.pathname.slice(1)) : undefined;
    if (!document) return new Response('Preview is no longer available.', { status: 404 });
    return new Response(document.html, { headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src aya-widget: data: blob:; media-src aya-widget: data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts",
      'Cache-Control': 'no-store',
    } });
  });
}
