# Edytor Repository Guide

This file is for coding agents and maintainers who need to work on the repo without rediscovering its structure every time.

The short version: this project is not a generic Svelte component library with a thin editor wrapper. It is a small editing engine with a Svelte rendering layer on top of a Yjs-backed document model. If you change behavior in the wrong layer, you will create bugs that look random from the DOM and selection side.

## Project Identity

- Name: `edytor`
- Current package version: `0.0.11`
- Stack: Svelte 5, SvelteKit, TypeScript, **vendored Yjs v14** (`@y/y@14.0.0-rc.26` under `src/lib/crdt/vendor/yjs/` — the `yjs` npm package is a devDependency only), Vitest, Playwright
- Goal from the README: a Svelte-native rich text editor with Slate-like flexibility and Yjs collaboration
- **Worker-safe CRDT boundary (maintainer constraint).** The CRDT engine and sync layer also run server-side in a Cloudflare Durable Object that coordinates clients over WebSockets (a central DO, not P2P). `src/lib/crdt/**` (vendor included), `src/lib/utils/json.ts`, `src/lib/utils.ts` and `src/lib/constants.ts` must stay importable and runnable without Svelte and without browser globals. Feature-detect browser APIs (IndexedDB, `navigator.locks`, `BroadcastChannel`, page events). Never import `svelte`, `$app/*`, `*.svelte(.ts|.js)` or the view layers (`components`, `selection`, `surface`, `session`, `events`, `block`, `text`, `plugins`, `hotkeys`, `clipboard`, `collaboration`, `edytor*.ts`). This is enforced by three checks: `pnpm lint` (`WORKER_SAFE` + `edytor/worker-safe-imports` in `eslint.config.js`), `pnpm check:worker` (`scripts/check-worker-bundle.mjs` bundles `src/lib/crdt/index.ts` for a Worker target) and `src/tests/crdt/arch-v2/do-coordinator.test.ts` (a reference DO coordinator runs with the browser globals removed and no timers, importing only `edytor/crdt` + `edytor/crdt/edytor`: the frame contract, wire read helpers and the instance-free awareness codec `readAwarenessEntries`/`writeAwarenessEntries` are exported for it). The README section "Server coordinator (Cloudflare Durable Object)" has the contract.
- Status from the README: work in progress, not production ready

> **Status update (post-CRDT-v14, see `docs/crdt-v14-execution-ledger.md`):**
> the editor runtime now runs on the vendored v14 engine via `bindCrdt(Y)` +
> the `EdytorDoc` facade (`src/lib/crdt/`). The "not green" claims scattered
> through this file are **stale** — unit, DOM, CRDT, and chromium lanes are
> green and `pnpm check`/`pnpm lint` are clean. Collaboration is real:
> providers, awareness, sync tests, and migration docs exist
> (`docs/crdt-v14-{providers,migration,browser-proof}.md`). Where this file
> and the v14 docs disagree, the v14 docs win.

The repo already has several real ideas in place:

- Yjs is the live source of truth for the editable editor.
- The editor model is block/content/children based rather than DOM-first.
- Rendering is driven by Svelte snippets registered through plugins.
- Structural editing happens through explicit operations on `Block` and `Text`.
- There is a custom JSX-based test DSL for authoring document fixtures.

The repo also still has visible unfinished surfaces:

