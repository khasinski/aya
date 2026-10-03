// Spellings a preset can start an agent behind, and text that only mentions one.

/** Agent runs behind something Aya does not read through. */
const WRAPPED_AGENT_SPELLINGS = [
  "nice -n 5 codex", "sudo -u x codex", "timeout 3600 codex", "caffeinate -i codex", "(codex)", "{ codex; }",
  "cd a\ncodex", "true & codex", "codex; echo done", "codex&& true", "ssh host codex", "docker run img codex",
  "tmux new codex", "script -q /dev/null codex", "asdf exec codex", "pnpm dlx codex", "bunx codex", "yarn codex",
  "npm exec codex", "mise exec -- codex", "direnv exec . codex", "npx @anthropic-ai/claude-code", "arch -arm64 codex",
  "stdbuf -o0 codex", "xargs codex", "watch codex", "login -pf $USER codex",
  "X='q r' nice codex",
  "npx -y @openai/codex", "echo hi | codex", "bash -lc \"codex\"", "zsh -c 'cd x && codex'", "sh -c \"exec claude --foo\"",
  // A program word counts when it is quoted too, and a package or entry script names its agent.
  "nohup \"codex\"", "env 'codex'", "time 'claude'", "echo hi; \"codex\"", "opencode-ai", "npx -y opencode-ai@latest",
  "node ~/.local/bin/claude", "node /usr/lib/node_modules/@openai/codex/bin/codex.js", "node /opt/codex/bin/codex.mjs", "node codex.cjs",
  "python3 ~/bin/claude", "node --no-warnings ~/bin/codex",
  // A shell carried by something other than the first word.
  "exec bash -c 'codex'", "arch -arm64 zsh -c 'codex'", "docker run img sh -c 'codex'", "docker run --rm -v a:b img bash -lc 'cd x && codex'",
  "kubectl exec pod -- sh -c 'codex'", "ssh host 'codex'", "ssh -t host 'cd x && codex'", "sh \"-c\" 'codex'",
  // Spellings that pin the word splitter.
  "npx --yes codex@latest", "echo hi\ncodex", "echo \\\"; codex", "FOO=${X:-a b} codex", "cd x && true & codex",
  // Compound statements and a shell by variable.
  "if true; then codex; fi", "while true; do codex; done", "! codex", "$SHELL -c 'codex'", "eval \"cd x && codex\"",
];

/** `cd <dir> &&` before the agent's own program: the program's own verdict, read in that directory. */
export const CD_LEAD_SPELLINGS = [
  "cd 'a b' && X='/n/node' Y=\"v w\" /p/fake-codex/codex", "cd x && \"/Users/me/My Tools/codex\"", "cd x && \"$HOME/bin/codex\"",
  "cd x && '/opt/my tools/claude' --resume", "cd x && codex 'oops", "cd sub && codex", "cd sub && claude",
];

const LEAD_IN_SPELLINGS = [
  "cd a; codex", "false || codex", "(cd a; codex)", "sudo codex", "time codex", "nohup codex", "command codex", "env -i codex",
];

/** Text or commands that only mention an agent. */
const MENTION_SPELLINGS = [
  "git commit -m 'wip; codex ready'", "echo \"done; claude is next\"", "python tool.py -c \"codex help\"",
  "notify-send 'x | opencode done'", "command -v codex", "cat codex.md", "sudo vim codex.md", "env | grep -i claude",
  "mytool 'codex'", "mytool --agent \"claude\"", "ls && codex-review", "make test && echo codex", "sh -c 'echo \"codex\"'", "python run.py codex",
  "git log --grep codex", "git checkout codex",
  // An agent's name as a directory, a model or a value is not the program that runs.
  "cd ~/src/codex && cargo run", "cd ~/work/claude && aider", "aider --model claude", "gemini --model claude", "cursor-agent -m claude",
  "gh copilot --agent codex", "my-agent --provider codex", "aider src/codex", "gemini codex", "node codex-notes.js", "node server.js",
  "python -c \"import codex\"", "node -e \"run('codex')\"", "bash -c \"echo \\\"a; codex \\\"\"", "echo ${X:-a|codex }", "python -c codex", "node -e codex", "echo 'it; codex", "ssh host ls codex",
];

/** All of them: unknown, noted, never held, and given no flags. */
export const UNREAD_SPELLINGS = [...WRAPPED_AGENT_SPELLINGS, ...LEAD_IN_SPELLINGS, ...MENTION_SPELLINGS];
