# Per-project agent toggles (design)

Status: proposal, not implemented. Reviewed with Codex (2 rounds).
Measurements: Claude Code 2.1.283, fresh `claude -p` sessions (haiku).

## Why

- Global skills, plugins and MCP servers are wanted in most projects, not all.
- Claude Code has no "disable all global skills here" switch.
- `skillOverrides` is keyed by exact name, no wildcard.
- Upstream: anthropics/claude-code#37463 closed with `skillOverrides`,
  #17685 duplicate, #30355 open, #62174 (per-project `enabledPlugins`) not
  planned.

## Rules

1. A project stores exclusions only. Not excluded = allowed by Aya.
2. A global item added later is allowed in every project by default.
3. Inventory refresh: once a day, on panel open, on "Refresh now".
4. Spawn never depends on the inventory. Stored exclusions are enough.
5. Nothing is written into the project's repo.
6. Scope: `claude` presets on local projects only. Remote (ssh) projects and
   other agents: toggles disabled with a reason, and spawn skips them too.
7. Not a security boundary. Skill files stay readable; other CLIs unaffected.

## Mechanisms (measured)

| Kind | Inventory source | Overlay key | Measured |
|---|---|---|---|
| User skills | `<profile>/skills/*/` | `skillOverrides: {name: "off"}` | 53 skills -> 13 |
| Skills synced from claude.ai | `<profile>/skills/synced/*/*/` | `skillOverrides: {name: "off"}` | `pdf`, `docx`, `morning` gone |
| Plugins | `<profile>/plugins/installed_plugins.json` | `enabledPlugins: {id: false}` | 14 `recall-loop:*` skills -> 0 |
| MCP servers, global | `~/.claude.json` (default profile) or `<profile>/.claude.json`, key `mcpServers` | `permissions.deny: ["mcp__<name>"]` | 30 `chrome-devtools` tools -> 0 |
| MCP servers, per project | same file, `projects[<dir>].mcpServers` | same | not measured separately |
| Bundled skills | none on disk | `disableBundledSkills: true` | 4 sampled -> 0 |

## Claude Code behavior the design depends on (measured)

| Behavior | Result | Consequence |
|---|---|---|
| `skillOverrides {"grok":"off"}` with a project skill `.claude/skills/grok` | project skill hidden too | exclusion is name-wide; row shows a collision warning |
| user and project skill with the same name | only one listed | inventory keeps source per row |
| two `--settings` flags | last one wins entirely, no merge | Aya must merge with the preset's own `--settings` |
| `--resume <id>` with a new exclusion | skill still listed (transcript snapshot), invocation returns "disabled ... in skillOverrides settings" | resume = blocked, not hidden; fresh session to drop it from context |
| `skillOverrides` on plugin skills | no effect | plugins only via `enabledPlugins` |
| disabling a plugin | disables the whole plugin, incl. its hooks | shown in the panel; Aya's hooks live in user settings, unaffected |

## Storage

- Field on `ProjectConfig`, saved in `~/.aya/projects/<slug>.json`:

  ```json
  "agentExclusions": {
    "claude": {
      "skills": ["grok", "spec-checker"],
      "plugins": ["recall-loop@claude-code-recall-loop"],
      "mcpServers": ["chrome-devtools"],
      "bundledSkills": false
    }
  }
  ```

- Must be added at every explicit field list, or it is silently dropped:
  - `electron/types.ts` `ProjectConfig`
  - `src/types.ts` renderer `ProjectConfig`
  - `electron/config.ts` read path (`listProjects`) and `toDisk`
  - `electron/validation.ts` `projects:update`
- Missing field = no exclusions. Malformed field = no exclusions + logged.
- Optional additive field, no schema bump. Older Aya drops it on next save.
- Round-trip test: write, reload, update, reload.

## Inventory

- One scan per distinct profile dir used by presets.
- Row identity: `kind + name`. Row keeps provenance: profiles, source path,
  project path (per-project MCP), affected presets.
- Plugin skills keep their `plugin:skill` namespace; the `synced` container
  dir is not a skill.
- Cache: `~/.aya/agent-inventory.json` with `refreshedAt`, per-source errors,
  last good result kept on error.
- Daily refresh: one-shot timer re-armed while Aya runs; stale cache
  refreshed at startup, async, never during spawn.
- `NEW` = not in the last-seen set. Last-seen advances only on Save or on
  explicit dismiss, not on refresh, not on Cancel.

## Spawn pipeline

Current order: renderer `commandWithAutoResume` (`src/App.tsx:523`) ->
`pty:spawn` (`electron/main.ts:2287`) -> `withAgentBrief` -> pty host ->
`shellArgv` (`electron/pty.ts:396`).

Change, in main, after request validation, before `withAgentBrief`:

1. Resolve agent from the preset, not the request (restart omits `agent`,
   `src/components/TerminalView.tsx:1208`).
2. If not claude, remote, or no exclusions: pass the command unchanged.
3. Tokenize the command. Find `--settings X` / `--settings=X`, ignoring
   text inside quoted values.
4. Base settings = last occurrence only (measured: last wins).
   - inline JSON: parse
   - literal path: resolve against `request.cwd`, read, parse
   - `$VAR`, `$(...)`, unreadable, invalid JSON: status "not applied",
     launch with the original command
5. Merge: base keys kept, Aya keys win, `permissions.deny` unioned.
   Only base + overlay, never the flattened effective config.
6. Write to `~/.aya/agent-settings/<sha256>.json`, content-addressed,
   atomic, mode 0600. Await the write before spawn.
7. Remove all `--settings` occurrences, append one `--settings '<abs path>'`.
   Keep resume args already added.
