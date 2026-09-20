# Edytor Hardening Phase Plan

This document is the execution map for making Edytor cleaner, less buggy, and
more Notion-like without repeatedly reopening the same work. It complements
`docs/cross-browser-worklog.md`.

- Use this file to decide **what phase comes next**.
- Use `docs/cross-browser-worklog.md` to track **browser-hardening slices and
  evidence**.
- Use `docs/cross-browser-confidence.md` for the current browser confidence
  summary.

The rule is simple: small slice, failing proof when possible, narrow patch,
focused verification, ledger update. No broad autonomous loops without a named
slice.

## Operating Contract

Before starting any implementation slice:

1. Name the phase and slice.
2. State the user-visible or engine-level contract being protected.
3. Search existing tests and `docs/cross-browser-worklog.md` for the same
   behavior.
4. If the behavior is already covered, stop unless a fresh bug reproduces.
5. Add or run the smallest failing verification first when the bug is not
   already proven.
6. Patch the narrowest runtime boundary.
7. Run focused verification before broad verification.
8. Update the relevant Markdown tracker before ending the slice.

Each slice must end in one of these states:

- **Green**: behavior covered, verification commands recorded, no active
  blocker.
- **Blocked**: exact failing command, observed failure, and next decision
  recorded.
- **No-op**: current runtime already satisfies the contract, with the proof
  command recorded.

## Verification Tiers

Use the smallest tier that proves the changed boundary, then climb only as
needed.

### Tier 0: Static Diff Check

Use for docs, test metadata, and small non-runtime edits.

```bash
git diff --check
pnpm exec prettier --check <changed-files>
```

### Tier 1: Focused Unit Or Model Check

Use for pure model operations, parser behavior, clipboard fragment shape, and
fixture harness changes.

```bash
pnpm test -- --run <test-file-or-pattern>
pnpm test:typecheck
```

### Tier 2: Mounted DOM Check

Use for deterministic DOM state, callbacks, attach/detach behavior, selection
state, and jsdom-representable user flows.

```bash
pnpm test:dom -- <test-file-or-pattern>
pnpm test:dom:typecheck
```

### Tier 3: Focused Browser Check

Use for native selection, `contenteditable`, IME, clipboard, browser-owned DOM
drift, and engine differences.

Always run focused browser specs sequentially.

```bash
lsof -ti :4173 | xargs -r kill
pnpm test:integration <spec-file> -g "<case name>" --workers=1
```

### Tier 4: Affected Suite Check

Use after a runtime patch touches input, selection, rendering, history,
clipboard, or operations.

```bash
pnpm test:integration <affected-spec-file> --workers=1
pnpm test -- --run
pnpm test:dom
pnpm check
pnpm lint
```

### Tier 5: Release Gate

Use only after a phase is complete or before publishing.

```bash
pnpm release:check
```

## Phase 0: Baseline And Damage Control

Goal: establish a trustworthy current baseline before doing more feature or
hardening work.

Do this first whenever the repo has visible regressions, a dirty tree from many
agents, or unclear current behavior.

### Work

1. Capture repo state.
   - Run `git status --short`.
   - Identify changed runtime files, test files, docs, and generated files.
   - Do not revert anything unless explicitly asked.
2. Capture app behavior.
   - Open `http://localhost:5173/`.
   - Exercise the demo route manually in the in-app browser.
   - Minimum smoke: clear editor, type text, toggle bold, press Enter, undo,
     redo, delete, type after placeholder.
3. Capture automated baseline.
   - Run only focused checks first if a regression is visible.
   - Avoid full Playwright until the visible regression is understood.
4. Record current status.
   - If browser behavior is involved, update `docs/cross-browser-worklog.md`.
   - If this is broad planning or sequencing, update this file only if the
     phase order changes.

### Verification Loop

```bash
git status --short
pnpm test:integration tests/editor-dom/demo-route.spec.ts --workers=1
pnpm check
pnpm lint
```

If the demo route is visibly broken, stop after the focused browser failure and
fix Phase 1 before broader checks.

### Done When

- The current failure boundary is known.
- There is either a focused failing test or a no-repro note with manual browser
  evidence.
- No next phase starts from an unknown baseline.

## Phase 1: Visible Regression Quarantine

Goal: fix regressions users can see while typing or selecting before continuing
architecture work.

This phase has priority over every roadmap item. A beautiful test matrix is
worthless if the local editor duplicates text, deletes the wrong content, or
loses the caret.

### Work

1. Reproduce in the browser first.
   - Use the route where the user saw the bug.
   - Prefer `http://localhost:5173/` for demo regressions.
