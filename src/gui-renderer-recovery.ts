// The error boundary marks recovery during commit, before passive session
// cleanup. GUI panels then retain their latest view instead of killing agents.
let recovering = false;
export function beginGuiRendererRecovery() { recovering = true; }
export function guiRendererRecoveryInProgress() { return recovering; }
