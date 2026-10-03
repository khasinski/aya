// The guard's own tests: like preload-guard.mjs, aimed at the fake home AYA_GUARD_HOME names.
import { guardChildren, installGuard, protectedRoots } from "./real-config-guard.mjs";

const roots = protectedRoots(process.env.AYA_GUARD_HOME);
installGuard(roots, process.env.AYA_GUARD_HOME);
guardChildren(roots, process.env.AYA_GUARD_HOME);
