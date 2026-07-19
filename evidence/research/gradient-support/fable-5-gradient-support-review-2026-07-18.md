# Chroma Relay — Gradient Support: Architecture & Feasibility Review

**Scope:** read-only review of `src/jsx/aeft/aeft.ts`, `src/jsx/aeft/color-apply.ts`, `src/js/main/main.tsx`, `tests/host-contract.test.mjs`, `docs/implementation-plan.md`, and the live evidence file `evidence/research/gradient-support/ae-26.3-readonly-gradient-scan.json` (treated as authoritative for AE 26.3x87). No files were modified, no commands run, no AE mutation. Note: the tooling available in this session had no plan-file write capability, so the report is delivered inline only.

---

## 1. Verdict (summary)

Gradient support splits cleanly into two worlds, and the current code conflates them:

- **Effect gradients (Gradient Ramp `ADBE Ramp`, 4-Color Gradient `ADBE 4ColorGradient`)** expose their colors as ordinary `PropertyValueType.COLOR` child streams. They are fully collectable, applyable, and keyframable with the *existing* collect/apply machinery — but today they are blocked before recursion by the broad `isGradientProperty` name heuristic. This is a bug-shaped opportunity: the smallest slice of gradient support is deleting an over-broad guard, not adding a gradient engine.
- **True stop-based gradients (Shape `ADBE Vector Grad Colors`, Layer Style `gradientFill/gradient`)** are `PropertyValueType.NO_VALUE` and throw on read/write. The live 26.3 scan confirms 20/20 shape and 34/34 layer-style read failures with the explicit host error "Can not get or set a value from this property … PropertyValueType.NO_VALUE" (`ae-26.3-readonly-gradient-scan.json:27,51`). No ExtendScript path exists for true round-trip of their stops. Everything around the color stops (type, start/end point, highlight, scale, rotation, angle, style, reverse, smoothness) *is* scriptable, per the same scan.

**Final: AGREE_WITH_CHANGES.** Readiness **8/10** for the recommended slice (effect-gradient support + honest reporting); **3/10** for any promise of true shape/layer-style gradient round-trip via scripting (effectively blocked; only approximations or native code remain).

---

## 2. Support matrix

| Family | Detect | Collect colors | True round-trip (stops, positions, alpha stops, midpoints) | Type / geometry | Keyframes | Apply |
|---|---|---|---|---|---|---|
| **Shape Gradient Fill/Stroke** — `ADBE Vector Grad Colors` under `ADBE Vector Graphic - G-Fill` / `G-Stroke` | ✅ exact matchName | ❌ direct (NO_VALUE, live-confirmed). ⚠️ approximate only via render/sample | ❌ — no scripting read *or* write of stops; midpoints/alpha stops unreachable | ✅ `ADBE Vector Grad Type` (1=linear, 2=radial), `Grad Start Pt`/`End Pt` (TwoD_SPATIAL), HiLite Length/Angle, Scale, Rotation all read OK in the live scan (`scan:100–178`) | `numKeys` readable (`scan:183`); keyframe *values* unreachable | ❌ |
| **Gradient Ramp** — `ADBE Ramp` (effect matchName confirmed via docsforadobe.dev effect match names) | ✅ | ✅ Start Color / End Color are plain COLOR streams *(child matchNames `ADBE Ramp-0002` / `-0004` — community-documented, **unverified by the live scan**, which found 0 Ramp effects: `scan:56–59`)* | ✅ trivially — the model is exactly 2 colors + start/end points + ramp shape + scatter + blend; there are no midpoints to lose | ✅ | ✅ via `setValue`/`setValueAtTime` | ✅ |
| **4-Color Gradient** — `ADBE 4ColorGradient` (matchName confirmed via docsforadobe.dev) | ✅ | ✅ Color 1–4 are COLOR streams *(child matchNames unverified by the live scan — 0 instances found: `scan:60–63`)* | ✅ — model is 4 point/color pairs + blend + jitter + opacity | ✅ | ✅ | ✅ |
| **Layer Style Gradient Overlay** — `gradientFill/gradient` | ✅ exact matchName | ❌ direct (NO_VALUE, 34/34 live failures). ⚠️ approximate via render/sample | ❌ | ✅ partial: mode2, opacity, smoothness, angle, style, reverse, align, scale, offset all read OK (`scan:206–310`) | unverified (scan shows `numKeys: 0` readable) | ❌ |

