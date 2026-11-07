import { artifactSearchText, normalizeArtifactSearch } from '../shared/gui-artifact-search.cjs';
import { GuiRecoveryJournal } from './gui-recovery-journal';
import { GuiPanelState, matchesGuiBinding } from './gui-panel-state';
import { openArtifactWindow } from './artifact-preview-window';
import { pathToFileURL } from 'node:url';
import { writeFileAtomic } from './atomic-write';
import { AYA_HOME } from './paths';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { loadConversation, saveConversation, archiveConversation, listConversations, readArchivedConversation, hydrateConversationArtifact } from './gui-conversation-store';
import { clearWidgetDocuments, registerWidgetProtocol, widgetDocument } from './gui-artifact-documents';
import { installArtifactImageMenu, saveGuiArtifact } from './gui-artifact-image-menu';
import type { GuiArtifact, GuiArtifactEntry, GuiEvent } from '../shared/codex-gui';
import { app, ipcMain, dialog, BrowserWindow, clipboard } from 'electron';
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
let prepareRecovery: (ownerId: number) => void = () => {};
export function prepareGuiRendererRecovery(ownerId: number) { prepareRecovery(ownerId); }
let activeGuiSessions = new Map<string, { session: GuiSessionInstance; cwd: string; agent: GuiAgentKind }>();

export function busyGuiSessionCount(): number {
  let count = 0;
  for (const entry of activeGuiSessions.values()) {
    if (entry.session.running) count++;
  }
  return count;
}

export function isGuiSessionBusy(id: string): boolean {
  for (const [key, entry] of activeGuiSessions) {
    if (key.endsWith(`:${id}`) && entry.session.running) {
      return true;
    }
  }
  return false;
}

