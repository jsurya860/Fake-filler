## Plan: Form Filler Analysis & Improvements

TL;DR - Analyze `src/content/form-filler.ts`, identify correctness, performance, security, and maintainability issues, then implement prioritized fixes and refactors (small→large). Recommended first fixes: shadowed `detectedErrorTypes`, filled counter de-dup, avoid sending `outerHTML` to background, consolidate `sendMessageSafe`.

**Steps**
1. Fix correctness bugs (P1, P2, P3):
   - Remove shadowed `detectedErrorTypes` and ensure learning payloads are populated.
   - Replace `filled` counter with `filledIds: Set<string>` to avoid double-counting.
   - Replace `outerHTML` with `textContent`/id/class in recovery payloads.
2. Consolidate messaging utilities (P4): extract robust `sendMessageSafe` into `src/shared/messaging.ts` and import from `form-filler.ts` and `index.ts`.
3. Small cleanup & perf (P5, P7, P10, P11, P12, P13):
   - Remove dead pre-loop in `fillForm`.
   - Compute `isTelField` once per `fillField` and pass through.
   - Cap exponential backoff at ~1000ms.
   - Scope combobox option queries to widget root before document-wide queries.
   - Tighten types for `fillSelect`.
   - Restrict console monkey-patch to extension logs only.
4. Refactor for maintainability & testing (P6, P8):
   - Extract `fillTextInput` sub-functions: combobox resolution, native setter, formatting/normalization.
   - Extract recovery heuristics into `src/shared/field-fixer.ts` and reuse from background and content.
5. Tests & verification (P9):
   - Add unit tests for `isErrorElementActive`, `findNearestField`, `field-fixer` heuristics, and the `detectedErrorTypes` learning path.
   - Run integration tests: `all-inputs.integration.test.ts`, `comprehensive-recovery.test.ts`.
6. Optional big improvements (P14):
   - Add `AbortSignal`-based cancellation to `fillFormWithRecovery` and propagate through callers.

**Relevant files**
- [src/content/form-filler.ts](src/content/form-filler.ts) — primary edits: `fillFormWithRecovery`, `fillForm`, `fillField`, `fillTextInput`, `fillSelect`, helpers
- [src/background/error-recovery.ts](src/background/error-recovery.ts) — deduplicate heuristics
- [src/content/index.ts](src/content/index.ts) — console monkey-patch, hotkey integration, call-sites for fill behaviour
- [src/shared/*] (new) — `messaging.ts`, `field-fixer.ts`
- tests/unit/ and tests/integration/ — new/updated tests

**Verification**
1. Unit tests: for each fix, write targeted unit tests to assert behavior (e.g., `detectedErrorTypes` is populated and `MARK_RECOVERY_SUCCESS` payload contains actual type).
2. Run integration tests: `npm test` or `yarn test` for `all-inputs.integration.test.ts`, `comprehensive-recovery.test.ts`, `hotkey.integration.test.ts`.
3. Manual smoke: load extension in a browser on pages with comboboxes, selects, and error messages; verify recovery flow and that no sensitive HTML is sent.

**Decisions / Assumptions**
- Preserve backwards compatibility of public `fillFormWithRecovery` arguments unless user requests API change (P14).
- Prioritize correctness/security fixes (P1-P4) before large refactors (P6/P8).

**Further considerations**
1. Option: Replace random fallback selection (`Math.random()`) with `crypto.getRandomValues` for consistency.
2. Option: Add feature flag for aggressive telemetry/console capture to opt-in during debugging only.
3. Need to coordinate test updates if refactoring splits `fillTextInput` across new modules.
