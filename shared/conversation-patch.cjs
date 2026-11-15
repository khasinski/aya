function conversationPatch(previous, next, base) {
  const { messages, ...view } = next;
  if (!previous || !Array.isArray(messages) || !Array.isArray(previous.messages)) return next;
  const updates = [];
  for (let index = 0; index < messages.length; index++) {
    if (messages[index] !== previous.messages[index]) updates.push([index, messages[index]]);
  }
  return { $ayaViewPatch: 1, base, view, length: messages.length, updates };
}
function applyConversationPatch(previous, payload, revision) {
  if (!payload || typeof payload !== 'object' || payload.$ayaViewPatch !== 1) return payload;
  if (payload.base !== revision || !previous || !Array.isArray(previous.messages)) throw Error('Conversation save base changed');
  if (!Number.isSafeInteger(payload.length) || payload.length < 0 || !Array.isArray(payload.updates) || !payload.view || typeof payload.view !== 'object' || Array.isArray(payload.view)) throw Error('Invalid conversation patch');
  // Do not allocate a sparse array from an untrusted claimed length.
  const messages = previous.messages.slice(0, payload.length);
  const seen = new Set();
  for (const update of payload.updates) {
    if (!Array.isArray(update) || update.length !== 2) throw Error('Invalid message update');
    const [index, value] = update;
    if (!Number.isSafeInteger(index) || index < 0 || index >= payload.length || index > messages.length || seen.has(index) || !value || typeof value !== 'object') throw Error('Invalid message index');
    seen.add(index); messages[index] = value;
  }
  if (messages.length !== payload.length) throw Error('Incomplete conversation patch');
  return { ...payload.view, messages };
}
module.exports = { conversationPatch, applyConversationPatch };
