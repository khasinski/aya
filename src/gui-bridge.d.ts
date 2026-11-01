import type { GuiEvent } from '../shared/codex-gui';
declare global { interface Window { ayaGui?: { invoke(id: string, action: string, value?: unknown): Promise<unknown>; onEvent(id: string, callback: (value: GuiEvent) => void): () => void } } }
