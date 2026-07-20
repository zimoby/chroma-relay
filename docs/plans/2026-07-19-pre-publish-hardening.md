# Chroma Relay pre-publish hardening implementation plan

**Intended path:** `docs/plans/2026-07-19-pre-publish-hardening.md`
**Plan date:** 2026-07-19
**Status:** Ready for parent orchestration; implementation not started
**Baseline:** clean local `main` at `c68a477589221964d0ef9c6facbcdd46c0406312`

## Goal

Produce a pragmatic, professional publication candidate by fixing demonstrated safety, storage, compatibility, runner, and release-gate defects without redesigning the product.

Preserve:

- React, Vite, CEP, the existing Node test runner, and current persistence schemas.
- Stable comp/layer/property identity and per-target re-resolution.
- One host call and one Undo group per native-gradient action.
- No automatic retry after unknown completion.
- Fail-closed native-gradient behavior and cleanup evidence.
- Main as the only durable palette writer.
- Chrome 74 and AEFT 22 compatibility.
- Exact private dependency pins and existing FFX bytes unless separately live-proven.

Do not introduce a state framework, RPC framework, generic polyfill layer, broad dependency upgrades, coverage percentages, exhaustive AE matrices, or large component rewrites.

## Architecture and technology

- React 19 Main and Settings panels.
- CEP/Vite 6 renderer output targeting Chrome 74.
- TypeScript 5.8.
- Rollup/Babel ExtendScript host bundle.
- Node 22.22.3 and npm 10.9.8.
- Node’s built-in test runner.
- Private `@zimoby/ae-native-gradient` dependency.
- CDP runners for explicitly approved live evidence.
- Windows GitHub Actions release job.

```text
Main React
  ├─ sole palette writer and recovery promoter
  ├─ collection, image extraction, solid/native application orchestration
  └─ evalTS → ExtendScript host

Settings React
  ├─ sole settings writer
  ├─ read-only palette view
  └─ revisioned palette commands → Main

Shared domain/adapters
  ├─ palette/layout/portable schemas
  ├─ storage and image adapters
  └─ native preset generation, leases, decoding, cleanup

ExtendScript host
  ├─ stable selection/target descriptors
  ├─ solid and native target re-resolution
  └─ preflight → one Undo group → mutation → restoration/finalization

Build/evidence
  ├─ Chrome 74 renderer and AEFT 22-compatible host bundle
  ├─ static Node suites
  ├─ bounded CDP/live runners
  └─ package/release verification
```

## Decision

**NO-GO until all FIX NOW slices, applicable LIVE GATES, and all POLICY GATES are closed.**

Native-gradient collection and application will be permitted only on `darwin` with AE `25.6.x` until additional evidence exists. Windows and unknown platforms must reject before reading Macintosh-captured FFX files, creating leases, parsing native-gradient project data, or invoking native-gradient host mutation.

The existing selection evidence and failed Track B evidence mean different things:

- `evidence/local/selection-scope/ae25-live.json` remains valid bounded evidence. It reports `passed:true` on AE `25.6.6x4`, covers selection/solid scope plus several native descriptor-collection cases, and records fixture cleanup. It is not commit/artifact-bound and does not prove FFX application, readback, unknown completion, or the release matrix.
- All seven formal reports under `evidence/local/native-gradient/track-b-apply-ae25/*/report.json` have `passed:false`. None can close the Track B release gate.

## BLOCKER/HIGH audit dispositions

