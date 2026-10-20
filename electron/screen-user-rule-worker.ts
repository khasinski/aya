// The only production module that constructs/evaluates user RegExp objects.
import {parentPort, workerData} from "node:worker_threads";
import type {UserRuleManifest} from "./screen-user-rule-data";
import type {RuleAgent, RuleKind, ScreenRegion} from "./screen-rule-data";
const manifest = workerData as UserRuleManifest;
try {
  const sets = Object.fromEntries(Object.entries(manifest.sets).map(([agent,rules]) => [agent,rules.map(rule => ({...rule,compiled:new RegExp(rule.pattern,rule.flags)}))]));
  parentPort!.on("message", (request: {id:number;agent:RuleAgent;regions:Record<ScreenRegion,string>}) => {
    const matches: {id:string;kind:RuleKind;region:ScreenRegion;start:number;length:number}[] = [];
    const kinds = new Set<RuleKind>();
    for (const rule of sets[request.agent]) {
      if (kinds.has(rule.kind)) continue;
      const match = rule.compiled.exec(request.regions[rule.region]);
      if (match) { kinds.add(rule.kind); matches.push({id:rule.id,kind:rule.kind,region:rule.region,start:match.index,length:match[0].length}); }
    }
    parentPort!.postMessage({type:"result",id:request.id,digest:manifest.digest,matches});
  });
  parentPort!.postMessage({type:"ready",digest:manifest.digest});
} catch {
  // Do not expose a pattern, screen, stack or environment through diagnostics.
  parentPort!.postMessage({type:"failed"});
}
