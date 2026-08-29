# Aya Emulator

A build target that renders the **real** Aya UI in any scripted state, so
screenshots are pixel-identical to the desktop app.

It shares 100% of the appearance code: `emulator.html` boots the same
`src/App.tsx` and every component and stylesheet the desktop and web builds use.
The only thing swapped out is the data layer — `window.aya` is replaced by a
mock (`bridge.ts`) that serves a static scenario instead of talking to the
Electron host. Nothing here spawns a process; terminal panes are filled by
writing text straight into the real xterm.

This is the same seam Aya Web uses (`src/web/main.tsx` installs
`window.aya = createWebAya(transport)`); the emulator installs
`window.aya = createEmulatorAya(scenario)`.

## Run it

```sh
npm run dev:renderer            # Vite dev server on :5183
# open http://localhost:5183/emulator.html?scenario=default
```

Pick a scenario with `?scenario=<name>` (defaults to `default`).

## Screenshots

```sh
npm run emulator:shot                       # shoots default + busy
npm run emulator:shot -- default busy       # named scenarios
npm run emulator:shot -- default --out screenshots/emulator --scale 2
```

The script spawns its own Vite server, so nothing needs to be running first. It
renders at 1440x900 @2x by default.

## Files

- `main.tsx` — entry: installs the mock `window.aya`, then imports `../App`.
- `bridge.ts` — `createEmulatorAya(scenario)`: the full `AyaApi` served from the
  scenario. Render-path methods return real data; native/window/updater calls
  are typed no-ops (like Aya Web).
- `scenario.ts` — the authoring types (`EmScenario`, `EmProject`, `EmTab`) plus
  `balancedSplitTree`.
- `scenarios.ts` — the example scenarios and the `?scenario=` registry.
- `presets.ts` / `theme.ts` — authentic default presets and the Aya Dark theme,
  copied from the main-process modules the renderer can't import.

## Authoring a scenario

Add an `EmScenario` to `scenarios.ts` and register it in `SCENARIOS`:

```ts
{
  name: "review",
  platform: "darwin",
  activeProjectSlug: "aya",
  usage: [/* UsageAccount → the Claude chip */],
  codexUsage: [/* → the Codex chip */],
  projects: [
    {
      slug: "aya", name: "aya", directory: "/Users/you/Projects/aya",
      git: { branch: "main", dirty: 3 },     // status-bar branch + dirty count
      activeTabId: "t1",
      tabs: [
        {
          id: "t1", presetId: "claude", name: "Claude",
          content: "\x1b[32mHello\x1b[0m\r\n",  // ANSI written into the pane
          status: "waiting",                     // → pane pill + status rail + tab badge
          statusText: "Approve edit?",
        },
        { id: "t2", presetId: "shell", name: "Shell", content: "$ ls\r\n" },
      ],
      // Omit `split` and >1 tab ⇒ a balanced split showing every pane.
      // Set `singleViewTabId` to show just one pane instead.
    },
  ],
}
```

Knobs that map to visible UI:

- **Split view**: two or more `tabs` render side by side automatically; pass an
  explicit `split` (a `SplitNode`) for a specific layout, or `singleViewTabId`
  for a single pane.
- **Terminal content**: `tab.content` is ANSI/plain text written into the pane.
- **Waiting / failed**: `tab.status` (`waiting` | `error` | `active` | `done`)
  drives the pane status pill, the sidebar dot, the StatusRail counts, the
  project-tab badge, and the status-bar attention count. `exitCode` / `stopped`
  render an exited/stopped pane.
- **Usage chips**: `usage` / `codexUsage` are `UsageAccount[]`; keep each
  account's `usage.updatedAt` recent or the chip dims as stale.
- **Git bar**: `project.git` sets the branch name and dirty count.