| Audit finding | Disposition | Verified evidence and treatment |
|---|---|---|
| Testing B1: native gradient not OS-gated | **CONFIRMED** | `native-gradient-contract.ts:30-34` gates only version; `native-gradient-files.ts:927-955` accepts Windows temp paths; `main.tsx:570-577` passes no platform. Macintosh provenance is recorded at `native-gradient-provenance.md:66-68`. Slice 2 adds Darwin-only gating. |
| Testing B2: empty collect output can delete repository | **CONFIRMED** | `cep-native-gradient-collect-smoke.mjs:20-25` resolves empty `--output=` to the repo root and line 262 recursively removes it. Slice 4 replaces caller-selected deletion with validated, exclusive run-token directories. |
| Testing H1: live marker/schema assumptions are stale | **CONFIRMED** | Runners expect `I11`, palette v2, or settings v3 while `debug-api.ts:1`, `palette-domain.ts:6`, and `layout-settings-domain.ts:1` expose `Palette v2 · 0.0.1`, v3, and v4. Slice 4 centralizes the contract and repairs runners. |
| Testing H2: no passing native-gradient Track B | **LIVE_GATE** | Exactly seven formal reports exist and all are false. Static workers cannot close this. Parent must obtain two same-session passes from frozen, HEAD-bound bits. |
| Testing H3: legacy passes are not HEAD-bound | **NARROWED** | Legacy URL/marker checks are insufficient. The bounded selection report still establishes its recorded cases, but not loaded commit identity or the full release matrix. Slices 4–5 add build provenance and artifact hashes; existing evidence remains historical. |
| Testing H4: legacy runners do not own mutation state | **CONFIRMED** | `cep-functional-smoke.mjs` uses fixed temporary roots, assumes pre-existing fixtures for collect/apply, and does not prove full original project/selection restoration. Slice 5 repairs the existing runner. |
| Testing H5: malformed/closed CDP can hang cleanup | **CONFIRMED** | Several message callbacks call `JSON.parse` directly; palette management has no timeout/close rejection. `run-live-ae-tests.mjs:87-120` already supplies the safer pattern. Slices 4–5 consolidate that behavior. |
| Testing H6: tag publishes without tests | **CONFIRMED** | `.github/workflows/main.yml` runs `npm ci`, `npm run zxp`, then release upload. Slice 6 adds mandatory static, release-contract, and artifact gates. |
| Architecture B1: toolkit `.at()` breaks Chrome 74 | **CONFIRMED** | Consumer call: `native-gradient-collection.ts:145-146`; installed failure: `node_modules/@zimoby/ae-native-gradient/dist/aep-gradient-identity.js:115`; upstream source: `../ae-native-gradient-toolkit/src/aep-gradient-identity.ts:172`; emitted Main CJS retains `.at(-1)`. Slice 1 repairs upstream; Slice 6 repins only after the commit is reachable. |
| Architecture B2: enabled native behavior lacks full gate | **NARROWED** | The failed Track B portion is a parent-owned live gate. The additional static defect is real: native collection has no platform/version gate before parsing and persistence. Slice 2 adds an atomic runtime gate while preserving the bounded AE25 selection evidence. |
| Architecture H1: invalid host results can delete evidence | **CONFIRMED** | `native-gradient-files.ts:1003-1040` trusts only `status`/`primaryStatus`; `{}`, truncated success, or contradictory results can become deterministic and be cleaned. Slice 2 adds a versioned decoder and unknown-completion preservation. |
| Architecture H2: Settings can promote palette recovery | **CONFIRMED** | Settings calls `loadPalette()` at `settings.tsx:210,722`; that loader renames `.tmp`/`.bak` at `palette-storage.ts:70-84`. Slice 3 separates inspection from Main-only promotion. |
| Architecture H3: release can publish incomplete output | **CONFIRMED** | Same root defect as Testing H6, plus no tag/version or required-runtime-file validation. Slice 6 closes the broader artifact contract. |
| Architecture H4: publisher/signing/licensing unresolved | **POLICY_GATE** | `cep.config.ts` retains placeholder organization metadata and reads the signing password only from `ZXP_PASSWORD`; the toolkit is `UNLICENSED`; root LICENSE names Hyper Brew. Humans must decide identity, rights, and certificate policy. No worker receives or commits secrets. |

No audit BLOCKER/HIGH was classified as a false positive.

## Scope tiers

### FIX NOW before publish

- Chrome 74 toolkit repair and exact consumer repin.
- Darwin/AE25.6 native collection and application gates.
- Strict host-result decoding and conservative unknown-completion handling.
- Native lease lifecycle, combined finalization/cleanup reporting, count units, and bounded diagnostics.
- Main-only palette recovery; settings recovery; lost-result timeout convergence.
- Bounded regular-file image reads.
- Solid-target re-resolution/finalization behavioral tests.
- Safe CLI parsing, CDP clients, temporary ownership, fixture ownership, restoration proof, and HEAD-aware live reports.
- One authoritative product identity/schema contract.
- One aggregate `npm run verify:static`.
- Fresh-build Chrome scanning, release workflow gate, artifact integrity, provenance, and privacy-log removal.
- Truthful README, storage, status, changelog, semantics, and evidence indexes.

### Parent-owned LIVE GATES

Only after all safe static hardening is integrated:

- Mac AE 25.6.6 formal Track A/Track B runs.
- Mac AE 26.3 non-native regression and fail-closed native checks.
- AEFT 22 floor smoke or narrowing of the advertised floor.
- Windows runtime checks and native fail-closed proof.
- Package creation/signing and signed-artifact inspection.
- Any CDP, AE mutation, panel reload, fixture creation, or evidence commit.

