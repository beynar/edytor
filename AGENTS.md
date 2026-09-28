# Edytor Repository Guide

For coding agents and maintainers who need to work on the repo without rediscovering its structure.

Edytor is a small editing engine with a Svelte rendering layer, on a Yjs v14 document. It is not a component library with a thin editor wrapper. Almost every bug that "looks random" from the DOM or selection side comes from changing behavior in the wrong layer, or from giving one fact a second owner. Read "One owner per fact" before changing anything in `session/`, `surface/` or `events/`.

## Project identity

- Name `edytor`, version `0.0.11`, work in progress (see README).
- Stack: Svelte 5, SvelteKit, TypeScript, **vendored Yjs v14** (`@y/y@14.0.0-rc.26`, an owned fork under `src/lib/crdt/vendor/yjs/`, patches listed in `UPSTREAM.md`; the `yjs` npm package is a dev dependency for migration tests only), Vitest, Playwright.
- The architecture below is the result of the arch-v2 plan (`docs/architecture-v2/plan.md`); `docs/architecture-v2/execution-ledger.md` records every checkpoint, the lane results and the measured numbers.

## The top-level model

Five contexts, each with one job and a lifetime:

| Context     | Lives in                                                                  | Lifetime               | Job                                                                                                                                                                          |
| ----------- | ------------------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **doc**     | `src/lib/crdt/` (not `vendor/`, `providers/`, `protocols/`, `migration/`) | the engine doc         | The replicated document and everything derived from it: block registry, placements, streams, one index, prepared operations, anchors, attribution. DOM-free and Svelte-free. |
| **sync**    | `src/lib/crdt/{providers,protocols,migration}/`, `src/lib/collaboration/` | provider / document    | Transport: the generation envelope, the room lifecycle and join rule, IndexedDB + websocket providers, awareness, presence, v13→v14 migration.                               |
| **session** | `src/lib/session/`                                                        | the view               | DOM-free per-view state: the selection value, the command dispatcher, input attempts, the composition session, history, keymap, navigation, moves, handles.                  |
| **surface** | `src/lib/surface/`, `src/lib/components/`, `src/lib/events/`              | one mount              | The only code that touches the host DOM: render cells, the compare-to-truth observer, the selection projector, the IME pin, the overlay, the event adapters.                 |
| **plugins** | `src/lib/plugins.ts`, `src/lib/plugins/`, `src/lib/kinds.ts`              | the editor (immutable) | Kind, mark and atom records, hooks, commands, bindings.                                                                                                                      |

`src/lib/edytor.svelte.ts` (`Edytor`) is the composition root: it builds one of each per view and wires them. It should hold wiring, not rules.

### Worker-safe CRDT boundary (maintainer constraint)

The CRDT engine and the sync layer also run server-side in a Cloudflare Durable Object that coordinates clients over WebSockets (a central coordinator, not P2P). `src/lib/crdt/**` (vendor included), `src/lib/utils/json.ts`, `src/lib/utils.ts` and `src/lib/constants.ts` must stay importable and runnable without Svelte and without browser globals:

- never import `svelte`, `$app/*`, `*.svelte(.ts|.js)` or a view layer (`components`, `selection`, `surface`, `session`, `events`, `block`, `text`, `plugins`, `clipboard`, `collaboration`, `edytor*.ts`) from there;
- feature-detect browser APIs (IndexedDB, `navigator.locks`, `BroadcastChannel`, page events); no module-level timers.

Three checks enforce it: `pnpm lint` (`WORKER_SAFE` + `edytor/worker-safe-imports` in `eslint.config.js`), `pnpm check:worker` (bundles `src/lib/crdt/index.ts` for a Worker target) and `src/tests/crdt/arch-v2/do-coordinator.test.ts` (a reference coordinator with the browser globals removed and timers forbidden). The coordinator's public surface — `bindCrdt(Y)` (`.sync` readers/writers and `applyRemote`, `.admission`, `.doc`), the frame contract, the message types, the lib0 frame helpers and the instance-free awareness codec (`readAwarenessEntries`/`writeAwarenessEntries`) — is section 8 of `src/lib/crdt/index.ts`. Do not remove anything that test imports. README "Server coordinator (Cloudflare Durable Object)" has the contract.

## One owner per fact

Each fact has exactly one writer. When a fix seems to need a second writer, the owner is missing a rule.

