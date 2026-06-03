# Account-wide usage chip

Aya can show an **account-wide** Claude usage chip in the top-right of the
window (5-hour + weekly limit, with reset times). The numbers are global to
your Claude account — they cover **all** your sessions and devices, not the
current project or terminal.

## How it works

Aya is deliberately **source-agnostic and hands-off**: it only **reads** a small
JSON file and renders it. It never fetches usage, never reads your auth token,
and ships no endpoint code. You decide what writes that file.

```
~/.aya/usage.json        (or ~/.aya-dev/usage.json under `npm run dev`)
```

Expected shape (anything else is ignored and the chip hides):

```json
{
  "fiveHour": { "pct": 30, "resetsAt": "2026-06-03T17:20:00Z" },
  "sevenDay": { "pct": 55, "resetsAt": "2026-06-06T15:00:00Z" },
  "updatedAt": "2026-06-03T14:32:00Z"
}
```

`pct` is 0–100 (percent used). `resetsAt` is optional. If `updatedAt` is older
than 15 minutes the chip dims and shows "stale".

## Wiring it up (optional, your responsibility)

The official `/usage` data comes from an **undocumented** endpoint
(`https://api.anthropic.com/api/oauth/usage`) — the same one Claude Code's
`/usage` command calls. Using it programmatically is **unsupported** (it may
change or break without notice) and is **your own decision** for your own
account. Aya neither ships nor endorses the fetch; it only reads the file.

A clean way to populate the file is a throttled Claude Code **hook** that fetches
on an event (e.g. `Stop`) and writes the file. The hook runs in your shell, with
your token — Aya is not involved.

`~/bin/aya-usage-hook.sh` (macOS — token from Keychain):

```sh
#!/usr/bin/env bash
set -euo pipefail
OUT="$HOME/.aya/usage.json"
# Throttle: skip if written in the last 5 minutes.
if [ -f "$OUT" ] && [ "$(( $(date +%s) - $(stat -f %m "$OUT") ))" -lt 300 ]; then
  exit 0
fi
TOKEN="$(security find-generic-password -s 'Claude Code-credentials' -w \
  | jq -r '.claudeAiOauth.accessToken // empty')"
[ -n "$TOKEN" ] || exit 0
RESP="$(curl -sS -m 10 -H "Authorization: Bearer $TOKEN" \
  https://api.anthropic.com/api/oauth/usage)" || exit 0
mkdir -p "$HOME/.aya"
printf '%s' "$RESP" | jq \
  --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{fiveHour:{pct:.five_hour.utilization, resetsAt:.five_hour.resets_at},
    sevenDay:{pct:.seven_day.utilization, resetsAt:.seven_day.resets_at},
    updatedAt:$ts}' > "$OUT.tmp" && mv "$OUT.tmp" "$OUT"
```

Register it in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command", "command": "~/bin/aya-usage-hook.sh" } ] }
    ]
  }
}
```

(On Linux the token lives in `~/.claude/.credentials.json` instead of the
Keychain — adjust the `TOKEN=` line accordingly.)

Prefer not to touch the endpoint at all? Point the file at any other source —
e.g. a `ccusage`-based script — as long as it emits the shape above. Aya doesn't
care where the numbers come from.
