import { isAbsolute, relative, sep } from "node:path";

export const assertCleanSourceStatus = (status) => {
  if (typeof status !== "string") throw new TypeError("Git status must be text");
  if (status.trim()) {
    throw new Error("Alpha packaging requires a clean tracked and untracked source tree");
  }
};

export const repositoryRelativePath = (repoRoot, filePath) => {
  const fromRoot = relative(repoRoot, filePath);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error("Artifact path must remain inside the repository");
  }
  return fromRoot.split(sep).join("/");
};