### Human POLICY GATES

The owner must decide and record:

- Final product, publisher, organization, and CEP identities.
- Certificate continuity and where signing secrets are supplied.
- Product copyright/license and Hyper Brew attribution.
- Private-toolkit redistribution rights and source-public versus binary-only policy.
- Platforms and AE versions that may be advertised.
- Reviewed immutable SHAs for release workflow actions.

The parent applies approved metadata. Secrets stay outside Git and agent prompts.

### High-leverage after publish

- Replace the wildcard-any renderer `Scripts` stub with a narrow DTO map.
- Replace touched positive source-string assertions with behavioral seams.
- Split oversized Main, Settings, host, and runner modules only along stable boundaries.
- Consolidate stable path identity after current behavior is frozen.
- Add React freshness/revision reducer tests if runtime regressions appear.

### Deferred or rejected

- Windows native gradients: reopen only after Windows-owned FFX provenance and the full readback/Undo/cleanup matrix.
- React Doctor as a release blocker: reopen only with reliable machine-readable completion.
- Portable serializer name validation: reopen when a second unvalidated caller appears.
- Broad React/CEP/Vite replacement, Redux/Zustand, polling, databases, cross-process services, dependency churn, polyfill frameworks, exhaustive matrices, and coverage targets are rejected.

## Execution rules

- Every implementation worker uses `gpt-5.6-luna` with high reasoning in an isolated local worktree.
- Maximum three active worktrees in a wave.
- Worktrees start from the exact baseline or the stated integrated milestone.
- Worker commits are local and permitted; no worker pushes, deploys, packages, signs, or runs live AE/CDP.
- Installs, network access, package creation, and builds require the parent’s normal approval.
- Tests are RED → GREEN → focused cleanup.
- Proof is written outside the repository under `/private/tmp/chroma-relay-hardening/`.
- Before and after each slice, record `git ls-files --eol -- <owned-files>`.
- Existing `i/crlf` files must remain `w/crlf`; new text files use LF.
- Each review checks `git diff --check`, `git diff --numstat`, `git status --porcelain=v1 -uall`, and rejects whole-file line-ending churn.

## Milestones and worktree waves

1. **M0 — Parent setup:** save this plan, verify clean baseline, create proof directory and isolated worktrees.
2. **Wave 1 — Three parallel Luna slices:** S1, S2, S3.
3. **M1 review:** separate spec and quality reviews; cherry-pick Chroma Relay commits S2 then S3. S1 remains in the upstream repository.
4. **Wave 2 — S4:** product contract and legacy runner core, based on M1.
5. **M2 review:** cherry-pick S4 and run its focused static gate.
6. **Wave 3 — S5:** functional/formal runner lifecycle and build identity, based on M2.
7. **M3 review:** cherry-pick S5; no live execution.
8. **Cross-repo gate:** Denis/parent makes the reviewed S1 commit reachable in the private upstream. No agent pushes it.
9. **Wave 4 — S6:** exact consumer repin, aggregate/release/package/privacy/docs work, based on M3 and the supplied upstream SHA.
10. **M4 frozen static integration:** policy decisions applied by parent; `verify:static` green on a clean integration commit.
11. **M5 parent live/package gates:** run the smallest release matrix against frozen bits.
12. **M6 final Sol review/fix loop.**

## S1 — Upstream Chrome 74 repair

**Objective:** Remove the transitive `.at()` runtime requirement at its source and produce a reviewed local upstream commit.

**Exclusive files, upstream repository**

- `src/aep-gradient-identity.ts`
- `tests/aep-gradient-identity.test.ts`
- New `tests/chrome-floor.test.ts`

**RED tests**

- The freshly built `dist/aep-gradient-identity.js` must contain no `.at(`.
- Exact identity indexing/resolution fixtures must remain unchanged.

**Minimal implementation**

Replace `matchNamePath.at(-1)` with length-checked indexed access. Do not change traversal, descriptors, fixtures, exports, or package version.

**Commands**

- Focused: `npm run build && node --experimental-strip-types --test tests/aep-gradient-identity.test.ts tests/chrome-floor.test.ts`
- Broader safe: `npm test`
- Parent-approved package-boundary check: `npm run pack:check`

**Proof artifact:** `/private/tmp/chroma-relay-hardening/s1-upstream.json`, including tests, diff/EOL summary, and local commit SHA.

**Commit:** `fix: support Chrome 74 identity traversal`

**Non-goals:** consumer pin, public push, polyfill, package publication, dependency upgrade, template changes.

**Spec review**