2. Map the symptom to a boundary.
   - Model value wrong: inspect `block.utils.ts`, `text.utils.ts`, clipboard, or
     history.
   - Model value right but DOM wrong: inspect rendering keys, attachment
     lifecycle, DOM mutation repair, and selection restoration.
   - Selection wrong before input: inspect `selection.svelte.ts` and DOM mapping.
   - Selection right but command wrong: inspect `onBeforeInput.ts`,
     `onKeyDown.ts`, and `hotkeys.ts`.
3. Add a focused browser regression.
   - Assert visible text, serialized value, and caret/selection when possible.
   - Use Chromium, Firefox, and WebKit unless the bug is engine-specific.
4. Patch only the failing boundary.
   - Do not refactor `onBeforeInput` or clipboard while fixing a rendering
     duplication unless the failing test proves that layer is responsible.
5. Verify manually in the in-app browser after the automated focused spec.

### Verification Loop

```bash
lsof -ti :4173 | xargs -r kill
pnpm test:integration tests/editor-dom/demo-route.spec.ts -g "<regression name>" --workers=1
pnpm test:integration tests/editor-dom/demo-route.spec.ts --workers=1
pnpm check
pnpm lint
```

Manual browser smoke:

1. Clear document.
2. Click first empty paragraph.
3. Type `One`.
4. Select `One`, toggle bold, type another character.
5. Type `Hello  ` and confirm auto-dot/double-space behavior does not delete
   earlier content.
6. Press Enter, type `Two`, undo, redo.
7. Confirm visible DOM text equals serialized value.

### Done When

- The user-visible regression is fixed in real browser behavior.
- A focused browser test prevents recurrence.
- The worklog records the failure, fix, and verification.

## Phase 2: Repository Cleanliness Gate

Goal: keep the repo globally green so editor bugs are not hidden by tooling
noise.

Do not add major features on top of a red hygiene baseline.

### Work

1. Keep runtime typecheck clean.
   - Root `pnpm check` covers shipped app/library surfaces.
   - Test typechecks cover fixture and mounted DOM harnesses separately.
2. Keep formatting and lint clean.
   - Remove debug logs, stale TODOs without issue value, and commented code.
3. Keep package/build clean.
   - Confirm `pnpm build` and `publint` pass.
4. Keep dependencies intentional.
   - Runtime dependencies are actual runtime dependencies.
   - Test and Playwright packages stay in `devDependencies`.

### Verification Loop

```bash
pnpm check
pnpm test:typecheck
pnpm test:dom:typecheck
pnpm lint
pnpm build
```

### Done When

- All commands pass with zero unexpected warnings.
- Any intentionally deferred warning is documented with owner and reason.

## Phase 3: Model Foundation

Goal: make the Yjs-backed model operations boring, deterministic, and invariant
safe.

This phase is model-first. Do not use browser tests as the main proof for pure
operation behavior.

### Work

1. Lock structural invariants.
   - Content starts with `Text`.
   - Content ends with `Text`.
   - No adjacent `Text`.
   - No adjacent `InlineBlock`.
   - Children are never orphaned.
   - Root never becomes childless.
2. Cover transformation contracts.
   - Insert/remove inline block.
   - Split/merge block.
   - Insert before/after.
   - Insert child with negative and overflow index clamping.
   - Move, nest, unnest, remove.
   - Delete same-block, cross-text, cross-block, and nested selections.
3. Cover deep move cases explicitly.
   - Move root sibling into a deeply nested target.
   - Move deeply nested block back to root.
   - Reject self-descendant moves.
4. Keep plugin-aware normalization direct.
   - Void, island, code, mention, and rich text branches need explicit cases.

### Verification Loop

```bash
pnpm test -- --run src/tests/fixtures/model
pnpm test -- --run src/tests/block
pnpm test:typecheck
```

If fixture paths are changed:

```bash
pnpm test -- --run src/tests/jsx src/tests/parser
```

### Done When

- Every exported block and text primitive has happy, boundary, no-op, and
  preservation coverage.
- Invariant/property tests run after operation sequences with fixed seeds.
- No browser behavior is inferred from model fixtures.

## Phase 4: Operation And Input Bridge

Goal: make `onBeforeInput`, `onKeyDown`, hotkeys, history, and selection
aftermath readable and testable without changing product behavior.

This phase is where duplicated insertion/deletion logic should be removed, but
only behind existing and focused tests.

### Status

