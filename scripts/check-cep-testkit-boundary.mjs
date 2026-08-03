#!/usr/bin/env node

import { readFile, readdir, lstat } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const CEP_TESTKIT_PACKAGE = "@zimoby/cep-testkit";
export const CEP_TESTKIT_VERSION = "0.1.0";
export const CEP_TESTKIT_INTEGRITY = "sha512-nwaLaPND2LsHeXHZY5aS/jMfq6YhqYSoZcBapDnvyEUTl51RVxD06aR55k7+ZBhzDeRAjBeLs08W9VeOq66bAw==";
export const CEP_TESTKIT_RESOLVED = "https://registry.npmjs.org/@zimoby/cep-testkit/-/cep-testkit-0.1.0.tgz";

const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const EXACT_PACKAGE_TOKEN = new RegExp(`(?<![A-Za-z0-9._-])${CEP_TESTKIT_PACKAGE}(?![A-Za-z0-9._-])`);

const propertyName = (property) => {
  if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) return property.name.text;
  return null;
};

const findNamedProperty = (source, name) => {
  const file = ts.createSourceFile("contract.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found = null;
  const visit = (node) => {
    if (found) return;
    if (ts.isPropertyAssignment(node) && propertyName(node) === name) found = node;
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
};

const hasPackageImport = (source, fileName) => {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found = false;
  const checkSpecifier = (value) => {
    const text = value?.text;
    if (typeof text === "string" && (text === CEP_TESTKIT_PACKAGE || text.startsWith(`${CEP_TESTKIT_PACKAGE}/`))) {
      found = true;
    }
  };
  const visit = (node) => {
    if (found) return;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      checkSpecifier(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      checkSpecifier(node.moduleReference.expression);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.Identifier &&
      node.expression.text === "require" &&
      node.arguments.length === 1
    ) {
      checkSpecifier(node.arguments[0]);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1
    ) {
      checkSpecifier(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found || EXACT_PACKAGE_TOKEN.test(source);
};

const assertExactArrayProperty = (source, name) => {
  const property = findNamedProperty(source, name);
  return Boolean(property && ts.isArrayLiteralExpression(property.initializer) && property.initializer.elements.length === 0);
};

const assertPackagesTopology = (source) => {
  const property = findNamedProperty(source, "packages");
  if (!property) return false;
  const text = property.initializer.getText().replace(/\s+/g, "");
  return text === "cepConfig.installModules||[]";
};

export const boundaryFailures = ({
  packageJson,
  lock,
  cepConfigSource,
  viteConfigSource,
  sourceFiles = [],
}) => {
  const failures = [];
  const dependencies = packageJson?.dependencies ?? {};
  const devDependencies = packageJson?.devDependencies ?? {};
  if (dependencies[CEP_TESTKIT_PACKAGE] !== undefined) {
    failures.push("package must not be a production dependency");
  }
  if (devDependencies[CEP_TESTKIT_PACKAGE] !== CEP_TESTKIT_VERSION) {
    failures.push("package must be an exact 0.1.0 devDependency");
  }

  const root = lock?.packages?.[""];
  const locked = lock?.packages?.[`node_modules/${CEP_TESTKIT_PACKAGE}`];
  if (root?.dependencies?.[CEP_TESTKIT_PACKAGE] !== undefined) {
    failures.push("lock root must not place the package in dependencies");
  }
  if (root?.devDependencies?.[CEP_TESTKIT_PACKAGE] !== CEP_TESTKIT_VERSION) {
    failures.push("lock root must place the exact package in devDependencies");
  }
  if (
    locked?.version !== CEP_TESTKIT_VERSION ||
    locked?.resolved !== CEP_TESTKIT_RESOLVED ||
    locked?.integrity !== CEP_TESTKIT_INTEGRITY ||
    locked?.dev !== true
  ) {
    failures.push("lock package record must match the exact registry artifact and integrity");
  }

  if (!assertExactArrayProperty(cepConfigSource, "installModules")) {
    failures.push("cep.config.ts installModules must be an empty array");
  }
  if (cepConfigSource.includes(CEP_TESTKIT_PACKAGE)) {
    failures.push("cep.config.ts must not mention the testkit");
  }
  if (!assertPackagesTopology(viteConfigSource)) {
    failures.push("Vite packages topology must derive only from cepConfig.installModules");
  }
  if (viteConfigSource.includes(CEP_TESTKIT_PACKAGE) || viteConfigSource.includes("node_modules/@zimoby/cep-testkit")) {
    failures.push("Vite copy/package topology must not mention the testkit");
  }
  for (const file of sourceFiles) {
    if (file.symbolicLink === true) {
      failures.push(`production source tree contains a symlink: ${file.path}`);
      continue;
    }
    if (hasPackageImport(file.source, file.path)) failures.push(`production source imports the testkit: ${file.path}`);
  }
  return failures;
};

const walk = async (root, callback) => {
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink()) {
    callback(root, rootStat, null);
    return;
  }
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      callback(path, stat, null);
    } else if (stat.isDirectory()) {
      await walk(path, callback);
    } else if (stat.isFile()) {
      callback(path, stat, await readFile(path));
    }
  }
};

export const productionDistFailures = async (distRoot) => {
  const failures = [];
  let rootStat;
  try {
    rootStat = await lstat(distRoot);
  } catch (error) {
    failures.push(`fresh production dist is missing: ${distRoot}`);
    return failures;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    failures.push("fresh production dist must be a real directory");
    return failures;
  }
  await walk(distRoot, (path, stat, contents) => {
    const relativePath = relative(distRoot, path).replaceAll("\\", "/");
    if (stat.isSymbolicLink()) {
      failures.push(`production dist contains a symlink: ${path}`);
      return;
    }
    if (relativePath.includes(CEP_TESTKIT_PACKAGE) || relativePath.includes("cep-testkit")) {
      failures.push(`production dist contains a testkit package path: ${path}`);
    }
    if (contents && /@zimoby\/cep-testkit|node_modules[\\/]@zimoby[\\/]cep-testkit/.test(contents.toString("utf8"))) {
      failures.push(`production dist contains testkit/package source text: ${path}`);
    }
  });
  return failures;
};

export const collectSourceFiles = async (root) => {
  const files = [];
  await walk(root, (path, stat, contents) => {
    if (stat.isSymbolicLink()) {
      files.push({ path, symbolicLink: true });
      return;
    }
    if (stat.isFile() && SOURCE_EXTENSIONS.has(extname(path))) files.push({ path, source: contents.toString("utf8") });
  });
  return files;
};

const run = async () => {
  const repositoryRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
  const packageJson = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(join(repositoryRoot, "package-lock.json"), "utf8"));
  const sourceFiles = await collectSourceFiles(join(repositoryRoot, "src"));
  const failures = boundaryFailures({
    packageJson,
    lock,
    cepConfigSource: await readFile(join(repositoryRoot, "cep.config.ts"), "utf8"),
    viteConfigSource: await readFile(join(repositoryRoot, "vite.config.ts"), "utf8"),
    sourceFiles,
  });
  failures.push(...await productionDistFailures(join(repositoryRoot, "dist", "cep")));
  if (failures.length > 0) {
    console.error("CEP testkit boundary failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
  } else {
    console.log("CEP testkit boundary passed: development-only package is excluded from production source and dist.");
  }
};

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) await run();
