import type { GuiArtifact } from '../shared/codex-gui';
import type { GuiAgentKind, GuiSessionInstance } from './codex-gui-session';
import type { ConversationSnapshot } from './gui-conversation-store';
export interface GuiBinding { cwd: string; configDir?: string; agent?: GuiAgentKind }
export interface GuiAttachment { id: string; name: string; path: string; image: boolean }
export function matchesGuiBinding(snapshot: ConversationSnapshot | undefined | null, binding: GuiBinding): snapshot is ConversationSnapshot {
  return !!snapshot && snapshot.cwd === binding.cwd && snapshot.configDir === binding.configDir && (snapshot.agent || 'codex') === (binding.agent || 'codex');
}
/** Owns all memory retained by a panel. Lifecycle actions are ordered so a late
 * save/close cannot race the next load or connection for that panel. */
export class GuiPanelState {
  readonly artifacts = new Map<string, Map<string, GuiArtifact>>();
  readonly artifactVersions = new Map<string, Map<string, GuiArtifact[]>>();
  readonly sessions = new Map<string, { session: GuiSessionInstance; cwd: string; agent: GuiAgentKind }>();
  readonly snapshots = new Map<string, ConversationSnapshot>();
  readonly attachments = new Map<string, Map<string, GuiAttachment>>();
  readonly closing = new Set<string>();
  private pending = new Map<string, Promise<unknown>>();
  constructor(private save: (id: string, snapshot: ConversationSnapshot) => Promise<void>, private clearDocuments: (key: string) => void) {}
  run<T>(key: string, action: () => Promise<T>): Promise<T> {
    const task = (this.pending.get(key) || Promise.resolve()).catch(() => {}).then(action);
    this.pending.set(key, task);
    void task.finally(() => { if (this.pending.get(key) === task) this.pending.delete(key); }).catch(() => {});
    return task;
  }
  forget(key: string) {
    this.sessions.delete(key);
    this.snapshots.delete(key);
    this.attachments.delete(key);
    this.artifacts.delete(key);
    this.artifactVersions.delete(key);
    this.clearDocuments(key);
    this.closing.delete(key);
  }
  async close(key: string, finalView?: Record<string, unknown>) {
    this.closing.add(key);
    try {
      this.sessions.get(key)?.session.close();
      const snapshot = this.snapshots.get(key);
      if (snapshot) {
        if (finalView) snapshot.view = finalView;
        await this.save(key.slice(key.indexOf(':') + 1), snapshot);
      }
    } finally { this.forget(key); }
  }
  async closeOwner(ownerId: number) {
    const keys = new Set([...this.sessions.keys(), ...this.snapshots.keys(), ...this.attachments.keys(), ...this.artifacts.keys(), ...this.artifactVersions.keys(), ...this.pending.keys()]);
    return Promise.allSettled([...keys].filter(key => key.startsWith(`${ownerId}:`)).map(key => this.run(key, () => this.close(key))));
  }
}
