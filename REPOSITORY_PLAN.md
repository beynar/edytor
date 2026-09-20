# Edytor Improvement Plan

This document is a practical plan to take the repo from "interesting work in progress" to "coherent, testable, publishable editor core".

It is intentionally opinionated. The repo does not need more surface area right now. It needs a green baseline, a trustworthy test pyramid, and a tighter story around correctness, performance, and public scope.

## Current Snapshot

Observed during this audit:

- package version: `0.0.11`
- README still marks the project as work in progress
- `pnpm test -- --run`: failing
- `pnpm check`: failing
- Playwright config exists, but there are no browser specs
- the core engine is already non-trivial:
  - `block.utils.ts`: `721` lines
  - `selection.svelte.ts`: `556` lines
  - `parser.ts`: `531` lines
  - `deserialize.ts`: `416` lines
  - `onBeforeInput.ts`: `398` lines
  - `hotkeys.ts`: `382` lines
  - `localProvider.ts`: `375` lines

That is enough complexity that "we will test it later" is no longer a believable strategy.

## Test Audit

The repo has a real testing idea, but not a complete testing system.

### What is good today

- The custom JSX DSL is excellent for authoring rich document fixtures.
- Model-level operation tests are readable.
- HTML parser/deserializer coverage is broad.
- Tests run fast.

### What is not good enough

- The suite is not green.
- The type-check is not green.
- Most `.tsx` tests are not type-checked because `tsconfig.json` does not include `src/tests/**/*.tsx`.
- The current harness manually mutates selection state and always marks it collapsed, so it cannot validate real range-selection behavior.
- There are debug tests that assert `expect(true).toBe(true)`.
- There is no browser-level validation of typing, selection, hotkeys, paste, IME, undo, or readonly rendering.
- Collaboration and persistence are untested.

### Direct coverage gaps

Block operations with no meaningful direct test coverage yet:

- `addChildBlocks`
- `insertBlockAfter`
- `insertBlockBefore`
- `mergeBlockForward`
- `pushContentIntoBlock`
- `normalizeContent`
- `normalizeChildren`
- `suggestText`
- `acceptSuggestedText`
- `deleteContentAtRange`
- `deleteContentWithinSelection`

Text operations with effectively no direct production-level test coverage:

- `insertText`
- `deleteText`
- `splitText`
- `setText`
- `markText`
- `removeMarksFromText`

Critical runtime systems with no convincing tests:

- `onBeforeInput`
- DOM-to-model selection mapping
- hotkeys
- undo/redo
- readonly mode
- plugin attach hooks
- code plugin
- image plugin
- HTML paste integration
- IndexedDB persistence
- collaborative sync and awareness
- DnD

## Recommended Direction

Do not keep extending features on top of the current baseline.

The right order is:

1. make the core green
2. rebuild the test pyramid
3. validate browser behavior
4. harden persistence and collaboration
5. measure performance and bundle/storage cost
6. only then expand the public API and feature list

## Phase 0: Establish a Green Baseline

Goal: no failing unit tests, no failing type-check, no fake-green debug tests.

### Tasks

- Fix the Yjs API drift around `toDelta()` usage in block merge/normalize logic.
- Fix Yjs typing mismatches in observers and event generics.
- Fix stale demo route API calls so the app type-checks.
- Fix readonly/mark type mismatches.
- Replace manual `paths` usage with proper SvelteKit alias configuration or align the config so `svelte-check` stops warning.
- Remove or rewrite debug-only tests that only assert `true`.
- Remove leftover `console.log` and `console.dir` noise from tests and core code unless it is deliberately guarded.

### Deliverable

- `pnpm test -- --run` passes
- `pnpm check` passes

### Acceptance Criteria

- no red tests
- no red type-check
- no noisy stdout during a normal unit run

## Phase 1: Rewrite the Testing Strategy

Goal: move from "fixture-heavy unit tests" to a real test pyramid.

### Layer A: Pure Model Tests

Keep the custom JSX DSL, but narrow its role.

Use it for:

- block/tree transformations
- JSON serialization expectations
- inline-block/text grouping invariants
- normalization rules

Rewrite the helper so it can represent:

