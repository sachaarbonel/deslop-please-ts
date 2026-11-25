import path from "node:path";
import ts from "typescript";
import type { AnalyzeOptions, Location } from "./types";

export interface Item {
  key: string;
  name: string;
  kind: "type" | "function" | "constant" | "field";
  node: ts.Node;
  file: ts.SourceFile;
  owner?: Item;
}

export interface Reference {
  item: Item;
  holder?: Item;
  node: ts.Node;
  typeOnly: boolean;
  /** An object reference escapes or the consumer operates on its representation. */
  exposes: boolean;
  through?: Item;
}

interface Wrapper {
  target: Item;
  writes?: boolean;
}

export interface ModuleEdge {
  from: ts.SourceFile;
  to: ts.SourceFile;
  node: ts.Node;
  typeOnly: boolean;
  name: string;
}

export interface Model {
  files: ts.SourceFile[];
  tests: Set<ts.SourceFile>;
  items: Item[];
  references: Reference[];
  rawReferences: Reference[];
  wrappers: Map<Item, Wrapper>;
  modules: ModuleEdge[];
  location(node: ts.Node): Location;
}

export function slash(value: string): string {
  return value.split(path.sep).join("/");
}

export function within(file: string, prefix: string): boolean {
  const relative = path.relative(prefix, file);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

export function isTest(file: string): boolean {
  return /(?:^|\/)(?:__tests__|tests?|__mocks__)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(
    slash(file),
  );
}

export function rootItem(item: Item): Item {
  let at = item;
  while (at.owner) at = at.owner;
  return at;
}

function children(node: ts.Node): ts.Node[] {
  const result: ts.Node[] = [];
  ts.forEachChild(node, (child) => {
    result.push(child);
  });
  return result;
}

function scopeLevel(node: ts.Node): boolean {
  return ts.isSourceFile(node) || ts.isModuleBlock(node);
}

function topLevel(node: ts.Node): boolean {
  const parent = node.parent;
  if (ts.isVariableDeclaration(node)) {
    return (
      ts.isVariableDeclarationList(parent) &&
      ts.isVariableStatement(parent.parent) &&
      scopeLevel(parent.parent.parent)
    );
  }
  return scopeLevel(parent);
}

function declaredName(node: ts.Node): ts.DeclarationName | undefined {
  if (
    ts.isVariableDeclaration(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isEnumMember(node) ||
    ts.isModuleDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isPropertySignature(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isParameter(node) ||
    ts.isTypeParameterDeclaration(node) ||
    ts.isBindingElement(node) ||
    ts.isPropertyAssignment(node) ||
    ts.isShorthandPropertyAssignment(node) ||
    ts.isImportClause(node) ||
    ts.isImportSpecifier(node) ||
    ts.isNamespaceImport(node) ||
    ts.isImportEqualsDeclaration(node) ||
    ts.isExportSpecifier(node)
  )
    return node.name;
  return undefined;
}

function unwrap(expression: ts.Expression): ts.Expression {
  let at = expression;
  while (
    ts.isParenthesizedExpression(at) ||
    ts.isAsExpression(at) ||
    ts.isNonNullExpression(at) ||
    ts.isTypeAssertionExpression(at) ||
    ts.isSatisfiesExpression(at)
  )
    at = at.expression;
  return at;
}

export function functionBody(node: ts.Node): ts.ConciseBody | undefined {
  if (ts.isExportAssignment(node)) {
    const value = unwrap(node.expression);
    if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) return value.body;
  }
  if ((ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) && node.initializer) {
    const value = unwrap(node.initializer);
    if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) return value.body;
  }
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  )
    return node.body;
  return undefined;
}

function singleExpression(body: ts.ConciseBody): ts.Expression | undefined {
  if (!ts.isBlock(body)) return unwrap(body);
  if (body.statements.length !== 1) return undefined;
  const statement = body.statements[0];
  if (statement && ts.isReturnStatement(statement) && statement.expression)
    return unwrap(statement.expression);
  if (statement && ts.isExpressionStatement(statement)) return unwrap(statement.expression);
  return undefined;
}

function isTypeReference(node: ts.Node): boolean {
  let at = node;
  while (at.parent) {
    if (ts.isExpressionWithTypeArguments(at.parent)) {
      const heritage = at.parent.parent;
      return ts.isHeritageClause(heritage) && heritage.token === ts.SyntaxKind.ImplementsKeyword;
    }
    if (ts.isTypeNode(at.parent)) return true;
    if (ts.isExpression(at.parent) || ts.isStatement(at.parent) || ts.isSourceFile(at.parent))
      return false;
    at = at.parent;
  }
  return false;
}

