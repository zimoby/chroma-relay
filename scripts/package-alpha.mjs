#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import packageJson from "../package.json" with { type: "json" };
import contract from "../src/shared/product-contract.json" with { type: "json" };
import {
  assertCleanSourceStatus,
  repositoryRelativePath,
} from "./lib/alpha-package-policy.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceRoot = resolve(repoRoot, "dist/cep");
const alphaRoot = resolve(repoRoot, "dist/alpha");
const bundleRoot = resolve(alphaRoot, packageJson.name);
const archiveName = `${contract.product.displayName}_${packageJson.version}-unsigned.zip`;
const archivePath = resolve(alphaRoot, archiveName);

const runChecked = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `${command} failed`);
  }
  return result.stdout.trim();
};

const commit = runChecked("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
const sourceStatus = runChecked("git", ["status", "--porcelain=v1", "-uall"], {
  cwd: repoRoot,
});
assertCleanSourceStatus(sourceStatus);
const dirty = false;
const nodeVersion = process.version;

const walk = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(entryPath)));
    else files.push(entryPath);
  }
  return files;
};

const assertInsideBundle = (filePath) => {
  const pathFromBundle = relative(bundleRoot, filePath);
  if (pathFromBundle.startsWith(`..${sep}`) || pathFromBundle === "..") {
    throw new Error(`Manifest resource escapes the extension bundle: ${filePath}`);
  }
};

const isForbiddenReleasePath = (filePath) =>
  filePath === ".debug" || filePath.endsWith(".map");

await stat(sourceRoot);
const sourceFiles = await walk(sourceRoot);
const forbiddenSourceFiles = sourceFiles
  .map((filePath) => relative(sourceRoot, filePath))
  .filter(isForbiddenReleasePath);
if (forbiddenSourceFiles.length > 0) {
  throw new Error(
    `Raw CEP build contains forbidden files: ${forbiddenSourceFiles.join(", ")}`
  );
}

await rm(alphaRoot, { recursive: true, force: true });
await mkdir(dirname(bundleRoot), { recursive: true });
await cp(sourceRoot, bundleRoot, { recursive: true });

const files = await walk(bundleRoot);
const relativeFiles = files.map((filePath) => relative(bundleRoot, filePath));
const forbiddenFiles = relativeFiles.filter(isForbiddenReleasePath);
if (forbiddenFiles.length > 0) {
  throw new Error(`Release bundle contains forbidden files: ${forbiddenFiles.join(", ")}`);
}

const manifestPath = resolve(bundleRoot, "CSXS/manifest.xml");
const manifest = await readFile(manifestPath, "utf8");
if (manifest.includes(">undefined<")) {
  throw new Error("CEP manifest contains undefined resource paths");
}
const manifestBundleId = manifest.match(/ExtensionBundleId="([^"]+)"/)?.[1];
const manifestBundleVersion = manifest.match(/ExtensionBundleVersion="([^"]+)"/)?.[1];
if (manifestBundleId !== packageJson.name || manifestBundleVersion !== packageJson.version) {
  throw new Error("Package identity does not match the CEP manifest");
}

const iconPaths = [...manifest.matchAll(/<Icon Type="[^"]+">([^<]+)<\/Icon>/g)].map(
  (match) => match[1]
);
if (iconPaths.length === 0) throw new Error("CEP manifest contains no icon resources");
for (const iconPath of iconPaths) {
  const resolvedIcon = resolve(bundleRoot, iconPath.replace(/^\.\//, ""));
  assertInsideBundle(resolvedIcon);
  await stat(resolvedIcon);
}

const textFiles = files.filter((filePath) => /\.(?:cjs|js|html)$/i.test(filePath));
for (const filePath of textFiles) {
  const source = await readFile(filePath, "utf8");
  if (
    source.includes("__CHROMA_RELAY_DEBUG__") ||
    source.includes("VITE_CHROMA_RELAY_DEBUG") ||
    source.includes("process.abort()") ||
    source.includes("Force Reload") ||
    /\.at\s*\(/.test(source)
  ) {
    throw new Error(`Release-incompatible surface found in ${relative(bundleRoot, filePath)}`);
  }
}

const zipped = spawnSync("/usr/bin/zip", ["-qry", archivePath, packageJson.name], {
  cwd: alphaRoot,
  encoding: "utf8",
});
if (zipped.status !== 0) {
  throw new Error(zipped.stderr || zipped.stdout || "zip failed");
}

runChecked("/usr/bin/unzip", ["-tqq", archivePath]);
const archiveInventory = runChecked("/usr/bin/unzip", ["-Z1", archivePath])
  .split(/\r?\n/)
  .filter((entry) => entry && !entry.endsWith("/"))
  .sort();
const expectedInventory = relativeFiles
  .map((filePath) => `${packageJson.name}/${filePath.replaceAll("\\", "/")}`)
  .sort();
if (JSON.stringify(archiveInventory) !== JSON.stringify(expectedInventory)) {
  throw new Error("Archive inventory differs from the packaged bundle");
}

const archiveBytes = await readFile(archivePath);
const report = {
  passed: true,
  commit,
  dirty,
  nodeVersion,
  manifest: {
    bundleId: manifestBundleId,
    version: manifestBundleVersion,
  },
  artifact: repositoryRelativePath(repoRoot, archivePath),
  bytes: archiveBytes.length,
  sha256: createHash("sha256").update(archiveBytes).digest("hex"),
  bundleFiles: relativeFiles.length,
  archiveInventory,
  iconPaths: [...new Set(iconPaths)],
  forbiddenFiles: [],
  debugSurface: false,
};
await writeFile(resolve(alphaRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
