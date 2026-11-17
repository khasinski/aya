# Kanban column order

Adding a column to an existing Aya Board puts it at the end. To change the order,
use the left and right arrow buttons in each column header. The arrow at the
corresponding edge is disabled. The buttons also work with keyboard focus and
Enter or Space.

Agents can reorder columns through the CLI:

```sh
aya board column add Backlog
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

The Archive button opens the shelf, a drawer beside the board. It has an
Archive tab with the cards archived from the board, and a Backlog tab when the
backlog is on (see "Backlog"). With the Backlog tab the button reads
"Shelf (n)".

The shelf has its own search box. It uses the same query as the board filter
(text, `#label`, `@owner`, `p0`-`p3`, `col:name`) and narrows the shelf on top
of the board filter. The tab shows how many cards match, for example `1/2`.
The search does not filter the board itself.

## Backlog

Settings > Kanban > Backlog turns the backlog on for every project. The setting
is kept in `~/.aya/kanban.json`, which exists only while it is on. Each board has
one backlog:

| Setting | Backlog column on the board | Backlog |
|---|---|---|
| off | no | none; nothing mentions it |
| off | yes | none; the column is an ordinary column |
| on | no | the shelf: Move to backlog takes the card off the board into the Backlog tab |
| on | yes | the column: Move to backlog puts the card in the Backlog column; no Backlog tab |

Where the backlog is on, each card's menu has Move to backlog.

Until it is on, nothing an agent reads mentions the backlog. That covers the
board usage, `aya capabilities`, `aya board` and `aya board --json`.
`aya board backlog` fails like any unknown command, and nothing can be moved
into the backlog.

On the shelf, Move to backlog takes the card off the board. Like archiving, it
removes the card's claim and asks the pane that held it to stop. Moving a
claimed card into a Backlog column does the same, as any return to Backlog does.
Restore on the Backlog tab puts the card back at the end of its column, or in
the first column if that column was deleted.

Cards already off the board keep the Backlog tab showing, in every state. This
covers turning the setting off and adding a Backlog column later, so the user
never loses sight of them. Agents see them only while the backlog is on.

Where it is on, agents use `aya board backlog`:

```sh
aya board backlog            # list (--json for JSON)
aya board backlog t-12       # move a card off the board into the backlog
aya board backlog restore t-12
aya board remove t-12        # delete a backlog card
```

`aya board backlog` lists the Backlog column's cards and any cards off the
board. `aya board backlog <id>` moves a card to the board's backlog: the column
or the shelf. Where the backlog is on and cards are off the board, `aya board`
shows a Backlog line and `aya board --json` has a `backlogCards` list.

The backlog is not a column. A column named Backlog (for example from
`aya board column add Backlog`) is shown on the board, and the rules about
"Todo or Backlog" in this document mean that column. With the setting on, that
column is the board's backlog (see the table above). Without it, the board's
backlog is the shelf, which keeps cards off the board.

In the board file a backlog card stays in `cards` with `"shelf": "backlog"`. An
Aya version without the backlog ignores the field and shows the card on the
board, so the card is not lost. A board with no backlog cards is saved exactly
as before.

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
- Backlog (Settings > Kanban): off by default, with no `~/.aya/kanban.json` (`readBacklogSetting` and `backlogMode` in `electron/board.ts`). A Backlog column alone does not turn it on.
- New card: goes into the first column; priority and labels are optional and are omitted when not given; description starts empty; no assignee.
- Card description limit: 16,000 characters (`MAX_CARD_DESCRIPTION_CHARS`).
- Priorities: `low`, `medium`, `high`, `urgent`. Search tokens: `p0` = urgent, `p1` = high, `p2` = medium, `p3` = low.
