import { randomUUID } from 'node:crypto';
import type { GuiProgress } from '../shared/gui-progress';
export const PROGRESS_TOOL = {
  type: 'function', name: 'aya_progress',
  description: 'Show a labeled progress bar for work with a measurable total, such as decompiling 10 functions. Report actual completed units, never an estimated percentage. Call once with current=0, then reuse the returned progressId to update the same bar. Use detail for the current stage. Finish with current=total, or status=paused/failed if work stops.',
  inputSchema: { type: 'object', properties: {
    progressId: { type: 'string', description: 'An ID previously returned by aya_progress; omit for a new task.' },
    label: { type: 'string', description: 'Short, human-readable task label.' },
    current: { type: 'number', description: 'Number of completed units.' },
    total: { type: 'number', description: 'Total units of work, greater than zero.' },
    detail: { type: 'string', description: 'Optional short description of the current stage.' },
    status: { type: 'string', enum: ['running', 'complete', 'paused', 'failed'] },
  }, required: ['label', 'current', 'total'], additionalProperties: false },
};
export function progressUpdate(raw: unknown, previous?: GuiProgress): GuiProgress {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('Progress must be an object');
  const value = raw as Record<string, unknown>;
  if (typeof value.label !== 'string' || !value.label.trim() || value.label.length > 200) throw Error('Progress label must contain 1–200 characters');
  if (typeof value.current !== 'number' || !Number.isFinite(value.current) || typeof value.total !== 'number' || !Number.isFinite(value.total) || value.current < 0 || value.total <= 0 || value.current > value.total || value.total > 1e12) throw Error('Progress must satisfy 0 ≤ current ≤ total, with a finite positive total');
  if (value.progressId !== undefined && (!previous || previous.id !== value.progressId)) throw Error('Unknown progressId; use the ID returned by aya_progress');
  if (value.detail !== undefined && (typeof value.detail !== 'string' || value.detail.length > 500)) throw Error('Progress detail must be text up to 500 characters');
  const status = value.status ?? (value.current === value.total ? 'complete' : 'running');
  if (!['running', 'complete', 'paused', 'failed'].includes(String(status))) throw Error('Invalid progress status');
  if (status === 'complete' && value.current !== value.total) throw Error('Complete progress must have current equal to total');
  return { id: previous?.id || randomUUID(), label: value.label.trim(), current: value.current, total: value.total, status: status as GuiProgress['status'], ...(typeof value.detail === 'string' ? { detail: value.detail } : {}) };
}
