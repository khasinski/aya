import { loadBundledScreenRules, type ScreenRuleSet } from "./screen-rule-data";
export const HOLD_RULES_UNAVAILABLE = "cannot be checked: built-in screen rules are unavailable";
export type ScreenRuleAvailability = { available: true; rules: ScreenRuleSet } | { available: false; reason: typeof HOLD_RULES_UNAVAILABLE };
/** Once per main, including a single diagnostic for an invalid whole bundle. */
export function createScreenRuleProvider(load = loadBundledScreenRules) {
  let state: ScreenRuleAvailability | undefined, logged = false;
  let log: (event: string, fields: Record<string, unknown>) => void = (event, fields) => console.error(event, fields.reason);
  return {
    setLogger(logger: typeof log): void { log = logger; },
    get(): ScreenRuleAvailability {
      if (!state) {
        try { state = { available: true, rules: load() }; }
        catch { state = { available: false, reason: HOLD_RULES_UNAVAILABLE }; }
      }
      if (!state.available && !logged) {
        logged = true;
        try { log("screen-rules-unavailable", { reason: state.reason }); } catch { /* Diagnostics never changes a hold. */ }
      }
      return state;
    },
  };
}
export const builtinScreenRules = createScreenRuleProvider();
