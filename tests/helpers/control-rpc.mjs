import * as net from "node:net";

/** One JSON frame to a control socket; resolves with the first line of the reply. */
export function rpc(socket, frame) {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(socket);
    let buf = "";
    c.setEncoding("utf8");
    c.on("data", (chunk) => (buf += chunk));
    c.on("close", () => resolve(JSON.parse(buf.split("\n")[0])));
    c.on("error", reject);
    c.on("connect", () => c.write(`${JSON.stringify(frame)}\n`));
  });
}
