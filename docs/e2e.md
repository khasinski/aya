# End-to-end tests (Playwright + Electron)

These drive the **real built app** through Playwright's Electron driver - they
click, focus, and assert on the live DOM, catching the interaction bugs that the
pure-core `node:test` suites can't see (focus not switching, click-twice,
overlay click-traps).

## Running

```sh
npm run test:e2e          # builds, then runs headless
npm run test:e2e:headed   # builds, then runs with a visible window
npx playwright test e2e/focus.spec.ts   # one spec (build must be current)
npx playwright show-report              # open the HTML report
```

`npm run test:e2e` runs `npm run build` first, so the specs always test the
current renderer + main.

## How isolation works

Each test launches a fresh app instance via `e2e/fixtures.ts` against a
throwaway environment built by `e2e/helpers/seed.ts`:

- **`AYA_HOME`** points at a temp dir, seeded with a deterministic project (two
  shell terminals in a 1x2 split) and a single shell preset - so no real `~/.aya`
  is touched and no PATH scan pulls in claude/codex.
- **`--user-data-dir`** is a separate temp dir, so the test instance never trips
  the single-instance lock of a running Aya or shares its cache.
- **No `AYA_DEV`** - the app loads the built `dist/index.html`, i.e. production
  mode, not the Vite dev server.
- `ELECTRON_RUN_AS_NODE` is stripped from the child env (it would make Electron
  start as plain Node with no `app`).

The app is launched with `dist-electron/main.js` as the entry (not the repo
root) because a bare directory arg is interpreted by `main.ts` as "open this
project".

## Specs

- `smoke.spec.ts` - app boots, hydrates the seeded split, renders two panes.
- `focus.spec.ts` - clicking a split pane activates it and moves keyboard focus
  into its terminal in a single click (guards the focus-switch / click-twice
  class of bug).
- `snippets.spec.ts` - the snippet drawer opens, shows the seeded default with
  its full text, collapses after sending; the closed drawer is `inert` (F14
  ghost-drawer regression guard).

## CI

The `e2e` job in `.github/workflows/build.yml` runs the suite on Linux under
`xvfb-run`; in CI the app is launched with `--no-sandbox` (the Chromium SUID
sandbox is unavailable on runners).

## Adding a test for a specific glitch

To pin a "needs two clicks" / "focus doesn't switch" bug, reproduce the exact
sequence (which element, in what order) in a spec, assert the correct
single-action outcome, and let it fail first - then fix the app until it passes.
