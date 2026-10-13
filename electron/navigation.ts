import type { Shell } from "electron";
import { fileURLToPath } from "node:url";

export interface ExternalUrlDeps {
  shell: Pick<Shell, "openPath" | "openExternal">;
}

const EXTERNAL_URL_PROTOCOLS = new Set([
  "http:",
  "https:",
  "file:",
  "vscode:",
  "vscode-insiders:",
  "cursor:",
  "zed:",
  "jetbrains:",
]);

export function parseExternalUrl(raw: string): URL | null {
  try {
    const parsed = new URL(raw);
    return EXTERNAL_URL_PROTOCOLS.has(parsed.protocol) ? parsed : null;
  } catch {
    return null;
  }
}

export function isInternalNavigationUrl(
  raw: string,
  options: { isDev: boolean; devServerUrl: string; appIndexPath?: string },
): boolean {
  if (options.isDev) {
    try {
      return new URL(raw).origin === new URL(options.devServerUrl).origin;
    } catch {
      return false;
    }
  }
  if (!options.appIndexPath) return false;
  try {
    const parsed = new URL(raw);
    return (
      parsed.protocol === "file:" &&
      decodeURIComponent(parsed.pathname) === options.appIndexPath
    );
  } catch {
    return false;
  }
}

export async function openExternalUrl(raw: string, deps: ExternalUrlDeps): Promise<void> {
  const parsed = parseExternalUrl(raw);
  if (!parsed) throw new Error("Unsupported external URL.");
  if (parsed.protocol === "file:") {
    const error = await deps.shell.openPath(fileURLToPath(parsed));
    if (error) throw new Error(error);
    return;
  }
  await deps.shell.openExternal(parsed.toString());
}
