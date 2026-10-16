// A deliberately conservative regex grammar for data, independent of RegExp execution.
import { RegExpParser, visitRegExpAST, type AST } from "@eslint-community/regexpp";

function nullable(node: AST.Node): boolean {
  switch (node.type) {
    case "Assertion": return true;
    case "Alternative": return node.elements.every(nullable);
    case "Pattern": case "Group": case "CapturingGroup": return node.alternatives.some(nullable);
    case "Quantifier": return node.min === 0 || nullable(node.element);
    default: return false;
  }
}
// Unknown character sets deliberately overlap everything. Literal alternatives
// use exact ASCII without flags, conservative folding for i/u, and unknown
// for unmodelled Unicode folds. Unknown never proves disjointness.
function first(node: AST.Node, fold: boolean): Set<string> | null {
  switch (node.type) {
    case "Character": return fold && node.value > 127 ? null : new Set([fold ? String.fromCodePoint(node.value).toLowerCase() : String.fromCodePoint(node.value)]);
    case "CharacterSet": {
      if (node.kind === "property" || node.kind === "any" || node.negate) return null;
      const chars = node.kind === "digit" ? "0123456789" : node.kind === "word" ? "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_ſK" : " \t\n\r\f\v\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
      return new Set([...chars].map(c => fold ? c.toLowerCase() : c));
    }
    case "Quantifier": return first(node.element, fold);
    case "Alternative": {
      const result = new Set<string>();
      for (const part of node.elements) {
        if (part.type === "Assertion") continue;
        const chars = first(part, fold); if (!chars) return null;
        for (const c of chars) result.add(c);
        if (!nullable(part)) break;
      }
      return result;
    }
    case "Group": case "CapturingGroup": {
      const result = new Set<string>();
      for (const alt of node.alternatives) {
        const chars = first(alt, fold); if (!chars) return null;
        for (const c of chars) result.add(c);
      }
      return result;
    }
    default: return null;
  }
}

// A finite repeated group containing an unbounded repeat needs a mandatory
// separator which that repeat cannot consume (the built-in trailing rows use LF).
// This excludes (a+){1,100} as well as the familiar unbounded nested shape.
function mandatoryLiterals(node: AST.Node): Set<number> {
  if (node.type === "Character") return new Set([node.value]);
  if (node.type === "Alternative") return new Set(node.elements.flatMap(e => [...mandatoryLiterals(e)]));
  if (node.type === "Group" || node.type === "CapturingGroup") {
    const sets = node.alternatives.map(mandatoryLiterals);
    return new Set([...(sets[0] ?? [])].filter(c => sets.every(s => s.has(c))));
  }
  if (node.type === "Quantifier" && Number.isFinite(node.max) && node.min > 0) return mandatoryLiterals(node.element);
  return new Set();
}
function canConsume(node: AST.Node, code: number, fold: boolean): boolean {
  if (fold && code > 127) return true; // Unmodelled Unicode folds cannot establish disjointness.
  switch (node.type) {
    case "Character": return node.value === code || (fold && String.fromCodePoint(node.value).toLowerCase() === String.fromCodePoint(code).toLowerCase());
    case "CharacterClassRange": return (fold ? [code, ...[...String.fromCodePoint(code).toLowerCase(), ...String.fromCodePoint(code).toUpperCase()].map(c => c.codePointAt(0)!)] : [code]).some(c => c >= node.min.value && c <= node.max.value);
    case "CharacterClass": { if (fold && node.negate) return true; const match = node.elements.some(e => canConsume(e, code, fold)); return node.negate ? !match : match; }
    case "CharacterSet":
      if (node.kind === "any") return ![10,13,0x2028,0x2029].includes(code);
      if (node.kind === "property") return true;
      { const c = String.fromCodePoint(code); const match = node.kind === "space" ? /\s/u.test(c) : node.kind === "digit" ? /[0-9]/.test(c) : /[a-zA-Z0-9_]/.test(c); return node.negate ? !match : match; }
    case "Quantifier": return canConsume(node.element, code, fold);
    case "Group": case "CapturingGroup": return node.alternatives.some(a => canConsume(a, code, fold));
    case "Alternative": return node.elements.some(e => canConsume(e, code, fold));
    case "Assertion": return false;
    default: return true;
  }
}

