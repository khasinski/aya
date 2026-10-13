import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";

interface OpenQueueDrainOptions {
  didBootstrap: boolean;
  openQueue: string[];
  openProjectRef: RefObject<(dir: string) => Promise<void>>;
  openRunningRef: RefObject<boolean>;
  unsavedOpensRef: RefObject<string[]>;
  setUnsavedOpensTick: Dispatch<SetStateAction<number>>;
  setOpenQueue: Dispatch<SetStateAction<string[]>>;
}

export function useOpenQueue() {
  // Handle "open this directory" requests from main — fired by `aya <dir>`
  // CLI invocations and the initial argv. Subscribed once; uses a ref to
  // always see the latest projects + handlers without resubscribing. The
  // preload holds opens sent before this subscribes and hands them over here.
  //
  // The IPC can arrive on `did-finish-load`, which is BEFORE the bootstrap
  // useEffect has populated projects state. If we processed it then, the
  // "find by directory" check sees an empty list and falls through to
  // auto-create — producing a duplicate next to whatever bootstrap loads.
  // So requests queue until bootstrap signals ready, then run one at a time.
  const openProjectRef = useRef<(dir: string) => Promise<void>>(async () => {});
  const [openQueue, setOpenQueue] = useState<string[]>([]);
  const openRunningRef = useRef(false);
  // Opens the page finished but whose project state the writer below has not saved:
  // main sends them again after a reload until this page says they are on disk.
  const unsavedOpensRef = useRef<string[]>([]);
  const [unsavedOpensTick, setUnsavedOpensTick] = useState(0);
  useEffect(() => {
    return window.aya.onOpenProject((dir) => {
      setOpenQueue((queue) => [...queue, dir]);
    });
  }, []);

  return {
    openProjectRef,
    unsavedOpensRef,
    unsavedOpensTick,
    drain: {
      openQueue,
      openProjectRef,
      openRunningRef,
      unsavedOpensRef,
      setUnsavedOpensTick,
      setOpenQueue,
    },
  };
}

export function useOpenQueueDrain({
  didBootstrap,
  openQueue,
  openProjectRef,
  openRunningRef,
  unsavedOpensRef,
  setUnsavedOpensTick,
  setOpenQueue,
}: OpenQueueDrainOptions) {
  // Drain the open-project queue once bootstrap commits. Running this in a
  // useEffect (not inline after setDidBootstrap) guarantees React has flushed
  // setProjects → projectsRef.current before the handler tries to match by
  // directory. Without this gate the drain raced the commit and "aya <known
  // project path>" auto-created a duplicate, hitting the slug-collision error.
  // One open per commit for the same reason: two concurrent opens each built on
  // the same stale project list, and the second dropped the first.
  useEffect(() => {
    if (!didBootstrap || openRunningRef.current || openQueue.length === 0) return;
    openRunningRef.current = true;
    const dir = openQueue[0];
    void openProjectRef.current(dir).catch((err) => {
      console.warn(`[aya] could not open ${dir}:`, err);
    }).finally(() => {
      unsavedOpensRef.current.push(dir);
      setUnsavedOpensTick((tick) => tick + 1);
      openRunningRef.current = false;
      setOpenQueue((queue) => queue.slice(1));
    });
  }, [
    didBootstrap,
    openQueue,
    openProjectRef,
    openRunningRef,
    unsavedOpensRef,
    setUnsavedOpensTick,
    setOpenQueue,
  ]);
}
