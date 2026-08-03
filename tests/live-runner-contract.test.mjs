import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, resolve, sep, win32 } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { CdpClient } from "../scripts/lib/cdp-client.mjs";
import {
  RunnerPolicyError,
  assertCanonicalRuntimeUrl,
  canonicalizeTemporaryDirectoryForTest,
  createOwnedRunDirectory,
  createOwnedScratchDirectory,
  createOwnedTemporaryConfigDirectory,
  guardClientEvaluations,
  isDirectCliInvocation,
  parseRunnerArgs,
  rejectSymlinkComponentsForTest,
  removeOwnedRunDirectory,
  restoreConfigRootWithReadback,
  selectCanonicalCdpTarget,
  validateRunnerOutputRoot,
} from "../scripts/lib/live-runner-policy.mjs";
import { assertFunctionalSmokeTemporaryDirectoryRemovalAllowed } from
  "../scripts/cep-functional-smoke.mjs";

const expectReject = async (promise, pattern) => {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof RunnerPolicyError || error instanceof Error);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
};

const collectBindingIdentifiers = (root) => {
  const bindings = [];
  const addBindingName = (name, declaration, kind) => {
    if (!name) return;
    if (ts.isIdentifier(name)) {
      bindings.push({ name: name.text, node: name, declaration, kind });
      return;
    }
    if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const element of name.elements) {
        if (ts.isBindingElement(element)) addBindingName(element.name, declaration, kind);
      }
    }
  };
  const visit = (node) => {
    if (ts.isImportSpecifier(node)) {
      addBindingName(node.name, node, "import-specifier");
    } else if (ts.isNamespaceImport(node)) {
      addBindingName(node.name, node, "namespace-import");
    } else if (ts.isImportClause(node) && node.name) {
      addBindingName(node.name, node, "default-import");
    } else if (ts.isImportEqualsDeclaration(node)) {
      addBindingName(node.name, node, "import-equals");
    } else if (ts.isVariableDeclaration(node)) {
      addBindingName(
        node.name,
        node,
        ts.isCatchClause(node.parent) ? "catch-binding" : "variable-declaration",
      );
    } else if (ts.isParameter(node)) {
      addBindingName(node.name, node, "parameter");
    } else if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) {
      addBindingName(
        node.name,
        node,
        ts.isFunctionDeclaration(node) ? "function-declaration" : "named-function-expression",
      );
    } else if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      addBindingName(
        node.name,
        node,
        ts.isClassDeclaration(node) ? "class-declaration" : "named-class-expression",
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return bindings;
};

const collectSourceFileScopeBindings = (sourceFile) => {
  const bindings = [];
  const addBindingName = (name, declaration, kind) => {
    if (ts.isIdentifier(name)) {
      bindings.push({ name: name.text, node: name, declaration, kind });
      return;
    }
    if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const element of name.elements) {
        if (ts.isBindingElement(element)) addBindingName(element.name, declaration, kind);
      }
    }
  };
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.name) addBindingName(clause.name, clause, "default-import");
      const namedBindings = clause?.namedBindings;
      if (namedBindings && ts.isNamespaceImport(namedBindings)) {
        addBindingName(namedBindings.name, namedBindings, "namespace-import");
      } else if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const specifier of namedBindings.elements) {
          addBindingName(specifier.name, specifier, "import-specifier");
        }
      }
    } else if (ts.isImportEqualsDeclaration(statement)) {
      addBindingName(statement.name, statement, "import-equals");
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        addBindingName(declaration.name, declaration, "variable-declaration");
      }
    } else if (ts.isFunctionDeclaration(statement)) {
      addBindingName(statement.name, statement, "function-declaration");
    } else if (ts.isClassDeclaration(statement)) {
      addBindingName(statement.name, statement, "class-declaration");
    }
  }
  return bindings;
};

const callArgumentUse = (identifier, calleeName, argumentIndex) => {
  const call = identifier.parent;
  return (
    ts.isCallExpression(call) &&
    call.arguments[argumentIndex] === identifier &&
    ts.isIdentifier(call.expression) &&
    call.expression.text === calleeName
  );
};

const propertyInitializerUse = (identifier, propertyName) =>
  ts.isPropertyAssignment(identifier.parent) &&
  identifier.parent.initializer === identifier &&
  ((ts.isIdentifier(identifier.parent.name) && identifier.parent.name.text === propertyName) ||
    (ts.isStringLiteral(identifier.parent.name) && identifier.parent.name.text === propertyName));

const EXPECTED_FUNCTIONAL_SMOKE_SOURCE_SHA256 =
  "3db743d187b959fb75310dcac0573b9f7790bab9b17fa0c005dfb39ddaae346b";

