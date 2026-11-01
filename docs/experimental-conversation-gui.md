# Experimental Conversation GUI

In Settings → Presets, select a **Codex**, **Claude Code**, **Pi**, or **Antigravity** preset and enable **Conversation GUI · Experimental**. Open a new panel using that preset. Terminal remains the default. Each agent runs over its native structured local wire protocol while keeping ownership of its own tools, sandbox and permissions:

- **Codex (`codex`)**: `codex app-server --listen stdio://` (`CODEX_HOME`, dynamic tools `aya_present`, `aya_open_artifact`, `aya_progress`).
- **Pi (`pi`)**: `pi --mode rpc` (`PI_CODING_AGENT_DIR`, bundled Aya Pi extension registering `aya_present`, `aya_open_artifact`, `aya_progress` and interactive `extension_ui_request` tool approvals).
- **Claude Code (`claude`)**: `claude --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-prompt-tool=stdio` (`CLAUDE_CONFIG_DIR`, in-band SDK MCP server `aya` for `aya_present`, `aya_open_artifact`, `aya_progress` and `can_use_tool` interactive approvals/questions).
- **Antigravity (`agy`)**: `agy --input-format stream-json --output-format stream-json` (`ANTIGRAVITY_GEMINI_DIR`, `step_update` streaming, `denied_actions` permission prompts, `ask_question` prompts, and `aya_present` / `aya_open_artifact` / `aya_progress` tool steps).

## Conversation

Responses stream as Markdown. A status beneath the latest response distinguishes working, waiting for your answer, completed, interrupted and failed turns. Tool activity stays in one expandable section; native plan updates appear as a compact checklist above the composer. Reading earlier messages pauses automatic scrolling; **Jump to latest** returns to the current response.

Messages sent during a turn enter an editable queue. **Steer** sends a text follow-up into the current Codex turn; queued messages can also be steered, reordered or removed. Stop and reconnect hold the queue until you choose **Resume queue**. Model and reasoning options come from the installed Codex model catalog and apply to the next turn. Attach files and supported images with the + button. Images go through native Codex image input; other files are supplied as user-selected paths. Attachments awaiting delivery need reattaching after a reconnect.

Conversation history, drafts, pending queue, goal, selected artifact and artifact versions are saved locally under Aya's config directory. Reopening the same panel resumes its native Codex thread. An interrupted turn is not automatically reissued, and a recovered queue stays paused. A resumed session must use the same workspace and account configuration.

## Measured task progress

For tasks with measurable units, Codex is given the `aya_progress` tool. Call it with `label`, `current`, `total`, and optionally `detail`; it returns a `progressId`. Reuse that ID to update the existing bar. For example, decompiling ten functions can report 0/10, 4/10 and 10/10. Percentages are derived from these counts, never invented by Aya. Optional `status` is `running`, `complete`, `paused` or `failed`; completion requires current equal to total.

A running bar stays above the composer. Completed or stopped bars remain in conversation history. Ending a turn before the task is marked complete pauses its bar without changing the reported count. The tool is described in the GUI harness instructions; newly created Codex GUI threads receive it in their tool catalog.

## Artifacts

`aya_present` supports:

- `kind: "html"`, `title`, `html`: up to 2 MiB of self-contained HTML/CSS/JavaScript, including SVG and canvas. Scripts run in an isolated frame with no Node, filesystem, network or Aya API access. Embed dependencies and images instead of fetching them. `window.ayaWidget.suggest(text)` proposes a follow-up; the user reviews it and chooses **Add to message**, then sends it themselves.
- `kind: "image"`, `title`, `path`: PNG/JPEG/WebP/SVG files inside the workspace, up to 8 MiB, shown with zoom, keyboard panning and Fit. Unsupported or missing images show a visible error.
- `kind: "table"`, `title`, `columns`, `rows`: filterable tables with row follow-up suggestions.
- `kind: "metric"`, `title`, `value`, `description`: compact metric cards.

New artifacts keep the drawer closed by default. `open: true` opens and selects the result; `aya_open_artifact(artifactId)` reopens an existing artifact. Pass a previously returned `artifactId` to `aya_present` to update it. The latest ten versions are retained per artifact; reviewing an older version does not jump to a newer update.

Use **Previous/Next** (or Alt+Left/Right), title/content search, and the artifact picker to navigate. **Expand** fills the panel; Escape reduces it, then closes the drawer. HTML has Preview/Source tabs. HTML widgets and graphics can be saved or opened at the selected version:

- **Open window** creates a separate isolated Aya preview window. Widget suggestions still return to the conversation.
- **Open in browser** writes a standalone local preview and opens the system browser. In that standalone preview, widget actions show follow-up text to copy into Aya.

## Commands

Goal changes are also recorded as conversation entries; the goal bar shows a separate Active/Paused/Complete status and icon actions. Repeated token accounting updates do not duplicate goal entries.

- `/goal <objective>`, `/goal`, `/goal pause`, `/goal resume`, `/goal clear` use native thread goal operations with Codex; other adapters keep goal metadata in Aya.
- `/btw <question>` samples the completed thread context without adding a normal conversation turn. This experimental implementation requires an idle thread with a completed turn; it cannot yet answer while the main turn is running.
- `/compact` requests native context compaction.
- Unsupported commands show an explicit error. CLI-only features remain available through Terminal mode.

Current limitations: local harnesses only; custom command flags and unsafe mode are not applied (GUI uses workspace-write and on-request approvals); review, skills and MCP management are not exposed yet. Existing Codex session records remain managed by Codex. Local conversation snapshots are limited to 32 MiB each.

The built-in **Violet** appearance applies the GUI prototype palette to Aya chrome and terminal defaults. Select **Settings → General → Appearance → Violet** in either development or packaged Aya. This is a saved, optional color scheme alongside System, Light and Dark; switching back removes the palette overrides. Explicit per-tab terminal themes retain their own colors.

## Conversation history

Use the history icon or `/resume [search]` to choose a conversation. The picker is scoped to the current project, account and harness, with title search, dates and a current-conversation marker. Aya saves drafts, rendered messages, goals and artifacts locally; switching requires an idle turn with no pending approvals. Resumed queues are held for review.

Codex also lists native CLI history through app-server `thread/list` and reads conversation turns through `thread/read`. Native conversations retain their original tool catalog: start a new conversation to get the latest Aya widget/progress tools. Other adapters currently list conversations saved in Aya; their pre-existing CLI histories are not imported.

`/new` and `/clear` start a fresh conversation while keeping history. `/help` lists GUI commands, `/model [name]` selects an available model (or focuses the model picker), and `/status` shows current model, workspace, goal and queue state. Unknown commands produce an error rather than becoming a prompt. Escape closes the history picker and returns focus to the composer; Tab stays inside it.
