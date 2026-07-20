# Chroma Relay Native Gradient Binary Toolkit Implementation Plan

> **For the fresh Hermes session:** Load `after-effects-runtime-debugging`, `ae-pseudo-effect-ffx`, `subagent-driven-development`, and `writing-plans`. Execute one milestone at a time. Use two-stage spec and quality review after every implementation task. Do not start live AE work from delegated subagents; the parent owns all live gates.

**Goal:** Build and live-prove a self-contained TypeScript/Node toolkit that can parse exact static AE native gradient data and generate safe Shape Gradient Fill/Stroke FFX presets. After the proof, integrate only the product behavior Denis explicitly selects.

**Architecture:** Chroma Relay owns the runtime candidate and fixtures. AutoTools contributes proven patterns but is not a runtime dependency. The binary writer parses big-endian RIFX with source spans, treats `GCky` as a `LIST` form containing a `Utf8` child, preserves all non-target bytes plus the trailer outside the declared RIFX boundary, and patches only the target `Utf8` payload and affected size words. Live mechanism proof runs through external AE helper scripts against one token-owned scratch gradient at a time. Generic saved-AEP target resolution and Main-panel wiring are separate post-proof tracks.

**Tech stack:** TypeScript 5.8; `$HOME/.local/bin/node` v22.22.3 and npm 10.9.8; Node built-in test runner with type stripping; CEP/ExtendScript only after the product decision; AE 26.3 mechanism proof, followed by exact-version evidence gates for every AE family enabled in production.

**Plan status:** Core mechanism complete. On 2026-07-18 Denis approved `PRODUCT-SEMANTICS=both_serially`: exact collection first, then active-palette application. The exact policy is recorded in [`native-gradient-product-semantics.md`](native-gradient-product-semantics.md). The package migration is complete at private toolkit commit `891eb6ba964ffdf99a382c285eef249fb24ce180`.

---

## 1. Adopted decision

Adopt with constraints.

The exact binary mechanism passed its bounded standalone and AE `26.3x87` proof. Chroma Relay product semantics are now approved as `both_serially`: collect exact native gradient color stops into ordinary palette swatches first, then add a separate explicit action that constructs a gradient from the active palette.

Collection and application remain separate reviewed tracks. The decision does not add whole-gradient palette objects or claim exact collection→application geometry round trips.

### Runtime ownership

The standalone `$HOME/Documents/Dev_code/_Collaborations/ae-native-gradient-toolkit` project now owns the binary implementation, fixtures, templates, CLI, and proof harness. Chroma Relay completed its migration to the exact private `@zimoby/ae-native-gradient` commit `891eb6ba964ffdf99a382c285eef249fb24ce180`. This supersedes the original pre-extraction ownership decision in this plan.

- Chroma Relay consumes that reproducibly pinned package and keeps only product semantics, UI, CEP bridge, and future runtime adapters.
- `@zimoby` is the toolkit owner scope. `Chroma Relay`, `Zimoby`, and the current `com.zimoby.chroma-relay` CEP identity remain provisional and must not be used as the toolkit owner, GitHub organization, or package namespace.
- Do not commit an absolute import, sibling `file:` dependency, source symlink, copied toolkit source, or generated vendor copy.
- Package templates remain canonical and may enter the CEP artifact only through the consumer build pipeline.
- AutoTools remains read-only reference material.

The remaining implementation-plan body is retained as a historical record of the pre-extraction work; its local codec, fixture, and CLI paths do not describe current Chroma Relay ownership.

### Explicitly rejected shortcuts

- Do not treat `GCky` as a leaf. It is `LIST(formType="GCky")` with a `Utf8` child.
- Do not rebuild a whole FFX and discard bytes outside the declared RIFX size.
- Do not use global equal-length replacement.
- Do not patch the active AEP.
- Do not use `app.project.save(tempFile)` as a copy/snapshot substitute for a user project.
- Do not identify comps, layers, groups, or properties by display names alone.
- Do not overload normal swatch click with undefined gradient behavior.
- Do not attempt to address the currently selected gradient stop; AE does not expose stable stop selection identity through ExtendScript.
- Do not add native/C++ support, keyframed gradients, Layer Style gradients, or Windows claims in the core proof.

## 2. Source of truth

### Product repository

`$HOME/Documents/Dev_code/_Collaborations/chroma-relay`

Read before work:

- `AGENTS.md`, if present; its absence is not a stop
- `README.md`
- `CONTRIBUTING.md`
- `docs/implementation-plan.md`
- `docs/implementation-status.md`
- `evidence/research/gradient-support/native-gradient-exact-parse-write-follow-up-2026-07-18.md`

The research report is background evidence. Its lines 277–279 describe `GCky`
as a leaf; that wording is superseded by this plan's verified section 8 model:
`LIST(formType="GCky") -> Utf8 -> XML`. Do not implement the superseded wording.

Existing product seams, for post-proof integration only:

- `src/jsx/aeft/aeft.ts`
- `src/jsx/aeft/color-apply.ts`
- `src/js/main/main.tsx`
- `src/js/lib/cep/node.ts`
- `src/js/shared/debug-api.ts`
- `tests/host-contract.test.mjs`
- `scripts/cep-functional-smoke.mjs`
- `cep.config.ts`

### Local reference repository

`$HOME/Documents/Dev_code/AutoTools/ae-agent-scripts`

Required reference for the RIFX extraction:

- `pseudo-effect-tests/ffx-generate-from-spec.js`
- `pseudo-effect-tests/test-ffx-generate-prefix.js`
- `pseudo-effect-tests/test-ffx-generate-popup.js`
- `pseudo-effect-tests/test-ffx-generate-expand.js`

Optional background reference only; do not make these prerequisites:

- `benchmark/level-17-special-folder/tools/l17-aep-structure-map.js`
- `benchmark/level-17-special-folder/tools/l17-aep-anchored-patcher.js`
- `benchmark/level-17-special-folder/tools/l17-aep-layer-duplicate.js`
- `AEBenchmarkLauncher/scripts/prepare-versioned-aep.js`

### Pinned external oracles

Use the versions and license findings already recorded in the research report:

