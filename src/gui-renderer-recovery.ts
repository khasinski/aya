// The error boundary marks recovery during commit, before passive session
// cleanup. GUI panels then retain their latest view instead of killing agents.
let recovering = false;
export function beginGuiRendererRecovery() { recovering = true; }
export function guiRendererRecoveryInProgress() { return recovering; }

const paneRecovery = new Set<string>();
export function beginGuiPaneRecovery(id: string) { paneRecovery.add(id); }
export function takeGuiPaneRecovery(id: string) { const pending = paneRecovery.has(id); paneRecovery.delete(id); return pending; }
