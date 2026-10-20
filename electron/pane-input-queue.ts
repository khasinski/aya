import { oneAtATime } from "./keyed-queue";

const serialize = oneAtATime();
const revisions = new Map<string, number>();

export function withPaneInputLock<T>(terminalId: string, work: () => Promise<T>): Promise<T> {
  return serialize(terminalId, work);
}

export function paneInputRevision(terminalId: string): number {
  return revisions.get(terminalId) ?? 0;
}

export function notePaneInput(terminalId: string): void {
  revisions.set(terminalId, paneInputRevision(terminalId) + 1);
}
