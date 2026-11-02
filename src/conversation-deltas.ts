export interface TextDelta { id: string; text: string }
/** Merge a frame's deltas in one history traversal, retaining unchanged rows. */
export function appendMessageDeltas<T extends TextDelta>(messages: T[], deltas: readonly TextDelta[], create: (delta: TextDelta) => T): T[] {
  if (!deltas.length) return messages;
  const pending = new Map(deltas.map(delta => [delta.id, delta.text]));
  const next = messages.map(message => {
    const text = pending.get(message.id);
    if (text === undefined) return message;
    pending.delete(message.id);
    return { ...message, text: message.text + text };
  });
  for (const [id, text] of pending) next.push(create({ id, text }));
  return next;
}
export function createTextDeltaBuffer(receive: (deltas: TextDelta[]) => void, schedule: (flush: () => void) => () => void) {
  const pending = new Map<string, string[]>();
  let cancel: (() => void) | null = null;
  const flush = () => {
    cancel?.(); cancel = null;
    if (!pending.size) return;
    const deltas = [...pending].map(([id, chunks]) => ({ id, text: chunks.join('') }));
    pending.clear(); receive(deltas);
  };
  return {
    push(id: string, text: string) {
      if (!text) return;
      const chunks = pending.get(id);
      if (chunks) chunks.push(text); else pending.set(id, [text]);
      if (!cancel) cancel = schedule(flush);
    },
    flush,
  };
}
/** RAF may stop in a hidden window; the fallback still releases buffered text. */
export function scheduleConversationFrame(flush: () => void): () => void {
  const frame = requestAnimationFrame(flush);
  const timer = setTimeout(flush, 100);
  return () => { cancelAnimationFrame(frame); clearTimeout(timer); };
}