- Bodymovin `a400a2551d7564691400b1ceef43fe9bab16900a` — MIT.
- AEUX `573d07d63b13059c6ebeb02561c89b39bb829180` — Apache-2.0.
- `py-aep` `d52678605581f3290a891ec3195a34fd39ee802e`, v0.13.0 — MIT.
- libpag `4a8fb4f97f9578b23a0496640675bcfa17d5ff59` — architecture reference only; do not copy code.

Fresh test runs must not require network access or Python. One-time oracle outputs are frozen as JSON alongside owned fixture hashes and provenance.

## 3. Current baseline to recheck

Observed on 2026-07-18:

- active Hermes `node`: `$HOME/.local/bin/node`, v22.22.3;
- active Hermes `npm`: `$HOME/.local/bin/npm`, 10.9.8;
- `/usr/local/bin/node` is v18.12.1 and cannot run the type-stripping test scripts;
- AE 26.3 is running;
- Chroma Relay Main/Settings are loaded on 8198/8199;
- the CEP symlink points to this checkout's `dist/cep`;
- `npm run test:domain`: 32/32 passed;
- `npm run test:host-contract`: 9/9 passed;
- AutoTools pseudo-effect node tests passed;
- one inspected production FFX has declared RIFX end at 66,450 and file size 70,223, proving a 3,773-byte trailer must be preserved;
- its gradient structure is `LIST -> formType GCky -> Utf8 -> XML`.

These are historical inputs, not execution assumptions. Recheck every relevant fact.

## 4. Repository and agent safety

The repository currently has no `HEAD`, and all project files are untracked. `git status --short` alone is not a recoverable baseline.

### Hard prerequisites before source edits

Use one of these paths:

1. **Preferred:** Denis approves and creates the first baseline commit.
2. **Fallback:** create an out-of-repo immutable baseline before any in-repo write.

The parent must also obtain a current-session decision from Denis to resolve the
dual package-manager state in favor of npm. Without that approval, M0 stops
before source edits. The authorized resolution is defined in Task 1.

Proposed durable fallback root, subject to Denis's approval:

`$HOME/Documents/Dev_code/_Collaborations/.agent-baselines/chroma-relay-native-gradient/<RUN_ID>`

It must contain:

- `git-status-all.txt` from `git status --short --untracked-files=all`;
- `manifest.sha256` covering every project file except `node_modules/`, `dist/`, generated packages, `.DS_Store`, and prior local evidence;
- `task-ledger.json` with task ID, active agent, exact writable paths, pre-edit hashes, snapshot archive hash, status, and reviewer verdicts;
- one finalized `snapshots/<TASK_ID>.tar` for every task or conditional track that may modify existing files.

Build each task snapshot in `/private/tmp` first. It must contain exact copies of
the existing files that task may modify plus permissions, hashes, and symlink
metadata; for planned new files, record that the path was absent. Move the
final archive into `snapshots/`, compute and record its SHA-256 in the mutable
ledger, then remove write permission from the archive. The mutable ledger stays
outside finalized archives. `/private/tmp` is staging only, never the durable
rollback location.

Do not write M0 evidence into the repository until this baseline exists.

### Rollback without Git

- New files from a failed task may be removed only when listed in the task ledger.
- Existing files are restored only from the active task's finalized snapshot, never from memory or a broad Git command.
- Never use `git clean`, `git reset`, `git checkout --`, or stash.
- Do not commit unless Denis approves commits after the initial baseline decision.

### Delegation ownership

- One writing agent at a time for shared binary modules and `package.json`.
- The parent records writable paths in `task-ledger.json` before dispatch.
- Read-only research may run in parallel.
- Parent re-reads changed files and reruns tests after each subagent.
- Live AE work is serial and parent-owned.

## 5. Scope classification

### Actionable core

1. Recoverable baseline and reproducible Node/npm selection.
2. Span-preserving RIFX parser and single-leaf patcher.
3. Exact static `GCky` gradient XML codec.
4. Owned Fill/Stroke FFX fixtures plus frozen oracle JSON.
5. FFX generator for 2–8 static color/alpha stops.
6. Read-only unique-gradient AEP inventory for scratch readback.
7. External AE proof: Apply → saved readback → separate Undo → restored readback.

### Needs decision

`PRODUCT-SEMANTICS`:

- `toolkit_only`: keep the mechanism as tested tooling; no product behavior yet.
- `collect_stops_only`: collect each exact static gradient color stop as a normal palette swatch; normal swatch apply remains unsupported for gradients.
- `apply_active_palette`: add an explicit action that rebuilds selected static gradients from the active palette.
- `both_serially`: implement collect and apply as separate reviewed tracks, one at a time.
- `store_gradient_items`: add whole-gradient palette objects; this requires a separate converged schema/UI/migration plan.
- `other`: Denis specifies exact behavior and loss policy.

### Needs data in the core proof

- Whether one owned template per kind works for 2, 3, and 8 stops.
- Whether any stop-count metadata exists outside the target `Utf8` payload.
- Whether AE preserves separate alpha stops and non-default midpoints.
- Whether finite HDR/negative RGB survives generated FFX application.

### Deferred

- Generic saved-AEP selected-target resolution until the collection track is chosen.
- Main/debug/host production plumbing until an application track is chosen.
- Keyframes, expressions, dirty/unsaved snapshots, direct AEP writes.
- Layer Style Gradient Overlay/Glow.
- More than eight generated stops.
- Native AEGP helper.
- Windows.
- Shared AutoTools/npm package.

## 6. Global invariants

1. Never mutate the user's current project.
2. A live test is allowed only when the active project is already a clean token-scoped scratch project confirmed by the parent in the current session.
3. Test setup must refuse to call `app.newProject`, close, Save As, or replace a non-token project.
4. One live AE script at a time.
5. Action script returns fully before readback and before Undo.
6. Undo is command ID `16` in a separate later AE invocation after a real wait.
7. Scratch saving is allowed only when the current project path is already inside the current token root.
8. Never change the active item. All live targets belong to the already-active comp.
9. Capture and restore layer/property selection in `finally`.
10. Temp preset paths are token-scoped and validated independently in Node and ExtendScript.
11. Preserve failure artifacts before cleanup. On validation failure, stop and retain the scratch project.
12. Classify failures as product, harness, fixture, runtime-load, binary-format, or environment.
13. Node green does not authorize live AE work.
14. Live proof does not authorize product semantics.
15. AE 26.3 proof does not authorize an AE 22–99 compatibility claim.

