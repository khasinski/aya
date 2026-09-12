# Aya Standout Features Report

Date: 2026-05-27

## Executive Summary

Aya should not compete head-on as another worktree kanban, parallel-agent
dashboard, or Claude-specific desktop shell. That space is already crowded and
well-funded. Aya's credible wedge is narrower and stronger:

> A free, open-source, project-first workspace for real long-lived terminal
> agents.

The best standout features should deepen that identity:

- Make long-lived PTYs more useful than disposable sessions.
- Make project switching feel smarter than tab switching.
- Make agent attention visible without scraping private provider state.
- Make `aya .` and local control hooks a lightweight integration surface.
- Keep worktrees optional, not ideological.

The highest-potential roadmap themes are:

1. **Project memory from terminal evidence**: local, searchable, user-visible
   notes extracted from terminal output and commands.
2. **Session timeline and receipts**: a compact history of what happened in a
   project across real PTYs.
3. **Agent attention center**: one place to see waiting, active, failed, and
   stale terminals across all projects.
4. **Shareable project presets**: repo-local `.aya/` profiles for teams and
   open-source projects.
5. **Optional worktree awareness**: detect and organize worktrees without
   becoming a worktree manager.
6. **Harness skills marketplace**: installable Claude/Codex/Aider skills that
   teach agents how to update Aya status and notifications.

## Current Aya Baseline

Current repo evidence:

- README positions Aya as project-first, long-lived PTYs, agent-agnostic, and
  terminal-native via `aya`.
- `bin/aya` already opens projects and exposes control commands:
  `focus`, `notify`, and `status`.
- `skills/aya-control/SKILL.md` already defines safe harness behavior and
  guardrails.
- `electron/control.ts` already exposes a local socket for open/focus/notify
  and status updates.
- Tests cover launch safety, IPC validation, config normalization, preset
  normalization, PTY buffer behavior, harness defaults, and theme import.

Aya already has a meaningful foundation. The missing layer is not "more agent
support"; it is making the project workspace feel alive and uniquely useful.

## Market Context

The market is moving toward three dominant patterns:

- **Worktree dashboards**: Conductor, Nimbalyst/Crystal, Emdash, dmux, and many
  smaller tools focus on parallel agents in isolated git worktrees.
- **Official app surfaces**: Claude Code Desktop and Codex app are expanding
  into multi-session coordination and first-party workflows.
- **Terminal/tmux wrappers**: Claude Squad-style tools and newer tmux wrappers
  manage multiple real PTYs, often with worktree isolation.

Relevant public references:

- Claude Code docs now include worktree and hook surfaces:
  https://code.claude.com/docs/en/worktrees and
  https://code.claude.com/docs/en/hooks
- Claude help center recommends parallel Claude sessions and worktrees:
  https://support.claude.com/en/articles/14554000-claude-code-power-user-tips
- OpenAI Codex CLI remains a local terminal agent:
  https://github.com/openai/codex
- Emdash describes itself as an open-source ADE for multiple agents in isolated
  git worktrees:
  https://docs.emdash.sh/
- Nimbalyst is an open-source visual workspace with sessions, tasks, worktrees,
  review, and iOS:
  https://nimbalyst.com/
- dmux positions around tmux + git worktrees:
  https://dmux.ai/

Conclusion: "multi-agent support", "notifications", "worktrees", and "visual
session dashboard" are not enough. Aya needs features competitors are unlikely
to prioritize because they are too committed to task/worktree orchestration.

## Feature Opportunities

### 1. Project Memory From Terminal Evidence

**Idea**

Build a local project memory layer from terminal evidence:

- Commands run in shells.
- Agent-visible status updates via `aya status`.
- Selected PTY output snippets.
- User-pinned notes.
- Project paths, branches, and terminal names.

Expose it through search and a compact project memory panel. Do not
automatically summarize private chats through a cloud model. Keep it local and
inspectable.

**Why it could stand out**

Competitors emphasize running many agents. Aya can become the place that
remembers what happened across real project sessions. This fits the
"long-lived PTY" identity: a session from Monday is useful on Wednesday because
its evidence remains searchable and organized.

**Potential UX**

- `Pin to project memory` from terminal selection.
- Auto-captured command receipts: `npm test`, `git status`, `rails db:migrate`.
- Search result type: `Memory`.
- Project drawer section: `Recent facts`.
- Optional local-only summarization later, behind a clear setting.

**Feasibility**

