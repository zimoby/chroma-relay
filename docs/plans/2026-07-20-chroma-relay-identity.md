# Chroma Relay identity migration implementation plan

> **For Hermes:** Implement this plan task-by-task with narrow patches and fresh verification. Preserve historical evidence and legacy compatibility identifiers.

**Goal:** Adopt **Chroma Relay** as the public product name without breaking the existing CEP installation identity, persisted user data, automation ownership, or portable palette imports.

**Architecture:** The existing `src/shared/product-contract.json` remains the source of truth. Public identity fields change to Chroma Relay, while explicitly named compatibility fields retain the current `com.zimoby.chroma-relay*`, `Chroma Relay/`, and `chroma-relay` values. Current user-facing code and docs derive from the contract; historical plans, evidence, and handoffs remain unchanged.

**Tech stack:** React 19, TypeScript 5.8, Vite/CEP, Node 22 built-in test runner, npm 10.

---

## Scope and compatibility boundary

Rename now:

- CEP display name and Main panel menu label.
- Main/Settings document titles, visible Settings heading, load diagnostics, and accessibility label.
- AE Undo group labels.
- Unsigned alpha archive filename.
- New portable palette export filename suffix.
- Current README, storage/design/status docs, and plugins-KB current-state routing.

Preserve intentionally:

- CEP bundle/panel IDs: `com.zimoby.chroma-relay*`.
- CEP event names using the same namespace.
- Existing CEP user-data directory: `Chroma Relay/`.
- Portable JSON `format: "chroma-relay"` and v1/v2 import support.
- Internal CSS classes, debug globals/environment variables, test ownership markers, temporary paths, and repository path.
- Historical evidence, completed historical plans, reports, handoffs, and their recorded artifact names.

Deferred policy gate:

- Final publisher/organization namespace, signing identity, public repository rename, and replacement CEP IDs. These require an owner decision and a separate installation/data migration design.

## Task 1: Freeze the identity contract with failing tests

**Files:**

- Modify: `tests/product-contract.test.mjs`
- Modify: `tests/palette-transfer.test.ts`
- Modify: `tests/release-contract.test.mjs`

**Steps:**

1. Require `displayName: "Chroma Relay"`, `slug: "chroma-relay"`, and new `.chroma-relay.json` exports.
2. Require legacy CEP IDs, storage directory, event namespace, and portable format to remain unchanged.
3. Require the packager to derive its archive name from the product contract rather than a stale literal.
4. Run focused tests and preserve the expected RED result.

## Task 2: Implement the contract-backed public rename

**Files:**

- Modify: `src/shared/product-contract.json`
- Modify: `cep.config.ts`
- Modify: `scripts/package-alpha.mjs`
- Modify: `src/js/shared/palette-transfer.ts`
- Modify: `src/js/shared/palette-storage.ts`
- Modify: `src/js/shared/layout-settings.ts`
- Modify: `src/js/main/index.html`
- Modify: `src/js/settings/index.html`
- Modify: `src/js/main/index-react.tsx`
- Modify: `src/js/settings/index-react.tsx`
- Modify: `src/js/main/main.tsx`
- Modify: `src/js/settings/settings.tsx`
- Modify: `src/jsx/aeft/color-apply.ts`
- Modify: `src/jsx/aeft/native-gradient-apply.ts`

**Steps:**

1. Add explicit public and compatibility identity fields to the product contract.
2. Derive display labels, storage directory, transfer format/suffix, and package archive name from those fields.
3. Change only user-visible strings to Chroma Relay.
4. Keep old transfer payloads importable and the existing storage directory authoritative.
5. Run focused product-contract, transfer, host-contract, and release-contract tests.

## Task 3: Update current documentation without rewriting history

**Files:**

- Modify: `README.md`
- Modify: `docs/STORAGE.md`
- Modify: `docs/design-direction.md`
- Modify: `docs/implementation-status.md`
- Modify: `docs/native-gradient-product-semantics.md`
- Modify: `docs/native-gradient-provenance.md`
- Modify: plugins KB `CURRENT_STATE.md`

**Steps:**

1. Rename current product headings and present-tense product references.
2. Document that `Chroma Relay` remains the legacy codename/storage/technical namespace.
3. Leave evidence reports, historical plan bodies, handoffs, and prior artifact records untouched.
4. Search current source/docs for stale user-facing labels and classify every retained occurrence.

## Task 4: Build and verify

**Commands:**

1. `npm run test:domain`
2. `npm run test:host-contract`
3. `npm run test:runner-contract`
4. `npm run test:release-contract`
5. `npm run verify:static` as the standalone final repository verification command.

**Runtime boundary:** A build is authorized by the approved rename. Live AE/CDP mutation, package signing, publication, push, and remote/repository renames remain out of scope. If an already-running panel is reloaded, verify exact surface identity before judging labels.

## Risks and rollback

- Changing CEP IDs would create a second installation and invalidate current runner/storage assumptions; therefore IDs stay unchanged.
- Changing the user-data directory would strand existing palettes/settings; therefore the legacy directory stays authoritative.
- Changing the portable JSON format would break existing exports; therefore only the suggested filename suffix changes.
- Broad replacement would corrupt historical evidence; therefore historical paths are excluded and current files are patched individually.
- Rollback is the inverse of the task-scoped diff; no data migration or external publication occurs in this plan.
