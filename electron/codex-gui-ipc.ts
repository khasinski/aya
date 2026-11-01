import { GuiPanelState, matchesGuiBinding } from './gui-panel-state';
import { openArtifactWindow } from './artifact-preview-window';
import { pathToFileURL } from 'node:url';
import { writeFileAtomic } from './atomic-write';
import { AYA_HOME } from './paths';
import * as path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { loadConversation, saveConversation, archiveConversation, listConversations, readArchivedConversation } from './gui-conversation-store';
import { clearWidgetDocuments, registerWidgetProtocol, widgetDocument } from './gui-artifact-documents';
import { writeFile } from 'node:fs/promises';
import type { GuiArtifact, GuiEvent } from '../shared/codex-gui';
import { app, ipcMain, dialog, BrowserWindow } from 'electron';
import { homedir } from 'node:os';
import { CodexGuiSession, PiGuiSession, ClaudeGuiSession, AntigravityGuiSession, workspaceImage, type GuiAgentKind, type GuiSessionInstance } from './codex-gui-session';
function normalizeGuiAgent(raw: unknown): GuiAgentKind {
  return raw === 'pi' || raw === 'claude' || raw === 'antigravity' ? raw : 'codex';
}
function createGuiSession(agent: GuiAgentKind, emit: (event: GuiEvent) => void): GuiSessionInstance {
  if (agent === 'pi') return new PiGuiSession(emit, process.env.AYA_E2E_RUN === '1' ? process.env.AYA_E2E_PI_BIN || 'pi' : 'pi');
  if (agent === 'claude') return new ClaudeGuiSession(emit, process.env.AYA_E2E_RUN === '1' ? process.env.AYA_E2E_CLAUDE_BIN || 'claude' : 'claude');
  if (agent === 'antigravity') return new AntigravityGuiSession(emit, process.env.AYA_E2E_RUN === '1' ? process.env.AYA_E2E_AGY_BIN || 'agy' : 'agy');
  return new CodexGuiSession(emit, process.env.AYA_E2E_RUN === '1' ? process.env.AYA_E2E_CODEX_BIN || 'codex' : 'codex');
}
export function registerCodexGuiIpc(openExternal: (url: string) => Promise<void>) {
  registerWidgetProtocol();
  const panels = new GuiPanelState(async (id, snapshot) => { await saveConversation(id, snapshot); await archiveConversation(snapshot); }, clearWidgetDocuments);
  const { artifacts, artifactVersions, sessions, snapshots, attachments } = panels;
  const owners = new Set<number>();
  ipcMain.handle('codex-gui', async (event, id: string, action: string, value: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame) throw Error('Main frame required');
    if (typeof id !== 'string' || id.length > 200) throw Error('Invalid panel');
    const key = `${event.sender.id}:${id}`;
    if (!owners.has(event.sender.id)) {
      const ownerId = event.sender.id;
      owners.add(ownerId);
      const cleanup = () => { void panels.closeOwner(ownerId); };
      event.sender.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) cleanup(); });
      event.sender.once('destroyed', () => { cleanup(); owners.delete(ownerId); });
    }
    const perform = async () => {
    if (action === 'load') {
      if (sessions.has(key)) throw Error('Close the current connection before loading another conversation');
      panels.forget(key);
      const params = value as { cwd: string; configDir?: string; agent?: GuiAgentKind };
      const saved = await loadConversation(id);
      if (!matchesGuiBinding(saved, params)) return null;
      snapshots.set(key, saved);
      const view = saved.view || {};
      if (Array.isArray(view.messages)) view.messages = view.messages.map((message: { progress?: { status: string }; delivery?: string }) => ({ ...message, ...(message.progress?.status === 'running' ? { progress: { ...message.progress, status: 'paused' } } : {}), ...(message.delivery === 'sending' ? { delivery: 'unconfirmed' } : {}) }));
      const prepare = (artifact: GuiArtifact) => { if (artifact.kind === 'html') artifact.previewUrl = widgetDocument(key, artifact.html); return artifact; };
      if (Array.isArray(view.artifacts)) {
        view.artifacts = (view.artifacts as GuiArtifact[]).map(prepare);
        artifacts.set(key, new Map((view.artifacts as GuiArtifact[]).map(a => [a.id, a])));
      }
      if (view.artifactHistory && typeof view.artifactHistory === 'object') for (const [artifactId, versions] of Object.entries(view.artifactHistory)) {
        if (Array.isArray(versions)) {
          const prepared = versions.map(prepare);
          (view.artifactHistory as Record<string, GuiArtifact[]>)[artifactId] = prepared;
          let owned = artifactVersions.get(key); if (!owned) { owned = new Map(); artifactVersions.set(key, owned); } owned.set(artifactId, prepared);
        }
      }
      return view;
    }
    if (action === 'history') {
      const snapshot = snapshots.get(key);
      if (!snapshot) throw Error('Panel is disconnected');
      await archiveConversation(snapshot);
      const saved = await listConversations(snapshot);
      const session = sessions.get(key)?.session;
      if (!session?.listConversations) return saved;
      try {
        const native = await session.listConversations();
        const savedThreads = new Set<string>();
        for (const row of saved) { const value = await readArchivedConversation(String(row.id), snapshot); if (value.threadId) savedThreads.add('codex:' + value.threadId); }
        return [...saved, ...native.filter(row => !savedThreads.has(row.id))].sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt));
      } catch { return saved; }
    }
    if (action === 'switch-conversation') {
      const snapshot = snapshots.get(key);
      if (!snapshot) throw Error('Panel is disconnected');
      if (sessions.get(key)?.session.running) throw Error('Stop the current turn before switching conversations');
      const params = value as { conversationId?: string; view?: Record<string, unknown> };
      let next = { cwd: snapshot.cwd, configDir: snapshot.configDir, agent: snapshot.agent, view: {} } as typeof snapshot;
      if (params.conversationId?.startsWith('codex:')) {
        const session = sessions.get(key)?.session;
        if (!session?.readConversation || snapshot.agent !== 'codex') throw Error('Native history is unavailable for this harness');
        next = { ...next, ...await session.readConversation(params.conversationId.slice(6)) };
      } else if (params.conversationId) next = await readArchivedConversation(params.conversationId, snapshot);
      await panels.close(key, params.view);
      await saveConversation(id, next);
      return;
    }
    if (action === 'persist') {
      const snapshot = snapshots.get(key);
      if (!snapshot) throw Error('Conversation has not connected yet');
      snapshot.view = value as Record<string, unknown>;
      await saveConversation(id, snapshot);
      return;
    }
    if (action === 'close') return panels.close(key, value && typeof value === 'object' ? value as Record<string, unknown> : undefined);
    if (action === 'connect') {
      const params = value as { cwd: string; configDir?: string; agent?: GuiAgentKind };
      if (sessions.has(key)) throw Error('Panel already connected');
      const agent = normalizeGuiAgent(params.agent);
      const cached = snapshots.get(key);
      if (cached && !matchesGuiBinding(cached, { ...params, agent })) panels.forget(key);
      const session = createGuiSession(agent, payload => {
        if (panels.closing.has(key) || sessions.get(key)?.session !== session) return;
        if (payload.method === 'aya/session' && typeof payload.params.threadId === 'string') { const snapshot = snapshots.get(key); if (snapshot) snapshot.threadId = payload.params.threadId; }
        if (payload.method === 'aya/artifact') {
          const artifact = payload.params.artifact as GuiArtifact;
          if (artifact.kind === 'html') artifact.previewUrl = widgetDocument(key, artifact.html);
          let owned = artifacts.get(key); if (!owned) { owned = new Map(); artifacts.set(key, owned); }
          owned.set(artifact.id, artifact);
          let versions = artifactVersions.get(key); if (!versions) { versions = new Map(); artifactVersions.set(key, versions); } versions.set(artifact.id, [...(versions.get(artifact.id) || []).slice(-9), artifact]);
        }
        if (!event.sender.isDestroyed()) event.sender.send('codex-gui:event', id, payload);
      });
      sessions.set(key, { session, cwd: params.cwd, agent });
      try {
        const saved = snapshots.get(key);
        const result = await session.connect(params.cwd, '', params.configDir?.replace(/^~(?=\/|$)/, homedir()), (saved?.view?.importNotice || (Array.isArray(saved?.view?.messages) && saved.view.messages.some((m: { type?: string; delivery?: string }) => m.type !== 'goal' && m.delivery !== 'failed'))) ? saved?.threadId : undefined);
        session.restoreArtifacts([...(artifacts.get(key)?.values() || [])]);
        if (Array.isArray(saved?.view?.messages)) session.restoreProgress(saved.view.messages.filter((m: { progress?: unknown }) => !!m.progress).map((m: { progress: import('../shared/gui-progress').GuiProgress }) => m.progress));
        const snapshot = { ...saved, cwd: params.cwd, configDir: params.configDir, agent, threadId: result.threadId };
        snapshots.set(key, snapshot);
        await saveConversation(id, snapshot);
        return result;
      }
      catch (error) { try { session.close(); } finally { panels.forget(key); } throw error; }
    }
    const entry = sessions.get(key);
    if (!entry) throw Error('Panel is disconnected');
    const requestedArtifact = () => {
      const request = typeof value === 'string' ? { id: value } : value as { id: string; revision?: number };
      if (typeof request?.revision === 'number') return artifactVersions.get(key)?.get(request.id)?.find(a => a.revision === request.revision);
      return artifacts.get(key)?.get(request?.id);
    };
    if (action === 'open-artifact' || action === 'open-artifact-browser') {
      const artifact = requestedArtifact();
      if (!artifact || (artifact.kind !== 'html' && artifact.kind !== 'image')) throw Error('This artifact has no browser preview');
      if (action === 'open-artifact') { openArtifactWindow(artifact, event.sender, id); return; }
      const escape = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
      const content = artifact.kind === 'html' ? artifact.html : `<img alt="${escape(artifact.title)}" src="${escape(artifact.dataUrl)}" style="max-width:100%;height:auto">`;
      const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><title>${escape(artifact.title)}</title><style>body{margin:0;padding:24px;background:#10151e;color:#dce3ef;font:14px system-ui}#aya-follow-up{position:fixed;bottom:16px;left:16px;right:16px;padding:12px;background:#1b2231;color:#dce3ef;white-space:pre-wrap;border:1px solid #b9a6f7;border-radius:8px}</style><script>window.ayaWidget=Object.freeze({suggest(text){let node=document.getElementById('aya-follow-up');if(!node){node=document.createElement('div');node.id='aya-follow-up';document.body.append(node)}node.textContent='Copy this suggestion into Aya:\\n'+String(text).slice(0,4000);}});</script></head><body>${content}</body></html>`;
      const file = path.join(AYA_HOME, 'artifact-previews', `${createHash('sha256').update(html).digest('hex')}.html`);
      await writeFileAtomic(file, html, 0o600);
      await openExternal(pathToFileURL(file).href);
      return;
    }
    if (action === 'save-artifact') {
      const artifact = requestedArtifact();
      if (!artifact) throw Error('Artifact is no longer available');
      if (artifact.kind !== 'html' && artifact.kind !== 'image') throw Error('Only widgets and graphics can be saved');
      const extension = artifact.kind === 'html' ? 'html' : artifact.dataUrl.startsWith('data:image/svg+xml') ? 'svg' : artifact.dataUrl.startsWith('data:image/jpeg') ? 'jpg' : artifact.dataUrl.startsWith('data:image/webp') ? 'webp' : 'png';
      const owner = BrowserWindow.fromWebContents(event.sender);
      if (!owner) throw Error('Window is closed');
      const result = await dialog.showSaveDialog(owner, { defaultPath: `${artifact.title.replace(/[^a-z0-9_-]/gi, '-').slice(0, 80)}.${extension}`, filters: [{ name: 'Artifact', extensions: [extension] }] });
      if (result.canceled || !result.filePath) return false;
      await writeFile(result.filePath, artifact.kind === 'html' ? artifact.html : Buffer.from(artifact.dataUrl.split(',')[1], 'base64'));
      return true;
    }
    if (action === 'models') return entry.session.models();
    if (action === 'steer') return entry.session.steer(String(value));
    if (action === 'pick-attachments') {
      const window = BrowserWindow.fromWebContents(event.sender); if (!window) throw Error('Window is closed');
      const agentLabel = entry.agent === 'pi' ? 'Pi' : entry.agent === 'claude' ? 'Claude' : entry.agent === 'antigravity' ? 'Antigravity' : 'Codex';
      const result = await dialog.showOpenDialog(window, { title: `Attach files to ${agentLabel}`, properties: ['openFile', 'multiSelections'] });
      if (sessions.get(key)?.session !== entry.session || panels.closing.has(key)) throw Error('Panel closed while selecting attachments');
      if (result.canceled) return [];
      let owned = attachments.get(key); if (!owned) { owned = new Map(); attachments.set(key, owned); }
      return result.filePaths.slice(0, 20).map(file => { const item = { id: randomUUID(), name: path.basename(file), path: file, image: /\.(png|jpe?g|webp)$/i.test(file) }; owned!.set(item.id, item); return item; });
    }
    if (action === 'send') {
      if (typeof value === 'string') return entry.session.send(value);
      const params = value as { text: string; model?: string; effort?: string; attachmentIds?: string[] };
      const files = (params.attachmentIds || []).map(id => { const file = attachments.get(key)?.get(id); if (!file) throw Error('Please reattach this file after reconnecting'); return file; });
      const text = params.text + (files.filter(f => !f.image).length ? '\n\nAttached files (selected by the user):\n' + files.filter(f => !f.image).map(f => JSON.stringify(f.path)).join('\n') : '');
      return entry.session.send(text, { model: params.model, effort: params.effort, images: files.filter(f => f.image).map(f => f.path) });
    }
    if (action === 'interrupt') return entry.session.interrupt();
    if (action === 'image') return workspaceImage(entry.cwd, String(value));
    if (action === 'command') { const p = value as { name: string; argument: string }; return entry.session.command(p.name, p.argument); }
    if (action === 'respond') { const p = value as { id: string | number; value: Parameters<CodexGuiSession['respond']>[1] }; return entry.session.respond(p.id, p.value); }
    throw Error('Unknown GUI action');
    };
    return ['load', 'connect', 'persist', 'close', 'history', 'switch-conversation'].includes(action) ? panels.run(key, perform) : perform();
  });
  app.on('before-quit', () => { for (const { session } of sessions.values()) session.close(); });
}