| Fact                                                                                      | Owner                                                                                         | Where                                                                                     |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Document content, structure, liveness (delete marks), order                               | document operations: `prepare.<op>(…)` → `apply(plan)`                                        | `crdt/edytor-doc.ts`, `crdt/rangeDelete.ts`, `crdt/flow.ts`                               |
| Derived facts (records, streams, placements, children, order, runs) and the change report | the one per-doc index, folded once per commit (mid-transaction reads fold the pending writes) | `crdt/text/runs.ts`, `crdt/text/model.ts`, `crdt/placement/model.ts`                      |
| Structural capability (`canPlace`, `canMerge`, `defaultChild`, `rendersContent`, roles)   | adopted kind records on the document                                                          | `crdt/document.ts`, facade                                                                |
| The seam of a vanished endpoint                                                           | `seam(doc, dead, displayable)`                                                                | `crdt/anchors.ts`                                                                         |
| Readiness, seeding, provider registry                                                     | `EdytorDocument`                                                                              | `crdt/document.ts`                                                                        |
| Hook order, veto, replacement, undo cuts, normalization, command status                   | the dispatcher                                                                                | `session/commands.ts`                                                                     |
| The selection                                                                             | the selection **value** (`select(value, cause)`)                                              | `selection/selection.svelte.ts` (`EdytorSelection`), pure parts in `session/selection.ts` |
| The DOM selection                                                                         | the projector (only writer)                                                                   | `surface/projector.svelte.ts`                                                             |
| What an input occurrence means and who performs it                                        | the input attempt                                                                             | `session/attempt.ts`                                                                      |
| IME state                                                                                 | the composition session                                                                       | `session/composition.svelte.ts` (+ `surface/pin.svelte.ts`, the only freeze)              |
| What the host DOM should be                                                               | render cells (patched from the change report)                                                 | `surface/cells.ts`, `components/*`                                                        |
| What a DOM change means                                                                   | the compare-to-truth observer (only interpreter of DOM changes, only MutationObserver)        | `surface/observer.svelte.ts`, `surface/attributes.ts`                                     |
| Chrome geometry                                                                           | the overlay (one layer beside the host, one measure pass per frame)                           | `surface/overlay.ts`                                                                      |
| Selection around each undo step                                                           | per-view `{before, after}` in stack-item `meta`                                               | `session/history.ts`                                                                      |
| Presence                                                                                  | the view's own `presenceKey` entry, written by `select()` and cleared by `destroy()`          | `collaboration/awarenessSelection.ts`                                                     |
| Key bindings and precedence                                                               | the keymap (consumer > extensions in list order > built-in rows)                              | `session/keymap.ts`, `session/bindings.ts`                                                |
| Caret stops for navigation keys                                                           | one stream of displayable stops                                                               | `session/navigation.ts`                                                                   |
| Marks of an insertion                                                                     | `marksForInsertion` (one rule for every insertion path)                                       | `session/editing/text.ts`                                                                 |

## Doc

- **Shape.** `JSONDoc = {children: JSONBlock[]}`, `JSONBlock = {type, id?, data?, content?, children?}`, `content` = `JSONText {text, marks?}` and `JSONInlineBlock {type, id?, data?}` (`src/lib/utils/json.ts`). A block owns its inline `content` and its nested `children`; the model is not a DOM mirror.
- **Streams (text ownership).** Each block's text is a stream in a backing text, delimited by boundary items. A split writes one boundary; a merge adds a claim. Split and merge never copy text. `docs/crdt-v14-text-ownership-adr.md` and the plan §2.1 have the details.
- **Operations are two-phase.** Every facade op is `apply(prepare.op(…))`. `prepare` writes nothing and returns a plan of named steps with its effect (or `refused`); `apply` writes it in one transaction and returns `OpResult {status: 'applied' | 'noop' | 'refused', ids}`. Range delete (`prepare.deleteRange`/`replaceRange`/`deleteBlocks`) and paste/drop placement (`prepare.insertFlow`) are single plans whose rules are rows in `docs/editor-delete-contract.md` (`del.range.*`, `flow.*`). A new structural case means a new contract row, not a caller flag.
- **One index, one report.** `facade.onChange(cb)` delivers one `DocChange` per commit that changed the visible document (`added`, `removed`, `moved`, `meta`, `content`, `order`). Nested transactions publish once; a transaction that nets out publishes nothing.
- **Roles.** `void` (structurally isolated, not editable by the core flow) and `island` (editable, sealed from its neighbours) drive merge, unnest, delete and navigation. They are not cosmetic.
- **Anchors** are `DocAnchor = {b, a}` (see the anchor contract below).

