import { oneAtATime } from "./keyed-queue";
const serial = oneAtATime();
export function projectStateTransaction<T>(work: () => Promise<T>): Promise<T> { return serial("projects-state", work); }
