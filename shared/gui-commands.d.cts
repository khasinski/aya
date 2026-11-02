export function guiCommands(agent: 'codex' | 'claude' | 'pi' | 'antigravity'): { name: string; description: string }[];

export function guiCapabilities(agent: 'codex' | 'claude' | 'pi' | 'antigravity'): { steer: boolean; sideQuestions: boolean };
