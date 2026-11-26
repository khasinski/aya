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
    [--asset <path>]    attach media used by JS; repeat for multiple files
aya artifact list [--json]
aya artifact open <id>
```

`-` reads the HTML or table JSON from stdin. `aya present` prints the artifact id. `aya capabilities` lists both
commands. The brief Aya gives an agent at launch ("Tell the agent about aya" in the preset; Claude, Codex, Grok,
opencode, Pi and Antigravity) has one line telling it to show charts, tables, diagrams, HTML reports, images and metrics
with `aya present`, never as ASCII art, so it presents without being asked to. The Conversation view's developer
instructions say the same for its `aya_present` tool.

A pane with artifacts shows an artifacts button (the Conversation view's cube icon with the count, labelled
"Artifacts (N)") in its header. It lists each artifact's title, kind, revision and time; choosing one opens its window.
An artifact stored with `--no-open`, or one that arrives while the pane is not focused, colours the button until the
list is opened.

HTML can contain `<video controls src="./demo.mp4">`, WebM sources, audio, captions and local video posters.
Aya copies these files into the artifact automatically. Paths resolve beside the HTML file; for stdin they resolve from
the CLI's working directory. Use `--asset clip.mp4` plus `window.ayaWidget.asset('clip.mp4')` for a JS-created player.
Media is streamed separately from the HTML, with seeking support; each file can be up to 256 MiB, with 32 files and
512 MiB total per artifact. External media and iframe players stay blocked.

- HTML runs in the same isolated `aya-widget:` frame as in the Conversation view: no Node, filesystem, network or Aya
  API access. `window.ayaWidget.suggest(text)` copies the text to the clipboard (there is no conversation to receive it).
- A pane lists and opens only its own artifacts, and cannot update another pane's.
- Artifacts are kept on disk per pane under `AYA_HOME/tui-artifacts/` (the pane's newest 50, in at most 32 MiB) and
  come back after Aya restarts; Aya holds the newest 100 across all panes. A closed pane's artifacts are removed a
  week after its last one. Only the latest revision is kept (the Conversation view's ten-revision history does not
  apply), and the window shows that revision.
- Main-process code can read a pane's artifacts with `paneTuiArtifacts(terminalId)` (electron/tui-artifacts.ts): full
  `GuiArtifact`s, newest first, as the Conversation view's artifact drawer takes them.
