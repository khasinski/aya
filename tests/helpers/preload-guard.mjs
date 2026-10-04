// node --import: no test in the run can write the account's real config.
import { guardChildren, installGuard, protectedRoots } from "./real-config-guard.mjs";

const roots = protectedRoots();
installGuard(roots);
guardChildren(roots);
