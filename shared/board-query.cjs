// The board query language, used by the board filter and shelf search in the
// renderer and by `aya board search`: #label, label:/tag:, @owner,
// assignee:/owner:, p0-p3, p:/priority:, col:/column:, is:archived/in:archive,
// is:active/is:open, is:claimed, is:unassigned, and free text. Every token must
// match; an empty query matches every card. Users type these tokens, so changing
// one changes what their searches find.

const { PRIORITY_QUERY_TOKENS, PRIORITY_SHORT_TOKENS } = require("./board-priorities.cjs");

/** The prefixes and whole tokens of the language, by what they match. */
const QUERY_TOKENS = Object.freeze({
  labelMark: "#",
  labelPrefixes: Object.freeze(["label:", "tag:"]),
  ownerMark: "@",
  ownerPrefixes: Object.freeze(["assignee:", "owner:"]),
  priorityPrefixes: Object.freeze(["p:", "priority:"]),
  columnPrefixes: Object.freeze(["col:", "column:"]),
  archived: Object.freeze(["is:archived", "in:archive"]),
  active: Object.freeze(["is:active", "is:open"]),
  claimed: "is:claimed",
  unassigned: "is:unassigned",
});
exports.QUERY_TOKENS = QUERY_TOKENS;

const VALUE_SEPARATOR = ":";
const startsWithAny = (token, prefixes) => prefixes.some((prefix) => token.startsWith(prefix));
const valueOf = (token) => token.slice(token.indexOf(VALUE_SEPARATOR) + 1);
const hasLabel = (card, needle) => card.labels?.some((l) => l.toLowerCase().includes(needle)) ?? false;
const hasOwner = (card, needle) =>
  (card.assignee?.toLowerCase().includes(needle) ?? false) ||
  (card.claim?.paneName.toLowerCase().includes(needle) ?? false);

/** Whether `card` matches `query`. `isArchived` says whether the card is in the archive;
 *  without it, the card's archivedAt says. */
exports.matchesBoardQuery = (card, query, isArchived) => {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const archived = typeof isArchived === "boolean" ? isArchived : Boolean(card.archivedAt);
  const tokens = q.split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    if (token.startsWith(QUERY_TOKENS.labelMark) && token.length > QUERY_TOKENS.labelMark.length) {
      if (!hasLabel(card, token.slice(QUERY_TOKENS.labelMark.length))) return false;
      continue;
    }
    if (startsWithAny(token, QUERY_TOKENS.labelPrefixes)) {
      const needle = valueOf(token);
      if (needle && !hasLabel(card, needle)) return false;
      continue;
    }
    if (token.startsWith(QUERY_TOKENS.ownerMark) && token.length > QUERY_TOKENS.ownerMark.length) {
      if (!hasOwner(card, token.slice(QUERY_TOKENS.ownerMark.length))) return false;
      continue;
    }
    if (startsWithAny(token, QUERY_TOKENS.ownerPrefixes)) {
      const needle = valueOf(token);
      if (needle && !hasOwner(card, needle)) return false;
      continue;
    }
    if (PRIORITY_SHORT_TOKENS.includes(token)) {
      if (card.priority !== PRIORITY_QUERY_TOKENS[token]) return false;
      continue;
    }
    if (startsWithAny(token, QUERY_TOKENS.priorityPrefixes)) {
      // An empty priority token is ignored.
      const rawP = valueOf(token);
      if (rawP) {
        const mapped = PRIORITY_QUERY_TOKENS[rawP];
        if (mapped) {
          if (card.priority !== mapped) return false;
        } else if ((card.priority?.toLowerCase() ?? "") !== rawP) {
          return false;
        }
      }
      continue;
    }
    if (startsWithAny(token, QUERY_TOKENS.columnPrefixes)) {
      const needle = valueOf(token);
      if (needle && !card.columnId.toLowerCase().includes(needle)) return false;
      continue;
    }
    if (QUERY_TOKENS.archived.includes(token)) {
      if (!archived) return false;
      continue;
    }
    if (QUERY_TOKENS.active.includes(token)) {
      if (archived) return false;
      continue;
    }
    if (token === QUERY_TOKENS.claimed) {
      if (!card.claim) return false;
      continue;
    }
    if (token === QUERY_TOKENS.unassigned) {
      if (card.claim || card.assignee) return false;
      continue;
    }
    const matchesFreeText =
      card.id.toLowerCase().includes(token) ||
      card.title.toLowerCase().includes(token) ||
      (card.description?.toLowerCase().includes(token) ?? false) ||
      card.columnId.toLowerCase().includes(token) ||
      hasOwner(card, token) ||
      (card.priority?.toLowerCase().includes(token) ?? false) ||
      hasLabel(card, token);
    if (!matchesFreeText) return false;
  }
  return true;
};
