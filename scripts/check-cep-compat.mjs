#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const sourceRoots = [
  "src/js/main",
  "src/js/settings",
  "src/js/shared",
  "src/js/lib/cep",
  "src/js/lib/utils/bolt.ts",
];
const forbiddenApis = [
  { pattern: /\bstructuredClone\s*\(/, name: "structuredClone" },
  { pattern: /\.replaceAll\s*\(/, name: "String.replaceAll" },
  { pattern: /\bPromise\.(?:any|allSettled)\s*\(/, name: "new Promise static method" },
  { pattern: /\bObject\.(?:hasOwn|fromEntries)\s*\(/, name: "new Object static method" },
  { pattern: /\.at\s*\(/, name: "Array/String.at" },
  { pattern: /\bcrypto\.randomUUID\s*\(/, name: "crypto.randomUUID" },
  { pattern: /\bAbortSignal\.timeout\s*\(/, name: "AbortSignal.timeout" },
  { pattern: /\bqueueMicrotask\s*\(/, name: "queueMicrotask" },
  { pattern: /\b(?:WeakRef|FinalizationRegistry)\b/, name: "weak-reference API" },
];

const collectFiles = async (relativePath) => {
  const absolutePath = resolve(ROOT, relativePath);
  if (extname(absolutePath)) return [absolutePath];
  const entries = await readdir(absolutePath, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? collectFiles(`${relativePath}/${entry.name}`)
        : [resolve(absolutePath, entry.name)]
    )
  );
  return nested.flat().filter((path) => /\.(?:ts|tsx)$/.test(path));
};

const failures = [];
const cepConfig = await readFile(resolve(ROOT, "cep.config.ts"), "utf8");
const viteConfig = await readFile(resolve(ROOT, "vite.config.ts"), "utf8");
if (!/name:\s*"AEFT",\s*version:\s*"\[22\.0,99\.9\]"/.test(cepConfig)) {
  failures.push("cep.config.ts must declare AEFT [22.0,99.9]");
}
if (!/target:\s*"chrome74"/.test(viteConfig)) {
  failures.push("vite.config.ts must retain the conservative chrome74 target");
}

const files = (await Promise.all(sourceRoots.map(collectFiles))).flat();
for (const file of files) {
  const source = await readFile(file, "utf8");
  for (const forbidden of forbiddenApis) {
    if (forbidden.pattern.test(source)) {
      failures.push(`${file.slice(ROOT.length + 1)} uses ${forbidden.name}`);
    }
  }
}

const hostBundlePath = resolve(ROOT, "dist/cep/jsx/index.js");
const hostBundle = await readFile(hostBundlePath, "utf8");
const hostSyntaxChecks = [
  { pattern: /=>/, name: "arrow function" },
  { pattern: /\bconst\s+/, name: "const declaration" },
  { pattern: /\blet\s+/, name: "let declaration" },
  { pattern: /\?\./, name: "optional chaining" },
  { pattern: /\?\?/, name: "nullish coalescing" },
  { pattern: /\bObject\.keys\s*\(/, name: "Object.keys call" },
];
for (const check of hostSyntaxChecks) {
  if (check.pattern.test(hostBundle)) {
    failures.push(`dist/cep/jsx/index.js still contains an ES3-incompatible ${check.name}`);
  }
}

const report = {
  passed: failures.length === 0,
  hostFloor: "AEFT 22.0",
  browserTarget: "chrome74",
  scannedSourceFiles: files.length,
  hostBundle: "dist/cep/jsx/index.js",
  failures,
};
console.log(JSON.stringify(report, null, 2));
if (failures.length) process.exitCode = 1;