- Effort: Medium.
- Technical risk: Medium.
- Privacy risk: Medium unless capture is conservative and visible.
- Dependencies: PTY buffer, search indexing, local config storage.

**Implementation path**

1. Add explicit pinning of selected terminal text to project memory.
2. Add command-line receipt capture for shell prompts if reliable enough, or
   start with `aya status done/error` events only.
3. Index memory entries in the existing global search.
4. Add retention controls per project.

**Risks**

- Automatic capture can feel creepy.
- Prompt detection varies by shell.
- The feature becomes less trustworthy if it invents summaries.

**Verdict**

High priority. This is a strong differentiator if kept local, explicit, and
search-first.

### 2. Session Timeline And Receipts

**Idea**

Each project gets a chronological timeline:

- Terminals opened/closed/restarted.
- Agent status changes.
- Notifications.
- Exit codes.
- Important commands.
- User-pinned PTY snippets.

This is not a transcript viewer. It is a project activity log.

**Why it could stand out**

Worktree dashboards show task cards. Aya can show what actually happened inside
a project across all long-lived PTYs. That is more aligned with solo dev/client
work than kanban orchestration.

**Potential UX**

- Small clock/history icon in the project status bar.
- Timeline rows: `Codex: tests failed`, `Shell: npm run build passed`,
  `Claude Code: waiting for approval`.
- Click row to focus the terminal and scroll near the event if possible.

**Feasibility**

- Effort: Medium.
- Technical risk: Low to Medium.
- Privacy risk: Low if event payloads are short and local.
- Dependencies: control status events, terminal lifecycle events, local storage.

**Implementation path**

1. Store bounded project events in each project config or a separate event log.
2. Append events from existing terminal lifecycle and control socket.
3. Render timeline in a drawer or modal.
4. Add search indexing for event titles.

**Risks**

- Too many noisy events.
- Needs clear retention policy.
- Requires careful UI restraint.

**Verdict**

High priority. Easier than full memory, and it immediately reinforces Aya's
long-lived project workspace identity.

### 3. Attention Center Across Projects

**Idea**

A global panel showing terminals that need attention, are active, errored, or
stale:

- Waiting for approval.
- Failed spawn.
- Exited with non-zero code.
- Last activity older than N hours/days.
- Agent-provided status via `aya status`.

**Why it could stand out**

Users juggling repos need to know where to look. A single attention center is
more project-first than a session dashboard and less invasive than scraping
agent internals.

**Potential UX**

- Click the status area or use a shortcut.
- Rows grouped by project.
- Each row has terminal name, status text, last activity, and one action:
  `Focus`.

**Feasibility**

- Effort: Low to Medium.
- Technical risk: Low.
- Privacy risk: Low.
- Dependencies: existing terminal status, bell heuristic, last activity, control
  status.

**Implementation path**

1. Normalize terminal status into one selector.
2. Add attention panel.
3. Add global shortcut/search integration.
4. Optionally add filters: Waiting, Failed, Stale.

**Risks**

- If heuristics are wrong, trust drops.
- UI can become another noisy dashboard.

**Verdict**

High priority. It is practical, visible, and aligned with existing work.

### 4. Shareable Project Presets

**Idea**

Support repo-local Aya configuration:

```text
.aya/
  project.json
  presets.json
  skills/
```

This would let a repo suggest launchers such as:

- `Claude Code`
- `Codex`
- `Rails console`
- `Run tests`
- `Local server`
- `Docs watcher`

Aya should prompt before importing anything from a repo.

**Why it could stand out**

This turns Aya into a tool open-source projects can recommend: "clone repo, run
`aya .`, get the project workspace." That is a popularity lever because it can
spread through repos, not ads.

**Potential UX**

- On `aya .`, detect `.aya/project.json`.
- Show a compact trust prompt: project name, launchers, env var names, commands.
- Allow `Import`, `Inspect`, `Ignore`.
- Imported presets remain editable.

**Feasibility**

- Effort: Medium.
- Technical risk: Medium.
- Security risk: Medium to High if commands are auto-run. Low if import-only and
  explicit.
- Dependencies: preset normalization, command validation, trust UI.

**Implementation path**

1. Define a minimal schema for repo-local preset suggestions.
2. Validate and display commands before import.
3. Never auto-run imported commands.
4. Add export current project as `.aya/project.json`.

**Risks**

- Malicious repos can suggest dangerous commands.
- Needs strong trust boundary and plain-language inspection.

**Verdict**

