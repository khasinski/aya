/** What other agent CLIs set for their children (session markers, then their
 *  companions), as the environment Aya may have been launched from. */
export const FOREIGN_MARKERS = {
  AI_AGENT: "claude-code_1_agent",
  CLAUDECODE: "1",
  CLAUDE_CODE_SESSION_ID: "outer-claude",
  CODEX_CI: "1",
  CODEX_SANDBOX: "seatbelt",
  CODEX_SANDBOX_NETWORK_DISABLED: "1",
  CODEX_SESSION_ID: "outer-codex",
  CODEX_THREAD_ID: "outer-codex",
  AGENT: "1",
  OPENCODE: "1",
  OPENCODE_PID: "1",
  GROK_AGENT: "1",
  GROK_SESSION_ID: "outer-grok",
};
export const FOREIGN_COMPANIONS = {
  GIT_EDITOR: "true",
  CLAUDE_EFFORT: "medium",
  CODEX_MANAGED_BY_NPM: "1",
  CODEX_VERSION: "0.158.0",
  CLAUDE_CODE_HOST_SESSION_ID: "h",
  NO_COLOR: "1",
  PAGER: "cat",
  CI: "true",
};
export const FOREIGN = { ...FOREIGN_MARKERS, ...FOREIGN_COMPANIONS };
export const OUTER_AYA = { AYA_PROJECT_SLUG: "outer-project", AYA_PRESET_ID: "outer-preset" };
