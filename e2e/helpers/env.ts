/** The runner's env minus every AYA_*: an inherited AYA_SOCKET or AYA_HOME
 *  would aim a real CLI at the developer's live app. */
export function envWithoutAya(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("AYA_")),
  ) as Record<string, string>;
}