- Only the last-element expression changed.
- Built output contains no `.at(`.
- Identity fixture outputs and public exports are unchanged.
- No consumer or `node_modules` patch is presented as the fix.

**Quality review**

- Upstream full tests pass.
- Package boundary remains dependency-free.
- No generated/untracked runtime file is omitted.
- Line endings and unrelated files are unchanged.

**Cross-repo gate**

The parent must provide the actual reviewed upstream commit SHA after it is reachable from the private repository. Do not invent a SHA. Slice 6 may proceed with the consumer pin only when `npm ci` can resolve that exact commit and the lockfile records it.

## S2 — Native-gradient fail-closed wire and lifecycle

**Objective:** Make native collection/application Darwin-and-AE25.6-only and treat every unvalidated post-call result as unknown completion.

**Exclusive files**

- `src/js/shared/native-gradient-contract.ts`
- `src/js/main/native-gradient-files.ts`
- `src/js/main/main.tsx`
- `src/jsx/aeft/native-gradient-apply.ts`
- `tests/native-gradient-application.test.ts`

**RED tests**

- `win32`, unknown platform, or unsupported AE with native content performs zero template reads, AEP native parsing, lease creation, palette writes, and native host calls.
- Solid-only collection remains available on otherwise supported AEFT hosts.
- `null`, `{}`, truncated success, unknown/future status, `{status:"ok", primaryStatus:"apply-unknown-completion"}`, impossible counts/indexes, or invalid finalization flags after invocation preserve both leases and never retry.
- Host responses require `schemaVersion:1`.
- Second RNG failure after root creation leaves no owned directory.
- Finalization plus cleanup failure reports both failures.
- Disabled-branch and preserved-property units are not added into one ambiguous number.
- Diagnostics are count- and length-bounded.

**Minimal implementation**

- Add a pure renderer runtime decision for platform plus host version.
- Add `unsupported-platform`.
- Gate mixed/native collection atomically before native AEP parsing or palette persistence.
- Add a schema-versioned decoder with explicit status/count/index/finalization invariants.
- Invalid fulfilled responses after a host call become unknown completion.
- Preserve leases on transport or decoded uncertainty.
- Keep one invocation and no retry.
- Add explicit branch/property count names while retaining validated legacy aliases.
- Move all post-`mkdirSync` work inside the cleanup guard.
- Compose primary, finalization, and cleanup messaging independently.

**Commands**

- Focused: `npm run test:native-gradient`
- Broader safe: `npm run test:host-contract && npm run test:domain && ./node_modules/.bin/tsc -p tsconfig-build.json --noEmit`
- Integrated: `npm run verify:static`

**Proof artifact:** `/private/tmp/chroma-relay-hardening/s2-native.json`.

**Commit:** `fix: fail closed on native gradient uncertainty`

**Non-goals:** FFX byte changes, Windows enablement, retry, target traversal rewrite, extra Undo groups, new transport.

**Spec review**

- Only Darwin/AE25.6 reaches native templates or native collection parsing.
- Unknown completion always preserves evidence and never retries.
- One host call, one `applyPreset` site, one Undo group, stable descriptors, and per-target re-resolution remain.
- Cleanup never overwrites finalization evidence.
- Existing bounded selection evidence is not relabeled.

**Quality review**

- Contradictory wire cases are table-driven.
- Error text and arrays are bounded.
- Existing success, deterministic rejection, partial, unknown, restoration, and cleanup tests remain green.
- CRLF `main.tsx` remains CRLF with no wholesale rewrite.

## S3 — Storage ownership, bounded image input, and solid behavior

**Objective:** Enforce single-writer recovery, converge lost-result timeouts without resend, bound image reads, and behavior-test solid re-resolution.

**Exclusive files**

- `src/js/shared/palette-storage.ts`
- `src/js/shared/layout-settings.ts`
- `src/js/shared/image-palette-file.ts`
- `src/js/settings/settings.tsx`
- `src/jsx/aeft/color-apply.ts`
- `tests/host-contract.test.mjs`
- New `tests/palette-storage.test.ts`
- New `tests/layout-settings-storage.test.ts`
- New `tests/image-palette-file.test.ts`

**RED tests**

- Settings inspection performs zero palette create/rename/delete/promote calls.
- Main promotion handles valid temp/backup, invalid primary, promotion failure, interrupted replacement, rollback, queued writes, and residue.
- Settings load recovers valid `.tmp`/`.bak` content without creating a second settings writer.
- Lost palette-result timeout reloads through read-only inspection, says completion is unknown, and never resends.
- Directory, non-regular, missing, changed, and `32 MiB + 1` image inputs fail before full read.
- Decode/canvas failures always revoke object URLs.
- Solid target wrapper replacement/reindex after an earlier mutation uses a fresh wrapper; failures continue deterministically; `endUndoGroup` occurs exactly once.