- `<Edytor>` enables block handles by default (`blockHandles={false}` opts out; deprecated `blockDnd={false}` still works). `blockHandles={{ draggable: false, onActivate }}` keeps keyboard/menu handles without pointer dragging. The plugin uses Atlassian Pragmatic Drag and Drop's element adapter; the public `edytor.canMoveBlocks`/`edytor.moveBlocks` commands own relative moves for DND, keyboard actions, and consumer menus.
- Drop placement belongs to `BlockHandleController`: it adapts before/inside/after zones to valid moves, keeps a valid placement across short gaps with PDD stickiness, and draws a separate fixed indicator so rounded block styles cannot bend the insertion line. Between siblings, derive the indicator from the shared insertion slot and center it between both block bounds; hovering after one block or before the next must draw the same line. Keep the shown placement and committed move in sync.
- `blockHandlesPlugin` aligns each handle to its block's first rendered text row, or to the header row for island blocks. Shared resize and structural observers update offsets after layout changes, block moves, and readonly transitions; keep the handle beside visible content rather than using the block's outer top edge. The demo block menu positions against the live handle and follows scroll and resize.
- A block-handle click leaves an atomic block selection. The demo menu clears it on open and returns to a text caret after actions so the selected-row background does not linger. Set the collapsed model caret first (`setCollapsedStateAtTextOffset` clears an atomic selection), then write the DOM caret (`setAtTextOffset`) and focus the editor. A DOM range alone cannot replace an atomic selection.
- Rich-text list-item, callout, and todo snippets render their own content and nested children in separate direct `div` elements. Demo CSS keeps both in the text column of a grid so a nested block starts on a new row; a flex row would place it inline with the parent text.
- HTML import was retired (arch-v2 D8, D-24 G-a): external HTML paste and drop fall back to `text/plain`; a consumer imports HTML through its own `onPaste`.
- The root demo route is a document-style playground with working selection, slash, and block menus. Test routes remain separate fixtures, not public API examples.

## Core Mental Model

If you keep only five things in your head, keep these:

1. The editable editor is Yjs-first.
2. `Block`, `Text`, and `InlineBlock` are live wrappers around Yjs data, not plain DTOs.
3. The public editing behavior mostly lives in operation utilities, not in Svelte components.
4. The Svelte components are a rendering tree over the model, not the source of editing truth.
5. Selection and browser input are translated into model operations by a central event pipeline.

That means:

- If a structural edit is wrong, inspect `src/lib/block/block.utils.ts` first.
- If a text edit is wrong, inspect `src/lib/text/text.utils.ts` first.
- If typing or deletion feels wrong in the browser, inspect `src/lib/events/onBeforeInput.ts` and selection derivation.
- If rendering is wrong but the model is correct, inspect snippets/components.

## Document Model

The canonical JSON types are in [src/lib/utils/json.ts](/Users/arnaud/code/edytor/src/lib/utils/json.ts).

Important shapes:

- `JSONDoc`: `{ children: JSONBlock[] }`
- `JSONBlock`: `{ type, id?, data?, content?, children? }`
- `JSONText`: `{ text, marks? }`
- `JSONInlineBlock`: `{ type, id?, data? }`

The model is intentionally split into:

- `children`: nested block structure
- `content`: inline content for the block itself

This is not DOM mirroring. A block owns:

- inline content in `content`
- nested blocks in `children`

### Structural Invariants

The most important invariant lives in `groupContent()` and `normalizeContent()` inside [src/lib/block/block.utils.ts](/Users/arnaud/code/edytor/src/lib/block/block.utils.ts):

- block content must start with a `Text`
- block content must end with a `Text`
- there should not be two consecutive `Text` nodes
- there should not be two consecutive inline blocks
- empty text nodes are injected as separators when needed

If you break those invariants, selection math and rendering become fragile fast.

### Special Block Modes

Block definitions can mark a block as:

- `void`: structurally isolated and not editable by the normal core flow
- `island`: editable but structurally isolated from surrounding blocks

Those semantics are central to merge, unnest, delete, and navigation behavior. Do not treat them as cosmetic flags.

## Runtime Architecture

### 1. `Edytor` Owns Runtime State

The runtime class lives in [src/lib/edytor.svelte.ts](/Users/arnaud/code/edytor/src/lib/edytor.svelte.ts).

It owns:

- the `Y.Doc`
- the root `Y.Map`
- plugin registries for marks, blocks, and inline blocks
- selection state via `EdytorSelection`
- hotkeys via `HotKeys`
- undo/redo via `Y.UndoManager`
- `id -> Block/Text/InlineBlock` maps
- `node -> Text/InlineBlock` maps
- sync/bootstrap and `onChange`