function useExpression(node: ts.Node): ts.Expression | undefined {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return parent;
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) return parent;
  return ts.isExpression(node) ? node : undefined;
}

/** Primitive values are copies; objects/functions retain representation identity in JS. */
function hasIdentity(checker: ts.TypeChecker, node: ts.Node): boolean {
  const type = checker.getTypeAtLocation(node);
  const identity = (part: ts.Type): boolean =>
    Boolean(
      part.flags &
      (ts.TypeFlags.Object |
        ts.TypeFlags.Any |
        ts.TypeFlags.Unknown |
        ts.TypeFlags.TypeParameter |
        ts.TypeFlags.NonPrimitive),
    );
  return type.isUnion() ? type.types.some(identity) : identity(type);
}

function exposes(checker: ts.TypeChecker, node: ts.Node, callResult = false): boolean {
  if (ts.isBindingElement(node)) return hasIdentity(checker, node.name);
  let expression = useExpression(node);
  if (!expression) return false;
  if (
    callResult &&
    ts.isCallExpression(expression.parent) &&
    expression.parent.expression === expression
  )
    expression = expression.parent;
  while (
    ts.isParenthesizedExpression(expression.parent) ||
    ts.isNonNullExpression(expression.parent) ||
    ts.isAsExpression(expression.parent)
  )
    expression = expression.parent;
  const parent = expression.parent;
  if (
    ts.isBinaryExpression(parent) &&
    parent.left === expression &&
    parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  )
    return true;
  if (
    (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
    (parent.operator === ts.SyntaxKind.PlusPlusToken ||
      parent.operator === ts.SyntaxKind.MinusMinusToken)
  )
    return true;
  if (ts.isDeleteExpression(parent)) return true;
  return hasIdentity(checker, expression);
}

function referenceName(node: ts.Node): boolean {
  if (ts.isStringLiteralLike(node))
    return ts.isElementAccessExpression(node.parent) && node.parent.argumentExpression === node;
  if (!ts.isIdentifier(node) && !ts.isPrivateIdentifier(node)) return false;
  const parent = node.parent;
  if (declaredName(parent) === node) return ts.isShorthandPropertyAssignment(parent);
  if (
    ts.isImportSpecifier(parent) ||
    ts.isExportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isImportEqualsDeclaration(parent)
  )
    return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (ts.isQualifiedName(parent) && parent.left === node) return false;
  if (
    ts.isLabeledStatement(parent) ||
    ts.isBreakStatement(parent) ||
    ts.isContinueStatement(parent)
  )
    return false;
  return true;
}

export function buildModel(
  program: ts.Program,
  files: ts.SourceFile[],
  options: AnalyzeOptions,
  reportingRoot: string,
): Model {
  const checker = program.getTypeChecker();
  const fileSet = new Set(files);
  const tests = new Set(
    files.filter((file) => isTest(path.relative(reportingRoot, file.fileName))),
  );
  const items: Item[] = [];
  const bySymbol = new Map<ts.Symbol, Item>();
  const byNode = new Map<ts.Node, Item>();
  const aliases = new Map<ts.Symbol, ts.Symbol>();
  const canonical = (symbol: ts.Symbol): ts.Symbol => {
    const cached = aliases.get(symbol);
    if (cached) return cached;
    let at = symbol;
    const seen = new Set<ts.Symbol>();
    while (at.flags & ts.SymbolFlags.Alias && !seen.has(at)) {
      seen.add(at);
      at = checker.getAliasedSymbol(at);
    }
    aliases.set(symbol, at);
    return at;
  };
  const symbolAt = (node: ts.Node): ts.Symbol | undefined => {
    const symbol = ts.isShorthandPropertyAssignment(node.parent)
      ? checker.getShorthandAssignmentValueSymbol(node.parent)
      : checker.getSymbolAtLocation(node);
    return symbol ? canonical(symbol) : undefined;
  };
  const itemAt = (node: ts.Node): Item | undefined => {
    const symbol = symbolAt(node);
    if (!symbol) return undefined;
    const direct = bySymbol.get(symbol);
    if (direct) return direct;
    // Instantiations can produce transient symbols with original declarations.
    for (const declaration of symbol.declarations ?? []) {
      const item = byNode.get(declaration);
      if (item) {
        bySymbol.set(symbol, item);
        return item;
      }
    }
    return undefined;
  };
  const location = (node: ts.Node): Location => {
    const file = node.getSourceFile();
    const position = file.getLineAndCharacterOfPosition(node.getStart(file));
    return {
      file: slash(path.relative(reportingRoot, file.fileName)),
      line: position.line + 1,
      column: position.character + 1,
    };
  };
  let nodes = 0;
  for (const file of files) {
    if (tests.has(file)) continue;
    const work: { node: ts.Node; owner?: Item }[] = [{ node: file }];
    while (work.length) {
      const current = work.pop();
      if (!current) break;
      const { node } = current;
      if (++nodes > 2_000_000) throw new Error("AST work limit exceeded (2,000,000 nodes)");
      let owner = current.owner;
      let kind: Item["kind"] | undefined;
      const named = declaredName(node);
      const anonymousDefault =
        !named &&
        (((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
          Boolean(
            node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword),
          )) ||
          (ts.isExportAssignment(node) && !node.isExportEquals));
      if ((named || anonymousDefault) && topLevel(node)) {
        if (
          ts.isClassDeclaration(node) ||
          ts.isInterfaceDeclaration(node) ||
          ts.isTypeAliasDeclaration(node) ||
          ts.isEnumDeclaration(node)
        )
          kind = "type";
        else if (ts.isFunctionDeclaration(node)) kind = "function";
        else if (ts.isVariableDeclaration(node))
          kind =
            node.initializer &&
            (ts.isArrowFunction(unwrap(node.initializer)) ||
              ts.isFunctionExpression(unwrap(node.initializer)))
              ? "function"
              : "constant";
        else if (ts.isExportAssignment(node))
          kind =
            ts.isArrowFunction(unwrap(node.expression)) ||
            ts.isFunctionExpression(unwrap(node.expression))
              ? "function"
              : "constant";
      } else if (
        owner &&
        named &&
        (ts.isClassDeclaration(node.parent) ||
          ts.isInterfaceDeclaration(node.parent) ||
          ts.isTypeLiteralNode(node.parent))
      ) {
        if (ts.isPropertyDeclaration(node))
          kind =
            node.initializer &&
            (ts.isArrowFunction(unwrap(node.initializer)) ||
              ts.isFunctionExpression(unwrap(node.initializer)))
              ? "function"
              : "field";
        else if (ts.isPropertySignature(node)) kind = "field";
        else if (
          ts.isMethodDeclaration(node) ||
          ts.isGetAccessorDeclaration(node) ||
          ts.isSetAccessorDeclaration(node)
        )
          kind = "function";
      } else if (
        owner &&
        ts.isParameter(node) &&
        ts.isConstructorDeclaration(node.parent) &&
        ts.isParameterPropertyDeclaration(node, node.parent)
      )
        kind = "field";
      if (
        kind &&
        (anonymousDefault ||
          (named &&
            (ts.isIdentifier(named) ||
              ts.isPrivateIdentifier(named) ||
              ts.isStringLiteralLike(named) ||
              ts.isNumericLiteral(named))))
      ) {
        const moduleSymbol = anonymousDefault ? checker.getSymbolAtLocation(file) : undefined;
        const exported = moduleSymbol
          ? checker.getExportsOfModule(moduleSymbol).find((symbol) => symbol.name === "default")
          : undefined;
        const symbol = named ? symbolAt(named) : exported ? canonical(exported) : undefined;
        const existing = symbol && bySymbol.get(symbol);
        if (existing) {
          if (kind === "function" && functionBody(node) && !functionBody(existing.node))
            existing.node = node;
          byNode.set(node, existing);
          owner = existing;
        } else {
          const namespace: string[] = [];
          for (let at = node.parent; at && !ts.isSourceFile(at); at = at.parent)
            if (ts.isModuleDeclaration(at)) namespace.unshift(at.name.getText(file));
          const name = `${namespace.length ? `${namespace.join(".")}.` : ""}${named ? named.getText(file) : "default"}`;
          const parent = topLevel(node) ? undefined : owner;
          const key = parent
            ? `${parent.key}#${name}`
            : `${slash(path.relative(reportingRoot, file.fileName))}#${name}`;
          const item: Item = { key, name, kind, node, file, ...(parent ? { owner: parent } : {}) };
          items.push(item);
          byNode.set(node, item);
          if (symbol) bySymbol.set(symbol, item);
          owner = item;
        }
      }
      const nested = children(node);
      for (let i = nested.length - 1; i >= 0; i--) {
        const child = nested[i];
        if (child) work.push({ node: child, ...(owner ? { owner } : {}) });
      }
    }
  }

  const wrappers = new Map<Item, Wrapper>();
  for (const item of items) {
    if (item.kind !== "function") continue;
    const body = functionBody(item.node);
    const expression = body && singleExpression(body);
    if (!expression) continue;
    let fn: ts.Node = item.node;
    if ((ts.isVariableDeclaration(fn) || ts.isPropertyDeclaration(fn)) && fn.initializer)
      fn = unwrap(fn.initializer);
    else if (ts.isExportAssignment(fn)) fn = unwrap(fn.expression);
    const parameters = ts.isFunctionLike(fn) ? fn.parameters : undefined;
    if (
      ts.isPropertyAccessExpression(expression) &&
      expression.expression.kind === ts.SyntaxKind.ThisKeyword
    ) {
      const field = itemAt(expression.name);
      if (
        field &&
        (field.kind === "field" || ts.isGetAccessorDeclaration(field.node)) &&
        rootItem(field) === rootItem(item)
      )
        wrappers.set(item, { target: field });
    } else if (ts.isCallExpression(expression)) {
      const call = expression;
      const target = itemAt(
        ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression,
      );
      if (!target || target === item) continue;
      // Only an unchanged parameter list and a pure receiver qualifies. This
      // avoids treating adapters, validation and transformed arguments as relays.
      if (!parameters || parameters.length !== call.arguments.length) continue;
      const unchanged = parameters.every((parameter, index) => {
        const argument = call.arguments[index];
        return (
          argument &&
          ts.isIdentifier(parameter.name) &&
          ts.isIdentifier(argument) &&
          checker.getSymbolAtLocation(parameter.name) === checker.getSymbolAtLocation(argument) &&
          !parameter.dotDotDotToken &&
          !parameter.initializer
        );
      });
      const receiver = ts.isPropertyAccessExpression(call.expression)
        ? call.expression.expression
        : undefined;
      const pureReceiver =
        !receiver ||
        receiver.kind === ts.SyntaxKind.ThisKeyword ||
        ts.isIdentifier(receiver) ||
        (ts.isPropertyAccessExpression(receiver) &&
          receiver.expression.kind === ts.SyntaxKind.ThisKeyword);
      if (unchanged && pureReceiver) wrappers.set(item, { target });
    } else if (
      ts.isBinaryExpression(expression) &&
      expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(expression.left) &&
      expression.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
      ts.isIdentifier(expression.right)
    ) {
      const field = itemAt(expression.left.name);
      const parameter = parameters?.length === 1 ? parameters[0] : undefined;
      if (
        field?.kind === "field" &&
        rootItem(field) === rootItem(item) &&
        parameter &&
        ts.isIdentifier(parameter.name) &&
        checker.getSymbolAtLocation(parameter.name) ===
          checker.getSymbolAtLocation(expression.right)
      )
        wrappers.set(item, {
          target: field,
          ...(ts.isSetAccessorDeclaration(item.node) ? {} : { writes: true }),
        });
    }
  }

  const rawReferences: Reference[] = [];
  const modules: ModuleEdge[] = [];
  const maxReferences = options.maxReferences ?? 1_000_000;
  const add = (item: Item, node: ts.Node, holder: Item | undefined, typeOnly: boolean): void => {
    if (rawReferences.length >= maxReferences)
      throw new Error(`Reference work limit exceeded (${maxReferences})`);
    rawReferences.push({
      item,
      node,
      typeOnly,
      exposes:
        item.kind === "field" || wrappers.has(item)
          ? exposes(checker, node, wrappers.has(item))
          : false,
      ...(holder ? { holder } : {}),
    });
  };
  const moduleTarget = (specifier: ts.Expression): ts.SourceFile | undefined => {
    const symbol = symbolAt(specifier);
    const declaration = symbol?.declarations?.find(ts.isSourceFile);
    return declaration && fileSet.has(declaration) && !tests.has(declaration)
      ? declaration
      : undefined;
  };
  for (const file of files) {
    if (tests.has(file)) continue;
    const work: { node: ts.Node; holder?: Item; importedTypeOnly: boolean }[] = [
      { node: file, importedTypeOnly: false },
    ];
    while (work.length) {
      const current = work.pop();
      if (!current) break;
      const { node } = current;
      const holder = byNode.get(node) ?? current.holder;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        const specifier = node.moduleSpecifier;
        if (specifier) {
          const target = moduleTarget(specifier);
          if (target) {
            const clause = ts.isImportDeclaration(node) ? node.importClause : undefined;
            const typeOnly = ts.isImportDeclaration(node)
              ? Boolean(clause?.isTypeOnly)
              : node.isTypeOnly ||
                (!program.getCompilerOptions().verbatimModuleSyntax &&
                  Boolean(
                    node.exportClause &&
                    ts.isNamedExports(node.exportClause) &&
                    node.exportClause.elements.every((element) => {
                      if (element.isTypeOnly) return true;
                      const symbol = checker.getSymbolAtLocation(element.name);
                      return symbol ? !(canonical(symbol).flags & ts.SymbolFlags.Value) : false;
                    }),
                  ));
            const sideEffect = ts.isImportDeclaration(node) && !node.importClause;
            if (
              ts.isExportDeclaration(node) ||
              sideEffect ||
              (program.getCompilerOptions().verbatimModuleSyntax && !typeOnly)
            )
              modules.push({
                from: file,
                to: target,
                node: specifier,
                typeOnly,
                name: specifier.getText(file),
              });
          }
        }
        continue;
      }
      let importedTypeOnly = current.importedTypeOnly;
      if (referenceName(node)) {
        const original = checker.getSymbolAtLocation(node);
        importedTypeOnly =
          importedTypeOnly ||
          Boolean(
            original?.declarations?.some(
              (declaration) =>
                (ts.isImportSpecifier(declaration) &&
                  (declaration.isTypeOnly ||
                    (ts.isImportClause(declaration.parent.parent) &&
                      declaration.parent.parent.isTypeOnly))) ||
                (ts.isImportClause(declaration) && declaration.isTypeOnly) ||
                (ts.isNamespaceImport(declaration) &&
                  ts.isImportClause(declaration.parent) &&
                  declaration.parent.isTypeOnly),
            ),
          );
        const item = itemAt(node);
        const inlinedEnum =
          item &&
          ts.isEnumDeclaration(item.node) &&
          item.node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ConstKeyword) &&
          !program.getCompilerOptions().isolatedModules &&
          (ts.isPropertyAccessExpression(node.parent) ||
            ts.isElementAccessExpression(node.parent)) &&
          checker.getConstantValue(node.parent) !== undefined;
        const typeOnly = importedTypeOnly || isTypeReference(node) || Boolean(inlinedEnum);
        // Preserve the consumed import's actual relay as well as the original
        // declaration. Otherwise a barrel re-exporting its own consumer would
        // hide a real runtime cycle when aliases resolve past that barrel.
        for (const declaration of original?.declarations ?? []) {
          let at: ts.Node = declaration;
          while (
            !ts.isSourceFile(at) &&
            !ts.isImportDeclaration(at) &&
            !ts.isImportEqualsDeclaration(at)
          )
            at = at.parent;
          const specifier = ts.isImportDeclaration(at)
            ? at.moduleSpecifier
            : ts.isImportEqualsDeclaration(at) && ts.isExternalModuleReference(at.moduleReference)
              ? at.moduleReference.expression
              : undefined;
          if (!specifier) continue;
          const target = moduleTarget(specifier);
          if (target && target !== file)
            modules.push({ from: file, to: target, node, typeOnly, name: specifier.getText(file) });
        }
        if (item) add(item, node, holder, typeOnly);
      }
      // Object destructuring has its own local binding symbols; resolve the
      // source property's symbol through its actual inferred type.
      if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        const key = node.propertyName ?? node.name;
        if (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) {
          const symbol = checker.getPropertyOfType(
            checker.getTypeAtLocation(node.parent),
            key.text,
          );
          const item = symbol && bySymbol.get(canonical(symbol));
          if (item) add(item, node, holder, false);
        }
      }
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        const target = moduleTarget(node.arguments[0]);
        if (target)
          modules.push({
            from: file,
            to: target,
            node: node.arguments[0],
            typeOnly: false,
            name: "dynamic import",
          });
      }
      const nested = children(node);
      for (let i = nested.length - 1; i >= 0; i--) {
        const child = nested[i];
        if (child) work.push({ node: child, importedTypeOnly, ...(holder ? { holder } : {}) });
      }
    }
  }
  for (const reference of rawReferences) {
    if (reference.item.file !== reference.node.getSourceFile())
      modules.push({
        from: reference.node.getSourceFile(),
        to: reference.item.file,
        node: reference.node,
        typeOnly: reference.typeOnly,
        name: reference.item.name,
      });
  }
  const references: Reference[] = [];
  for (const reference of rawReferences) {
    if (reference.holder && wrappers.has(reference.holder)) continue;
    let item = reference.item;
    let exposesRepresentation = reference.exposes;
    const visited = new Set<Item>();
    while (wrappers.has(item) && !visited.has(item)) {
      visited.add(item);
      const wrapper = wrappers.get(item);
      if (!wrapper) break;
      exposesRepresentation ||= Boolean(wrapper.writes);
      item = wrapper.target;
    }
    references.push({
      ...reference,
      item,
      ...(item === reference.item ? {} : { through: reference.item }),
      exposes: item.kind === "field" && exposesRepresentation,
    });
  }
  return { files, tests, items, rawReferences, references, wrappers, modules, location };
}