Very high upside. This is one of the best popularity features if security is
handled well.

### 5. Optional Worktree Awareness, Not Worktree Management

**Idea**

Detect when the current project has sibling git worktrees and show them as
related projects. Do not create, merge, or manage them initially.

**Why it could stand out**

This avoids sounding anti-worktree while preserving Aya's identity. Users who
already use `git worktree`, Claude `--worktree`, or another tool can still use
Aya as the project workspace.

**Potential UX**

- Project tab context menu: `Related worktrees`.
- Search results include worktree paths.
- `aya .` from a worktree opens it as its own project, linked to the main repo.

**Feasibility**

- Effort: Low to Medium.
- Technical risk: Low.
- Privacy risk: Low.
- Dependencies: git worktree parsing via `git worktree list --porcelain`.

**Implementation path**

1. Add git helper for worktree discovery.
2. Store relation metadata in project state.
3. Show related worktrees in search and project menu.

**Risks**

- Users may expect full worktree lifecycle management.
- Needs careful copy: "Aya detects worktrees; it does not own them."

**Verdict**

Medium priority. Good positioning fix, not the main wedge.

### 6. Harness Skills Marketplace

**Idea**

Ship installable skills/hooks for Claude Code, Codex, Aider, and other
harnesses that teach them to use Aya's local CLI:

- Set status before long tasks.
- Mark waiting when blocked.
- Notify on completion.
- Open/focus projects.
- Add timeline receipts.

This should be a local folder installer, not a cloud marketplace at first.

**Why it could stand out**

Aya can become the desktop app that agents know how to talk to without Aya
needing private integrations. This is especially attractive because it respects
Claude Code subscription boundaries.

**Potential UX**

- Settings: `Install Aya skill for Claude Code`.
- Per-harness install status.
- Preview of what the skill can do.
- One-click copy/open install folder if automatic install is unsafe.

**Feasibility**

- Effort: Medium.
- Technical risk: Medium because harness skill formats differ.
- Subscription/policy risk: Low if it only uses public CLI/status commands.
- Dependencies: existing `skills/aya-control`, CLI install status.

**Implementation path**

1. Expand the existing skill into versioned templates.
2. Add Settings UI for install/update/remove.
3. Detect installed skill versions.
4. Document guardrails clearly.

**Risks**

- Claude/Codex skill APIs may change.
- Installing into user agent config needs user trust.

**Verdict**

High priority. It is unique to Aya's "agents coordinate through local CLI"
angle and can create shareable developer delight.

### 7. Local "Agent Runbook" Per Project

**Idea**

A project-specific runbook that agents and humans can use:

- Common commands.
- Test command.
- Dev server command.
- Branch policy.
- Known gotchas.
- Preferred harnesses.

Aya can expose this to humans and optionally install it as context for harness
skills.

**Why it could stand out**

Many agent failures come from missing project context. Aya can own this context
at the project level without becoming an IDE.

**Potential UX**

- `Project Runbook` editor in Settings or project menu.
- Buttons: `Add from package.json`, `Add current command`.
- Search result: runbook commands.
- Export to `.aya/project.json`.

**Feasibility**

- Effort: Medium.
- Technical risk: Low.
- Privacy risk: Low.
- Dependencies: project config, preset UI.

**Implementation path**

1. Add runbook model to project config.
2. Add small editor.
3. Add "promote terminal command to runbook" action.
4. Integrate with project presets and search.

**Risks**

- Could overlap with README/CLAUDE.md.
- Needs to stay concise.

**Verdict**

Medium to high priority. Strong if paired with shareable presets.

### 8. Terminal URL And Preview Workflows

**Idea**

Aya already plans/has clickable HTTP/HTTPS URLs. Extend this into a "local
preview" layer:

- Detect localhost URLs.
- Show them in project status.
- Optional mini browser popover.
- Remember last preview URL per project.
- Let agents set preview URL with `aya status set-url`.

**Why it could stand out**

Coding agents often start servers and ask users to inspect them. Aya can bridge
terminal output and browser inspection without becoming a full IDE.

**Potential UX**

- Status bar chip: `localhost:5173`.
- Click opens browser.
- Hover shows source terminal and timestamp.

**Feasibility**

- Effort: Low to Medium.
- Technical risk: Low.
- Security/privacy risk: Low if only user-click opens.
- Dependencies: URL detection in PTY output, status bar.

**Implementation path**

1. Capture URLs from PTY output.
2. Store per-terminal recent links.
3. Add project-level preview chip.
4. Add optional `aya preview set URL`.