8. Continue to `withAgentBrief`. Its punctuation guard runs before brief
   injection, as today.

- No JSON in the shell string, so no quoting of user data.
- Content-addressed files: concurrent restores with different presets never
  overwrite each other.
- Cleanup: path registered per PTY. GC deletes only files not referenced
  by any PTY the host reports alive (the host outlives the app,
  `electron/pty-host-client.ts:254`). Never on app quit or project close.

## Per-tab status

| Status | Meaning |
|---|---|
| applied | process started with the current revision |
| pending restart | exclusions changed after this process started |
| resumed | started with `--resume`/`--continue`: blocked, may still be listed |
| not applied | merge failed; reason shown |
| n/a | not claude, or remote |

- Stored per process: revision, settings path, reason.
- Reattached PTYs keep their recorded status (the host ignores a new spawn
  for an existing PTY, `electron/pty.ts:487`).

## UX

### Entry point: project context menu

```
 PROJECTS
 ┌──────────────────────────┐
 │ ● aya                    │  right-click
 │   game         ⊘ 26 excl │ ┌──────────────────────────────┐
 │   ruby_llm-contract      │ │ Agent tools...               │
 │   blog                   │ │ ──────────────────────────── │
 └──────────────────────────┘ │ Move to New Window           │
                              │ Move to Window: game         │
                              └──────────────────────────────┘
```

- Badge counts exclusions of items currently installed (not `GONE`).

### Panel

```
┌─ Agent tools - game (Claude) ─────────────────────────────────── [x] ─┐
│                                                                       │
│  Excluded by Aya in new Claude sessions of this project.              │
│  Resumed sessions: excluded skills are blocked but may stay listed.   │
│                                                                       │
│  [ Filter...                ]  [Allow listed]  [Exclude listed]       │
│  Inventory: today 09:14  (~/.claude)                  [Refresh now]   │
│                                                                       │
│  ▾ Skills (19)                          17 allowed · 2 excluded       │
│    [✓] anti-facade-pre-claim     ~/.claude                            │
│    [ ] grok                      ~/.claude                            │
│        ! also hides this project's .claude/skills/grok                │
│    [✓] ship-gate                 ~/.claude                            │
│    [ ] spec-checker              ~/.claude                            │
│    [✓] weekly-summary   NEW      ~/.claude                            │
│    [ ] old-audit        GONE     not installed anymore          [×]   │
│                                                                       │
│  ▾ Skills from claude.ai (9)                   9 allowed              │
│    [✓] docs  [✓] docx  [✓] pdf  [✓] pptx  [✓] xlsx  ...               │
│                                                                       │
│  ▾ Plugins (7)                          6 allowed · 1 excluded        │
│    [ ] recall-loop     14 skills, 1 hook   whole plugin is disabled   │
│    [✓] atlassian        4 skills                                      │
│                                                                       │
│  ▸ MCP servers (2)                      2 allowed                     │
│      chrome-devtools (global) · conftrace (this project)              │
│                                                                       │
│  ▸ Built-in Claude Code skills          allowed (one switch)          │
│                                                                       │
│  ───────────────────────────────────────────────────────────────────  │
│  Overlay passed to the next session                  [Copy JSON]      │
│  {"skillOverrides":{"grok":"off","spec-checker":"off"},...}           │
│  ! preset "claude-work" has its own --settings: merged, Aya wins      │
│                                                                       │
│                                               [Cancel]  [Save]        │
└───────────────────────────────────────────────────────────────────────┘
```

- `[✓]` allowed by Aya, `[ ]` excluded by Aya. Allowed does not override
  managed or other settings that disable an item.
- `[Allow listed]` / `[Exclude listed]` act on rows matching the filter.
  Items installed later still arrive allowed.
- `GONE`: excluded, no longer installed. Kept (may come back), still passed,
  `[×]` drops it.
- Remote project or non-claude preset: panel read-only with the reason.

### After Save

```
┌─────────────────────────────────────────────────────────────┐
│  Saved. 2 Claude tabs in game: pending restart.             │
│    Tab 1  claude   working   pending restart                │
│    Tab 3  claude   idle      pending restart                │
│  Restarting a tab with auto-resume blocks the new           │
│  exclusions but keeps old skill names in its context.       │
│                                                       [OK]  │
└─────────────────────────────────────────────────────────────┘
```

- No bulk restart in v1 (would interrupt running work).

## Tests

- Fake agent from `e2e/agent-brief.spec.ts` (records argv/env):
  - no exclusions: command unchanged
  - exclusions: one `--settings <path>`, file content, mode 0600
  - preset with inline / `=` / relative-path `--settings`: merged, last wins
  - dynamic or unreadable `--settings`: original command, status not applied
  - resume args and brief still present, order unchanged
  - restart without `agent` in the request
  - two presets restored at once: two files, no overwrite
  - remote project, non-claude preset: unchanged
- Unit: `ProjectConfig` round-trip, validation of malformed field.
- Pinned real-Claude acceptance matrix (manual or nightly, not CI):
  project-skill collision, last-`--settings`-wins, resume behavior for
  skills, plugins, bundled skills and MCP.

## Unverified

- Resume behavior for plugin skills, bundled skills and MCP tools.
- A copied settings file behaving the same as the original (watching,
  relative values inside).
- `--dangerously-skip-permissions` presets vs MCP deny rules.
- Late reads of the settings file by the claude process after start.

## Out of scope for v1

- Codex, Grok, opencode and other agents.
- Remote (ssh) projects.
- Subagents (`Agent(name)` deny) and settings hooks.
- Bulk restart of running tabs.