Legend: ✅ feasible with ExtendScript today; ❌ blocked by host; ⚠️ approximation only.

---

## 3. The `isGradientProperty` heuristic **does** block scriptable COLOR children — with locale-dependent behavior

The heuristic (duplicated at `src/jsx/aeft/aeft.ts:52-60` and `src/jsx/aeft/color-apply.ts:27-35`) matches `"grad"` in `matchName` **or** `"gradient"` in the localized display `name`, and both traversals return early at the *group* level before recursing (`aeft.ts:102-107`, `color-apply.ts:47-51`). Consequences:

1. **Gradient Ramp is wrongly blocked (English UI).** `"adbe ramp"` contains no `"grad"`, but the display name "Gradient Ramp" contains `"gradient"` → the effect group is counted as one unsupported gradient and its Start/End COLOR children are never visited. In a localized AE (e.g., German "Verlauf"), neither test matches, recursion proceeds, and the colors **are** collected — the panel behaves differently per UI language. That is the worst kind of heuristic: silently locale-dependent.
2. **4-Color Gradient is blocked in all locales** — `"adbe 4colorgradient"` contains `"grad"` — despite Color 1–4 being ordinary writable COLOR streams.
3. **User-named content is blocked.** Any layer, shape group, or effect the user renamed to contain "gradient" (e.g., a group called "gradient card bg") is skipped wholesale at `aeft.ts:103`, including its plain solid fills, because `readColorProperty` is also invoked on whole layers (`aeft.ts:187`).
4. **Count inflation when the group check misses.** If recursion does reach a shape Gradient Fill (localized name), each of the ~8 children whose matchName contains "Grad" (Type, Start Pt, End Pt, HiLite ×2, Scale, Rotation, Colors) is individually counted into `selectedPropertyCount`/`unsupportedGradientCount` (`aeft.ts:114-117`), so the panel's "skipped N unsupported" message (`main.tsx:401-402,451`; apply side `main.tsx:487-495`) over-reports.

The contract test only asserts that `unsupportedGradientCount` exists (`tests/host-contract.test.mjs:11`) and `docs/implementation-plan.md:272` explicitly endorses "stable match/display-name evidence" — so the docs/tests currently lock in the over-broad behavior. Gradients are declared out of scope at `docs/implementation-plan.md:93,96,692`.

---

## 4. Evaluation of alternative acquisition/apply strategies

