// The window `aya present` opens: one per artifact, reloaded in place when the artifact is updated.
import { clipboard } from "electron";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { GuiArtifact } from "../shared/codex-gui";
import { clearWidgetDocuments, isWidgetPreviewUrl, widgetDocument } from "./gui-artifact-documents";
import { installArtifactImageMenu } from "./gui-artifact-image-menu";
import { registerPreviewSuggestSink } from "./artifact-preview-window";

type CreateWindow = (options: Electron.BrowserWindowConstructorOptions) => Electron.BrowserWindow;

const windows = new Map<string, Electron.BrowserWindow>();
const owners = new Map<number, string>();
const shown = new Map<string, GuiArtifact>();
const escape = (text: string) => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The artifact's body as markup; tables and metrics are static, html goes in the isolated widget frame. */
export function artifactBody(artifact: GuiArtifact, previewUrl?: string): string {
  if (artifact.kind === "html") return `<iframe title="${escape(artifact.title)}" src="${escape(previewUrl || "")}" sandbox="allow-scripts"></iframe>`;
  if (artifact.kind === "image") return `<main><img alt="${escape(artifact.title)}" src="${escape(artifact.dataUrl)}"></main>`;
  if (artifact.kind === "metric") return `<main><div class="metric"><b>${escape(artifact.value)}</b><p>${escape(artifact.description)}</p></div></main>`;
  const head = artifact.columns.map((c) => `<th>${escape(c)}</th>`).join("");
  const rows = artifact.rows.map((r) => `<tr>${r.map((c) => `<td>${escape(c)}</td>`).join("")}</tr>`).join("");
  return `<main class="tablewrap"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></main>`;
}

function documentFor(artifact: GuiArtifact, previewUrl?: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src aya-widget:; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'"><title>${escape(artifact.title)}</title><style>html,body{height:100%;margin:0;background:#10151e;color:#dce3ef;font:13px system-ui}body{display:flex;flex-direction:column}header{padding:14px 20px;border-bottom:1px solid #2a3345;display:flex;gap:12px;align-items:center}header small{color:#8190a8;margin-left:auto}iframe{flex:1;width:100%;border:0}main{overflow:auto;display:grid;place-items:center;flex:1}img{max-width:100%;object-fit:contain}.tablewrap{place-items:start stretch;padding:16px 20px}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:6px 10px;border-bottom:1px solid #2a3345}th{color:#8190a8;font-weight:600}.metric b{display:block;font-size:56px}.metric p{color:#8190a8;font-size:16px}#feedback{font-size:12px;color:#b9a6f7}</style><script>document.documentElement.dataset.previewReady='true';addEventListener('message',event=>{const frame=document.querySelector('iframe');if(event.source===frame?.contentWindow&&event.data?.type==='aya:suggest'&&typeof event.data.value==='string'){window.artifactPreview.suggest(event.data.value);const feedback=document.querySelector('#feedback');if(feedback)feedback.textContent='Suggestion copied to the clipboard';}});</script></head><body><header><strong>${escape(artifact.title)}</strong><span id="feedback" role="status"></span><small>Aya · Artifact · r${artifact.revision ?? 1}</small></header>${artifactBody(artifact, previewUrl)}</body></html>`;
}

/** Shows the artifact: a new window, or the one already open for it, reloaded. */
export function showTuiArtifact(artifact: GuiArtifact, createWindow: CreateWindow): void {
  let win = windows.get(artifact.id);
  if (!win || win.isDestroyed()) {
    win = createWindow({
      width: 1100, height: 800, acceptFirstMouse: true, minWidth: 480, minHeight: 360, title: artifact.title,
      show: process.env.AYA_E2E_HEADLESS !== "1", backgroundColor: "#10151e",
      webPreferences: { preload: path.join(__dirname, "artifact-preview-preload.bundle.js"), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
    });
    const created = win, id = created.webContents.id, owner = `${id}:${randomUUID()}`;
    windows.set(artifact.id, created);
    owners.set(id, owner);
    // There is no conversation to receive a widget's suggestion: it goes to the clipboard for the user to paste.
    registerPreviewSuggestSink(id, (text) => clipboard.writeText(text));
    installArtifactImageMenu(created.webContents, (url) => { const current = shown.get(artifact.id); return current?.kind === "image" && url === current.dataUrl ? current : undefined; });
    created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    created.webContents.on("will-navigate", (event) => event.preventDefault());
    created.webContents.on("will-frame-navigate", (event) => { if (event.isMainFrame || !isWidgetPreviewUrl(event.url, id)) event.preventDefault(); });
    created.once("closed", () => { windows.delete(artifact.id); shown.delete(artifact.id); owners.delete(id); registerPreviewSuggestSink(id, null); clearWidgetDocuments(owner); });
  } else if (!win.isVisible() && process.env.AYA_E2E_HEADLESS !== "1") win.show();
  const id = win.webContents.id, owner = owners.get(id)!;
  shown.set(artifact.id, artifact);
  const previewUrl = artifact.kind === "html" ? widgetDocument(owner, artifact.html) : undefined;
  win.setTitle(artifact.title);
  if (process.env.AYA_E2E_HEADLESS !== "1") win.focus();
  void win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(documentFor(artifact, previewUrl)));
}

/** For tests: the ids of artifacts with a live window. */
export function openArtifactWindowIds(): string[] { return [...windows.entries()].filter(([, w]) => !w.isDestroyed()).map(([id]) => id); }