**Minimal implementation**

- Separate read-only palette inspection from Main-only promotion.
- Return recovery promotion errors inside the load result.
- Inspect valid settings recovery candidates without load-time mutation.
- On Settings timeout, inspect authoritative palette state and unlock without resend.
- Add `MAX_IMAGE_FILE_BYTES = 32 * 1024 * 1024`, regular-file/stat checks, and narrow injectable seams.
- Change solid implementation only if the RED behavioral test exposes a real defect.

**Commands**

- Focused: `node --experimental-strip-types --test tests/palette-storage.test.ts tests/layout-settings-storage.test.ts tests/image-palette-file.test.ts`
- Focused host: `npm run test:host-contract`
- Broader safe: `npm run test:domain && npm run test:host-contract`
- Integrated: `npm run verify:static`

**Proof artifact:** `/private/tmp/chroma-relay-hardening/s3-storage-input.json`.

**Commit:** `fix: harden storage ownership and bounded inputs`

**Non-goals:** cross-process locks, polling, schema changes, streaming decoder, image-library replacement, second palette writer.

**Spec review**

- Main is the only palette artifact mutator.
- Settings remains the only settings writer.
- Timeout cannot cause replay.
- Invalid primaries and valid recovery candidates are preserved safely.
- Image cap applies before allocation/read duplication.
- Solid identity and Undo invariants remain stable.

**Quality review**

- Temporary test directories are empty or intentionally preserved after each case.
- Browser/CEP seams remain narrow and production behavior is unchanged.
- No positive source-string assertion substitutes for the new storage/solid behavior tests.
- CRLF/LF status is preserved per file.

## S4 — Authoritative product contract and safe legacy runner core

**Objective:** Remove stale identity/schema duplication and make the smaller legacy CDP runners fail safely before mutation.

**Exclusive files**

- New `src/shared/product-contract.json`
- `cep.config.ts`
- `src/js/shared/debug-api.ts`
- `src/js/shared/palette-domain.ts`
- `src/js/shared/layout-settings-domain.ts`
- `src/js/shared/layout-settings.ts`
- `src/js/shared/palette-transfer.ts`
- `src/js/shared/palette-events.ts`
- New `scripts/lib/cdp-client.mjs`
- New `scripts/lib/live-runner-policy.mjs`
- `scripts/cep-native-gradient-collect-smoke.mjs`
- `scripts/cep-cdp.mjs`
- `scripts/cep-design-capture.mjs`
- `scripts/cep-persistence-smoke.mjs`
- `scripts/cep-palette-management-smoke.mjs`
- New `tests/product-contract.test.mjs`
- New `tests/live-runner-contract.test.mjs`

**RED tests**

- Contract values disagreeing with package/config/debug identity, palette v3, settings v4, or portable v2 fail statically.
- Empty, duplicate, unknown, absolute, root, traversal, and symlink-escape output arguments fail before filesystem calls.
- Malformed CDP, close/error before response, timeout, duplicate ID, and late result reject pending calls and permit cleanup.
- Stale marker/schema assumptions fail.
- Fixed-root collision or foreign ownership refuses mutation.
- Rejected CLI cases make zero filesystem mutations.

**Minimal implementation**

- Make `product-contract.json` authoritative for technical product IDs, marker lineage, and schema versions; package version remains authoritative in `package.json`.
- Import the contract into runtime/config domains and every runner.
- Extract the already-proven bounded CDP behavior from `run-live-ae-tests.mjs`.
- Use exclusive run-token directories and ownership files.
- Preserve caller output roots; create a unique child and never recursively delete a caller-selected directory.
- Update current marker/schema expectations without rewriting historical evidence.

**Commands**

- Focused: `node --experimental-strip-types --test tests/product-contract.test.mjs tests/live-runner-contract.test.mjs`
- Broader safe: `npm run test:domain && npm run test:native-gradient && npm run test:host-contract`
- Integrated: `npm run verify:static`

**Proof artifact:** `/private/tmp/chroma-relay-hardening/s4-runner-core.json`.

**Commit:** `test: make CDP runners bounded and contract-driven`

**Non-goals:** executing CDP, deleting old evidence, new test framework, changing user data, resolving publisher/license policy.

**Spec review**

