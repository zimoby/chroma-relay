#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { IsolatedBuildSignalError, runIsolatedBuild } from "./lib/isolated-build.mjs";

export const runBuildCli = async ({ runBuild = runIsolatedBuild, processApi = process } = {}) => {
  try {
    return await runBuild();
  } catch (error) {
    if (error instanceof IsolatedBuildSignalError) {
      processApi.kill(processApi.pid, error.signal);
      return undefined;
    }
    throw error;
  }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runBuildCli();
}
