# Artifacts for TUI panes

The Conversation view shows artifacts in a drawer beside the messages (see `experimental-conversation-gui.md`). A pane
that only has a terminal gets the same four kinds through the `aya` CLI; each one opens in its own Aya window.

```
aya present --title <t> --html <file|->          # self-contained HTML/CSS/JS, up to 2 MiB, no network
aya present --title <t> --image <file>           # PNG, JPEG, WebP or SVG, up to 8 MiB
aya present --title <t> --table <json file|->    # {"columns":[...],"rows":[[...]]}, 12 columns, 200 rows
aya present --title <t> --metric <value> [--description <d>]
    [--id <artifact>]   update that artifact in place (its window reloads, revision +1)
    [--no-open]         store it without opening a window
aya artifact list [--json]
aya artifact open <id>
```

`-` reads the HTML or table JSON from stdin. `aya present` prints the artifact id. `aya capabilities` lists both
commands, so an agent running in a pane learns about them from there.

- HTML runs in the same isolated `aya-widget:` frame as in the Conversation view: no Node, filesystem, network or Aya
  API access. `window.ayaWidget.suggest(text)` copies the text to the clipboard (there is no conversation to receive it).
- A pane lists and opens only its own artifacts, and cannot update another pane's.
- Artifacts are kept in memory (the newest 100) and end when Aya quits; the Conversation view's saved history and
  version retention (ten revisions) do not apply here, and the window shows only the latest revision.
