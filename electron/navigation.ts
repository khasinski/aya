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

export function isInternalNavigationUrl(
  raw: string,
  options: { isDev: boolean; devServerUrl: string },
): boolean {
  if (options.isDev) {
    try {
      return new URL(raw).origin === new URL(options.devServerUrl).origin;
    } catch {
      return false;
    }
  }
  return raw.startsWith("file:");
}
