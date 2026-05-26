# Aya Release Checklist

## Automated

- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run package`

## Packaged App Smoke Test

- Launch `release/mac*/Aya.app`.
- This local build is unsigned unless a Developer ID certificate is available; Gatekeeper may warn on first launch.
- Confirm the app menu says `Aya`, not `Electron`.
- Confirm `Aya > About Aya` shows the new scanner icon and app name.
- Confirm Dock icon uses the new scanner icon.
- Confirm a waiting-terminal notification appears from Aya and clicking it focuses the right terminal.
- Confirm `Cmd+T`, `Cmd+W`, `Cmd+K`, `Cmd+F`, `Cmd+[`, `Cmd+]`, and `Cmd+1..9`.
- Confirm Shift Shift opens/closes search.
- Confirm top project tabs scroll with mouse wheel and trackpad gestures.
- Confirm Settings opens, harness suggestions render, and adding a suggestion creates a preset.
- Confirm first launch with no config still creates/opens a Shell preset.
- Confirm missing project directories show the recovery modal.

## CLI / Single Instance

- With Aya already open, run `bin/aya /path/to/project`.
- Confirm the existing window focuses and switches to or creates the project.
- Run `open -a Aya /path/to/project` against the packaged app and confirm the same behavior.

## Notes

- Dev mode runs inside Electron.app, so some OS-level surfaces may still behave differently from the packaged `.app`.
- Treat the packaged app as the source of truth for app identity, icon, and notification sender.
