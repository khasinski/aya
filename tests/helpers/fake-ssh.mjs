import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeExecutable } from "./executable.mjs";

/** A fake `ssh` in `<dir>/bin`: per alias, `<dir>/<alias>.mode` says ok:<fixture file> | down | hang | denied.
 *  Every call appends its argv to `<dir>/calls` and saves the script it got on stdin. Never reaches a real host. */
export function installFakeSsh(dir) {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const script = `#!/bin/sh
dir="${dir}"
echo "$*" >> "$dir/calls"
alias=""
seen_dashdash=""
for a do
  if [ -n "$seen_dashdash" ]; then alias="$a"; break; fi
  [ "$a" = "--" ] && seen_dashdash=1
done
cat > "$dir/stdin-$alias"
mode=$(cat "$dir/$alias.mode" 2>/dev/null || echo unknown)
case "$mode" in
  ok:*) cat "\${mode#ok:}" ;;
  down) echo "ssh: connect to host $alias port 22: Operation timed out" >&2; exit 255 ;;
  denied) echo "$alias: Permission denied (publickey)." >&2; exit 255 ;;
  unknown-key) printf "No ED25519 host key is known for %s and you have requested strict checking.\nHost key verification failed.\n" "$alias" >&2; exit 255 ;;
  changed-key) printf "WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\nOffending ED25519 key in /private/fake/known_hosts:4\nHost key verification failed.\n" >&2; exit 255 ;;
  hang) sleep 30 ;;
  *) echo "ssh: Could not resolve hostname $alias: nodename nor servname provided, or not known" >&2; exit 255 ;;
esac
`;
  writeExecutable(join(bin, "ssh"), script);
  return {
    bin,
    setMode(alias, mode) {
      writeFileSync(join(dir, `${alias}.mode`), mode);
    },
  };
}