- Runners contain no independent current marker/schema literals.
- Rejected arguments cannot reach `rm`, `mkdir`, CDP, or AE.
- Only owned token children may be recursively removed.
- All pending socket calls terminate deterministically.
- Reports distinguish pass, failure, cleanup, and historical evidence.

**Quality review**

- Helpers are small and importable without running a runner.
- Fake-WebSocket and fake-filesystem tests cover cleanup paths.
- No runner module performs work at import time.
- Existing command names remain unless safety requires a documented argument refinement.

## S5 — Functional/formal runner lifecycle and HEAD identity

**Objective:** Repair existing mutation runners so future parent-owned live evidence is self-owned, restorable, and bound to frozen source and loaded assets.

**Exclusive files**

- `scripts/cep-functional-smoke.mjs`
- `scripts/run-live-ae-tests.mjs`
- `vite.config.ts`
- New `tests/live-runner-lifecycle.test.mjs`

**RED tests**

- Functional collect/apply refuses a missing or foreign fixture and invokes its committed setup path for its own fixture.
- Concurrent mode collision, stale lock, partial setup, panel close, and cleanup failure produce durable failures.
- Original project path, active item, layer/property selection, palette/settings bytes, and fixture residue are independently represented.
- Formal reports require clean `gitHead`, build provenance, exact page/runtime asset hashes, manifest, host bundle, and both templates.
- A stale dist/provenance pair or changed runtime asset is rejected.
- Report-schema drift caused by the stricter native decoder fails statically.

**Minimal implementation**

- Adopt Slice 4’s CDP/path policies.
- Give functional modes unique roots, ownership locks, self-created fixtures, and restoration checks.
- Add build provenance during Vite output without committing generated dist.
- Require formal Track B to begin from a clean commit and record it.
- Keep the stronger formal runner’s existing exact target selection, storage snapshot, lock, restoration, residue, and lease checks.
- Update expectations for the versioned native host result; do not weaken assertions to make failed reports pass.

**Commands**

- Focused: `node --test tests/live-runner-lifecycle.test.mjs`
- Broader safe: `node --experimental-strip-types --test tests/product-contract.test.mjs tests/live-runner-contract.test.mjs tests/live-runner-lifecycle.test.mjs`
- Integrated: `npm run verify:static`

**Proof artifact:** `/private/tmp/chroma-relay-hardening/s5-runner-lifecycle.json`.

**Commit:** `test: bind live runners to owned state and HEAD`

**Non-goals:** live AE/CDP, fixture mutation, rewriting runner framework, claiming old failures as passes.

**Spec review**

- Every mutation target is created and identified by the current run.
- Original project, selection, storage, panel, leases, and residue have separate cleanup outcomes.
- A passing report proves current clean commit plus exact loaded runtime bytes.
- Existing seven false Track B reports remain false and immutable.

**Quality review**

- Failure reports survive cleanup failures.
- Locks and run roots verify ownership before removal.
- No hard-coded local npm executable remains where `process.execPath`/current environment suffices.
- Runner changes remain testable without AE.

## S6 — Aggregate static, release/package, privacy, and documentation gate

**Prerequisite:** the parent supplies a reachable reviewed S1 upstream SHA and has approved any required install/network operation.

**Objective:** Repin the exact toolkit repair and make tags/artifacts traceable, tested, private, and truthfully documented.

**Exclusive files**

- `package.json`
- `package-lock.json`
- `scripts/check-cep-compat.mjs`
- `scripts/package-alpha.mjs`
- New `scripts/verify-release-contract.mjs`
- New `scripts/verify-artifact.mjs`
- `.github/workflows/main.yml`
- `src/js/lib/utils/bolt.ts`
- `src/js/lib/utils/cep.ts`
- `src/js/main/index-react.tsx`
- `src/js/settings/index-react.tsx`
- `tests/native-gradient-package-integration.test.ts`
- New `tests/release-contract.test.mjs`
- `README.md`
- `CONTRIBUTING.md`
- `CHANGELOG.md`
- `docs/STORAGE.md`
- `docs/implementation-status.md`
- `docs/native-gradient-product-semantics.md`
- `docs/native-gradient-binary-toolkit-implementation-plan.md`
- `evidence/README.md`

**RED tests**