- 2026-06-19: Green for input-bridge extraction. `onBeforeInput.ts` is now a
  dispatcher with event-time snapshot construction and command handlers split
  into focused event modules. Selection replacement still routes through the
  shared `selection/replaceSelection.ts` helpers for insertion/replacement
  paths. Verification passed for model operations, mounted DOM fixtures, test
  typechecks, DOM typechecks, hotkeys browser spec, `check`, and `lint`.
  `tests/editor-dom/input.spec.ts` passed in a rerun before the final split, but
  after the final split the full suite repeated one Firefox outside-focus
  flake before input dispatch; the exact focused Firefox case passed in
  isolation.

### Work

1. Snapshot event-time state explicitly.
   - `BeforeInputSnapshot` should name that it is a snapshot.
   - Boundary decisions use snapshot state.
   - Post-delete insertion uses live returned targets.
2. Split `onBeforeInput` by command.
   - Ignore/readonly/void guard.
   - Composition handling.
   - Insert text.
   - Delete backward/forward.
   - Insert paragraph.
   - Insert line break.
   - Paste fallback.
3. Centralize selection replacement.
   - Same-text range.
   - Cross-text range.
   - Cross-block range.
   - Selected blocks.
   - Nested boundary selections.
4. Keep history policy explicit.
   - Contiguous typing coalesces.
   - Structural edits are separate.
   - Paste/cut are separate.
   - New edit after undo clears redo.
   - Undo/redo restore content and selection.
5. Keep mark policy explicit.
   - Collapsed pending marks.
   - Mixed-mark range behavior.
   - Range toggle on/off.
   - Remove-mark behavior.

### Verification Loop

Start with the exact command family touched:

```bash
pnpm test -- --run src/tests/fixtures/model/operations
pnpm test:dom -- src/tests/fixtures/dom
pnpm test:typecheck
pnpm test:dom:typecheck
```

If `onBeforeInput.ts`, `onKeyDown.ts`, `hotkeys.ts`, or
`selection.svelte.ts` changes:

```bash
pnpm test:integration tests/editor-dom/input.spec.ts --workers=1
pnpm test:integration tests/editor-dom/hotkeys.spec.ts --workers=1
pnpm check
pnpm lint
```

### Done When

- `onBeforeInput.ts` reads as a dispatcher plus focused command handlers.
- Selection replacement has one implementation.
- History and selection aftermath are locked by tests.
- No behavior changed without a before/after regression test.

## Phase 5: Browser-Owned Editing Semantics

Goal: make real browser behavior reliable across Chromium, Firefox, WebKit,
mobile Chromium, and mobile WebKit.

This phase owns native selection, composition, DOM drift, missing
`beforeinput`, non-cancelable `beforeinput`, and browser-specific quirks.

### Work

1. Continue only from a named worklog slice.
   - Read `Current Status Snapshot`, `Fast Coverage Index`, `Active Slice`, and
     `Next Queue`.
   - Do not reopen clipboard/paste unless a browser regression proves paste is
     the failing boundary.
2. Ask one concrete peer-editor question when needed.
   - Slate, ProseMirror, Lexical, and Svedit are references.
   - Query for the exact browser behavior, not generic editor architecture.
3. Add a focused Playwright regression.
   - Prefer `/test/dom` fixture routes for deterministic scenarios.
   - Use `/` only for demo-route smoke and root-route regressions.
4. Patch one boundary.
   - DOM mapping.
   - Selection restoration.
   - Mutation repair.
   - Input fallback.
   - Rendering key/remount.
5. Document browser differences explicitly.
   - Use local expectation helpers for browser-specific policy.
   - Do not hide browser differences in anonymous conditionals.

### Verification Loop

```bash
lsof -ti :4173 | xargs -r kill
pnpm test:integration <focused-spec> -g "<case name>" --workers=1
pnpm test:integration <focused-spec> --workers=1
pnpm check
pnpm lint
```

If runtime selection/input/rendering changed:

```bash
pnpm test -- --run
pnpm test:dom
pnpm test:integration tests/editor-dom/input.spec.ts --workers=1
pnpm test:integration tests/editor-dom/selection.spec.ts --workers=1
```

Manual browser smoke after visible behavior changes:

1. Type into an empty first paragraph.
2. Type through a mark toggle.
3. Split a paragraph.
4. Undo and redo split.
5. Backspace at block start.
6. Shift+Enter soft break.
7. Click before/after inline mention.
8. Confirm visible DOM and serialized value match.

### Done When

- The worklog has no active slice unless it records a blocker.
- Focused browser spec passes in relevant browsers.
- Manual localhost smoke matches the automated result for visible regressions.

## Phase 6: Clipboard And Paste

Goal: keep clipboard model-first, layered, and predictable without turning every
browser-hardening pass back into clipboard work.