## 7. Core file inventory

Create only as each failing test requires:

```text
src/js/shared/ae-binary/
  bytes.ts
  riff-rifx.ts
  native-gradient-types.ts
  gcky-gradient.ts
  ffx-gradient.ts
  aep-gradient-inventory.ts
tests/
  native-gradient-bytes.test.ts
  native-gradient-riff.test.ts
  native-gradient-gcky.test.ts
  native-gradient-ffx.test.ts
  native-gradient-aep-inventory.test.ts
tests/fixtures/native-gradient/
  manifest.json
  fill-template.ffx
  stroke-template.ffx
  fill-template.expected.json
  stroke-template.expected.json
  scratch-fill.aep
  scratch-fill.expected.json
  scratch-stroke.aep
  scratch-stroke.expected.json
scripts/native-gradient/
  inspect.mjs
  generate-ffx.mjs
  proof-setup.jsx
  proof-apply.jsx
  proof-save-readback.jsx
  proof-undo.jsx
  proof-cleanup.jsx
  run-proof.sh
docs/native-gradient-provenance.md
evidence/local/native-gradient/README.md
.node-version
```

Modify during the core only:

```text
package.json
CONTRIBUTING.md
```

Do not touch `main.tsx`, debug API, product JSX exports, build assets, or `cep.config.ts` before `PRODUCT-SEMANTICS`.

## 8. Binary contracts

### 8.1 RIFX model

```ts
export type RiffSpan = {
  headerStart: number;
  sizeFieldStart: number;
  dataStart: number;
  dataEnd: number;
  paddedEnd: number;
};

export type RiffNode = {
  id: string;
  declaredSize: number;
  formType: string | null;
  children: readonly RiffNode[];
  span: RiffSpan;
};

export type RiffDocument = {
  source: Uint8Array;
  root: RiffNode;
  declaredEnd: number;
  trailerStart: number;
};

export function parseRifx(source: Uint8Array, limits?: RiffLimits): RiffDocument;
export function findListsByFormType(doc: RiffDocument, formType: string): RiffNode[];
export function replaceLeafPayload(
  doc: RiffDocument,
  leaf: RiffNode,
  replacement: Uint8Array
): { bytes: Uint8Array; report: SpanPatchReport };
```

Rules:

- root must be `RIFX` with big-endian sizes;
- `LIST` and root forms have a four-byte form type before children;
- retain immutable source spans and original pad bytes;
- retain all bytes from `declaredEnd` to EOF as trailer;
- parser rejects overflow, truncation, invalid nesting, excessive depth/count/bytes, and unexplained bytes inside declared containers;
- no generic full-file serializer in the first slice;
- replacement changes only:
  - the target leaf size word;
  - the target payload and its pad;
  - size words of containing `LIST` nodes and root;
- all bytes after the old target `paddedEnd`, including the trailer, must equal all bytes after the new target `paddedEnd` byte-for-byte;
- all prefix bytes must remain equal except the explicit size-word offsets;
- report ancestor size patches, target old/new spans, old/new declared end, trailer SHA-256 supplied by the CLI adapter, and unchanged-suffix proof.

Hashing stays out of shared codecs. Node CLIs and Main adapters own crypto and filesystem behavior.

### 8.2 Gradient model

```ts
export type GradientColorStop = {
  offset: number;
  midpoint: number;
  rgb: [number, number, number];
  extra: number;
};

export type GradientAlphaStop = {
  offset: number;
  midpoint: number;
  alpha: number;
};

export type NativeGradient = {
  schemaVersion: 1;
  colorStops: GradientColorStop[];
  alphaStops: GradientAlphaStop[];
};
```

Parser:

- input is the data payload of the `Utf8` child inside `LIST(GCky)`;
- require `<prop.map version='4'>` and all required gradient keys/lists/counts;
- reject DTD/entity declarations, duplicate required keys, malformed/non-finite numbers, count mismatch, unsupported version, and oversized XML;
- preserve list order, duplicate offsets, parsed finite RGB/extra values, and raw XML hash in the adapter report;
- parser safety limit may exceed product limits, but it is not a support claim.

Generator:

- 2–8 color stops and 2–8 alpha stops in the core proof;
- offsets are nondecreasing in `[0,1]`; duplicate offsets are preserved;
- midpoint and alpha are in `[0,1]`;
- RGB and `extra` are finite and not clamped;
- normalize generated numeric values through `Math.fround` and format with deterministic `String(Math.fround(value))` unless fixture/oracle comparison proves AE requires another round-trip-safe representation;
- serializer emits deterministic UTF-8 XML only; RIFF padding belongs to `replaceLeafPayload`;
- no implicit sorting or deduplication.

### 8.3 FFX target

A valid template must:

- parse as RIFX;
- contain exactly one `LIST(formType="GCky")`;
- that list must contain exactly one `Utf8` leaf and no ambiguous nested candidate;
- contain structural/match-name evidence for the requested Shape Fill or Stroke kind;
- parse its current gradient successfully;
- have a fixture hash present in `manifest.json`.

The generator replaces only that `Utf8.data` and returns bytes plus a pure structural report. CLI adds hashes and file paths.

### 8.4 Scratch AEP inventory

The core AEP reader is intentionally not a selected-target resolver.

It:

- parses a clean saved scratch AEP read-only;
- enumerates `LIST(GCky)/Utf8` candidates with spans and decoded values;
- reports nearby structural/match-name evidence when available;
- requires exactly one valid gradient candidate for M3 readback;
- returns nonzero for zero, multiple, malformed, or ambiguous candidates;
- never exposes a write function.

Generic descriptor mapping is deferred to the collection track.

## 9. Milestones and stop states

### M0 — Recoverable baseline and toolchain

Artifact: out-of-repo baseline, task ledger, read-only preflight report.

Stop if baseline recovery is incomplete, Node type stripping is unavailable, package-manager choice is unresolved, static tests fail, or another agent owns target paths.