function flatten(elements: readonly AST.Element[]): AST.Element[] {
  return elements.flatMap(e => (e.type === "Group" || e.type === "CapturingGroup") && e.alternatives.length === 1 ? flatten(e.alternatives[0].elements) : [e]);
}

function ancestors(node: AST.Node): AST.Node[] {
  const result: AST.Node[] = []; let parent: AST.Node | null = node.parent;
  while (parent) {
    // Assertions are atomic zero-width submatchers: repetitions outside do
    // not backtrack into a successful lookahead. Analyze its body separately.
    if (parent.type === "Assertion" && parent.kind === "lookahead") break;
    result.push(parent); parent = parent.parent;
  }
  return result;
}

export function validateScreenPattern(source: string, flags: string): void {
  if (typeof source !== "string" || source.length === 0 || source.length > 2048) throw new Error("Invalid screen rule pattern length");
  if (typeof flags !== "string" || !/^[imu]*$/.test(flags) || new Set(flags).size !== flags.length) throw new Error("Invalid screen rule flags");
  const fold = flags.includes("i") || flags.includes("u");
  const ast = new RegExpParser({ ecmaVersion: 2022 }).parsePattern(source, 0, source.length, { unicode: flags.includes("u") });
  let nodes = 0;
  visitRegExpAST(ast, {
    onBackreferenceEnter() { throw new Error("Unsafe screen rule backreference"); },
    onAssertionEnter(node) { if (node.kind === "lookbehind") throw new Error("Unsupported screen rule lookbehind"); },
    onQuantifierEnter(node) {
      if (++nodes > 512) throw new Error("Screen rule repetition budget");
      if (node.max > 1 && nullable(node.element)) throw new Error("Unsafe screen rule nullable repetition");
      let finiteExpansion = Number.isFinite(node.max) ? node.max : 1;
      for (const parent of ancestors(node)) {
        if (parent.type !== "Quantifier") continue;
        if (node.max === Infinity && parent.max === Infinity) throw new Error("Unsafe screen rule nested unbounded repetition");
        if (Number.isFinite(parent.max)) {
          finiteExpansion *= parent.max;
          if (node.max === Infinity && parent.max > 1 && ![...mandatoryLiterals(parent.element)].some(c => !canConsume(node.element, c, fold))) throw new Error("Unsafe screen rule bounded nested repetition without separator");
        }
      }
      if (finiteExpansion > 4096) throw new Error("Screen rule finite repetition budget");
    },
    onAlternativeEnter(node) {
      let insideAssertion = false;
      for (let p: AST.Node | null = node.parent; p; p = p.parent) if (p.type === "Assertion" && p.kind === "lookahead") insideAssertion = true;
      if (!insideAssertion) return;
      let previous: Set<string> | null | undefined;
      for (const e of flatten(node.elements)) {
        if (e.type === "Assertion") continue;
        if (e.type === "Quantifier" && e.max === Infinity) {
          const current = first(e, fold);
          if (previous !== undefined && (!previous || !current || [...previous].some(c => current.has(c)))) throw new Error("Unsafe screen rule overlapping assertion repetitions");
          previous = current;
        } else if (!nullable(e)) previous = undefined;
      }
    },
    onGroupEnter: checkAlternatives,
    onCapturingGroupEnter: checkAlternatives,
  });
  function checkAlternatives(node: AST.Group | AST.CapturingGroup): void {
    let repeated = false;
    for (const p of ancestors(node)) if (p.type === "Quantifier" && p.max > 3) repeated = true;
    if (!repeated || node.alternatives.length < 2) return;
    const sets = node.alternatives.map(a => first(a, fold));
    for (let a = 0; a < sets.length; a++) for (let b = a + 1; b < sets.length; b++) {
      const left = sets[a], right = sets[b];
      if (!left || !right || [...left].some(c => right.has(c))) throw new Error("Unsafe screen rule repeated overlapping alternatives");
    }
  }
}
