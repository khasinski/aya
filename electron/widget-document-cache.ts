const MIB = 1024 * 1024;
export class WidgetDocumentCache {
  private documents = new Map<string, { owner: string; html: string; bytes: number }>();
  private owners = new Map<string, { tokens: Set<string>; bytes: number }>();
  private bytes = 0;
  constructor(private perOwnerLimit = 32 * MIB, private totalLimit = 128 * MIB) {
    if (![perOwnerLimit, totalLimit].every(limit => Number.isSafeInteger(limit) && limit > 0)) throw new RangeError('Invalid widget cache budget');
  }
  get(token: string): Readonly<{ owner: string; html: string }> | undefined {
    const entry = this.documents.get(token);
    if (!entry) return;
    this.documents.delete(token); this.documents.set(token, entry);
    const owner = this.owners.get(entry.owner)!;
    owner.tokens.delete(token); owner.tokens.add(token);
    return entry;
  }
  set(token: string, owner: string, html: string): void {
    const bytes = Buffer.byteLength(html);
    if (bytes > Math.min(this.perOwnerLimit, this.totalLimit)) throw Error('Widget exceeds the preview cache budget');
    this.delete(token);
    let state = this.owners.get(owner);
    if (!state) { state = { tokens: new Set(), bytes: 0 }; this.owners.set(owner, state); }
    state.tokens.add(token); state.bytes += bytes; this.bytes += bytes;
    this.documents.set(token, { owner, html, bytes });
    while (state.bytes > this.perOwnerLimit) this.delete(state.tokens.values().next().value!);
    while (this.bytes > this.totalLimit) this.delete(this.documents.keys().next().value!);
  }
  private delete(token: string): void {
    const entry = this.documents.get(token); if (!entry) return;
    this.documents.delete(token); this.bytes -= entry.bytes;
    const owner = this.owners.get(entry.owner)!;
    owner.tokens.delete(token); owner.bytes -= entry.bytes;
    if (!owner.tokens.size) this.owners.delete(entry.owner);
  }
  clearOwner(owner: string): void {
    const state = this.owners.get(owner);
    if (state) for (const token of state.tokens) this.delete(token);
  }
  stats() { return { bytes: this.bytes, documents: this.documents.size, owners: this.owners.size }; }
}