const analyzeFunctionalSmokeClosedWorld = (inputSource, { requireExactSource = true } = {}) => {
  const source = inputSource.replaceAll("\r\n", "\n");
  const sourceFile = ts.createSourceFile(
    "cep-functional-smoke.mjs",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const errors = [];
  const actualSourceSha256 = createHash("sha256").update(source).digest("hex");
  if (requireExactSource && actualSourceSha256 !== EXPECTED_FUNCTIONAL_SMOKE_SOURCE_SHA256) {
    errors.push(
      `functional-source-fingerprint:expected-${EXPECTED_FUNCTIONAL_SMOKE_SOURCE_SHA256}:actual-${actualSourceSha256}`,
    );
  }
  const counts = new Map();
  const allow = (label) => counts.set(label, (counts.get(label) ?? 0) + 1);
  const reject = (identifier, policy) => {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(identifier.getStart(sourceFile));
    errors.push(`${policy}:${line + 1}:${character + 1}`);
  };
  const rejectNode = (node, policy) => reject(node, policy);
  const identifierNamed = (node, name) => ts.isIdentifier(node) && node.text === name;
  const isConstDeclaration = (declaration) =>
    ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0;
  const propertyAccessNamed = (node, expressionName, propertyName) =>
    ts.isPropertyAccessExpression(node) &&
    identifierNamed(node.expression, expressionName) &&
    identifierNamed(node.name, propertyName);
  const propertyNameText = (property) => {
    if (ts.isShorthandPropertyAssignment(property)) return property.name.text;
    if (
      (ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property)) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
    ) {
      return property.name.text;
    }
    return null;
  };

  if (sourceFile.parseDiagnostics.length > 0) {
    for (const diagnostic of sourceFile.parseDiagnostics) {
      errors.push(`parse-diagnostic:${diagnostic.start ?? "unknown"}:${diagnostic.code}`);
    }
    return errors;
  }

  const sourceFileBindings = collectSourceFileScopeBindings(sourceFile);
  const topLevelVariableDeclarationsNamed = (name) => {
    const declarations = [];
    for (const statement of sourceFile.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (identifierNamed(declaration.name, name)) declarations.push(declaration);
      }
    }
    return declarations;
  };
  const authenticateNamedImport = (name, moduleName) => {
    const matchingSpecifiers = [];
    for (const statement of sourceFile.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        statement.moduleSpecifier.text !== moduleName
      ) continue;
      const namedBindings = statement.importClause?.namedBindings;
      if (!namedBindings || !ts.isNamedImports(namedBindings)) continue;
      for (const specifier of namedBindings.elements) {
        const importedName = specifier.propertyName?.text ?? specifier.name.text;
        if (importedName === name && specifier.name.text === name) matchingSpecifiers.push(specifier);
      }
    }
    const sourceBindings = sourceFileBindings.filter((binding) => binding.name === name);
    if (
      matchingSpecifiers.length !== 1 ||
      sourceBindings.length !== 1 ||
      sourceBindings[0].node !== matchingSpecifiers[0].name
    ) {
      errors.push(
        `${name}-import-authority:expected-${moduleName}-named-import:imports-${matchingSpecifiers.length}:bindings-${sourceBindings.length}`,
      );
    }
  };
  const authenticateTopLevelArrowBinding = (name) => {
    const declarations = topLevelVariableDeclarationsNamed(name);
    const sourceBindings = sourceFileBindings.filter((binding) => binding.name === name);
    const declaration = declarations.length === 1 ? declarations[0] : null;
    if (
      !declaration ||
      sourceBindings.length !== 1 ||
      sourceBindings[0].node !== declaration.name ||
      !isConstDeclaration(declaration) ||
      !ts.isArrowFunction(declaration.initializer)
    ) {
      errors.push(
        `${name}-top-level-binding-authority:declarations-${declarations.length}:bindings-${sourceBindings.length}`,
      );
      return null;
    }
    return declaration.initializer;
  };

  authenticateNamedImport("readFile", "node:fs/promises");
  authenticateNamedImport("writeFile", "node:fs/promises");
  authenticateNamedImport("resolve", "node:path");
  authenticateNamedImport("Buffer", "node:buffer");
  const topLevelArrowBindings = new Map();
  for (const name of [
    "run",
    "runCorruptImageSelectionCase",
    "createFunctionalSmokeDiagnosticState",
    "captureImageSelectionOwnedTopology",
    "isFunctionalSmokeRuntimeCompletionKnown",
    "importProjectImageSource",
    "cleanupImageSelectionFixturesSource",
    "selectProjectImagesSource",
  ]) {
    topLevelArrowBindings.set(name, authenticateTopLevelArrowBinding(name));
  }
  const run = topLevelArrowBindings.get("run");
  const corruptHelper = topLevelArrowBindings.get("runCorruptImageSelectionCase");
  const diagnosticStateFactory = topLevelArrowBindings.get(
    "createFunctionalSmokeDiagnosticState",
  );
  if (!run || !corruptHelper) return errors;

  const unwrapParenthesized = (node) => {
    let current = node;
    while (current && ts.isParenthesizedExpression(current)) current = current.expression;
    return current;
  };
  const diagnosticStateFactoryBody = diagnosticStateFactory
    ? unwrapParenthesized(diagnosticStateFactory.body)
    : null;
  if (
    diagnosticStateFactory &&
    (
      diagnosticStateFactory.parameters.length !== 0 ||
      (ts.getModifiers(diagnosticStateFactory) ?? []).length !== 0 ||
      !diagnosticStateFactoryBody ||
      !ts.isObjectLiteralExpression(diagnosticStateFactoryBody) ||
      diagnosticStateFactoryBody.properties.length !== 2 ||
      !ts.isPropertyAssignment(diagnosticStateFactoryBody.properties[0]) ||
      propertyNameText(diagnosticStateFactoryBody.properties[0]) !== "cleanupErrors" ||
      !ts.isArrayLiteralExpression(diagnosticStateFactoryBody.properties[0].initializer) ||
      diagnosticStateFactoryBody.properties[0].initializer.elements.length !== 0 ||
      !ts.isPropertyAssignment(diagnosticStateFactoryBody.properties[1]) ||
      propertyNameText(diagnosticStateFactoryBody.properties[1]) !== "evidenceWriteErrors" ||
      !ts.isArrayLiteralExpression(diagnosticStateFactoryBody.properties[1].initializer) ||
      diagnosticStateFactoryBody.properties[1].initializer.elements.length !== 0
    )
  ) {
    rejectNode(diagnosticStateFactory, "createFunctionalSmokeDiagnosticState-shape");
  }

  const sourceBufferBinding = sourceFileBindings.find((binding) => binding.name === "Buffer");

  const runBindings = collectBindingIdentifiers(run);
  for (const name of [
    "runCorruptImageSelectionCase",
    "readFile",
    "writeFile",
    "resolve",
    "captureImageSelectionOwnedTopology",
    "isFunctionalSmokeRuntimeCompletionKnown",
    "importProjectImageSource",
    "cleanupImageSelectionFixturesSource",
    "selectProjectImagesSource",
    "createFunctionalSmokeDiagnosticState",
    "Buffer",
  ]) {
    for (const binding of runBindings.filter((candidate) => candidate.name === name)) {
      rejectNode(binding.node, `${name}-shadow-binding`);
    }
  }

  const corruptHelperBindings = collectBindingIdentifiers(corruptHelper);
  for (const binding of corruptHelperBindings.filter(
    (candidate) => candidate.name === "Buffer",
  )) {
    rejectNode(binding.node, "Buffer-helper-shadow-binding");
  }
  for (const binding of corruptHelperBindings.filter(
    (candidate) => candidate.name === "createFunctionalSmokeDiagnosticState",
  )) {
    rejectNode(binding.node, "createFunctionalSmokeDiagnosticState-helper-shadow-binding");
  }
  const corruptHelperParameter = corruptHelper.parameters.length === 1
    ? corruptHelper.parameters[0]
    : null;
  const corruptHelperParameterElements =
    corruptHelperParameter && ts.isObjectBindingPattern(corruptHelperParameter.name)
      ? corruptHelperParameter.name.elements
      : [];
  const expectedCorruptHelperParameterNames = [
    "corruptPath",
    "validBytes",
    "corruptBytes",
    "runProductCase",
    "validateProductResult",
    "hasRestoreAuthority",
    "diagnosticState",
    "onRestoreVerified",
    "writeSource",
    "readSource",
  ];
  const hasAsyncModifier = (node) =>
    (ts.getModifiers(node) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
    );
  const isExactZeroArgumentCall = (node, calleeName) =>
    ts.isCallExpression(node) &&
    identifierNamed(node.expression, calleeName) &&
    node.arguments.length === 0;
  const isExactCorruptBytesDefault = (node) =>
    ts.isCallExpression(node) &&
    propertyAccessNamed(node.expression, "Buffer", "from") &&
    node.arguments.length === 1 &&
    ts.isStringLiteral(node.arguments[0]) &&
    node.arguments[0].text === "not a valid PNG";
  const isExactRestoreCallbackDefault = (node) =>
    ts.isArrowFunction(node) &&
    hasAsyncModifier(node) &&
    node.parameters.length === 0 &&
    identifierNamed(node.body, "undefined");
  const corruptHelperParameterShapeValid =
    corruptHelper.parameters.length === 1 &&
    corruptHelperParameter !== null &&
    corruptHelperParameter.dotDotDotToken === undefined &&
    corruptHelperParameter.initializer === undefined &&
    ts.isObjectBindingPattern(corruptHelperParameter.name) &&
    corruptHelperParameterElements.length === expectedCorruptHelperParameterNames.length &&
    corruptHelperParameterElements.every((element, index) => {
      const name = expectedCorruptHelperParameterNames[index];
      if (
        element.dotDotDotToken !== undefined ||
        element.propertyName !== undefined ||
        !identifierNamed(element.name, name)
      ) return false;
      switch (name) {
        case "corruptBytes":
          return isExactCorruptBytesDefault(element.initializer);
        case "diagnosticState":
          return isExactZeroArgumentCall(
            element.initializer,
            "createFunctionalSmokeDiagnosticState",
          );
        case "onRestoreVerified":
          return isExactRestoreCallbackDefault(element.initializer);
        case "writeSource":
          return identifierNamed(element.initializer, "writeFile");
        case "readSource":
          return identifierNamed(element.initializer, "readFile");
        default:
          return element.initializer === undefined;
      }
    });
  if (!corruptHelperParameterShapeValid) {
    rejectNode(corruptHelperParameter ?? corruptHelper, "corrupt-helper-parameter-shape");
  }
  for (const name of [
    "corruptPath",
    "validBytes",
    "corruptBytes",
    "runProductCase",
    "validateProductResult",
    "hasRestoreAuthority",
    "diagnosticState",
    "onRestoreVerified",
    "writeSource",
    "readSource",
  ]) {
    const intendedElements = corruptHelperParameterElements.filter(
      (element) => ts.isIdentifier(element.name) && element.name.text === name,
    );
    const bindings = corruptHelperBindings.filter((binding) => binding.name === name);
    if (
      intendedElements.length !== 1 ||
      bindings.length !== 1 ||
      bindings[0].node !== intendedElements[0].name
    ) {
      errors.push(
        `${name}-helper-binding-shadow:expected-parameter-binding:actual-${bindings.length}`,
      );
    }
  }
  const walkIdentifiers = (root, name, policy, classify) => {
    const visit = (node) => {
      if (ts.isIdentifier(node) && node.text === name) {
        const label = classify(node);
        if (label) allow(label);
        else reject(node, policy);
      }
      ts.forEachChild(node, visit);
    };
    visit(root);
  };
  const rejectDynamicExecution = (root, policy) => {
    const dynamicNames = new Set([
      "eval",
      "Function",
      "AsyncFunction",
      "GeneratorFunction",
      "AsyncGeneratorFunction",
    ]);
    const visit = (node) => {
      if (ts.isIdentifier(node) && dynamicNames.has(node.text)) reject(node, policy);
      if (
        (
          (ts.isPropertyAccessExpression(node) && ["eval", "constructor"].includes(node.name.text)) ||
          (ts.isElementAccessExpression(node) &&
            !ts.isNumericLiteral(node.argumentExpression))
        )
      ) rejectNode(node, policy);
      ts.forEachChild(node, visit);
    };
    visit(root);
  };
  walkIdentifiers(sourceFile, "Buffer", "Buffer-use-authority", (identifier) => {
    if (sourceBufferBinding?.node === identifier) return "Buffer-import-use";
    if (
      (ts.isPropertyAccessExpression(identifier.parent) && identifier.parent.name === identifier) ||
      ((ts.isPropertyAssignment(identifier.parent) || ts.isMethodDeclaration(identifier.parent)) &&
        identifier.parent.name === identifier) ||
      (ts.isLabeledStatement(identifier.parent) && identifier.parent.label === identifier)
    ) return "Buffer-non-value-name";
    const propertyAccess = identifier.parent;
    if (
      ts.isPropertyAccessExpression(propertyAccess) &&
      propertyAccess.expression === identifier &&
      identifierNamed(propertyAccess.name, "from") &&
      ts.isCallExpression(propertyAccess.parent) &&
      propertyAccess.parent.expression === propertyAccess &&
      !propertyAccess.parent.questionDotToken
    ) return "Buffer-from-direct-call";
    return null;
  });
  rejectDynamicExecution(run, "production-dynamic-execution");
  rejectDynamicExecution(corruptHelper, "helper-dynamic-execution");
  const helperBindingUse = (identifier, name) =>
    ts.isBindingElement(identifier.parent) &&
    identifier.parent.name === identifier &&
    identifierNamed(identifier, name) &&
    ts.isObjectBindingPattern(identifier.parent.parent) &&
    identifier.parent.parent === corruptHelperParameter?.name;
  const helperCalleeUse = (identifier, argumentCount) =>
    ts.isCallExpression(identifier.parent) &&
    identifier.parent.expression === identifier &&
    identifier.parent.arguments.length === argumentCount;
  const helperBufferFromArgumentUse = (identifier) => {
    const call = identifier.parent;
    return (
      ts.isCallExpression(call) &&
      call.arguments.length === 1 &&
      call.arguments[0] === identifier &&
      propertyAccessNamed(call.expression, "Buffer", "from")
    );
  };
  walkIdentifiers(corruptHelper, "validBytes", "helper-validBytes-use", (identifier) => {
    if (helperBindingUse(identifier, "validBytes")) return "helper-validBytes-binding";
    if (helperBufferFromArgumentUse(identifier)) return "helper-validBytes-copy";
    return null;
  });
  walkIdentifiers(corruptHelper, "corruptBytes", "helper-corruptBytes-use", (identifier) => {
    if (helperBindingUse(identifier, "corruptBytes")) return "helper-corruptBytes-binding";
    if (
      callArgumentUse(identifier, "writeSource", 1) &&
      identifier.parent.arguments.length === 2 &&
      identifierNamed(identifier.parent.arguments[0], "corruptPath")
    ) return "helper-corruptBytes-write";
    return null;
  });
  walkIdentifiers(corruptHelper, "runProductCase", "helper-runProductCase-use", (identifier) => {
    if (helperBindingUse(identifier, "runProductCase")) return "helper-runProductCase-binding";
    if (helperCalleeUse(identifier, 0)) return "helper-runProductCase-call";
    return null;
  });
  walkIdentifiers(
    corruptHelper,
    "validateProductResult",
    "helper-validateProductResult-use",
    (identifier) => {
      if (helperBindingUse(identifier, "validateProductResult")) {
        return "helper-validateProductResult-binding";
      }
      if (
        helperCalleeUse(identifier, 1) &&
        identifierNamed(identifier.parent.arguments[0], "result")
      ) return "helper-validateProductResult-call";
      return null;
    },
  );
  walkIdentifiers(
    corruptHelper,
    "hasRestoreAuthority",
    "helper-hasRestoreAuthority-use",
    (identifier) => {
      if (helperBindingUse(identifier, "hasRestoreAuthority")) {
        return "helper-hasRestoreAuthority-binding";
      }
      if (helperCalleeUse(identifier, 0)) return "helper-hasRestoreAuthority-call";
      return null;
    },
  );
  walkIdentifiers(corruptHelper, "diagnosticState", "helper-diagnosticState-use", (identifier) => {
    if (helperBindingUse(identifier, "diagnosticState")) return "helper-diagnosticState-binding";
    if (callArgumentUse(identifier, "importFunctionalSmokeErrorDiagnostics", 1)) {
      return "helper-diagnosticState-import";
    }
    if (callArgumentUse(identifier, "attachFunctionalSmokeDiagnosticCompatibility", 1)) {
      return "helper-diagnosticState-attach";
    }
    const property = identifier.parent;
    const appendCall = property.parent;
    if (
      propertyAccessNamed(property, "diagnosticState", "cleanupErrors") &&
      ts.isCallExpression(appendCall) &&
      appendCall.arguments[0] === property &&
      identifierNamed(appendCall.expression, "appendFunctionalSmokeDiagnostic")
    ) return "helper-diagnosticState-cleanup-append";
    return null;
  });
  walkIdentifiers(
    corruptHelper,
    "onRestoreVerified",
    "helper-onRestoreVerified-use",
    (identifier) => {
      if (helperBindingUse(identifier, "onRestoreVerified")) return "helper-onRestoreVerified-binding";
      if (
        helperCalleeUse(identifier, 1) &&
        identifierNamed(identifier.parent.arguments[0], "restoration")
      ) return "helper-onRestoreVerified-call";
      return null;
    },
  );
  walkIdentifiers(corruptHelper, "writeSource", "helper-writeSource-use", (identifier) => {
    if (helperBindingUse(identifier, "writeSource")) return "helper-writeSource-binding";
    if (helperCalleeUse(identifier, 2)) return "helper-writeSource-call";
    return null;
  });
  walkIdentifiers(corruptHelper, "readSource", "helper-readSource-use", (identifier) => {
    if (helperBindingUse(identifier, "readSource")) return "helper-readSource-binding";
    if (helperCalleeUse(identifier, 1)) return "helper-readSource-call";
    return null;
  });
  const variableDeclarationNamed = (root, name) => {
    const declarations = [];
    const visit = (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        identifierNamed(node.name, name)
      ) declarations.push(node);
      ts.forEachChild(node, visit);
    };
    visit(root);
    if (declarations.length !== 1) {
      errors.push(`${name}-declaration:expected-1:actual-${declarations.length}`);
      return null;
    }
    return declarations[0];
  };
  const containingStatement = (node) => {
    let current = node;
    while (current && !ts.isStatement(current)) current = current.parent;
    return current;
  };
  const expectedBytesDeclaration = variableDeclarationNamed(corruptHelper, "expectedBytes");
  if (
    !expectedBytesDeclaration ||
    !isConstDeclaration(expectedBytesDeclaration) ||
    !ts.isCallExpression(expectedBytesDeclaration.initializer) ||
    !propertyAccessNamed(expectedBytesDeclaration.initializer.expression, "Buffer", "from") ||
    expectedBytesDeclaration.initializer.arguments.length !== 1 ||
    !identifierNamed(expectedBytesDeclaration.initializer.arguments[0], "validBytes")
  ) {
    rejectNode(expectedBytesDeclaration ?? corruptHelper, "expectedBytes-provenance");
  }
  walkIdentifiers(corruptHelper, "expectedBytes", "expectedBytes-use", (identifier) => {
    if (expectedBytesDeclaration?.name === identifier) return "expectedBytes-declaration-use";
    if (
      callArgumentUse(identifier, "writeSource", 1) &&
      identifier.parent.arguments.length === 2 &&
      identifierNamed(identifier.parent.arguments[0], "corruptPath")
    ) return "expectedBytes-restore-write";
    if (callArgumentUse(identifier, "imageSourceSha256", 0)) return "expectedBytes-sha-use";
    if (
      ts.isCallExpression(identifier.parent) &&
      identifier.parent.arguments[0] === identifier &&
      propertyAccessNamed(identifier.parent.expression, "restoredBytes", "equals")
    ) return "expectedBytes-equality-use";
    return null;
  });
  walkIdentifiers(run, "corruptPath", "production-corruptPath", (identifier) => {
    if (
      ts.isVariableDeclaration(identifier.parent) &&
      identifier.parent.name === identifier &&
      ts.isCallExpression(identifier.parent.initializer) &&
      ts.isIdentifier(identifier.parent.initializer.expression) &&
      identifier.parent.initializer.expression.text === "resolve"
    ) return "corrupt-declaration";
    if (
      callArgumentUse(identifier, "writeFile", 0) &&
      ts.isIdentifier(identifier.parent.arguments[1]) &&
      identifier.parent.arguments[1].text === "pngBytes"
    ) return "corrupt-valid-copy";
    if (
      callArgumentUse(identifier, "importProjectImageSource", 0) &&
      ts.isStringLiteral(identifier.parent.arguments[1]) &&
      identifier.parent.arguments[1].text === "CP_IMAGE_CORRUPT_PNG"
    ) return "corrupt-valid-import";
    if (ts.isShorthandPropertyAssignment(identifier.parent)) {
      const object = identifier.parent.parent;
      const call = object.parent;
      if (
        ts.isObjectLiteralExpression(object) &&
        ts.isCallExpression(call) &&
        call.arguments[0] === object &&
        ts.isIdentifier(call.expression) &&
        call.expression.text === "runCorruptImageSelectionCase"
      ) return "corrupt-lifecycle-wire";
    }
    return null;
  });

  walkIdentifiers(
    corruptHelper,
    "corruptPath",
    "helper-corruptPath",
    (identifier) => {
      if (
        ts.isBindingElement(identifier.parent) &&
        identifier.parent.name === identifier &&
        ts.isObjectBindingPattern(identifier.parent.parent)
      ) return "helper-corrupt-parameter";
      if (callArgumentUse(identifier, "writeSource", 0)) return "helper-corrupt-write";
      if (callArgumentUse(identifier, "readSource", 0)) return "helper-corrupt-read";
      if (propertyInitializerUse(identifier, "path")) return "helper-corrupt-path-record";
      return null;
    },
  );

  walkIdentifiers(
    run,
    "imageSelectionOwnedTopology",
    "production-imageSelectionOwnedTopology",
    (identifier) => {
      if (
        ts.isVariableDeclaration(identifier.parent) &&
        identifier.parent.name === identifier &&
        ts.isArrayLiteralExpression(identifier.parent.initializer) &&
        identifier.parent.initializer.elements.length === 0
      ) return "topology-declaration";
      if (
        callArgumentUse(identifier, "captureImageSelectionOwnedTopology", 0) &&
        identifier.parent.arguments.length === 3 &&
        ts.isIdentifier(identifier.parent.arguments[1]) &&
        identifier.parent.arguments[1].text === "items" &&
        ts.isIdentifier(identifier.parent.arguments[2]) &&
        identifier.parent.arguments[2].text === "setupResult"
      ) return "topology-validated-capture";
      if (
        callArgumentUse(identifier, "cleanupImageSelectionFixturesSource", 2) &&
        identifier.parent.arguments.length === 3 &&
        ts.isIdentifier(identifier.parent.arguments[0]) &&
        identifier.parent.arguments[0].text === "runId" &&
        ts.isIdentifier(identifier.parent.arguments[1]) &&
        identifier.parent.arguments[1].text === "imageSelectionOwnedItems"
      ) return "topology-readonly-cleanup";
      return null;
    },
  );

  const captureNewOwnedTopologyDeclaration = variableDeclarationNamed(
    run,
    "captureNewOwnedTopology",
  );
  const captureNewOwnedTopology =
    captureNewOwnedTopologyDeclaration &&
    ts.isArrowFunction(captureNewOwnedTopologyDeclaration.initializer)
      ? captureNewOwnedTopologyDeclaration.initializer
      : null;
  const captureCall = captureNewOwnedTopology?.body;
  if (
    !captureNewOwnedTopology ||
    captureNewOwnedTopology.parameters.length !== 2 ||
    !identifierNamed(captureNewOwnedTopology.parameters[0].name, "items") ||
    !identifierNamed(captureNewOwnedTopology.parameters[1].name, "setupResult") ||
    !ts.isCallExpression(captureCall) ||
    !identifierNamed(captureCall.expression, "captureImageSelectionOwnedTopology") ||
    captureCall.arguments.length !== 3 ||
    !identifierNamed(captureCall.arguments[0], "imageSelectionOwnedTopology") ||
    !identifierNamed(captureCall.arguments[1], "items") ||
    !identifierNamed(captureCall.arguments[2], "setupResult")
  ) {
    rejectNode(
      captureNewOwnedTopology ?? captureNewOwnedTopologyDeclaration ?? run,
      "captureNewOwnedTopology-shape",
    );
  }
  walkIdentifiers(run, "captureNewOwnedTopology", "captureNewOwnedTopology-use", (identifier) => {
    if (
      ts.isVariableDeclaration(identifier.parent) &&
      identifier.parent.name === identifier &&
      identifier.parent.initializer === captureNewOwnedTopology &&
      isConstDeclaration(identifier.parent)
    ) return "captureNewOwnedTopology-declaration";
    if (
      ts.isCallExpression(identifier.parent) &&
      identifier.parent.expression === identifier &&
      ts.isExpressionStatement(identifier.parent.parent)
    ) return "captureNewOwnedTopology-terminal-call";
    return null;
  });

  const pngBytesDeclaration = variableDeclarationNamed(run, "pngBytes");
  if (
    pngBytesDeclaration &&
    (
      !isConstDeclaration(pngBytesDeclaration) ||
      !pngBytesDeclaration.initializer ||
      !ts.isAwaitExpression(pngBytesDeclaration.initializer) ||
      !ts.isCallExpression(pngBytesDeclaration.initializer.expression) ||
      !identifierNamed(pngBytesDeclaration.initializer.expression.expression, "readFile") ||
      pngBytesDeclaration.initializer.expression.arguments.length !== 1 ||
      !propertyAccessNamed(
        pngBytesDeclaration.initializer.expression.arguments[0],
        "pngFixture",
        "path",
      )
    )
  ) {
    rejectNode(pngBytesDeclaration ?? run, "pngBytes-provenance");
  }
  walkIdentifiers(run, "pngBytes", "pngBytes-use", (identifier) => {
    if (pngBytesDeclaration?.name === identifier) return "pngBytes-provenance-use";
    if (
      callArgumentUse(identifier, "writeFile", 1) &&
      identifier.parent.arguments.length === 2 &&
      identifierNamed(identifier.parent.arguments[0], "corruptPath")
    ) return "pngBytes-valid-copy-use";
    if (propertyInitializerUse(identifier, "validBytes")) return "pngBytes-lifecycle-use";
    return null;
  });

  const corruptLifecycleDeclaration = variableDeclarationNamed(run, "corruptLifecycle");
  const corruptLifecycleAwait = corruptLifecycleDeclaration?.initializer;
  const corruptLifecycleCall =
    corruptLifecycleAwait && ts.isAwaitExpression(corruptLifecycleAwait)
    ? corruptLifecycleAwait.expression
    : null;
  const corruptLifecycleObject =
    corruptLifecycleCall &&
    ts.isCallExpression(corruptLifecycleCall) &&
    corruptLifecycleCall.arguments.length === 1 &&
    ts.isObjectLiteralExpression(corruptLifecycleCall.arguments[0])
      ? corruptLifecycleCall.arguments[0]
      : null;
  const corruptLifecycleProperties = corruptLifecycleObject?.properties ?? [];
  const expectedLifecycleProperties = [
    "corruptPath",
    "validBytes",
    "diagnosticState",
    "hasRestoreAuthority",
    "runProductCase",
    "validateProductResult",
    "onRestoreVerified",
  ];
  if (
    !corruptLifecycleDeclaration ||
    !isConstDeclaration(corruptLifecycleDeclaration) ||
    !corruptLifecycleAwait ||
    !ts.isAwaitExpression(corruptLifecycleAwait) ||
    !corruptLifecycleCall ||
    !ts.isCallExpression(corruptLifecycleCall) ||
    !identifierNamed(corruptLifecycleCall.expression, "runCorruptImageSelectionCase") ||
    !corruptLifecycleObject ||
    corruptLifecycleProperties.length !== expectedLifecycleProperties.length ||
    corruptLifecycleProperties.some(
      (property, index) => propertyNameText(property) !== expectedLifecycleProperties[index],
    ) ||
    !ts.isShorthandPropertyAssignment(corruptLifecycleProperties[0]) ||
    !identifierNamed(corruptLifecycleProperties[0].name, "corruptPath") ||
    !ts.isPropertyAssignment(corruptLifecycleProperties[1]) ||
    !identifierNamed(corruptLifecycleProperties[1].initializer, "pngBytes") ||
    !ts.isShorthandPropertyAssignment(corruptLifecycleProperties[2]) ||
    !identifierNamed(corruptLifecycleProperties[2].name, "diagnosticState") ||
    !ts.isPropertyAssignment(corruptLifecycleProperties[4]) ||
    !ts.isArrowFunction(corruptLifecycleProperties[4].initializer) ||
    !ts.isPropertyAssignment(corruptLifecycleProperties[5]) ||
    !ts.isArrowFunction(corruptLifecycleProperties[5].initializer) ||
    !ts.isPropertyAssignment(corruptLifecycleProperties[6]) ||
    !ts.isArrowFunction(corruptLifecycleProperties[6].initializer)
  ) {
    rejectNode(corruptLifecycleDeclaration ?? run, "corrupt-lifecycle-shape");
  }

  const authorityProperty = corruptLifecycleProperties[3];
  const authorityArrow = authorityProperty &&
    ts.isPropertyAssignment(authorityProperty) &&
    ts.isArrowFunction(authorityProperty.initializer)
      ? authorityProperty.initializer
      : null;
  const authorityBody = authorityArrow?.body;
  if (
    !authorityArrow ||
    authorityArrow.parameters.length !== 0 ||
    !ts.isBinaryExpression(authorityBody) ||
    authorityBody.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken ||
    !identifierNamed(authorityBody.left, "imageSelectionHostStateKnown") ||
    !ts.isCallExpression(authorityBody.right) ||
    !identifierNamed(authorityBody.right.expression, "runtimeEvaluationCompletionKnown") ||
    authorityBody.right.arguments.length !== 0
  ) {
    rejectNode(authorityProperty ?? corruptLifecycleDeclaration ?? run, "restore-authority-shape");
  }

  const restoreCallbackProperty = corruptLifecycleProperties[6];
  const restoreCallback =
    restoreCallbackProperty &&
    ts.isPropertyAssignment(restoreCallbackProperty) &&
    ts.isArrowFunction(restoreCallbackProperty.initializer)
      ? restoreCallbackProperty.initializer
      : null;
  const restoreCallbackStatement =
    restoreCallback &&
    ts.isBlock(restoreCallback.body) &&
    restoreCallback.body.statements.length === 1 &&
    ts.isExpressionStatement(restoreCallback.body.statements[0])
      ? restoreCallback.body.statements[0]
      : null;
  const restoreCallbackAssignment = restoreCallbackStatement?.expression;
  if (
    !restoreCallback ||
    restoreCallback.parameters.length !== 0 ||
    restoreCallback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
    !restoreCallbackStatement ||
    !ts.isBinaryExpression(restoreCallbackAssignment) ||
    restoreCallbackAssignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !identifierNamed(restoreCallbackAssignment.left, "corruptImageSourceRestored") ||
    restoreCallbackAssignment.right.kind !== ts.SyntaxKind.TrueKeyword
  ) {
    rejectNode(
      restoreCallbackProperty ?? corruptLifecycleDeclaration ?? run,
      "restore-callback-shape",
    );
  }

  const runtimeCompletionDeclaration = variableDeclarationNamed(
    run,
    "runtimeEvaluationCompletionKnown",
  );
  const runtimeCompletion =
    runtimeCompletionDeclaration && ts.isArrowFunction(runtimeCompletionDeclaration.initializer)
      ? runtimeCompletionDeclaration.initializer
      : null;
  const runtimeCompletionCall = runtimeCompletion?.body;
  if (
    !runtimeCompletion ||
    runtimeCompletion.parameters.length !== 0 ||
    !ts.isCallExpression(runtimeCompletionCall) ||
    !identifierNamed(
      runtimeCompletionCall.expression,
      "isFunctionalSmokeRuntimeCompletionKnown",
    ) ||
    runtimeCompletionCall.arguments.length !== 1 ||
    !identifierNamed(runtimeCompletionCall.arguments[0], "runtimeEvaluationGuard") ||
    !ts.isVariableDeclaration(runtimeCompletion.parent) ||
    !isConstDeclaration(runtimeCompletion.parent)
  ) {
    rejectNode(
      runtimeCompletion ?? runtimeCompletionDeclaration ?? run,
      "runtime-completion-binding-shape",
    );
  }

  const intendedRunBindingDeclarations = new Map([
    ["runtimeEvaluationCompletionKnown", runtimeCompletionDeclaration],
    ["runtimeEvaluationGuard", variableDeclarationNamed(run, "runtimeEvaluationGuard")],
    ["imageSelectionHostStateKnown", variableDeclarationNamed(run, "imageSelectionHostStateKnown")],
    ["configMutationAttempted", variableDeclarationNamed(run, "configMutationAttempted")],
    ["configRestored", variableDeclarationNamed(run, "configRestored")],
    ["imageSelectionCleanupRequired", variableDeclarationNamed(run, "imageSelectionCleanupRequired")],
    ["imageSelectionProjectResetRequired", variableDeclarationNamed(run, "imageSelectionProjectResetRequired")],
    ["imageSelectionProjectResetCompleted", variableDeclarationNamed(run, "imageSelectionProjectResetCompleted")],
    ["corruptImageSourceRestoreRequired", variableDeclarationNamed(run, "corruptImageSourceRestoreRequired")],
    ["corruptImageSourceRestored", variableDeclarationNamed(run, "corruptImageSourceRestored")],
    ["evalImageHost", variableDeclarationNamed(run, "evalImageHost")],
    ["captureNewOwnedTopology", captureNewOwnedTopologyDeclaration],
    ["executeCase", variableDeclarationNamed(run, "executeCase")],
  ]);
  for (const [name, declaration] of intendedRunBindingDeclarations) {
    const bindings = runBindings.filter((binding) => binding.name === name);
    if (
      !declaration ||
      !ts.isIdentifier(declaration.name) ||
      bindings.length !== 1 ||
      bindings[0].node !== declaration.name
    ) {
      errors.push(
        `${name}-binding-shadow:expected-intended-declaration:actual-${bindings.length}`,
      );
    }
  }

  const compactText = (node) => node?.getText(sourceFile).replace(/\s+/g, "") ?? "";
  const siblingStatements = (node) => {
    const statement = containingStatement(node);
    const statements = statement?.parent?.statements;
    if (!statement || !statements) return { previous: null, next: null, next2: null };
    const index = statements.indexOf(statement);
    return {
      previous: index > 0 ? statements[index - 1] : null,
      next: index >= 0 ? statements[index + 1] ?? null : null,
      next2: index >= 0 ? statements[index + 2] ?? null : null,
    };
  };
  const directAwaitedCall = (statement) => {
    let expression = null;
    if (ts.isExpressionStatement(statement)) expression = statement.expression;
    if (
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.length === 1
    ) expression = statement.declarationList.declarations[0].initializer;
    if (!expression || !ts.isAwaitExpression(expression)) return null;
    const call = expression.expression;
    return ts.isCallExpression(call) && !call.questionDotToken ? call : null;
  };
  const isDirectAwaitedCall = (statement, calleeText, argumentCount) => {
    const call = directAwaitedCall(statement);
    return Boolean(
      call &&
      compactText(call.expression) === calleeText &&
      call.arguments.length === argumentCount,
    );
  };
  const enclosingCleanupPhase = (node) => {
    let current = node;
    while (current && current !== run) {
      if (ts.isObjectLiteralExpression(current)) {
        const phase = current.properties.find(
          (property) =>
            ts.isPropertyAssignment(property) &&
            propertyNameText(property) === "phase" &&
            ts.isStringLiteral(property.initializer),
        );
        if (phase) return phase.initializer.text;
      }
      current = current.parent;
    }
    return null;
  };
  const isTemporaryDirectoryRemovalAssertionArgument = (identifier) => {
    const property = identifier.parent;
    if (!ts.isShorthandPropertyAssignment(property) || property.name !== identifier) return false;
    const argument = property.parent;
    const call = argument.parent;
    return Boolean(
      ts.isObjectLiteralExpression(argument) &&
      ts.isCallExpression(call) &&
      call.arguments.length === 1 &&
      call.arguments[0] === argument &&
      compactText(call.expression) === "assertFunctionalSmokeTemporaryDirectoryRemovalAllowed" &&
      compactText(argument) ===
        "{path:configRun.path,corruptImageSourceRestoreRequired,corruptImageSourceRestored,imageSelectionProjectResetRequired,imageSelectionProjectResetCompleted,configMutationAttempted,configRestored,}" &&
      enclosingCleanupPhase(identifier) === "temporary-directory"
    );
  };
  const latchNames = [
    "configMutationAttempted",
    "configRestored",
    "imageSelectionCleanupRequired",
    "imageSelectionProjectResetRequired",
    "imageSelectionProjectResetCompleted",
    "corruptImageSourceRestoreRequired",
    "corruptImageSourceRestored",
  ];
  for (const name of latchNames) {
    const declaration = intendedRunBindingDeclarations.get(name);
    if (
      !declaration ||
      !declaration.parent ||
      (declaration.parent.flags & ts.NodeFlags.Let) === 0 ||
      declaration.initializer?.kind !== ts.SyntaxKind.FalseKeyword
    ) rejectNode(declaration ?? run, `${name}-declaration-shape`);
  }
  const latchAssignment = (identifier) => {
    const assignment = identifier.parent;
    return ts.isBinaryExpression(assignment) &&
      assignment.left === identifier &&
      assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      assignment.right.kind === ts.SyntaxKind.TrueKeyword
      ? assignment
      : null;
  };
  walkIdentifiers(run, "configMutationAttempted", "configMutationAttempted-use", (identifier) => {
    if (intendedRunBindingDeclarations.get("configMutationAttempted")?.name === identifier) {
      return "configMutationAttempted-declaration-use";
    }
    if (latchAssignment(identifier)) {
      const { previous, next } = siblingStatements(identifier);
      if (
        ts.isIfStatement(previous) &&
        compactText(previous).includes("initialIdentity.configRoot") &&
        compactText(next) === "imageSelectionHostStateKnown=false;"
      ) return "configMutationAttempted-latch";
      return null;
    }
    if (isTemporaryDirectoryRemovalAssertionArgument(identifier)) {
      return "configMutationAttempted-delete-guard";
    }
    if (
      ts.isPrefixUnaryExpression(identifier.parent) &&
      identifier.parent.operator === ts.SyntaxKind.ExclamationToken &&
      ts.isIfStatement(identifier.parent.parent) &&
      enclosingCleanupPhase(identifier) === "temporary-config-root"
    ) return "configMutationAttempted-restore-guard";
    if (
      ts.isBinaryExpression(identifier.parent) &&
      identifier.parent.left === identifier &&
      identifier.parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      enclosingCleanupPhase(identifier) === "temporary-directory"
    ) return "configMutationAttempted-delete-guard";
    return null;
  });
  walkIdentifiers(run, "configRestored", "configRestored-use", (identifier) => {
    if (intendedRunBindingDeclarations.get("configRestored")?.name === identifier) {
      return "configRestored-declaration-use";
    }
    if (latchAssignment(identifier)) {
      const { previous } = siblingStatements(identifier);
      const restorationCall = directAwaitedCall(previous);
      if (
        restorationCall &&
        compactText(restorationCall.expression) === "restoreConfigRootWithReadback" &&
        restorationCall.arguments.length === 1 &&
        compactText(restorationCall.arguments[0]) ===
          '{expectedRoot:originalConfigRoot,setRoot:(root)=>client.evaluate(debugCall(`(api)=>api.setTemporaryConfigRoot(${JSON.stringify(root)})`)),settle:()=>afterRender(client),readRoot:()=>client.evaluate(debugCall("(api)=>api.getIdentity().configRoot")),label:"functionalsmokeMainconfigroot",}' &&
        enclosingCleanupPhase(identifier) === "temporary-config-root"
      ) return "configRestored-latch";
      return null;
    }
    if (isTemporaryDirectoryRemovalAssertionArgument(identifier)) {
      return "configRestored-delete-guard";
    }
    if (
      ts.isPrefixUnaryExpression(identifier.parent) &&
      identifier.parent.operator === ts.SyntaxKind.ExclamationToken &&
      ts.isBinaryExpression(identifier.parent.parent) &&
      identifier.parent.parent.right === identifier.parent &&
      enclosingCleanupPhase(identifier) === "temporary-directory"
    ) return "configRestored-delete-guard";
    return null;
  });
  walkIdentifiers(run, "imageSelectionCleanupRequired", "imageSelectionCleanupRequired-use", (identifier) => {
    if (intendedRunBindingDeclarations.get("imageSelectionCleanupRequired")?.name === identifier) {
      return "imageSelectionCleanupRequired-declaration-use";
    }
    if (latchAssignment(identifier)) {
      const { previous, next } = siblingStatements(identifier);
      if (
        compactText(previous) === "imageSelectionProjectResetRequired=true;" &&
        compactText(next).startsWith("evalImageHost=(source)=>")
      ) return "imageSelectionCleanupRequired-latch";
      return null;
    }
    if (
      ts.isBinaryExpression(identifier.parent) &&
      identifier.parent.left === identifier &&
      identifier.parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      ts.isIfStatement(identifier.parent.parent)
    ) return "imageSelectionCleanupRequired-branch-guard";
    return null;
  });
  walkIdentifiers(
    run,
    "imageSelectionProjectResetRequired",
    "imageSelectionProjectResetRequired-use",
    (identifier) => {
      if (intendedRunBindingDeclarations.get("imageSelectionProjectResetRequired")?.name === identifier) {
        return "imageSelectionProjectResetRequired-declaration-use";
      }
      if (latchAssignment(identifier)) {
        const { previous, next } = siblingStatements(identifier);
        if (
          ts.isIfStatement(previous) &&
          compactText(previous).includes("requiresanemptycleanunsavedproject") &&
          compactText(next) === "imageSelectionCleanupRequired=true;"
        ) return "imageSelectionProjectResetRequired-latch";
        return null;
      }
      if (isTemporaryDirectoryRemovalAssertionArgument(identifier)) {
        return "imageSelectionProjectResetRequired-delete-guard";
      }
      if (
        ts.isPrefixUnaryExpression(identifier.parent) &&
        identifier.parent.operator === ts.SyntaxKind.ExclamationToken &&
        ts.isBinaryExpression(identifier.parent.parent) &&
        identifier.parent.parent.right === identifier.parent
      ) return "imageSelectionProjectResetRequired-cleanup-negated-guard";
      if (ts.isIfStatement(identifier.parent) && identifier.parent.expression === identifier) {
        return "imageSelectionProjectResetRequired-reset-branch";
      }
      return null;
    },
  );
  walkIdentifiers(
    run,
    "imageSelectionProjectResetCompleted",
    "imageSelectionProjectResetCompleted-use",
    (identifier) => {
      if (intendedRunBindingDeclarations.get("imageSelectionProjectResetCompleted")?.name === identifier) {
        return "imageSelectionProjectResetCompleted-declaration-use";
      }
      if (latchAssignment(identifier)) {
        const { previous } = siblingStatements(identifier);
        if (
          enclosingCleanupPhase(identifier) === "image-selection-project-reset" &&
          compactText(previous) ===
            'if(reset.reset!==true||reset.archivePath!==archivePath||reset.projectPath!==null||reset.dirty!==false||reset.numItems!==0){thrownewError(`Image-selectionprojectresetfailed:${JSON.stringify(reset)}`);}'
        ) return "imageSelectionProjectResetCompleted-latch";
        return null;
      }
      return isTemporaryDirectoryRemovalAssertionArgument(identifier)
        ? "imageSelectionProjectResetCompleted-delete-guard"
        : null;
    },
  );
  const classifyCorruptRestorationGuard = (identifier, name) => {
    if (isTemporaryDirectoryRemovalAssertionArgument(identifier)) {
      return "corrupt-restoration-temporary-directory-guard";
    }
    const expression = name === "corruptImageSourceRestored"
      ? identifier.parent.parent
      : identifier.parent;
    if (
      !ts.isBinaryExpression(expression) ||
      expression.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken ||
      (name === "corruptImageSourceRestoreRequired" && expression.left !== identifier) ||
      (name === "corruptImageSourceRestored" &&
        (!ts.isPrefixUnaryExpression(identifier.parent) || expression.right !== identifier.parent))
    ) return null;
    const phase = enclosingCleanupPhase(identifier);
    return ["image-selection-project-reset", "temporary-directory"].includes(phase)
      ? `corrupt-restoration-${phase}-guard`
      : null;
  };
  walkIdentifiers(
    run,
    "corruptImageSourceRestoreRequired",
    "corruptImageSourceRestoreRequired-use",
    (identifier) => {
      if (intendedRunBindingDeclarations.get("corruptImageSourceRestoreRequired")?.name === identifier) {
        return "corruptImageSourceRestoreRequired-declaration-use";
      }
      if (latchAssignment(identifier)) {
        const { previous } = siblingStatements(identifier);
        const latchStatement = containingStatement(identifier);
        const lifecycleStatement = containingStatement(corruptLifecycleDeclaration);
        if (
          compactText(previous).startsWith("captureNewOwnedTopology([corruptOwnedItem],corruptImage)") &&
          latchStatement?.parent === lifecycleStatement?.parent &&
          latchStatement.getStart(sourceFile) < lifecycleStatement.getStart(sourceFile)
        ) return "corruptImageSourceRestoreRequired-latch";
        return null;
      }
      return classifyCorruptRestorationGuard(identifier, "corruptImageSourceRestoreRequired");
    },
  );
  walkIdentifiers(run, "corruptImageSourceRestored", "corruptImageSourceRestored-use", (identifier) => {
    if (intendedRunBindingDeclarations.get("corruptImageSourceRestored")?.name === identifier) {
      return "corruptImageSourceRestored-declaration-use";
    }
    if (latchAssignment(identifier)) return "corruptImageSourceRestored-callback-latch";
    return classifyCorruptRestorationGuard(identifier, "corruptImageSourceRestored");
  });

  const runtimeGuardDeclaration = intendedRunBindingDeclarations.get("runtimeEvaluationGuard");
  walkIdentifiers(run, "runtimeEvaluationGuard", "runtimeEvaluationGuard-use", (identifier) => {
    if (runtimeGuardDeclaration?.name === identifier) return "runtimeEvaluationGuard-declaration-use";
    const assignment = identifier.parent;
    if (
      ts.isBinaryExpression(assignment) &&
      assignment.left === identifier &&
      assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isCallExpression(assignment.right) &&
      identifierNamed(assignment.right.expression, "guardClientEvaluations") &&
      assignment.right.arguments.length === 2 &&
      identifierNamed(assignment.right.arguments[0], "client") &&
      ts.isStringLiteral(assignment.right.arguments[1]) &&
      assignment.right.arguments[1].text === "functional smoke Main"
    ) return "runtimeEvaluationGuard-install";
    if (callArgumentUse(identifier, "isFunctionalSmokeRuntimeCompletionKnown", 0)) {
      return "runtimeEvaluationGuard-completion-read";
    }
    if (callArgumentUse(identifier, "waitForHostIdle", 1)) {
      return "runtimeEvaluationGuard-host-wait";
    }
    if (callArgumentUse(identifier, "waitForStableDebug", 1)) {
      return "runtimeEvaluationGuard-stable-wait";
    }
    if (callArgumentUse(identifier, "waitForMutationRevision", 2)) {
      return "runtimeEvaluationGuard-mutation-wait";
    }
    if (callArgumentUse(identifier, "waitForReloadedPalette", 3)) {
      return "runtimeEvaluationGuard-reload-wait";
    }
    return null;
  });

  const hostStateDeclaration = intendedRunBindingDeclarations.get("imageSelectionHostStateKnown");
  walkIdentifiers(
    run,
    "imageSelectionHostStateKnown",
    "imageSelectionHostStateKnown-use",
    (identifier) => {
      if (hostStateDeclaration?.name === identifier) return "imageSelectionHostStateKnown-declaration-use";
      const assignment = identifier.parent;
      if (
        ts.isBinaryExpression(assignment) &&
        assignment.left === identifier &&
        assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        const { previous, next, next2 } = siblingStatements(identifier);
        const previousText = compactText(previous);
        const nextText = compactText(next);
        const next2Text = compactText(next2);
        if (assignment.right.kind === ts.SyntaxKind.FalseKeyword) {
          if (
            isDirectAwaitedCall(next, "client.evaluate", 1) &&
            nextText.startsWith("constaccepted=awaitclient.evaluate(debugCall(expression))") &&
            isDirectAwaitedCall(next2, "waitForHostIdle", 2) &&
            next2Text.startsWith("conststate=awaitwaitForHostIdle(client,runtimeEvaluationGuard)")
          ) return "host-state-dispatch-false";
          if (
            isDirectAwaitedCall(next, "client.evaluate", 1) &&
            nextText.startsWith("awaitclient.evaluate(debugCall(`(api)=>api.setTemporaryConfigRoot(")
          ) {
            return "host-state-config-false";
          }
          if (
            isDirectAwaitedCall(next, "evalHost", 2) &&
            nextText.startsWith("constresult=awaitevalHost(client,guardImageSelectionProjectSource(")
          ) {
            return "host-state-image-wrapper-false";
          }
          if (
            isDirectAwaitedCall(next, "client.evaluate", 1) &&
            nextText.startsWith("constaccepted=awaitclient.evaluate(debugCall('(api)=>api.dispatchClick(\"palette-add\")'))") &&
            isDirectAwaitedCall(next2, "waitForHostIdle", 2) &&
            next2Text.startsWith("conststate=awaitwaitForHostIdle(client,runtimeEvaluationGuard)")
          ) return "host-state-palette-click-false";
          if (
            isDirectAwaitedCall(next, "evalHost", 2) &&
            nextText.startsWith("constresult=awaitevalHost(client,cleanupImageSelectionFixturesSource(")
          ) {
            return "host-state-cleanup-false";
          }
          if (
            nextText.startsWith("constarchivePath=resolve(outputDirectory,\"preserved-functional-project.aep\")") &&
            isDirectAwaitedCall(next2, "evalHost", 2) &&
            next2Text.startsWith("constreset=awaitevalHost(client,archiveAndResetOwnedProjectSource(")
          ) return "host-state-project-reset-false";
          return null;
        }
        if (assignment.right.kind === ts.SyntaxKind.TrueKeyword) {
          if (
            isDirectAwaitedCall(previous, "waitForHostIdle", 2) &&
            previousText.startsWith("conststate=awaitwaitForHostIdle(client,runtimeEvaluationGuard)") &&
            nextText === "return{accepted,state};"
          ) return "host-state-dispatch-true";
          if (
            ts.isIfStatement(previous) &&
            previousText.includes("temporaryIdentity.configRoot!==temporaryRoot") &&
            nextText.startsWith("if(mode===\"mutate\")")
          ) return "host-state-config-true";
          if (
            isDirectAwaitedCall(previous, "evalHost", 2) &&
            previousText.startsWith("constresult=awaitevalHost(client,guardImageSelectionProjectSource(") &&
            nextText === "returnresult;"
          ) return "host-state-image-wrapper-true";
          if (
            isDirectAwaitedCall(previous, "waitForHostIdle", 2) &&
            previousText.startsWith("conststate=awaitwaitForHostIdle(client,runtimeEvaluationGuard)") &&
            nextText.startsWith("constelapsedMs=Date.now()-startedAt")
          ) return "host-state-image-case-true";
          if (
            isDirectAwaitedCall(previous, "evalHost", 2) &&
            previousText.startsWith("constresult=awaitevalHost(client,cleanupImageSelectionFixturesSource(") &&
            nextText === "returnresult;"
          ) return "host-state-cleanup-true";
          if (
            isDirectAwaitedCall(previous, "evalHost", 2) &&
            previousText.startsWith("constreset=awaitevalHost(client,archiveAndResetOwnedProjectSource(") &&
            ts.isIfStatement(next)
          ) return "host-state-project-reset-true";
          return null;
        }
        if (
          assignment.right.getText(sourceFile).replace(/\s+/g, "") ===
            "accepted===true&&snapshot?.state?.pendingHostAction===null&&snapshot?.counters?.hostCalls===1" &&
          isDirectAwaitedCall(previous, "client.evaluate", 1) &&
          previousText.startsWith("constsnapshot=awaitclient.evaluate(debugCall(") &&
          nextText.startsWith("conststored=JSON.parse(awaitreadFile(")
        ) return "host-state-selection-case-derived";
        return null;
      }
      if (authorityBody?.left === identifier) return "imageSelectionHostStateKnown-authority-read";
      if (
        ts.isPrefixUnaryExpression(identifier.parent) &&
        identifier.parent.operator === ts.SyntaxKind.ExclamationToken &&
        ts.isBinaryExpression(identifier.parent.parent) &&
        identifier.parent.parent.left === identifier.parent &&
        identifier.parent.parent.operatorToken.kind === ts.SyntaxKind.BarBarToken &&
        ts.isPrefixUnaryExpression(identifier.parent.parent.right) &&
        identifier.parent.parent.right.operator === ts.SyntaxKind.ExclamationToken &&
        ts.isCallExpression(identifier.parent.parent.right.operand) &&
        identifierNamed(
          identifier.parent.parent.right.operand.expression,
          "runtimeEvaluationCompletionKnown",
        )
      ) {
        const phase = enclosingCleanupPhase(identifier);
        return [
          "image-selection-fixtures",
          "image-selection-project-reset",
          "temporary-config-root",
        ].includes(phase)
          ? `imageSelectionHostStateKnown-${phase}-guard`
          : null;
      }
      return null;
    },
  );

  walkIdentifiers(run, "diagnosticState", "production-diagnosticState-use", (identifier) => {
    if (
      ts.isBindingElement(identifier.parent) &&
      identifier.parent.name === identifier &&
      ts.isObjectBindingPattern(identifier.parent.parent) &&
      identifier.parent.parent === run.parameters[0]?.name
    ) return "production-diagnosticState-binding";
    if (callArgumentUse(identifier, "importFunctionalSmokeErrorDiagnostics", 1)) {
      return "production-diagnosticState-import";
    }
    if (ts.isShorthandPropertyAssignment(identifier.parent)) {
      const object = identifier.parent.parent;
      const call = object.parent;
      if (
        ts.isObjectLiteralExpression(object) &&
        ts.isCallExpression(call) &&
        call.arguments[0] === object &&
        ts.isIdentifier(call.expression) &&
        [
          "runCorruptImageSelectionCase",
          "finalizeFunctionalSmoke",
          "publishFunctionalSmokeFailure",
        ].includes(call.expression.text)
      ) return `production-diagnosticState-${call.expression.text}`;
    }
    return null;
  });

  const corruptImportDeclaration = variableDeclarationNamed(run, "corruptImage");
  const corruptImportAwait = corruptImportDeclaration?.initializer;
  const corruptImportEvalCall = corruptImportAwait && ts.isAwaitExpression(corruptImportAwait)
    ? corruptImportAwait.expression
    : null;
  const corruptImportSourceCall =
    corruptImportEvalCall &&
    ts.isCallExpression(corruptImportEvalCall) &&
    corruptImportEvalCall.arguments.length === 1 &&
    ts.isCallExpression(corruptImportEvalCall.arguments[0])
      ? corruptImportEvalCall.arguments[0]
      : null;
  if (
    !corruptImportDeclaration ||
    !isConstDeclaration(corruptImportDeclaration) ||
    !corruptImportAwait ||
    !ts.isAwaitExpression(corruptImportAwait) ||
    !corruptImportEvalCall ||
    !ts.isCallExpression(corruptImportEvalCall) ||
    !identifierNamed(corruptImportEvalCall.expression, "evalImageHost") ||
    !corruptImportSourceCall ||
    !identifierNamed(corruptImportSourceCall.expression, "importProjectImageSource") ||
    corruptImportSourceCall.arguments.length !== 2 ||
    !identifierNamed(corruptImportSourceCall.arguments[0], "corruptPath") ||
    !ts.isStringLiteral(corruptImportSourceCall.arguments[1]) ||
    corruptImportSourceCall.arguments[1].text !== "CP_IMAGE_CORRUPT_PNG"
  ) {
    rejectNode(corruptImportDeclaration ?? run, "corrupt-import-shape");
  }

  let validCopyStatement = null;
  const findValidCopy = (node) => {
    if (
      ts.isExpressionStatement(node) &&
      ts.isAwaitExpression(node.expression) &&
      ts.isCallExpression(node.expression.expression) &&
      identifierNamed(node.expression.expression.expression, "writeFile") &&
      node.expression.expression.arguments.length === 2 &&
      identifierNamed(node.expression.expression.arguments[0], "corruptPath") &&
      identifierNamed(node.expression.expression.arguments[1], "pngBytes")
    ) {
      if (validCopyStatement) rejectNode(node, "corrupt-valid-copy-duplicate");
      validCopyStatement = node;
    }
    ts.forEachChild(node, findValidCopy);
  };
  findValidCopy(run);
  const pngBytesStatement = pngBytesDeclaration && containingStatement(pngBytesDeclaration);
  const corruptImportStatement = corruptImportDeclaration && containingStatement(corruptImportDeclaration);
  const corruptLifecycleStatement =
    corruptLifecycleDeclaration && containingStatement(corruptLifecycleDeclaration);
  if (
    !pngBytesStatement ||
    !validCopyStatement ||
    !corruptImportStatement ||
    !corruptLifecycleStatement ||
    pngBytesStatement.parent !== validCopyStatement.parent ||
    validCopyStatement.parent !== corruptImportStatement.parent ||
    corruptImportStatement.parent !== corruptLifecycleStatement.parent ||
    !(
      pngBytesStatement.getStart(sourceFile) < validCopyStatement.getStart(sourceFile) &&
      validCopyStatement.getStart(sourceFile) < corruptImportStatement.getStart(sourceFile) &&
      corruptImportStatement.getStart(sourceFile) < corruptLifecycleStatement.getStart(sourceFile)
    )
  ) {
    rejectNode(corruptLifecycleDeclaration ?? run, "corrupt-lifecycle-order");
  }

  const corruptSourceRestorationDeclaration = variableDeclarationNamed(
    run,
    "corruptSourceRestoration",
  );
  walkIdentifiers(run, "corruptLifecycle", "corruptLifecycle-use", (identifier) => {
    if (corruptLifecycleDeclaration?.name === identifier) return "corruptLifecycle-declaration-use";
    if (
      ts.isPropertyAccessExpression(identifier.parent) &&
      identifier.parent.expression === identifier &&
      identifierNamed(identifier.parent.name, "restoration") &&
      corruptSourceRestorationDeclaration?.initializer === identifier.parent
    ) return "corruptLifecycle-restoration-use";
    return null;
  });
  walkIdentifiers(
    run,
    "corruptSourceRestoration",
    "corruptSourceRestoration-use",
    (identifier) => {
      if (corruptSourceRestorationDeclaration?.name === identifier) {
        return "corruptSourceRestoration-declaration-use";
      }
      if (
        ts.isShorthandPropertyAssignment(identifier.parent) &&
        identifier.parent.name === identifier
      ) return "corruptSourceRestoration-report-use";
      return null;
    },
  );

  for (const [label, expected] of [
    ["corrupt-declaration", 1],
    ["corrupt-valid-copy", 1],
    ["corrupt-valid-import", 1],
    ["corrupt-lifecycle-wire", 1],
    ["helper-corrupt-parameter", 1],
    ["helper-corrupt-write", 2],
    ["helper-corrupt-read", 1],
    ["helper-corrupt-path-record", 2],
    ["helper-validBytes-binding", 1],
    ["helper-validBytes-copy", 1],
    ["helper-corruptBytes-binding", 1],
    ["helper-corruptBytes-write", 1],
    ["Buffer-import-use", 1],
    ["Buffer-from-direct-call", 9],
    ["helper-runProductCase-binding", 1],
    ["helper-runProductCase-call", 1],
    ["helper-validateProductResult-binding", 1],
    ["helper-validateProductResult-call", 1],
    ["helper-hasRestoreAuthority-binding", 1],
    ["helper-hasRestoreAuthority-call", 1],
    ["helper-diagnosticState-binding", 1],
    ["helper-diagnosticState-import", 1],
    ["helper-diagnosticState-attach", 2],
    ["helper-diagnosticState-cleanup-append", 1],
    ["helper-onRestoreVerified-binding", 1],
    ["helper-onRestoreVerified-call", 1],
    ["helper-writeSource-binding", 1],
    ["helper-writeSource-call", 2],
    ["helper-readSource-binding", 1],
    ["helper-readSource-call", 1],
    ["expectedBytes-declaration-use", 1],
    ["expectedBytes-restore-write", 1],
    ["expectedBytes-sha-use", 1],
    ["expectedBytes-equality-use", 1],
    ["configMutationAttempted-declaration-use", 1],
    ["configMutationAttempted-latch", 1],
    ["configMutationAttempted-restore-guard", 1],
    ["configMutationAttempted-delete-guard", 1],
    ["configRestored-declaration-use", 1],
    ["configRestored-latch", 1],
    ["configRestored-delete-guard", 1],
    ["imageSelectionCleanupRequired-declaration-use", 1],
    ["imageSelectionCleanupRequired-latch", 1],
    ["imageSelectionCleanupRequired-branch-guard", 1],
    ["imageSelectionProjectResetRequired-declaration-use", 1],
    ["imageSelectionProjectResetRequired-latch", 1],
    ["imageSelectionProjectResetRequired-cleanup-negated-guard", 1],
    ["imageSelectionProjectResetRequired-reset-branch", 1],
    ["imageSelectionProjectResetRequired-delete-guard", 1],
    ["imageSelectionProjectResetCompleted-declaration-use", 1],
    ["imageSelectionProjectResetCompleted-latch", 1],
    ["imageSelectionProjectResetCompleted-delete-guard", 1],
    ["corruptImageSourceRestoreRequired-declaration-use", 1],
    ["corruptImageSourceRestoreRequired-latch", 1],
    ["corruptImageSourceRestored-declaration-use", 1],
    ["corruptImageSourceRestored-callback-latch", 1],
    ["corrupt-restoration-image-selection-project-reset-guard", 2],
    ["corrupt-restoration-temporary-directory-guard", 2],
    ["runtimeEvaluationGuard-declaration-use", 1],
    ["runtimeEvaluationGuard-install", 1],
    ["runtimeEvaluationGuard-completion-read", 1],
    ["runtimeEvaluationGuard-host-wait", 3],
    ["runtimeEvaluationGuard-stable-wait", 4],
    ["runtimeEvaluationGuard-mutation-wait", 4],
    ["runtimeEvaluationGuard-reload-wait", 1],
    ["imageSelectionHostStateKnown-declaration-use", 1],
    ["host-state-dispatch-false", 1],
    ["host-state-config-false", 1],
    ["host-state-image-wrapper-false", 1],
    ["host-state-palette-click-false", 2],
    ["host-state-cleanup-false", 1],
    ["host-state-project-reset-false", 1],
    ["host-state-dispatch-true", 1],
    ["host-state-config-true", 1],
    ["host-state-image-wrapper-true", 1],
    ["host-state-image-case-true", 1],
    ["host-state-cleanup-true", 1],
    ["host-state-project-reset-true", 1],
    ["host-state-selection-case-derived", 1],
    ["imageSelectionHostStateKnown-authority-read", 1],
    ["imageSelectionHostStateKnown-image-selection-fixtures-guard", 1],
    ["imageSelectionHostStateKnown-image-selection-project-reset-guard", 1],
    ["imageSelectionHostStateKnown-temporary-config-root-guard", 1],
    ["production-diagnosticState-binding", 1],
    ["production-diagnosticState-import", 1],
    ["production-diagnosticState-runCorruptImageSelectionCase", 1],
    ["production-diagnosticState-finalizeFunctionalSmoke", 1],
    ["production-diagnosticState-publishFunctionalSmokeFailure", 1],
    ["topology-declaration", 1],
    ["topology-validated-capture", 1],
    ["topology-readonly-cleanup", 1],
    ["captureNewOwnedTopology-declaration", 1],
    ["captureNewOwnedTopology-terminal-call", 5],
    ["pngBytes-provenance-use", 1],
    ["pngBytes-valid-copy-use", 1],
    ["pngBytes-lifecycle-use", 1],
    ["corruptLifecycle-declaration-use", 1],
    ["corruptLifecycle-restoration-use", 1],
    ["corruptSourceRestoration-declaration-use", 1],
    ["corruptSourceRestoration-report-use", 1],
  ]) {
    if ((counts.get(label) ?? 0) !== expected) {
      errors.push(`${label}:expected-${expected}:actual-${counts.get(label) ?? 0}`);
    }
  }
  return errors;
};

test("CLI parsing rejects empty, duplicate, unknown, absolute, root, and traversal outputs", () => {
  for (const argv of [
    ["--output="],
    ["--output=a", "--output=b"],
    ["--unknown=x"],
    ["--output=/tmp/out"],
    ["--output=C:\\tmp\\out"],
    ["--output=C:tmp\\out"],
    ["--output=\\rooted"],
    ["--output=\\\\server\\share"],
    ["--output=."],
    ["--output=./."],
    ["--output=.//"],
    ["--output=.\\."],
    ["--output=../out"],
    ["--output=a/../../out"],
    ["--output=a\\..\\out"],
    ["--output=.. /outside"],
    ["--output=.../outside"],
    ["--output=foo/.. /outside"],
    ["--output=foo./outside"],
    ["--output=CON"],
    ["--output=nul.txt"],
    ["--output=reports:stream"],
    ["--output=bad?name"],
  ]) {
    assert.throws(() => parseRunnerArgs(argv, { allowed: ["output"] }), RunnerPolicyError);
  }
  assert.deepEqual(
    parseRunnerArgs(["--output=reports", "--main-id=main"], {
      allowed: ["output", "main-id"],
    }),
    { output: "reports", "main-id": "main" }
  );
  assert.deepEqual(parseRunnerArgs(["--output=./reports"], { allowed: ["output"] }), {
    output: "./reports",
  });
  assert.deepEqual(parseRunnerArgs(["--output=.\\reports"], { allowed: ["output"] }), {
    output: ".\\reports",
  });
  assert.deepEqual(parseRunnerArgs(["--output= reports "], { allowed: ["output"] }), {
    output: "reports",
  });
});