**Risks**

- Too many URLs.
- Avoid auto-opening anything.

**Verdict**

Medium priority. Simple, useful, and demo-friendly.

### 9. "Resume Where I Left Off" Daily View

**Idea**

On app launch, show a lightweight resume view if multiple projects have recent
activity:

- Last active projects.
- Terminals waiting.
- Recent receipts.
- Stale sessions.

This should be dismissible and should not replace the project UI once projects
exist.

**Why it could stand out**

Aya's target user returns to client/project work across days. A good resume
surface makes long-lived sessions feel intentional.

**Feasibility**

- Effort: Medium.
- Technical risk: Low.
- Privacy risk: Low.
- Dependencies: session timeline, last activity.

**Implementation path**

1. Build after timeline/attention center.
2. Show only when useful, with a permanent dismiss option.
3. Keep actions to `Open`, `Focus waiting`, `Dismiss`.

**Risks**

- Can feel like onboarding clutter if always shown.
- Depends on timeline quality.

**Verdict**

Medium priority. Do later, once the underlying event model exists.

### 10. Read-Only Remote Watch Mode

**Idea**

Let users monitor Aya status from another machine or phone on the same network,
without remote command execution:

- Waiting terminals.
- Recent done/error statuses.
- Notifications.
- Focus/open instructions as deep links when local.

This could be a local web view or eventually a tiny companion app.

**Why it could stand out**

Nimbalyst has iOS. Remote monitoring is attractive, but a full remote-control
story is expensive. A read-only mode gives much of the utility with less risk.

**Feasibility**

- Effort: High.
- Technical risk: Medium.
- Security risk: High if exposed poorly.
- Dependencies: auth token, local server, status model.

**Implementation path**

1. Do not start here.
2. First build attention center and timeline.
3. Add opt-in local-only web server with pairing token.
4. Keep it read-only initially.

**Risks**

- Security surface.
- Support burden across networks.
- Easy to overbuild.

**Verdict**

Interesting but not immediate. Revisit after Aya has stronger core adoption.

## Prioritization

### Build First

1. Attention center across projects.
2. Session timeline and receipts.
3. Shareable project presets.
4. Harness skills installer.

These are feasible, aligned with current architecture, and immediately improve
the existing product.

### Build Next

5. Project memory from terminal evidence.
6. Local agent runbook per project.
7. Terminal URL/preview workflows.
8. Optional worktree awareness.

These become stronger once events, presets, and project metadata are more
structured.

### Defer

9. Resume daily view.
10. Read-only remote watch mode.

Useful, but they depend on a better event model and would distract if built too
early.

## Features To Avoid Or Treat Carefully

- **Full worktree kanban orchestration**: crowded, dilutes Aya's identity.
- **Provider-specific scraping**: high policy and maintenance risk.
- **Auto-summarizing private agent conversations by default**: trust risk.
- **Auto-running repo-supplied commands**: security risk.
- **Cloud sync before local trust is earned**: changes the product category.
- **A big plugin marketplace too early**: operational overhead before demand is
  proven.

## Recommended Near-Term Roadmap

### Milestone 1: Make Status Useful

- Attention center.
- Better stale/active/waiting model.
- Timeline event schema.
- Search results for status/timeline events.

### Milestone 2: Make Projects Portable

- `.aya/project.json` import/export.
- Project runbook.
- Preset suggestions.
- Trust prompt for repo-local config.

### Milestone 3: Make Agents Aya-Aware

- Settings installer for Aya harness skills.
- Versioned skill templates.
- `aya status` receipts.
- `aya preview set URL`.

### Milestone 4: Make Memory Real

- Explicit pin-to-memory.
- Terminal evidence search.
- Retention controls.
- Optional local summarization only after the raw evidence model works.

## Final Recommendation

Aya should be opinionated, but not combative:

- Worktrees are optional.
- Real TUIs stay real.
- Subscriptions stay with the official tools.
- Project state is the durable object.
- Local evidence beats hidden integrations.

The most promising popularity play is **shareable project presets plus harness
skills**. That creates a distribution loop:

1. A project includes `.aya/project.json`.
2. A developer runs `aya .`.
3. Aya opens the project with useful launchers.
4. Claude/Codex can update Aya status through the installed skill.
5. The user sees why Aya is better within the first minute.

That is more defensible than copying worktree dashboards and more likely to
spread among developers than another generic agent manager.