### M1 — Synthetic binary core

Artifact: green synthetic byte/RIFX/`GCky` tests, including randomized bounded cases and trailer preservation.

No real fixtures, AE, product host code, or in-repo evidence yet.

Stop for spec and quality reviews.

### M2 — Synthetic inventory, owned fixtures, and fixture-backed generation

Artifact: synthetic AEP inventory first; then owned Fill/Stroke FFX and clean
unique-gradient AEP fixtures, frozen expected JSON, provenance, and green
fixture-backed FFX/AEP inventory tests.

Fixture acquisition is a parent/human live gate. Stop if distributability/provenance is uncertain.

### M3 — AE 26.3 mechanism proof

Artifact: Fill and Stroke 2/3/8-stop Apply → saved readback → separate Undo → restored readback, plus HDR/negative RGB probe.

Uses external `ae_file_json`; no product panel wiring.

Stop for Denis and `PRODUCT-SEMANTICS`.

### M4A — Exact collection track, conditional

Starts only for `collect_stops_only` or `both_serially`.

Build generic selected-target-to-saved-AEP resolution first. Stop if stable identity cannot be proven.

### M4B — Production application track, conditional

Starts only for `apply_active_palette` or `both_serially`.

Build product temp-file bridge, host apply function, explicit Main action, and CDP smoke.

### M5 — Version-evidence/release gate

Run selected production behavior on explicit AE versions. AE 22.x and 26.3 are
independent evidence points, not proof for AE 23–25 or future versions. Runtime-
gate native-gradient behavior to live-proven version families. Windows and
packaging remain separate approvals.

## 10. Task 0 — M0 baseline and preflight

**Writes:** the approved durable baseline root; `/private/tmp` only for staging snapshots.

1. Read the source-of-truth files in section 2.
2. Set the toolchain explicitly:

   ```bash
   export PATH=$HOME/.local/bin:$PATH
   command -v node
   node --version
   command -v npm
   npm --version
   node --experimental-strip-types -e 'console.log("type-strip-ok")'
   ```

   Expected: `$HOME/.local/bin/node`, Node 22.x, npm 10.x, `type-strip-ok`.
3. Record both `$HOME/.local/bin/node` and `/usr/local/bin/node` versions to prevent PATH ambiguity.
4. Record the conflict: README/current status use npm, `CONTRIBUTING.md` and
   `yarn.lock` disagree, and `package.json` pins neither Node nor npm.
   Obtain Denis's explicit current-session approval for Task 1's npm resolution.
   If approval is absent, stop M0.
5. Create the fallback baseline described in section 4 unless Denis approved a baseline commit.
6. Create `task-ledger.json` with no active writer.
7. Run:

   ```bash
   npm run test:domain
   npm run test:host-contract
   cd $HOME/Documents/Dev_code/AutoTools/ae-agent-scripts/pseudo-effect-tests
   ./run-pseudo-node-tests.sh
   ```

8. Run read-only AE checks:

   ```bash
   env HOME=$HOME zsh -lc 'source $HOME/.ae-helpers.sh && ae_check'
   ```

9. Record shell versions, exit codes, repo state, active AE project path/item count/selection count, CEP process version if a development panel is available, and live-mutation authorization as false by default.
10. Stop for parent review.

## 11. Task 1 — Byte helpers and synthetic RIFX parser/patcher

**Create:**

- `src/js/shared/ae-binary/bytes.ts`
- `src/js/shared/ae-binary/riff-rifx.ts`
- `tests/native-gradient-bytes.test.ts`
- `tests/native-gradient-riff.test.ts`
- `.node-version` containing `22.22.3`.

**Modify:**

- `package.json`: add `test:native-gradient`, `"packageManager": "npm@10.9.8"`, and a Node 22 engine constraint.
- `CONTRIBUTING.md`: change package-manager commands to npm.
- `package-lock.json`: refresh with the authorized Node/npm toolchain.

**Remove after its task snapshot exists and only with the M0 approval:**
`yarn.lock`. Do not delete any lockfile before approval and
snapshot.

**TDD sequence:**

1. Apply the approved toolchain metadata and lockfile resolution first.
2. Copy the source tree without `node_modules`, `dist`, packages, or evidence to
   a fresh temporary directory. Run `npm ci --ignore-scripts` there with the
   pinned Node/npm, then run the existing static tests. Stop on lock drift or a
   clean-install-only failure.
3. Add failing byte tests for big-endian u32, FourCC, UTF-8, parity, bounds, overflow, and truncation.
4. Run focused test and observe failure.
5. Implement minimal pure `Uint8Array`/`DataView` helpers.
6. Add failing synthetic RIFX tests for:
   - nested root/LIST/leaf spans;
   - odd/even payload pads;
   - nonzero original pad-byte preservation when untouched;
   - legal trailer outside declared root;
   - expansion and shrinkage of a nested leaf;
   - exact suffix/trailer preservation after displacement;
   - only target/ancestor size fields changed;
   - zero-length leaf;
   - malformed sizes/pads/containers;
   - depth/count/byte limits;
   - rejection of little-endian `RIFF`.
7. Add a deterministic seeded randomized test generating bounded synthetic trees, patching one leaf, reparsing, and checking invariants. Keep seed in failure output.
8. Implement the smallest span parser and patcher; do not implement a general serializer.
9. Run:

   ```bash
   npm run test:native-gradient
   npm run test:domain
   npm run test:host-contract
   ```

10. Parent re-reads all changed files.
11. Run spec-compliance review, fix, rerun.
12. Run code-quality/security review, fix, rerun.
13. Stop M1 Task 1.

**Acceptance:** No full-file reconstruction, no trailer loss, no hash/filesystem import in shared modules, and no unchecked recursion/allocation.

## 12. Task 2 — Synthetic `GCky` codec

**Create:**

- `src/js/shared/ae-binary/native-gradient-types.ts`
- `src/js/shared/ae-binary/gcky-gradient.ts`
- `tests/native-gradient-gcky.test.ts`

**Required API:**