The root model is stored at `doc.getMap('content')`.

### 2. Live Wrappers Mirror Yjs

The three most important classes are:

- [src/lib/block/block.svelte.ts](/Users/arnaud/code/edytor/src/lib/block/block.svelte.ts)
- [src/lib/text/text.svelte.ts](/Users/arnaud/code/edytor/src/lib/text/text.svelte.ts)
- [src/lib/block/inlineBlock.svelte.ts](/Users/arnaud/code/edytor/src/lib/block/inlineBlock.svelte.ts)

Each wrapper can be built from:

- JSON when initializing fresh content
- existing Yjs nodes when hydrating synced state

Each wrapper also exposes a computed `value` that reserializes current state back to JSON.

### 3. Operations Are Bound, Not Hardcoded Inline

Behavior is intentionally split into utilities and then bound onto instances.

Block operations are in [src/lib/block/block.utils.ts](/Users/arnaud/code/edytor/src/lib/block/block.utils.ts).

Text operations are in [src/lib/text/text.utils.ts](/Users/arnaud/code/edytor/src/lib/text/text.utils.ts).

Both files use a `batch()` wrapper that dispatches each call through the view's
command dispatcher (`edytor.dispatcher`, [src/lib/session/commands.ts](/Users/arnaud/code/edytor/src/lib/session/commands.ts)):

- admission (readonly, `document.writable`) refuses before any write
- `onBeforeOperation` runs before any write, on the command and on each step of
  its prepared document plan (`prepare*` functions) under the documented names
- the operation runs in one transaction; nested operations are its steps (no
  hooks) and normalization requests run once at its end
- `onAfterOperation` runs once, after the transaction

`prevent()` is caught only in the dispatcher (`scope`/`intercept`/`run`); user
commands (`dispatcher.run(kind, …)`) apply the undo policy table (`cut`). Never
call `undoManager.stopCapturing()` or catch `PreventionError` elsewhere.

History (`session/history.ts`) is the named exception: `edytor.historyUndo()`/
`historyRedo()` run the bare `um.undo()`/`redo()` — never inside a transaction,
and no tracked write (normalization included) after them, which would empty
the redo stack. Each stack item's `meta` holds per-view `{before, after}`
selection values; the issuing view restores its value through `select()`. Do
not queue selection snapshots before a command's write.

This is the real editing command layer.

Examples:

- `splitBlock`
- `mergeBlockBackward`
- `nestBlock`
- `removeInlineBlock`
- `insertText`
- `deleteText`
- `markText`

If you implement logic directly in a component instead of through these operations, you are probably putting behavior in the wrong place.

### 4. Rendering Is Recursive and Plugin-Driven

Rendering starts in [src/lib/components/Edytor.svelte](/Users/arnaud/code/edytor/src/lib/components/Edytor.svelte).

The rendering stack is:

- `Edytor.svelte`
- `Block.svelte`
- `Content.svelte`
- `Text.svelte`
- `Mark.svelte`
- `InlineBlock.svelte`

Important detail:

- `Block.svelte` does not know semantic block types.
- It resolves the snippet from the current block definition.
- Marks are recursively nested by `Mark.svelte` using delta mark arrays.

This means the rendering layer is generic. Semantics come from plugin definitions.

### 5. Selection and Input Form the Editing Bridge

Selection logic lives in:

- [src/lib/selection/selection.svelte.ts](/Users/arnaud/code/edytor/src/lib/selection/selection.svelte.ts)
- [src/lib/selection/selection.utils.ts](/Users/arnaud/code/edytor/src/lib/selection/selection.utils.ts)

Input/event handling lives in:

- [src/lib/events/onBeforeInput.ts](/Users/arnaud/code/edytor/src/lib/events/onBeforeInput.ts)
- [src/lib/events/onKeyDown.ts](/Users/arnaud/code/edytor/src/lib/events/onKeyDown.ts)
- [src/lib/hotkeys.ts](/Users/arnaud/code/edytor/src/lib/hotkeys.ts)

