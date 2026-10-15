export interface CellRuns { text: string; flags: number[][]; attrs: number[][] }
export function encodeCellRuns(words: Uint32Array, length: number): CellRuns | null;
export function decodeCellRuns(value: unknown, length: number): Uint32Array;