## Sync

- Every frame is `varuint GENERATION | varuint messageType | payload`; `GENERATION = PROTOCOL_VERSION * 1000 + SCHEMA_VERSION` (schema generation 4). Anything else is refused before decode; `applyRemote` refuses updates that forge the schema stamp.
- One room lifecycle and join rule (`providers/room.ts`): hello = Step1 + presence; a Step1 is answered with Step2, plus our own Step1 when the asker holds something we lack.
- `createIndexeddbSync(name)` / `createWebsocketSync({serverUrl, roomName, params?, maxBackoffTime?})` are `EdytorSync` factories for `<Edytor {sync}>` or `document.attachSync`; the document keeps one provider per transport target. The websocket provider has no BroadcastChannel leg: stack IndexedDB for cross-tab sync.
- Seeds are deterministic (a hashed writer id), so two replicas seeding the same value converge.
- Presence: `selections[viewKey] = serialize(value) + t`. A view writes only its own key. Remote carets resolve the freshest valid text entry per client.

## Session

- **Selection value** (`SelectionValue`, by `kind`): `none`, `text {anchor, focus, pending?}`, `atom {blockId, atomId, from}`, `blocks {ids}`. Everything a command reads (endpoints as (block, display offset), direction, collapsed, covered blocks, edge flags, marks, content) is `project(value, doc)`, memoized per (value, index version). `selection.state` is a read-only compatibility getter over the projection. Pending marks are `value.pending` (`selection.pending`, `selection.stage(marks)`).
- **`select(value, cause)`** is the one writer. It applies the effects once (selected/focused sets and hooks, suggestions), emits `onSelectionChange` and publishes presence only when the value changed, and asks the projector to display (causes `model`/`history`), or not (`dom`).
- **Dispatcher** (`edytor.dispatcher`): admission (readonly, `document.writable`) → prepare → `onBeforeOperation` on the command and on each planned step under its documented name, all before any write → one transaction → normalization requests drained once inside it → `last.status` (`refused | noop | applied | failed`) → `onAfterOperation` once. A veto refuses the whole command; `prevent(cb)` replaces it. `prevent()` is caught only in the dispatcher. User commands (`dispatcher.run(kind, …)`) apply the undo policy table; never call `stopCapturing()` or catch `PreventionError` elsewhere.
- **Input attempt** (`edytor.attempts`): one per occurrence (a `beforeinput`, a keydown whose `beforeinput` never came, paste, drop, a native line break). Intent, anchored target (the selection value) and owner (model performs, or browser performs and the model adopts) are fixed at admission. A model-owned attempt owns the DOM drift around it until its deadline.
- **Composition session** (`edytor.composition`): one IME composition, `live → tail → gone`. The start target is replaced by an ordinary command at the first write; previews are mechanical tracked writes in one capture group (one undo step); it ends exactly once (`commit`, `cancel`, `abandon`, or D-20 when a commit re-places the host's block). No timer ever ends a session. While live, the host's segment list is frozen by the pin and the projector writes no DOM selection.
- **History**: `edytor.historyUndo()/historyRedo()` are the bare engine calls — never inside a transaction and with no tracked write after them (that would empty the redo stack), so nothing normalizes after them. The issuing view restores its recorded value.
- **Handles**: `Block`, `Text`, `InlineBlock` are id-only handles (`edytor.idToBlock` is the `Handles` registry). Getters read the document index (inside a command they see its writes); mutators issue commands. They are **not reactive**: templates read the snippet's view object or the cells. A `Text` is the `ordinal`-th segment of its block and has no identity across commits; key extension state by block id and anchor. Liveness is `block.isInTree`, `text.isInDocument`, `atom.isInDocument`.

## Surface

- **Cells** (`edytor.cells`): one frozen cell per visible block, patched from each change report; a patch replaces exactly the cells it names. Components render from cells only (`Edytor` → `Block` → `Content` → `Text`/`Mark`/`InlineBlock`). The core renders the block element from the kind's `element`; snippets render inner markup and receive view objects (`BlockView`, `InlineBlockView`), not handles. Text segments are keyed causally (by the atom before them), so typing never remounts the caret's node.
- **Compare-to-truth observer** (`edytor.surface`): records carry no provenance; they only say what to compare. The pre pass (root `$effect.pre`) inverts a record that removed registered elements and snapshots an edit the flush would overwrite; the compare pass (root `$effect`, after every DOM write) compares each named content with its cell. Text inside a content is adopted through the dispatcher unless an expectation claims its host (the composition tail, a pending structural key, a model-owned drift — then the cell is restored); structure is restored; the live IME host is the IME's; read-only divergence is inverted at the flip back. The root, text elements and core mark elements are strict containers. **D-25:** a block's own text/atom run is a strict region only the editor writes; tolerance covers only a kind's own markup around the content and children slots (and attributes the table does not own).
- **Projector** (`edytor.projector`): the only DOM-selection writer. After every flush it writes the current value when asked, or when the render epoch moved, and only if the live DOM selection differs. It never takes focus from outside the editor and never writes while a composition is live. It classifies every `selectionchange` (echo, drift, composition, foreign, intent). Two named, time-bounded browser rules are the only signatures: the Android post-delete snap-back and the IME post-commit jump.
- **Overlay** (`edytor.overlay`): handles, drop indicator, menus and remote carets live in `[data-edytor-overlay]` beside the host, positioned layer-relative once per frame. Never add chrome inside the host.
- **Placeholder** is the `data-placeholder` attribute on the empty text element, drawn by a shipped `::before` rule.
- **BI2-5 lint**: DOM mutation calls in `src/lib` are allowed only in the host writers (`components/`, the handles' attachments, `surface/observer`, `surface/attributes`, `surface/overlay`, `plugins/`, `collaboration/`). Never write imperatively into owned text or mark elements.

### Selection contracts that must not regress

(Normative spec: `docs/editor-delete-contract.md`, "Anchor contract", "Selection ownership and lifecycle", "Responsibility map".)

- A caret anchor is `{b, a}`: `b` the home block of the backing text, `a.i` the bound item (causal identity), `a.a`'s sign the insert affinity. Text ownership is streams delimited by boundary items: a left caret at a split-born block's start binds that block's boundary item, so the containing stream and the side are two facts in two fields (no owner facet since arch-v2 D12). Never let a caret migrate into a surviving neighbour block because that neighbour received text at the shared gap.
- Logical recovery destination and DOM readiness are separate: a live destination with no mounted node stays the selection value and is displayed by the projector's pass after the flush that mounts it (a value that no longer projects runs the seam repair; a text mount or the observer's records re-run a waiting pass). Do not "fix" this by treating unmounted text as unrecoverable, or by weakening `firstEditableText`'s mounted-node requirement (container phantom slots must stay skipped).
- `surface/projector.svelte.ts` is the only DOM-selection writer: after every Svelte flush it writes the current value, so no older request can overwrite a newer gesture. There is no deferred selection write: commands and input attempts decide the value and `select()` it in their own turn (`edytor.attempts.caret` only records the drift-repair caret). Do not bring back tick/timeout re-assert loops. While a requested display has not landed, a `selectionchange` with no intent gesture since the request (`Edytor.intentSerial`, the one gesture serial; `input` events do not bump it) is not adopted.

## Plugins

`Plugin = (editor) => definitions & operations` (`src/lib/plugins.ts`). A plugin contributes:

- kind records (`blocks`): `snippet`, `element`, `viewState`, `void`, `island`, `rendersContent`, `defaultChild`, `presets` (slash menu, markdown, "turn into"), `empty`, `html`/`plain` export, `parse` (HTML import), `transformText`, `normalizeContent`/`normalizeChildren`, focus/select hooks;
- mark records (`marks`): `tag` + `attributes(value)` (the one element the core renders and the clipboard exports, P2.7), an optional `snippet` (custom markup inside a core span), `parse` (HTML import), `void`, `edge` (`inclusive | exclusive | side-dependent`), `toolbar`; atom records (`inlineBlocks`);
- `hotkeys`, `commands`, and hooks (`onBeforeOperation`, `onAfterOperation`, `onBeforeInput`, `onCopy`/`onCut`/`onPaste`, `onDeleteSelectedBlocks`, attach hooks, `placeholder`).

Duplicate definitions and commands: **first wins** (an extension that extends another's definition lists itself first). Extensions read the document through handles and view objects, never Yjs types. Bundled: rich text, mention, code (Prism in manual mode; tokens are its `transformText`), image, block handles, slash menu, toolbar, arrow move. HTML import (P4.1, `clipboard/htmlFlow.ts`): external `text/html` paste and drop are parsed by the browser (`DOMParser`) into a flow; the tag tables are the kind and mark records inverted (a preset's export/element tag, a mark's `tag`, each record's `parse` hook first) — never a tag switch. Paste order: internal MIME, embedded fragment, a plugin's `onPaste`, HTML import, `text/plain`.

## Where to fix what

- A structural edit is wrong → the document op (`crdt/edytor-doc.ts` prepare functions, `crdt/rangeDelete.ts`, `crdt/flow.ts`) and its contract row, then the view command in `block/block.utils.ts`.
- A text edit is wrong → `text/text.utils.ts`, `session/editing/text.ts` (marks).
- A keystroke is wrong in the browser → `events/onBeforeInput.ts` + `events/beforeInputCommands.ts` / `beforeInputDeleteCommands.ts`, the attempt (`session/attempt.ts`), the binding (`session/bindings.ts`).
- The caret lands wrong → the command's result selection (`Dispatcher.caret`) or the seam (`crdt/anchors.ts`); the projector only displays the value.
- The DOM differs from the model → the observer's classification (`surface/observer.svelte.ts`) or the cell (`surface/cells.ts`). Never patch the DOM from a command.
- IME → `session/composition.svelte.ts` and `surface/pin.svelte.ts`.
- Rendering is wrong while the model is right → components and kind records.

## Testing

Lanes (all green except the known reds listed in the ledger):

```bash
pnpm check                   # svelte-check, 0/0
pnpm lint                    # prettier + eslint (worker-safe boundary, BI2-5 host writers)
pnpm check:worker            # Worker bundle of src/lib/crdt
pnpm exec vitest --run       # unit + model fixtures
pnpm test:crdt               # engine, facade, sync, migration (restore src/tests/crdt/random/failures/seed-37.json and seed-59.json after it; delete stray seed-*.doc.json)
pnpm test:dom                # jsdom-mounted editors (truth check after every test)
pnpm test:typecheck; pnpm test:dom:typecheck
pnpm exec playwright test --project=chromium|firefox|webkit|mobile-chromium|mobile-webkit|cdp
pnpm test:dst                # deterministic editor-input corpus, solo + collab, three engines
tests/packed-consumer/run.sh # packed tarball: node smoke, Svelte build/SSR/mount, strict tsc
pnpm bench:crdt; pnpm census; node scripts/xloc.mjs src/lib --dirs
```

- `playwright.arch.config.ts` / `playwright.dst.config.ts` take `PW_PORT` so parallel worktrees do not collide.
- The JSX fixture DSL (`src/tests/jsx/`) turns `<root><paragraph>Hello <bold>world</bold></paragraph></root>` into `JSONDoc`; `|` marks cursor positions. `createTestEdytor()` (`src/tests/test.utils.ts`) is the headless view for model operations; `renderDomEdytor()` (`src/tests/dom/test.utils.ts`) mounts a real editor in jsdom.
- Oracles live in `src/tests/oracles/` (`truth.ts`: every content equals its cell; `doc-change.ts`, `fresh-view.ts`, `runs.ts`, `model-ops.ts`). Expected results come from contracts, never from production output.
- `docs/editor-delete-contract.md` names the deletion, flow, seam and anchor rows; tests cite them.
- Real browser behaviour (selection, IME, Android drift) is proven only in the Playwright and cdp lanes; jsdom rows are necessary, not sufficient.

## Practical rules

- Change behaviour in its owner. If a change needs a flag, timer, retry or a second place that decides the same thing, stop: a contract row or an owner rule is missing.
- Timers are named, counted browser rules only (`pnpm census` reports them); no `tick()` polling, no re-assert loops.
- Keep `src/lib/crdt` Worker-safe; run `pnpm check:worker` when touching it.
- Verify engine APIs in the vendored source (`src/lib/crdt/vendor/yjs/src`), not from Yjs v13 examples; fork changes go through `UPSTREAM.md`.
- Public API changes are recorded in the README ("Migrating from 0.0.11") and the ledger.
