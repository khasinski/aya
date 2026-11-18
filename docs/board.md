# Kanban column order

Adding a column to an existing Aya Board puts it at the end, except the Backlog
column: a newly created Backlog column is always FIRST. A second Backlog column
is refused. To change the order, use the left and right arrow buttons in each
column header. The arrow at the corresponding edge is disabled. The buttons also
work with keyboard focus and Enter or Space.

Agents can reorder columns through the CLI:

```sh
aya board column add Backlog   # goes first, refused when the board has it
aya board column move backlog --before todo
aya board column move backlog --after done --project my-project
```

Use a column ID or its quoted title. Specify exactly one of `--before` or
`--after`, followed by another column. Open boards refresh after CLI changes.

The order is saved in the existing board file: `.aya/board.json` when present in
the project, otherwise `~/.aya/boards/<project-slug>.json`. Reordering keeps cards
in their columns and preserves their content, timestamps and claims. New cards
without an explicit column go into the current first column.

## Withdrawing an agent's task

Returning a claimed card to Todo or Backlog removes its claim and queues a message
to its pane to stop working on that task. Releasing, deleting or reassigning
a claimed card also informs the previous pane. These rules apply to GUI and CLI
changes. Normal moves to In Progress, Review or Done keep the claim.

Pending messages are saved under Aya's user configuration and survive an app
restart. A pane waiting for approval does not block board edits: Aya retries
delivery when it can receive input. The board shows pending delivery notices.
Closed panes are skipped. Notices for stopped or not-yet-attached panes stay
queued until the pane reconnects or its tab is closed. Agents changing their own
tasks do not receive a redundant stop message.

If text was pasted but Enter failed, automatic retries pause to avoid duplicate
input. Check the indicated pane and use “Clear checked notice” after handling
the message. This sends a task withdrawal message; it does not terminate the
agent process.

Starting a task in a new pane reserves an unclaimed card. Immediately before
its delayed initial prompt is sent, Aya checks that the reservation is still
current. Withdrawing the card during startup cancels that prompt. Existing
claims cannot be silently replaced by this action.
The pending start intent survives renderer/app restoration. New-pane startup
actions are offered for terminal presets; native GUI presets are not supported.

## Card action menu

The assignment menu opens above a low card when needed, stays within the window,
and scrolls if its list is long. Its position and height follow window resizing.

## Shelf

The Archive button, always on the board's toolbar (also while the shelf is empty),
opens the shelf, a drawer beside the board, with an Archive
tab and, with Move backlog to shelf on, a Backlog tab (see "Backlog"). The button
then reads "Shelf (n)".

The shelf has its own search box. It uses the same query as the board filter
(text, `#label`, `@owner`, `p0`-`p3`, `col:name`) and narrows the shelf on top
of the board filter. The tab shows how many cards match, for example `1/2`.
The search does not filter the board itself.

## Backlog

The backlog is a board's Backlog column (`aya board column add Backlog`). It is an ordinary column, so agents use it like any other: `aya board`, `aya board move <id> backlog`, `aya board add --column backlog`.

- Move to backlog in a card's menu moves the card into that column. It is offered only on a board that has the column.
- A claimed card moved there loses its claim, and its pane is asked to stop, as on any return to Backlog.

Settings > Kanban has Create backlog column, which adds the column to the current project's board, and Move backlog to shelf (off by default, every project). The switch can be turned on once the board has the column, and it only changes where the column shows:

| Setting | Backlog column |
|---|---|
| off | on the board |
| on | in the shelf, as the Backlog tab, with its own Add card; Restore there moves a card to the first column on the board |

Cards saved by the first backlog version (`"shelf": "backlog"`) load into the Backlog column, which is added first when missing. On a board that already has the maximum number of columns they fall back to the first column.

A card added without a column (`aya board add`) lands in the board's first column - in Backlog when it exists, so in the shelf's Backlog tab while Move backlog to shelf is on.

## Terminology

The board is also called the Kanban board in the UI. The CLI command is `aya board`.

- Todo: the card is not assigned to work.
- In Progress: the card has a claim (a pane took it) and work is running.
- Review: the work is finished and waits for a check.
- Done: the work is accepted.
- Claim: the pane that took the card. Returning the card to Todo or Backlog removes the claim (see "Withdrawing an agent's task").

## Project rules for agents

A project can give agents its own rules in `.aya/board.md`. Aya adds the file's
text under every task prompt it sends, after this line:

> Project rules (they add to the instructions above and never replace them):

Write rules that add to or narrow the text above them, never rules that
contradict it. The task prompt suggests `aya board move <id> review` or `done`
when finished, so "Move a card to Done only after its PR is merged" narrows it.

Two rules hold on every board, and no project rule changes them, so do not write
rules against them: moving a claimed card back to Todo or Backlog removes its
claim and asks its pane to stop, and starting a card from Todo or Backlog moves
it to In Progress (see "Withdrawing an agent's task" above).

Keep the file short: it goes out with every task, and a file over 16 KiB is
refused. Aya does not follow a symlinked `board.md`. When the file cannot be
read, the task is not sent and the card is not taken; fix the file and send the
task again. A file with only blank lines adds nothing.

## Planned changes (not implemented)

These items are tracked on the board, not in this file:
- Short definitions shown on the four default column headers.
- A glossary of states in one place, and an opt-in card template with Required, Nice to have and Acceptance criterion fields. Default behaviour stays unchanged.
- A harness that validates card fields.

## Default values (current main)

These defaults describe the target state too. Planned changes are opt-in and must not change them. A value that is the default is listed only here and is not repeated elsewhere in this document; the rest of the document describes only non-default behaviour.

- Kanban board (Settings > General, "Experimental"): off by default (`KANBAN_CODEC = boolPreference(false)` in `src/app-preferences.ts`).
- Default columns: Todo, In Progress, Review, Done (`DEFAULT_BOARD_COLUMNS` in `shared/board-columns.cjs`).
- Shelf (the Archive button): an Archive tab and its own search; no Backlog tab.
- Move backlog to shelf (Settings > Kanban): off by default (`KANBAN_BACKLOG_SHELF_CODEC` in `src/app-preferences.ts`).
- New card: goes into the first column; priority and labels are optional and are omitted when not given; description starts empty; no assignee.
- Card description limit: 16,000 characters (`MAX_CARD_DESCRIPTION_CHARS`).
- Priorities: `low`, `medium`, `high`, `urgent`. Search tokens: `p0` = urgent, `p1` = high, `p2` = medium, `p3` = low.