- collapsed selections
- text ranges in a single text node
- text ranges across multiple text nodes
- block-spanning selections

The current helper is too optimistic about selection state.

### Layer B: Runtime Unit Tests Without DOM Mounting

Add direct tests around:

- `text.utils.ts`
- `block.utils.ts`
- `diffText.ts`
- `deltas.ts`
- `localProvider.ts` storage logic

This layer should test production functions directly instead of recreating their logic in test files.

Example target:

- replace the custom helper copy in `index.test.ts` with tests against the real mark-range implementation

### Layer C: DOM-Backed Component/Selection Tests

Add Vitest + DOM environment tests that mount the editor or key pieces of it.

Use these to validate:

- `selectionchange` mapping
- placeholder behavior
- suggestion overlays
- mark rendering nesting
- readonly rendering
- plugin attach hooks

This is the missing bridge between the data model and the Svelte rendering tree.

### Layer D: Browser E2E Tests

Use Playwright for actual browser editing scenarios.

First wave:

- type into a paragraph
- split blocks with Enter
- merge blocks with Backspace/Delete
- toggle marks with hotkeys
- paste plain text
- select all inside code blocks
- readonly rendering

Second wave:

- IME/composition
- multi-block selection deletion
- inline block insertion and deletion
- persistence reload

### Layer E: Regression and Property Tests

Add invariant-driven tests for tree operations.

Useful property/invariant ideas:

- content always starts and ends with `Text`
- no consecutive inline blocks without an intervening text node
- every block has stable serializable output
- move/nest/unnest never create cycles
- remove operations never orphan children incorrectly

### Test Infrastructure Tasks

- Include `.tsx` tests in `tsconfig.json` so they are type-checked.
- Introduce coverage reporting and thresholds.
- Split test utilities into:
  - fixture rendering
  - selection building
  - editor construction
  - serialization comparison
- Remove debug-only tests.
- Tag tests by layer so CI can run fast smoke checks and slower browser suites separately.

## Phase 2: Harden the Editing Pipeline

Goal: make the real typing/selection experience trustworthy.

### `onBeforeInput` Hardening

Current risk:

- the file is large and command-dense
- it mixes browser-default behavior, custom diffing, and structural editing
- it contains debug logging and timing-sensitive logic

Plan:

- split the handler into smaller input-type-specific commands
- make selection preconditions explicit
- isolate composition behavior from normal text insertion
- define exact behavior for:
  - collapsed selection
  - text-spanning selection
  - block-spanning selection
  - void/island boundaries

### Selection Hardening

Current risk:

- selection derivation depends on DOM traversal details
- browser quirks are handled ad hoc
- there is little verification around reverse selections and multi-range edge cases

Plan:

- test reverse selection explicitly
- test nested block boundaries explicitly
- test inline-block boundaries explicitly
- test placeholder and empty-text behavior explicitly
- document which browser behaviors are intentionally supported

### Hotkey Hardening

Plan:

- write real hotkey tests for default commands
- verify plugin override/prevention order
- verify Mac/Windows modifier normalization
- verify block-selection keyboard flows

## Phase 3: Finish or Cut Incomplete Features

Goal: stop carrying half-built surfaces without a decision.

### HTML Paste

The HTML parser and deserializer are far ahead of the actual HTML plugin integration.

Decision path:

- either finish `htmlPlugin.ts` so pasted HTML inserts real content
- or stop advertising the plugin as usable until insertion behavior exists

### Drag and Drop

`dnd.svelte.ts` exists, but the README still says DND is not ready.

Decision path:

- either integrate it end-to-end with tests
- or keep it internal and explicitly mark it experimental in docs

### Image and Code Plugins

These currently look more like experiments than finished plugins.

Plan:

- define the stable contract for void blocks and island blocks
- add tests for plugin-specific editing behavior
- remove debugging/demo behavior from plugin snippets

### Readonly Mode

Plan:

- test it as a first-class runtime path
- remove proxy noise and debugging output
- document what readonly mode guarantees and what it does not

## Phase 4: Performance Plan

Goal: understand actual cost centers before optimizing blindly.

### Suspected Runtime Hotspots