This phase is intentionally separate from generic browser input hardening.

### Work

1. Preserve MIME precedence.
   - `application/x-edytor-fragment`.
   - `data-edytor-fragment` inside `text/html`.
   - External `text/html`.
   - `text/plain`.
2. Preserve ID policy.
   - Copied block and inline-block IDs are never reused on paste.
   - Marks, data, children, and relative subtree order are preserved.
3. Validate internal fragments deeply.
   - Reject malformed blocks, text parts, inline blocks, invalid kind, missing
     block type, and non-array content.
   - Fall back to HTML/plain only when fallback data is valid.
4. Keep HTML mapping honest.
   - Default and user-provided mappings must point to registered block,
     inline-block, or mark definitions.
   - Unknown mappings should fail loudly in tests or be rejected with a clear
     fallback policy.
5. Keep serialization semantic.
   - No DOM cloning.
   - Plain text includes mention labels when available.
   - HTML excludes editor-only placeholders, suggestions, and contenteditable
     artifacts.

### Verification Loop

Model and mounted checks first:

```bash
pnpm test -- --run src/tests/fixtures/model/clipboard
pnpm test:dom -- src/tests/fixtures/dom/clipboard
pnpm test:typecheck
pnpm test:dom:typecheck
```

Browser checks only after semantic coverage:

```bash
lsof -ti :4173 | xargs -r kill
pnpm test:integration tests/editor-dom/clipboard.spec.ts --workers=1
pnpm test:integration tests/editor-dom/paste-html.spec.ts --workers=1
```

### Done When

- Copy, cut, internal paste, HTML paste, plain paste, undo/redo, readonly, and
  malformed payloads have direct tests.
- Paste placement bugs are tracked as clipboard bugs, not mixed into generic
  input refactors.

## Phase 7: Plugin Semantics

Goal: make plugin-conditioned behavior explicit so rich text, mention, code,
image, void, island, and arrow-move features do not rely on accidental core
behavior.

### Work

1. Rich text.
   - Marks, mixed marks, range formatting, collapsed pending marks.
   - Link boundary behavior.
2. Mention.
   - Inline atomic insertion.
   - Selection before/after atom.
   - Deletion and replacement.
   - Clipboard labels.
3. Code.
   - Tab insertion.
   - Suggestions accept/clear.
   - Auto-pairs.
   - Shift+Enter and Enter behavior.
   - Island merge guards.
4. Image and void blocks.
   - Non-editable body.
   - Editable caption.
   - Delete/select boundaries.
5. Arrow move.
   - Block movement hotkeys.
   - Selection aftermath.

### Verification Loop

```bash
pnpm test -- --run src/tests/fixtures/model/plugins
pnpm test:dom -- src/tests/fixtures/dom/plugins
pnpm test:integration tests/editor-dom/plugins.spec.ts --workers=1
pnpm test:integration tests/editor-dom/inline-atomic.spec.ts --workers=1
pnpm check
pnpm lint
```

### Done When

- Every plugin branch that changes editing semantics has at least one direct
  model or DOM test.
- Void/island guards are covered in both operation and browser paths.

## Phase 8: Notion-Like Product Layer

Goal: add block-editor product features only after the foundation is stable.

This phase should be plugin-first and feature-sliced. Do not introduce a broad
product layer while core input or selection gates are red.

### Work Order

1. Rich block set.
   - Headings 1-3.
   - Quote.
   - Bulleted and numbered list items.
   - Todo item.
   - Toggle item.
   - Callout.
   - Divider.
2. Block conversion.
   - Preserve content and children unless target forbids children.
   - Reject invalid conversions for void/island blocks.
3. Command registry.
   - Command metadata.
   - `isEnabled`.
   - `run`.
   - Plugin contribution.
4. Slash menu.
   - Trigger `/`.
   - Query filtering.
   - Keyboard navigation.
   - Escape and mouse selection.
   - Remove trigger text before command execution.
5. Markdown shortcuts.
   - `# `, `## `, `### `.
   - `- `, `* `, `1. `.
   - `[ ] `.
   - `> `.
   - `---`.
   - Triple backtick.
6. Toolbar and link editing.
   - Bubble toolbar.
   - Link apply/edit/remove.
   - Selection restoration.
7. Block handle and DnD.
   - Drag before/after/inside.
   - Multi-block drag.
   - Invalid drop guards.
   - Keyboard fallback.

### Verification Loop

Each product feature follows this loop:

```bash
pnpm test -- --run <feature-model-fixtures>
pnpm test:dom -- <feature-mounted-fixtures>
lsof -ti :4173 | xargs -r kill
pnpm test:integration <feature-browser-spec> --workers=1
pnpm check
pnpm lint
```