- Lockfile/installed package SHA differs from the parent-supplied upstream SHA.
- Any emitted renderer CJS contains `.at(` or another forbidden Chrome 74 API.
- `check:cep` sees missing, stale, dirty-release, or hash-drifted build provenance.
- Tag, package, manifest, and authoritative identity disagree.
- Required panel pages, host bundle, Fill/Stroke templates, icons, or non-empty assets are missing.
- Package contains maps, debug APIs, serialized host arguments, absolute startup paths, milestone logs, placeholders, or unexpected files.
- Archive cannot be reopened or its inventory/hash differs.
- Workflow can reach ZXP/upload before static, release-contract, and artifact checks.
- Package report lacks commit, dirty state, Node/npm versions, manifest identity, runtime hashes, archive inventory, and aggregate SHA.

**Minimal implementation**

- Repin only `@zimoby/ae-native-gradient` to the actual reachable S1 SHA and regenerate the lockfile normally.
- Add `test:runner-contract`.
- Add one aggregate `verify:static`: fresh build, domain, host, native, runner contracts, then emitted CEP compatibility scan.
- Add separate release-contract and post-package artifact checks.
- Scan all emitted renderer assets and host output.
- Enrich package reports and reopen archives.
- Gate serialized eval arguments and absolute startup logs; remove milestone entrypoint logs.
- Require immutable reviewed action SHAs and ordered workflow gates.
- Reconcile documentation with current schemas, npm, bounded selection evidence, seven failed Track B reports, pending live gates, and historical package status.
- Do not edit `LICENSE`, publisher values, or signing credentials without the human gate.

**Commands**

- Focused: `node --experimental-strip-types --test tests/native-gradient-package-integration.test.ts tests/release-contract.test.mjs`
- Broader safe: `npm run verify:static`
- Parent-only after permission: `npm run package:alpha`, `npm run verify:artifact`, and signed ZXP commands.

**Proof artifact:** `/private/tmp/chroma-relay-hardening/s6-release.json`.

**Commit:** `build: enforce pre-publish release gates`

**Non-goals:** signing, publishing, pushing, generic upgrades, live AE, silently replacing historical evidence, choosing legal policy.

**Spec review**

- Installed package, package/lock pins, and emitted renderer all reflect the supplied upstream SHA.
- `verify:static` is the sole aggregate static entry point.
- Workflow cannot upload if any prior gate fails.
- Reports bind artifact bytes to a clean commit.
- Documentation does not promote bounded selection evidence into Track B or a broad matrix.

**Quality review**

- Package lock changes are limited to the exact private pin.
- Archive/path checks reject traversal and duplicate entries.
- Runtime imports are tracked.
- Workflow secrets appear only as secret references.
- CRLF package/README files retain CRLF.

## Integration and conflict strategy

Chroma Relay cherry-pick order:

1. S2 native safety.
2. S3 storage/input safety.
3. S4 contract/runner core.
4. S5 lifecycle/provenance.
5. S6 consumer/release/docs.

S1 remains an upstream-repository commit and is referenced only after the cross-repo reachability gate.

After every cherry-pick:

- Confirm only expected files changed.
- Run the slice’s focused tests.
- Run `git diff --check`.
- Inspect untracked runtime files.
- Compare EOL state to baseline.
- Record integration commit and proof.

If a serial slice touches a previously changed file, rebase it on the integrated milestone before review. Never resolve with wholesale “ours” or “theirs.” Reconstruct the intended change and rerun both affected focused suites. Only S6 may regenerate `package-lock.json`; do not hand-merge its dependency entry.

## Release-readiness matrix

| Gate | Required proof | Consequence |
|---|---|---|
| Static | Clean exact pin; `npm run verify:static`; typecheck; all emitted renderer/host scans; runner safety tests; no EOL churn | Required before live work |
| Package | Clean commit; tag/package/manifest equality; required files; archive reopen; per-runtime hashes; aggregate SHA; no debug/log/privacy residue | Required before upload |
| Mac AE 25.6.6x4 | Preserve bounded selection-scope evidence; obtain two consecutive formal Track B passes in one session covering Fill, Stroke, exact/group/layer/multi-layer, gradient slot, palette action, readback, stable identity, one Undo, unknown/no-retry, restoration, cleanup, and residue | Required for native-gradient publication |
| Mac AE 26.3 | Panel open, palette/settings reload, image, solid collect/apply; native collection/application reject before native disk/template/host work | Required current-version regression |
| AEFT 22 floor | Install/open, palette reload/write, settings, solid collect/apply, one Undo; native behavior rejects | Pass or narrow manifest/README floor |
| Windows CI | Node 22.22.3, exact private install, `verify:static`, production build, package checks | Required on every tag |
| Windows AE | Storage replacement, dialogs, image decode, solid collect/apply, cleanup; native collection/application statically and live fail closed | Required for a Windows runtime claim |
| Windows native gradients | Separately captured/distributable Windows FFX plus full application/readback/Undo/cleanup matrix | Deferred; not a Mac release blocker while disabled |
| Publisher/signing/license | Owner-approved identity, certificate continuity, secret handling, product license/attribution, toolkit redistribution, and action SHAs | Required before public distribution |

