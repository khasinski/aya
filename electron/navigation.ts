export function parseHttpUrl(raw: string): URL | null {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed
      : null;
  } catch {
    return null;
  }
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
