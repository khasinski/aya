// Aya Web: the listen addresses Settings offers, as [host, label] pairs.

import type { WebServerStatus } from "./types";

export const WEB_LOOPBACK_HOST = "127.0.0.1";
export const WEB_ALL_NETWORKS_HOST = "0.0.0.0";

/** True for an address that listens on every network: Settings then warns that nothing is encrypted. IPv6 has many
 *  spellings of one address (0:0:0:0:0:0:0:0 is ::), so it is compared in the form the URL parser writes. */
export function listensOnAllNetworks(host: string): boolean {
  if (host === WEB_ALL_NETWORKS_HOST) return true;
  if (!host.includes(":")) return false;
  try {
    const canonical = new URL(`http://[${host}]`).hostname;
    // :: listens on every IPv6 network (and IPv4 too on a dual-stack system); ::ffff:0:0 is 0.0.0.0 mapped into IPv6.
    return canonical === "[::]" || canonical === "[::ffff:0:0]";
  } catch {
    return false;
  }
}

/** The warning Settings shows while Aya Web listens, or will listen, on every network; null otherwise. */
export function allNetworksWarning(status: Pick<WebServerStatus, "host" | "enabled">): string | null {
  if (!listensOnAllNetworks(status.host)) return null;
  return `${status.enabled ? "Aya Web listens" : "Aya Web will listen"} on every network this computer joins, a cafe or hotel Wi-Fi too, and the password and your terminals travel unencrypted.`;
}

/** This computer only, every IPv4 network, then each interface address. The saved address comes first when it is none
 *  of those (an edited web.json, or an interface that is gone), so the select never shows a choice that is not
 *  the one in use. */
export function webHostOptions(
  status: Pick<WebServerStatus, "host" | "addresses">,
): Array<[string, string]> {
  const options: Array<[string, string]> = [
    [WEB_LOOPBACK_HOST, `This computer only (${WEB_LOOPBACK_HOST})`],
    [WEB_ALL_NETWORKS_HOST, `All IPv4 networks (${WEB_ALL_NETWORKS_HOST})`],
  ];
  for (const { name, address } of status.addresses) {
    if (!options.some(([host]) => host === address)) options.push([address, `${name} (${address})`]);
  }
  if (status.host && !options.some(([host]) => host === status.host)) {
    options.unshift([status.host, `${status.host} (from web.json)`]);
  }
  return options;
}
