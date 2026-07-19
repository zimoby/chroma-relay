#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const outputArg = process.argv.slice(2).find((value) => value.startsWith("--output="));
const requestedOutput = outputArg
  ? outputArg.slice("--output=".length)
  : "evidence/react-doctor.txt";
const outputPath = isAbsolute(requestedOutput)
  ? requestedOutput
  : resolve(repoRoot, requestedOutput);

await mkdir(dirname(outputPath), { recursive: true });

const child = spawn(
  "/usr/bin/script",
  ["-q", "/dev/null", "react-doctor", ".", "--verbose"],
  {
  cwd: repoRoot,
  env: { ...process.env, CI: "1", NO_COLOR: "1" },
  stdio: ["ignore", "pipe", "pipe"],
  }
);

let output = "";
let lastOutputAt = Date.now();
let completedMarkerSeen = false;
let forcedExitAfterCompletion = false;
let timedOut = false;
let settled = false;

const collect = (chunk) => {
  const text = chunk.toString();
  output += text;
  lastOutputAt = Date.now();
  if (text.includes("Full diagnostics")) completedMarkerSeen = true;
};

child.stdout.on("data", collect);
child.stderr.on("data", collect);

const result = await new Promise((resolveResult, rejectResult) => {
  child.on("error", rejectResult);
  child.on("exit", (code, signal) => {
    if (settled) return;
    settled = true;
    resolveResult({ code, signal });
  });

  const interval = setInterval(() => {
    if (settled) {
      clearInterval(interval);
      return;
    }
    if (completedMarkerSeen && Date.now() - lastOutputAt > 1500) {
      forcedExitAfterCompletion = true;
      child.kill("SIGTERM");
    }
  }, 250);

  setTimeout(() => {
    if (settled) return;
    timedOut = true;
    child.kill("SIGTERM");
    settled = true;
    resolveResult({ code: null, signal: "SIGTERM" });
  }, 120000);
});

await writeFile(outputPath, output);
if (timedOut) {
  throw new Error(`React Doctor did not complete within 120 seconds; output saved to ${outputPath}`);
}
if (!completedMarkerSeen && result.code !== 0) {
  throw new Error(`React Doctor exited before completing (code ${result.code}, signal ${result.signal})`);
}

console.log(
  JSON.stringify(
    {
      completed: true,
      exitCode: result.code,
      signal: result.signal,
      forcedExitAfterCompletion,
      outputPath,
    },
    null,
    2
  )
);