```ts
export function parseGradientUtf8Payload(data: Uint8Array): NativeGradient;
export function serializeGradientUtf8Payload(value: NativeGradient): Uint8Array;
export function validateGeneratedGradient(value: unknown): NativeGradient;
```

**TDD sequence:**

1. Build minimal synthetic `<prop.map version='4'>` payloads from the pinned format report; do not read production binary in unit setup.
2. Add failing tests for exact independent color/alpha lists, non-default midpoints, duplicate offsets, `extra`, HDR/negative RGB, deterministic float32 output, UTF-8, and serialize/parse round trip.
3. Add malformed tests for missing/duplicate keys, wrong version, count mismatch, NaN/Infinity, DTD/entity declarations, malformed nesting, huge counts/XML, and trailing unparsed required structure.
4. Implement a narrow bounded parser. Avoid a general XML dependency; if a dependency becomes necessary, stop and justify it before changing the manifest.
5. Serializer emits canonical deterministic XML and no RIFF header/padding.
6. Run all native-gradient, domain, and host-contract tests.
7. Run spec review then quality/security review.
8. Stop M1.

**Acceptance:** `LIST(GCky)` concerns stay in RIFX/FFX modules; the codec only knows the `Utf8` XML payload.

## 13. Task 3A — Build synthetic read-only AEP inventory

**Create:**

- `src/js/shared/ae-binary/aep-gradient-inventory.ts`
- `tests/native-gradient-aep-inventory.test.ts`
- `scripts/native-gradient/inspect.mjs`

1. Build synthetic RIFX/AEP-like bytes containing zero, one, and multiple
   `LIST(GCky)/Utf8` candidates.
2. Implement read-only candidate enumeration with source spans, decoded values,
   and structural context. Do not add any write API.
3. Add unique-candidate mode that exits nonzero for zero, multiple, malformed,
   or ambiguous candidates.
4. Make `inspect.mjs` emit deterministic normalized JSON and file SHA-256; invoke
   it with the pinned Node type-stripping flag.
5. Run native-gradient, domain, and host-contract tests plus both reviews.
6. Stop before fixture acquisition.

## 14. Task 3B — Acquire owned fixtures and freeze oracle data

**Parent/human live gate:** Do not delegate this unattended.

**Create:**

- `tests/fixtures/native-gradient/manifest.json`
- owned Fill/Stroke FFX and unique-gradient AEP fixtures from section 7;
- expected JSON files;
- `docs/native-gradient-provenance.md`.

**Precondition:** The parent explicitly confirms that the active AE project is already a clean token-scoped scratch project, or performs the transition manually after Denis approves. Scripts must refuse to create/close/replace a project.

**Acquisition:**

1. Use a brand-new scratch project under `/private/tmp/chroma-relay-gradient-<RUN_ID>/`.
2. Create one Shape Gradient Fill fixture and one separate Shape Gradient Stroke fixture. Each saved AEP used for inventory contains exactly one gradient.
3. Capture one property-scoped FFX template per kind using AE's Save Animation Preset UI. The template must not include transforms, unrelated shape properties, or another gradient.
4. Record the exact AE version and platform.
5. Compute SHA-256 and byte sizes.
6. Verify structure before acceptance:
   - root `RIFX`;
   - declared end and trailer length;
   - exactly one `LIST(GCky)`;
   - exactly one `Utf8` child;
   - expected Fill/Stroke identity;
   - no second gradient candidate.
7. Verify each acquired file with the already-checked-in `inspect.mjs`; do not use
   an ad hoc scanner as the acceptance gate.
8. Use pinned `py-aep` commit
   `d52678605581f3290a891ec3195a34fd39ee802e` as the mandatory one-time external
   oracle. Keep the adapter, pinned dependency metadata, virtual environment, and
   regeneration command in local validation infrastructure outside this project.
9. Record fixture hash, external adapter/requirements hashes, raw-oracle output
   hash, normalized-output hash, Python version, `py-aep` commit, and license in
   `manifest.json`/provenance. Static tests consume frozen normalized JSON and
   require no Python, network, or external tooling. Installing the pinned external
   oracle remains approval-gated if its packages are not already cached.
10. Note that live `ae_file_json` currently uses Python internally through the
    existing AE helper; that is a harness prerequisite, not a shipped runtime.
11. Do not use or commit `Super Morphings.aep` or `MP_pseudo3Dstyle.ffx`.
12. Parent reviews distributability and provenance.
13. Stop M2 fixture gate.

If reliable property-scoped templates cannot be captured, stop. An AEUX-derived template requires an explicit Apache-2.0 attribution decision before use.

## 15. Task 4 — Fixture-backed FFX generator

**Create:**

- `src/js/shared/ae-binary/ffx-gradient.ts`
- `tests/native-gradient-ffx.test.ts`
- `scripts/native-gradient/generate-ffx.mjs`

**FFX API:**

```ts
export function findSingleGradientUtf8(
  doc: RiffDocument,
  kind: "fill" | "stroke"
): RiffNode;

export function generateGradientFfx(
  template: Uint8Array,
  kind: "fill" | "stroke",
  gradient: NativeGradient
): { bytes: Uint8Array; report: GradientFfxStructuralReport };
```

**Tests:**

1. Parse each owned template and compare exact model with frozen expected JSON.
2. Repatch each with 2-, 3-, and 8-stop gradients.
3. Reparse generated bytes and compare every color/alpha offset, midpoint, component, and `extra` after expected float32 normalization.
4. Require correct target kind and exactly one `LIST(GCky)/Utf8` candidate.
5. Reject missing/multiple/wrong-kind/malformed templates.
6. Compare span-level preservation:
   - unchanged prefix except explicit size words;
   - target leaf ID/header identity unchanged;
   - target payload/pad replaced;
   - unchanged suffix from old/new `paddedEnd` is byte-identical;
   - trailer bytes and hash identical;
   - ancestor sizes equal old size plus padded delta.
7. Same inputs produce identical bytes.
8. CLI is explain-only unless `--write <output>` is supplied; refuse existing output unless `--force`.
9. CLI computes hashes; shared module does not.
10. Inventory each owned AEP and require exactly one `LIST(GCky)/Utf8` candidate matching frozen expected JSON.
11. Inventory rejects zero/multiple/malformed candidates for the unique-candidate proof mode.
12. Run all tests and both reviews.

