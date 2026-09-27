# Per-project agent toggles (design)

Status: proposal, nothing implemented yet.

## Why

Global Claude skills, plugins and MCP servers are useful in most projects, but
in some projects I want them gone: they cost context, they trigger where they
do not belong, and a project may need a clean agent. Claude Code has no switch
for "disable all global skills in this project". `skillOverrides` takes exact
names only (no wildcard), and per-project `enabledPlugins` is written by hand.
Listing every name per project, and keeping those lists current when a new
global skill appears, is exactly the chore Aya can do.

## What exists upstream (checked 2026-09-27)

- anthropics/claude-code#37463 (per-project enable/disable of skills) was
  closed as completed with `skillOverrides`, which is keyed by exact name.
- #17685 (disable global skills per project) closed as a duplicate, #30355
  (disable auto-triggering per project) is open, #62174 (per-project
  `enabledPlugins`) closed as not planned.
- Claude Code 2.1.283 schema: `skillOverrides` values are `on`, `name-only`,
  `user-invocable-only`, `off`; plugin skills are not affected by it.

## Rules

1. A project stores **exclusions only**. Anything not excluded is on.
2. A global item added later is therefore **on by default** in every project
   and shows up in each project's list as on.
3. Aya refreshes the inventory **once a day** and whenever the panel opens.
4. Nothing is written into the project's repo. Exclusions are passed at spawn
   time with `claude --settings '<json>'`.
5. A change applies to the next start or resume of a session. Running sessions
   keep what they started with (that is how Claude Code loads settings).

## What can be toggled

Every row was verified on a fresh `claude -p` session (haiku), counting the
items the model sees without and with the setting:

| Kind | Where Aya reads the list | How it is turned off | Measured |
|---|---|---|---|
| User skills | `<profile>/skills/*/` | `skillOverrides: {name: "off"}` | 53 skills -> 13 (only bundled left) |
| Skills synced from claude.ai | `<profile>/skills/synced/*/*/` | `skillOverrides: {name: "off"}` | `pdf`, `docx`, `morning` ... gone |
| Plugins | `<profile>/plugins/installed_plugins.json` | `enabledPlugins: {id: false}` | 14 `recall-loop:*` skills -> 0 |
| MCP servers | `<profile>/.claude.json` `mcpServers` | `permissions.deny: ["mcp__<name>"]` | 30 `chrome-devtools` tools -> 0 |
| Bundled Claude Code skills | no list on disk | `disableBundledSkills: true` (one switch) | 4 sampled -> 0 |

`<profile>` is each distinct `CLAUDE_CONFIG_DIR` used by a preset (for example
`~/.claude` and `~/.claude_chris`). Hooks are out of scope: turning them off
would also turn off Aya's own status and usage hooks.

## UX

### Entry point: project context menu

Right-click a project in the left sidebar. The menu today only has "Move to
..." entries; one item is added.

```
 PROJECTS
 ┌──────────────────────────┐
 │ ● aya                    │  right-click
 │   b2b          ⊘ 26 off  │ ┌──────────────────────────────┐
 │   alligent               │ │ Agent tools...               │
 │   blog                   │ │ ──────────────────────────── │
 └──────────────────────────┘ │ Move to New Window           │
                              │ Move to Window: alligent     │
                              └──────────────────────────────┘
```

A project with exclusions gets a quiet `⊘ N off` badge in the sidebar, so a
missing skill is never a mystery.

### Panel: Agent tools for one project

