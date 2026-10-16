// Pure additive composition only. The coordinator must establish snapshot,
// caller/exclusion and rule-epoch freshness before using any decision for input.
import type {RuleAgent} from "./screen-rule-data";
import type {UserRuleManifest} from "./screen-user-rule-data";
import type {UserRuleRequest, UserRuleResult} from "./screen-user-rule-runtime";
import {screenRuleExcerpt, type ScreenRuleMatch} from "./agent-screen-rules";
import {HOLD_ACCOUNT_SETTING, HOLD_APPROVAL, HOLD_USAGE_LIMIT, isDialogHold, isUserOnlyHold} from "./pane-holds";

export const HOLD_USER_ACCOUNT = "shows a user-defined account-setting dialog that only you may answer";
export const HOLD_USER_RULES_UNKNOWN = "user screen rules are unavailable; automated input is held";
export interface BuiltinPaneDecision {hold:string|null;busy:boolean;waiting:boolean|null}
export interface AdditivePaneDecision extends BuiltinPaneDecision {
  // Delivery must check this contribution independently of the display hold,
  // including before Enter when the builtin draft hold alone may be allowed.
  userHold:string|null;
  blocksAutomatedInput:boolean;
  inputProtection:string|null;
  user:{available:boolean;digest:string|null;reason?:string;evidence:readonly ScreenRuleMatch[]};
}
/** Never execute patterns or replace builtin policy. Account protection is an
 * independent result: a builtin display reason must not hide a user-only hold. */
export function composeUserRuleDecision(
  builtin:BuiltinPaneDecision,
  context:{agent:RuleAgent;regions:UserRuleRequest["regions"];recoveryUnknown?:boolean},
  manifest:UserRuleManifest|null,
  result:UserRuleResult,
):AdditivePaneDecision {
  const baseProtection=isUserOnlyHold(builtin.hold)?HOLD_ACCOUNT_SETTING:null;
  const base={...builtin,userHold:null,blocksAutomatedInput:!!baseProtection,inputProtection:baseProtection};
  if(!manifest)return {...base,user:{available:true,digest:null,evidence:[]}};
  const unknown=():AdditivePaneDecision=>({...base,hold:builtin.hold??HOLD_USER_RULES_UNKNOWN,waiting:builtin.waiting===true?true:null,blocksAutomatedInput:true,inputProtection:baseProtection??HOLD_USER_RULES_UNKNOWN,user:{available:false,digest:manifest.digest,reason:HOLD_USER_RULES_UNKNOWN,evidence:[]}});
  if(!result.available||result.digest!==manifest.digest||context.recoveryUnknown)return unknown();
  const evidence:ScreenRuleMatch[]=[];
  for(const match of result.matches){
    const rule=manifest.sets[context.agent].find(rule=>rule.id===match.id);
    const text=context.regions[match.region];
    if(!rule||rule.kind!==match.kind||rule.region!==match.region||typeof text!=="string"||!Number.isSafeInteger(match.start)||!Number.isSafeInteger(match.length)||match.start<0||match.length<0||match.start>text.length||match.length>text.length-match.start||evidence.some(e=>e.kind===match.kind))return unknown();
    evidence.push({id:rule.id,kind:rule.kind,region:rule.region,source:rule.source,version:rule.version,digest:manifest.digest,excerpt:screenRuleExcerpt(text.slice(match.start,match.start+match.length))});
  }
  const has=(kind:ScreenRuleMatch["kind"])=>evidence.some(e=>e.kind===kind);
  // Suppressors never cancel dialogs or any builtin verdict.
  const userWaiting=has("dialog")||(has("prompt")&&!has("suppressor"));
  const dialog=builtin.waiting===true||isDialogHold(builtin.hold)||userWaiting;
  const userAccount=dialog&&has("account-setting"),userUsage=dialog&&has("usage-limit");
  const userHold=userAccount?HOLD_USER_ACCOUNT:userUsage?HOLD_USAGE_LIMIT:userWaiting?HOLD_APPROVAL:null;
  const protection=baseProtection??(userAccount?HOLD_USER_ACCOUNT:null);
  // Account/usage transcript matches are not active holds; retain a suppressor
  // as explain evidence without suggesting it removed builtin protection.
  const active=evidence.filter(e=>(e.kind!=="account-setting"&&e.kind!=="usage-limit")||dialog);
  return {...base,hold:builtin.hold??userHold,busy:builtin.busy||has("busy"),waiting:builtin.waiting===true||userWaiting?true:builtin.waiting,userHold,blocksAutomatedInput:!!protection,inputProtection:protection,user:{available:true,digest:manifest.digest,evidence:active}};
}