**Important:** Node generation proves structural validity only. It does not prove AE accepts 2/3/8 stops or that one template is sufficient. That is M3.

## 16. Task 5 — Build the external live proof harness

**Create:**

```text
scripts/native-gradient/
  proof-setup.jsx
  proof-apply.jsx
  proof-save-readback.jsx
  proof-undo.jsx
  proof-cleanup.jsx
  run-proof.sh
```

No product host, Main, debug API, asset, or CEP config changes.

### Shared config

The shell/Node runner validates a UTF-8 JSON config, then generates a token-
scoped dispatch JSX that embeds the validated config and the absolute path or
contents of exactly one reviewed implementation script. The dispatch sets a
single temporary `$.global` config key, invokes the implementation, and deletes
that global in `finally`. The generated dispatch file—not the implementation
file—is passed to `ae_file_json`. No persistent global config remains.

Config includes:

- run token;
- expected scratch root and exact current project path;
- expected comp ID;
- expected layer ID and index;
- property index/match-name path;
- Fill/Stroke kind;
- exact preset path and expected filename pattern;
- evidence output paths.

### Setup ownership

`proof-setup.jsx` has two phases:

1. project-only preflight validates the exact token scratch project/path before
   any target exists;
2. setup creates or reuses one persistent token-owned comp, removes only token-
   marked test layers/groups, creates one target, then records its IDs/indices
   for target-specific preflight.

Setup may open the persistent token comp because it owns the scratch fixture.
Action/readback/Undo scripts never change the active item. After setup, save in
a separate invocation and assert the project is clean before the case begins.

### Every mutating action JSX preflight

- active project exists and `app.project.file.fsName` equals the exact token-scoped scratch AEP path;
- project is clean at setup start;
- active item is the expected comp and is never changed;
- comp/layer IDs and indices match;
- property path indices and every match name match;
- target parent is exact `ADBE Vector Graphic - G-Fill` or `ADBE Vector Graphic - G-Stroke`;
- `ADBE Vector Grad Colors` is static: no keys/expression;
- preset `File.fsName` is inside the exact token root, basename matches `cp-gradient-<token>-(fill|stroke)-(2|3|8).ffx`, is a file, and size is below the fixture-defined limit;
- no symlink/substitution is accepted by the Node runner: `realpath` for root and file must match expected; Node re-reads and hashes immediately before AE dispatch;
- layer/property selection snapshot is captured.

### Script ownership

`proof-apply.jsx`:

- performs all preflight before `beginUndoGroup`;
- opens exactly one balanced group;
- selects only target layer/property;
- calls `layer.applyPreset(new File(path))`;
- restores layer/property selection in `finally`;
- ends the group in `finally` only if opened;
- returns; it never saves, reads, deletes, or calls Undo.

`proof-save-readback.jsx`:

- is a separate later invocation;
- verifies exact scratch path and token;
- calls `app.project.save()` only for the already-token-scoped scratch project;
- captures and returns full project-item count/IDs, layer inventory, selected
  layer/property identities, target descriptor, and all scriptable sibling
  values both before and after save, plus path/dirty state; Node then inventories
  the saved AEP.

`proof-undo.jsx`:

- is another separate invocation after the apply call has returned and after a real bounded wait;
- verifies exact scratch identity;
- calls stable Undo ID `16` once;
- does not open an undo group;
- returns; save/readback occurs in a fourth invocation.

`proof-cleanup.jsx`:

- never closes or replaces the project;
- retains the persistent token-owned comp and removes only token-marked test
  layers/groups after successful evidence is complete;
- does not run automatically after validation failure.

Cleanup is followed by a separate save invocation and a clean-state assertion
before another case starts.

### Runner behavior

Use canonical helper invocation with real HOME and the absolute helper path:

```bash
env HOME=$HOME zsh -lc 'source $HOME/.ae-helpers.sh && ae_file_json /absolute/path/to/generated-dispatch.jsx'
```

Run serially. No background AE calls.

Before dispatch, runner:

- acquires an atomic single-run lock via `mkdir`; refuses a live lock, records
  owner PID/run token, and removes only its own lock in `trap`;
- uses `$HOME/.local/bin/node` explicitly;
- validates realpaths, hashes, project identity through read-only `ae_run`, and that no second script is running;
- creates generated presets in token root through write-then-rename;
- writes exact command/evidence manifest;
- records selected AE app/version.

Every helper call has an explicit timeout. After apply and Undo return, wait at
least 1,000 ms before the next invocation, then poll bounded read-only identity/
dirty-state probes until stable or timeout. Never retry a mutating call whose
completion is unknown.

On host-call failure before validation, copy/hash the preset and config into evidence, then clean only transient duplicates. On readback mismatch, preserve the generated preset and scratch AEP and stop.

## 17. Task 6 — Execute M3 on AE 26.3

**Current-session approval required.** Parent must confirm the active project is the owned scratch project. Old approval does not carry forward.

### Matrix

For Fill and Stroke:

- 2 stops;
- 3 stops with independent alpha offsets and non-default midpoints;
- 8 stops;
- one 3-stop finite HDR/negative RGB probe.

If the HDR/negative probe is normalized or rejected by AE, record that result and block any product branch that promises exact HDR gradient application. Do not fail the normal-range mechanism proof solely because AE defines a narrower native range.

For every case:

1. Reset to known scratch baseline through token-owned setup.
2. Save and inventory baseline AEP; require exactly one gradient candidate.
3. Generate preset and preservation report.
4. Apply in one invocation.
5. Wait.
6. Save in another invocation.
7. Inventory and compare all stops plus unrelated sibling properties and selection.
8. Call Undo ID `16` in another invocation.
9. Wait.
10. Save in another invocation.
11. Inventory and prove exact baseline restoration.
12. Preserve console/host outputs and cleanup report.

Repeat the complete normal-range matrix twice in the same AE session.

### Pass criteria

- all Fill and Stroke 2/3/8 normal-range cases pass twice;
- separate alpha stops and non-default midpoints are exact within documented float32 normalization;
- unchanged siblings and selection pass;
- preset suffix/trailer preservation reports pass;
- separate Undo restores exact baseline;
- cleanup returns token residue to baseline after successful cases;
- zero skips and zero wrong-target executions;
- no console/JSX errors.

