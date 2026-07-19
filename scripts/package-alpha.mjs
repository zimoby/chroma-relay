#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import packageJson from "../package.json" with { type: "json" };

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceRoot = resolve(repoRoot, "dist/cep");
const alphaRoot = resolve(repoRoot, "dist/alpha");
const bundleRoot = resolve(alphaRoot, packageJson.name);
const archiveName = `Chroma Relay_${packageJson.version}-unsigned.zip`;
const archivePath = resolve(alphaRoot, archiveName);

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
    source.includes("Force Reload")
  ) {
    throw new Error(`Release debug surface found in ${relative(bundleRoot, filePath)}`);
  }
}

const zipped = spawnSync("/usr/bin/zip", ["-qry", archivePath, packageJson.name], {
  cwd: alphaRoot,
  encoding: "utf8",
});
if (zipped.status !== 0) {
  throw new Error(zipped.stderr || zipped.stdout || "zip failed");
}

const archiveBytes = await readFile(archivePath);
const report = {
  passed: true,
  artifact: archivePath,
  bytes: archiveBytes.length,
  sha256: createHash("sha256").update(archiveBytes).digest("hex"),
  bundleFiles: relativeFiles.length,
  iconPaths: [...new Set(iconPaths)],
  forbiddenFiles: [],
  debugSurface: false,
};
await writeFile(resolve(alphaRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
