// A close can arrive while a view awaits its display, before main has a spawn
// flight to cancel. Once the request is sent, main's spawn gate owns it.
const pending = new Map<string, Set<() => void>>();
const closing = new Map<string, Set<symbol>>();

export function registerPendingTerminalAttach(id: string, cancel: () => void): () => void {
  const entries = pending.get(id) ?? new Set<() => void>();
  entries.add(cancel);
  pending.set(id, entries);
  if (closing.has(id)) cancel();
  return () => {
    entries.delete(cancel);
    if (!entries.size && pending.get(id) === entries) pending.delete(id);
  };
}

export function cancelPendingTerminalAttach(id: string): () => void {
  const token = Symbol(), attempts = closing.get(id) ?? new Set<symbol>();
  attempts.add(token); closing.set(id, attempts);
  for (const cancel of [...(pending.get(id) ?? [])]) cancel();
  return () => {
    attempts.delete(token);
    if (!attempts.size && closing.get(id) === attempts) closing.delete(id);
  };
}
