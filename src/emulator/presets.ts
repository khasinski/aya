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

// A short roster of the most popular terminals, so the launcher stays clean in
// screenshots. Shell first, then the common agents. Add more from
// electron/harnesses.ts if a scenario needs them.
const SEEDS: PresetSeed[] = [
  { id: "shell", name: "Shell", icon: "$", color: "" },
  { id: "claude", name: "Claude Code", icon: "✻", color: "#d97757", agent: "claude" },
  { id: "codex", name: "Codex", icon: "◆", color: "#10a37f", agent: "codex" },
  { id: "gemini", name: "Gemini", icon: "G", color: "#4285f4" },
  { id: "cursor", name: "Cursor Agent", icon: "▲", color: "#6b7280", agent: "cursor" },
  { id: "copilot", name: "GitHub Copilot", icon: "⊙", color: "#6e7681", agent: "copilot" },
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
