#!/usr/bin/env node

import { lstat, readdir, readFile, realpath, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import productContract from "../src/shared/product-contract.json" with { type: "json" };
import { removeOwnedRunDirectory } from "./lib/live-runner-policy.mjs";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const MARKER_FILE = productContract.runner.markerFile;
const EVIDENCE_ROOT = resolve(REPO_ROOT, "evidence/local/native-gradient/track-b-apply-ae25");
const TEMPORARY_ROOT = "/private/tmp/chroma-relay-native-gradient-apply";

const isDirectChild = (root, candidate) => {
  const child = relative(root, candidate);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child) && !child.includes(sep);
};

const refusal = (root, candidate, reason) => ({ root, candidate, reason });

const inspectCandidate = async (root, candidate, fs) => {
  if (!isDirectChild(root, candidate)) return refusal(root, candidate, "candidate is outside the documented direct-child scope");
  let rootStat;
  let candidateStat;
  try {
    rootStat = await fs.lstat(root);
    candidateStat = await fs.lstat(candidate);
  } catch (error) {
    if (error?.code === "ENOENT") return refusal(root, candidate, "path disappeared during inspection");
    return refusal(root, candidate, `inspection failed: ${error.message}`);
  }
  if (rootStat.isSymbolicLink?.()) return refusal(root, candidate, "documented root is a symlink");
  if (!rootStat.isDirectory?.()) return refusal(root, candidate, "documented root is not a directory");
  if (candidateStat.isSymbolicLink?.()) return refusal(root, candidate, "candidate is a symlink");
  if (!candidateStat.isDirectory?.()) return refusal(root, candidate, "candidate is not a directory");
  let rootReal;
  let candidateReal;
  try {
    rootReal = await fs.realpath(root);
    candidateReal = await fs.realpath(candidate);
  } catch (error) {
    return refusal(root, candidate, `realpath failed: ${error.message}`);
  }
  if (!isDirectChild(rootReal, candidateReal)) return refusal(root, candidate, "candidate realpath escaped its root");
  const markerPath = resolve(candidate, MARKER_FILE);
  let markerStat;
  try {
    markerStat = await fs.lstat(markerPath);
  } catch (error) {
    if (error?.code === "ENOENT") return refusal(root, candidate, "ownership marker is missing");
    return refusal(root, candidate, `marker inspection failed: ${error.message}`);
  }
  if (markerStat.isSymbolicLink?.() || !markerStat.isFile?.()) return refusal(root, candidate, "ownership marker is not a regular file");
  let markerReal;
  try {
    markerReal = await fs.realpath(markerPath);
  } catch (error) {
    return refusal(root, candidate, `marker realpath failed: ${error.message}`);
  }
  if (resolve(markerReal) !== resolve(candidateReal, MARKER_FILE)) return refusal(root, candidate, "ownership marker escaped its child");
  let marker;
  try {
    marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
  } catch {
    return refusal(root, candidate, "ownership marker is malformed");
  }
  if (
    marker?.kind !== productContract.runner.ownershipKind ||
    marker?.schema !== productContract.runner.ownershipSchema ||
    marker?.contractVersion !== productContract.contractVersion ||
    marker?.marker !== productContract.marker.current ||
    typeof marker?.token !== "string" ||
    !/^[A-Za-z0-9._-]+$/.test(marker.token) ||
    marker?.root !== rootReal ||
    marker?.child !== candidateReal
  ) return refusal(root, candidate, "ownership marker is foreign or stale");
  return {
    root,
    candidate,
    run: { root, path: candidate, token: marker.token, markerPath },
    marker,
  };
};

export const inspectCleanupRoots = async ({ roots = [EVIDENCE_ROOT, TEMPORARY_ROOT], apply = false, fs = {
  lstat,
  readdir,
  readFile,
  realpath,
  rm,
} } = {}) => {
  const candidates = [];
  const refusals = [];
  const removed = [];
  for (const root of roots) {
    let names;
    try {
      const rootStat = await fs.lstat(root);
      if (rootStat.isSymbolicLink?.() || !rootStat.isDirectory?.()) {
        refusals.push(refusal(root, root, rootStat.isSymbolicLink?.() ? "documented root is a symlink" : "documented root is not a directory"));
        continue;
      }
      names = await fs.readdir(root);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      refusals.push(refusal(root, root, `root scan failed: ${error.message}`));
      continue;
    }
    for (const name of names.sort()) {
      const candidate = resolve(root, name);
      const inspected = await inspectCandidate(root, candidate, fs);
      if (inspected.run) {
        candidates.push({ root, candidate, marker: inspected.marker, action: apply ? "remove" : "would-remove" });
        if (apply) {
          try {
            await removeOwnedRunDirectory(inspected.run, { fs });
            removed.push(candidate);
          } catch (error) {
            refusals.push(refusal(root, candidate, `owned cleanup refused: ${error.message}`));
          }
        }
      } else {
        refusals.push(inspected);
      }
    }
  }
  return {
    mode: apply ? "apply" : "dry-run",
    mutated: apply && removed.length > 0,
    candidates,
    refusals,
    removed,
    roots: [...roots],
  };
};

const isDirectCliInvocation = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectCliInvocation) {
  const apply = process.argv.slice(2).length === 1 && process.argv[2] === "--apply";
  if (process.argv.slice(2).length > 0 && !apply) {
    console.error("Usage: node scripts/cleanup-live-test-residue.mjs [--apply]");
    process.exitCode = 2;
  } else {
    inspectCleanupRoots({ apply }).then((report) => {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    }).catch((error) => {
      console.error(error instanceof Error ? error.stack || error.message : String(error));
      process.exitCode = 1;
    });
  }
}
