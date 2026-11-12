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
