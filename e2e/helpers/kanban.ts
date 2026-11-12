/** Dense boards are the normal GUI contract: every column scrolls and carries metadata. */
export function populatedBoard(cardsPerColumn = 8, extraColumns = false) {
  const columns = [
    { id: "todo", title: "Todo" }, { id: "in-progress", title: "In Progress" },
    { id: "review", title: "Review" }, { id: "done", title: "Done" },
    ...(extraColumns ? [{ id: "backlog", title: "Backlog" }, { id: "on-hold", title: "On Hold" }, { id: "blocked", title: "Blocked" }] : []),
  ];
  const cards = columns.flatMap((column, columnIndex) => Array.from({ length: cardsPerColumn }, (_, index) => ({
    id: `t-${columnIndex * cardsPerColumn + index + 1}`,
    title: `${column.title}: task ${index + 1} with a realistic descriptive title`,
    description: "A detailed task with enough context to fill the card.\nKeep the existing implementation and test its state transitions.\nAcceptance: preserve all other cards, descriptions, assignments and dates.",
    columnId: column.id,
    createdAt: "2026-11-12T10:00:00.000Z", updatedAt: "2026-11-12T10:00:00.000Z",
    ...(index % 3 === 1 ? { assignee: `Planned owner ${index + 1}` } : {}),
    ...(index % 4 === 2 ? { claim: { paneId: `existing-owner-${columnIndex}-${index}`, paneName: `Owner ${index + 1}`, since: "2026-11-12T10:10:00.000Z" } } : {}),
  })));
  return { version: 1 as const, columns, cards };
}