```
┌─ Agent tools - b2b ─────────────────────────────────────────── [x] ─┐
│                                                                     │
│  Claude sessions in this project start with these turned off.       │
│  Changes apply to the next start or resume of a session.            │
│                                                                     │
│  [ Filter...                   ]   [All on]  [All off]              │
│                                                                     │
│  Inventory refreshed today 09:14    [Refresh now]                   │
│                                                                     │
│  ▾ Skills (19)                                   17 on · 2 off      │
│    [■] anti-facade-pre-claim         ~/.claude_chris                │
│    [■] bounded-sink-audit            ~/.claude_chris                │
│    [ ] grok                          ~/.claude_chris                │
│    [■] ship-gate                     ~/.claude_chris, ~/.claude     │
│    [ ] spec-checker                  ~/.claude_chris                │
│    [■] weekly-summary      NEW       ~/.claude                      │
│    ...                                                              │
│                                                                     │
│  ▾ Skills from claude.ai (9)                      9 on              │
│    [■] docs  [■] docx  [■] pdf  [■] pptx  [■] xlsx  ...             │
│                                                                     │
│  ▾ Plugins (7)                                    6 on · 1 off      │
│    [ ] recall-loop           claude-code-recall-loop   14 skills    │
│    [■] atlassian             claude-plugins-official    4 skills    │
│    [■] rotate-context        claude-code-rotate-context 1 skill     │
│    ...                                                              │
│                                                                     │
│  ▸ MCP servers (1)                                1 on              │
│                                                                     │
│  ▸ Built-in Claude Code skills                    on                │
│    [■] code-review, simplify, loop, init, ... (one switch)          │
│                                                                     │
│  ─────────────────────────────────────────────────────────────────  │
│  Preview: what the next session gets                  [Copy JSON]   │
│  claude --settings '{"skillOverrides":{"grok":"off",...}}'          │
│                                                                     │
│                                           [Cancel]  [Save]          │
└─────────────────────────────────────────────────────────────────────┘
```

- `[■]` on, `[ ]` off. Sections are collapsible; the counts stay visible.
- `NEW` marks an item that appeared since the last refresh. It is on, per
  rule 2. The mark clears after the panel is opened once.
- The profile column shows which config dir the item comes from; a name found
  in several profiles is one row (the override is keyed by name).
- "All off" is the one-click answer to "no global tools in this project".
  It stores the current names; a later new item still arrives on.
- The preview shows the exact flag the next session gets, so the effect can
  be checked by hand.

### Item that disappeared from the inventory

```
│  ▾ Skills (19)                                                      │
│    [ ] old-audit           GONE   excluded, no longer installed [×] │
```

An exclusion whose item is no longer installed stays stored (it may come
back) and is shown as `GONE` with a button to drop it. It is still passed to
`--settings`; an override for a missing name is harmless.

### Running sessions after Save

```
┌─────────────────────────────────────────────────────────────┐
│  Saved. 2 Claude sessions in b2b still run with the old     │
│  set. They pick up the change when restarted or resumed.    │
│                                         [Restart them] [OK] │
└─────────────────────────────────────────────────────────────┘
```

## How it works

```
 once a day / panel open                     tab spawn (pty:spawn)
 ─────────────────────────                   ─────────────────────
 for each preset profile dir:                project = tab's project
   skills/*, skills/synced/*/*               excl = project.agentExclusions
   plugins/installed_plugins.json            if agent is claude and excl != {}:
   .claude.json mcpServers                     json = buildSettings(excl)
        │                                      cmd += --settings '<json>'
        ▼                                            │
 ~/.aya/agent-inventory.json                         ▼
 { refreshedAt, items[{kind,name,profiles}] }   spawnPty(...)
```

- Storage: a new optional field on `ProjectConfig` (`electron/types.ts`),
  saved in `~/.aya/projects/<slug>.json`:

  ```json
  "agentExclusions": {
    "skills": ["grok", "spec-checker"],
    "plugins": ["recall-loop@claude-code-recall-loop"],
    "mcpServers": [],
    "bundledSkills": false
  }
  ```

- Spawn: next to `withAgentBrief` in the `pty:spawn` handler, only for
  commands detected as `claude` (same detection as `src/agentPreset.ts`).
- Inventory: read-only scan in main, cached with its timestamp. A one-shot
  timer re-arms itself for the next day while Aya runs; a stale cache is
  refreshed at startup.

## Out of scope for v1

- Codex, Grok, opencode and other agents (each has its own mechanism).
- Remote (ssh) projects: the inventory would have to come from the remote
  host.
- Subagents (`Agent(name)` deny) and hooks.

## Open questions

- If a preset's command already has its own `--settings`, merge the two or
  skip and warn? My lean: skip and show a warning in the panel.
- Should "Restart them" exist in v1, or is the notice enough?
