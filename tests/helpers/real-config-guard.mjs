// Limits: guards fs writes and socket connects in this process and node children (guardChildren); other children's
// writes show only in the exit-time mtime check of isolate-home.mjs.
import fs from "node:fs";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
import { userInfo } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The account's home from the passwd entry: $HOME is what a test overrides. */
export const realHome = () => userInfo().homedir;

const AGENT_DOT_DIR = /^\.(claude|codex|aya|grok|gemini|opencode|antigravity)/;
const AGENT_SUBDIRS = [join(".config", "opencode"), join(".local", "share", "opencode"), join(".config", "gemini")];

/** Whether `p` is inside an agent CLI's top-level dot-dir of `home`, existing or not. */
export function inAgentDir(p, home) {
  return AGENT_DOT_DIR.test(relative(home, p).split(sep)[0]);
}

/** Every place an agent CLI or Aya keeps config or sessions that exists now: any ~/.claude*,
 *  ~/.codex*, ~/.aya*, ~/.grok*, OpenCode's and Gemini's dirs, and the dirs the env names. */
export function protectedRoots(home = realHome(), env = process.env) {
  const dotDirs = fs.readdirSync(home).filter((name) => AGENT_DOT_DIR.test(name));
  const named = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "AYA_HOME", "GROK_HOME"].map((key) => env[key]).filter(Boolean);
  return [
    ...dotDirs.map((name) => join(home, name)),
    ...AGENT_SUBDIRS.map((dir) => join(home, dir)),
    ...named.map((dir) => resolve(dir)),
  ];
}

/** Files whose change after a test proves something bypassed the guard (a child process). */
export function protectedFiles(home = realHome(), env = process.env) {
  const files = [];
  for (const root of protectedRoots(home, env)) {
    for (const name of ["settings.json", "AGENTS.md", "config.toml", "presets.json", "auth.json"]) files.push(join(root, name));
  }
  return files;
}

const PATH_ARGS = {
  writeFile: [0], appendFile: [0], mkdir: [0], mkdtemp: [0], rm: [0], rmdir: [0], unlink: [0], truncate: [0],
  chmod: [0], chown: [0], utimes: [0], rename: [0, 1], copyFile: [1], cp: [1], symlink: [1], link: [1],
  createWriteStream: [0], open: [0],
};
const READ_FLAGS = new Set([undefined, "r", "rs", "sr"]);

const asPath = (p) => {
  if (p instanceof URL) return fileURLToPath(p);
  if (typeof p === "string" || Buffer.isBuffer(p)) return resolve(p.toString());
  return null;
};

const { realpathSync } = fs;
/** The path with its symlinks resolved as far as it exists. */
function realpathOrSelf(p) {
  try {
    return realpathSync(p);
  } catch {
    const parent = dirname(p);
    return parent === p ? p : join(realpathOrSelf(parent), basename(p));
  }
}

/** Makes any write into `roots`, or into an agent dot-dir of `home` even if absent, throw
 *  in this process through the fs APIs. */
export function installGuard(roots, home = realHome()) {
  const guarded = [...new Set(roots.flatMap((root) => [root, realpathOrSelf(root)]))];
  const homes = [...new Set([home, realpathOrSelf(home)])];
  // macOS volumes ignore case by default: ~/.AYA/aya.sock is ~/.aya/aya.sock there.
  const fold = process.platform === "darwin" ? (p) => p.toLowerCase() : (p) => p;
  const inside = (p) =>
    guarded.some((root) => fold(p) === fold(root) || fold(p).startsWith(fold(root) + sep)) || homes.some((h) => inAgentDir(fold(p), fold(h)));
  const check = (p) => {
    const abs = asPath(p);
    if (abs && (inside(abs) || inside(realpathOrSelf(abs)))) throw new Error(`test tried to write the real config: ${abs}`);
  };
  const wrap = (target, name, name2, indexes) => {
    const original = target[name2];
    if (typeof original !== "function") return;
    target[name2] = function (...args) {
      if (name !== "open" || !READ_FLAGS.has(args[1])) for (const i of indexes) check(args[i]);
      return original.apply(this, args);
    };
  };
  // A socket under the real ~/.aya is the live Aya or pty host: a test's shutdown there closes the user's panes.
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0]; // net.createConnection passes its normalized args
    const target = typeof first === "string" ? first : first?.path;
    const abs = typeof target === "string" ? asPath(target) : null;
    if (abs && (inside(abs) || inside(realpathOrSelf(abs)))) throw new Error(`test tried to connect to the real Aya: ${abs}`);
    return connect.apply(this, args);
  };
  for (const [name, indexes] of Object.entries(PATH_ARGS)) {
    wrap(fs, name, name, indexes);
    wrap(fs, name, `${name}Sync`, indexes);
    wrap(fs.promises, name, name, indexes);
  }
  syncBuiltinESMExports();
}

/** Hands the guard to node children: a test that spawns node without the preload would otherwise reach the real Aya. */
export function guardChildren(roots, home = realHome()) {
  const child = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "preload-guard-child.mjs")).href;
  process.env.AYA_GUARD_ROOTS = JSON.stringify(roots);
  process.env.AYA_GUARD_REAL_HOME = home;
  if (!(process.env.NODE_OPTIONS ?? "").includes(child)) process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} --import ${child}`.trim();
}
