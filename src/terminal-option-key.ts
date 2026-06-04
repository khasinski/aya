export type MacOptionKeyMode = "right-option-compose" | "option-as-meta";
export type OptionSide = "left" | "right" | "unknown";

export const DEFAULT_MAC_OPTION_KEY_MODE: MacOptionKeyMode =
  "right-option-compose";

export function isMacOptionKeyMode(value: string | null): value is MacOptionKeyMode {
  return value === "right-option-compose" || value === "option-as-meta";
}

export function shouldUseXtermOptionAsMeta(mode: MacOptionKeyMode): boolean {
  return mode === "option-as-meta";
}

export function optionSideFromCode(code: string): OptionSide {
  if (code === "AltLeft") return "left";
  if (code === "AltRight") return "right";
  return "unknown";
}

export function leftOptionMetaSequence(
  key: string,
  code: string,
  shift: boolean,
  side: OptionSide,
  mode: MacOptionKeyMode,
): string | null {
  if (mode !== "right-option-compose") return null;
  if (side !== "left") return null;
  const keyCodeMatch = /^Key([A-Z])$/.exec(code);
  if (keyCodeMatch) {
    const letter = shift ? keyCodeMatch[1] : keyCodeMatch[1].toLowerCase();
    return `\x1b${letter}`;
  }
  if (key.length !== 1) return null;
  return `\x1b${key}`;
}
