// The card priorities: the value board files store and `aya board` accepts, the
// name the board shows, and the short name (P0-P3) on a card's badge. The board
// filter and `aya board search` take the short name, lowercased, or the value as
// a query token. Board files store the values, so changing one breaks existing boards.

/** Highest first, as the board lists them. */
const PRIORITY_OPTIONS = Object.freeze([
  Object.freeze({ value: "urgent", label: "Urgent", short: "P0" }),
  Object.freeze({ value: "high", label: "High", short: "P1" }),
  Object.freeze({ value: "medium", label: "Medium", short: "P2" }),
  Object.freeze({ value: "low", label: "Low", short: "P3" }),
]);
exports.PRIORITY_OPTIONS = PRIORITY_OPTIONS;

/** The values, lowest first, as `aya board` lists them. */
exports.PRIORITY_VALUES = Object.freeze(PRIORITY_OPTIONS.map((option) => option.value).reverse());

/** The short names as query tokens: p0-p3. */
const PRIORITY_SHORT_TOKENS = Object.freeze(PRIORITY_OPTIONS.map((option) => option.short.toLowerCase()));
exports.PRIORITY_SHORT_TOKENS = PRIORITY_SHORT_TOKENS;

/** Each query token that names a priority, short name or value, mapped to the value. */
exports.PRIORITY_QUERY_TOKENS = Object.freeze(Object.fromEntries(PRIORITY_OPTIONS.flatMap((option, rank) => [
  [PRIORITY_SHORT_TOKENS[rank], option.value],
  [option.value, option.value],
])));