The intended flow is:

1. Browser selection changes.
2. `EdytorSelection` maps DOM nodes back to model objects.
3. `beforeinput` is intercepted.
4. The editor decides whether to let the browser type or to prevent default.
5. Model operations run.
6. Selection is restored or updated.

This is the most fragile part of the repo and also the least tested part.

**Selection contracts that must not regress** (normative spec:
[docs/editor-delete-contract.md](/Users/arnaud/code/edytor/docs/editor-delete-contract.md),
"Anchor contract" / "Selection ownership and lifecycle" / "Responsibility
map" sections):

- A caret anchor is `{b, a}`: `b` the home block of the backing text,
  `a.i` the bound item (causal identity), `a.a`'s sign the insert
  affinity. Text ownership is streams delimited by boundary items (R2): a
  left caret at a split-born block's start binds that block's boundary
  item, so the containing stream and the side are two facts in two fields
  (no owner facet since arch-v2 D12). Never let a caret migrate into a
  surviving neighbor block because that neighbor received text at the
  shared gap.
- Logical recovery destination and DOM readiness are separate: a live
  destination with no mounted node stays the selection value and is
  displayed by the projector's pass after the flush that mounts it (a
  value that no longer projects runs the seam repair; a text mount or the
  observer's records re-run a waiting pass). Do not "fix" this by
  treating unmounted text as unrecoverable or by weakening
  `firstEditableText`'s mounted-node requirement (container phantom slots
  must stay skipped).
- `src/lib/surface/projector.svelte.ts` is the only DOM-selection writer:
  after every Svelte flush it writes the CURRENT value, so no older
  request can overwrite a newer gesture. There is no deferred selection
  write — commands and input attempts decide the value and `select()` it
  in their own turn (`edytor.attempts.caret` only records the drift-repair
  caret); do not bring back tick/timeout re-assert loops. While a
  requested display has not landed, a `selectionchange` with no intent
  gesture since the request (`Edytor.intentSerial`, the one gesture
  serial; `input` events do not bump it) is not adopted.

## Plugin System

Plugin typing lives in [src/lib/plugins.ts](/Users/arnaud/code/edytor/src/lib/plugins.ts).

A plugin can contribute:

- block definitions
- mark definitions
- inline block definitions
- hotkeys
- lifecycle hooks
- operation interception
- normalization hooks
- default block resolution

Bundled plugins currently include:

- [src/lib/plugins/richtext/RichTextPlugin.svelte](/Users/arnaud/code/edytor/src/lib/plugins/richtext/RichTextPlugin.svelte)
- [src/lib/plugins/mention/MentionPlugin.svelte](/Users/arnaud/code/edytor/src/lib/plugins/mention/MentionPlugin.svelte)
- [src/lib/plugins/code/CodePlugin.svelte](/Users/arnaud/code/edytor/src/lib/plugins/code/CodePlugin.svelte)
- [src/lib/plugins/image/ImagePlugin.svelte](/Users/arnaud/code/edytor/src/lib/plugins/image/ImagePlugin.svelte)
- [src/lib/plugins/arrowMove/arrowMove.ts](/Users/arnaud/code/edytor/src/lib/plugins/arrowMove/arrowMove.ts)

Plugin order matters. Prevention is first-win. README says this, and the runtime agrees.

## Readonly Mode

