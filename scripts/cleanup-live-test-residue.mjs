#!/usr/bin/env node

import { lstat, readdir, readFile, realpath, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import productContract from "../src/shared/product-contract.json" with { type: "json" };
import { isDirectCliInvocation, removeOwnedRunDirectory } from "./lib/live-runner-policy.mjs";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const MARKER_FILE = productContract.runner.markerFile;
const EVIDENCE_ROOT = resolve(REPO_ROOT, "evidence/local/native-gradient/track-b-apply-ae25");
const TRACK_B_TEMPORARY_ROOT = "/private/tmp";
const DEFAULT_MINIMUM_AGE_MS = 24 * 60 * 60 * 1000;

const isDirectChild = (root, candidate) => {
  const child = relative(root, candidate);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child) && !child.includes(sep);
};

const refusal = (root, candidate, reason) => ({ root, candidate, reason });

const defaultProcessAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
};

const inspectCandidate = async (root, candidate, fs, { now, minimumAgeMs, processAlive }) => {
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
  const createdAt = Date.parse(marker.createdAt);
  if (!Number.isFinite(createdAt)) {
    return refusal(root, candidate, "ownership marker has no trustworthy creation time");
  }
  if (Number.isInteger(marker.pid) && marker.pid > 0 && processAlive(marker.pid)) {
    return refusal(root, candidate, "owned run process is still active");
  }
  const ageMs = now - createdAt;
  if (ageMs < minimumAgeMs) {
    return refusal(root, candidate, "owned run is active or inside the cleanup grace period");
  }
  return {
    root,
    candidate,
    run: { root, path: candidate, token: marker.token, markerPath },
    marker,
  };
};

export const buildDefaultCleanupRootSpecifications = ({
  canonicalTemporaryRoot,
  evidenceRoot = EVIDENCE_ROOT,
  trackBTemporaryRoot = TRACK_B_TEMPORARY_ROOT,
}) => {
  const specifications = [
    { path: evidenceRoot, prefix: "chroma-relay-track-b-" },
  ];
  if (resolve(canonicalTemporaryRoot) === resolve(trackBTemporaryRoot)) {
    specifications.push({ path: trackBTemporaryRoot, prefix: "chroma-relay-" });
  } else {
    specifications.push(
      { path: trackBTemporaryRoot, prefix: "chroma-relay-track-b-" },
      { path: canonicalTemporaryRoot, prefix: "chroma-relay-" }
    );
  }
  return specifications;
};

const defaultCleanupRoots = async (fs) => {
  let canonicalTemporaryRoot;
  try {
    canonicalTemporaryRoot = await fs.realpath(tmpdir());
  } catch {
    canonicalTemporaryRoot = resolve(tmpdir());
  }
  return buildDefaultCleanupRootSpecifications({ canonicalTemporaryRoot });
};

export const inspectCleanupRoots = async ({
  roots,
  apply = false,
  now = Date.now(),
  minimumAgeMs = roots ? 0 : DEFAULT_MINIMUM_AGE_MS,
  processAlive = defaultProcessAlive,
  fs = {
  lstat,
  readdir,
  readFile,
  realpath,
  rm,
  },
} = {}) => {
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(minimumAgeMs) ||
    minimumAgeMs < 0 ||
    typeof processAlive !== "function"
  ) {
    throw new TypeError("Cleanup age policy must use finite non-negative milliseconds");
  }
  const candidates = [];
  const refusals = [];
  const removed = [];
  const rootSpecifications = roots
    ? roots.map((root) => typeof root === "string" ? { path: root, prefix: null } : root)
    : await defaultCleanupRoots(fs);
  for (const specification of rootSpecifications) {
    const root = specification.path;
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
      if (specification.prefix && !name.startsWith(specification.prefix)) continue;
      const candidate = resolve(root, name);
      const inspected = await inspectCandidate(root, candidate, fs, {
        now,
        minimumAgeMs,
        processAlive,
      });
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
    roots: rootSpecifications.map(({ path }) => path),
    rootFilters: rootSpecifications.map(({ path, prefix }) => ({ path, prefix })),
  };
};

if (isDirectCliInvocation(import.meta.url)) {
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