Live reports must use frozen clean integration bits. A failed run stays failed; it may diagnose a runner but cannot satisfy a release row.

## Final Codex CLI review/fix-loop contract

Run only after static, package, applicable live, and policy gates are complete.

Preflight:

```bash
git status --short --branch
git diff --stat
git diff --cached --stat
git status --porcelain=v1 -uall
git diff --cached --name-status
git ls-files --others --exclude-standard
npm run verify:static
```

Independent review:

```bash
codex exec \
  -C /absolute/path/to/integration-worktree \
  -m gpt-5.6-sol \
  -c 'model_reasoning_effort="xhigh"' \
  -s read-only \
  'Review the complete change from c68a477589221964d0ef9c6facbcdd46c0406312, including staged, unstaged, and untracked runtime files, for blockers only. Check correctness, data loss, unknown-completion handling, single-writer storage, Chrome 74/AEFT 22 compatibility, live-runner safety, package provenance, workflow ordering, and deploy/import consistency. Treat findings as hypotheses. Ignore style-only changes, broad refactors, coverage targets, and speculative optimization. If no blocker remains, say exactly: OK TO PUBLISH.'
```

Convergence rules:

- `gpt-5.6-sol` is reviewer only and remains read-only.
- Verify every finding against source or a reproducing test.
- Fix only confirmed correctness, security, data-loss, compatibility, or release blockers.
- A confirmed blocker gets a fresh bounded Luna fix worktree and focused RED test.
- Rerun the affected suite, `verify:static`, and Sol review.
- Maximum two blocker-fix cycles.
- Stop and escalate if the second cycle does not return `OK TO PUBLISH`.
- No style churn, unrelated cleanup, push, deploy, signing, or secret handling.
- Before sending unpublished code to any external service, parent confirms the already-requested review authorization.

## Stop conditions

Stop immediately if:

- The baseline or integration worktree contains unexplained changes.
- The upstream `.at()` fix is not reachable or the consumer pin/lock/install disagree.
- A fresh renderer still contains `.at(` or another unsupported Chrome 74 API.
- Windows/unknown platforms reach native templates, AEP native parsing, leases, or native host mutation.
- An invalid fulfilled host result is classified as deterministic after invocation.
- Unknown completion causes cleanup or retry.
- Native target identity, one-host-call, one-Undo, restoration, or cleanup evidence drifts.
- Settings can mutate palette artifacts.
- A rejected runner argument can touch the filesystem.
- Cleanup can erase or hide a primary/finalization failure.
- Whole-file line-ending churn appears.
- Static gates fail.
- AE25.6 formal Track B has no current two-pass result.
- AE26.3 or AEFT22 fails without an approved claim reduction.
- Package provenance does not bind exact bytes to the clean release commit.
- Publisher/signing/license/redistribution decisions remain unresolved.
- Final Sol review does not converge within two fix cycles.

## First execution boundary

After the parent saves this plan, it may create three isolated Wave 1 worktrees and start S1, S2, and S3 with `gpt-5.6-luna` high-effort workers.

That authorization covers local worker edits, tests, and local commits only. It does not authorize pushes, dependency publication, consumer repinning to an unreachable commit, packaging, signing, CDP, live AE, evidence mutation, or deployment.

## Requirement markers

- [x] **TESTING-AUDIT:** every testing BLOCKER/HIGH is dispositioned and mapped to a slice or gate.
- [x] **ARCHITECTURE-AUDIT:** every architecture BLOCKER/HIGH is dispositioned and mapped.
- [x] **EVIDENCE-BOUNDARY:** bounded AE25 selection evidence is preserved separately from seven failed Track B reports.
- [x] **LUNA-HIGH:** six bounded implementation slices specify high-effort Luna worktrees, RED tests, files, commands, proof, commits, and reviews.
- [x] **PARALLELISM:** no more than three worktrees per wave; same-wave file ownership does not overlap.
- [x] **LIVE-OWNERSHIP:** AE/CDP/Windows/package mutation remains parent-owned.
- [x] **POLICY-OWNERSHIP:** identity, signing, licensing, and redistribution remain human decisions; no secrets are assigned.
- [x] **SOL-XHIGH-FINAL:** final blockers-only Codex review uses `gpt-5.6-sol` xhigh with at most two fix cycles.
