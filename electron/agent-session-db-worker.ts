import { parentPort } from 'node:worker_threads';
import { readCodexSessionIdLocally } from './agent-session';
parentPort!.on('message', async ({ id, args }: { id: number; args: [string, string, number[], number] }) => {
  try { parentPort!.postMessage({ id, value: await readCodexSessionIdLocally(...args) }); }
  catch (error) { parentPort!.postMessage({ id, error: error instanceof Error ? error.message : String(error) }); }
});