export function registerCodexGuiIpc(openExternal: (url: string) => Promise<void>, createWindow: (options: Electron.BrowserWindowConstructorOptions) => Electron.BrowserWindow) {
  registerWidgetProtocol();
  const panels = new GuiPanelState(async (id, snapshot) => { await saveConversation(id, snapshot); await archiveConversation(snapshot); }, clearWidgetDocuments);
  const { artifacts, artifactVersions, sessions, snapshots, attachments } = panels;
  activeGuiSessions = sessions;
  const owners = new Set<number>();
  const recoveringOwners = new Set<number>();
  const recoverablePanels = new Set<string>();
  const journals = new Map<string, GuiRecoveryJournal>();
  const searches = new Map<string, symbol>();
  prepareRecovery = ownerId => {
    recoveringOwners.add(ownerId);
    for (const panelKey of snapshots.keys()) if (panelKey.startsWith(`${ownerId}:`)) recoverablePanels.add(panelKey);
  };
  const imageReferences = new Map<number, Map<string, { key: string; id: string; revision?: number }>>();
  const withPanelArtifacts = (key: string, view: Record<string, unknown>) => ({
    ...view,
    artifacts: [...(artifacts.get(key)?.values() || [])],
    artifactHistory: Object.fromEntries(artifactVersions.get(key) || []),
  });
  ipcMain.handle('codex-gui', async (event, id: string, action: string, value: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame) throw Error('Main frame required');
    if (typeof id !== 'string' || id.length > 200) throw Error('Invalid panel');
    const key = `${event.sender.id}:${id}`;
    if (!owners.has(event.sender.id)) {
      const ownerId = event.sender.id;
      owners.add(ownerId);
      installArtifactImageMenu(event.sender, async url => {
        const identity = imageReferences.get(ownerId)?.get(createHash('sha256').update(url).digest('hex'));
        const shown = identity && panels.artifact(identity.key, identity.id, identity.revision);
        if (shown) return 'deferred' in shown ? hydrateConversationArtifact(shown) : shown;
        for (const [panelKey, versions] of artifactVersions) {
          if (!panelKey.startsWith(`${ownerId}:`)) continue;
          for (const artifacts of versions.values()) for (const artifact of artifacts) if (!('deferred' in artifact) && artifact.kind === 'image' && artifact.dataUrl === url) return artifact;
        }
        // Older saved conversations may not contain revision history.
        for (const [panelKey, owned] of artifacts) {
          if (!panelKey.startsWith(`${ownerId}:`)) continue;
          for (const artifact of owned.values()) if (!('deferred' in artifact) && artifact.kind === 'image' && artifact.dataUrl === url) return artifact;
        }
      });
      const cleanup = () => {
        for (const panelKey of journals.keys()) if (panelKey.startsWith(`${ownerId}:`)) { journals.delete(panelKey); recoverablePanels.delete(panelKey); }
        for (const panelKey of searches.keys()) if (panelKey.startsWith(`${ownerId}:`)) searches.delete(panelKey);
        void panels.closeOwner(ownerId);
      };
      event.sender.on('render-process-gone', (_event, details) => {
        if (details.reason === 'clean-exit') return;
        prepareGuiRendererRecovery(ownerId);
      });
      event.sender.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) { if (recoveringOwners.has(ownerId)) recoveringOwners.delete(ownerId); else cleanup(); } });
      event.sender.once('destroyed', () => { cleanup(); owners.delete(ownerId); imageReferences.delete(ownerId); });
    }
    const perform = async () => {
    if (action === 'load') {
      if (recoverablePanels.has(key) && sessions.has(key)) {
        const current = snapshots.get(key);
        if (!matchesGuiBinding(current, value as { cwd: string; configDir?: string; agent?: GuiAgentKind })) throw Error('Recovered panel binding does not match');
        return { ...withPanelArtifacts(key, current.view || {}), recoveryRunning: sessions.get(key)!.session.running };
      }
      if (sessions.has(key)) throw Error('Close the current connection before loading another conversation');
      panels.forget(key);
      const params = value as { cwd: string; configDir?: string; agent?: GuiAgentKind };
      const saved = await loadConversation(id, { lazyArtifacts: true });
      if (!matchesGuiBinding(saved, params)) return null;
      snapshots.set(key, saved);
      const view = saved.view || {};
      view.eventSequence = 0;
      if (Array.isArray(view.messages)) view.messages = view.messages.map((message: { progress?: { status: string }; delivery?: string }) => ({ ...message, ...(message.progress?.status === 'running' ? { progress: { ...message.progress, status: 'paused' } } : {}), ...(message.delivery === 'sending' ? { delivery: 'unconfirmed' } : {}) }));
      const prepare = (artifact: GuiArtifactEntry) => { if (!('deferred' in artifact) && artifact.kind === 'html') delete artifact.previewUrl; return artifact; };
      if (Array.isArray(view.artifacts)) {
        view.artifacts = (view.artifacts as GuiArtifactEntry[]).map(prepare);
        artifacts.set(key, new Map((view.artifacts as GuiArtifactEntry[]).map(a => [a.id, a])));
      }
      if (view.artifactHistory && typeof view.artifactHistory === 'object') for (const [artifactId, versions] of Object.entries(view.artifactHistory)) {
        if (Array.isArray(versions)) {
          const prepared = versions.map(prepare);
          (view.artifactHistory as Record<string, GuiArtifactEntry[]>)[artifactId] = prepared;
          let owned = artifactVersions.get(key); if (!owned) { owned = new Map(); artifactVersions.set(key, owned); } owned.set(artifactId, prepared);
        }
      }
      return view;
    }
    if (action === 'history') {
      const snapshot = snapshots.get(key);
      if (!snapshot) throw Error('Panel is disconnected');
      const params = value as { historyPage?: boolean; query?: string; offset?: number; view?: Record<string, unknown> } | undefined;
      const paged = params?.historyPage === true;
      const view = paged ? params?.view : value;
      if (view && typeof view === 'object') snapshot.view = withPanelArtifacts(key, view as Record<string, unknown>);
      if (!paged || view) await archiveConversation(snapshot);
      const query = paged && typeof params?.query === 'string' ? params.query.toLowerCase() : '';
      const offset = paged && Number.isSafeInteger(params?.offset) && params!.offset! >= 0 ? params!.offset! : 0;
      const saved = await listConversations(snapshot, { query, limit: paged ? Number.MAX_SAFE_INTEGER : 100 });
      const page = (rows: { id: string; threadId?: string; title: string; updatedAt: number; current: boolean }[]) => paged ? { rows: rows.slice(offset, offset + 100), hasMore: rows.length > offset + 100 } : rows;
      const session = sessions.get(key)?.session;
      if (!session?.listConversations) return page(saved);
      try {
        const native = await session.listConversations();
        const savedThreads = new Set(saved.filter(row => typeof row.threadId === 'string').map(row => 'codex:' + row.threadId));
        return page([...saved, ...native.filter(row => !savedThreads.has(row.id) && row.title.toLowerCase().includes(query))].sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt)));
      } catch { return page(saved); }
    }
    if (action === 'switch-conversation') {
      searches.delete(key);
      const snapshot = snapshots.get(key);
      if (!snapshot) throw Error('Panel is disconnected');
      if (sessions.get(key)?.session.running) throw Error('Stop the current turn before switching conversations');
      const params = value as { conversationId?: string; view?: Record<string, unknown> };
      let next = { cwd: snapshot.cwd, configDir: snapshot.configDir, agent: snapshot.agent, view: {} } as typeof snapshot;
      if (params.conversationId?.startsWith('codex:')) {
        const session = sessions.get(key)?.session;
        if (!session?.readConversation || snapshot.agent !== 'codex') throw Error('Native history is unavailable for this harness');
        next = { ...next, ...await session.readConversation(params.conversationId.slice(6)) };
      } else if (params.conversationId) next = await readArchivedConversation(params.conversationId, snapshot, { lazyArtifacts: true });
      await panels.close(key, params.view ? withPanelArtifacts(key, params.view) : undefined);
      await saveConversation(id, next);
      return;
    }
    if (action === 'persist') {
      const snapshot = snapshots.get(key);
      if (!snapshot) throw Error('Conversation has not connected yet');
      snapshot.view = withPanelArtifacts(key, value as Record<string, unknown>);
      await saveConversation(id, snapshot);
      journals.get(key)?.acknowledge(Number(snapshot.view?.eventSequence || 0));
      return;
    }
    if (action === 'close' || action === 'retain-for-recovery') {
      searches.delete(key);
      if (action === 'retain-for-recovery') prepareGuiRendererRecovery(event.sender.id);
      if (!snapshots.has(key)) return;
      if (recoverablePanels.has(key) && sessions.has(key)) {
        const snapshot = snapshots.get(key)!;
        if (value && typeof value === 'object') snapshot.view = withPanelArtifacts(key, value as Record<string, unknown>);
        await saveConversation(id, snapshot);
        journals.get(key)?.acknowledge(Number(snapshot.view?.eventSequence || 0));
        return;
      }
      journals.delete(key);
      return panels.close(key, value && typeof value === 'object' ? withPanelArtifacts(key, value as Record<string, unknown>) : undefined);
    }
    if (action === 'connect' || action === 'reconnect') {
      let params = value as { cwd: string; configDir?: string; agent?: GuiAgentKind; unsafeMode?: boolean; view?: Record<string, unknown> };
      if (action === 'reconnect') {
        const saved = snapshots.get(key);
        if (!saved) throw Error('Reload the conversation before reconnecting');
        if (sessions.get(key)?.session.running) throw Error('Stop the current turn before reconnecting');
        if (params.view) saved.view = withPanelArtifacts(key, params.view);
        panels.disconnect(key);
        params = { ...params, cwd: saved.cwd, configDir: saved.configDir, agent: normalizeGuiAgent(saved.agent) };
      }
      if (recoverablePanels.has(key) && sessions.has(key)) {
        const current = sessions.get(key)!;
        const replay = journals.get(key)?.replay(Number(snapshots.get(key)?.view?.eventSequence || 0));
        for (const payload of replay?.events || []) event.sender.send('codex-gui:event', id, payload);
        const connected = journals.get(key)?.connectionLost !== true;
        event.sender.send('codex-gui:event', id, { method: 'aya/recovered', params: { connected, running: connected && current.session.running, truncated: replay?.truncated === true } });
        recoverablePanels.delete(key);
        if (!connected) { panels.disconnect(key); event.sender.send('codex-gui:event', id, { method: 'aya/disconnected', params: { message: 'The agent connection was lost while the interface was unavailable. Reconnect to resume the saved conversation.' } }); }
        return { connected, threadId: snapshots.get(key)?.threadId, model: current.model || current.agent };
      }
      if (sessions.has(key)) throw Error('Panel already connected');
      const agent = normalizeGuiAgent(params.agent);
      const cached = snapshots.get(key);
      if (cached && !matchesGuiBinding(cached, { ...params, agent })) panels.forget(key);
      if (!snapshots.has(key)) snapshots.set(key, { cwd: params.cwd, configDir: params.configDir, agent });
      const previous = snapshots.get(key); if (previous?.view) previous.view = { ...previous.view, eventSequence: 0 };
      event.sender.send('codex-gui:event', id, { method: 'aya/sessionEpoch', params: {} });
      const journal = new GuiRecoveryJournal(); journals.set(key, journal);
      const session = createGuiSession(agent, rawPayload => {
        if (panels.closing.has(key) || sessions.get(key)?.session !== session) return;
        const payload = journal.record(rawPayload);
        if (payload.method === 'aya/session' && typeof payload.params.threadId === 'string') { const snapshot = snapshots.get(key); if (snapshot) snapshot.threadId = payload.params.threadId; }
        if (payload.method === 'aya/artifact') {
          const artifact = payload.params.artifact as GuiArtifact;
          let owned = artifacts.get(key); if (!owned) { owned = new Map(); artifacts.set(key, owned); }
          owned.set(artifact.id, artifact);
          let versions = artifactVersions.get(key); if (!versions) { versions = new Map(); artifactVersions.set(key, versions); } versions.set(artifact.id, [...(versions.get(artifact.id) || []).slice(-9), artifact]);
        }
        if (!recoverablePanels.has(key) && !event.sender.isDestroyed()) { try { event.sender.send('codex-gui:event', id, payload); } catch { /* Renderer recovery replays this journal. */ } }
      });
      sessions.set(key, { session, cwd: params.cwd, agent });
      try {
        const saved = snapshots.get(key);
        const result = await session.connect(params.cwd, '', params.configDir?.trim().replace(/^(?:~|\$HOME)(?=\/|$)/, homedir()), (saved?.view?.importNotice || (Array.isArray(saved?.view?.messages) && saved.view.messages.some((m: { type?: string; delivery?: string }) => m.type !== 'goal' && m.type !== 'settings' && m.delivery !== 'failed'))) ? saved?.threadId : undefined, params.unsafeMode === true);
        const connected = sessions.get(key); if (connected) connected.model = result.model;
        session.restoreArtifacts([...(artifacts.get(key)?.values() || [])]);
        if (Array.isArray(saved?.view?.messages)) session.restoreProgress(saved.view.messages.filter((m: { progress?: unknown }) => !!m.progress).map((m: { progress: import('../shared/gui-progress').GuiProgress }) => m.progress));
        const snapshot = { ...saved, cwd: params.cwd, configDir: params.configDir, agent, threadId: result.threadId };
        snapshots.set(key, snapshot);
        await saveConversation(id, snapshot);
        return result;
      }
      catch (error) { panels.disconnect(key); throw error; }
    }
    const entry = sessions.get(key);
    const requestedArtifact = async () => {
      const request = typeof value === 'string' ? { id: value } : value as { id: string; revision?: number };
      const entry = panels.artifact(key, request?.id, request?.revision);
      return entry && 'deferred' in entry ? hydrateConversationArtifact(entry) : entry;
    };
    if (action === 'artifact-search') {
      const search = Symbol(); searches.set(key, search);
      const tokens = normalizeArtifactSearch(String(value).slice(0, 1000)).trim().split(/\s+/).filter(Boolean);
      const found: string[] = [];
      if (!tokens.length) { searches.delete(key); return [...artifacts.get(key)?.keys() || []]; }
      try {
        for (const entry of artifacts.get(key)?.values() || []) {
          if (searches.get(key) !== search) return [];
          try {
            const artifact = 'deferred' in entry ? await hydrateConversationArtifact(entry) : entry;
            const text = artifactSearchText(artifact);
            if (tokens.every(token => text.includes(token))) found.push(artifact.id);
          } catch { /* The picker still lists a damaged artifact; opening it shows its error. */ }
        }
        return found;
      } finally { if (searches.get(key) === search) searches.delete(key); }
    }
    if (action === 'artifact-content') {
      const artifact = await requestedArtifact();
      if (!artifact) throw Error('Artifact is no longer available');
      if (artifact.kind === 'image') {
        const ref = panels.artifact(key, artifact.id, artifact.revision);
        if (ref) {
          let images = imageReferences.get(event.sender.id); if (!images) { images = new Map(); imageReferences.set(event.sender.id, images); }
          images.set(createHash('sha256').update(artifact.dataUrl).digest('hex'), { key, id: artifact.id, revision: artifact.revision });
          if (images.size > 32) images.delete(images.keys().next().value!);
        }
      }
      return artifact;
    }
    if (action === 'artifact-preview') {
      const artifact = await requestedArtifact();
      if (artifact?.kind !== 'html') throw Error('This artifact has no widget preview');
      return widgetDocument(key, artifact.html);
    }
    if (action === 'open-artifact' || action === 'open-artifact-browser') {
      const artifact = await requestedArtifact();
      if (!artifact || (artifact.kind !== 'html' && artifact.kind !== 'image')) throw Error('This artifact has no browser preview');
      if (action === 'open-artifact' && artifact.kind === 'html') artifact.previewUrl = widgetDocument(key, artifact.html);
      if (action === 'open-artifact') { openArtifactWindow(artifact, event.sender, id, createWindow); return; }
      const escape = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
      const content = artifact.kind === 'html' ? artifact.html : `<img alt="${escape(artifact.title)}" src="${escape(artifact.dataUrl)}" style="max-width:100%;height:auto">`;
      const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><title>${escape(artifact.title)}</title><style>body{margin:0;padding:24px;background:#10151e;color:#dce3ef;font:14px system-ui}#aya-follow-up{position:fixed;bottom:16px;left:16px;right:16px;padding:12px;background:#1b2231;color:#dce3ef;white-space:pre-wrap;border:1px solid #b9a6f7;border-radius:8px}</style><script>window.ayaWidget=Object.freeze({suggest(text){let node=document.getElementById('aya-follow-up');if(!node){node=document.createElement('div');node.id='aya-follow-up';document.body.append(node)}node.textContent='Copy this suggestion into Aya:\\n'+String(text).slice(0,4000);}});</script></head><body>${content}</body></html>`;
      const file = path.join(AYA_HOME, 'artifact-previews', `${createHash('sha256').update(html).digest('hex')}.html`);
      await writeFileAtomic(file, html, 0o600);
      await openExternal(pathToFileURL(file).href);
      return;
    }
    if (action === 'save-artifact') {
      const artifact = await requestedArtifact();
      if (!artifact) throw Error('Artifact is no longer available');
      return saveGuiArtifact(artifact, event.sender);
    }
    if (!entry) throw Error('Panel is disconnected');
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
    if (action === 'paste-image') {
      const img = clipboard.readImage();
      if (img.isEmpty()) return null;
      const png = img.toPNG();
      if (!png.length) return null;
      const fileId = randomUUID();
      const dir = path.join(AYA_HOME, 'gui-attachments');
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, `${fileId}.png`);
      await fs.writeFile(file, png, { mode: 0o600 });
      let owned = attachments.get(key); if (!owned) { owned = new Map(); attachments.set(key, owned); }
      const item = { id: fileId, name: `clipboard-${fileId.slice(0, 8)}.png`, path: file, image: true };
      owned.set(item.id, item);
      return item;
    }
    if (action === 'send') {
      if (typeof value === 'string') return entry.session.send(value);
      const params = value as { text: string; model?: string; effort?: string; plan?: boolean; attachmentIds?: string[] };
      const files = (params.attachmentIds || []).map(id => { const file = attachments.get(key)?.get(id); if (!file) throw Error('Please reattach this file after reconnecting'); return file; });
      const text = params.text + (files.filter(f => !f.image).length ? '\n\nAttached files (selected by the user):\n' + files.filter(f => !f.image).map(f => JSON.stringify(f.path)).join('\n') : '');
      return entry.session.send(text, { model: params.model, effort: params.effort, ...(typeof params.plan === 'boolean' ? { plan: params.plan } : {}), images: files.filter(f => f.image).map(f => f.path) });
    }
    if (action === 'interrupt') return entry.session.interrupt();
    if (action === 'image') return workspaceImage(entry.cwd, String(value));
    if (action === 'command') { const p = value as { name: string; argument: string }; return entry.session.command(p.name, p.argument); }
    if (action === 'respond') { const p = value as { id: string | number; value: Parameters<CodexGuiSession['respond']>[1] }; return entry.session.respond(p.id, p.value); }
    throw Error('Unknown GUI action');
    };
    return ['load', 'connect', 'reconnect', 'persist', 'close', 'retain-for-recovery', 'history', 'switch-conversation'].includes(action) ? panels.run(key, perform) : perform();
  });
  app.on('before-quit', () => { for (const { session } of sessions.values()) session.close(); });
}
