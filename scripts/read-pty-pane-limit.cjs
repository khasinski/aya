const ts = require("typescript");

function readPtyPaneLimit(source) {
  const file = ts.createSourceFile("pty-pane-limits.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (file.parseDiagnostics.length) throw new Error("Could not parse the shared PTY pane limit");
  const declarations = [];
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === "MAX_PTY_PANES") {
        declarations.push({ statement, declaration });
      }
    }
  }
  if (declarations.length !== 1) throw new Error("Expected exactly one shared PTY pane limit");
  const { statement, declaration } = declarations[0];
  const exported = statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
  if (!exported || !(statement.declarationList.flags & ts.NodeFlags.Const) ||
      statement.declarationList.declarations.length !== 1 || !declaration.initializer ||
      !ts.isNumericLiteral(declaration.initializer) || !/^[0-9]+$/.test(declaration.initializer.text)) {
    throw new Error("Shared PTY pane limit must be one exported integer literal");
  }
  const value = Number(declaration.initializer.text);
  if (!Number.isSafeInteger(value) || value < 1 || value > 512) throw new Error("Invalid shared PTY pane limit");
  return value;
}

module.exports = { readPtyPaneLimit };
