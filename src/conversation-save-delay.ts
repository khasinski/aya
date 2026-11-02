/** Debounce quiet edits, but continuous streaming must still save by 5 seconds. */
export function conversationSaveDelay(busy: boolean, lastSave: number, now = Date.now()): number {
  return Math.max(0, Math.min(busy ? 1500 : 250, 5000 - (now - lastSave)));
}
