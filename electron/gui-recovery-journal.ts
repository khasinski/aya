import type { GuiEvent } from '../shared/codex-gui';
/** Only updates not yet acknowledged by a saved renderer snapshot are retained.
 * Approvals have a separate bounded current-state set, so a long crash cannot
 * strand a running agent behind an approval dropped from the text journal. */
export class GuiRecoveryJournal {
  private events: { event: GuiEvent; bytes: number }[] = [];
  private requests = new Map<string | number, GuiEvent>();
  private requestBytes = new Map<string | number, number>();
  private bytes = 0;
  private sequence = 0;
  private droppedThrough = 0;
  private goal: GuiEvent | null = null;
  private progress = new Map<string, GuiEvent>();
  private opened: GuiEvent | null = null;
  private lost = false;
  get connectionLost() { return this.lost; }
  record(value: GuiEvent): GuiEvent {
    const event = { ...value, sequence: ++this.sequence };
    if (event.method === 'aya/disconnected') this.lost = true;
    if (event.method === 'thread/goal/updated' || event.method === 'thread/goal/cleared') this.goal = event;
    if (event.method === 'aya/progress') {
      const id = String((event.params.progress as { id?: unknown } | undefined)?.id || '');
      this.progress.set(id, event); if (this.progress.size > 128) this.progress.delete(this.progress.keys().next().value!);
    }
    if (event.method === 'aya/openArtifact') this.opened = event;
    if (event.method === 'aya/artifact' && event.params.open === true) this.opened = { method: 'aya/openArtifact', sequence: event.sequence, params: { artifactId: (event.params.artifact as { id?: string })?.id } };
    if (event.id !== undefined) {
      const size = Buffer.byteLength(JSON.stringify(event));
      const retained = [...this.requestBytes.values()].reduce((sum, bytes) => sum + bytes, 0) - (this.requestBytes.get(event.id) || 0);
      if ((!this.requests.has(event.id) && this.requests.size >= 128) || retained + size > 4 * 1024 * 1024) throw Error('Agent exceeded the pending approval/question recovery limit; reconnect the session');
      this.requests.set(event.id, event); this.requestBytes.set(event.id, size);
    }
    if (event.method === 'aya/requestResolved' || event.method === 'serverRequest/resolved') { const id = (event.params.id ?? event.params.requestId) as string | number; this.requests.delete(id); this.requestBytes.delete(id); }
    if (event.method === 'turn/completed' || event.method === 'aya/disconnected') { this.requests.clear(); this.requestBytes.clear(); }
    // Artifacts are restored from the panel's current metadata/library instead.
    if (event.method === 'aya/artifact' || event.method === 'aya/openArtifact') return event;
    const bytes = Buffer.byteLength(JSON.stringify(event));
    this.events.push({ event, bytes }); this.bytes += bytes;
    while (this.bytes > 2 * 1024 * 1024 || this.events.length > 2048) {
      const first = this.events.shift()!; this.bytes -= first.bytes; this.droppedThrough = first.event.sequence!;
    }
    return event;
  }
  acknowledge(sequence: number) {
    if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > this.sequence) return;
    while (this.events[0] && this.events[0].event.sequence! <= sequence) this.bytes -= this.events.shift()!.bytes;
  }
  replay(after: number): { events: GuiEvent[]; truncated: boolean } {
    if (!Number.isSafeInteger(after) || after < 0 || after > this.sequence) after = 0;
    return { events: [...this.events.filter(({ event }) => event.sequence! > after).map(({ event }) => event), ...(this.goal ? [this.goal] : []), ...this.progress.values(), ...this.requests.values(), ...(this.opened && this.opened.sequence! > after ? [this.opened] : [])], truncated: after < this.droppedThrough };
  }
}