For UI-visible features, add a manual localhost smoke:

1. Use the feature through real typing/clicking.
2. Confirm serialized value.
3. Confirm visible DOM.
4. Confirm undo/redo.
5. Confirm readonly behavior when relevant.

### Done When

- The default editor feels block-first, not textarea-first.
- Slash commands, markdown shortcuts, richer blocks, link editing, and block
  handles are tested through real user flows.
- No feature bypasses the core operation/history/selection pipeline.

## Phase 9: Collaboration And Persistence

Goal: make Yjs support a documented product surface instead of only engine
plumbing.

Do this after single-editor behavior is stable.

### Work

1. Define provider setup API.
   - Local IndexedDB provider.
   - Websocket provider example.
   - Awareness passing.
2. Add remote cursor/selection rendering.
3. Test provider lifecycle.
   - Two editors sharing one `Y.Doc`.
   - Updates propagate both directions.
   - Undo is local by default.
   - Awareness cleanup on destroy.
   - Offline reload from IndexedDB provider.
4. Document unsupported collaboration surfaces.
   - Auth.
   - Permissions.
   - Hosted persistence guarantees.

### Verification Loop

```bash
pnpm test -- --run src/tests/fixtures/model/collaboration
pnpm test:dom -- src/tests/fixtures/dom/collaboration
pnpm check
pnpm lint
```

If browser-visible remote cursors are implemented:

```bash
pnpm test:integration tests/editor-dom/collaboration.spec.ts --workers=1
```

### Done When

- Collaboration examples match the actual public API.
- Provider lifecycle has tests.
- README claims do not exceed verified behavior.

## Phase 10: Scale, Performance, And Release Hardening

Goal: make regressions visible before they become product bugs.

### Work

1. Add deterministic large-document checks.
   - 1,000 flat blocks.
   - 5,000 flat blocks.
   - 100-level nested tree.
   - Many marks in one text.
   - Many inline blocks in one block.
2. Add operation sequence/property tests.
   - Insert text.
   - Split.
   - Merge.
   - Delete range.
   - Nest and unnest.
   - Move.
   - Mark toggle.
   - Undo and redo.
3. Add browser matrix expansion.
   - Chromium.
   - WebKit.
   - Firefox when stable enough.
   - Mobile Chromium and mobile WebKit for input/composition lanes.
4. Add release checklist.
   - One command for checks, tests, build, package, and publint.

### Verification Loop

```bash
pnpm release:check
```

For performance checks:

```bash
pnpm test -- --run <performance-or-property-test-file>
```

Performance tests should fail only on severe regressions. Noisy microbenchmarks
belong in reports, not hard gates.

### Done When

- Release confidence is a command, not memory.
- Large documents and operation sequences have deterministic checks.
- Performance regressions are visible and attributable.

## Slice Size Rules

A slice is too large if it changes more than one of these at once:

- Model operation behavior.
- Selection mapping.
- Browser event routing.
- Rendering/remount behavior.
- Clipboard serialization/deserialization.
- Plugin semantics.
- Product UI.

Split immediately when:

- A test failure points to a different boundary than the current patch.
- A fix needs more than one browser-specific policy decision.
- A runtime patch requires changing broad test expectations.
- Manual browser behavior and serialized value disagree.

## Stop Rules

Stop and record the blocker instead of continuing when:

- The same failure remains after three focused attempts.
- The failing command is flaky and cannot distinguish app failure from
  Playwright/server noise.
- A proposed fix changes architecture or public API.
- A browser behavior differs by engine and the correct product policy is not
  obvious.
- The next step would reopen a completed worklog area without a fresh
  browser-backed failure.

## Documentation Rules

Use the correct document for the job:

- `docs/editor-hardening-phase-plan.md`: ordered roadmap and verification loops.
- `docs/cross-browser-worklog.md`: active browser slice, completed browser
  evidence, and do-not-repeat boundaries.
- `docs/cross-browser-confidence.md`: summarized confidence and peer-editor
  patterns.
- README: public claims only after behavior is implemented and verified.

Every completed browser slice must update `docs/cross-browser-worklog.md`. Every
roadmap order change must update this file.

## Immediate Next Move

The next implementation session should not start with clipboard or a broad
refactor. It should start with Phase 0:

1. Confirm the current dirty tree and local app behavior.
2. Run the demo-route focused browser smoke.
3. If the visible editor is stable, pick one named Phase 5 browser slice from
   the worklog.
4. If the visible editor regressed, run Phase 1 and fix that first.
