import net from "node:net";
import { join } from "node:path";

/** Sends one JSON line to the app's control socket; resolves on reply or close. */
export function sendControl(ayaHome: string, payload: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(join(ayaHome, "aya.sock"));
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on("data", () => resolve());
    socket.on("error", reject);
    socket.on("close", () => resolve());
  });
}

/** A request to the control socket naming pane `terminalId` as caller, with no pid (as an older CLI sends it); resolves with the parsed reply. */
export function askControl<T = { ok: boolean; error?: string }>(ayaHome: string, request: Record<string, unknown>, terminalId = "tab-left"): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(join(ayaHome, "aya.sock"));
    let reply = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ ...request, caller: { terminalId } })}\n`));
    socket.on("data", (chunk) => (reply += chunk));
    socket.on("error", reject);
    socket.on("close", () => resolve(JSON.parse(reply)));
  });
}