test("direct CLI detection canonicalizes symlinked entry paths", () => {
  const modulePath = resolve("scripts/cep-functional-smoke.mjs");
  const moduleUrl = pathToFileURL(modulePath).href;
  assert.equal(
    isDirectCliInvocation(moduleUrl, "/alias/scripts/cep-functional-smoke.mjs", {
      realpathFn: (path) => path.startsWith("/alias/")
        ? path.replace("/alias", process.cwd())
        : path,
    }),
    true
  );
});

test("rejected output roots perform zero filesystem mutation", async () => {
  const calls = [];
  const fs = new Proxy({}, { get: () => (...args) => { calls.push(args); } });
  await expectReject(
    createOwnedRunDirectory("../escape", { cwd: "/workspace", fs }),
    /traversal/
  );
  assert.deepEqual(calls, []);
});

test("runner output validation rejects direct and nested symlink escapes before mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "chroma-relay-output-validation-"));
  const repo = join(root, "repo");
  const outside = join(root, "outside");
  await mkdir(repo);
  await mkdir(outside);
  await symlink(outside, join(repo, "escape"));

  try {
    await expectReject(
      validateRunnerOutputRoot("escape", { cwd: repo }),
      /escapes through a symlink|symlink/
    );
    await expectReject(
      validateRunnerOutputRoot("escape/missing/nested", { cwd: repo }),
      /symlink/
    );
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("canonical CDP selection rejects foreign same-suffix pages before client mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "chroma-relay-canonical-cdp-"));
  const canonical = join(root, "repo", "dist", "cep", "main", "index.html");
  const foreign = join(root, "foreign", "main", "index.html");
  const alias = join(root, "installed", "main", "index.html");
  const target = (path, suffix = "") => ({
    type: "page",
    url: `${pathToFileURL(path).href}${suffix}`,
    webSocketDebuggerUrl: "ws://canonical",
  });

  try {
    await mkdir(dirname(canonical), { recursive: true });
    await mkdir(dirname(foreign), { recursive: true });
    await mkdir(dirname(alias), { recursive: true });
    await writeFile(canonical, "canonical\n");
    await writeFile(foreign, "foreign\n");
    await rm(alias, { force: true });
    await symlink(canonical, alias);

    const canonicalTarget = target(canonical);
    const aliasTarget = target(alias);
    assert.equal(
      await selectCanonicalCdpTarget([canonicalTarget], canonical, { label: "Main" }),
      canonicalTarget
    );
    assert.equal(
      await selectCanonicalCdpTarget([aliasTarget], canonical, { label: "Main" }),
      aliasTarget
    );
    await assert.doesNotReject(
      assertCanonicalRuntimeUrl(aliasTarget.url, canonical, { label: "connected Main" })
    );
    await assert.rejects(
      assertCanonicalRuntimeUrl(target(foreign).url, canonical, { label: "connected Main" }),
      /does not resolve to the canonical runtime/
    );
    await assert.rejects(
      assertCanonicalRuntimeUrl(target(canonical, "?debug=1").url, canonical),
      /does not resolve to the canonical runtime/
    );
    await assert.rejects(
      selectCanonicalCdpTarget([target(foreign)], canonical, { label: "Main" }),
      /exactly one canonical target; found 0/
    );
    await assert.rejects(
      selectCanonicalCdpTarget([target(canonical, "?debug=1")], canonical, { label: "Main" }),
      /found 0/
    );
    await assert.rejects(
      selectCanonicalCdpTarget([target(canonical, "#")], canonical, { label: "Main" }),
      /found 0/
    );
    await assert.rejects(
      selectCanonicalCdpTarget([canonicalTarget, aliasTarget], canonical, { label: "Main" }),
      /found 2/
    );
    await assert.rejects(
      selectCanonicalCdpTarget(
        [{ ...canonicalTarget, webSocketDebuggerUrl: "" }],
        canonical,
        { label: "Main" }
      ),
      /no WebSocket debugger URL/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("config restoration requires settled authoritative readback", async () => {
  const calls = [];
  let renderedRoot = "/scratch";
  let pendingRoot = renderedRoot;
  const setRoot = async (root) => {
    calls.push(["set", root]);
    pendingRoot = root;
  };
  const settle = async () => {
    calls.push(["settle"]);
    renderedRoot = pendingRoot;
  };
  const readRoot = async () => {
    calls.push(["read", renderedRoot]);
    return renderedRoot;
  };
  assert.equal(
    await restoreConfigRootWithReadback({
      expectedRoot: null,
      setRoot,
      settle,
      readRoot,
      label: "test config",
    }),
    null
  );
  assert.deepEqual(calls, [["set", null], ["settle"], ["read", null]]);
  await assert.rejects(
    restoreConfigRootWithReadback({
      expectedRoot: "/baseline",
      setRoot: async () => undefined,
      settle: async () => undefined,
      readRoot: async () => "/scratch",
      label: "drifted config",
    }),
    /restoration readback mismatch/
  );
});

test("evaluation guard permanently quarantines a client after unknown completion", async () => {
  let calls = 0;
  const client = {
    send: async () => true,
    evaluate: async () => {
      calls += 1;
      if (calls === 2) throw new Error("request completion unknown");
      return calls;
    },
  };
  const guard = guardClientEvaluations(client, "contract client");
  assert.equal(await client.evaluate("first"), 1);
  assert.equal(guard.isCompletionKnown(), true);
  await assert.rejects(client.evaluate("second"), /completion unknown/);
  assert.equal(guard.status(), "unknown");
  await assert.rejects(client.evaluate("third"), /reentry refused/);
  assert.equal(calls, 2);
});

test("evaluation guard supports semantic quarantine after a renderer operation outlives CDP", async () => {
  const client = {
    evaluate: async () => true,
    send: async () => true,
  };
  const guard = guardClientEvaluations(client, "semantic fixture");
  assert.equal(await client.evaluate("1 + 1"), true);
  guard.quarantine();
  assert.equal(guard.isCompletionKnown(), false);
  assert.equal(guard.status(), "unknown");
  await assert.rejects(client.send("Page.reload"), /reentry refused while completion is unknown/);
});

test("operation guard quarantines direct CDP sends and refuses later restoration", async () => {
  let sendCalls = 0;
  const client = {
    send: async () => {
      sendCalls += 1;
      throw new Error("Page.reload timed out after dispatch");
    },
    evaluate: async () => true,
  };
  const guard = guardClientEvaluations(client, "send contract");
  await assert.rejects(client.send("Page.reload"), /timed out after dispatch/);
  assert.equal(guard.status(), "unknown");
  await assert.rejects(client.evaluate("restore config"), /reentry refused/);
  assert.equal(sendCalls, 1);
});

test("operation guard rejects a concurrent top-level send without breaking nested evaluation transport", async () => {
  let releaseEvaluation;
  const evaluationResult = new Promise((resolve) => { releaseEvaluation = resolve; });
  let sends = 0;
  const client = {
    send: async () => { sends += 1; return true; },
    evaluate: async () => evaluationResult,
  };
  const guard = guardClientEvaluations(client, "concurrency contract");
  const pendingEvaluation = client.evaluate("hold");
  await assert.rejects(client.send("Page.reload"), /reentry refused while completion is pending/);
  assert.equal(sends, 0);
  releaseEvaluation("done");
  assert.equal(await pendingEvaluation, "done");
  assert.equal(guard.status(), "ready");
  assert.equal(await client.send("Page.captureScreenshot"), true);
  assert.equal(sends, 1);

  const cdp = Object.create(CdpClient.prototype);
  const calls = [];
  cdp.sendForEvaluate = async (...args) => {
    calls.push(args);
    return { result: { value: 42 } };
  };
  assert.equal(await cdp.evaluate("6 * 7"), 42);
  assert.equal(calls[0][0], "Runtime.evaluate");
});

test("formal and diagnostic runners quarantine every post-enable CDP operation", async () => {
  for (const script of [
    "run-live-ae-tests.mjs",
    "diagnose-ae-selection-semantics.mjs",
    "diagnose-ae23-selection-restore.mjs",
  ]) {
    const source = await readFile(resolve("scripts", script), "utf8");
    assert.match(source, /guardClientEvaluations/);
    assert.match(source, /operationGuard\?\.isCompletionKnown\(\) !== false/);
  }
});

test("formal and functional runners quarantine semantic host-action timeouts", async () => {
  const [formal, functional] = await Promise.all([
    readFile(resolve("scripts/run-live-ae-tests.mjs"), "utf8"),
    readFile(resolve("scripts/cep-functional-smoke.mjs"), "utf8"),
  ]);
  assert.match(formal, /let hostActionCompletionKnown = true/);
  assert.equal(
    (formal.match(/hostActionCompletionKnown = false;\s*await triggerGradientAction\(client\)/g) || []).length,
    2
  );
  assert.equal(
    (formal.match(/hostActionCompletionKnown = true;\s*const (?:rendererReport|failureReport)/g) || []).length,
    2
  );
  assert.equal(
    (formal.match(/operationGuard\?\.isCompletionKnown\(\) !== false &&\s*hostActionCompletionKnown/g) || []).length,
    3
  );
  assert.match(formal, /productionRestoreRequired && finalizationCompletionKnown\(\)/);
  assert.match(formal, /completion became unknown before production rebuild; canonical build left untouched/);
  assert.match(formal, /host action completion is unknown; compensating cleanup refused/);
  assert.match(formal, /const waitForIdle = async \(client, operationGuard\)/);
  assert.match(formal, /operationGuard\?\.quarantine\(\);\s*fail\("Native-gradient application did not become idle/);
  assert.match(formal, /waitForIdle\(client, operationGuard\)/);
  assert.match(formal, /const waitForRuntime = async \(client, expectedUrl, expectedDebug, operationGuard\)/);
  assert.match(formal, /catch \(error\) \{\s*operationGuard\?\.quarantine\(\);\s*throw error;/);
  assert.match(formal, /FINALIZATION_DIAGNOSTICS/);
  assert.match(formal, /throwable\.cleanupErrors = \[\.\.\.existing, \.\.\.cleanupErrors\]/);
  assert.match(functional, /const dispatchHostActionAndWait = async/);
  assert.match(
    functional,
    /imageSelectionHostStateKnown = false;\s*const accepted = await client\.evaluate[^]*const state = await waitForHostIdle\(client, runtimeEvaluationGuard\);\s*imageSelectionHostStateKnown = true;/
  );
  assert.match(functional, /evaluationGuard\?\.quarantine\(\)/);
  assert.match(functional, /waitForStableDebug\(client, runtimeEvaluationGuard\)/);
});

test("every maintained reload readiness wait quarantines semantic timeout", async () => {
  const sources = await Promise.all(
    [
      "cep-cdp.mjs",
      "cep-design-capture.mjs",
      "cep-palette-management-smoke.mjs",
      "cep-native-gradient-collect-smoke.mjs",
    ].map((script) => readFile(resolve("scripts", script), "utf8")),
  );
  for (const source of sources) {
    assert.match(source, /completion quarantined/);
    assert.match(source, /(?:evaluationGuard|operationGuard)\?\.quarantine\(\)/);
  }
  assert.match(sources[0], /waitForComplete\(client, evaluationGuards\.get\(panel\.page\)\)/);
  assert.match(sources[1], /waitForComplete\(client, evaluationGuard\)/);
  assert.match(sources[2], /waitForDebug\(client, client\.evaluationGuard\)/);
  assert.match(sources[3], /waitForDebug\(client, operationGuard\)/);
});

test("absolute roots reject first-component POSIX symlinks and Windows junctions", async () => {
  for (const { pathApi, root, redirect } of [
    { pathApi: posix, root: "/redirect/owned", redirect: "/redirect" },
    { pathApi: win32, root: "C:\\redirect\\owned", redirect: "C:\\redirect" },
  ]) {
    const fs = {
      lstat: async (path) => {
        if (path === redirect) return { isSymbolicLink: () => true };
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
      realpath: async (path) => path,
    };
    await expectReject(
      rejectSymlinkComponentsForTest(root, fs, pathApi),
      /symlink/
    );
  }
});

test("absolute roots allow only verified macOS system temp aliases", async () => {
  const fs = {
    lstat: async (path) => {
      if (path === "/tmp") return { isSymbolicLink: () => true };
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    realpath: async (path) => path === "/tmp" ? "/private/tmp" : path,
  };
  await assert.doesNotReject(
    rejectSymlinkComponentsForTest("/tmp/chroma-relay", fs, posix)
  );
  await expectReject(
    rejectSymlinkComponentsForTest("/tmp/chroma-relay", {
      ...fs,
      realpath: async () => "/attacker-controlled-temp",
    }, posix),
    /symlink/
  );
});

test("temporary allocation canonicalizes only verified exact macOS temp aliases", async () => {
  const trustedFs = {
    lstat: async () => ({ isSymbolicLink: () => true }),
    realpath: async (path) => path === "/tmp" ? "/private/tmp" : path,
  };
  assert.equal(
    await canonicalizeTemporaryDirectoryForTest("/tmp", trustedFs, posix),
    "/private/tmp"
  );
  assert.equal(
    await canonicalizeTemporaryDirectoryForTest(
      "/private/tmp/chroma-relay-parent",
      trustedFs,
      posix
    ),
    "/private/tmp/chroma-relay-parent"
  );
  await expectReject(
    canonicalizeTemporaryDirectoryForTest(
      "/tmp",
      {
        ...trustedFs,
        realpath: async () => "/attacker-controlled-temp",
      },
      posix
    ),
    /symlink/
  );
});

test("owned run directories are exclusive and cleanup cannot remove the caller root", async () => {
  const root = await mkdtemp(join(tmpdir(), "chroma-relay-s4-"));
  const first = await createOwnedRunDirectory(root, {
    tokenFactory: () => "fixed-token",
  });
  const second = await createOwnedRunDirectory(root, {
    tokenFactory: () => "second-token",
  });
  assert.notEqual(first.path, second.path);
  const marker = JSON.parse(await readFile(first.markerPath, "utf8"));
  assert.equal(marker.kind, "chroma-relay-run");
  await removeOwnedRunDirectory(first);
  await assert.doesNotReject(() => readFile(second.markerPath, "utf8"));
  await expectReject(removeOwnedRunDirectory(root), /owned run directory/);
  await removeOwnedRunDirectory(second);
  await rm(root, { recursive: true, force: true });
});

test("owned cleanup gives transient Windows locks bounded native retries", async () => {
  const root = await mkdtemp(join(tmpdir(), "chroma-relay-s4-rm-retry-"));
  const run = await createOwnedRunDirectory(root, { tokenFactory: () => "rm-retry-token" });
  const calls = [];
  await removeOwnedRunDirectory(run, {
    fs: {
      lstat,
      realpath,
      readFile,
      rm: async (path, options) => {
        calls.push({ path, options });
        return rm(path, options);
      },
    },
  });
  assert.deepEqual(calls, [
    {
      path: run.path,
      options: { recursive: true, force: false, maxRetries: 10, retryDelay: 100 },
    },
  ]);
  await rm(root, { recursive: true, force: true });
});

test("owned cleanup recomputes the marker path and rejects forged, swapped, and stale identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "chroma-relay-s4-identity-"));
  const outside = await mkdtemp(join(tmpdir(), "chroma-relay-s4-outside-"));
  const run = await createOwnedRunDirectory(root, { tokenFactory: () => "identity-token" });
  await writeFile(join(outside, "sentinel"), "preserve\n");

  await assert.rejects(
    removeOwnedRunDirectory({ ...run, markerPath: join(outside, "sentinel") }),
    RunnerPolicyError
  );
  assert.equal(await readFile(run.markerPath, "utf8") !== "", true);

  const marker = JSON.parse(await readFile(run.markerPath, "utf8"));
  marker.child = `${run.path}-stale`;
  await writeFile(run.markerPath, `${JSON.stringify(marker)}\n`);
  await expectReject(removeOwnedRunDirectory(run), /marker/);
  marker.child = run.path;
  await writeFile(run.markerPath, `${JSON.stringify(marker)}\n`);

  await rm(run.path, { recursive: true, force: true });
  await symlink(outside, run.path);
  await expectReject(removeOwnedRunDirectory(run), /symlink|owned/);
  assert.equal(await readFile(join(outside, "sentinel"), "utf8"), "preserve\n");

  await rm(run.path, { force: true });
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

test("marker-write failure leaves residue and never calls recursive rm", async () => {
  const calls = [];
  const outputRoot = resolve(sep, "workspace", "out");
  const residuePath = join(outputRoot, "residue-token");
  const fs = {
    lstat: async (path) => {
      if (path === outputRoot) return { isDirectory: () => true, isSymbolicLink: () => false };
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    realpath: async (path) => path,
    mkdir: async (path, options) => calls.push(["mkdir", path, options]),
    writeFile: async () => { throw new Error("marker write failed"); },
    rm: async (...args) => calls.push(["rm", ...args]),
  };
  await assert.rejects(
    createOwnedRunDirectory(outputRoot, {
      fs,
      tokenFactory: () => "residue-token",
    }),
    (error) => {
      assert.equal(error.residuePath, residuePath);
      return true;
    }
  );
  assert.equal(calls.some(([name]) => name === "rm"), false);
});

test("owned cleanup rejects marker symlink swaps and root replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "chroma-relay-s4-replacement-"));
  const movedRoot = `${root}-moved`;
  const outside = await mkdtemp(join(tmpdir(), "chroma-relay-s4-marker-outside-"));
  const run = await createOwnedRunDirectory(root, { tokenFactory: () => "replacement-token" });
  const markerText = await readFile(run.markerPath, "utf8");
  const markerTarget = join(outside, "marker-target");
  await writeFile(markerTarget, "foreign\n");
  await rm(run.markerPath);
  await symlink(markerTarget, run.markerPath);
  await expectReject(removeOwnedRunDirectory(run), /marker/);
  await rm(run.markerPath);
  await writeFile(run.markerPath, markerText);

  await rename(root, movedRoot);
  await symlink(movedRoot, root);
  await expectReject(removeOwnedRunDirectory(run), /root|symlink/);

  await rm(root, { force: true });
  await rm(movedRoot, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

test("scratch children are marked, exclusive, and removable without removing the caller root", async () => {
  const root = await mkdtemp(join(tmpdir(), "chroma-relay-s4-scratch-"));
  const run = await createOwnedRunDirectory(root, { tokenFactory: () => "parent-token" });
  const scratch = await createOwnedScratchDirectory(run, { tokenFactory: () => "scratch-token" });
  const marker = JSON.parse(await readFile(scratch.markerPath, "utf8"));
  assert.equal(marker.root, await realpath(run.path));
  assert.equal(marker.child, await realpath(scratch.path));
  await removeOwnedRunDirectory(scratch);
  await assert.doesNotReject(() => readFile(run.markerPath, "utf8"));
  await removeOwnedRunDirectory(run);
  await rm(root, { recursive: true, force: true });
});

test("foreign, stale, fixed, and symlink-escaping roots are rejected before mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "chroma-relay-s4-"));
  await writeFile(join(root, ".chroma-relay-run.json"), JSON.stringify({ kind: "foreign" }));
  await expectReject(createOwnedRunDirectory(root), /foreign/);

  const stale = await mkdtemp(join(tmpdir(), "chroma-relay-stale-"));
  await writeFile(
    join(stale, ".chroma-relay-run.json"),
    JSON.stringify({ kind: "chroma-relay-run", schema: 999 })
  );
  await expectReject(createOwnedRunDirectory(stale), /stale/);

  const fixed = await mkdtemp(join(tmpdir(), "chroma-relay-fixed-"));
  await expectReject(createOwnedRunDirectory(fixed, { fixedRoots: [fixed] }), /fixed/);

  const outside = await mkdtemp(join(tmpdir(), "chroma-relay-outside-"));
  const parent = await mkdtemp(join(tmpdir(), "chroma-relay-parent-"));
  await symlink(outside, join(parent, "escape"));
  await expectReject(createOwnedRunDirectory(join(parent, "escape", "child")), /symlink/);
  await rm(root, { recursive: true, force: true });
  await rm(stale, { recursive: true, force: true });
  await rm(fixed, { recursive: true, force: true });
  await rm(parent, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

class FakeSocket {
  static instances = [];
  constructor({ closeMode = "event" } = {}) {
    this.listeners = new Map();
    this.sent = [];
    this.readyState = 0;
    this.closeMode = closeMode;
    this.onceOptions = [];
    this.closeCalls = 0;
    this.terminateCalls = 0;
    FakeSocket.instances.push(this);
  }
  addEventListener(name, fn, options) {
    const list = this.listeners.get(name) || [];
    list.push({ fn, once: options?.once === true });
    this.listeners.set(name, list);
    if (options?.once === true) this.onceOptions.push(name);
  }
  removeEventListener(name, fn) {
    this.listeners.set(name, (this.listeners.get(name) || []).filter((entry) => entry.fn !== fn));
  }
  listenerCount(name) { return (this.listeners.get(name) || []).length; }
  emit(name, value = {}) {
    const list = [...(this.listeners.get(name) || [])];
    for (const entry of list) {
      if (entry.once) this.removeEventListener(name, entry.fn);
      entry.fn(value);
    }
  }
  send(value) { this.sent.push(JSON.parse(value)); }
  close() {
    this.closeCalls += 1;
    if (this.closeMode === "event") {
      this.readyState = 3;
      this.emit("close", {});
    }
  }
  terminate() {
    this.terminateCalls += 1;
    this.readyState = 3;
    this.emit("close", {});
  }
}

const connectedClient = async (timeoutMs = 30) => {
  const client = new CdpClient("ws://fake", { WebSocket: FakeSocket, timeoutMs });
  const connecting = client.connect();
  const socket = FakeSocket.instances.at(-1);
  socket.readyState = 1;
  socket.emit("open", {});
  await connecting;
  return { client, socket };
};

test("CDP malformed, close/error, timeout, duplicate/late results, and cleanup settle pending calls", async () => {
  const { client, socket } = await connectedClient();
  const malformed = client.send("One");
  const second = client.send("Two");
  socket.emit("message", { data: "{" });
  await expectReject(malformed, /Malformed CDP message/);
  await expectReject(second, /Malformed CDP message/);
  assert.equal(client.pending.size, 0);

  const response = client.send("Three");
  const id = socket.sent.at(-1).id;
  socket.emit("message", { data: JSON.stringify({ id, result: { ok: true } }) });
  assert.deepEqual(await response, { ok: true });
  socket.emit("message", { data: JSON.stringify({ id, result: { late: true } }) });
  assert.equal(client.pending.size, 0);

  const errorPending = client.send("Error");
  socket.emit("error", {});
  await expectReject(errorPending, /socket error/);
  assert.equal(client.pending.size, 0);

  const closePending = client.send("Four");
  socket.emit("close", {});
  await expectReject(closePending, /closed/);
  assert.equal(client.pending.size, 0);

  const timeoutClient = await connectedClient(5);
  const timeout = timeoutClient.client.send("Timeout");
  await expectReject(timeout, /timed out/);
  assert.equal(timeoutClient.client.pending.size, 0);
  await timeoutClient.client.close();
});

test("CDP connect rejects exactly once and removes listeners when it closes or errors before open", async () => {
  for (const event of ["close", "error"]) {
    const client = new CdpClient("ws://fake", { WebSocket: FakeSocket, timeoutMs: 30 });
    const connecting = client.connect();
    const socket = FakeSocket.instances.at(-1);
    socket.emit(event, {});
    await assert.rejects(connecting, /Unable to connect|closed|error/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(socket.listenerCount("open"), 0);
    assert.equal(socket.listenerCount("close"), 0);
    assert.equal(socket.listenerCount("error"), 0);
    assert.equal(socket.listenerCount("message"), 0);
  }
});

test("CDP refuses an active ID before mutating pending state and ignores late responses", async () => {
  const { client, socket } = await connectedClient();
  const first = client.send("First");
  const activeId = socket.sent.at(-1).id;
  client.nextId = activeId;
  await assert.rejects(client.send("Duplicate"), /duplicate.*id/i);
  assert.equal(client.pending.size, 1);
  socket.emit("message", { data: JSON.stringify({ id: activeId, result: "first" }) });
  assert.equal(await first, "first");
  const second = client.send("Second");
  const secondId = socket.sent.at(-1).id;
  socket.emit("message", { data: JSON.stringify({ id: activeId, result: "late" }) });
  assert.equal(client.pending.size, 1);
  socket.emit("message", { data: JSON.stringify({ id: secondId, result: "second" }) });
  assert.equal(await second, "second");
  await client.close();
});

test("CDP close timeout/error rejects, terminates, removes listeners, and is idempotent", async () => {
  const timeoutConnected = await connectedClient();
  timeoutConnected.socket.closeMode = "silent";
  const pending = timeoutConnected.client.send("Pending");
  const close = timeoutConnected.client.close(5);
  assert.strictEqual(close, timeoutConnected.client.close(5));
  await assert.rejects(pending, /closed/);
  await assert.rejects(close, /timed out/);
  assert.equal(timeoutConnected.client.pending.size, 0);
  assert.equal(timeoutConnected.socket.terminateCalls, 1);
  assert.equal(timeoutConnected.socket.listenerCount("message"), 0);
  assert.equal(timeoutConnected.socket.listenerCount("close"), 0);
  assert.equal(timeoutConnected.socket.listenerCount("error"), 0);

  const errorConnected = await connectedClient();
  errorConnected.socket.closeMode = "silent";
  const errorClose = errorConnected.client.close(30);
  errorConnected.socket.emit("error", new Error("close boom"));
  await assert.rejects(errorClose, /close boom|failed during close/);
  assert.equal(errorConnected.client.pending.size, 0);
  assert.equal(errorConnected.socket.listenerCount("message"), 0);
  assert.equal(errorConnected.socket.listenerCount("close"), 0);
});

test("CDP clears every injected request and close timer on settlement", async () => {
  const activeTimers = new Set();
  const timerClient = new CdpClient("ws://fake", {
    WebSocket: FakeSocket,
    timeoutMs: 5,
    setTimeoutFn: (handler, milliseconds) => {
      const timer = setTimeout(() => {
        activeTimers.delete(timer);
        handler();
      }, milliseconds);
      activeTimers.add(timer);
      return timer;
    },
    clearTimeoutFn: (timer) => {
      activeTimers.delete(timer);
      clearTimeout(timer);
    },
  });
  const connecting = timerClient.connect();
  const socket = FakeSocket.instances.at(-1);
  socket.readyState = 1;
  socket.emit("open", {});
  await connecting;
  const request = timerClient.send("Settled");
  const requestId = socket.sent.at(-1).id;
  assert.equal(activeTimers.size, 1);
  socket.emit("message", { data: JSON.stringify({ id: requestId, result: true }) });
  assert.equal(await request, true);
  assert.equal(activeTimers.size, 0);
  const close = timerClient.close(30);
  assert.equal(activeTimers.size, 0);
  await close;
  assert.equal(activeTimers.size, 0);
});

test("owned runners do not recursively remove fixed scratch roots and await async close", async () => {
  for (const file of [
    "cep-native-gradient-collect-smoke.mjs",
    "cep-cdp.mjs",
    "cep-design-capture.mjs",
    "cep-functional-smoke.mjs",
    "cep-persistence-smoke.mjs",
    "cep-palette-management-smoke.mjs",
  ]) {
    const source = await readFile(new URL(`../scripts/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /rm\([^\n]*\{\s*recursive:\s*true/);
    assert.doesNotMatch(source, /(?<!await\s)\bclient\.close\(\)/);
    if (file === "cep-design-capture.mjs") {
      assert.match(source, /tmpdir\(\)/);
      assert.match(source, /resolveTemporaryConfigParent/);
      assert.match(source, /createOwnedRunDirectory\(temporaryConfigParent/);
      assert.doesNotMatch(source, /"\/private\/tmp"/);
      assert.match(source, /chroma-relay-design-/);
      assert.doesNotMatch(source, /createOwnedScratchDirectory\(parentRun\)/);
    } else {
      assert.match(source, /createOwnedTemporaryConfigDirectory/);
      assert.doesNotMatch(source, /createOwnedScratchDirectory\(parentRun\)/);
    }
    assert.match(source, /removeOwnedRunDirectory/);
  }
});

test("all five runners are importable without invoking their CLI", async () => {
  for (const file of [
    "cep-native-gradient-collect-smoke.mjs",
    "cep-cdp.mjs",
    "cep-design-capture.mjs",
    "cep-persistence-smoke.mjs",
    "cep-palette-management-smoke.mjs",
  ]) {
    await assert.doesNotReject(import(`../scripts/${file}?s4=${Date.now()}-${file}`));
  }
});

test("design capture canonicalizes an OS-provided temporary directory", async () => {
  const design = await import("../scripts/cep-design-capture.mjs?s4-portable-temp");
  const windowsTemp = "C:\\Users\\runner\\AppData\\Local\\Temp";
  const canonical = "C:\\Users\\runner\\AppData\\Local\\Temp\\canonical";
  assert.equal(
    await design.resolveTemporaryConfigParent({
      temporaryDirectory: windowsTemp,
      fs: { realpath: async (path) => path === windowsTemp ? canonical : path },
    }),
    canonical
  );
});

test("debug config roots accept direct children of canonical macOS temp only", async () => {
  const { normalizeTemporaryConfigRoot } = await import("../src/js/shared/debug-api.ts");
  const root = "/private/var/folders/qj/session-hash/T/chroma-relay-design-main-run";
  assert.equal(normalizeTemporaryConfigRoot(root), root);
  assert.throws(
    () => normalizeTemporaryConfigRoot(
      "/private/var/folders/qj/session-hash/T/nested/chroma-relay-design-main-run",
    ),
    /supported macOS or Windows temp directory/,
  );
  for (const traversal of [
    "/private/var/folders/../../T/chroma-relay-design-main-run",
    "/private/var/folders/qj/./T/chroma-relay-design-main-run",
  ]) {
    assert.throws(
      () => normalizeTemporaryConfigRoot(traversal),
      /supported macOS or Windows temp directory/,
    );
  }
});

test("owned temporary config directories are direct chroma-relay children of the OS temp root", async () => {
  const run = await createOwnedTemporaryConfigDirectory();
  try {
    const canonicalRoot = await realpath(tmpdir());
    const canonicalChild = await realpath(run.path);
    assert.equal(dirname(canonicalChild), canonicalRoot);
    assert.match(canonicalChild.split(sep).at(-1), /^chroma-relay-/);
    const { normalizeTemporaryConfigRoot } = await import("../src/js/shared/debug-api.ts");
    assert.equal(normalizeTemporaryConfigRoot(canonicalChild), canonicalChild);
  } finally {
    await removeOwnedRunDirectory(run);
  }
});

test("CDP selectors normalize Windows paths and inject flyout IDs into browser source", async () => {
  const { createSettingsFlyoutProbeSource, pathMatchesPageSuffix } = await import(
    "../scripts/cep-cdp.mjs?s4-windows-targets"
  );
  assert.equal(
    pathMatchesPageSuffix("C:\\Build\\dist\\cep\\main\\index.html", "/main/index.html"),
    true,
  );
  assert.equal(
    pathMatchesPageSuffix("C:\\Build\\dist\\cep\\settings\\index.html", "/main/index.html"),
    false,
  );
  const source = createSettingsFlyoutProbeSource("com.example.settings");
  assert.match(source, /extensionId:\s*"com\.example\.settings"/);
  assert.doesNotMatch(source, /contract\./);
});

test("functional smoke reads current palette documents and wrapped color-selection results", async () => {
  const functional = await import("../scripts/cep-functional-smoke.mjs?s4-current-contracts");
  const colors = [{ id: "current", rgba: [1, 0, 0, 1] }];
  assert.equal(
    functional.activePaletteItems({
      activePaletteId: "active",
      palettes: [
        { id: "other", colors: [] },
        { id: "active", colors },
      ],
    }),
    colors,
  );
  assert.deepEqual(functional.activePaletteItems({ colors }), colors);
  const selection = { status: "ok", colors: [[1, 0, 0, 1]] };
  assert.equal(functional.colorSelectionResult({ selection: { colors: selection }, gradients: [] }), selection);
  assert.equal(functional.colorSelectionResult(selection), selection);

  const source = await readFile(
    new URL("../scripts/cep-functional-smoke.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /data-testid=remove-[a-z]/);
  assert.doesNotMatch(source, /new CDPClient\(/);
  assert.match(source, /new CdpClient\(/);
  assert.match(source, /new MouseEvent\("click", \{ altKey: true/);
  assert.match(source, /key: "Enter"[\s\S]*altKey: true/);
  assert.match(source, /mode === "image-selection" \|\| mode === "image"/);
  assert.match(source, /requires an empty clean unsaved project/);
  assert.match(source, /evalImageHost\(importSelectedImageSource\(fixture\)\)/);
  assert.doesNotMatch(source, /evalImageHost\(removeProjectItemSource\(imported\.id\)\)/);
  assert.match(source, /app\.project\.save\(archive\)/);
  assert.match(source, /var closed = app\.project\.close\(CloseOptions\.SAVE_CHANGES\)/);
  assert.match(source, /if \(closed !== true\)/);
  assert.match(source, /__CHROMA_FUNCTIONAL_PROJECT__ !== app\.project/);
  assert.match(source, /foreign-project-claim-present/);
  assert.match(source, /cleanupImageSelectionFixturesSource\(\s*runId,\s*imageSelectionOwnedItems,\s*imageSelectionOwnedTopology/);
  assert.match(source, /deferredToProjectArchive: true/);
  assert.match(source, /imageSelectionCleanupRequired && !imageSelectionProjectResetRequired/);
  assert.doesNotMatch(source, /\n\s*imageSelectionCleanupRequired = false;/);
  assert.match(source, /owned-item-topology-mismatch/);
  assert.match(source, /captureNewOwnedTopology/);
  assert.match(source, /snapshotProperty\(property\.property\(childIndex\)\)/);
  assert.match(source, /item\.id === owned\[ownedIndex\]\.id/);
  assert.doesNotMatch(source, /owned\[item\.name\]/);
  assert.match(source, /fixture-setup-failed/);
  assert.doesNotMatch(source, /_compCleanupError|_itemCleanupError/);
  assert.doesNotMatch(source, /try \{ if \(imported\) imported\.remove\(\); \}/);
  assert.match(source, /residualItems: residualItems/);
  assert.match(source, /recordResidualItems\(colorFixture\)/);
  assert.match(source, /recordResidualItems\(layerFixture\)/);
  assert.match(source, /imageSelectionHostStateKnown = false;\s*const result = await evalHost/);
  assert.match(
    source,
    /configMutationAttempted = true;\s*imageSelectionHostStateKnown = false;[^]*temporaryIdentity\.configRoot !== temporaryRoot[^]*imageSelectionHostStateKnown = true;/
  );
  assert.match(source, /runtimeEvaluationGuard = guardClientEvaluations\(client, "functional smoke Main"\)/);
  assert.match(source, /imageSelectionHostStateKnown = false;\s*const accepted = await client\.evaluate/);
  assert.match(source, /const state = await waitForHostIdle\(client, runtimeEvaluationGuard\);\s*imageSelectionHostStateKnown = true/);
  assert.match(source, /waitForMutationRevision\(client, 1, runtimeEvaluationGuard\)/);
  assert.match(source, /evaluationGuard\?\.quarantine\(\)/);
  assert.match(source, /const applyAction = await dispatchHostActionAndWait/);
  assert.match(source, /const collectionAction = await dispatchHostActionAndWait/);
  assert.match(source, /!imageSelectionHostStateKnown \|\| !runtimeEvaluationCompletionKnown\(\)/);
  assert.doesNotMatch(source, /if \(imported\?\.id && imageSelectionHostStateKnown/);
  assert.doesNotMatch(source, /imageOperationError/);
  assert.match(source, /host completion is unknown; project reset refused/);
  assert.doesNotMatch(source, /if \(imageSelectionProjectResetError\) throw imageSelectionProjectResetError/);
  assert.match(source, /finalizeFunctionalSmoke\(\{/);
  const setupSource = await readFile(
    new URL("../scripts/ae-i07-i08-setup.jsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(setupSource, /comp\.remove\(\)/);
  const paletteManagementSource = await readFile(
    new URL("../scripts/cep-palette-management-smoke.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    paletteManagementSource,
    /for \(const client of clients\) client\.evaluationGuard\?\.quarantine\(\)/,
  );
  assert.match(
    paletteManagementSource,
    /const waitFor = async \(predicate, label, evaluationGuard\)[^]*evaluationGuard\?\.quarantine\(\)/,
  );
  assert.match(
    paletteManagementSource,
    /"export file",\s*settings\.evaluationGuard/,
  );
});

test("functional smoke production paths satisfy AST-backed closed-world mutation contracts", async () => {
  const functionalSource = await readFile(
    new URL("../scripts/cep-functional-smoke.mjs", import.meta.url),
    "utf8",
  );
  assert.deepEqual(analyzeFunctionalSmokeClosedWorld(functionalSource), []);
  const lfFunctionalSource = functionalSource.replaceAll("\r\n", "\n");
  assert.deepEqual(
    analyzeFunctionalSmokeClosedWorld(lfFunctionalSource.replaceAll("\n", "\r\n")),
    [],
  );

  const afterValidCopy = (insertion) => functionalSource.replace(
    "      await writeFile(corruptPath, pngBytes);",
    `      await writeFile(corruptPath, pngBytes);\n${insertion}`,
  );
  for (const [label, mutated] of [
    [
      "direct writer",
      afterValidCopy('      await writeFile(corruptPath, Buffer.from("not a valid PNG"));'),
    ],
    [
      "aliased writer",
      afterValidCopy(
        '      const corruptAlias = corruptPath;\n      await writeFile(corruptAlias, "not a valid PNG");',
      ),
    ],
    ["helper wrapped", afterValidCopy("      await mutateCorruptFixture(corruptPath);")],
    ["alternate writer", afterValidCopy('      await appendFile(corruptPath, "damage");')],
    ["Buffer consumer", afterValidCopy("      Buffer.from(corruptPath);")],
  ]) {
    assert.match(
      analyzeFunctionalSmokeClosedWorld(mutated).join("\n"),
      /production-corruptPath/,
      label,
    );
  }
  const helperBypass = functionalSource.replace(
    "    await writeSource(corruptPath, corruptBytes);",
    '    await writeFile(corruptPath, Buffer.from("helper bypass"));\n    await writeSource(corruptPath, corruptBytes);',
  );
  assert.match(
    analyzeFunctionalSmokeClosedWorld(helperBypass).join("\n"),
    /helper-corruptPath/,
    "corrupt helper internals must remain separately closed",
  );

  const assertBindingMutationRejected = (label, mutated, policy = /binding|shadow/) => {
    const parsed = ts.createSourceFile(
      `${label}.mjs`,
      mutated,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    assert.equal(parsed.parseDiagnostics.length, 0, `${label} must be syntactically valid`);
    let errors;
    assert.doesNotThrow(() => {
      errors = analyzeFunctionalSmokeClosedWorld(mutated);
    }, `${label} must return causal analyzer errors rather than throw`);
    assert.match(errors.join("\n"), policy, label);
  };
  const beforeCorruptLifecycle = (insertion) => functionalSource.replace(
    "      const corruptLifecycle = await runCorruptImageSelectionCase({",
    `${insertion}\n      const corruptLifecycle = await runCorruptImageSelectionCase({`,
  );

  const exactCorruptHelperParameter = `export const runCorruptImageSelectionCase = async ({
  corruptPath,
  validBytes,
  corruptBytes = Buffer.from("not a valid PNG"),
  runProductCase,
  validateProductResult,
  hasRestoreAuthority,
  diagnosticState = createFunctionalSmokeDiagnosticState(),
  onRestoreVerified = async () => undefined,
  writeSource = writeFile,
  readSource = readFile,
}) => {`;
  const mutateCorruptHelperParameter = (replacement) => {
    assert.ok(functionalSource.includes(exactCorruptHelperParameter));
    return functionalSource.replace(exactCorruptHelperParameter, replacement);
  };
  const corruptHelperDefaultAndTopologyMutations = [
    [
      "no-op write default",
      exactCorruptHelperParameter.replace(
        "writeSource = writeFile",
        "writeSource = async () => undefined",
      ),
    ],
    [
      "forged read default",
      exactCorruptHelperParameter.replace(
        "readSource = readFile",
        "readSource = async () => Buffer.from(validBytes)",
      ),
    ],
    [
      "valid bytes replace corrupt default",
      exactCorruptHelperParameter.replace(
        'corruptBytes = Buffer.from("not a valid PNG")',
        "corruptBytes = validBytes",
      ),
    ],
    [
      "foreign diagnostic state default",
      exactCorruptHelperParameter.replace(
        "diagnosticState = createFunctionalSmokeDiagnosticState()",
        "diagnosticState = ({ cleanupErrors: [], evidenceWriteErrors: [] })",
      ),
    ],
    [
      "permissive diagnostic state default",
      exactCorruptHelperParameter.replace(
        "diagnosticState = createFunctionalSmokeDiagnosticState()",
        "diagnosticState = createFunctionalSmokeDiagnosticState() || {}",
      ),
    ],
    [
      "throwing restore callback default",
      exactCorruptHelperParameter.replace(
        "onRestoreVerified = async () => undefined",
        'onRestoreVerified = async () => { throw new Error("forged restore"); }',
      ),
    ],
    [
      "aliased parameter",
      exactCorruptHelperParameter.replace("  corruptPath,", "  corruptPath: watchedPath,"),
    ],
    [
      "nested destructuring parameter",
      exactCorruptHelperParameter.replace("  validBytes,", "  validBytes: { length },"),
    ],
    [
      "rest parameter element",
      exactCorruptHelperParameter.replace("  readSource = readFile,", "  ...rest,"),
    ],
    [
      "extra parameter element",
      exactCorruptHelperParameter.replace("  readSource = readFile,", "  readSource = readFile,\n  extra,"),
    ],
    [
      "reordered parameter elements",
      exactCorruptHelperParameter
        .replace("  corruptPath,\n  validBytes,", "  validBytes,\n  corruptPath,"),
    ],
    [
      "missing parameter element",
      exactCorruptHelperParameter.replace("  validateProductResult,\n", ""),
    ],
    [
      "second function parameter",
      exactCorruptHelperParameter.replace("}) => {", "}, options) => {"),
    ],
  ];
  for (const [label, replacement] of corruptHelperDefaultAndTopologyMutations) {
    assertBindingMutationRejected(
      label,
      mutateCorruptHelperParameter(replacement),
      /corrupt-helper-parameter-shape/,
    );
  }

  const inCorruptHelperBody = (insertion) => functionalSource.replace(
    "  const expectedBytes = Buffer.from(validBytes);",
    `${insertion}\n  const expectedBytes = Buffer.from(validBytes);`,
  );
  for (const [name, replacement, policy] of [
    ["corruptPath", '  corruptPath = "/forged/corrupt.png";', /helper-corruptPath/],
    ["validBytes", '  validBytes = Buffer.from("forged valid");', /helper-validBytes-use/],
    ["corruptBytes", "  corruptBytes = validBytes;", /helper-corruptBytes-use/],
    ["runProductCase", "  runProductCase = async () => undefined;", /helper-runProductCase-use/],
    [
      "validateProductResult",
      "  validateProductResult = async () => undefined;",
      /helper-validateProductResult-use/,
    ],
    ["hasRestoreAuthority", "  hasRestoreAuthority = () => true;", /helper-hasRestoreAuthority-use/],
    [
      "diagnosticState",
      "  diagnosticState = createFunctionalSmokeDiagnosticState();",
      /helper-diagnosticState-use/,
    ],
    ["onRestoreVerified", "  onRestoreVerified = async () => undefined;", /helper-onRestoreVerified-use/],
    ["writeSource", "  writeSource = async () => undefined;", /helper-writeSource-use/],
    ["readSource", "  readSource = async () => Buffer.from(validBytes);", /helper-readSource-use/],
  ]) {
    assertBindingMutationRejected(
      `${name} same-binding reassignment`,
      inCorruptHelperBody(replacement),
      policy,
    );
    assertBindingMutationRejected(
      `${name} alias`,
      inCorruptHelperBody(`  const ${name}Alias = ${name};`),
      policy,
    );
  }
  assertBindingMutationRejected(
    "corruptPath update expression",
    inCorruptHelperBody("  corruptPath++;"),
    /helper-corruptPath/,
  );
  for (const [label, insertion, policy] of [
    [
      "direct helper eval authority forgery",
      '  eval("hasRestoreAuthority = () => true");',
      /helper-dynamic-execution/,
    ],
    [
      "element-access helper eval authority forgery",
      '  globalThis["eval"]("hasRestoreAuthority = () => true");',
      /helper-dynamic-execution/,
    ],
    [
      "dynamic Function constructor",
      '  Function("return true")();',
      /helper-dynamic-execution/,
    ],
    [
      "computed constructor chain",
      '  ({})["con" + "structor"]["con" + "structor"]("return true")();',
      /helper-dynamic-execution/,
    ],
    [
      "template eval access",
      '  globalThis[`eval`]("hasRestoreAuthority = () => true");',
      /helper-dynamic-execution/,
    ],
    [
      "unknown computed callable key",
      '  const dynamicKey = "eval";\n  globalThis[dynamicKey]("hasRestoreAuthority = () => true");',
      /helper-dynamic-execution/,
    ],
  ]) {
    assertBindingMutationRejected(label, inCorruptHelperBody(insertion), policy);
  }
  for (const [label, insertion] of [
    ["Buffer.from method replacement", "  Buffer.from = () => Buffer.alloc(0);"],
    ["Buffer.from element replacement", '  Buffer["from"] = () => Buffer.alloc(0);'],
    ["Buffer.from alias", "  const forgedBufferFrom = Buffer.from;"],
    [
      "Buffer.from descriptor replacement",
      '  Object.defineProperty(Buffer, "from", { value: () => Buffer.alloc(0) });',
    ],
  ]) {
    assertBindingMutationRejected(
      label,
      inCorruptHelperBody(insertion),
      /Buffer-use-authority/,
    );
  }

  for (const [label, insertion] of [
    [
      "mutable forged expected bytes",
      '  let expectedBytes = Buffer.from(validBytes);\n  expectedBytes = Buffer.from("forged restoration bytes");',
    ],
    ["expected bytes alias", "  const expectedBytes = Buffer.from(validBytes);\n  const expectedAlias = expectedBytes;"],
    ["expected bytes update", "  const expectedBytes = Buffer.from(validBytes);\n  expectedBytes++;"],
    [
      "expected bytes destructuring target",
      "  const expectedBytes = Buffer.from(validBytes);\n  ({ expectedBytes } = replacement);",
    ],
    [
      "expected bytes extra use",
      "  const expectedBytes = Buffer.from(validBytes);\n  Buffer.from(expectedBytes);",
    ],
  ]) {
    assertBindingMutationRejected(
      label,
      functionalSource.replace("  const expectedBytes = Buffer.from(validBytes);", insertion),
      /expectedBytes-(?:provenance|use)|expectedBytes-.*expected-/,
    );
  }

  for (const [label, insertion, policy] of [
    [
      "direct run eval authority forgery",
      '      eval("runtimeEvaluationGuard = { isCompletionKnown: () => true }");',
      /production-dynamic-execution/,
    ],
    [
      "element-access run eval authority forgery",
      '      globalThis["eval"]("imageSelectionHostStateKnown = true");',
      /production-dynamic-execution/,
    ],
    [
      "computed run constructor evaluator replacement",
      '      ({})["con" + "structor"]["con" + "structor"]("client", "client.evaluate = client.sendForEvaluate")(client);',
      /production-dynamic-execution/,
    ],
    [
      "template run eval authority forgery",
      '      globalThis[`eval`]("runtimeEvaluationGuard = { isCompletionKnown: () => true }");',
      /production-dynamic-execution/,
    ],
    [
      "runtime guard forged reassignment",
      "      runtimeEvaluationGuard = { isCompletionKnown: () => true };",
      /runtimeEvaluationGuard-use/,
    ],
    [
      "runtime guard duplicate authenticated install",
      '      runtimeEvaluationGuard = guardClientEvaluations(client, "functional smoke Main");',
      /runtimeEvaluationGuard-install:expected-1:actual-2/,
    ],
    [
      "runtime guard alias",
      "      const runtimeGuardAlias = runtimeEvaluationGuard;",
      /runtimeEvaluationGuard-use/,
    ],
    [
      "host-state forged reassignment",
      "      imageSelectionHostStateKnown = true;",
      /imageSelectionHostStateKnown-use|host-state-/,
    ],
    [
      "host-state alias",
      "      const hostStateAlias = imageSelectionHostStateKnown;",
      /imageSelectionHostStateKnown-use/,
    ],
    [
      "run diagnostic-state reassignment",
      "      diagnosticState = createFunctionalSmokeDiagnosticState();",
      /production-diagnosticState-use/,
    ],
    [
      "run diagnostic-state alias",
      "      const diagnosticAlias = diagnosticState;",
      /production-diagnosticState-use/,
    ],
  ]) {
    assertBindingMutationRejected(label, beforeCorruptLifecycle(insertion), policy);
  }
  for (const [label, mutated] of [
    [
      "Reflect prototype constructor recovery backstop",
      beforeCorruptLifecycle(
        '      Reflect.get(Object.getPrototypeOf(() => undefined), "constructor")("client", "client.evaluate = client.sendForEvaluate")(client);',
      ),
    ],
    [
      "guarded client capability reassignment backstop",
      beforeCorruptLifecycle("      client.evaluate = client.sendForEvaluate;"),
    ],
    [
      "guarded client numeric-element escape backstop",
      beforeCorruptLifecycle("      client.evaluate = [client.sendForEvaluate][0];"),
    ],
    [
      "global Buffer alias mutation backstop",
      inCorruptHelperBody("  globalThis.Buffer.from = () => globalThis.Buffer.alloc(0);"),
    ],
    [
      "Reflect global Buffer alias mutation backstop",
      inCorruptHelperBody(
        '  Reflect.set(globalThis.Buffer, "from", () => globalThis.Buffer.alloc(0));',
      ),
    ],
    [
      "restore callee lexical shadow backstop",
      beforeCorruptLifecycle(
        "      { const restoreConfigRootWithReadback = async () => originalConfigRoot; void restoreConfigRootWithReadback; }",
      ),
    ],
    [
      "host wait callee lexical shadow backstop",
      beforeCorruptLifecycle(
        "      { const waitForHostIdle = async () => ({ pendingHostAction: null }); void waitForHostIdle; }",
      ),
    ],
  ]) {
    assertBindingMutationRejected(label, mutated, /functional-source-fingerprint/);
  }

  for (const [name, value] of [
    ["corruptImageSourceRestoreRequired", "false"],
    ["corruptImageSourceRestored", "true"],
    ["configRestored", "true"],
    ["configMutationAttempted", "false"],
    ["imageSelectionCleanupRequired", "false"],
    ["imageSelectionProjectResetRequired", "false"],
  ]) {
    assertBindingMutationRejected(
      `${name} forged cleanup latch`,
      beforeCorruptLifecycle(`      ${name} = ${value};`),
      new RegExp(`${name}-use|${name}-.*expected-`),
    );
  }
  assertBindingMutationRejected(
    "no-op restoration callback",
    functionalSource.replace(
      "        onRestoreVerified: () => {\n          corruptImageSourceRestored = true;\n        },",
      "        onRestoreVerified: () => undefined,",
    ),
    /restore-callback-shape|corruptImageSourceRestored-.*expected-/,
  );
  assertBindingMutationRejected(
    "same-count host-state true transition moved before awaited operation",
    functionalSource.replace(
      `            imageSelectionHostStateKnown = false;
            const accepted = await client.evaluate(
              debugCall('(api) => api.dispatchClick("palette-add")')
            );
            const state = await waitForHostIdle(client, runtimeEvaluationGuard);
            imageSelectionHostStateKnown = true;`,
      `            imageSelectionHostStateKnown = false;
            imageSelectionHostStateKnown = true;
            const accepted = await client.evaluate(
              debugCall('(api) => api.dispatchClick("palette-add")')
            );
            const state = await waitForHostIdle(client, runtimeEvaluationGuard);`,
    ),
    /imageSelectionHostStateKnown-use|host-state-image-case-true:expected-1:actual-0/,
  );

  const configRestoreOpen = "            await restoreConfigRootWithReadback({";
  const configRestoreClose =
    '              label: "functional smoke Main config root",\n            });\n            configRestored = true;';
  assert.ok(functionalSource.includes(configRestoreOpen));
  assert.ok(functionalSource.includes(configRestoreClose));
  for (const [label, mutated] of [
    [
      "config restoration catch suffix",
      functionalSource.replace(
        configRestoreClose,
        '              label: "functional smoke Main config root",\n            }).catch(() => undefined);\n            configRestored = true;',
      ),
    ],
    [
      "config restoration then suffix",
      functionalSource.replace(
        configRestoreClose,
        '              label: "functional smoke Main config root",\n            }).then(() => undefined);\n            configRestored = true;',
      ),
    ],
    [
      "config restoration callee replacement",
      functionalSource.replace(configRestoreOpen, "            await Promise.resolve({"),
    ],
    [
      "config restoration wrapper",
      functionalSource
        .replace(
          configRestoreOpen,
          "            await (async () => restoreConfigRootWithReadback({",
        )
        .replace(
          configRestoreClose,
          '              label: "functional smoke Main config root",\n            }))();\n            configRestored = true;',
        ),
    ],
  ]) {
    assertBindingMutationRejected(
      label,
      mutated,
      /configRestored-use|configRestored-latch:expected-1:actual-0/,
    );
  }

  for (const [label, mutated, policy] of [
    [
      "project reset completion defaults true",
      functionalSource.replace(
        "  let imageSelectionProjectResetCompleted = false;",
        "  let imageSelectionProjectResetCompleted = true;",
      ),
      /imageSelectionProjectResetCompleted-declaration-shape/,
    ],
    [
      "project reset completion latch relocated into a suffix block",
      functionalSource.replace(
        "            imageSelectionProjectResetCompleted = true;",
        "            { imageSelectionProjectResetCompleted = true; }",
      ),
      /imageSelectionProjectResetCompleted-use|imageSelectionProjectResetCompleted-latch:expected-1:actual-0/,
    ],
    [
      "temporary root deletion omits project reset completion authority",
      functionalSource.replace(
        "            imageSelectionProjectResetCompleted,\n            configMutationAttempted,",
        "            configMutationAttempted,",
      ),
      /imageSelectionProjectResetCompleted-delete-guard:expected-1:actual-0/,
    ],
  ]) {
    assertBindingMutationRejected(label, mutated, policy);
  }

  for (const [label, mutated, policy] of [
    [
      "source-level Buffer binding",
      functionalSource.replace(
        "export const runCorruptImageSelectionCase = async ({",
        "const Buffer = globalThis.Buffer;\nexport const runCorruptImageSelectionCase = async ({",
      ),
      /Buffer-import-authority|Buffer-use-authority/,
    ],
    [
      "corrupt helper Buffer shadow",
      functionalSource.replace(
        "  const expectedBytes = Buffer.from(validBytes);",
        "  { const Buffer = { from: (bytes) => bytes }; void Buffer; }\n  const expectedBytes = Buffer.from(validBytes);",
      ),
      /Buffer-helper-shadow-binding/,
    ],
    [
      "run diagnostic-state factory shadow",
      beforeCorruptLifecycle(
        "      { const createFunctionalSmokeDiagnosticState = () => ({ cleanupErrors: [], evidenceWriteErrors: [] }); void createFunctionalSmokeDiagnosticState; }",
      ),
      /createFunctionalSmokeDiagnosticState-shadow-binding/,
    ],
    [
      "corrupt helper diagnostic-state factory shadow",
      functionalSource.replace(
        "  const expectedBytes = Buffer.from(validBytes);",
        "  { const createFunctionalSmokeDiagnosticState = () => ({}); void createFunctionalSmokeDiagnosticState; }\n  const expectedBytes = Buffer.from(validBytes);",
      ),
      /createFunctionalSmokeDiagnosticState-helper-shadow-binding/,
    ],
    [
      "top-level diagnostic-state factory alias",
      functionalSource
        .replace(
          "export const createFunctionalSmokeDiagnosticState = () => ({",
          "export const intendedCreateFunctionalSmokeDiagnosticState = () => ({",
        )
        .replace(
          "const FUNCTIONAL_SMOKE_CLI_DIAGNOSTIC_LIMIT =",
          "const createFunctionalSmokeDiagnosticState = intendedCreateFunctionalSmokeDiagnosticState;\nconst FUNCTIONAL_SMOKE_CLI_DIAGNOSTIC_LIMIT =",
        ),
      /createFunctionalSmokeDiagnosticState-top-level-binding-authority/,
    ],
    [
      "async diagnostic-state factory",
      functionalSource.replace(
        "export const createFunctionalSmokeDiagnosticState = () => ({",
        "export const createFunctionalSmokeDiagnosticState = async () => ({",
      ),
      /createFunctionalSmokeDiagnosticState-shape/,
    ],
  ]) {
    assertBindingMutationRejected(label, mutated, policy);
  }

  const afterTopologyDeclaration = (insertion) => functionalSource.replace(
    "  const imageSelectionOwnedTopology = [];",
    `  const imageSelectionOwnedTopology = [];\n${insertion}`,
  );
  for (const [label, mutated] of [
    ["direct push", afterTopologyDeclaration("  imageSelectionOwnedTopology.push({});")],
    ["direct splice", afterTopologyDeclaration("  imageSelectionOwnedTopology.splice(0, 0, {});")],
    ["assignment", afterTopologyDeclaration("  imageSelectionOwnedTopology = [];")],
    [
      "alias then mutation",
      afterTopologyDeclaration(
        "  const topologyAlias = imageSelectionOwnedTopology;\n  topologyAlias.push({});",
      ),
    ],
    [
      "unknown helper",
      afterTopologyDeclaration("  mutateOwnedTopology(imageSelectionOwnedTopology);"),
    ],
    [
      "spread append bypass",
      functionalSource.replace(
        "      const captureNewOwnedTopology = (items, setupResult) =>",
        "      imageSelectionOwnedTopology.push(...setupResult.ownedTopology);\n      const captureNewOwnedTopology = (items, setupResult) =>",
      ),
    ],
  ]) {
    assert.match(
      analyzeFunctionalSmokeClosedWorld(mutated).join("\n"),
      /production-imageSelectionOwnedTopology/,
      label,
    );
  }

  for (const [label, mutated, policy] of [
    [
      "capture return chained mutation",
      functionalSource.replace(
        "        captureImageSelectionOwnedTopology(imageSelectionOwnedTopology, items, setupResult);",
        "        captureImageSelectionOwnedTopology(imageSelectionOwnedTopology, items, setupResult).push({});",
      ),
      /captureNewOwnedTopology-shape/,
    ],
    [
      "capture return alias mutation",
      functionalSource.replace(
        "        captureNewOwnedTopology([colorOwnedItem], colorFixture);",
        "        const capturedTopologyAlias = captureNewOwnedTopology([colorOwnedItem], colorFixture);\n        capturedTopologyAlias.push({});",
      ),
      /captureNewOwnedTopology-use/,
    ],
    [
      "post-lifecycle restoration path writer",
      functionalSource.replace(
        "      const corruptSourceRestoration = corruptLifecycle.restoration;",
        '      const corruptSourceRestoration = corruptLifecycle.restoration;\n      await writeFile(corruptLifecycle.restoration.path, Buffer.from("damage"));',
      ),
      /corruptLifecycle-use/,
    ],
    [
      "post-lifecycle restoration path alias writer",
      functionalSource.replace(
        "      const corruptSourceRestoration = corruptLifecycle.restoration;",
        '      const corruptSourceRestoration = corruptLifecycle.restoration;\n      const restorationPathAlias = corruptSourceRestoration.path;\n      await writeFile(restorationPathAlias, Buffer.from("damage"));',
      ),
      /corruptSourceRestoration-use/,
    ],
    [
      "invalid pngBytes provenance",
      functionalSource.replace(
        "      const pngBytes = await readFile(pngFixture.path);",
        '      const pngBytes = Buffer.from("not a valid PNG");',
      ),
      /pngBytes-provenance/,
    ],
    [
      "valid copy moved after corrupt lifecycle",
      functionalSource
        .replace("      await writeFile(corruptPath, pngBytes);\n", "")
        .replace(
          "      const corruptSourceRestoration = corruptLifecycle.restoration;",
          "      await writeFile(corruptPath, pngBytes);\n      const corruptSourceRestoration = corruptLifecycle.restoration;",
        ),
      /corrupt-lifecycle-order/,
    ],
    [
      "corrupt lifecycle validBytes rewired",
      functionalSource.replace(
        "        validBytes: pngBytes,",
        '        validBytes: Buffer.from("not a valid PNG"),',
      ),
      /corrupt-lifecycle-shape/,
    ],
  ]) {
    assert.match(analyzeFunctionalSmokeClosedWorld(mutated).join("\n"), policy, label);
  }

  const exactAuthority =
    "          imageSelectionHostStateKnown && runtimeEvaluationCompletionKnown(),";
  for (const [label, replacement] of [
    ["authority OR true", "          imageSelectionHostStateKnown && runtimeEvaluationCompletionKnown() || true,"],
    ["authority ternary", "          imageSelectionHostStateKnown ? runtimeEvaluationCompletionKnown() : true,"],
    ["authority non-false", "          (imageSelectionHostStateKnown && runtimeEvaluationCompletionKnown()) !== false,"],
    ["authority wrapper", "          Boolean(imageSelectionHostStateKnown && runtimeEvaluationCompletionKnown()),"],
    ["authority extra parent expression", "          (imageSelectionHostStateKnown && runtimeEvaluationCompletionKnown()) && true,"],
  ]) {
    assert.match(
      analyzeFunctionalSmokeClosedWorld(functionalSource.replace(exactAuthority, replacement)).join("\n"),
      /restore-authority-shape/,
      label,
    );
  }
  const exactRuntimeBinding =
    "  const runtimeEvaluationCompletionKnown = () =>\n    isFunctionalSmokeRuntimeCompletionKnown(runtimeEvaluationGuard);";
  for (const [label, replacement] of [
    [
      "permissive runtime completion binding",
      "  const runtimeEvaluationCompletionKnown = () =>\n    isFunctionalSmokeRuntimeCompletionKnown(runtimeEvaluationGuard) || true;",
    ],
    [
      "wrapped runtime completion binding",
      "  const runtimeEvaluationCompletionKnown = () =>\n    Boolean(isFunctionalSmokeRuntimeCompletionKnown(runtimeEvaluationGuard));",
    ],
  ]) {
    assert.match(
      analyzeFunctionalSmokeClosedWorld(functionalSource.replace(exactRuntimeBinding, replacement)).join("\n"),
      /runtime-completion-binding-shape/,
      label,
    );
  }

  const afterRuntimeCompletionBinding = (insertion) => functionalSource.replace(
    exactRuntimeBinding,
    `${exactRuntimeBinding}\n${insertion}`,
  );

  for (const [label, mutated, policy] of [
    [
      "reviewer block function shadows corrupt lifecycle helper",
      beforeCorruptLifecycle(
        "      async function runCorruptImageSelectionCase(options) {\n        try {\n          return await options.runProductCase();\n        } finally {\n          await writeFile(options[\"corrupt\" + \"Path\"], options.validBytes);\n        }\n      }",
      ),
      /runCorruptImageSelectionCase-(?:binding|shadow)/,
    ],
    [
      "function declaration shadows readFile",
      beforeCorruptLifecycle("      { function readFile(path) { return path; } }"),
      /readFile-(?:binding|shadow)/,
    ],
    [
      "const declaration shadows readFile",
      beforeCorruptLifecycle("      { const readFile = async () => Buffer.alloc(0); void readFile; }"),
      /readFile-(?:binding|shadow)/,
    ],
    [
      "parameter shadows readFile",
      beforeCorruptLifecycle("      { const inspectReader = (readFile) => readFile; void inspectReader; }"),
      /readFile-(?:binding|shadow)/,
    ],
    [
      "destructuring declaration shadows readFile",
      beforeCorruptLifecycle("      { const { readFile } = { readFile: null }; void readFile; }"),
      /readFile-(?:binding|shadow)/,
    ],
    [
      "block function shadows topology capture helper",
      beforeCorruptLifecycle("      { function captureImageSelectionOwnedTopology() { return []; } }"),
      /captureImageSelectionOwnedTopology-(?:binding|shadow)/,
    ],
    [
      "block const shadows topology capture helper",
      beforeCorruptLifecycle("      { const captureImageSelectionOwnedTopology = () => []; void captureImageSelectionOwnedTopology; }"),
      /captureImageSelectionOwnedTopology-(?:binding|shadow)/,
    ],
    [
      "nested block shadows runtime completion authority",
      beforeCorruptLifecycle("      { const runtimeEvaluationCompletionKnown = () => true; void runtimeEvaluationCompletionKnown; }"),
      /runtimeEvaluationCompletionKnown-(?:binding|shadow)/,
    ],
    [
      "block const shadows writeFile",
      beforeCorruptLifecycle("      { const writeFile = async () => undefined; void writeFile; }"),
      /writeFile-(?:binding|shadow)/,
    ],
    [
      "block function shadows strict completion helper",
      afterRuntimeCompletionBinding(
        "  { function isFunctionalSmokeRuntimeCompletionKnown() { return true; } }",
      ),
      /isFunctionalSmokeRuntimeCompletionKnown-(?:binding|shadow)/,
    ],
    [
      "nested function shadows evalImageHost",
      beforeCorruptLifecycle("      function inspectEvalBinding(evalImageHost) { return evalImageHost; } void inspectEvalBinding;"),
      /evalImageHost-(?:binding|shadow)/,
    ],
    [
      "block const shadows captureNewOwnedTopology",
      beforeCorruptLifecycle("      { const captureNewOwnedTopology = () => undefined; void captureNewOwnedTopology; }"),
      /captureNewOwnedTopology-(?:binding|shadow)/,
    ],
    [
      "block class shadows cleanup source helper",
      beforeCorruptLifecycle("      { class cleanupImageSelectionFixturesSource {} void cleanupImageSelectionFixturesSource; }"),
      /cleanupImageSelectionFixturesSource-(?:binding|shadow)/,
    ],
    [
      "catch binding shadows image source helper",
      beforeCorruptLifecycle("      try {} catch (importProjectImageSource) { void importProjectImageSource; }"),
      /importProjectImageSource-(?:binding|shadow)/,
    ],
    [
      "destructuring parameter shadows host-state authority",
      beforeCorruptLifecycle("      { const inspectHostState = ({ imageSelectionHostStateKnown }) => imageSelectionHostStateKnown; void inspectHostState; }"),
      /imageSelectionHostStateKnown-(?:binding|shadow)/,
    ],
    [
      "named function expression shadows runtime guard",
      beforeCorruptLifecycle("      { const inspectGuard = function runtimeEvaluationGuard() {}; void inspectGuard; }"),
      /runtimeEvaluationGuard-(?:binding|shadow)/,
    ],
    [
      "named class expression shadows capture helper",
      beforeCorruptLifecycle("      { const Capture = class captureImageSelectionOwnedTopology {}; void Capture; }"),
      /captureImageSelectionOwnedTopology-(?:binding|shadow)/,
    ],
    [
      "nested block shadows corrupt helper writer parameter",
      functionalSource.replace(
        "    await writeSource(corruptPath, corruptBytes);",
        "    { const writeSource = async () => undefined; void writeSource; }\n    await writeSource(corruptPath, corruptBytes);",
      ),
      /writeSource-helper-binding-shadow/,
    ],
    [
      "nested parameter shadows corrupt helper reader parameter",
      functionalSource.replace(
        "    await writeSource(corruptPath, corruptBytes);",
        "    { const inspectSource = (readSource) => readSource; void inspectSource; }\n    await writeSource(corruptPath, corruptBytes);",
      ),
      /readSource-helper-binding-shadow/,
    ],
    [
      "top-level readFile import alias and redeclaration",
      functionalSource.replace(
        'import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";',
        'import { mkdir, readFile as importedReadFile, realpath, rename, rm, writeFile } from "node:fs/promises";\nconst readFile = importedReadFile;',
      ),
      /readFile-(?:import|binding|authority)/,
    ],
    [
      "top-level writeFile import alias and redeclaration",
      functionalSource.replace(
        'import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";',
        'import { mkdir, readFile, realpath, rename, rm, writeFile as importedWriteFile } from "node:fs/promises";\nconst writeFile = importedWriteFile;',
      ),
      /writeFile-(?:import|binding|authority)/,
    ],
    [
      "top-level corrupt helper alias replaces intended declaration shape",
      functionalSource
        .replace(
          "export const runCorruptImageSelectionCase = async ({",
          "export const intendedRunCorruptImageSelectionCase = async ({",
        )
        .replace(
          "const IMAGE_FIXTURES =",
          "const runCorruptImageSelectionCase = intendedRunCorruptImageSelectionCase;\nconst IMAGE_FIXTURES =",
        ),
      /runCorruptImageSelectionCase-top-level-binding-authority/,
    ],
  ]) {
    assertBindingMutationRejected(label, mutated, policy);
  }

  const nonBindingNameUses = beforeCorruptLifecycle(
    "      readFile: {\n        const propertyNoise = {\n          readFile: true,\n          writeFile() {},\n          captureImageSelectionOwnedTopology: true,\n        };\n        propertyNoise.isFunctionalSmokeRuntimeCompletionKnown;\n        break readFile;\n      }",
  );
  const nonBindingParsed = ts.createSourceFile(
    "non-binding-critical-name-uses.mjs",
    nonBindingNameUses,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  assert.equal(nonBindingParsed.parseDiagnostics.length, 0);
  assert.deepEqual(
    analyzeFunctionalSmokeClosedWorld(nonBindingNameUses, { requireExactSource: false }),
    [],
    "property keys, method names, labels, and property usages must not be treated as bindings",
  );
  const helperNonBindingNameUses = functionalSource.replace(
    "  const expectedBytes = Buffer.from(validBytes);",
    "  const propertyNoise = { Buffer: true, createFunctionalSmokeDiagnosticState() {} };\n  propertyNoise.Buffer;\n  propertyNoise.createFunctionalSmokeDiagnosticState;\n  const expectedBytes = Buffer.from(validBytes);",
  );
  assert.deepEqual(
    analyzeFunctionalSmokeClosedWorld(helperNonBindingNameUses, { requireExactSource: false }),
    [],
    "helper property keys, method names, and property accesses must not be treated as bindings",
  );
});

test("functional image selection executes and wires same-dispatch topology capture", async () => {
  const functionalSource = await readFile(
    new URL("../scripts/cep-functional-smoke.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(functionalSource, /\brequireCondition\s*\(/);
  assert.match(
    functionalSource,
    /captureImageSelectionOwnedTopology\(imageSelectionOwnedTopology, items, setupResult\)/,
  );

  const { captureImageSelectionOwnedTopology } = await import(
    "../scripts/cep-functional-smoke.mjs?image-selection-topology-validation"
  );
  const items = [{ id: 37, name: "CP_IMAGE_LAYER_PNG", kind: "footage" }];
  const topology = [{ id: 37, name: "CP_IMAGE_LAYER_PNG", kind: "footage", detail: {} }];
  const sentinel = { id: "sentinel", nested: { retained: true } };
  const capturedTopology = [sentinel];

  assert.equal(
    captureImageSelectionOwnedTopology(capturedTopology, items, { ownedTopology: topology }),
    capturedTopology,
  );
  assert.deepEqual(capturedTopology, [sentinel, ...topology]);

  for (const { label, candidateItems, setupResult, pattern } of [
    { label: "count drift", candidateItems: items, setupResult: { ownedTopology: [] }, pattern: /same-dispatch topology capture failed/ },
    { label: "ID drift", candidateItems: items, setupResult: { ownedTopology: [{ ...topology[0], id: 38 }] }, pattern: /topology descriptor drifted/ },
    { label: "name drift", candidateItems: items, setupResult: { ownedTopology: [{ ...topology[0], name: "DRIFTED" }] }, pattern: /topology descriptor drifted/ },
    { label: "kind drift", candidateItems: items, setupResult: { ownedTopology: [{ ...topology[0], kind: "comp" }] }, pattern: /topology descriptor drifted/ },
    { label: "missing items", candidateItems: null, setupResult: { ownedTopology: topology }, pattern: /same-dispatch topology capture failed/ },
    { label: "object items", candidateItems: {}, setupResult: { ownedTopology: topology }, pattern: /same-dispatch topology capture failed/ },
    { label: "malformed item", candidateItems: [null], setupResult: { ownedTopology: topology }, pattern: /topology descriptor drifted/ },
    { label: "matching malformed descriptors", candidateItems: [{}], setupResult: { ownedTopology: [{}] }, pattern: /topology descriptor drifted/ },
    { label: "missing setup", candidateItems: items, setupResult: null, pattern: /same-dispatch topology capture failed/ },
    { label: "object setup topology", candidateItems: items, setupResult: { ownedTopology: {} }, pattern: /same-dispatch topology capture failed/ },
    { label: "malformed setup topology item", candidateItems: items, setupResult: { ownedTopology: [null] }, pattern: /topology descriptor drifted/ },
  ]) {
    const destination = [{ ...sentinel, nested: { ...sentinel.nested } }];
    const before = structuredClone(destination);
    assert.throws(
      () => captureImageSelectionOwnedTopology(destination, candidateItems, setupResult),
      pattern,
      label,
    );
    assert.deepEqual(destination, before, `${label} must leave the capture destination unchanged`);
  }

  const malformedTarget = { sentinel: { retained: true } };
  const malformedTargetBefore = structuredClone(malformedTarget);
  assert.throws(
    () => captureImageSelectionOwnedTopology(malformedTarget, items, { ownedTopology: topology }),
    /topology capture target is unavailable/,
  );
  assert.deepEqual(malformedTarget, malformedTargetBefore);
});

test("functional temporary source root is preserved when project reset is refused", () => {
  const archivePath = "/owned-output/preserved-functional-project.aep";
  const reset = {
    reset: false,
    reason: "project-close-refused",
    archivePath,
    projectPath: "/owned-temp/image-selection.aep",
    dirty: true,
    numItems: 1,
  };
  const imageSelectionProjectResetCompleted =
    reset.reset === true &&
    reset.archivePath === archivePath &&
    reset.projectPath === null &&
    reset.dirty === false &&
    reset.numItems === 0;
  assert.equal(imageSelectionProjectResetCompleted, false);

  const restoredState = {
    path: "/owned-temp/image-selection",
    corruptImageSourceRestoreRequired: true,
    corruptImageSourceRestored: true,
    imageSelectionProjectResetRequired: true,
    imageSelectionProjectResetCompleted,
    configMutationAttempted: true,
    configRestored: true,
  };
  assert.throws(
    () => assertFunctionalSmokeTemporaryDirectoryRemovalAllowed(restoredState),
    /image-selection project reset is unproven/,
  );
  assert.doesNotThrow(() => assertFunctionalSmokeTemporaryDirectoryRemovalAllowed({
    ...restoredState,
    imageSelectionProjectResetCompleted: true,
  }));
});

test("functional corrupt image lifecycle restores valid bytes before evidence and fails closed", async () => {
  const functionalSource = await readFile(
    new URL("../scripts/cep-functional-smoke.mjs", import.meta.url),
    "utf8",
  );
  const corruptLifecycleIndex = functionalSource.indexOf(
    "const corruptLifecycle = await runCorruptImageSelectionCase({",
  );
  const selectionScreenshotIndex = functionalSource.indexOf(
    'const screenshot = await client.send("Page.captureScreenshot"',
    corruptLifecycleIndex,
  );
  assert.ok(corruptLifecycleIndex > 0, "production must use the modal-safe corrupt lifecycle");
  assert.ok(
    selectionScreenshotIndex > corruptLifecycleIndex,
    "corrupt source restoration must complete before selection screenshot capture",
  );
  assert.doesNotMatch(
    functionalSource,
    /await writeFile\(corruptPath, "not a valid PNG"\)/,
    "production must not bypass the restoring lifecycle",
  );
  assert.match(
    functionalSource,
    /corruptImageSourceRestoreRequired && !corruptImageSourceRestored[^]*project reset refused/,
  );
  assert.match(
    functionalSource,
    /finalizeFunctionalSmoke\(\{\s*primaryError,\s*hasPrimaryError,\s*diagnosticState,/,
    "production finalization must retain the shared corrupt-source diagnostic state",
  );
  const diagnosticImportCatchPattern =
    /catch \(error\) \{\s*primaryError = error;\s*hasPrimaryError = true;\s*importFunctionalSmokeErrorDiagnostics\(error, diagnosticState\);/g;
  assert.equal(
    functionalSource.match(diagnosticImportCatchPattern)?.length,
    2,
    "the corrupt helper and production run catch must both import lower-layer diagnostics",
  );
  const productionCatchIndex = functionalSource.lastIndexOf("} catch (error) {");
  const productionImportIndex = functionalSource.indexOf(
    "importFunctionalSmokeErrorDiagnostics(error, diagnosticState);",
    productionCatchIndex,
  );
  const productionFinalizationIndex = functionalSource.indexOf(
    "await finalizeFunctionalSmoke({",
    productionCatchIndex,
  );
  assert.ok(
    productionCatchIndex > 0 &&
      productionImportIndex > productionCatchIndex &&
      productionFinalizationIndex > productionImportIndex,
    "production must import caught diagnostics before finalization",
  );
  assert.match(
    functionalSource,
    /hasRestoreAuthority: \(\) =>\s*imageSelectionHostStateKnown && runtimeEvaluationCompletionKnown\(\)/,
    "production restoration authority must combine host-state and runtime-completion knowledge",
  );
  assert.doesNotMatch(
    functionalSource,
    /hasRestoreAuthority\s*=\s*\(\)\s*=>\s*true/,
    "corrupt-source restoration authority must never default to true",
  );
  assert.doesNotMatch(functionalSource, /productCaseReturned/);

  const {
    createFunctionalSmokeDiagnosticState,
    finalizeFunctionalSmoke,
    formatFunctionalSmokeCliDiagnostics,
    importFunctionalSmokeErrorDiagnostics,
    publishFunctionalSmokeFailure,
    printFunctionalSmokeCliError,
    runCorruptImageSelectionCase,
  } = await import(
    "../scripts/cep-functional-smoke.mjs?corrupt-image-modal-safe-lifecycle"
  );
  const validBytes = Buffer.from("valid PNG fixture bytes");
  const corruptBytes = Buffer.from("not a valid PNG");
  const expectedResult = { name: "corrupt-png-decode-rejected" };
  const events = [];
  let diskBytes = Buffer.from(validBytes);
  const writeSource = async (_path, bytes) => {
    diskBytes = Buffer.from(bytes);
    events.push(diskBytes.equals(validBytes) ? "restore-write" : "corrupt-write");
  };
  const readSource = async () => {
    events.push("restore-readback");
    return Buffer.from(diskBytes);
  };

  const corruptLifecycle = await runCorruptImageSelectionCase({
    corruptPath: "/owned/corrupt.png",
    validBytes,
    corruptBytes,
    writeSource,
    readSource,
    runProductCase: async () => {
      events.push("product-case");
      return expectedResult;
    },
    validateProductResult: (result) => {
      events.push("product-validation");
      assert.equal(result, expectedResult);
    },
    hasRestoreAuthority: () => {
      events.push("restore-authority");
      return true;
    },
    onRestoreVerified: ({ sha256 }) => events.push(`restore-verified:${sha256}`),
  });
  events.push("screenshot", "archive-reset", "publish-success");

  assert.equal(corruptLifecycle.result, expectedResult);
  assert.equal(corruptLifecycle.restoration.restored, true);
  assert.equal(
    corruptLifecycle.restoration.sha256,
    createHash("sha256").update(validBytes).digest("hex"),
  );
  assert.deepEqual(events.map((event) => event.split(":")[0]), [
    "corrupt-write",
    "product-case",
    "product-validation",
    "restore-authority",
    "restore-write",
    "restore-readback",
    "restore-verified",
    "screenshot",
    "archive-reset",
    "publish-success",
  ]);
  assert.ok(diskBytes.equals(validBytes));

  const lowerCleanupDiagnostic = {
    phase: "lower-layer-cleanup",
    error: "lower cleanup failed",
  };
  const lowerEvidenceDiagnostic = {
    phase: "lower-layer-evidence",
    error: "lower evidence write failed",
  };
  const lowerLayerError = new Error("lower-layer primary failed");
  lowerLayerError.cleanupErrors = [lowerCleanupDiagnostic];
  lowerLayerError.evidenceWriteErrors = [lowerEvidenceDiagnostic];
  const lowerLayerState = createFunctionalSmokeDiagnosticState();
  await assert.rejects(
    runCorruptImageSelectionCase({
      corruptPath: "/owned/corrupt.png",
      validBytes,
      corruptBytes,
      diagnosticState: lowerLayerState,
      writeSource: async () => undefined,
      readSource: async () => validBytes,
      runProductCase: async () => { throw lowerLayerError; },
      validateProductResult: () => assert.fail("failed product must not validate"),
      hasRestoreAuthority: () => false,
    }),
    (error) => error === lowerLayerError,
  );
  assert.deepEqual(
    lowerLayerState.cleanupErrors.map(({ phase }) => phase),
    ["lower-layer-cleanup", "corrupt-image-source-restoration"],
  );
  assert.deepEqual(
    lowerLayerState.evidenceWriteErrors.map(({ phase }) => phase),
    ["lower-layer-evidence"],
  );
  await assert.rejects(
    finalizeFunctionalSmoke({
      primaryError: lowerLayerError,
      hasPrimaryError: true,
      diagnosticState: lowerLayerState,
      cleanupSteps: [
        {
          phase: "lower-layer-finalizer-cleanup",
          run: async () => { throw new Error("later cleanup failed"); },
        },
      ],
      publishSuccess: async () => assert.fail("a primary failure must not publish success"),
      writeFailure: (failure) => publishFunctionalSmokeFailure({
        ...failure,
        reportPath: "/owned/report.json",
        pendingReportPath: "/owned/report.pending.json",
        failurePath: "/owned/failure.json",
        mode: "image-selection",
        runId: "lower-layer-diagnostics",
        replaceReport: async () => { throw new Error("lower report replacement failed"); },
        writeFailureFile: async () => { throw new Error("lower failure file write failed"); },
      }),
    }),
    (error) => error === lowerLayerError,
  );
  assert.deepEqual(
    lowerLayerState.cleanupErrors.map(({ phase }) => phase),
    [
      "lower-layer-cleanup",
      "corrupt-image-source-restoration",
      "lower-layer-finalizer-cleanup",
      "write-failure",
    ],
  );
  assert.deepEqual(
    lowerLayerState.evidenceWriteErrors.map(({ phase }) => phase),
    ["lower-layer-evidence", "failure-report", "failure-json"],
  );
  const lowerLayerCliOutput = [];
  printFunctionalSmokeCliError(
    lowerLayerError,
    lowerLayerState,
    (line) => lowerLayerCliOutput.push(line),
  );
  const lowerLayerCliDiagnostics = JSON.parse(lowerLayerCliOutput[1]);
  assert.deepEqual(
    lowerLayerCliDiagnostics.cleanupErrors.map(({ phase }) => phase),
    [
      "lower-layer-cleanup",
      "corrupt-image-source-restoration",
      "lower-layer-finalizer-cleanup",
      "write-failure",
    ],
  );
  assert.deepEqual(
    lowerLayerCliDiagnostics.evidenceWriteErrors.map(({ phase }) => phase),
    ["lower-layer-evidence", "failure-report", "failure-json"],
  );

  const frozenCleanupDiagnostic = {
    phase: "frozen-lower-cleanup",
    error: "frozen cleanup failed",
  };
  const frozenEvidenceDiagnostic = {
    phase: "frozen-lower-evidence",
    error: "frozen evidence failed",
  };
  const frozenLowerLayerError = new Error("frozen lower-layer primary failed");
  frozenLowerLayerError.cleanupErrors = [frozenCleanupDiagnostic];
  frozenLowerLayerError.evidenceWriteErrors = [frozenEvidenceDiagnostic];
  Object.freeze(frozenLowerLayerError);
  const frozenLowerLayerState = createFunctionalSmokeDiagnosticState();
  await assert.rejects(
    runCorruptImageSelectionCase({
      corruptPath: "/owned/corrupt.png",
      validBytes,
      corruptBytes,
      diagnosticState: frozenLowerLayerState,
      writeSource: async (_path, bytes) => {
        if (Buffer.from(bytes).equals(validBytes)) throw new Error("frozen primary restore failed");
      },
      readSource: async () => assert.fail("failed restoration must not read back"),
      runProductCase: async () => { throw frozenLowerLayerError; },
      validateProductResult: () => assert.fail("failed product must not validate"),
      hasRestoreAuthority: () => true,
    }),
    (error) => error === frozenLowerLayerError,
  );
  assert.deepEqual(
    frozenLowerLayerState.cleanupErrors.map(({ phase }) => phase),
    ["frozen-lower-cleanup", "corrupt-image-source-restoration"],
  );
  assert.deepEqual(
    frozenLowerLayerState.evidenceWriteErrors.map(({ phase }) => phase),
    ["frozen-lower-evidence"],
  );
  assert.deepEqual(frozenLowerLayerError.cleanupErrors, [frozenCleanupDiagnostic]);
  assert.deepEqual(frozenLowerLayerError.evidenceWriteErrors, [frozenEvidenceDiagnostic]);

  const sharedLedgerCleanupDiagnostic = {
    phase: "shared-ledger-cleanup",
    error: "shared cleanup failed",
  };
  const sharedLedgerEvidenceDiagnostic = {
    phase: "shared-ledger-evidence",
    error: "shared evidence failed",
  };
  const sharedLedgerState = createFunctionalSmokeDiagnosticState();
  sharedLedgerState.cleanupErrors.push(sharedLedgerCleanupDiagnostic);
  sharedLedgerState.evidenceWriteErrors.push(sharedLedgerEvidenceDiagnostic);
  const sharedLedgerError = new Error("shared-ledger primary failed");
  sharedLedgerError.cleanupErrors = sharedLedgerState.cleanupErrors;
  sharedLedgerError.evidenceWriteErrors = sharedLedgerState.evidenceWriteErrors;
  await assert.rejects(
    runCorruptImageSelectionCase({
      corruptPath: "/owned/corrupt.png",
      validBytes,
      corruptBytes,
      diagnosticState: sharedLedgerState,
      writeSource: async () => undefined,
      readSource: async () => validBytes,
      runProductCase: async () => { throw sharedLedgerError; },
      validateProductResult: () => assert.fail("failed product must not validate"),
      hasRestoreAuthority: () => false,
    }),
    (error) => error === sharedLedgerError,
  );
  assert.deepEqual(
    sharedLedgerState.cleanupErrors.map(({ phase }) => phase),
    ["shared-ledger-cleanup", "corrupt-image-source-restoration"],
  );
  assert.deepEqual(
    sharedLedgerState.evidenceWriteErrors.map(({ phase }) => phase),
    ["shared-ledger-evidence"],
  );
  importFunctionalSmokeErrorDiagnostics(
    {
      cleanupErrors: [sharedLedgerCleanupDiagnostic],
      evidenceWriteErrors: [sharedLedgerEvidenceDiagnostic],
    },
    sharedLedgerState,
  );
  assert.equal(
    sharedLedgerState.cleanupErrors.filter((entry) => entry === sharedLedgerCleanupDiagnostic).length,
    1,
  );
  assert.equal(
    sharedLedgerState.evidenceWriteErrors.filter(
      (entry) => entry === sharedLedgerEvidenceDiagnostic,
    ).length,
    1,
  );

  const omittedAuthorityEvents = [];
  let omittedAuthorityDiskBytes = Buffer.from(validBytes);
  let omittedAuthoritySuccessPublished = false;
  let omittedAuthorityError;
  await assert.rejects(
    runCorruptImageSelectionCase({
      corruptPath: "/owned/corrupt.png",
      validBytes,
      corruptBytes,
      writeSource: async (_path, bytes) => {
        omittedAuthorityDiskBytes = Buffer.from(bytes);
        omittedAuthorityEvents.push(
          omittedAuthorityDiskBytes.equals(validBytes) ? "restore-write" : "corrupt-write",
        );
      },
      readSource: async () => {
        omittedAuthorityEvents.push("restore-readback");
        return Buffer.from(omittedAuthorityDiskBytes);
      },
      runProductCase: async () => {
        omittedAuthorityEvents.push("product-case");
        return expectedResult;
      },
      validateProductResult: () => omittedAuthorityEvents.push("product-validation"),
      onRestoreVerified: () => omittedAuthorityEvents.push("restore-verified"),
    }).then(() => {
      omittedAuthoritySuccessPublished = true;
    }),
    (error) => {
      omittedAuthorityError = error;
      return /completion is unknown.*restoration refused/i.test(error.message);
    },
  );
  assert.deepEqual(omittedAuthorityEvents, [
    "corrupt-write",
    "product-case",
    "product-validation",
  ]);
  assert.ok(omittedAuthorityDiskBytes.equals(corruptBytes));
  assert.equal(omittedAuthoritySuccessPublished, false);
  assert.deepEqual(
    omittedAuthorityError.cleanupErrors.map(({ phase }) => phase),
    ["corrupt-image-source-restoration"],
  );

  const nonFunctionAuthorityEvents = [];
  let nonFunctionAuthorityError;
  await assert.rejects(
    runCorruptImageSelectionCase({
      corruptPath: "/owned/corrupt.png",
      validBytes,
      corruptBytes,
      writeSource: async (_path, bytes) => {
        nonFunctionAuthorityEvents.push(
          Buffer.from(bytes).equals(validBytes) ? "restore-write" : "corrupt-write",
        );
      },
      readSource: async () => {
        nonFunctionAuthorityEvents.push("restore-readback");
        return validBytes;
      },
      runProductCase: async () => expectedResult,
      validateProductResult: () => undefined,
      hasRestoreAuthority: true,
      onRestoreVerified: () => nonFunctionAuthorityEvents.push("restore-verified"),
    }),
    (error) => {
      nonFunctionAuthorityError = error;
      return /completion is unknown.*restoration refused/i.test(error.message);
    },
  );
  assert.deepEqual(nonFunctionAuthorityEvents, ["corrupt-write"]);
  assert.deepEqual(
    nonFunctionAuthorityError.cleanupErrors.map(({ phase }) => phase),
    ["corrupt-image-source-restoration"],
  );

  const unknownCompletionError = new Error("product dispatch completion unknown");
  const unknownEvents = [];
  let unknownDiskBytes = Buffer.from(validBytes);
  let completionKnown = true;
  let restoreAuthorityChecks = 0;
  await assert.rejects(
    runCorruptImageSelectionCase({
      corruptPath: "/owned/corrupt.png",
      validBytes,
      corruptBytes,
      writeSource: async (_path, bytes) => {
        unknownDiskBytes = Buffer.from(bytes);
        unknownEvents.push(unknownDiskBytes.equals(validBytes) ? "restore-write" : "corrupt-write");
      },
      readSource: async () => {
        unknownEvents.push("restore-readback");
        return Buffer.from(unknownDiskBytes);
      },
      runProductCase: async () => {
        unknownEvents.push("product-dispatch");
        completionKnown = false;
        throw unknownCompletionError;
      },
      validateProductResult: () => unknownEvents.push("product-validation"),
      hasRestoreAuthority: () => {
        restoreAuthorityChecks += 1;
        return completionKnown;
      },
      onRestoreVerified: () => unknownEvents.push("restore-verified"),
    }),
    (error) => error === unknownCompletionError,
  );
  assert.deepEqual(unknownEvents, ["corrupt-write", "product-dispatch"]);
  assert.ok(unknownDiskBytes.equals(corruptBytes));
  assert.equal(restoreAuthorityChecks, 1);
  assert.deepEqual(
    unknownCompletionError.cleanupErrors.map(({ phase }) => phase),
    ["corrupt-image-source-restoration"],
  );
  assert.match(unknownCompletionError.cleanupErrors[0].error, /completion is unknown.*restoration refused/i);

  const unknownFinalizerEvents = [];
  await assert.rejects(
    finalizeFunctionalSmoke({
      primaryError: unknownCompletionError,
      initialCleanupErrors: unknownCompletionError.cleanupErrors,
      cleanupSteps: [
        {
          phase: "image-selection-project-reset",
          run: async () => {
            if (!unknownDiskBytes.equals(validBytes)) throw new Error("source restoration unproven; project reset refused");
            unknownFinalizerEvents.push("archive-reset");
          },
        },
        {
          phase: "temporary-config-root",
          run: async () => {
            if (!completionKnown) throw new Error("completion unknown; config restoration refused");
            unknownFinalizerEvents.push("config-restore");
          },
        },
        { phase: "cdp-close", run: async () => unknownFinalizerEvents.push("cdp-close") },
        {
          phase: "temporary-directory",
          run: async () => {
            if (!unknownDiskBytes.equals(validBytes)) throw new Error("source restoration unproven; deletion refused");
            unknownFinalizerEvents.push("temporary-directory-delete");
          },
        },
      ],
      publishSuccess: async () => unknownFinalizerEvents.push("publish-success"),
      writeFailure: async () => unknownFinalizerEvents.push("write-failure"),
    }),
    (error) => error === unknownCompletionError,
  );
  assert.deepEqual(unknownFinalizerEvents, ["cdp-close", "write-failure"]);

  const validationFailure = new Error("returned product validation failed");
  const validationFailureEvents = [];
  let validationFailureDiskBytes = Buffer.from(validBytes);
  await assert.rejects(
    runCorruptImageSelectionCase({
      corruptPath: "/owned/corrupt.png",
      validBytes,
      corruptBytes,
      writeSource: async (_path, bytes) => {
        validationFailureDiskBytes = Buffer.from(bytes);
        validationFailureEvents.push(
          validationFailureDiskBytes.equals(validBytes) ? "restore-write" : "corrupt-write",
        );
      },
      readSource: async () => {
        validationFailureEvents.push("restore-readback");
        return Buffer.from(validationFailureDiskBytes);
      },
      runProductCase: async () => {
        validationFailureEvents.push("product-case");
        return expectedResult;
      },
      validateProductResult: () => {
        validationFailureEvents.push("product-validation");
        throw validationFailure;
      },
      hasRestoreAuthority: () => {
        validationFailureEvents.push("restore-authority");
        return false;
      },
      onRestoreVerified: () => validationFailureEvents.push("restore-verified"),
    }),
    (error) => error === validationFailure,
  );
  assert.deepEqual(validationFailureEvents, [
    "corrupt-write",
    "product-case",
    "product-validation",
    "restore-authority",
  ]);
  assert.ok(validationFailureDiskBytes.equals(corruptBytes));
  assert.deepEqual(
    validationFailure.cleanupErrors.map(({ phase }) => phase),
    ["corrupt-image-source-restoration"],
  );
  assert.match(
    validationFailure.cleanupErrors[0].error,
    /completion is unknown.*restoration refused/i,
  );

  for (const { label, getAuthority } of [
    { label: "false", getAuthority: () => false },
    { label: "non-Boolean", getAuthority: () => "true" },
    { label: "callback throw", getAuthority: () => { throw new Error("authority callback failed"); } },
  ]) {
    const refusalEvents = [];
    let refusalDiskBytes = Buffer.from(validBytes);
    let refusalError;
    await assert.rejects(
      runCorruptImageSelectionCase({
        corruptPath: "/owned/corrupt.png",
        validBytes,
        corruptBytes,
        writeSource: async (_path, bytes) => {
          refusalDiskBytes = Buffer.from(bytes);
          refusalEvents.push(refusalDiskBytes.equals(validBytes) ? "restore-write" : "corrupt-write");
        },
        readSource: async () => {
          refusalEvents.push("restore-readback");
          return Buffer.from(refusalDiskBytes);
        },
        runProductCase: async () => {
          refusalEvents.push("product-case");
          return expectedResult;
        },
        validateProductResult: () => refusalEvents.push("product-validation"),
        hasRestoreAuthority: () => {
          refusalEvents.push("restore-authority");
          return getAuthority();
        },
        onRestoreVerified: () => refusalEvents.push("restore-verified"),
      }),
      (error) => {
        refusalError = error;
        return /completion is unknown.*restoration refused/i.test(error.message);
      },
      label,
    );
    assert.deepEqual(
      refusalEvents,
      ["corrupt-write", "product-case", "product-validation", "restore-authority"],
      label,
    );
    assert.ok(refusalDiskBytes.equals(corruptBytes), label);
    assert.deepEqual(
      refusalError.cleanupErrors.map(({ phase }) => phase),
      ["corrupt-image-source-restoration"],
      label,
    );
  }

  for (const phase of ["product-case", "product-validation"]) {
    const failureEvents = [];
    let failureDiskBytes = Buffer.from(validBytes);
    const productError = new Error(`${phase} failed`);
    let failureAuthorityChecks = 0;
    await assert.rejects(
      runCorruptImageSelectionCase({
        corruptPath: "/owned/corrupt.png",
        validBytes,
        corruptBytes,
        writeSource: async (_path, bytes) => {
          failureDiskBytes = Buffer.from(bytes);
          failureEvents.push(failureDiskBytes.equals(validBytes) ? "restore-write" : "corrupt-write");
        },
        readSource: async () => {
          failureEvents.push("restore-readback");
          return Buffer.from(failureDiskBytes);
        },
        runProductCase: async () => {
          failureEvents.push("product-case");
          if (phase === "product-case") throw productError;
          return expectedResult;
        },
        validateProductResult: () => {
          failureEvents.push("product-validation");
          if (phase === "product-validation") throw productError;
        },
        hasRestoreAuthority: () => {
          failureAuthorityChecks += 1;
          failureEvents.push("restore-authority");
          return true;
        },
        onRestoreVerified: () => failureEvents.push("restore-verified"),
      }),
      (error) => error === productError,
    );
    assert.ok(failureDiskBytes.equals(validBytes));
    assert.equal(failureAuthorityChecks, 1);
    assert.deepEqual(failureEvents.slice(-3), ["restore-write", "restore-readback", "restore-verified"]);
  }

  const restoreError = new Error("restore disk full");
  let successPublished = false;
  await assert.rejects(
    runCorruptImageSelectionCase({
      corruptPath: "/owned/corrupt.png",
      validBytes,
      corruptBytes,
      writeSource: async (_path, bytes) => {
        if (Buffer.from(bytes).equals(validBytes)) throw restoreError;
      },
      readSource: async () => assert.fail("failed restore must not claim readback"),
      runProductCase: async () => expectedResult,
      validateProductResult: () => undefined,
      hasRestoreAuthority: () => true,
    }).then(() => {
      successPublished = true;
    }),
    (error) => error === restoreError,
  );
  assert.equal(successPublished, false);

  const productFailure = new Error("known-complete product failure");
  const combinedRestoreFailure = new Error("combined restore failure");
  await assert.rejects(
    runCorruptImageSelectionCase({
      corruptPath: "/owned/corrupt.png",
      validBytes,
      corruptBytes,
      writeSource: async (_path, bytes) => {
        if (Buffer.from(bytes).equals(validBytes)) throw combinedRestoreFailure;
      },
      readSource: async () => assert.fail("failed restore must not claim readback"),
      runProductCase: async () => { throw productFailure; },
      validateProductResult: () => assert.fail("failed product must not validate"),
      hasRestoreAuthority: () => true,
    }),
    (error) => error === productFailure,
  );
  assert.deepEqual(
    productFailure.cleanupErrors.map(({ phase }) => phase),
    ["corrupt-image-source-restoration"],
  );

  const failureWrites = [];
  await assert.rejects(
    finalizeFunctionalSmoke({
      primaryError: productFailure,
      initialCleanupErrors: productFailure.cleanupErrors,
      cleanupSteps: [
        {
          phase: "image-selection-project-reset",
          run: async () => { throw new Error("project reset refused"); },
        },
      ],
      publishSuccess: async () => assert.fail("combined failure must not publish success"),
      writeFailure: async (failure) => failureWrites.push(failure),
    }),
    (error) => error === productFailure,
  );
  assert.deepEqual(
    failureWrites[0].cleanupErrors.map(({ phase }) => phase),
    ["corrupt-image-source-restoration", "image-selection-project-reset"],
  );

  const evidenceWriteError = new Error("failure publication disk full");
  const restorationDiagnostics = productFailure.cleanupErrors.filter(
    ({ phase }) => phase === "corrupt-image-source-restoration",
  );
  const diagnosticState = createFunctionalSmokeDiagnosticState();
  diagnosticState.cleanupErrors.push(...restorationDiagnostics);
  await assert.rejects(
    finalizeFunctionalSmoke({
      primaryError: productFailure,
      hasPrimaryError: true,
      diagnosticState,
      cleanupSteps: [],
      publishSuccess: async () => assert.fail("combined failure must not publish success"),
      writeFailure: (failure) => publishFunctionalSmokeFailure({
        ...failure,
        reportPath: "/owned/report.json",
        pendingReportPath: "/owned/report.pending.json",
        failurePath: "/owned/failure.json",
        mode: "image-selection",
        runId: "combined-failure",
        replaceReport: async () => { throw new Error("report replacement failed"); },
        writeFailureFile: async () => { throw evidenceWriteError; },
      }),
    }),
    (error) => error === productFailure,
  );
  const cliOutput = [];
  printFunctionalSmokeCliError(
    productFailure,
    diagnosticState,
    (line) => cliOutput.push(line),
  );
  assert.equal(cliOutput.length, 2);
  assert.match(cliOutput[0], /known-complete product failure/);
  const cliDiagnostics = JSON.parse(cliOutput[1]);
  assert.equal(cliDiagnostics.kind, "functional-smoke-finalization-diagnostics");
  assert.deepEqual(
    cliDiagnostics.cleanupErrors.map(({ phase }) => phase),
    [
      "corrupt-image-source-restoration",
      "image-selection-project-reset",
      "write-failure",
    ],
  );
  assert.deepEqual(
    cliDiagnostics.evidenceWriteErrors.map(({ phase }) => phase),
    ["failure-report", "failure-json"],
  );
  const boundedDiagnostics = JSON.parse(formatFunctionalSmokeCliDiagnostics({
    cleanupErrors: Array.from({ length: 20 }, (_, index) => ({
      phase: `cleanup-${index}`,
      error: "x".repeat(5000),
    })),
  }));
  assert.equal(boundedDiagnostics.cleanupErrors.length, 16);
  assert.equal(boundedDiagnostics.cleanupErrors[0].error.length, 4096);
  assert.match(
    functionalSource,
    /run\(\{ diagnosticState \}\)\.catch\(\(error\) => \{\s*printFunctionalSmokeCliError\(error, diagnosticState\);\s*process\.exitCode = 1;/,
  );
});

test("functional smoke preserves arbitrary primaries through restoration, publication, and CLI diagnostics", async () => {
  const functionalSource = await readFile(
    new URL("../scripts/cep-functional-smoke.mjs", import.meta.url),
    "utf8",
  );
  const functional = await import(
    "../scripts/cep-functional-smoke.mjs?arbitrary-primary-diagnostic-channel"
  );
  const validBytes = Buffer.from("valid image bytes");
  const corruptBytes = Buffer.from("corrupt image bytes");
  const captureRejection = async (promise, label) => {
    let rejected = false;
    let rejection;
    try {
      await promise;
    } catch (error) {
      rejected = true;
      rejection = error;
    }
    assert.equal(rejected, true, `${label} must reject`);
    return rejection;
  };

  for (const authority of [true, false]) {
    for (const primary of [0, false, null, undefined, ""]) {
      const label = `${String(primary)} / authority ${authority}`;
      const diagnosticState = { cleanupErrors: [], evidenceWriteErrors: [] };
      let diskBytes = Buffer.from(validBytes);
      let writes = 0;
      const rejection = await captureRejection(
        functional.runCorruptImageSelectionCase({
          corruptPath: "/owned/corrupt.png",
          validBytes,
          corruptBytes,
          diagnosticState,
          writeSource: async (_path, bytes) => {
            writes += 1;
            diskBytes = Buffer.from(bytes);
          },
          readSource: async () => Buffer.from(diskBytes),
          runProductCase: async () => { throw primary; },
          validateProductResult: () => assert.fail("thrown product result must not validate"),
          hasRestoreAuthority: () => authority,
        }),
        label,
      );
      assert.equal(rejection, primary, `${label} must preserve the exact primary value`);
      assert.equal(writes, authority ? 2 : 1, label);
      assert.ok(diskBytes.equals(authority ? validBytes : corruptBytes), label);
      assert.deepEqual(
        diagnosticState.cleanupErrors.map(({ phase }) => phase),
        authority ? [] : ["corrupt-image-source-restoration"],
        label,
      );
    }
  }

  for (const {
    label,
    primary,
    authority,
    failRestore,
  } of [
    {
      label: "frozen Error restoration refusal",
      primary: Object.freeze(new Error("frozen product failure")),
      authority: false,
      failRestore: false,
    },
    {
      label: "truthy primitive restoration failure",
      primary: "truthy product failure",
      authority: true,
      failRestore: true,
    },
    {
      label: "falsy primitive restoration refusal",
      primary: 0,
      authority: false,
      failRestore: false,
    },
  ]) {
    const diagnosticState = functional.createFunctionalSmokeDiagnosticState();
    const bodyRejection = await captureRejection(
      functional.runCorruptImageSelectionCase({
        corruptPath: "/owned/corrupt.png",
        validBytes,
        corruptBytes,
        diagnosticState,
        writeSource: async (_path, bytes) => {
          if (failRestore && Buffer.from(bytes).equals(validBytes)) {
            throw new Error("restoration write failed");
          }
        },
        readSource: async () => validBytes,
        runProductCase: async () => { throw primary; },
        validateProductResult: () => assert.fail("thrown product result must not validate"),
        hasRestoreAuthority: () => authority,
      }),
      `${label} body`,
    );
    assert.equal(bodyRejection, primary, `${label} body must preserve primary identity/value`);

    const finalRejection = await captureRejection(
      functional.finalizeFunctionalSmoke({
        primaryError: primary,
        hasPrimaryError: true,
        diagnosticState,
        cleanupSteps: [
          { phase: "later-cleanup", run: async () => { throw new Error("later cleanup failed"); } },
        ],
        publishSuccess: async () => assert.fail("a primary failure must not publish success"),
        writeFailure: (failure) => functional.publishFunctionalSmokeFailure({
          ...failure,
          reportPath: "/owned/report.json",
          pendingReportPath: "/owned/report.pending.json",
          failurePath: "/owned/failure.json",
          mode: "image-selection",
          runId: "diagnostic-run",
          replaceReport: async () => { throw new Error("report replacement failed"); },
          writeFailureFile: async () => { throw new Error("failure.json write failed"); },
          getFailureConsoleEvidence: () => null,
        }),
      }),
      `${label} finalization`,
    );
    assert.equal(finalRejection, primary, `${label} finalizer must preserve primary identity/value`);
    assert.deepEqual(
      diagnosticState.cleanupErrors.map(({ phase }) => phase),
      ["corrupt-image-source-restoration", "later-cleanup", "write-failure"],
      label,
    );
    assert.deepEqual(
      diagnosticState.evidenceWriteErrors.map(({ phase }) => phase),
      ["failure-report", "failure-json"],
      label,
    );

    const cliOutput = [];
    functional.printFunctionalSmokeCliError(
      primary,
      diagnosticState,
      (line) => cliOutput.push(line),
    );
    assert.equal(cliOutput.length, 2, label);
    assert.match(cliOutput[0], new RegExp(primary instanceof Error ? "frozen product failure" : String(primary)), label);
    const cliDiagnostics = JSON.parse(cliOutput[1]);
    assert.deepEqual(
      cliDiagnostics.cleanupErrors.map(({ phase }) => phase),
      ["corrupt-image-source-restoration", "later-cleanup", "write-failure"],
      label,
    );
    assert.deepEqual(
      cliDiagnostics.evidenceWriteErrors.map(({ phase }) => phase),
      ["failure-report", "failure-json"],
      label,
    );
  }

  let hostileCleanupReads = 0;
  let hostileEvidenceReads = 0;
  const hostilePrimary = new Error("hostile diagnostic properties");
  Object.defineProperties(hostilePrimary, {
    cleanupErrors: {
      get() {
        hostileCleanupReads += 1;
        throw new Error("cleanup diagnostic getter failed");
      },
    },
    evidenceWriteErrors: {
      get() {
        hostileEvidenceReads += 1;
        throw new Error("evidence diagnostic getter failed");
      },
    },
  });
  const hostileState = functional.createFunctionalSmokeDiagnosticState();
  const hostileRejection = await captureRejection(
    functional.runCorruptImageSelectionCase({
      corruptPath: "/owned/corrupt.png",
      validBytes,
      corruptBytes,
      diagnosticState: hostileState,
      writeSource: async () => undefined,
      readSource: async () => validBytes,
      runProductCase: async () => { throw hostilePrimary; },
      validateProductResult: () => assert.fail("thrown product result must not validate"),
      hasRestoreAuthority: () => false,
    }),
    "hostile diagnostic property access",
  );
  assert.equal(hostileRejection, hostilePrimary);
  assert.equal(hostileCleanupReads, 1);
  assert.equal(hostileEvidenceReads, 1);
  assert.deepEqual(
    hostileState.cleanupErrors.map(({ phase }) => phase),
    ["corrupt-image-source-restoration"],
  );
  assert.deepEqual(hostileState.evidenceWriteErrors, []);

  const malformedLedgerPrimary = new Error("malformed diagnostic ledgers");
  malformedLedgerPrimary.cleanupErrors = { phase: "not-an-array" };
  malformedLedgerPrimary.evidenceWriteErrors = "not-an-array";
  const malformedLedgerState = functional.createFunctionalSmokeDiagnosticState();
  const malformedLedgerRejection = await captureRejection(
    functional.runCorruptImageSelectionCase({
      corruptPath: "/owned/corrupt.png",
      validBytes,
      corruptBytes,
      diagnosticState: malformedLedgerState,
      writeSource: async () => undefined,
      readSource: async () => validBytes,
      runProductCase: async () => { throw malformedLedgerPrimary; },
      validateProductResult: () => assert.fail("thrown product result must not validate"),
      hasRestoreAuthority: () => false,
    }),
    "malformed diagnostic ledgers",
  );
  assert.equal(malformedLedgerRejection, malformedLedgerPrimary);
  assert.deepEqual(
    malformedLedgerState.cleanupErrors.map(({ phase }) => phase),
    ["corrupt-image-source-restoration"],
  );
  assert.deepEqual(malformedLedgerState.evidenceWriteErrors, []);

  let customStringReads = 0;
  const cyclicDiagnosticValue = {};
  cyclicDiagnosticValue.self = cyclicDiagnosticValue;
  const customStringValue = {
    toString() {
      customStringReads += 1;
      throw new Error("custom diagnostic toString must not run");
    },
  };
  let independentErrorReads = 0;
  const throwingPhaseDiagnostic = Object.create(null, {
    phase: {
      enumerable: true,
      get() { throw new Error("phase getter failed"); },
    },
    error: {
      enumerable: true,
      get() {
        independentErrorReads += 1;
        return "error survived unreadable phase";
      },
    },
  });
  let proxyFieldReads = 0;
  const throwingProxyDiagnostic = new Proxy({}, {
    get() {
      proxyFieldReads += 1;
      throw new Error("diagnostic proxy field failed");
    },
  });
  const hostileSnapshot = functional.snapshotFunctionalSmokeDiagnostics([
    throwingPhaseDiagnostic,
    { phase: cyclicDiagnosticValue, error: Symbol("diagnostic-symbol") },
    { phase: customStringValue, error: 12n },
    null,
    throwingProxyDiagnostic,
  ]);
  assert.deepEqual(hostileSnapshot, [
    { phase: "<unreadable-phase>", error: "error survived unreadable phase" },
    { phase: "<object>", error: "<symbol>" },
    { phase: "<object>", error: "12" },
    { phase: "<missing-phase>", error: "<missing-error>" },
    { phase: "<unreadable-phase>", error: "<unreadable-error>" },
  ]);
  assert.equal(independentErrorReads, 1, "phase and error must be read independently");
  assert.equal(proxyFieldReads, 2, "both hostile Proxy fields must be attempted independently");
  assert.equal(customStringReads, 0, "custom diagnostic coercion must never execute");
  assert.equal(Object.isFrozen(hostileSnapshot), true);
  assert.equal(hostileSnapshot.every(Object.isFrozen), true);
  assert.equal(
    hostileSnapshot.every((entry) => Object.getPrototypeOf(entry) === Object.prototype),
    true,
  );
  const hostileLedgerProxy = new Proxy([throwingPhaseDiagnostic], {
    get(target, property, receiver) {
      if (property === "0") throw new Error("ledger entry read failed");
      return Reflect.get(target, property, receiver);
    },
  });
  assert.deepEqual(functional.snapshotFunctionalSmokeDiagnostics(hostileLedgerProxy), [
    { phase: "<unreadable-phase>", error: "<unreadable-error>" },
  ]);
  const { proxy: revokedLedgerProxy, revoke } = Proxy.revocable([], {});
  revoke();
  assert.doesNotThrow(() => functional.snapshotFunctionalSmokeDiagnostics(revokedLedgerProxy));
  assert.deepEqual(functional.snapshotFunctionalSmokeDiagnostics(revokedLedgerProxy), []);
  const hostileDiagnosticState = new Proxy({}, {
    get() { throw new Error("diagnostic state ledger getter failed"); },
  });
  assert.doesNotThrow(() => functional.formatFunctionalSmokeCliDiagnostics(hostileDiagnosticState));
  assert.equal(functional.formatFunctionalSmokeCliDiagnostics(hostileDiagnosticState), null);

  const hostileImportedPrimary = new Error("hostile imported diagnostic primary");
  hostileImportedPrimary.cleanupErrors = [
    throwingPhaseDiagnostic,
    { phase: "cyclic-cleanup", error: cyclicDiagnosticValue },
  ];
  hostileImportedPrimary.evidenceWriteErrors = [
    { phase: Symbol("phase"), error: customStringValue },
    throwingProxyDiagnostic,
  ];
  const hostileImportedState = functional.createFunctionalSmokeDiagnosticState();
  const hostileHelperRejection = await captureRejection(
    functional.runCorruptImageSelectionCase({
      corruptPath: "/owned/corrupt.png",
      validBytes,
      corruptBytes,
      diagnosticState: hostileImportedState,
      writeSource: async () => undefined,
      readSource: async () => validBytes,
      runProductCase: async () => { throw hostileImportedPrimary; },
      validateProductResult: () => assert.fail("failed product must not validate"),
      hasRestoreAuthority: () => false,
    }),
    "hostile imported diagnostics helper",
  );
  assert.equal(hostileHelperRejection, hostileImportedPrimary);
  assert.equal(hostileImportedState.cleanupErrors[0], throwingPhaseDiagnostic);
  assert.equal(hostileImportedState.evidenceWriteErrors[1], throwingProxyDiagnostic);
  let hostilePublishedReport;
  let hostilePublishedFailure;
  const hostileFinalRejection = await captureRejection(
    functional.finalizeFunctionalSmoke({
      primaryError: hostileImportedPrimary,
      hasPrimaryError: true,
      diagnosticState: hostileImportedState,
      cleanupSteps: [],
      publishSuccess: async () => assert.fail("hostile primary must not publish success"),
      writeFailure: (failure) => functional.publishFunctionalSmokeFailure({
        ...failure,
        reportPath: "/owned/report.json",
        pendingReportPath: "/owned/report.pending.json",
        failurePath: "/owned/failure.json",
        mode: "image-selection",
        runId: "hostile-diagnostic-publication",
        replaceReport: async ({ report }) => { hostilePublishedReport = structuredClone(report); },
        writeFailureFile: async (_path, contents) => {
          hostilePublishedFailure = JSON.parse(contents);
        },
      }),
    }),
    "hostile imported diagnostics finalizer",
  );
  assert.equal(hostileFinalRejection, hostileImportedPrimary);
  for (const artifact of [hostilePublishedReport, hostilePublishedFailure]) {
    assert.equal(artifact.error.includes("hostile imported diagnostic primary"), true);
    assert.deepEqual(artifact.cleanupErrors.slice(0, 2), [
      { phase: "<unreadable-phase>", error: "error survived unreadable phase" },
      { phase: "cyclic-cleanup", error: "<object>" },
    ]);
    assert.deepEqual(artifact.evidenceWriteErrors, [
      { phase: "<symbol>", error: "<object>" },
      { phase: "<unreadable-phase>", error: "<unreadable-error>" },
    ]);
  }
  const hostileCliOutput = [];
  assert.doesNotThrow(() => functional.printFunctionalSmokeCliError(
    hostileImportedPrimary,
    hostileImportedState,
    (line) => hostileCliOutput.push(line),
  ));
  assert.match(hostileCliOutput[1], /<unreadable-phase>/);
  assert.match(hostileCliOutput[1], /<unreadable-error>/);
  assert.equal(customStringReads, 0, "publication and CLI must not execute custom coercion");

  const failedHostilePrimary = new Error("failed hostile publication primary");
  const failedHostileState = functional.createFunctionalSmokeDiagnosticState();
  failedHostileState.cleanupErrors.push(throwingPhaseDiagnostic);
  let failedSerializedFailure;
  const failedHostileRejection = await captureRejection(
    functional.finalizeFunctionalSmoke({
      primaryError: failedHostilePrimary,
      hasPrimaryError: true,
      diagnosticState: failedHostileState,
      cleanupSteps: [],
      publishSuccess: async () => assert.fail("failed hostile primary must not publish success"),
      writeFailure: (failure) => functional.publishFunctionalSmokeFailure({
        ...failure,
        reportPath: "/owned/report.json",
        pendingReportPath: "/owned/report.pending.json",
        failurePath: "/owned/failure.json",
        mode: "image-selection",
        runId: "failed-hostile-publication",
        replaceReport: async () => { throw new Error("hostile report write failed"); },
        writeFailureFile: async (_path, contents) => {
          failedSerializedFailure = JSON.parse(contents);
          throw new Error("hostile failure.json write failed");
        },
      }),
    }),
    "failed hostile publication finalizer",
  );
  assert.equal(failedHostileRejection, failedHostilePrimary);
  assert.deepEqual(
    failedHostileState.evidenceWriteErrors.map(({ phase }) => phase),
    ["failure-report", "failure-json"],
  );
  assert.deepEqual(
    failedHostileState.cleanupErrors.slice(1).map(({ phase }) => phase),
    ["write-failure"],
  );
  assert.deepEqual(
    failedSerializedFailure.evidenceWriteErrors.map(({ phase }) => phase),
    ["failure-report"],
    "failure.json serialization must contain diagnostics known before its own failed write",
  );
  const failedHostileCliOutput = [];
  assert.doesNotThrow(() => functional.printFunctionalSmokeCliError(
    failedHostilePrimary,
    failedHostileState,
    (line) => failedHostileCliOutput.push(line),
  ));
  const failedHostileCliDiagnostics = JSON.parse(failedHostileCliOutput[1]);
  assert.deepEqual(
    failedHostileCliDiagnostics.evidenceWriteErrors.map(({ phase }) => phase),
    ["failure-report", "failure-json"],
  );
  assert.deepEqual(
    failedHostileCliDiagnostics.cleanupErrors.map(({ phase }) => phase),
    ["<unreadable-phase>", "write-failure"],
  );

  const successfulPublicationState = functional.createFunctionalSmokeDiagnosticState();
  successfulPublicationState.cleanupErrors.push({ phase: "cleanup-seed", error: "cleanup failed" });
  successfulPublicationState.evidenceWriteErrors.push({
    phase: "evidence-seed",
    error: "earlier evidence failed",
  });
  let publishedReport;
  let publishedFailure;
  let successPublished = false;
  const publicationRejection = await captureRejection(
    functional.finalizeFunctionalSmoke({
      primaryError: 0,
      hasPrimaryError: true,
      diagnosticState: successfulPublicationState,
      cleanupSteps: [],
      publishSuccess: async () => { successPublished = true; },
      writeFailure: (failure) => functional.publishFunctionalSmokeFailure({
        ...failure,
        reportPath: "/owned/report.json",
        pendingReportPath: "/owned/report.pending.json",
        failurePath: "/owned/failure.json",
        mode: "image-selection",
        runId: "successful-failure-publication",
        replaceReport: async ({ report }) => { publishedReport = structuredClone(report); },
        writeFailureFile: async (_path, contents) => {
          publishedFailure = JSON.parse(contents);
        },
        getFailureConsoleEvidence: () => ({ logs: [] }),
      }),
    }),
    "successful failure publication",
  );
  assert.equal(publicationRejection, 0);
  assert.equal(successPublished, false);
  for (const publication of [publishedReport, publishedFailure]) {
    assert.equal(publication.error, "0");
    assert.deepEqual(publication.cleanupErrors, successfulPublicationState.cleanupErrors);
    assert.deepEqual(publication.evidenceWriteErrors, successfulPublicationState.evidenceWriteErrors);
  }

  assert.match(
    functionalSource,
    /const diagnosticState = createFunctionalSmokeDiagnosticState\(\);[^]*run\(\{ diagnosticState \}\)\.catch\(\(error\) => \{\s*printFunctionalSmokeCliError\(error, diagnosticState\)/,
    "the direct CLI must print the same run-scoped side channel passed into production",
  );
  assert.match(
    functionalSource,
    /publishFunctionalSmokeFailure\(\{[^]*diagnosticState[^]*\}\)/,
    "production finalization must call the exported failure publisher with the shared side channel",
  );
  assert.doesNotMatch(
    functionalSource,
    /if \(primaryError\)|if \(!primaryError/,
    "primary presence must never be inferred from truthiness",
  );
});

test("functional smoke error text is bounded deterministic and no-throw for hostile values", async () => {
  const functional = await import(
    "../scripts/cep-functional-smoke.mjs?hostile-error-text-normalization"
  );
  const captureRejection = async (promise, label) => {
    try {
      await promise;
    } catch (error) {
      return error;
    }
    assert.fail(`${label} must reject`);
  };
  const { proxy: revokedProxy, revoke } = Proxy.revocable({}, {});
  revoke();
  let stackReads = 0;
  let messageReads = 0;
  const throwingErrorFields = new Error("hidden");
  Object.defineProperties(throwingErrorFields, {
    stack: {
      configurable: true,
      get() {
        stackReads += 1;
        throw new Error("stack getter must remain contained");
      },
    },
    message: {
      configurable: true,
      get() {
        messageReads += 1;
        throw new Error("message getter must remain contained");
      },
    },
  });
  let customToStringCalls = 0;
  let customValueOfCalls = 0;
  const customCoercion = {
    toString() {
      customToStringCalls += 1;
      throw new Error("custom toString must not execute");
    },
    valueOf() {
      customValueOfCalls += 1;
      throw new Error("custom valueOf must not execute");
    },
  };
  const cyclicObject = {};
  cyclicObject.self = cyclicObject;
  const symbolStackError = new Error("safe message fallback");
  Object.defineProperty(symbolStackError, "stack", {
    configurable: true,
    get: () => Symbol("unsafe-stack"),
  });
  const hostileFunction = () => undefined;
  hostileFunction.toString = () => {
    customToStringCalls += 1;
    throw new Error("custom function toString must not execute");
  };

  for (const primary of [Object.freeze(new Error("frozen exact primary")), 0]) {
    const diagnosticState = functional.createFunctionalSmokeDiagnosticState();
    const helperRejection = await captureRejection(
      functional.runCorruptImageSelectionCase({
        corruptPath: "/owned/corrupt.png",
        validBytes: Buffer.from("valid"),
        diagnosticState,
        writeSource: async (_path, bytes) => {
          if (Buffer.from(bytes).equals(Buffer.from("valid"))) throw revokedProxy;
        },
        readSource: async () => assert.fail("failed restoration must not read back"),
        runProductCase: async () => { throw primary; },
        validateProductResult: () => assert.fail("failed product must not validate"),
        hasRestoreAuthority: () => true,
      }),
      "corrupt restoration hostile diagnostic",
    );
    assert.equal(helperRejection, primary, "restoration diagnostics must not replace the primary");

    let publishedReport;
    let publishedFailure;
    const finalRejection = await captureRejection(
      functional.finalizeFunctionalSmoke({
        primaryError: primary,
        hasPrimaryError: true,
        diagnosticState,
        cleanupSteps: [
          { phase: "throwing-error-fields", run: async () => { throw throwingErrorFields; } },
          { phase: "cyclic-object", run: async () => { throw cyclicObject; } },
        ],
        publishSuccess: async () => assert.fail("hostile primary must not publish success"),
        writeFailure: (failure) => functional.publishFunctionalSmokeFailure({
          ...failure,
          reportPath: "/owned/report.json",
          pendingReportPath: "/owned/report.pending.json",
          failurePath: "/owned/failure.json",
          mode: "image-selection",
          runId: "hostile-error-text",
          replaceReport: async ({ report }) => {
            publishedReport = structuredClone(report);
            throw customCoercion;
          },
          writeFailureFile: async (_path, contents) => {
            publishedFailure = JSON.parse(contents);
            throw Symbol("failure-json-write");
          },
        }),
      }),
      "hostile finalizer diagnostics",
    );
    assert.equal(finalRejection, primary, "finalization diagnostics must not replace the primary");
    assert.equal(typeof publishedReport.error, "string");
    assert.equal(typeof publishedFailure.error, "string");
    assert.deepEqual(
      diagnosticState.cleanupErrors.map(({ phase }) => phase),
      ["corrupt-image-source-restoration", "throwing-error-fields", "cyclic-object", "write-failure"],
    );
    assert.deepEqual(
      diagnosticState.evidenceWriteErrors.map(({ phase }) => phase),
      ["failure-report", "failure-json"],
    );
    const cliLines = [];
    assert.doesNotThrow(() => functional.printFunctionalSmokeCliError(
      primary,
      diagnosticState,
      (line) => cliLines.push(line),
    ));
    assert.equal(cliLines.length, 2);
    const printable = JSON.parse(cliLines[1]);
    assert.deepEqual(
      printable.cleanupErrors.map(({ phase }) => phase),
      ["corrupt-image-source-restoration", "throwing-error-fields", "cyclic-object", "write-failure"],
    );
    assert.deepEqual(
      printable.evidenceWriteErrors.map(({ phase }) => phase),
      ["failure-report", "failure-json"],
    );
  }

  for (const [label, primary, expectedText] of [
    ["revoked Proxy", revokedProxy, "<object>"],
    ["throwing Error fields", throwingErrorFields, "<error>"],
    ["custom coercion", customCoercion, "<object>"],
    ["Symbol", Symbol("hostile-primary"), "<symbol>"],
    ["cyclic object", cyclicObject, "<object>"],
    ["function", hostileFunction, "<function>"],
    ["Error symbol stack with safe message", symbolStackError, "safe message fallback"],
  ]) {
    let report;
    let failure;
    await functional.publishFunctionalSmokeFailure({
      reportPath: "/owned/report.json",
      pendingReportPath: "/owned/report.pending.json",
      failurePath: "/owned/failure.json",
      mode: "image-selection",
      runId: `hostile-primary-${label}`,
      primaryError: primary,
      hasPrimaryError: true,
      diagnosticState: functional.createFunctionalSmokeDiagnosticState(),
      replaceReport: async ({ report: value }) => { report = structuredClone(value); },
      writeFailureFile: async (_path, contents) => { failure = JSON.parse(contents); },
    });
    assert.equal(report.error, expectedText, label);
    assert.equal(failure.error, expectedText, label);
    const cliLines = [];
    assert.doesNotThrow(
      () => functional.printFunctionalSmokeCliError(
        primary,
        functional.createFunctionalSmokeDiagnosticState(),
        (line) => cliLines.push(line),
      ),
      label,
    );
    assert.deepEqual(cliLines, [expectedText], label);
  }
  const longPrimaryLines = [];
  functional.printFunctionalSmokeCliError(
    "x".repeat(5000),
    functional.createFunctionalSmokeDiagnosticState(),
    (line) => longPrimaryLines.push(line),
  );
  assert.equal(longPrimaryLines[0].length, 4096);
  assert.equal(stackReads > 0, true, "Error stack must be attempted");
  assert.equal(messageReads > 0, true, "Error message must be attempted independently");
  assert.equal(customToStringCalls, 0);
  assert.equal(customValueOfCalls, 0);
});

test("functional runtime completion authority requires a callable strict-true guard", async () => {
  const functionalSource = await readFile(
    new URL("../scripts/cep-functional-smoke.mjs", import.meta.url),
    "utf8",
  );
  const functional = await import(
    "../scripts/cep-functional-smoke.mjs?strict-runtime-completion-authority"
  );
  for (const [label, guard] of [
    ["missing", undefined],
    ["null", null],
    ["object without method", {}],
    ["non-callable method", { isCompletionKnown: true }],
    ["false", { isCompletionKnown: () => false }],
    ["throw", { isCompletionKnown: () => { throw new Error("guard failed"); } }],
    ["truthy non-Boolean", { isCompletionKnown: () => "true" }],
    ["promise", { isCompletionKnown: () => Promise.resolve(true) }],
  ]) {
    assert.equal(functional.isFunctionalSmokeRuntimeCompletionKnown(guard), false, label);
  }
  assert.equal(
    functional.isFunctionalSmokeRuntimeCompletionKnown({ isCompletionKnown: () => true }),
    true,
  );

  for (const [label, guard, shouldRestore] of [
    ["missing", undefined, false],
    ["non-callable", { isCompletionKnown: true }, false],
    ["installed strict true", { isCompletionKnown: () => true }, true],
  ]) {
    let writes = 0;
    const diagnostics = functional.createFunctionalSmokeDiagnosticState();
    let rejected = false;
    try {
      await functional.runCorruptImageSelectionCase({
        corruptPath: "/owned/corrupt.png",
        validBytes: Buffer.from("valid"),
        diagnosticState: diagnostics,
        writeSource: async () => { writes += 1; },
        readSource: async () => Buffer.from("valid"),
        runProductCase: async () => ({ ok: true }),
        validateProductResult: () => undefined,
        hasRestoreAuthority: () =>
          true && functional.isFunctionalSmokeRuntimeCompletionKnown(guard),
      });
    } catch {
      rejected = true;
    }
    assert.equal(rejected, !shouldRestore, label);
    assert.equal(writes, shouldRestore ? 2 : 1, label);
  }

  assert.doesNotMatch(
    functionalSource,
    /runtimeEvaluationGuard\?\.isCompletionKnown\(\) !== false/,
  );
  assert.match(
    functionalSource,
    /hasRestoreAuthority: \(\) =>\s*imageSelectionHostStateKnown && runtimeEvaluationCompletionKnown\(\)/,
    "production restoration authority must continue to combine host-known and runtime-known",
  );
});

test("functional image cleanup cannot remove an ID-matching item from a foreign project", async () => {
  const functional = await import("../scripts/cep-functional-smoke.mjs?foreign-image-project");
  const ownedProject = {};
  let removed = false;
  const foreignProject = {
    numItems: 1,
    item: () => ({ id: 37, remove: () => { removed = true; } }),
  };
  const dollar = {
    global: {
      __CHROMA_FUNCTIONAL_PROJECT_OWNER__: "run-token",
      __CHROMA_FUNCTIONAL_PROJECT__: ownedProject,
    },
  };
  const source = functional.guardImageSelectionProjectSource(
    "run-token",
    functional.removeProjectItemSource(37)
  );
  const raw = Function("$", "app", `return ${source}`)(dollar, { project: foreignProject });
  assert.deepEqual(JSON.parse(raw), {
    ok: false,
    reason: "image-selection-project-owner-mismatch",
  });
  assert.equal(removed, false);
});

test("functional smoke finalization withholds success and continues after restoration failures", async () => {
  const functional = await import("../scripts/cep-functional-smoke.mjs?s4-finalization-cleanup");
  const events = [];
  const failureWrites = [];

  await assert.rejects(
    functional.finalizeFunctionalSmoke({
      cleanupSteps: [
        {
          phase: "image-selection-project-reset",
          run: async () => {
            events.push("reset");
            throw new Error("reset failed");
          },
        },
        {
          phase: "cdp-close",
          run: async () => {
            events.push("close");
            throw new Error("close failed");
          },
        },
        { phase: "temporary-directory", run: async () => events.push("temporary-directory") },
      ],
      publishSuccess: async () => assert.fail("cleanup failure must not publish success"),
      writeFailure: async (failure) => {
        events.push("write-failure");
        failureWrites.push(failure);
      },
    }),
    (error) => error instanceof AggregateError && /cleanup failed/i.test(error.message)
  );

  assert.deepEqual(events, [
    "reset",
    "close",
    "temporary-directory",
    "write-failure",
  ]);
  assert.deepEqual(
    failureWrites[0].cleanupErrors.map(({ phase }) => phase),
    ["image-selection-project-reset", "cdp-close"]
  );
});

test("functional smoke finalization preserves the primary error with cleanup diagnostics", async () => {
  const functional = await import("../scripts/cep-functional-smoke.mjs?s4-finalization-primary");
  const primary = new Error("body failed");
  const failureWrites = [];

  await assert.rejects(
    functional.finalizeFunctionalSmoke({
      primaryError: primary,
      cleanupSteps: [
        { phase: "cdp-close", run: async () => { throw new Error("close failed"); } },
        { phase: "temporary-directory", run: async () => undefined },
      ],
      publishSuccess: async () => assert.fail("primary failure must not publish success"),
      writeFailure: async (failure) => failureWrites.push(failure),
    }),
    (error) => error === primary
  );

  assert.equal(failureWrites[0].primaryError, primary);
  assert.deepEqual(failureWrites[0].cleanupErrors.map(({ phase }) => phase), ["cdp-close"]);

  await assert.rejects(
    functional.finalizeFunctionalSmoke({
      primaryError: primary,
      cleanupSteps: [],
      publishSuccess: async () => assert.fail("primary failure must not publish success"),
      writeFailure: async () => { throw new Error("evidence disk full"); },
    }),
    (error) => error === primary
  );
  assert.deepEqual(
    primary.cleanupErrors.map(({ phase }) => phase),
    ["cdp-close", "write-failure"],
  );
});

test("functional smoke finalizer imports lower ledgers at every boundary in causal order", async () => {
  const functional = await import("../scripts/cep-functional-smoke.mjs?finalizer-lower-ledger-boundaries");
  const diagnostic = (phase) => ({ phase, error: `${phase} failed` });

  const directCleanup = diagnostic("direct-lower-cleanup");
  const directEvidence = diagnostic("direct-lower-evidence");
  const directPrimary = new Error("direct lower-layer primary");
  directPrimary.cleanupErrors = [directCleanup, directCleanup];
  directPrimary.evidenceWriteErrors = [directEvidence, directEvidence];
  const directState = functional.createFunctionalSmokeDiagnosticState();
  let directFailureVisibility;
  await assert.rejects(
    functional.finalizeFunctionalSmoke({
      primaryError: directPrimary,
      hasPrimaryError: true,
      diagnosticState: directState,
      initialCleanupErrors: [directCleanup],
      cleanupSteps: [],
      publishSuccess: async () => assert.fail("a direct primary must not publish success"),
      writeFailure: async (failure) => {
        directFailureVisibility = {
          primaryError: failure.primaryError,
          cleanup: [...failure.cleanupErrors],
          evidence: [...failure.evidenceWriteErrors],
        };
      },
    }),
    (error) => error === directPrimary,
  );
  assert.equal(directFailureVisibility.primaryError, directPrimary);
  assert.deepEqual(directFailureVisibility.cleanup, [directCleanup]);
  assert.deepEqual(directFailureVisibility.evidence, [directEvidence]);
  assert.equal(directPrimary.cleanupErrors, directState.cleanupErrors);
  assert.equal(directPrimary.evidenceWriteErrors, directState.evidenceWriteErrors);
  assert.deepEqual(directState.cleanupErrors, [directCleanup]);
  assert.deepEqual(directState.evidenceWriteErrors, [directEvidence]);

  const cleanupLowerCleanup = diagnostic("cleanup-catch-lower-cleanup");
  const cleanupLowerEvidence = diagnostic("cleanup-catch-lower-evidence");
  const cleanupThrown = new Error("cleanup step failed");
  cleanupThrown.cleanupErrors = [cleanupLowerCleanup, cleanupLowerCleanup];
  cleanupThrown.evidenceWriteErrors = [cleanupLowerEvidence, cleanupLowerEvidence];
  Object.freeze(cleanupThrown);
  const cleanupState = functional.createFunctionalSmokeDiagnosticState();
  let cleanupFailureVisibility;
  await assert.rejects(
    functional.finalizeFunctionalSmoke({
      diagnosticState: cleanupState,
      cleanupSteps: [{
        phase: "cleanup-step-current",
        run: async () => { throw cleanupThrown; },
      }],
      publishSuccess: async () => assert.fail("cleanup failure must not publish success"),
      writeFailure: async (failure) => {
        cleanupFailureVisibility = {
          cleanup: [...failure.cleanupErrors],
          evidence: [...failure.evidenceWriteErrors],
        };
      },
    }),
    (error) => error instanceof AggregateError,
  );
  assert.equal(cleanupFailureVisibility.cleanup[0], cleanupLowerCleanup);
  assert.deepEqual(
    cleanupFailureVisibility.cleanup.map(({ phase }) => phase),
    ["cleanup-catch-lower-cleanup", "cleanup-step-current"],
  );
  assert.match(cleanupFailureVisibility.cleanup[1].error, /cleanup step failed/);
  assert.deepEqual(cleanupFailureVisibility.evidence, [cleanupLowerEvidence]);
  assert.deepEqual(cleanupState.cleanupErrors, cleanupFailureVisibility.cleanup);
  assert.deepEqual(cleanupState.evidenceWriteErrors, [cleanupLowerEvidence]);

  const publishLowerCleanup = diagnostic("publish-catch-lower-cleanup");
  const publishLowerEvidence = diagnostic("publish-catch-lower-evidence");
  const publishPrimary = Object.create(null);
  Object.defineProperties(publishPrimary, {
    cleanupErrors: { get: () => [publishLowerCleanup, publishLowerCleanup] },
    evidenceWriteErrors: { get: () => [publishLowerEvidence, publishLowerEvidence] },
    [Symbol.toPrimitive]: {
      value: () => { throw new Error("publish primary must not be coerced"); },
    },
  });
  Object.freeze(publishPrimary);
  const publishState = functional.createFunctionalSmokeDiagnosticState();
  let publishFailureVisibility;
  await assert.rejects(
    functional.finalizeFunctionalSmoke({
      diagnosticState: publishState,
      cleanupSteps: [],
      publishSuccess: async () => { throw publishPrimary; },
      writeFailure: async (failure) => {
        publishFailureVisibility = {
          primaryError: failure.primaryError,
          cleanup: [...failure.cleanupErrors],
          evidence: [...failure.evidenceWriteErrors],
        };
      },
    }),
    (error) => error === publishPrimary,
  );
  assert.equal(publishFailureVisibility.primaryError, publishPrimary);
  assert.deepEqual(publishFailureVisibility.cleanup, [publishLowerCleanup]);
  assert.deepEqual(publishFailureVisibility.evidence, [publishLowerEvidence]);
  assert.deepEqual(publishState.cleanupErrors, [publishLowerCleanup]);
  assert.deepEqual(publishState.evidenceWriteErrors, [publishLowerEvidence]);

  const writeLowerCleanup = diagnostic("write-catch-lower-cleanup");
  const writeLowerEvidence = diagnostic("write-catch-lower-evidence");
  const writeThrown = new Error("failure publication failed");
  writeThrown.cleanupErrors = [writeLowerCleanup, writeLowerCleanup];
  writeThrown.evidenceWriteErrors = [writeLowerEvidence, writeLowerEvidence];
  Object.freeze(writeThrown);
  const writeState = functional.createFunctionalSmokeDiagnosticState();
  let writeFailureInput;
  let primitivePrimaryCaught = false;
  try {
    await functional.finalizeFunctionalSmoke({
      primaryError: 0,
      hasPrimaryError: true,
      diagnosticState: writeState,
      cleanupSteps: [],
      publishSuccess: async () => assert.fail("a primitive primary must not publish success"),
      writeFailure: async (failure) => {
        writeFailureInput = {
          primaryError: failure.primaryError,
          cleanup: [...failure.cleanupErrors],
          evidence: [...failure.evidenceWriteErrors],
        };
        throw writeThrown;
      },
    });
    assert.fail("the exact primitive primary must be rethrown");
  } catch (error) {
    primitivePrimaryCaught = true;
    assert.equal(error, 0);
  }
  assert.equal(primitivePrimaryCaught, true);
  assert.equal(writeFailureInput.primaryError, 0);
  assert.deepEqual(writeFailureInput.cleanup, []);
  assert.deepEqual(writeFailureInput.evidence, []);
  assert.equal(writeState.cleanupErrors[0], writeLowerCleanup);
  assert.deepEqual(
    writeState.cleanupErrors.map(({ phase }) => phase),
    ["write-catch-lower-cleanup", "write-failure"],
  );
  assert.match(writeState.cleanupErrors[1].error, /failure publication failed/);
  assert.deepEqual(writeState.evidenceWriteErrors, [writeLowerEvidence]);
});

test("functional smoke failure publisher imports lower ledgers before local diagnostics", async () => {
  const functional = await import("../scripts/cep-functional-smoke.mjs?publisher-lower-ledger-boundaries");
  const diagnostic = (phase) => ({ phase, error: `${phase} failed` });
  const base = {
    primaryError: new Error("product failed"),
    hasPrimaryError: true,
    reportPath: "/owned/report.json",
    pendingReportPath: "/owned/report.pending.json",
    failurePath: "/owned/failure.json",
    mode: "image-selection",
    runId: "publisher-ledger-test",
  };

  const reportCleanup = diagnostic("report-lower-cleanup");
  const reportEvidence = diagnostic("report-lower-evidence");
  const frozenReportError = new Error("report replacement failed");
  frozenReportError.cleanupErrors = [reportCleanup, reportCleanup];
  frozenReportError.evidenceWriteErrors = [reportEvidence, reportEvidence];
  Object.freeze(frozenReportError);
  const reportState = functional.createFunctionalSmokeDiagnosticState();
  let writtenFailure;
  await functional.publishFunctionalSmokeFailure({
    ...base,
    diagnosticState: reportState,
    replaceReport: async () => { throw frozenReportError; },
    writeFailureFile: async (_path, contents) => { writtenFailure = JSON.parse(contents); },
  });
  assert.deepEqual(reportState.cleanupErrors, [reportCleanup]);
  assert.equal(reportState.evidenceWriteErrors[0], reportEvidence);
  assert.deepEqual(
    reportState.evidenceWriteErrors.map(({ phase }) => phase),
    ["report-lower-evidence", "failure-report"],
  );
  assert.deepEqual(
    writtenFailure.cleanupErrors.map(({ phase }) => phase),
    ["report-lower-cleanup"],
  );
  assert.deepEqual(
    writtenFailure.evidenceWriteErrors.map(({ phase }) => phase),
    ["report-lower-evidence", "failure-report"],
  );

  const primitiveState = functional.createFunctionalSmokeDiagnosticState();
  await functional.publishFunctionalSmokeFailure({
    ...base,
    diagnosticState: primitiveState,
    replaceReport: async () => { throw 0; },
    writeFailureFile: async () => undefined,
  });
  assert.deepEqual(
    primitiveState.evidenceWriteErrors.map(({ phase, error }) => [phase, error]),
    [["failure-report", "0"]],
  );

  const jsonCleanup = diagnostic("json-lower-cleanup");
  const hostileEvidence = new Proxy({}, {
    get() { throw new Error("hostile diagnostic entry getter"); },
  });
  const failureJsonError = new Proxy(new Error("failure JSON failed"), {
    get(target, property, receiver) {
      if (property === "cleanupErrors") return [jsonCleanup, jsonCleanup];
      if (property === "evidenceWriteErrors") return [hostileEvidence, hostileEvidence];
      if (property === Symbol.toPrimitive) {
        return () => { throw new Error("failure JSON error must not be coerced"); };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const jsonState = functional.createFunctionalSmokeDiagnosticState();
  await assert.rejects(
    functional.publishFunctionalSmokeFailure({
      ...base,
      diagnosticState: jsonState,
      replaceReport: async () => undefined,
      writeFailureFile: async () => { throw failureJsonError; },
    }),
    (error) => error === failureJsonError,
  );
  assert.deepEqual(jsonState.cleanupErrors, [jsonCleanup]);
  assert.equal(jsonState.evidenceWriteErrors[0], hostileEvidence);
  assert.equal(jsonState.evidenceWriteErrors.length, 2);
  assert.equal(jsonState.evidenceWriteErrors[1].phase, "failure-json");
  assert.match(jsonState.evidenceWriteErrors[1].error, /failure JSON failed/);
});

test("functional smoke publishes success only after every cleanup stage", async () => {
  const functional = await import("../scripts/cep-functional-smoke.mjs?s4-finalization-success");
  const events = [];

  await functional.finalizeFunctionalSmoke({
    cleanupSteps: [
      { phase: "project-reset", run: async () => events.push("project-reset") },
      { phase: "cdp-close", run: async () => events.push("cdp-close") },
      { phase: "temporary-directory", run: async () => events.push("temporary-directory") },
    ],
    publishSuccess: async () => events.push("publish-success"),
    writeFailure: async () => assert.fail("successful finalization must not write failure evidence"),
  });

  assert.deepEqual(events, [
    "project-reset",
    "cdp-close",
    "temporary-directory",
    "publish-success",
  ]);
});

test("functional smoke treats success publication failure as the primary failure", async () => {
  const functional = await import("../scripts/cep-functional-smoke.mjs?s4-finalization-publication");
  const publicationError = new Error("publish failed");
  const failureWrites = [];

  await assert.rejects(
    functional.finalizeFunctionalSmoke({
      cleanupSteps: [{ phase: "temporary-directory", run: async () => undefined }],
      publishSuccess: async () => { throw publicationError; },
      writeFailure: async (failure) => failureWrites.push(failure),
    }),
    (error) => error === publicationError
  );

  assert.equal(failureWrites[0].primaryError, publicationError);
  assert.deepEqual(failureWrites[0].cleanupErrors, []);
});

test("functional smoke atomically replaces stale success before work and preserves non-success on promotion failure", async () => {
  const functional = await import("../scripts/cep-functional-smoke.mjs?s4-report-publication");
  const root = await mkdtemp(join(tmpdir(), "chroma-relay-functional-report-"));
  const reportPath = join(root, "report.json");
  const pendingReportPath = join(root, ".report-current.pending.json");

  try {
    await writeFile(reportPath, '{"capturedAt":"prior-run","passed":true}\n');
    await functional.replaceFunctionalSmokeReport({
      reportPath,
      pendingReportPath,
      report: { capturedAt: "current-run", passed: false, status: "running" },
    });
    assert.deepEqual(JSON.parse(await readFile(reportPath, "utf8")), {
      capturedAt: "current-run",
      passed: false,
      status: "running",
    });

    const publicationError = new Error("failure evidence could not be removed");
    await assert.rejects(
      functional.replaceFunctionalSmokeReport({
        reportPath,
        pendingReportPath,
        report: { capturedAt: "current-run", passed: true, status: "passed" },
        beforeCommit: async () => { throw publicationError; },
      }),
      (error) => error === publicationError
    );
    assert.deepEqual(JSON.parse(await readFile(reportPath, "utf8")), {
      capturedAt: "current-run",
      passed: false,
      status: "running",
    });
    await assert.rejects(lstat(pendingReportPath), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const functionalRunChildren = async (root) => {
  const children = [];
  for (const name of await readdir(root)) {
    if ((await lstat(join(root, name))).isDirectory()) children.push(join(root, name));
  }
  return children;
};

test("functional smoke invalid mode preserves existing output files and publishes in an owned child", async () => {
  const root = await mkdtemp(join(process.cwd(), ".chroma-relay-functional-invalid-mode-"));
  const reportPath = join(root, "report.json");

  try {
    await writeFile(reportPath, '{"capturedAt":"prior-run","passed":true,"status":"passed"}\n');
    const result = spawnSync(
      process.execPath,
      [
        resolve("scripts/cep-functional-smoke.mjs"),
        "--mode=unsupported",
        `--output=${relative(process.cwd(), root)}`,
      ],
      { cwd: process.cwd(), encoding: "utf8" }
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unsupported functional smoke mode: unsupported/);
    const [runDirectory] = await functionalRunChildren(root);
    assert.ok(runDirectory);
    const report = JSON.parse(await readFile(join(runDirectory, "report.json"), "utf8"));
    const failure = JSON.parse(await readFile(join(runDirectory, "failure.json"), "utf8"));
    assert.equal(JSON.parse(await readFile(reportPath, "utf8")).passed, true);
    assert.equal(report.passed, false);
    assert.equal(report.status, "failed");
    assert.equal(report.mode, "unsupported");
    assert.equal(failure.passed, false);
    assert.equal(
      (await readdir(runDirectory)).filter((name) => name.endsWith(".pending.json")).length,
      0
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("functional smoke parser failure preserves parent files and publishes in an owned child", async () => {
  const root = await mkdtemp(join(process.cwd(), ".chroma-relay-functional-invalid-cli-"));
  const reportPath = join(root, "report.json");

  try {
    await writeFile(reportPath, '{"capturedAt":"prior-run","passed":true,"status":"passed"}\n');
    const result = spawnSync(
      process.execPath,
      [
        resolve("scripts/cep-functional-smoke.mjs"),
        `--output=${relative(process.cwd(), root)}`,
        "--unknown=x",
      ],
      { cwd: process.cwd(), encoding: "utf8" }
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown runner option: unknown/);
    const [runDirectory] = await functionalRunChildren(root);
    assert.ok(runDirectory);
    const report = JSON.parse(await readFile(join(runDirectory, "report.json"), "utf8"));
    const failure = JSON.parse(await readFile(join(runDirectory, "failure.json"), "utf8"));
    assert.equal(JSON.parse(await readFile(reportPath, "utf8")).passed, true);
    assert.equal(report.passed, false);
    assert.equal(report.status, "failed");
    assert.equal(report.mode, "invalid-cli");
    assert.equal(failure.passed, false);
    assert.equal(
      (await readdir(runDirectory)).filter((name) => name.endsWith(".pending.json")).length,
      0
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("functional smoke normalized-equivalent duplicate outputs preserve parent files", async () => {
  const root = await mkdtemp(join(process.cwd(), ".chroma-relay-functional-duplicate-output-"));
  const reportPath = join(root, "report.json");
  const outputArgument = `--output=${relative(process.cwd(), root)}`;
  const equivalentOutputArgument = `--output=./${relative(process.cwd(), root)}`;

  try {
    await writeFile(reportPath, '{"capturedAt":"prior-run","passed":true,"status":"passed"}\n');
    const result = spawnSync(
      process.execPath,
      [resolve("scripts/cep-functional-smoke.mjs"), outputArgument, equivalentOutputArgument],
      { cwd: process.cwd(), encoding: "utf8" }
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Duplicate runner option: output/);
    const [runDirectory] = await functionalRunChildren(root);
    assert.ok(runDirectory);
    const report = JSON.parse(await readFile(join(runDirectory, "report.json"), "utf8"));
    const failure = JSON.parse(await readFile(join(runDirectory, "failure.json"), "utf8"));
    assert.equal(JSON.parse(await readFile(reportPath, "utf8")).passed, true);
    assert.equal(report.passed, false);
    assert.equal(report.status, "failed");
    assert.equal(report.mode, "invalid-cli");
    assert.equal(failure.passed, false);
    assert.equal(
      (await readdir(runDirectory)).filter((name) => name.endsWith(".pending.json")).length,
      0
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("functional smoke symlink-equivalent duplicate outputs preserve parent files", async () => {
  const root = await mkdtemp(join(process.cwd(), ".chroma-relay-functional-symlink-output-"));
  const aliasParent = await mkdtemp(join(process.cwd(), ".chroma-relay-functional-output-alias-"));
  const alias = join(aliasParent, "output-link");
  const secondAlias = join(aliasParent, "second-output-link");
  try {
    await symlink(root, alias, "dir");
    await symlink(root, secondAlias, "dir");
    const outputPairs = [
      [
        `--output=${relative(process.cwd(), root)}`,
        `--output=${relative(process.cwd(), alias)}`,
      ],
      [
        `--output=${relative(process.cwd(), alias)}`,
        `--output=${relative(process.cwd(), secondAlias)}`,
      ],
    ];
    for (const outputArgs of outputPairs) {
      for (const args of [outputArgs, [...outputArgs].reverse()]) {
        await writeFile(join(root, "report.json"), '{"passed":true,"status":"passed"}\n');
        await rm(join(root, "failure.json"), { force: true });
        const priorChildren = new Set(await functionalRunChildren(root));
        const result = spawnSync(
          process.execPath,
          [resolve("scripts/cep-functional-smoke.mjs"), ...args],
          { cwd: process.cwd(), encoding: "utf8" }
        );
        assert.equal(result.status, 1);
        assert.equal(JSON.parse(await readFile(join(root, "report.json"), "utf8")).passed, true);
        const [runDirectory] = (await functionalRunChildren(root)).filter((path) => !priorChildren.has(path));
        assert.ok(runDirectory);
        assert.equal(JSON.parse(await readFile(join(runDirectory, "failure.json"), "utf8")).passed, false);
      }
    }
  } finally {
    await rm(aliasParent, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("functional smoke invoked through a symlinked ancestor preserves parent files", async () => {
  const aliasRoot = await mkdtemp(join(tmpdir(), "chroma-relay-functional-entry-alias-"));
  const outputRoot = await mkdtemp(join(process.cwd(), ".chroma-relay-functional-alias-output-"));
  const repoAlias = join(aliasRoot, "repo-alias");
  const reportPath = join(outputRoot, "report.json");

  try {
    await symlink(process.cwd(), repoAlias, "dir");
    await writeFile(reportPath, '{"capturedAt":"prior-run","passed":true,"status":"passed"}\n');
    const result = spawnSync(
      process.execPath,
      [
        join(repoAlias, "scripts", "cep-functional-smoke.mjs"),
        `--output=${relative(process.cwd(), outputRoot)}`,
        "--unknown=x",
      ],
      { cwd: process.cwd(), encoding: "utf8" }
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown runner option: unknown/);
    assert.equal(JSON.parse(await readFile(reportPath, "utf8")).passed, true);
    const [runDirectory] = await functionalRunChildren(outputRoot);
    assert.ok(runDirectory);
    assert.equal(JSON.parse(await readFile(join(runDirectory, "failure.json"), "utf8")).passed, false);
  } finally {
    await rm(aliasRoot, { recursive: true, force: true });
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test("CDP self-test awaits canonical target selection and Settings does too", async () => {
  const result = spawnSync(
    process.execPath,
    [resolve("scripts/cep-cdp.mjs"), "self-test"],
    { cwd: process.cwd(), encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).passed, [
    "single exact target",
    "wrong page",
    "duplicate exact pages",
    "wrong runtime ID",
  ]);
  const source = await readFile(resolve("scripts/cep-cdp.mjs"), "utf8");
  assert.match(source, /const target = await selectTarget\(await getTargets\(panel\.port\), panel\)/);
  assert.match(source, /await waitForMainHostAction\(client, evaluationGuard\)/);
  assert.match(source, /terminalState\.pendingHostAction === null/);
  assert.match(source, /terminalState\.pendingPaletteMutation === false/);
  assert.match(source, /evaluationGuard\.quarantine\(\)/);
  assert.ok(
    source.indexOf("await waitForMainHostAction(client, evaluationGuard)") <
      source.indexOf('api.resetTestState()')
  );
});

test("design capture can target Settings without weakening the Main compositor gate", async () => {
  const source = await readFile(
    new URL("../scripts/cep-design-capture.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /allowed: \["output", "panel"\]/);
  assert.match(source, /options\.panel !== "main" && options\.panel !== "settings"/);
  assert.match(source, /const selectedPanels = options\.panel/);
  assert.match(source, /Main compositor is \$\{captureViewport\.width\}x\$\{captureViewport\.height\}/);
});

test("design capture selects only the canonical reviewed panel before reload", async () => {
  const design = await import("../scripts/cep-design-capture.mjs?s4-canonical-target");
  const canonical = resolve(tmpdir(), "reviewed", "main", "index.html");
  const foreign = resolve(tmpdir(), "foreign", "main", "index.html");
  const panel = { page: "main", port: 8198 };
  const target = (path) => ({
    type: "page",
    url: pathToFileURL(path).href,
    webSocketDebuggerUrl: "ws://canonical",
  });
  const realpathFn = async (path) => path;

  assert.equal(
    await design.selectDesignCaptureTarget([target(canonical)], panel, {
      expectedPage: canonical,
      realpathFn,
    }).then(({ url }) => url),
    pathToFileURL(canonical).href
  );
  await assert.rejects(
    design.selectDesignCaptureTarget([target(foreign)], panel, {
      expectedPage: canonical,
      realpathFn,
    }),
    /exactly one canonical target; found 0/
  );
});

test("design capture lifecycle returns only after successful cleanup", async () => {
  const design = await import("../scripts/cep-design-capture.mjs?s4-lifecycle-success");
  const events = [];
  const result = await design.runDesignCaptureLifecycle({
    capture: async () => {
      events.push("capture");
      return { passed: true };
    },
    cleanupSteps: [
      { phase: "close", run: async () => events.push("close") },
      { phase: "scratch", run: async () => events.push("scratch") },
    ],
    writeFailure: async () => assert.fail("successful capture must not write failure evidence"),
  });
  assert.deepEqual(events, ["capture", "close", "scratch"]);
  assert.deepEqual(result, { passed: true });
});

test("design capture lifecycle preserves primary failure and reports cleanup failures", async () => {
  const design = await import("../scripts/cep-design-capture.mjs?s4-lifecycle-primary");
  const primary = new Error("capture failed");
  const failureWrites = [];
  await assert.rejects(
    design.runDesignCaptureLifecycle({
      capture: async () => { throw primary; },
      cleanupSteps: [
        { phase: "close", run: async () => { throw new Error("close failed"); } },
        { phase: "scratch", run: async () => undefined },
      ],
      writeFailure: async (failure) => failureWrites.push(failure),
    }),
    (error) => error === primary
  );
  assert.equal(failureWrites.length, 1);
  assert.equal(failureWrites[0].primaryError, primary);
  assert.deepEqual(failureWrites[0].cleanupErrors.map((entry) => entry.phase), ["close"]);

  await assert.rejects(
    design.runDesignCaptureLifecycle({
      capture: async () => { throw primary; },
      cleanupSteps: [],
      writeFailure: async () => { throw new Error("evidence disk full"); },
    }),
    (error) => error === primary
  );
  assert.deepEqual(primary.cleanupErrors.map(({ phase }) => phase), ["write-failure"]);
});

test("design capture lifecycle fails when cleanup alone fails", async () => {
  const design = await import("../scripts/cep-design-capture.mjs?s4-lifecycle-cleanup");
  const failureWrites = [];
  await assert.rejects(
    design.runDesignCaptureLifecycle({
      capture: async () => ({ passed: true }),
      cleanupSteps: [
        { phase: "close", run: async () => { throw new Error("close failed"); } },
      ],
      writeFailure: async (failure) => failureWrites.push(failure),
    }),
    (error) => error instanceof AggregateError && /cleanup failed/i.test(error.message)
  );
  assert.equal(failureWrites.length, 1);
  assert.equal(failureWrites[0].primaryError, null);
  assert.equal(failureWrites[0].cleanupErrors[0].phase, "close");
});

test("Settings and persistence publish success only after exact restoration and cleanup", async () => {
  for (const script of ["cep-cdp.mjs", "cep-persistence-smoke.mjs"]) {
    const source = await readFile(resolve("scripts", script), "utf8");
    const pendingIndex = source.indexOf("pendingReport = {");
    const baselineIndex = source.indexOf("originalConfigRoots.set(");
    const restorationIndex = source.indexOf("originalConfigRoots.get(page)");
    const scratchCleanupIndex = source.indexOf(
      script === "cep-persistence-smoke.mjs"
        ? "for (const ownedScratch of [scratch, ...inactiveScratches])"
        : "await removeOwnedRunDirectory(scratch)",
      restorationIndex
    );
    const publicationIndex = source.lastIndexOf("JSON.stringify(pendingReport, null, 2)");
    assert.ok(baselineIndex > 0 && baselineIndex < pendingIndex, `${script} must capture baseline first`);
    assert.ok(pendingIndex < restorationIndex, `${script} must hold success pending before restoration`);
    assert.ok(restorationIndex < scratchCleanupIndex, `${script} must restore before deleting scratch`);
    assert.ok(scratchCleanupIndex < publicationIndex, `${script} must publish only after cleanup`);
    assert.match(source, /phase: `restore-config:\$\{page\}`/);
    assert.match(source, /failure-evidence/);
    assert.match(source, /writeFile\([^\n]*failureText\)/);
    if (script === "cep-persistence-smoke.mjs") {
      const identityIndex = source.indexOf('api.getIdentity()');
      const extensionCheckIndex = source.indexOf("identity.extensionId !== contract.product.panelIds[panel.page]", identityIndex);
      const buildCheckIndex = source.indexOf("identity.buildMarker !== EXPECTED_BUILD_MARKER", identityIndex);
      const resetIndex = source.indexOf("api.resetTestState()", identityIndex);
      assert.ok(identityIndex > 0 && identityIndex < extensionCheckIndex);
      assert.ok(extensionCheckIndex < buildCheckIndex && buildCheckIndex < resetIndex);
    }
  }
});

test("CDP inspect authenticates before mutation and publishes only after exact cleanup", async () => {
  const source = await readFile(resolve("scripts/cep-cdp.mjs"), "utf8");
  const inspectStart = source.indexOf("const inspectPanel = async");
  const runningIndex = source.indexOf('status: "running"', inspectStart);
  const allocationIndex = source.indexOf("scratch = await createOwnedTemporaryConfigDirectory", inspectStart);
  const identityIndex = source.indexOf("assertIdentity(initialIdentity, panel)", inspectStart);
  const latchIndex = source.indexOf("configMutationAttempted = true", identityIndex);
  const mutateIndex = source.indexOf("api.setTemporaryConfigRoot", latchIndex);
  const restoreIndex = source.indexOf("configRestored = true", mutateIndex);
  const closeIndex = source.indexOf("await client?.close()", restoreIndex);
  const removeIndex = source.indexOf("await removeOwnedRunDirectory(scratch)", closeIndex);
  const passIndex = source.indexOf("report.passed = true", removeIndex);
  const publishIndex = source.indexOf("reportPath,", passIndex);
  assert.ok(runningIndex < allocationIndex);
  assert.ok(allocationIndex < identityIndex && identityIndex < latchIndex && latchIndex < mutateIndex);
  assert.ok(mutateIndex < restoreIndex && restoreIndex < closeIndex && closeIndex < removeIndex);
  assert.ok(removeIndex < passIndex && passIndex < publishIndex);
});

test("temporary-config ownership is latched before mutating requests across maintained runners", async () => {
  const checks = [
    ["cep-functional-smoke.mjs", "configMutationAttempted = true", "api.setTemporaryConfigRoot"],
    ["cep-design-capture.mjs", "temporaryConfigInstalled = true", "api.setTemporaryConfigRoot"],
    ["cep-persistence-smoke.mjs", "configuredPanels.add(panel.page)", "api.setTemporaryConfigRoot"],
    ["cep-palette-management-smoke.mjs", "configMutationAttempted.add(client.page)", "api.setTemporaryConfigRoot"],
    ["diagnose-ae23-selection-restore.mjs", "configMutationAttempted = true", "api.setTemporaryConfigRoot"],
  ];
  for (const [script, latch, mutation] of checks) {
    const source = await readFile(resolve("scripts", script), "utf8");
    const latchIndex = source.indexOf(latch);
    const mutationIndex = source.indexOf(mutation, latchIndex);
    assert.ok(latchIndex > 0 && latchIndex < mutationIndex, `${script} must latch before mutation`);
  }
  for (const [script, latch, reset] of [
    ["cep-persistence-smoke.mjs", "configuredPanels.add(panel.page)", "api.resetTestState()"],
    ["cep-palette-management-smoke.mjs", "configMutationAttempted.add(client.page)", "api.resetTestState()"],
  ]) {
    const source = await readFile(resolve("scripts", script), "utf8");
    assert.ok(source.indexOf(latch) < source.indexOf(reset), `${script} must latch before reset`);
  }
});

test("maintained mutation runners reauthenticate the connected canonical runtime", async () => {
  const checks = [
    ["cep-cdp.mjs", "configMutationAttempted = true"],
    ["cep-functional-smoke.mjs", "configMutationAttempted = true"],
    ["cep-design-capture.mjs", "temporaryConfigInstalled = true"],
    ["cep-persistence-smoke.mjs", "configuredPanels.add(panel.page)"],
    ["cep-palette-management-smoke.mjs", "configMutationAttempted.add(client.page)"],
    ["cep-native-gradient-collect-smoke.mjs", "setupAttempted = true"],
    ["diagnose-ae23-selection-restore.mjs", "projectSetupAttempted = true"],
    ["diagnose-ae-selection-semantics.mjs", "hostResult = await hostEval(client, hostSource)"],
  ];
  for (const [script, firstMutation] of checks) {
    const source = await readFile(resolve("scripts", script), "utf8");
    const runtimeProof = source.indexOf("await assertCanonicalRuntimeUrl(");
    const mutation = source.indexOf(firstMutation);
    assert.ok(runtimeProof > 0, `${script} must authenticate the connected runtime URL`);
    assert.ok(runtimeProof < mutation, `${script} must authenticate runtime before mutation`);
  }
});

test("every maintained page reload is bounded by fresh pre- and post-reload identity proofs", async () => {
  const checks = [
    ["cep-cdp.mjs", "await assertIdentity(", "setTemporaryConfigRoot("],
    ["cep-functional-smoke.mjs", "await assertFunctionalRuntime(", "setTemporaryConfigRoot("],
    ["cep-design-capture.mjs", "await assertCanonicalRuntimeUrl(", "setTemporaryConfigRoot("],
    ["cep-palette-management-smoke.mjs", "await assertCanonicalRuntimeUrl(", "api.resetTestState()"],
    ["cep-native-gradient-collect-smoke.mjs", "await assertNativeGradientRuntime(", "evalHost(client"],
  ];
  for (const [script, identityProof, mutation] of checks) {
    const source = await readFile(resolve("scripts", script), "utf8");
    let previousReload = -1;
    let reload = source.indexOf('client.send("Page.reload"');
    assert.ok(reload > 0, `${script} must contain a reload to exercise this contract`);
    while (reload >= 0) {
      const preReloadProof = source.lastIndexOf(identityProof, reload);
      const postReloadProof = source.indexOf(identityProof, reload);
      const firstMutation = source.indexOf(mutation, reload);
      assert.ok(preReloadProof > previousReload, `${script} reload must follow fresh identity proof`);
      assert.ok(postReloadProof > reload, `${script} reload must be followed by identity proof`);
      assert.ok(
        firstMutation < 0 || postReloadProof < firstMutation,
        `${script} must reauthenticate after reload before mutation`
      );
      previousReload = reload;
      reload = source.indexOf('client.send("Page.reload"', reload + 1);
    }
  }
  const settingsSource = await readFile(resolve("scripts/cep-cdp.mjs"), "utf8");
  assert.match(settingsSource, /preReloadIdentity\.configRoot !== temporaryRoot/);
});

test("maintained config restoration uses authoritative readback before latching", async () => {
  for (const [script, minimumCalls] of [
    ["cep-cdp.mjs", 2],
    ["cep-functional-smoke.mjs", 1],
    ["cep-design-capture.mjs", 1],
    ["cep-persistence-smoke.mjs", 1],
    ["cep-palette-management-smoke.mjs", 1],
    ["diagnose-ae23-selection-restore.mjs", 1],
  ]) {
    const source = await readFile(resolve("scripts", script), "utf8");
    assert.ok(
      source.split("await restoreConfigRootWithReadback({").length - 1 >= minimumCalls,
      `${script} must restore through authoritative readback`
    );
    assert.match(source, /getIdentity\(\)\.configRoot/);
  }
  const nativeSource = await readFile(
    resolve("scripts/cep-native-gradient-collect-smoke.mjs"),
    "utf8"
  );
  assert.match(nativeSource, /restoredIdentity\.configRoot === originalConfigRoot/);
  assert.ok(
    nativeSource.indexOf("restoredIdentity.configRoot === originalConfigRoot") <
      nativeSource.indexOf("await removeOwnedRunDirectory(scratch)")
  );
});

test("maintained config runners quarantine unknown renderer completion before cleanup", async () => {
  for (const script of [
    "cep-cdp.mjs",
    "cep-design-capture.mjs",
    "cep-palette-management-smoke.mjs",
  ]) {
    const source = await readFile(resolve("scripts", script), "utf8");
    assert.match(source, /guardClientEvaluations/);
    assert.match(source, /isCompletionKnown\(\)/);
    assert.match(source, /completion is unknown;[^\n]*dispatch refused/);
  }
});

test("diagnostic failure evidence preserves primary errors with write diagnostics", async () => {
  for (const script of [
    "diagnose-ae23-selection-restore.mjs",
    "diagnose-ae-selection-semantics.mjs",
  ]) {
    const source = await readFile(resolve("scripts", script), "utf8");
    assert.match(source, /const evidenceWriteErrors = \[\]/);
    assert.match(source, /primaryError\.evidenceWriteErrors = evidenceWriteErrors/);
    assert.match(source, /throw primaryError/);
  }
  const cdpSource = await readFile(resolve("scripts/cep-cdp.mjs"), "utf8");
  assert.match(cdpSource, /phase: `failure-evidence:\$\{phase\}`/);
  assert.match(cdpSource, /primaryError\.cleanupErrors = cleanupErrors/);
  assert.match(cdpSource, /publicationError\.evidenceWriteErrors = evidenceWriteErrors/);
  for (const script of ["cep-persistence-smoke.mjs", "cep-palette-management-smoke.mjs"]) {
    const source = await readFile(resolve("scripts", script), "utf8");
    assert.match(source, /const evidenceWriteErrors = \[\]/);
    assert.match(source, /publicationError\.evidenceWriteErrors = evidenceWriteErrors/);
  }
});

test("palette smoke authenticates extension identity and restores exact roots before publication", async () => {
  const source = await readFile(resolve("scripts/cep-palette-management-smoke.mjs"), "utf8");
  const identityIndex = source.indexOf("baselineIdentity.extensionId, contract.product.panelIds[client.page]");
  const baselineIndex = source.indexOf("originalConfigRoots.set(client.page", identityIndex);
  const mutationIndex = source.indexOf("configMutationAttempted.add(client.page)", baselineIndex);
  const restoreIndex = source.indexOf("originalConfigRoots.get(client.page)", mutationIndex);
  const removeIndex = source.indexOf("await removeOwnedRunDirectory(scratch)", restoreIndex);
  const publishIndex = source.lastIndexOf("JSON.stringify(lifecycleResult.report, null, 2)");
  assert.ok(identityIndex > 0 && identityIndex < baselineIndex && baselineIndex < mutationIndex);
  assert.ok(mutationIndex < restoreIndex && restoreIndex < removeIndex && removeIndex < publishIndex);
});

test("persistence rotates temporary roots before retiring the active root and can roll back partial switches", async () => {
  const source = await readFile(resolve("scripts/cep-persistence-smoke.mjs"), "utf8");
  const createIndex = source.indexOf("const nextScratch = await createOwnedTemporaryConfigDirectory");
  const switchIndex = source.indexOf("setVerifiedConfigRoot(", createIndex);
  const switchReadbackIndex = source.indexOf('"persistence rotated config root"', switchIndex);
  const rollbackIndex = source.indexOf('"persistence rolled-back config root"', switchReadbackIndex);
  const retireIndex = source.indexOf("await removeOwnedRunDirectory(previousScratch)", switchIndex);
  assert.ok(
    createIndex > 0 &&
      createIndex < switchIndex &&
      switchIndex < switchReadbackIndex &&
      switchReadbackIndex < rollbackIndex &&
      rollbackIndex < retireIndex
  );
  assert.match(source, /const setVerifiedConfigRoot =[^]*restoreConfigRootWithReadback/);
  assert.match(source, /for \(const client of switchedClients\.reverse\(\)\)/);
  assert.match(source, /setVerifiedConfigRoot\([^]*previousScratch\.path/);
  assert.match(source, /inactiveScratches\.push\(nextScratch\)/);
  assert.match(source, /await setVerifiedConfigRoot\([^]*nextScratch\.path[^]*switchedClients\.push\(client\)/);
  assert.match(source, /const uncertainClients = new Set\(\)/);
  assert.match(source, /guardClientEvaluations\(client, `\$\{panel\.page\} persistence smoke`\)/);
  assert.match(source, /!evaluationGuards\.get\(client\)\?\.isCompletionKnown\(\)/);
  assert.match(source, /uncertainClients\.has\(client\)[^]*restoration dispatch refused/);
  assert.doesNotMatch(source, /rollbackErrors\.length === 0[^]*removeOwnedRunDirectory\(nextScratch\)/);
  assert.match(source, /ownedTemporaryRoots: \[scratch, \.\.\.inactiveScratches\]/);
});

test("design capture restores the accepted baseline before deleting temporary config", async () => {
  const source = await readFile(resolve("scripts/cep-design-capture.mjs"), "utf8");
  const reloadIndex = source.indexOf('client.send("Page.reload"');
  const baselineIndex = source.indexOf("originalConfigRoot = baselineIdentity.configRoot ?? null;");
  const installIndex = source.indexOf("temporaryConfigInstalled = true;");
  const restoreIndex = source.indexOf('phase: "restore-config"');
  const scratchIndex = source.indexOf('phase: "scratch"');
  assert.ok(baselineIndex > 0 && baselineIndex < reloadIndex && reloadIndex < installIndex);
  assert.ok(installIndex < restoreIndex && restoreIndex < scratchIndex);
  assert.match(source, /restoreConfigRootWithReadback\(\{/);
  assert.match(source, /getIdentity\(\)\.configRoot/);
});

test("palette lifecycle closes acquired clients and scratch after a partial second connect", async () => {
  const palette = await import("../scripts/cep-palette-management-smoke.mjs?s4-lifecycle-partial");
  const closed = [];
  const failureWrites = [];
  const primary = new Error("settings connect failed");
  const makeClient = (page) => ({ page, close: async () => closed.push(page) });
  await assert.rejects(
    palette.runPaletteManagementLifecycle({
      acquireClient: async (page, register) => {
        const client = makeClient(page);
        register(client);
        if (page === "settings") throw primary;
        return client;
      },
      execute: async () => assert.fail("the work phase must not run after partial connect"),
      cleanupClient: async (client) => client.close(),
      cleanupScratch: async () => closed.push("scratch"),
      writeFailure: async (failure) => failureWrites.push(failure),
    }),
    (error) => error === primary
  );
  assert.deepEqual(closed, ["settings", "main", "scratch"]);
  assert.equal(failureWrites[0].primaryError, primary);
});

test("palette lifecycle preserves nested cleanup diagnostics and primary precedence when evidence writing fails", async () => {
  const palette = await import("../scripts/cep-palette-management-smoke.mjs?s4-lifecycle-structured-failure");
  const primary = new Error("settings connect failed");
  const nested = new AggregateError(
    [new Error("settings close failed"), new AggregateError([new Error("deep close failed")], "nested close")],
    "settings cleanup"
  );
  const failureWrites = [];
  const makeClient = () => ({ close: async () => undefined });

  await assert.rejects(
    palette.runPaletteManagementLifecycle({
      acquireClient: async (page, register) => {
        const client = makeClient();
        register(client);
        if (page === "settings") throw primary;
        return client;
      },
      execute: async () => assert.fail("the work phase must not run after partial connect"),
      cleanupClient: async (client) => {
        if (client.page === "settings") throw nested;
      },
      cleanupScratch: async () => { throw new Error("scratch cleanup failed"); },
      writeFailure: async (failure) => {
        failureWrites.push(failure);
        throw new Error("failure writer failed");
      },
    }),
    (error) => error === primary
  );

  assert.equal(failureWrites.length, 1);
  const failure = failureWrites[0];
  assert.deepEqual(failure.clients.map((client) => client.page), ["main", "settings"]);
  assert.deepEqual(failure.cleanupErrors.map((entry) => entry.phase), [
    "close:settings",
    "scratch",
    "failure-evidence",
  ]);
  assert.equal(failure.cleanupErrors[0].error.name, "AggregateError");
  assert.equal(failure.cleanupErrors[0].error.errors[0].message, "settings close failed");
  assert.equal(failure.cleanupErrors[0].error.errors[1].errors[0].message, "deep close failed");
  assert.equal(failure.cleanupErrors[2].error.message, "failure writer failed");
});

test("palette lifecycle fails clearly when cleanup and failure evidence both fail without a primary", async () => {
  const palette = await import("../scripts/cep-palette-management-smoke.mjs?s4-lifecycle-cleanup-evidence");
  const failureWrites = [];
  await assert.rejects(
    palette.runPaletteManagementLifecycle({
      acquireClient: async (page, register) => {
        const client = { close: async () => undefined };
        register(client);
        return client;
      },
      execute: async () => ({ passed: true }),
      cleanupClient: async () => {
        throw new AggregateError([new Error("close failed")], "cleanup");
      },
      cleanupScratch: async () => { throw new Error("scratch failed"); },
      writeFailure: async (failure) => {
        failureWrites.push(failure);
        throw new Error("failure writer failed");
      },
    }),
    (error) =>
      error instanceof AggregateError &&
      /cleanup failed/i.test(error.message) &&
      error.errors.some((cause) => cause.message === "failure writer failed")
  );
  assert.deepEqual(failureWrites[0].cleanupErrors.map((entry) => entry.phase), [
    "close:settings",
    "close:main",
    "scratch",
    "failure-evidence",
  ]);
});

test("native-gradient fixture loading accepts exact hosts and owned newer-host conversions only", async () => {
  const { canLoadReviewedNativeGradientFixture, classifyNativeGradientFixtureLoad } = await import(
    "../scripts/cep-native-gradient-collect-smoke.mjs?fixture-load"
  );
  const fixtureCopy = "/tmp/chroma-relay-native/exact-identity-ae25.aep";
  const expectedVersion = "25.6.6x4";
  assert.equal(canLoadReviewedNativeGradientFixture(expectedVersion, expectedVersion), true);
  assert.equal(canLoadReviewedNativeGradientFixture("26.3x87", expectedVersion), true);
  assert.equal(canLoadReviewedNativeGradientFixture("25.5x4", expectedVersion), false);
  assert.equal(canLoadReviewedNativeGradientFixture("25.7x1", expectedVersion), false);
  assert.equal(canLoadReviewedNativeGradientFixture("27.0", expectedVersion), false);
  assert.equal(canLoadReviewedNativeGradientFixture("21.0", expectedVersion), false);
  assert.equal(canLoadReviewedNativeGradientFixture("invalid", "invalid"), false);
  const identity = { ok: true, compId: 1, selectedLayers: 2, selectedProperties: 0 };
  assert.deepEqual(
    classifyNativeGradientFixtureLoad({
      setup: {
        ...identity,
        version: expectedVersion,
        projectPath: fixtureCopy,
        dirty: false,
      },
      expectedVersion,
      fixtureCopy,
    }),
    { accepted: true, exact: true, converted: false, runtimeMajor: 25, expectedMajor: 25 },
  );
  assert.equal(
    classifyNativeGradientFixtureLoad({
      setup: { ...identity, version: "26.3x87", projectPath: null, dirty: true },
      expectedVersion,
      fixtureCopy,
    }).converted,
    true,
  );
  for (const setup of [
    { ...identity, version: "27.0", projectPath: null, dirty: true },
    { ...identity, version: "26.3x87", projectPath: fixtureCopy, dirty: true },
    { ...identity, version: "26.3x87", projectPath: null, dirty: true, compId: 99 },
  ]) {
    assert.equal(
      classifyNativeGradientFixtureLoad({ setup, expectedVersion, fixtureCopy }).accepted,
      false,
    );
  }
});

test("native-gradient cleanup requires panel restoration and retains scratch evidence", async () => {
  const gradient = await import("../scripts/cep-native-gradient-collect-smoke.mjs?s4-lifecycle-panel");
  const valid = gradient.assessNativeGradientCleanup({
    report: { passed: true },
    failure: null,
    setup: { ok: true },
    cleanup: {
      panel: { restored: true, loaded: { paletteRevision: 1 } },
      project: { restored: true },
      temp: { removed: true },
    },
  });
  assert.deepEqual(valid, {
    report: { passed: true },
    failure: null,
    retainScratch: false,
  });

  const primary = new Error("collection failed");
  const unrestored = gradient.assessNativeGradientCleanup({
    report: { passed: true },
    failure: primary,
    setup: { ok: true },
    cleanup: {
      panel: { restored: false, error: "reload failed" },
      project: { restored: true },
      temp: { removed: false, reason: "panel-state-unrestored" },
    },
  });
  assert.equal(unrestored.report, null);
  assert.equal(unrestored.failure, primary);
  assert.equal(unrestored.retainScratch, true);

  const cleanupOnly = gradient.assessNativeGradientCleanup({
    report: { passed: true },
    failure: null,
    setup: { ok: true },
    cleanup: {
      panel: { restored: false, error: "reload failed" },
      project: { restored: true },
      temp: { removed: false, reason: "panel-state-unrestored" },
    },
  });
  assert.equal(cleanupOnly.report, null);
  assert.match(cleanupOnly.failure.message, /cleanup failed/i);
  assert.equal(cleanupOnly.retainScratch, true);

  const reloadError = gradient.assessNativeGradientCleanup({
    report: { passed: true },
    failure: null,
    setup: { ok: true },
    cleanup: {
      panel: { restored: true, loaded: { error: "palette reload failed" } },
      project: { restored: true },
      temp: { removed: true },
    },
  });
  assert.equal(reloadError.report, null);
  assert.match(reloadError.failure.message, /cleanup failed/i);
  assert.equal(reloadError.retainScratch, true);
});

test("native-gradient cleanup retains scratch when host setup completion is unknown", async () => {
  const gradient = await import("../scripts/cep-native-gradient-collect-smoke.mjs?s4-lifecycle-unknown-setup");
  const primary = new Error("app.open completion unknown");
  const unknown = gradient.assessNativeGradientCleanup({
    report: { passed: true },
    failure: primary,
    setup: null,
    setupAttempted: true,
    cleanup: {
      panel: { restored: false, error: "reload failed" },
      project: { restored: false, error: "project restore failed" },
      temp: { removed: false, reason: "host-state-unknown" },
    },
  });
  assert.equal(unknown.report, null);
  assert.equal(unknown.failure, primary);
  assert.equal(unknown.retainScratch, true);

  const unknownCleanupOnly = gradient.assessNativeGradientCleanup({
    report: null,
    failure: null,
    setup: null,
    setupAttempted: true,
    cleanup: {
      panel: { restored: false },
      project: { restored: false },
      temp: { removed: false },
    },
  });
  assert.equal(unknownCleanupOnly.report, null);
  assert.match(unknownCleanupOnly.failure.message, /cleanup failed/i);
  assert.equal(unknownCleanupOnly.retainScratch, true);

  const preMutation = gradient.assessNativeGradientCleanup({
    report: { passed: true },
    failure: null,
    setup: null,
    setupAttempted: false,
    cleanup: {
      panel: { restored: true },
      project: { restored: true },
      temp: { removed: true },
    },
  });
  assert.deepEqual(preMutation, {
    report: { passed: true },
    failure: null,
    retainScratch: false,
  });
});

test("native-gradient setup reauthenticates its predecessor and cleanup honors close refusal", async () => {
  const source = await readFile(
    resolve("scripts/cep-native-gradient-collect-smoke.mjs"),
    "utf8"
  );
  const openStart = source.indexOf("const openFixtureSource =");
  const restoreStart = source.indexOf("const restoreProjectSource =");
  const openBody = source.slice(openStart, restoreStart);
  const restoreBody = source.slice(restoreStart, source.indexOf("const aeMajor", restoreStart));
  assert.match(openBody, /predecessor-project-drift/);
  assert.ok(openBody.indexOf("currentProjectState()") < openBody.indexOf("app.open(fixture)"));
  assert.match(source, /openFixtureSource\(fixtureCopy, originalProject, ownershipToken\)/);
  assert.match(source, /restoreProjectSource\(\s*originalProject,/);
  assert.match(source, /let cleanupDispatchAuthorized = false/);
  assert.match(openBody, /foreign-owner-present/);
  assert.match(openBody, /__CHROMA_NATIVE_GRADIENT_OWNER__/);
  assert.match(openBody, /fixtureOpened: true/);
  assert.match(
    source,
    /cleanupDispatchAuthorized =\s*setup\?\.ownershipClaimed === true && setup\?\.fixtureOpened === true/
  );
  assert.match(restoreBody, /native-gradient-owner-mismatch/);
  assert.match(restoreBody, /delete \$\.global\.__CHROMA_NATIVE_GRADIENT_OWNER__/);
  assert.match(source, /if \(!panelMutationAttempted\)[^]*panelCleanupCompletionKnown = true/);
  assert.match(
    source,
    /runtimeSave = await evalHost\([^]*cleanupDispatchAuthorized = true;\s*if \(\s*runtimeSave\.ok/
  );
  assert.match(
    source,
    /temporaryIdentity = await client\.evaluate[^]*cleanupDispatchAuthorized = true;\s*if \(temporaryIdentity\?\.configRoot !== temporaryRoot\)/
  );
  assert.match(source, /cleanupDispatchAuthorized = false;\s*const before = await evalHost/);
  assert.match(source, /cleanupDispatchAuthorized = false;\s*const after = await evalHost/);
  assert.match(source, /failure\.evidenceWriteErrors =/);
  assert.match(source, /if \(client && cleanupDispatchAuthorized && operationGuard\?\.isCompletionKnown\(\) !== false\)/);
  assert.match(source, /cleanup-dispatch-not-authorized/);
  assert.match(source, /snapshot\?\.state\?\.lastHostResult != null/);
  assert.match(source, /originalProject && panelCleanupCompletionKnown/);
  assert.match(source, /selectedPropertyPaths/);
  assert.match(restoreBody, /restoredLayer\.selectedProperties\.length !== wantedLayer\.selectedProperties/);
  assert.match(restoreBody, /foundItem\.selected = wantedItem\.selected === true/);
  assert.match(restoreBody, /var closed = app\.project\.close/);
  assert.match(restoreBody, /if \(closed !== true\)/);
  assert.ok(restoreBody.indexOf("previous.exists") < restoreBody.indexOf("app.project.close"));
  assert.match(restoreBody, /restored: emptyRestored/);
  assert.match(restoreBody, /restored: savedRestored/);
  assert.match(restoreBody, /exactFixtureTopology = app\.project\.numItems === 1/);
  assert.match(restoreBody, /JSON\.stringify\(snapshotComp\(active\)\)/);
  assert.match(restoreBody, /var ownedSavedCopy = app\.project\.file[^]*exactFixtureTopology/);
  assert.match(restoreBody, /app\.project\.close\(CloseOptions\.SAVE_CHANGES\)/);
  assert.match(source, /native-gradient fixture bytes drifted before restoration/);
  assert.match(source, /acceptedFixtureTopology = setup\.fixtureTopology/);
  assert.match(source, /fixture topology drifted after same-dispatch setup capture/);
  assert.match(source, /operationGuard = guardClientEvaluations\(client, "native-gradient smoke Main"\)/);
});

test("destructive fixture cleanup authenticates completed topology and exposes publication failures", async () => {
  const [formal, functional, nativeGradient, selection, ae23, cdp, palette, persistence] = await Promise.all([
    readFile(resolve("scripts/run-live-ae-tests.mjs"), "utf8"),
    readFile(resolve("scripts/cep-functional-smoke.mjs"), "utf8"),
    readFile(resolve("scripts/cep-native-gradient-collect-smoke.mjs"), "utf8"),
    readFile(resolve("scripts/diagnose-ae-selection-semantics.mjs"), "utf8"),
    readFile(resolve("scripts/diagnose-ae23-selection-restore.mjs"), "utf8"),
    readFile(resolve("scripts/cep-cdp.mjs"), "utf8"),
    readFile(resolve("scripts/cep-palette-management-smoke.mjs"), "utf8"),
    readFile(resolve("scripts/cep-persistence-smoke.mjs"), "utf8"),
  ]);

  assert.match(formal, /current\.dirty !== false[\s\S]*owned-project-topology-drift/);
  assert.match(formal, /expectedFinalOwnedProject = projectIdentity\(failureAfter\)/);
  assert.match(formal, /owned project bytes drifted before restoration/);
  assert.match(formal, /keyInTemporalEase/);
  assert.match(formal, /keySpatialContinuous/);
  assert.match(formal, /app\.project\.close\(CloseOptions\.SAVE_CHANGES\)/);
  assert.match(formal, /postCloseOwnedProjectHash/);
  assert.match(formal, /saved owned project drifted; temporary archive retained/);

  assert.match(functional, /captureSetupTopologySource/);
  assert.doesNotMatch(functional, /captureImageSelectionTopologySource/);
  assert.match(functional, /same-dispatch topology capture failed/);
  assert.match(functional, /keyInInterpolationType/);
  assert.match(functional, /keyOutTemporalEase/);
  assert.match(functional, /keyRoving/);

  assert.match(nativeGradient, /acceptedFixtureTopology = setup\.fixtureTopology/);
  assert.match(nativeGradient, /app\.project\.close\(CloseOptions\.SAVE_CHANGES\)/);
  assert.match(nativeGradient, /postCloseHashes/);
  assert.match(nativeGradient, /saved native-gradient fixture drifted; scratch archive retained/);
  assert.ok(
    nativeGradient.indexOf("runtimeSave = await evalHost") <
      nativeGradient.indexOf('dispatchClick("palette-add")'),
    "converted fixture must be saved before production descriptor collection"
  );
  assert.match(nativeGradient, /comment: layer\.comment/);
  assert.match(nativeGradient, /keyInTemporalEase/);
  assert.match(selection, /__CHROMA_SELECTION_SEMANTICS_SETUP_COMPLETE__/);
  assert.match(selection, /!setupComplete &&\s*isFinalOwnedItem/);
  assert.match(ae23, /__CHROMA_AE23_DIAGNOSTIC_SETUP_COMPLETE__/);
  assert.match(ae23, /!setupComplete &&\s*layerIndex === 1/);

  assert.match(nativeGradient, /Failure evidence publication also failed/);
  assert.match(nativeGradient, /JSON\.stringify\(error\.evidenceWriteErrors, null, 2\)/);
  for (const source of [cdp, palette, persistence]) {
    assert.match(source, /Failure evidence publication also failed/);
    assert.match(source, /error\?\.cleanupErrors/);
    assert.match(source, /startsWith\("failure-evidence/);
    assert.match(source, /JSON\.stringify\(evidenceDiagnostics, null, 2\)/);
  }
  for (const source of [selection, ae23]) {
    assert.match(source, /diagnosticProjectTopology/);
    assert.match(source, /owned-fixture-topology-drift/);
    assert.match(source, /keyInTemporalEase/);
  }
});

test("native-gradient restoration refuses a structurally substituted fixture before close", async () => {
  const gradient = await import("../scripts/cep-native-gradient-collect-smoke.mjs?foreign-fixture-topology");
  class CompItem {}
  let closeCount = 0;
  const project = {
    file: { fsName: "/owned/fixture.aep" },
    dirty: true,
    numItems: 99,
    activeItem: {},
    close: () => { closeCount += 1; return true; },
  };
  const source = gradient.restoreProjectSource(
    { projectPath: null },
    true,
    "/owned/fixture.aep",
    "/owned/runtime.aep",
    "run-token"
  );
  const raw = Function("$", "app", "CompItem", `return ${source}`)(
    {
      global: {
        __CHROMA_NATIVE_GRADIENT_OWNER__: "run-token",
        __CHROMA_NATIVE_GRADIENT_PREDECESSOR__: {},
      },
    },
    { project },
    CompItem
  );
  const result = JSON.parse(raw);
  assert.equal(result.restored, false);
  assert.equal(result.reason, "fixture-project-ownership-mismatch");
  assert.equal(closeCount, 0);
});

test("native-gradient restoration refuses topology drift and saves opaque edits before close", async () => {
  const gradient = await import("../scripts/cep-native-gradient-collect-smoke.mjs?nested-fixture-topology");
  class CompItem {
    constructor() {
      this.id = 1;
      this.name = "A3 Exact Identity Mixed AE25";
      this.width = 1920;
      this.height = 1080;
      this.pixelAspect = 1;
      this.duration = 1;
      this.frameRate = 24;
      this.bgColor = [0, 0, 0];
      this.layers = [
        { id: 14, name: "one", matchName: "ADBE AV Layer" },
        { id: 13, name: "two", matchName: "ADBE AV Layer" },
      ].map((layer, index) => ({
        ...layer,
        index: index + 1,
        source: null,
        enabled: true,
        locked: false,
        shy: false,
        solo: false,
        adjustmentLayer: false,
        guideLayer: false,
        threeDLayer: false,
        startTime: 0,
        inPoint: 0,
        outPoint: 1,
        stretch: 100,
        numProperties: 0,
      }));
      this.numLayers = this.layers.length;
    }
    layer(index) { return this.layers[index - 1]; }
  }
  let closeCount = 0;
  let closeOption = null;
  let persistedOpaquePayload = null;
  const comp = new CompItem();
  const project = {
    file: { fsName: "/owned/fixture.aep" },
    dirty: false,
    numItems: 1,
    activeItem: comp,
    opaquePayload: "baseline",
    close: (option) => {
      closeCount += 1;
      closeOption = option;
      persistedOpaquePayload = project.opaquePayload;
      return true;
    },
  };
  const app = {
    project,
    newProject() {
      this.project = { file: null, dirty: false, numItems: 0 };
    },
  };
  const dollar = {
    global: {
      __CHROMA_NATIVE_GRADIENT_OWNER__: "run-token",
      __CHROMA_NATIVE_GRADIENT_PREDECESSOR__: {},
    },
  };
  const closeOptions = { SAVE_CHANGES: "save", DO_NOT_SAVE_CHANGES: "discard" };
  const source = gradient.restoreProjectSource(
    { projectPath: null },
    true,
    "/owned/fixture.aep",
    "/owned/runtime.aep",
    "run-token",
    { nested: "different" }
  );
  const raw = Function("$", "app", "CompItem", "CloseOptions", `return ${source}`)(
    dollar,
    app,
    CompItem,
    closeOptions
  );
  const topologyResult = JSON.parse(raw);
  assert.equal(topologyResult.restored, false);
  assert.equal(topologyResult.reason, "fixture-project-ownership-mismatch");
  assert.equal(closeCount, 0);

  project.dirty = true;
  project.opaquePayload = "mutated";
  const opaqueCollisionSource = gradient.restoreProjectSource(
    { projectPath: null },
    true,
    "/owned/fixture.aep",
    "/owned/runtime.aep",
    "run-token",
    topologyResult.fixtureTopology
  );
  const opaqueCollisionRaw = Function(
    "$",
    "app",
    "CompItem",
    "CloseOptions",
    `return ${opaqueCollisionSource}`
  )(dollar, app, CompItem, closeOptions);
  const opaqueCollision = JSON.parse(opaqueCollisionRaw);
  assert.equal(opaqueCollision.restored, true);
  assert.equal(closeCount, 1);
  assert.equal(closeOption, closeOptions.SAVE_CHANGES);
  assert.equal(persistedOpaquePayload, "mutated");
});

test("AE23 selection diagnostic performs one bounded owned cleanup before success publication", async () => {
  const source = await readFile(
    resolve("scripts/diagnose-ae23-selection-restore.mjs"),
    "utf8"
  );
  const dispatchMarker = "actionDispatched = true;";
  const dispatchIndex = source.indexOf(dispatchMarker);
  assert.ok(dispatchIndex > 0, "diagnostic must latch before product dispatch");
  const targetSelectionIndex = source.indexOf("target = await selectCanonicalCdpTarget(");
  const connectIndex = source.indexOf("client = new CdpClient(");
  assert.ok(targetSelectionIndex > 0 && targetSelectionIndex < connectIndex);
  assert.equal(source.includes('pathname.endsWith("/main/index.html")'), false);
  assert.match(
    source.slice(dispatchIndex),
    /actionDispatched = true;\s*projectCleanupAuthorized = false;\s*const accepted = await client\.evaluate/
  );
  assert.match(source, /actionTerminalConfirmed && hostResult\?\.undoGroupClosed === true/);
  assert.match(source, /if \(client && projectCleanupAuthorized\)/);
  assert.match(source, /projectCleanupAuthorized = false;\s*projectCleanup = await client\.evaluate/);
  assert.match(source, /comp\.name !== "CHROMA_AE23_SELECTION_/);
  assert.match(source, /__CHROMA_AE23_DIAGNOSTIC_OWNER__/);
  assert.match(source, /comp\.comment !==/);
  const setupStart = source.indexOf("const setupSource =");
  const cleanupStart = source.indexOf("const cleanupSource =");
  const setupBody = source.slice(setupStart, cleanupStart);
  const cleanupBody = source.slice(cleanupStart, source.indexOf("let client = null", cleanupStart));
  assert.match(setupBody, /foreign-owner-present/);
  assert.match(setupBody, /cleanupSafe: undoCloseError === null/);
  assert.match(source, /setup = await hostEval\(client, setupSource\);\s*projectCleanupAuthorized = setup\?\.cleanupSafe === true/);
  assert.match(cleanupBody, /function exactPartialTarget/);
  assert.match(cleanupBody, /createdKinds = \["fill", "stroke"\]\.slice\(0, comp\.numLayers\)/);
  assert.ok(setupBody.indexOf("comp.comment =") < setupBody.indexOf("$.global.__CHROMA_AE23_DIAGNOSTIC_OWNER__ ="));
  assert.equal(cleanupBody.includes("alreadyClean"), false);
  assert.ok(cleanupBody.indexOf("app.version !==") < cleanupBody.indexOf("if (!app.project)"));
  assert.match(cleanupBody, /if \(!app\.project\) \{\s*return JSON\.stringify\(\{ ok: false, reason: "no-project" \}\)/);
  assert.match(cleanupBody, /app\.project\.file !== null/);
  assert.ok(
    cleanupBody.indexOf("app.project.save(archive)") <
      cleanupBody.indexOf("app.project.close(CloseOptions.SAVE_CHANGES)") &&
      cleanupBody.indexOf("app.project.close(CloseOptions.SAVE_CHANGES)") <
      cleanupBody.indexOf("delete $.global.__CHROMA_AE23_DIAGNOSTIC_OWNER__")
  );
  assert.match(source, /AE23 diagnostic label must be a lowercase safe token/);
  assert.equal(setupBody.includes("app.newProject()"), false);
  assert.ok(setupBody.indexOf("app.version !==") < setupBody.indexOf("!app.project"));
  const setupDispatchIndex = source.indexOf("setup = await hostEval(client, setupSource)");
  const configMutationIndex = source.indexOf("configMutationAttempted = true");
  assert.ok(setupDispatchIndex > 0 && setupDispatchIndex < configMutationIndex);
  assert.match(source, /projectSetupAttempted = true;\s*setup = await hostEval/);
  assert.match(source, /app\.project\.save\(archive\)/);
  assert.match(source, /app\.project\.close\(CloseOptions\.SAVE_CHANGES\)/);
  assert.match(source, /projectCleanup = await client\.evaluate/);
  assert.match(source, /restoreConfigRootWithReadback\(\{/);
  assert.match(source, /getIdentity\(\)\.configRoot/);
  assert.match(cleanupBody, /var closed = app\.project\.close/);
  assert.match(cleanupBody, /if \(closed !== true\)/);
  assert.match(cleanupBody, /layer\.comment !==/);
  assert.match(cleanupBody, /root\.numProperties !== 1/);
  assert.match(source, /await removeOwnedRunDirectory\(scratchRun\)/);
  assert.match(source, /harnessHostEvalAfterActionCount !== 0/);
  const cleanupIndex = source.indexOf("projectCleanup = await client.evaluate");
  const restoreIndex = source.indexOf("configRestored = true", cleanupIndex);
  const removeIndex = source.indexOf("scratchRemoved = true", restoreIndex);
  const publishIndex = source.lastIndexOf("await writeFile(reportPath");
  assert.ok(dispatchIndex < cleanupIndex && cleanupIndex < restoreIndex);
  assert.ok(restoreIndex < removeIndex && removeIndex < publishIndex);
  assert.match(source, /expectedTruncated/);
  assert.match(source, /layersTruncated/);
  assert.match(source, /actualTruncated/);
  assert.match(source, /cleanupErrors\.push\(\{ phase: "close"/);
});

test("AE23 diagnostic invalidates stale success before setup and defers success until close", async () => {
  const parent = await mkdtemp(join(tmpdir(), "chroma-relay-ae23-invalid-"));
  const output = join(parent, "evidence");
  const label = "transaction-probe";
  const reportPath = join(output, `${label}-report.json`);
  try {
    await mkdir(output, { recursive: true });
    await writeFile(reportPath, '{"passed":true,"capturedAt":"stale"}\n');
    const result = spawnSync(
      process.execPath,
      [resolve("scripts/diagnose-ae23-selection-restore.mjs"), join(output, "missing-repo"), label, "23.0", output],
      { cwd: process.cwd(), encoding: "utf8" }
    );
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(await readFile(reportPath, "utf8")), {
      passed: false,
      status: "running",
      label,
      expectedVersion: "23.0",
      port: "8198",
    });

    const source = await readFile(resolve("scripts/diagnose-ae23-selection-restore.mjs"), "utf8");
    const closeIndex = source.indexOf("if (client) await client.close()");
    const publishIndex = source.lastIndexOf("await writeFile(reportPath");
    assert.ok(closeIndex > 0 && closeIndex < publishIndex);
    assert.match(source, /for \(const \[phase, path\] of \[\["report", reportPath\], \["failure", failurePath\]\]\)/);
    assert.match(source, /try \{ await writeFile\(path, failureText\); \} catch \(error\)/);

    const escapedPath = join(parent, "escaped-report.json");
    const unsafe = spawnSync(
      process.execPath,
      [
        resolve("scripts/diagnose-ae23-selection-restore.mjs"),
        join(output, "missing-repo"),
        "../escaped",
        "23.0",
        output,
      ],
      { cwd: process.cwd(), encoding: "utf8" }
    );
    assert.equal(unsafe.status, 1);
    await assert.rejects(readFile(escapedPath, "utf8"), /ENOENT/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("raw AE selection-semantics diagnostic uses one evidence call and one token-owned cleanup", async () => {
  const staleOutput = await mkdtemp(join(process.cwd(), "selection-semantics-stale-"));
  const staleLabel = "stale-evidence";
  try {
    const staleReport = join(staleOutput, `${staleLabel}-report.json`);
    await writeFile(staleReport, '{"passed":true,"status":"passed"}\n');
    const failed = spawnSync(
      process.execPath,
      [
        resolve("scripts/diagnose-ae-selection-semantics.mjs"),
        join(staleOutput, "missing-repo"),
        staleLabel,
        "23.0",
        staleOutput,
      ],
      { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, APPDATA: staleOutput } }
    );
    assert.equal(failed.status, 1);
    assert.deepEqual(JSON.parse(await readFile(staleReport, "utf8")), {
      passed: false,
      status: "running",
      label: staleLabel,
      expectedVersion: "23.0",
      port: "8198",
    });
  } finally {
    await rm(staleOutput, { recursive: true, force: true });
  }
  const source = (
    await readFile(resolve("scripts/diagnose-ae-selection-semantics.mjs"), "utf8")
  ).replace(/\r\n/g, "\n");
  const targetSelectionIndex = source.indexOf("target = await selectCanonicalCdpTarget(");
  const connectIndex = source.indexOf("client = new CdpClient(");
  assert.ok(targetSelectionIndex > 0 && targetSelectionIndex < connectIndex);
  assert.equal(source.includes('pathname.endsWith("/main/index.html")'), false);
  assert.equal((source.match(/\.evalScript\(/g) || []).length, 2);
  assert.equal((source.match(/hostEval\(client, hostSource\)/g) || []).length, 1);
  const dispatchIndex = source.indexOf("hostResult = await hostEval(client, hostSource);");
  const cleanupIndex = source.indexOf("projectCleanup = await client.evaluate", dispatchIndex);
  const closeIndex = source.indexOf("if (client) await client.close()", cleanupIndex);
  const publishIndex = source.lastIndexOf("await writeFile(reportPath");
  assert.ok(dispatchIndex > 0, "probe must dispatch its one evidence host call");
  assert.ok(cleanupIndex > dispatchIndex && closeIndex > cleanupIndex && publishIndex > closeIndex);
  for (const forbidden of [
    "applyPreset(",
    "executeCommand(",
    "app.open(",
    "setTemporaryConfigRoot(",
    "removeOwnedRunDirectory(",
    "rm(scratch",
  ]) {
    assert.equal(
      source.includes(forbidden),
      false,
      `selection-semantics diagnostic contains forbidden operation: ${forbidden}`
    );
  }
  assert.match(source, /MAX_SELECTED_PROPERTIES = 32/);
  assert.match(source, /Selection-semantics label must be a lowercase safe token/);
  assert.match(source, /current-project-not-empty-clean/);
  assert.match(source, /app\.project\.file !== null/);
  assert.match(source, /unexpected-ae-version/);
  assert.ok(
    source.indexOf("app.version !== EXPECTED_VERSION") < source.indexOf("app.beginUndoGroup("),
    "exact AE version must be checked before fixture mutation"
  );
  assert.match(source, /__CHROMA_SELECTION_SEMANTICS_OWNER__/);
  assert.match(source, /comp\.comment =/);
  assert.match(source, /layer\.comment = OWNER_TOKEN/);
  assert.match(source, /var OWNER_TOKEN = \$\{JSON\.stringify\(ownershipToken\)\}/);
  assert.match(source, /item\.comment !==/);
  assert.match(source, /item\.name !== expectedNames\[itemIndex - 1\]/);
  assert.match(source, /root\.numProperties !== 1/);
  assert.match(source, /app\.project\.save\(archive\)/);
  assert.match(source, /app\.project\.close\(CloseOptions\.SAVE_CHANGES\)/);
  const rawCleanupStart = source.indexOf("const cleanupSource =");
  const rawCleanupBody = source.slice(rawCleanupStart, source.indexOf("const caseSpecs =", rawCleanupStart));
  assert.ok(rawCleanupBody.indexOf("app.version !==") < rawCleanupBody.indexOf("if (!app.project)"));
  assert.match(rawCleanupBody, /if \(!app\.project\) \{\s*return JSON\.stringify\(\{ ok: false, reason: "no-project" \}\)/);
  assert.ok(
    rawCleanupBody.indexOf("app.project.save(archive)") <
      rawCleanupBody.indexOf("app.project.close(CloseOptions.SAVE_CHANGES)") &&
      rawCleanupBody.indexOf("app.project.close(CloseOptions.SAVE_CHANGES)") <
      rawCleanupBody.indexOf("delete $.global.__CHROMA_SELECTION_SEMANTICS_OWNER__")
  );
  assert.match(rawCleanupBody, /var closed = app\.project\.close/);
  assert.match(rawCleanupBody, /if \(closed !== true\)/);
  assert.match(source, /stage = "end-undo";\s*undoOpened = false;\s*undoCompletionKnown = false;\s*app\.endUndoGroup\(\);\s*undoCompletionKnown = true;/);
  assert.match(
    source,
    /if \(undoOpened\) \{\s*undoOpened = false;\s*undoCompletionKnown = false;\s*try \{\s*app\.endUndoGroup\(\);\s*undoCompletionKnown = true;/
  );
  assert.match(source, /cleanupSafe: closeError === null && undoCompletionKnown/);
  assert.match(source, /hostCleanupAuthorized = hostResult\?\.cleanupSafe === true/);
  assert.match(source, /if \(client && hostCleanupAuthorized && operationGuard\?\.isCompletionKnown\(\) !== false\)/);
  assert.match(source, /foreign-owner-present/);
  assert.match(rawCleanupBody, /function exactPartialTarget/);
  assert.match(rawCleanupBody, /layerIndex <= item\.numLayers/);
  assert.match(rawCleanupBody, /isFinalOwnedItem &&\s*layerIndex === 1 &&\s*exactPartialTarget/);
  assert.match(rawCleanupBody, /createdKinds = kinds\.slice\(0, item\.numLayers\)/);
  assert.match(source, /throw new Error\("selected-properties-over-limit"\)/);
  assert.match(source, /throw new Error\("selected-property-path-invalid"\)/);
  assert.match(source, /validateHostResult\(hostResult\)/);
  assert.match(source, /installedPanelPath = await realpath/);
  assert.match(source, /targetPanelPath = await realpath\(fileURLToPath\(targetUrl\)\)/);
  assert.match(source, /Main CDP target resolved to the wrong panel/);
  assert.match(source, /groupMatchNamePath/);
  assert.match(source, /leafMatchNamePath/);
  assert.match(source, /current\.matchName !== expectedMatchNames\[index\]/);
  assert.match(source, /harnessHostEvalCount !== 1/);
  assert.match(source, /harnessHostEvalAfterResultCount !== 0/);
  assert.match(source, /for \(const \[phase, path\] of \[\["report", reportPath\], \["failure", failurePath\]\]\)/);
  assert.match(source, /try \{ await writeFile\(path, failureText\); \} catch \(error\)/);
  assert.match(source, /panelConfigChanged: false/);
  for (const caseName of [
    "fill-leaf-only",
    "stroke-leaf-only",
    "fill-parent-only",
    "stroke-parent-only",
    "fill-parent-then-leaf",
    "stroke-parent-then-leaf",
    "fill-leaf-then-parent-off",
    "stroke-leaf-then-parent-off",
    "fill-then-stroke",
    "stroke-then-fill",
  ]) {
    assert.match(source, new RegExp(`runCase\\(\"${caseName}\"`));
  }

  const validatorStart = source.indexOf("const caseSpecs = [");
  const validatorEnd = source.indexOf("\n\nlet client = null;", validatorStart);
  assert.ok(validatorStart > 0 && validatorEnd > validatorStart);
  const { caseSpecs, validateHostResult } = new Function(
    `${source.slice(validatorStart, validatorEnd)}\nreturn { caseSpecs, validateHostResult };`
  )();
  const emptySnapshot = () => ({
    selectedLayerCount: 0,
    selectedPropertyCount: 0,
    truncated: false,
    layers: [],
  });
  const selectedSnapshot = (layerCount) => ({
    selectedLayerCount: layerCount,
    selectedPropertyCount: 0,
    truncated: false,
    layers: Array.from({ length: layerCount }, (_, index) => ({
      layerId: 1000 + index,
      layerIndex: index + 1,
      layerName: `Layer ${index + 1}`,
      selected: true,
      properties: [],
    })),
  });
  const validResult = {
    projectItemCount: 10,
    projectDirty: true,
    caseCount: caseSpecs.length,
    cases: caseSpecs.map((spec) => ({
      name: spec.name,
      baseline: emptySnapshot(),
      steps: spec.operations.map(([target, scope, requested]) => ({
        target,
        scope,
        requested,
        selectedAfterSet: requested,
        layerSelectedAfterSet: true,
        snapshot: selectedSnapshot(spec.maximumLayerCount),
      })),
      insideUndo: selectedSnapshot(spec.maximumLayerCount),
      afterUndo: selectedSnapshot(spec.maximumLayerCount),
    })),
  };
  assert.equal(validateHostResult(validResult), null);

  const mutate = (callback) => {
    const candidate = structuredClone(validResult);
    callback(candidate);
    return validateHostResult(candidate);
  };
  assert.match(
    mutate((candidate) => {
      candidate.cases[0].steps[0].target = "stroke";
    }),
    /case-step-invalid-fill-leaf-only/
  );
  assert.match(
    mutate((candidate) => {
      candidate.cases[0].insideUndo.selectedLayerCount = 0;
    }),
    /snapshot-selected-layer-count-mismatch/
  );
  assert.match(
    mutate((candidate) => {
      candidate.cases[8].insideUndo.layers[1].layerId =
        candidate.cases[8].insideUndo.layers[0].layerId;
    }),
    /snapshot-layer-identity-duplicate/
  );
  assert.match(
    mutate((candidate) => {
      candidate.cases[0].afterUndo.truncated = true;
    }),
    /snapshot-missing-or-truncated/
  );
});
