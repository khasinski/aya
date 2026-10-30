// The screen identity a fenced write or check names: which VT snapshot of a pane it was made against. Pure, so the
// host protocol and the main process can validate a fence without loading the VT mirror and its terminal emulator.

export interface VtSnapshotFence { generation: string; revision: string }
export function validVtSnapshotFence(value: unknown): value is VtSnapshotFence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Partial<VtSnapshotFence>;
  return Object.keys(v).length === 2 && Object.hasOwn(v, "generation") && Object.hasOwn(v, "revision") && typeof v.generation === "string" && v.generation.length > 0 && v.generation.length <= 128 &&
    typeof v.revision === "string" && /^[a-f0-9-]{36}:[1-9][0-9]{0,15}$/.test(v.revision);
}
