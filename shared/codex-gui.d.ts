export type GuiArtifact = (
  | { id: string; kind: 'table'; title: string; columns: string[]; rows: string[][] }
  | { id: string; kind: 'metric'; title: string; value: string; description: string }
  | { id: string; kind: 'html'; title: string; html: string; previewUrl?: string }
  | { id: string; kind: 'image'; title: string; path: string; dataUrl: string }) & { revision?: number };
export interface GuiEvent { method: string; params: Record<string, unknown>; id?: string | number }
