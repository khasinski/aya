# Aya Web invoke channels

Aya Web dispatches invoke frames only for the channels declared by `src/web/bridge.ts` and the windowless overrides in `electron/web-server.ts`. The server checks this allowlist before looking up or invoking a captured Electron handler. A bridge change that adds an `inv("channel")` must update the server allowlist; `tests/web-server.test.mjs` checks the two surfaces stay in sync. Other channels return `Not available in Aya Web`.

This allowlist is defense in depth and reduces accidental access to desktop-only APIs. It is not Aya Web's security boundary: an authenticated Aya Web client can use `pty:spawn` and `pty:write` to run commands as the account that runs Aya. Aya Web authentication and network exposure remain the access boundary.

The following bridge-callable channels are candidates for a later product decision about desktop-only behavior. They remain available in Aya Web for now so the current web UI keeps working:

- Host paths and repository operations: `env:cwd`, `env:home`, `env:expand`, `env:complete-path`, `env:dir-exists`, `env:create-dir`, `env:git`, `env:git-changed-files`, `env:git-diff`, `env:git-root`, `env:git-worktree-status`, `env:github-link`, `env:github-cli-available`, `projects:read-repo-config`.
- Host app and diagnostics: `app:cli-status`, `app:install-cli`, `app:diagnostics`, `pty-host:restart`, `pty-host:retry-recovery`, `pty-host:stop-others`, `updates:check`, `updates:install`, `mic:status`, `mic:request`.
- Global configuration and credentials: `presets:save`, `presets:scan-harnesses`, `snippets:save`, `themes:save`, `usage-hook:install`, `usage-hook:uninstall`, `status-hook:install`, `status-hook:uninstall`, `web:configure`, `web:regenerate-password`, `machines:setup`, `machines:configure`, `machines:command`.
- Local tools and system state: `harness:search`, `local-summary:summarize`, `intelligence:ollama-status`, `intelligence:pull-ollama-model`, `sessions:list-monitored`.

The candidate list is a review queue, not a claim that these channels are currently blocked. Channels without a current bridge call, including clipboard, external shell opening, native file pickers, and window-only operations not covered by an override, are denied by the server.