Readonly rendering IS the editable editor with `contenteditable=false`:
the `readonly` prop flows to `edytor.readonly`, the same block tree
renders, and the event pipeline (`onBeforeInput`, hotkeys, the DOM
mutation observer's flush) gates edits while `readonly` is set. There is
no separate readonly component — `ReadonlyEditor.svelte` was removed
(it was imported by `Edytor.svelte` but never rendered).

The proxy-backed readonly wrappers in
[src/lib/components/readonlyElements.svelte.ts](/Users/arnaud/code/edytor/src/lib/components/readonlyElements.svelte.ts)
still exist, but they serve a different purpose: `Block.svelte`'s
`suggestions` getter wraps suggestion content
(`createReadonlyText`/`createReadonlyInlineBlock`) so suggested text and
inline atoms render through the normal `<Text>`/`<InlineBlock>`
components without being editable model nodes.

This area has no meaningful test coverage and the proxies still warn on
missing properties in DEV — that warning is intentional when a readonly
wrapper meets a live-only API.

## Collaboration and Persistence

The README markets collaboration as built-in, but the repo state is more precise than that.

What exists (post-v14 — this section is updated):

- v14-backed core runtime on the vendored engine (`src/lib/crdt/`)
- `IndexeddbPersistence` + `WebsocketProvider` + awareness + sync/auth
  protocols under `src/lib/crdt/{providers,protocols}/` — bound to the
  engine via `bindCrdt(Y)`; `localProvider.ts` is deleted
- `createIndexeddbSync`/`createWebsocketSync` sync factories for the
  `<Edytor {sync}>` prop (`src/lib/collaboration/providers.ts`)
- v13→v14 migration (`src/lib/crdt/migration/`, runbook
  `docs/crdt-v14-migration.md`), wire-envelope + storage-generation gates
- Automated sync/migration/persistence tests (`src/tests/crdt/providers/`,
  `src/tests/crdt/migration/`) and a real-browser multi-client proof
  (`docs/crdt-v14-browser-proof.md`)

What still does not exist:

- auth, permissions, or persistence strategy for hosted collaboration
- production telemetry — the green lanes are evidence, not battle history

## File Map You Actually Need

High-value files:

- [README.md](/Users/arnaud/code/edytor/README.md): product intent and public claims
- [package.json](/Users/arnaud/code/edytor/package.json): scripts and dependency surface
- [src/lib/edytor.svelte.ts](/Users/arnaud/code/edytor/src/lib/edytor.svelte.ts): runtime root
- [src/lib/block/block.svelte.ts](/Users/arnaud/code/edytor/src/lib/block/block.svelte.ts): block wrapper
- [src/lib/text/text.svelte.ts](/Users/arnaud/code/edytor/src/lib/text/text.svelte.ts): text wrapper
- [src/lib/block/block.utils.ts](/Users/arnaud/code/edytor/src/lib/block/block.utils.ts): structural operations
- [src/lib/text/text.utils.ts](/Users/arnaud/code/edytor/src/lib/text/text.utils.ts): text operations
- [src/lib/selection/selection.svelte.ts](/Users/arnaud/code/edytor/src/lib/selection/selection.svelte.ts): selection derivation and restoration
- [src/lib/events/onBeforeInput.ts](/Users/arnaud/code/edytor/src/lib/events/onBeforeInput.ts): browser input bridge
- [src/lib/hotkeys.ts](/Users/arnaud/code/edytor/src/lib/hotkeys.ts): keyboard command system
- [src/lib/plugins.ts](/Users/arnaud/code/edytor/src/lib/plugins.ts): plugin contract
- [src/tests/test.utils.ts](/Users/arnaud/code/edytor/src/tests/test.utils.ts): custom editor test harness
- [src/tests/jsx/rendering.ts](/Users/arnaud/code/edytor/src/tests/jsx/rendering.ts): JSX fixture compiler

Files that signal unfinished work:

- [src/lib/utils/serialize.ts](/Users/arnaud/code/edytor/src/lib/utils/serialize.ts): empty file
- [src/routes/+page.svelte](/Users/arnaud/code/edytor/src/routes/+page.svelte): document-style demo and block action menu

## Testing Deep Dive

This repo has a custom testing pattern. It is real and useful, but it is not enough on its own.

### Test Stack

- Test runner: Vitest
- Config: [vite.config.ts](/Users/arnaud/code/edytor/vite.config.ts)
- Test include glob: `src/**/*.{test,spec}.{js,ts,tsx}`
- Playwright config in [playwright.config.ts](/Users/arnaud/code/edytor/playwright.config.ts) runs real specs under `tests/editor-dom/` (`pnpm playwright test --project=chromium`; the collaboration subset also runs on firefox/webkit). See `docs/crdt-v14-browser-proof.md` for what's proven where

### The Custom JSX Fixture System

The test JSX runtime lives in:

- [src/tests/jsx/jsx-runtime.ts](/Users/arnaud/code/edytor/src/tests/jsx/jsx-runtime.ts)
- [src/tests/jsx/jsx-dev-runtime.ts](/Users/arnaud/code/edytor/src/tests/jsx/jsx-dev-runtime.ts)
- [src/tests/jsx/rendering.ts](/Users/arnaud/code/edytor/src/tests/jsx/rendering.ts)
- [src/tests/jsx/types.ts](/Users/arnaud/code/edytor/src/tests/jsx/types.ts)

It converts JSX fixtures like this:

```tsx
<root>
	<paragraph>
		Hello <bold>world</bold>
	</paragraph>
</root>
```

into the internal JSON block tree.

That DSL supports:

- nested blocks
- marks such as `bold`, `italic`, `underline`, `strike`, `code`
- inline block fixtures like `mention`
- attributes copied into `data`
- fragments and mixed children

It also merges adjacent text nodes with identical marks so fixtures stay concise.

### Cursor Simulation

Cursor markers are encoded with `|` characters in text content.

`findCursorPosition()` in [src/tests/test.utils.ts](/Users/arnaud/code/edytor/src/tests/test.utils.ts):

- mutates the parsed JSON to strip `|`
- returns path/offset positions for the first and second marker

This is clever, but note the limitation:

- it reasons over the JSON fixture, not over live DOM selection

### `createTestEdytor()`

`createTestEdytor()` in [src/tests/test.utils.ts](/Users/arnaud/code/edytor/src/tests/test.utils.ts):

- instantiates `Edytor` directly from fixture JSON
- loads `richTextPlugin` and `mentionPlugin`
- manually patches `edytor.selection.state`
- returns a custom `expect()` helper that compares serialized block JSON

This is fast and expressive for model operations.

It does not mount Svelte components.

It does not exercise:

- DOM selectionchange
- actual `beforeinput`
- actual hotkey dispatch through the browser
- plugin attach hooks
- placeholder rendering
- readonly rendering
- browser IME/composition behavior

### Important Limitation in the Current Harness

The current harness always sets `isCollapsed: true` when it patches selection state, even when two cursor markers were found.

That means:

- range selection fixtures can be parsed
- but the resulting editor selection state is not a faithful non-collapsed selection

So the test harness is reliable for direct block operation tests, but not reliable as a substitute for real browser selection behavior.

### Current Test Inventory

As audited in this repo state (stale pre-v14 snapshot — see the status note
above; the current suite is ~1,200 unit tests plus DOM/CRDT/e2e lanes):

- `127` tests across `15` files according to `vitest`
- large concentration in:
  - HTML deserializer: `43`
  - split block scenarios: `22`
  - HTML parser: `18`
  - move block: `12`

This means the suite is broad in fixture variety but uneven in architecture coverage.

### What Is Covered Reasonably Well

- JSX fixture compilation
- cursor marker extraction
- block splitting scenarios
- several block structural operations
- HTML parsing/deserialization edge cases

### What Is Barely Covered or Not Covered

- `text.utils.ts` operations as first-class units
- `onBeforeInput` behavior
- real hotkeys
- selection derivation from DOM
- undo/redo
- readonly mode
- placeholder/suggestion rendering
- code plugin behavior
- image plugin behavior
- HTML paste plugin integration
- collaboration and IndexedDB persistence
- drag and drop
- component rendering invariants
- performance regressions

### Current Test Quality Assessment

The current tests are useful but not sufficient. (Note: this assessment is
pre-v14 — the unit/DOM lanes are green now and collaboration, selection,
history, and provider paths have dedicated coverage; the coverage gaps below
are still directionally right for the _fixture_ harness.)

Reasons:

- the suite is not green
- many critical runtime paths are untested
- there are debug-style tests with `expect(true).toBe(true)`
- there is heavy console noise in tests
- most `.tsx` tests are not type-checked because `tsconfig.json` includes `src/tests/**/*.ts` but not `src/tests/**/*.tsx`
- some tests exercise methods directly with payloads that would have benefited from TypeScript checking

In other words: the custom JSX system is a strong foundation, but the overall testing story is still incomplete.

## Observed Baseline Problems

**Historical snapshot — stale.** This was the observed state during the
pre-v14 repo audit. Measured reality now: `pnpm test -- --run`, `pnpm check`,
and `pnpm test:dom` are all green; Playwright runs real specs under
`tests/editor-dom/`. Kept for history; do not treat as current state.

- `pnpm test -- --run` fails
- `pnpm check` fails
- Playwright is configured but unused

Concrete failures:

- `mergeBlock`
- `removeInlineBlock`
- `setBlock`

All currently fail through the same Yjs API drift/problem area: code calling `toDelta()` on Yjs text objects.

Concrete type-check problems include:

- Yjs API mismatches
- stale or incorrect typings in event observers
- stale demo route API usage
- readonly/mark definition mismatches
- TS config warning from manual `paths`

## Practical Advice for Future Agents

When changing this repo:

- change behavior in the operation layer first
- only patch components when the model is already correct
- use the public README and types for contracts; the root demo also exercises the current editing API
- do not trust the test suite as full coverage
- run both `pnpm test -- --run` and `pnpm check`

When adding tests:

- use the JSX DSL for pure model transformations
- add DOM-aware tests for `selection`, `hotkeys`, and `beforeinput`
- add browser tests for end-to-end editing behavior

When touching Yjs code:

- verify the actual API in the installed version
- do not assume older examples from Yjs blog posts still apply

When touching selection/input:

- think in terms of model invariants, not DOM appearances
- confirm behavior in real browser tests, not only fixture tests

## Commands

Useful commands:

```bash
pnpm test -- --run
pnpm check
pnpm build
pnpm test:integration
pnpm test:dst
pnpm test:dst:solo
pnpm test:dst:collab
pnpm test:dst:extensive
```

Reality check (stale claims removed — post-v14 state):

- `pnpm test:integration` runs real Playwright specs under `tests/editor-dom/`
  (chromium green; firefox/webkit binaries may be absent in this environment)
- `pnpm test:dst` runs the deterministic editor-input corpus in Chromium,
  Firefox, and WebKit. `test:dst:solo`/`test:dst:collab` select the
  single-document and multi-context collaboration lanes (env knobs
  `DST_*` / `COLLAB_DST_*`; `test:dst:extensive` expands both). Failures
  write replayable artifacts under `.artifacts/editor-dst/`; replay one
  with `DST_REPLAY=/absolute/path/to/artifact.json pnpm test:dst`.
- `src/tests/fixtures/dom/command-*.test.tsx` (in `pnpm test:dom`) runs the
  real `runBeforeInputCommand` dispatch headlessly on mounted jsdom
  editors — deletion/recovery contracts are named in
  `docs/editor-delete-contract.md`; expected states are hand-authored,
  never derived from production deletion code.
- `pnpm check`, `pnpm test -- --run`, `pnpm test:dom`, `pnpm test:crdt`,
  `pnpm lint` are all green — see `docs/crdt-v14-execution-ledger.md` for
  the current lane counts
- CRDT lanes: `pnpm test:crdt`, `pnpm test:crdt:extensive`, `pnpm bench:crdt`;
  the packed-consumer check is `tests/packed-consumer/run.sh`

## Bottom Line

This repo already contains the skeleton of a serious editor:

- model wrappers
- Yjs transactions
- plugin-driven rendering
- structural operations
- a custom fixture DSL

But it is still in the phase where architecture is ahead of verification.

Treat it as a promising editor engine with incomplete runtime hardening, not as a finished component library.
