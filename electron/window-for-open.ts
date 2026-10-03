import { singleFlight } from "./single-flight";

/** The window an outside action lands in: the existing one, else one made once for every caller arriving meanwhile;
 *  while Aya quits there is none, since an open acked then would be lost with the process. */
export function createWindowSource<W>(
  existing: () => W | null,
  create: () => Promise<W>,
  quitting: () => boolean = () => false,
): {
  forOpen: () => Promise<W>;
  createOnce: () => Promise<W>;
} {
  const made = singleFlight(create);
  const createOnce = async (): Promise<W> => {
    if (quitting()) throw new Error("Aya is quitting; run it again once it has quit");
    return made();
  };
  return { forOpen: async () => (quitting() ? createOnce() : (existing() ?? createOnce())), createOnce };
}