### Decision from count tests

- If one template per kind passes 2/3/8, support generator range 2–8.
- If a count fails due metadata outside `Utf8`, inspect diffs and adopt count-specific owned templates only for live-proven counts.
- Do not add heuristic offset patches.

Stop after M3. Present evidence to Denis before product work.

## 18. Task 7 — Record `PRODUCT-SEMANTICS`

**Completed decision — 2026-07-18:** Denis selected `both_serially`. Implement exact collection first and active-palette application second. The approved action, alpha conversion, stop construction, limits, numeric policy, rejection behavior, Undo/error contract, and release gates are canonical in [`native-gradient-product-semantics.md`](native-gradient-product-semantics.md).

Record a dated decision under `docs/` with:

- selected state from section 5;
- exact user action and UI location;
- data stored versus derived;
- alpha policy;
- stop offset/midpoint policy;
- behavior for fewer than 2 and more than 8 colors;
- HDR/negative policy based on M3 evidence;
- static/keyed/expression/dirty/ambiguous behavior;
- mixed solid + gradient selection behavior;
- Undo and error-copy contract;
- selected implementation track(s) and order.

If `store_gradient_items` is selected, stop and run a new plan-convergence loop for schema, migration, import/export, UI, accessibility, and backwards compatibility.

If `toolkit_only` is selected, stop successfully after documenting M3.

## 19. Conditional Track A — Exact collection

Start only for `collect_stops_only` or `both_serially`.

### A1. Exact match-name classification

Before broadening the current localized `indexOf("Grad")` guards:

- enumerate exact supported parent/property match names;
- keep scriptable Gradient Ramp effect children in the existing solid-color path;
- add host-contract regressions for renamed groups and mixed solid/native-gradient selections;
- do not match display names.

### A2. Read-only target descriptors

Create `src/jsx/aeft/native-gradient-target.ts` and export through `aeft.ts` only after tests fail.

Descriptor requires:

- comp item ID;
- layer ID and index; `layerId` is mandatory on supported hosts;
- property index path from layer root;
- match-name path;
- Fill/Stroke kind;
- saved project path and clean/dirty status.

Collector is read-only and rejects unsaved, dirty, keyed, expression-controlled, locked, unsupported, or ambiguous targets. It never selects, saves, alerts, opens Undo, or writes.

### A3. Saved-AEP resolver spike

Resolve one descriptor to exactly one inventory candidate using serialized comp/layer/property structure. Test duplicate comp/layer/group names, wrong IDs/indices, moved properties, zero matches, and ambiguity.

Hard stop: if stable scoped identity is not present or requires names/nearest-offset heuristics, exact collection is not feasible through this architecture. Do not weaken the resolver. Record alternatives: stricter adaptation of Bodymovin's saved-project parser, later AEGP snapshot helper, or deferred collection.

### A4. Integrate `collect_stops_only`

Only after A3 passes:

- Main requests descriptors, Node reads the clean saved AEP, and exact RGB stops become normal palette RGBA entries;
- Denis must choose alpha conversion at each color offset: interpolated alpha versus forced `1`;
- preserve deterministic traversal, dedupe, and current solid/image behavior;
- normal swatch application continues to report native gradients unsupported;
- add node, host-contract, and live CDP collect tests with saved/dirty/duplicate-name cases.

## 20. Conditional Track B — Production application

Start only for `apply_active_palette` or `both_serially`.

### B1. Product temp-file adapter

Create `src/js/main/native-gradient-files.ts` and promote owned templates to `src/assets/native-gradient/`.

- Main owns `fs`, `path`, `crypto`, realpath, write-rename, re-read/hash, and cleanup.
- Use embedded CEP Node capability self-test from the real Main panel: `process.version`, fs/crypto availability, rename semantics, user agent.
- Feature runtime-gates if embedded CEP Node lacks required APIs.
- Generated preset name/root follow the proven token contract.
- On validation mismatch preserve evidence before cleanup.
- Build/package checks include templates and exclude generated presets/reports.

### B2. Product host apply

Create `src/jsx/aeft/native-gradient-apply.ts` and export through `aeft.ts`.

- all targets belong to already-active comp; never change active item;
- descriptor requires comp/layer IDs, indices, property index/match-name path, and kind;
- host independently checks token root, exact filename, file size, static target, and descriptor drift;
- one balanced Undo group, selection restore in `finally`, no save/delete/Undo;
- reject keyed, expression-controlled, locked, wrong-kind, wrong-comp, ambiguous, or out-of-range gradients.

### B3. Explicit product action

Do not overload normal swatch click. Add the exact action approved in Task 7. Initial deterministic mapping for `apply_active_palette`, if selected:

- require 2–8 active palette colors;
- preserve palette order;
- offsets `i / (n - 1)`;
- midpoint `0.5`;
- one alpha stop per palette color using RGBA alpha unless Denis chose another policy;
- static selected Shape Fill/Stroke only;
- one host call/Undo group; no palette disk write.

### B4. Product live smoke

Add a dedicated runner rather than overgrowing `cep-functional-smoke.mjs`.

Require exact Main identity/build marker, real production action path, token-owned scratch project, saved readback, separate Undo, same-session second run, console capture, and cleanup proof. Rerun current legacy collect/apply smokes and all static tests.

## 21. M5 host-version evidence gate

Chroma Relay's manifest declares AE 22–99 for the product as a whole. That
range is not a native-gradient support claim. Before enabling a product track:

1. Repeat the selected normal-range M3/product smoke on one exact AE 22.x build.
2. Repeat on exact AE 26.3.
3. Do not run AE versions concurrently.
4. Closing/launching/restarting AE requires explicit parent/user approval.
5. Treat those as independent evidence points only. They do not prove AE 23,
   24, 25, other 22/26 minors, or future 27–99 behavior.
6. Runtime-gate native gradients to exact live-proven major/minor families. Add
   each additional AE family only after the same matrix passes, or add version-
   specific owned templates with evidence.
