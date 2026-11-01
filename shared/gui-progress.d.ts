export interface GuiProgress {
  id: string;
  label: string;
  current: number;
  total: number;
  status: 'running' | 'complete' | 'paused' | 'failed';
  detail?: string;
}
