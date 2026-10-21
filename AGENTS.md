# Rules for agents working on Aya

- When debugging or driving Aya teams, never make a team agent read files outside the project directory it works in; paste the content into the message instead (a first read outside made Claude Code offer an account-wide read block that froze every session, 2026-10-03).
- No test may open the real browser: external URLs go through main's externalShell, which in e2e writes them to AYA_E2E_OPEN_EXTERNAL_LOG instead of opening them. Assert that log; never stub shell.openExternal from a spec (2026-10-21, test runs opened github.com tabs).