- **Render + sample approximation** — *viable for collect-only, approximate*. Two routes: (a) temporary expression using `sampleImage()` on a scratch property, reading the post-expression `.value` — works but mutates the project temporarily (must be undo-wrapped, violating the collector's read-only contract enforced at `host-contract.test.mjs:12-13`); (b) render one frame via the render queue and reuse the existing `extractPaletteFromImageFile` pipeline (`main.tsx:392`) — yields palette colors, not stops. Neither recovers exact stop positions, midpoints, or interpolation; dense sampling + knee detection can estimate them (unverified precision). Recommended only as an opt-in "grab colors from this gradient" feature, clearly labeled approximate.
- **Project/AEP parsing** — *read-only research spike only*. The .aep RIFX container does hold stop data and community parsers exist (e.g., the Go `aftereffects-aep-parser`; gradient-chunk coverage **unverified**). Requires a saved file, goes stale against unsaved edits, and write-back to an open project file is categorically unsafe. Never a live path.
- **FFX / animation presets** — `applyPreset()` can *create* gradient fills with pre-baked stops, but generating FFX with arbitrary stops requires a reverse-engineered binary format (unverified, version-fragile), and retargeting a preset onto a specific existing fill is not controllable. Reject for product use.
- **Clipboard / menu automation** — no CEP/ExtendScript access to the property clipboard; `executeCommand` sequences are focus- and selection-fragile and fail silently. Reject.
- **Native C++/AEGP** — the only conceivable route to true shape-gradient stream access, and even the AEGP stream suites do not document gradient stops as an accessible stream type (**unverified**); it would also change distribution to signed per-OS native plugins. Out of scope for this CEP panel.
- **Custom managed-gradient model** — sound *within* the writable families: the panel can own gradient objects and apply them exactly to Ramp/4-Color targets, and optionally offer "apply as a new Gradient Ramp effect" as an honest fallback on layers whose shape gradients can't be written.

---

## 5. Recommended domain model / host API

```ts
type GradientStop = { position: number; color: Rgba };           // midpoint omitted until a writer can honor it
type ManagedGradient = {
  kind: "linear" | "radial";
  stops: GradientStop[];                                          // 2 for ramp, 4-point model for 4-color
  source: "ramp" | "four-color" | "sampled" | "manual";
  fidelity: "exact" | "approximate";                              // sampled ⇒ approximate, always surfaced in UI
};

// Host bridge (mirrors existing result-object style):
collectSelectedGradients(): {
  status: ...; gradients: ManagedGradient[];
  unreadableGradientCount: number;                                // shape + layer-style NO_VALUE leaves, counted once each
  families: { shape: number; layerStyle: number; ramp: number; fourColor: number };
};
applyGradientToSelectedProperties(g: ManagedGradient): ColorApplyResult-like;
```

Solid-color collect/apply keeps its current shape; the only change there is the block-list: replace the name heuristic with an exact leaf blocklist `{"ADBE Vector Grad Colors", "gradientFill/gradient"}` plus a generic guard skipping `NO_VALUE`/`CUSTOM_VALUE` leaves, and drop the group-level early return entirely so recursion reaches COLOR children.

---

## 6. Smallest reversible slice + staged plan

**Slice (Stage 1):** narrow `isGradientProperty` in both files as above. This alone makes Gradient Ramp and 4-Color Gradient colors collect **and** apply with zero new apply logic, fixes locale dependence, un-blocks user-renamed groups, and fixes count inflation. Fully reversible (two small functions), preserved by the existing single balanced undo group (`color-apply.ts:138-157`, asserted at `host-contract.test.mjs:48-57`).

- **Stage 0 — evidence first:** extend the read-only scan script to a fixture comp containing shape gradient fill + stroke, Gradient Overlay style, Gradient Ramp, 4-Color Gradient, and a solid fill inside a group renamed "gradient stuff". Capture Ramp/4-Color child matchNames and value types — this closes the current evidence gap (`gradientRampEffects.count: 0`, `fourColorGradientEffects.count: 0`).
- **Stage 1 — the slice** + contract-test updates (assert exact-matchName blocklist, assert no display-name matching) and live tests: readback before/after apply on Ramp Start/End and 4-Color 1–4; single-Undo revert comparing full property snapshots; re-run the read-only scan to prove the collector still mutates nothing and counts each unreadable gradient exactly once.
- **Stage 2 — honest UX:** per-family unsupported breakdown in status copy (main.tsx already threads skipped counts).
- **Stage 3 (optional, behind a setting):** approximate color grab from shape/layer-style gradients via frame render + existing image-extraction pipeline, labeled "approximate".
- **Stage 4 (research spike, no commitment):** AEP read-only parse for exact stops on saved projects.

---

## 7. Blockers, assumptions, and what not to promise

**Blockers (live-confirmed for 26.3):** `ADBE Vector Grad Colors` and `gradientFill/gradient` are NO_VALUE and throw on read/set; Adobe's scripting docs define NO_VALUE as "stores no data" and never document gradient stop access. **Assumptions to verify in Stage 0:** Ramp/4-Color child streams are COLOR-typed and writable in 26.3 (community-documented, absent from the current scan). **Do not promise:** reading or writing shape/layer-style gradient stops, alpha stops, midpoints, or interpolation; keyframed gradient editing; locale-proof name-based detection; AEP write-back; clipboard/menu automation; exact fidelity for any sampled gradient.

**Final: AGREE_WITH_CHANGES — readiness 8/10** for Stages 0–2 as scoped; the "changes" are: land Stage 0 evidence before the heuristic change, and keep true stop round-trip explicitly out of the committed scope.
