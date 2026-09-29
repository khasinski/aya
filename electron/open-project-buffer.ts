type OpenHandler = (directory: string) => void;

/** Holds "open-project" sends until the renderer subscribes. Main delivers
 *  once the page has loaded, but the page subscribes later, in a React
 *  effect; without this the opens in between were dropped after the CLI was
 *  told they landed. The first subscriber gets what was held, once. */
export function createOpenProjectBuffer(): {
  push(directory: string): void;
  subscribe(handler: OpenHandler): () => void;
} {
  const handlers = new Set<OpenHandler>();
  let held: string[] = [];
  return {
    push(directory) {
      if (handlers.size === 0) {
        held.push(directory);
        return;
      }
      for (const handler of [...handlers]) handler(directory);
    },
    subscribe(handler) {
      handlers.add(handler);
      const flushed = held;
      held = [];
      for (const directory of flushed) handler(directory);
      return () => {
        handlers.delete(handler);
      };
    },
  };
}
