// `aya rules fetch <https-url> --agent <name>`: bring a user rule file in from the web, on request and never on a
// timer. What arrives is only ever a user rule file: it passes the same closed schema, caps, additive-only checks
// and killable evaluator as one written by hand, and is validated together with the files already there before it
// is moved into place. Nothing here can weaken a built-in rule or turn a hold off.
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { MAX_RULE_FILE_BYTES, RULE_AGENTS, type RuleAgent, type ScreenRuleSet } from "./screen-rule-data";
import { parseUserRuleFile, readUserRuleFile, readUserScreenRules } from "./screen-user-rule-data";

export const RULE_FETCH_TIMEOUT_MS = 10_000;

export interface FetchedRuleFile { path: string; agent: RuleAgent; version: string; ruleCount: number; replaced: boolean }
export type FetchBytes = (url: URL, signal: AbortSignal) => Promise<Buffer>;

function refuse(reason: string): never { throw new Error(reason); }

/** The default transport: https only, at most MAX_RULE_FILE_BYTES read, a redirect must stay on https. */
export const fetchRuleBytes: FetchBytes = async (url, signal) => {
  const response = await fetch(url, { signal, redirect: "follow", headers: { accept: "application/json" } });
  if (new URL(response.url).protocol !== "https:") refuse("the address redirected away from https");
  if (!response.ok) refuse(`the server answered ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) refuse("the server sent no data");
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RULE_FILE_BYTES) { await reader.cancel(); refuse(`the file is larger than ${MAX_RULE_FILE_BYTES / 1024} KiB`); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
};

export async function fetchUserRuleFile(options: {
  url: string; agent: string; replace: boolean; directory: string; builtin: ScreenRuleSet;
  fetchBytes?: FetchBytes; timeoutMs?: number;
}): Promise<FetchedRuleFile> {
  const agent = RULE_AGENTS.find((name) => name === options.agent);
  if (!agent) refuse(`unknown agent "${options.agent}"; use one of ${RULE_AGENTS.join(", ")}`);
  let url: URL;
  try { url = new URL(options.url); } catch { refuse("that is not a web address"); }
  if (url.protocol !== "https:") refuse("only https addresses are fetched");
  if (url.username || url.password) refuse("the address must not carry a user name or password");

  const target = path.join(options.directory, `${agent}.json`);
  const existed = fs.existsSync(target);
  if (existed && !options.replace) refuse(`${agent}.json is already there; pass --replace to overwrite it`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? RULE_FETCH_TIMEOUT_MS);
  let bytes: Buffer;
  try { bytes = await (options.fetchBytes ?? fetchRuleBytes)(url, controller.signal); }
  catch (error) { refuse(controller.signal.aborted ? "the server did not answer in time" : `could not fetch it: ${error instanceof Error ? error.message : "unknown error"}`); }
  finally { clearTimeout(timer); }

  let parsed: ReturnType<typeof parseUserRuleFile>;
  try { parsed = parseUserRuleFile(bytes, agent); }
  catch (error) { refuse(`not a valid rule file for ${agent}: ${error instanceof Error ? error.message : "unreadable"}`); }

  fs.mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  // Validate the file together with the others already in the folder (id collisions, counts), in a scratch copy:
  // the live folder is only touched once the whole set is acceptable.
  const scratch = fs.mkdtempSync(path.join(path.dirname(options.directory), ".screen-rules-candidate-"));
  try {
    fs.chmodSync(scratch, 0o700);
    for (const other of RULE_AGENTS) {
      if (other === agent) continue;
      const file = path.join(options.directory, `${other}.json`);
      if (fs.existsSync(file)) fs.writeFileSync(path.join(scratch, `${other}.json`), readUserRuleFile(file), { mode: 0o600 });
    }
    fs.writeFileSync(path.join(scratch, `${agent}.json`), bytes, { mode: 0o600 });
    try { readUserScreenRules(scratch, options.builtin); }
    catch (error) { refuse(`it does not fit with the other rules: ${error instanceof Error ? error.message : "refused"}`); }
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }

  const temporary = path.join(options.directory, `.${agent}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, target);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  return { path: target, agent, version: parsed.version, ruleCount: parsed.rules.length, replaced: existed };
}
