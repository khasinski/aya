// Loaded into every node child of a guarded test run: the parent's protected roots, not ones from the child's own env.
import { installGuard, protectedRoots, realHome } from "./real-config-guard.mjs";

const home = process.env.AYA_GUARD_REAL_HOME || realHome();
installGuard(process.env.AYA_GUARD_ROOTS ? JSON.parse(process.env.AYA_GUARD_ROOTS) : protectedRoots(home, {}), home);