7. Do not claim Windows support until the equivalent Windows temp-path, FFX, readback, Undo, and cleanup matrix passes.

## 22. Verification commands

Core static:

```bash
export PATH=$HOME/.local/bin:$PATH
npm run test:native-gradient
npm run test:domain
npm run test:host-contract
npm run check:cep
```

Core live uses `scripts/native-gradient/run-proof.sh` and serial `ae_file_json` calls. The runner must print the exact output directory and nonzero-exit on skip/partial execution.

After Track A or B changes:

```bash
npm run test:native-gradient
npm run test:domain
npm run test:host-contract
npm run check:cep
npm run react:doctor -- --verbose
npm run build:dev
npm run cdp:self-test
# chosen dedicated live runner
npm run cdp:collect -- --output=<run-dir>/legacy-collect
npm run cdp:apply -- --output=<run-dir>/legacy-apply
npm run build
```

Do not package merely to finish this plan. Packaging is a separate post-freeze approval.

## 23. Fresh-session delegation brief

### Parent startup

1. Start in Chroma Relay repo.
2. Load the four Hermes skills named at the top. If a skill is unavailable in a future profile, call `skills_list`, load the nearest current equivalent, and record the substitution; do not confuse repo `.claude` skills with Hermes profile skills.
3. Read this full plan and create todos for M0–M3 only.
4. Recheck repo/Node/AE facts.
5. Establish the recoverable baseline and task ledger.
6. Do not schedule conditional tracks.

### Serial assignment

- Implementer 1: Task 1 byte/RIFX core.
- Implementer 2: Task 2 `GCky` codec.
- Implementer 3: Task 3A synthetic AEP inventory.
- Parent/human: Task 3B fixture acquisition.
- Implementer 4: Task 4 fixture-backed FFX generator.
- Implementer 5: Task 5 external proof harness.
- Parent: Task 6 live execution.
- Denis: Task 7 product decision.
- Fresh sequence: chosen Track A or B only.

### Review loop per implementation task

1. Implementer receives exact task text, source paths, allowed paths, baseline hashes, and test command.
2. Parent inspects status and files; a timeout is not automatically a failure.
3. Spec reviewer checks requirements only.
4. Fix all blockers/high issues and rerun focused plus regression tests.
5. Quality/security reviewer checks binary bounds, failure behavior, side effects, and maintainability.
6. Fix and rerun.
7. Mark task complete in ledger; no overlapping writer begins before that.
8. Stop at milestone boundary.

## 24. Failure preservation and cleanup

Routine successful case:

- copy final reports to evidence;
- delete generated temp FFX/config files;
- remove only token-owned test items;
- prove residue returned to baseline.

Host-call failure before semantic validation:

- copy/hash preset, config, host output, and logs into evidence;
- cleanup only transient duplicates after preservation;
- do not retry unknown-completion work automatically.

Readback/Undo/selection mismatch:

- preserve generated preset and scratch AEP;
- do not run project cleanup;
- stop all further mutation;
- classify the failure and return evidence to parent.

Never attempt compensating mutations in a user project.

## 25. Acceptance checklist

### M0

- [ ] Baseline commit approved, or immutable out-of-repo manifest/backups exist.
- [ ] Task ledger owns exact writable paths.
- [ ] Node/npm resolve to `$HOME/.local/bin` and type stripping works.
- [ ] Denis authorized npm resolution; `.node-version`, packageManager, engines,
      lockfile, and CONTRIBUTING agree.
- [ ] Clean temporary `npm ci --ignore-scripts` and static tests pass.
- [ ] Domain/host/AutoTools baselines pass.

### M1

- [ ] RIFX parser models root/LIST form types and source spans.
- [ ] `GCky` is handled as a LIST with one Utf8 child.
- [ ] Trailer and unchanged suffix are byte-identical after patching.
- [ ] Only target/ancestor size words and target payload/pad change.
- [ ] Bounded malformed and seeded randomized tests pass.
- [ ] `GCky` XML round trips exact static color/alpha stops.
- [ ] Shared modules contain no fs/path/crypto imports.

### M2

- [ ] Fill and Stroke fixtures are owned, minimal, distributable, and hashed.
- [ ] Expected oracle JSON is frozen with pinned provenance.
- [ ] 2/3/8 generated outputs reparse structurally.
- [ ] Unique-candidate scratch AEP inventory matches oracle JSON.
- [ ] No production/project fixture is committed.

### M3

- [ ] Parent confirms token scratch project in current session.
- [ ] Fill and Stroke 2/3/8 pass twice in same AE 26.3 session.
- [ ] Separate alpha stops and non-default midpoints survive.
- [ ] HDR/negative behavior is recorded and gates product promises.
- [ ] Siblings and selection remain unchanged.
- [ ] Separate Undo restores exact baseline.
- [ ] No hidden skip/zero-target pass.
- [ ] Failure preservation and successful cleanup are proven.

### Product

- [x] `PRODUCT-SEMANTICS` is explicit: `both_serially`, collection before application.
- [ ] Only selected track is implemented.
- [ ] Collection never uses names/nearest candidate heuristics.
- [ ] Application is an explicit action with bounded stop policy.
- [ ] Embedded CEP Node capabilities are live-proven.
- [ ] Native-gradient behavior is enabled only for exact live-proven AE families;
      product manifest range is not treated as gradient proof.
- [ ] Windows remains unclaimed until proved.

## 26. Reopen rules

- **AutoTools/shared package:** reopen only when a second real consumer needs the same module.
- **Dirty/unsaved snapshots:** reopen only when saved-project collection is a confirmed user blocker; run a separate AEGP `SaveProjectToPath` spike.
- **Keyframed gradients:** reopen only after static support ships and animation semantics are approved.
- **Layer Style gradients:** reopen only after Shape Fill/Stroke is green and minimal property-scoped presets are separately proven.
- **More than eight stops:** reopen only when approved product semantics require it and count metadata is understood.
- **Windows:** required before public cross-platform release claim.

---

## Final handoff

A fresh agent executes M0–M2 node/fixture work first. M3 is a parent-owned live gate. The plan stops after M3 for Denis's product decision. Exact binary capability is not permission to choose UX, mutate a user project, or advertise broad gradient support.
