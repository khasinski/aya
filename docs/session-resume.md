# Which session a restarted pane resumes

A pane restarts into its own conversation or into a fresh one. It never takes
the folder's "latest" session when that may belong to another pane, for the
cases listed under "What Aya cannot see" the exceptions apply. Verified with
stand-in CLIs for Claude, Codex, Grok and OpenCode; Claude's flag behaviour
also against the real CLI. Not verified: a live Grok (its on-disk layout), a
live Codex under the shared daemon, fish and other non-POSIX pane shells.

## How each CLI knows its own session

| CLI | Id | Restart |
| --- | --- | --- |
| Claude | Aya names it at launch (`--session-id`); Claude's `sessions/<pid>.json` confirms it | `--resume <id>`; no transcript yet or purged: `--session-id <id>` (same id, new conversation) |
| Grok | Same, `--session-id` at launch | `--resume <id>`; folder gone: `--session-id <id>` |
| Codex | Read after the first message: the thread of this cwd whose log rows carry the pane's process ids | `resume <id>`; thread gone or archived: fresh |
| OpenCode | None | Fresh once the folder has been shared (below) |

The brief and a team pane's role note are appended to the launch command; the
id and stale-id steps read the command's shell words, so they still see it.

## "Continue the latest" is only for a pane that was always alone

Codex `resume --last`, `claude --continue` and `opencode --continue` pick the
folder's newest session. A pane without an id may only use them if no pane of
the same agent is open in its folder. Each terminal keeps a saved latch
(`sharedDir` in the project file) once another pane of its agent has been open
in its folder at the same time; from then on it resumes a known id or starts
fresh. A sibling that was closed before the pane ever ran leaves no latch. The latch
compares folders as spelled (a trailing slash aside); while both panes run, the pty host
also compares their real paths at spawn, so a symlink, `..` or letter-case spelling of the
same folder starts fresh too. It never clears: nothing in the UI resets it.

Cost, per CLI:

- Codex: a pane that shared its folder once and never learned an id (it was
  restarted before its first message, or Aya could not read Codex's store)
  restarts blank.
- Claude and Grok: none in practice, panes have an id from birth. Only a pane
  saved before ids existed is affected.
- OpenCode: it has no id to learn, so after a folder was shared its pane
  always restarts fresh, for good, even if the other pane is long gone.
- Kilo and pi are outside the guarantee: they continue the latest session
  without a per-folder rule, so a shared folder still gives `--continue`.

## What Aya cannot see

- Peers are the terminals of this window's projects. A same-folder pane in
  another window, in a project that is not open, in a second Aya, or the
  user's own CLI is invisible: with no id and no latch, `--last` / `--continue`
  may still pick its session.
- Sequential use: a Codex or OpenCode pane restarted before its first message
  resumes the folder's latest session even if another pane of that agent ran
  there earlier and was closed (the latch only covers panes open together).
  Claude and Grok have an id from birth. Not fixed: it would start fresh a pane
  whose id Aya failed to learn.
- A sibling spelled differently (symlink, `..`, letter case) and closed before
  the pane restarts leaves no latch: a pane with no id may then continue the
  folder's latest session, which can be the sibling's.
- Remote (ssh) panes are compared as plain `host:dir` strings: `h` and
  `me@h`, or `/a/../a`, are different folders to the latch.
- A remote (ssh) project's agent keeps its transcripts on the other host. Aya
  gives such a pane no id of its own and does not rewrite its `--resume`; a
  restart uses what the remote agent reported, else `--continue` there.
- One rule covers every id and rewrite (birth id, stale-id repair, the saved id
  a restore appends, Codex and OpenCode): the command's program, after leading
  `NAME=value` assignments and a plain `exec`, must be the agent binary itself
  (`claude`, `grok`, `codex`, `opencode`, also by path). Behind `bash -c`,
  `env`, `nohup`, `time`, `sudo`, `docker exec`, `mosh`, `ssh` and the like the
  command stays as written, and a restore appends the CLI's own `--continue`
  form, as before. `env`, `nohup` and `time` pass flags on but are treated as
  wrappers too.
- Claude's `sessions/<pid>.json` is read for the pane's pid; only a conversation
  with a transcript is reported. Interactive claude writes the file late (not yet
  at the trust or login screen): a missing file means not learned yet, and the
  next poll (every 5 s) looks again. A leftover file of a dead claude whose pid
  was reused is not reported: a file whose `startedAt` is before the pane's
  spawn (1 s slack) is not the pane's. A file without `startedAt` still counts.
- OpenCode: when the session lookup fails or takes more than 10 s, the pane
  keeps plain `--continue` (the repo's newest session) if the repo has no other
  worktree, and starts fresh if it has one (`git worktree list`). A folder that
  is not a repo, or a `git` that does not answer in 1.5 s, counts as no other
  worktree.
- Claude's `--session-id` of an id whose transcript exists is refused, so
  "gone" needs certainty. Aya accepts a transcript under any `projects/*`
  folder (Claude cuts a long cwd at 200 characters and adds a hash). A
  `CLAUDE_CONFIG_DIR=` in the command is the only dir looked in. Otherwise a
  preset's configDir is only a label: the transcript may be in Aya's own
  env dir or `~/.claude`, or in the dir the pane's login shell exports. Aya asks
  the shell for `CLAUDE_CONFIG_DIR` once, only when the others lack it; a shell
  that does not answer keeps the resume.
  The id can then not be proven unused (its transcript may sit in the dir the
  shell would have named), and `--session-id` of an existing transcript is as
  fatal as `--resume` of a missing one, so Aya keeps the resume and logs
  `claude-config-dir-probe-failed`. For a pane that never got a first message
  that resume can end in "No conversation found".
- That probe waits at most 10 s (a startup file that leaves a background job
  holding the output makes it use all of it) and blocks only that pane's launch;
  panes probe in parallel.
- Only a UUID is a session id for the stale-id repair: `claude --resume
  release-note` is a title search and stays as written (`--session-id` takes a
  UUID only, for Claude and Grok alike). A quoted word is never an option, and
  a `-c`/`--continue` anywhere keeps the resume.
- UNVERIFIED (no live Codex in a scratch store): a Codex preset with `-C <dir>`
  different from the pane's folder makes the session reader and the shared-folder
  latch look at the pane's folder, not `<dir>`; and the deleted-thread check
  reads the thread row, not the rollout file, so a deleted rollout with a
  surviving row keeps `codex resume <id>` (which may then exit).
- Grok's session folder layout is only known for the cwd-encoded name, so its
  id under any folder counts as alive. Not verified against a live Grok.

## Codex and the shared daemon

The Codex reader matches log rows by the pane's process ids. Under the shared
Codex daemon the rows carry the daemon's pid, and nothing is found (unverified
without a live Codex). #148 (`--no-daemon`) makes each pane log under its own
pid, so it should merge first. Both change the `const command =` block in
`electron/pty.ts`: expect a textual conflict. The `--no-daemon` flag lands
right after the binary, so the trailing `resume <id>` check still matches.