- full JSON serialization on every doc update for `onChange`
- `selectionchange` DOM walking
- `beforeinput` diffing path for browser-managed text insertion
- repeated `TreeWalker` and `MutationObserver` work on attach
- Prism tokenization on every code-line transform
- recursive normalization that may re-enter often

### Concrete Profiling Work

- instrument typing latency in large documents
- measure selectionchange frequency and handler cost
- measure `onChange` serialization cost by document size
- measure code block tokenization cost by line length and file size
- measure normalization cost on repeated structural edits

### Immediate Likely Wins

- avoid full-value serialization on every tiny update unless a consumer actually asked for it
- cache or scope DOM walkers more tightly
- avoid unnecessary re-creation of wrapper objects during normalization/merges
- replace expensive debug-time mutation observers where possible
- isolate Prism work to changed code lines only

## Phase 5: Cost Structure

The repo currently has technical cost even before it has direct cloud cost.

### Bundle Cost

Potentially expensive dependencies:

- Prism
- Atlaskit pragmatic DnD packages
- Yjs ecosystem packages

Plan:

- measure bundle size with and without optional plugins
- ensure consumers can tree-shake plugins they do not use
- decide whether heavyweight plugins should move to separate entry points

### Runtime Cost

Cost drivers:

- serializing the whole document on each update
- maintaining node maps and observers
- tokenizing code
- persistent storage growth in IndexedDB

Plan:

- define performance budgets for typing latency and large-document operations
- define storage compaction expectations for local persistence

### Collaboration/Infra Cost

The repo depends on Yjs collaboration ideas, which implies future operational cost:

- websocket infrastructure
- awareness traffic
- persistence backend
- auth and room isolation

Plan:

- document at least two supported deployment models:
  - local/offline-only
  - hosted collaborative editing
- estimate provider/storage cost per document/session model
- decide whether the repo should ship provider integrations or only the editor core

### CI Cost

A mature test pyramid will add cost.

Plan:

- split CI into:
  - fast unit/type smoke
  - browser integration
  - optional performance/regression suites

## Phase 6: Public API and Packaging

Goal: make the package shape deliberate.

### Tasks

- audit exports and remove unstable public surface area
- document which plugins are official versus experimental
- create examples that are type-correct and current
- add migration notes whenever APIs change
- publish a supported integration recipe for SvelteKit consumers

### Documentation Tasks

- rewrite the README examples against current APIs
- add a dedicated collaboration guide
- add a plugin authoring guide with concrete end-to-end examples
- add a testing guide that explains the custom JSX DSL and its scope

## Suggested Execution Order

### Milestone 1: Baseline Integrity

- fix failing tests
- fix type-check
- remove debug tests/logs
- include `.tsx` tests in type-checking

### Milestone 2: Test Pyramid

- rewrite the test harness for real range selections
- add direct unit tests for text utilities
- add DOM-backed Vitest tests
- add first Playwright smoke tests

### Milestone 3: Editing Correctness

- refactor `onBeforeInput`
- harden selection logic
- validate hotkey behavior
- test void/island boundaries thoroughly

### Milestone 4: Feature Decisions

- finish or cut HTML paste
- finish or cut DnD
- harden code/image/readonly plugins

### Milestone 5: Performance and Productization

- measure runtime costs
- reduce bundle/runtime/storage overhead
- lock public API and docs

## Definition of "Finished Enough" for This Repo

The repo is not finished when it merely has more features.

It is finished enough when:

- unit tests are green
- type-check is green
- browser smoke tests exist and pass
- collaboration/persistence scope is explicitly defined
- the README examples are current
- incomplete experimental surfaces are either completed or clearly marked
- performance and bundle/storage budgets are measured, not guessed

## Immediate Next Actions

If work starts now, the first concrete sequence should be:

1. Fix the `toDelta()` failures and make the current suite green.
2. Make `pnpm check` green.
3. Type-check `.tsx` tests.
4. Remove fake-green debug tests.
5. Rewrite the test harness so range selections are represented honestly.
6. Add the first DOM-backed tests for `onBeforeInput`, `selectionchange`, and hotkeys.

Everything else becomes easier after that.
