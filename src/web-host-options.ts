// Aya Web: the listen addresses Settings offers, as [host, label] pairs.

import type { WebServerStatus } from "./types";

export const WEB_LOOPBACK_HOST = "127.0.0.1";
export const WEB_ALL_NETWORKS_HOST = "0.0.0.0";

/** This computer only, every network, then each interface address. The saved address comes first when it is none
 *  of those (an edited web.json, or an interface that is gone), so the select never shows a choice that is not
 *  the one in use. */
export function webHostOptions(
  status: Pick<WebServerStatus, "host" | "addresses">,
): Array<[string, string]> {
  const options: Array<[string, string]> = [
    [WEB_LOOPBACK_HOST, `This computer only (${WEB_LOOPBACK_HOST})`],
    [WEB_ALL_NETWORKS_HOST, `All networks (${WEB_ALL_NETWORKS_HOST})`],
  ];
  for (const { name, address } of status.addresses) {
    if (!options.some(([host]) => host === address)) options.push([address, `${name} (${address})`]);
  }
  if (status.host && !options.some(([host]) => host === status.host)) {
    options.unshift([status.host, `${status.host} (from web.json)`]);
  }
  return options;
}
