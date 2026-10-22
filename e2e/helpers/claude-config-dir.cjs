const fs = require("node:fs");
const path = require("node:path");

function samePath(left, right) {
  try {
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch {
    return path.resolve(left) === path.resolve(right);
  }
}

function resolveClaudeConfigDir(env, userHome) {
  if (env.CLAUDE_CONFIG_DIR) return env.CLAUDE_CONFIG_DIR;
  const home = env.HOME;
  if (!home || samePath(home, userHome)) {
    throw new Error("Refusing to write fake Claude session data without an isolated home or CLAUDE_CONFIG_DIR");
  }
  return path.join(home, ".claude");
}

module.exports = { resolveClaudeConfigDir };
