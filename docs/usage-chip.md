# Account-wide usage chip

Aya can show **account-wide** Claude, Codex, Grok and Antigravity usage chips in the top-right of
the window (5-hour + weekly limit, with reset times). The numbers are global to
each account — they cover **all** sessions and devices for that account, not the
current project or terminal.

## How it works

For Claude, Aya is deliberately **source-agnostic and hands-off**: it only
**reads** a small JSON file and renders it. It never fetches usage, never reads
your auth token, and calls no endpoint. You decide what writes that file; the
built-in option is Claude Code's own status line (below).

```
~/.aya/usage.json        (or ~/.aya-dev/usage.json under `npm run dev`)
```

Expected shape (anything else is ignored and the chip hides). The original
single-account shape still works:

```json
{
  "fiveHour": { "pct": 30, "resetsAt": "2026-06-03T17:20:00Z" },
  "sevenDay": { "pct": 55, "resetsAt": "2026-06-06T15:00:00Z" },
  "updatedAt": "2026-06-03T14:32:00Z"
}
```

`pct` is 0–100 (percent used). `resetsAt` is optional. If `updatedAt` is older
than 15 minutes the chip dims and shows "stale".

For multiple Claude accounts, write an account list instead:

```json
{
  "accounts": [
    {
      "id": "work",
      "label": "Work",
      "usage": {
        "fiveHour": { "pct": 30, "resetsAt": "2026-06-03T17:20:00Z" },
        "sevenDay": { "pct": 55, "resetsAt": "2026-06-06T15:00:00Z" },
        "updatedAt": "2026-06-03T14:32:00Z"
      }
    },
    {
      "id": "personal",
      "label": "Personal",
      "usage": {
        "fiveHour": { "pct": 8 },
        "sevenDay": { "pct": 12 },
        "updatedAt": "2026-06-03T14:32:00Z"
      }
    }
  ]
}
```

Aya renders one chip per agent. The number in the top bar is the average weekly
percent used across detected accounts, so two Claude accounts at 0% and 100%
show `50%`. The dropdown lists each account by `label` and shows that account's
own 5-hour and weekly limits. `id` must be stable and unique.

Codex usage is automatic: Aya reads Codex's local rollout logs under
`$CODEX_HOME/sessions` or `~/.codex/sessions`. If Codex logs include an account
identifier on `token_count` rate-limit events, Aya includes those accounts in
the Codex chip dropdown and averages them in the top-bar number. If no account
identifier is present, Aya keeps the previous behavior and shows a single Codex
account in the dropdown.

## Easiest: the Settings toggle

**Settings → Claude usage chip → Enable.** A dialog spells out what it does; on
confirm, Aya writes a small script and sets it as the `statusLine` command in
`~/.claude/settings.json`. **Disable** restores your previous status line and
removes the script.

Claude Code passes every status-line command a JSON document on stdin that
includes `rate_limits.five_hour` and `rate_limits.seven_day`
(`used_percentage`, `resets_at`). The script saves those two windows in the
shape above, then runs your previous status-line command (if you had one) with
the same input, so it keeps rendering as before. No token is read and nothing
goes over the network. The numbers refresh while a Claude Code session is open
(the file is rewritten at most every 30 seconds); with no session running the
chip dims as "stale" after 15 minutes. A window Claude Code has no figure for
yet is simply left out.

Builds before this one used a `Stop` hook that called Anthropic's undocumented
usage endpoint. Aya removes that hook at launch and switches the chip to the
status line automatically.

## Or wire it manually

Prefer not to let Aya touch `~/.claude`? Write the file from your own
`statusLine` script. Minimal example (`jq` required):

```sh
#!/usr/bin/env bash
INPUT=$(cat)
printf '%s' "$INPUT" | jq --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
  {fiveHour: {pct: .rate_limits.five_hour.used_percentage},
   sevenDay: {pct: .rate_limits.seven_day.used_percentage},
   updatedAt: $ts}' > "$HOME/.aya/usage.json.tmp" && mv "$HOME/.aya/usage.json.tmp" "$HOME/.aya/usage.json"
```

Any other source works too (e.g. a `ccusage`-based script) as long as it emits
the shape above. Aya doesn't care where the numbers come from.

## Google Antigravity

With an Antigravity preset configured, Aya runs the official CLI's built-in
`agy -p /usage --output-format json --print-timeout 15s` command. Sign in through
`agy` first. The command refreshes quota data without a model turn; Aya does not
read Google credentials or call Google endpoints directly.

The ring shows the highest percentage **used** among the returned quota limits.
The popover splits Gemini and Claude/GPT into quota groups, showing each group's
weekly and five-hour windows and reset times. These are shared model pools, not
separate accounts. Polls are coalesced and cached for one minute across windows;
on a temporary failure the previous snapshot remains and eventually dims as stale.
With no CLI, no login, or an unsupported response, no new percentage is invented.

Reference: https://www.antigravity.google/docs/cli/commands/usage
