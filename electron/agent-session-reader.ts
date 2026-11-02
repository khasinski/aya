import { Worker } from 'node:worker_threads';
import * as path from 'node:path';
let worker: Worker | null = null;
let nextId = 0;
let retiring = false;
function stopWorker(current: Worker): void {
  if (worker !== current || retiring) return;
  retiring = true; current.unref();
  void current.terminate().catch(() => {}).finally(() => { if (worker === current) worker = null; retiring = false; });
}
let idleTimer: ReturnType<typeof setTimeout> | undefined;
const pending = new Map<number, { resolve: (id: string | null) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
export function readSessionDatabase(args: [string, string, number[], number]): Promise<string | null> {
  if (retiring) return Promise.reject(new Error("Session database reader is restarting"));
  if (idleTimer) clearTimeout(idleTimer);
  if (!worker) {
    const current = new Worker(path.join(__dirname, 'agent-session-db-worker.js'));
    worker = current;
    const fail = (error: Error) => {
      if (worker !== current) return;
      if (retiring) return;
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
      pending.clear();
      stopWorker(current);
    };
    current.on('error', fail);
    current.on('exit', code => fail(new Error(`Session database reader exited (${code})`)));
    current.on('message', (message: { id: number; value?: string | null; error?: string }) => {
      const entry = pending.get(message.id); if (!entry) return;
      pending.delete(message.id); clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error)); else entry.resolve(message.value ?? null);
      if (!pending.size) {
        current.unref();
        idleTimer = setTimeout(() => { if (worker === current && !pending.size) { stopWorker(current); } }, 30000);
        idleTimer.unref();
      }
    });
  }
  const current = worker;
  current.ref();
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      if (worker !== current) return;
      stopWorker(current);
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Session database read timed out')); }
      pending.clear();
    }, 10000);
    pending.set(id, { resolve, reject, timer });
    try { current.postMessage({ id, args }); }
    catch (error) { clearTimeout(timer); pending.delete(id); if (!pending.size) current.unref(); reject(error); }
  });
}
