// Authentic default presets for the Aya emulator, mirroring the icons/colors
// of the real built-in shell preset (electron/presets.ts) and agent harnesses
// (electron/harnesses.ts). Kept as plain data so the emulator's listPresets()
// renders tabs with the same icon glyph and accent color a real Aya install
// shows. `command` is cosmetic here — the emulator never spawns a process.

import type { AgentKind, Preset } from "../types";

interface PresetSeed {
  id: string;
  name: string;
  icon: string;
  color: string;
  agent?: AgentKind;
}

// Order roughly matches Aya's own preset ordering: shell first, then the
// agent harnesses.
const SEEDS: PresetSeed[] = [
  { id: "shell", name: "Shell", icon: "$", color: "" },
  { id: "claude", name: "Claude Code", icon: "✻", color: "#d97757", agent: "claude" },
  { id: "codex", name: "Codex", icon: "◆", color: "#10a37f", agent: "codex" },
  { id: "aider", name: "Aider", icon: "A", color: "#f0ad4e" },
  { id: "gemini", name: "Gemini", icon: "G", color: "#4285f4" },
  { id: "opencode", name: "OpenCode", icon: "O", color: "#8957e5", agent: "opencode" },
  { id: "amp", name: "Amp", icon: "Λ", color: "#3b78ff" },
  { id: "crush", name: "Crush", icon: "C", color: "#ff7b72" },
  { id: "qwen-code", name: "Qwen Code", icon: "Q", color: "#615ced" },
  { id: "kilo", name: "Kilo Code", icon: "K", color: "#f97316", agent: "kilo" },
  { id: "pi", name: "Pi", icon: "π", color: "#7c3aed", agent: "pi" },
  { id: "cursor", name: "Cursor Agent", icon: "▲", color: "#6b7280", agent: "cursor" },
  { id: "copilot", name: "GitHub Copilot", icon: "⊙", color: "#6e7681", agent: "copilot" },
  { id: "grok", name: "Grok", icon: "𝕏", color: "#111827", agent: "grok" },
  { id: "droid", name: "Droid", icon: "D", color: "#22c55e", agent: "droid" },
  { id: "devin", name: "Devin", icon: "◈", color: "#0ea5e9", agent: "devin" },
  { id: "kimi", name: "Kimi", icon: "K", color: "#8b5cf6", agent: "kimi" },
  { id: "hermes", name: "Hermes", icon: "H", color: "#f59e0b", agent: "hermes" },
  { id: "qodercli", name: "Qoder", icon: "Q", color: "#14b8a6", agent: "qodercli" },
  { id: "antigravity", name: "Antigravity", icon: "↑", color: "#ec4899", agent: "antigravity" },
];

export const EMULATOR_PRESETS: Preset[] = SEEDS.map((s) => ({
  id: s.id,
  name: s.name,
  icon: s.icon,
  color: s.color,
  command: s.id === "shell" ? "$SHELL" : s.id,
  agent: s.agent,
}));

export function emulatorPreset(id: string): Preset {
  return (
    EMULATOR_PRESETS.find((p) => p.id === id) ?? {
      id,
      name: id,
      icon: "$",
      color: "",
      command: id,
    }
  );
}
