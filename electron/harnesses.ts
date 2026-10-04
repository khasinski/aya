// Detect agent CLIs installed on the user's PATH so the first-launch
// preset list contains only what's actually usable, and so Settings can
// suggest harnesses the user hasn't added yet.

import { scanCommands } from "./command-probe";

export interface HarnessDef {
  /** Canonical id; used as the preset id when seeded. */
  id: string;
  /** Binary name on PATH (no flags). */
  binary: string;
  name: string;
  icon: string;
  color: string;
  /** Default launch command. Plain binary in v1; user can edit later. */
  command: string;
}

/** Known agent harnesses + interactive AI CLIs we'll probe for. Add new
 *  ones here as the ecosystem grows. */
export const KNOWN_HARNESSES: readonly HarnessDef[] = [
  {
    id: "claude",
    binary: "claude",
    name: "Claude Code",
    icon: "✻",
    color: "#d97757",
    command: "claude",
  },
  {
    id: "codex",
    binary: "codex",
    name: "Codex",
    icon: "◆",
    color: "#10a37f",
    command: "codex",
  },
  {
    id: "aider",
    binary: "aider",
    name: "Aider",
    icon: "A",
    color: "#f0ad4e",
    command: "aider",
  },
  {
    id: "gemini",
    binary: "gemini",
    name: "Gemini",
    icon: "G",
    color: "#4285f4",
    command: "gemini",
  },
  {
    id: "opencode",
    binary: "opencode",
    name: "OpenCode",
    icon: "O",
    color: "#8957e5",
    command: "opencode",
  },
  {
    id: "amp",
    binary: "amp",
    name: "Amp",
    icon: "Λ",
    color: "#3b78ff",
    command: "amp",
  },
  {
    id: "crush",
    binary: "crush",
    name: "Crush",
    icon: "C",
    color: "#ff7b72",
    command: "crush",
  },
  {
    id: "qwen-code",
    binary: "qwen-code",
    name: "Qwen Code",
    icon: "Q",
    color: "#615ced",
    command: "qwen-code",
  },
  {
    id: "kilo",
    binary: "kilo",
    name: "Kilo Code",
    icon: "K",
    color: "#f97316",
    command: "kilo",
  },
  {
    id: "pi",
    binary: "pi",
    name: "Pi",
    icon: "π",
    color: "#7c3aed",
    command: "pi",
  },
  {
    id: "cursor",
    binary: "cursor-agent",
    name: "Cursor Agent",
    icon: "▲",
    color: "#6b7280",
    command: "cursor-agent",
  },
  {
    id: "copilot",
    binary: "copilot",
    name: "GitHub Copilot",
    icon: "⊙",
    color: "#6e7681",
    command: "copilot",
  },
  {
    id: "grok",
    binary: "grok",
    name: "Grok",
    icon: "𝕏",
    color: "#111827",
    command: "grok",
  },
  {
    id: "droid",
    binary: "droid",
    name: "Droid",
    icon: "D",
    color: "#22c55e",
    command: "droid",
  },
  {
    id: "devin",
    binary: "devin",
    name: "Devin",
    icon: "◈",
    color: "#0ea5e9",
    command: "devin",
  },
  {
    id: "kimi",
    binary: "kimi",
    name: "Kimi",
    icon: "K",
    color: "#8b5cf6",
    command: "kimi",
  },
  {
    id: "hermes",
    binary: "hermes",
    name: "Hermes",
    icon: "H",
    color: "#f59e0b",
    command: "hermes",
  },
  {
    id: "qodercli",
    binary: "qodercli",
    name: "Qoder",
    icon: "Q",
    color: "#14b8a6",
    command: "qodercli",
  },
  {
    id: "antigravity",
    binary: "agy",
    name: "Antigravity",
    icon: "↑",
    color: "#ec4899",
    command: "agy",
  },
];

/** The known harnesses on the user's PATH, and the ones a login shell did not answer
 *  for in time (unknown, not missing). */
export async function probeHarnesses(): Promise<{ found: HarnessDef[]; unanswered: HarnessDef[] }> {
  const answers = await scanCommands(KNOWN_HARNESSES.map((h) => h.binary));
  const pick = (answer: string) => KNOWN_HARNESSES.filter((h) => answers.get(h.binary) === answer);
  return { found: pick("found"), unanswered: pick("no answer") };
}

export async function scanHarnesses(): Promise<HarnessDef[]> {
  return (await probeHarnesses()).found;
}
