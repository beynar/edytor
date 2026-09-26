# AI implementation handoff: paragraph attribution and editor performance

Date: 2026-09-22.

This is the consolidated follow-up to the integrated-document implementation. It replaces the earlier paragraph-attribution prompt and adds findings from a review of the editor and its benchmarks. Read this as an implementation assignment. The user has chosen paragraph-level attribution for now and asked for modest, measured editor performance improvements.

The earlier [integration handoff](./crdt-v14-integration-handoff.md) explains historical context. Its requirement to expose text-level attribution by default is superseded here. Keep the integrated document, default history, default awareness, providers, admission checks, identity-preserving moves, and split/merge behavior already delivered. Do not reimplement completed units.

## Goal and completion

Make ordinary editing use compact, durable attribution on logical blocks, and remove avoidable document-wide work from text input and document creation. Preserve editing semantics and make performance claims reproducible.

Done means:

- The normal document API provides block attribution automatically, without persisting one native attribution record per keystroke or decorating ordinary text runs with author boundaries.
- Local history, remote updates, save/load, IndexedDB, and multi-view use preserve the documented attribution semantics.
- The existing size amplification is measured again using matched workloads. Ordinary typing does not generate a second transaction solely for attribution.
- A text wrapper can refresh after a local write without projecting every unrelated block. Placeholder repair is scoped and coalesced. The inert block observer is removed after its lack of behavior is verified.
- The measured quadratic initialization work is removed at its existing owner, with read-your-writes and placement invariants intact.
- Browser measurements distinguish actual work from frame scheduling and identify the remaining expensive functions. Gains and limitations are recorded against source and packed-package identities.
- Relevant correctness suites, browser DST, and packed-consumer checks pass. Unresolved failures remain visible; no weakened oracle, larger timeout, disabled repair, or skipped scenario counts as a performance improvement.

This is not an assignment to virtualize the editor, replace Svelte, rewrite the CRDT algorithm, add a second attribution mode, introduce a new persistence system, or build tracked changes. Start with the existing owners and delete redundant work. Preserve concurrent changes in this dirty checkout.

## Verified context and corrections

The current stack uses vendored `@y/y@14.0.0-rc.26`, the document composition in `src/lib/crdt/document.ts`, the domain facade in `src/lib/crdt/edytor-doc.ts`, and Svelte view wrappers. Verify the pin and local patches in `src/lib/crdt/vendor/yjs/UPSTREAM.md` before editing vendor code.

The reviewed browser artifact is `bench/results/browser-latest.json`, timestamp `2026-09-22T02:36:44.658Z`, M4 Pro, Chromium 147.0.7727.15, real packed-package consumer with trusted CDP input. At review time its source and tarball hashes matched the current files:

- `src/lib`: `308b06d23db7cbefb70869595b6bd65f17cea12b31c1203ef9236bdbaa5c6bb5`
- Package tarball: `418be6e147052a7eb1214db6452acf01b284badee890b5ab0275769e7d6c31d1`

These identities are evidence, not an instruction to reset the checkout. Recompute them before using a baseline.

| Existing observation                                                        | Correct interpretation                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input to first rAF p50: about 7 ms at 6 blocks, 6.7 ms at 1k, 38.8 ms at 5k | Real results for those fixtures and that machine. A first rAF callback is not completed paint. No measured threshold at 2k, guarantee for every document below 1k, or exact count of dropped frames follows.                                                   |
| 5k `dispatchTailMs` about 23 ms                                             | First observed DOM mutation to the document-level `beforeinput` bubble listener. Its owner is unproven. It can contain later microtasks, selection work, layout, listeners, and additional rendering. It is not a measurement of 23 ms of Svelte rendering.    |
| 5k `writeMs` about 10.2 ms; near-zero `publishMs`                           | Existing marks mix transactions: first transaction start, last `beforeObserverCalls`, first facade publication. With two transactions per edit, this does not isolate engine writing or publication.                                                           |
| Alleged ownership scan over 319k dense positions                            | Stale explanation. Ownership is already interval-based. This artifact reports `itemsWalked` p50 10,054 at 5k, with one block recomputed. Those are range-reader sequence items, not dense character owners. Broad work remains, but diagnose its actual owner. |
| Shared 100k-character backing split into 50 blocks: 10.9 ms total p50       | One measured shape. A single edit recomputes all 50 blocks, visiting p50 9,292 items and 5,948 format markers. Do not call all long-text work constant or free.                                                                                                |
| 5k mount about 16.3 seconds                                                 | Navigation through all block DOM nodes appearing. It includes module loading, document creation, wrappers, and rendering. It does not isolate DOM mount.                                                                                                       |
| 5k heap quoted as 239 MB                                                    | This artifact records 212,000,000 bytes. `performance.memory.usedJSHeapSize` is coarse and includes uncollected garbage; it is not retained heap. Reconcile the ledger instead of mixing values.                                                               |
| Attribution adds about 0.03–0.1 ms in the Node microbenchmark               | `bench/u10-attribution-overhead.mjs` compares a bare facade with a document including history, awareness, and attribution. This is a combined integration delta, not isolated attribution overhead or a browser typing measurement.                            |

Read `bench/browser.js`, especially its transaction marks and `stageSpans`, before modifying the benchmark. Stage medians overlap and must not be added. A small latency delta does not prove that growing persistence or metadata cannot affect longer sessions.

### New initialization evidence

A read-only diagnostic used production `bindDocument(Y)` to create flat documents and load their encoded state. Each paragraph contained 60 characters. It counted calls to `getAttr` on the block registry:

| Blocks | Registry lookups during creation | Creation time, instrumented | Load time, instrumented |
| ------ | -------------------------------: | --------------------------: | ----------------------: |
| 100    |                           10,200 |                    30.36 ms |                 3.08 ms |
| 500    |                          251,000 |                   256.49 ms |                 4.84 ms |
| 1,000  |                        1,002,000 |                   869.85 ms |                 7.34 ms |

The lookup counts follow `N² + 2N` for these inputs. Load made zero individual registry lookups through this method and one scan visiting N entries. Creation made one initial empty registry scan, so repeated full `collectBlocks()` scans are not the demonstrated cause. The shared model is doing repeated individual work.

Probe: `.artifacts/editor-performance-audit/initialization-probe.mjs`. Recorded output: `.artifacts/editor-performance-audit/initialization-results.json`. Run from the project root with `node .artifacts/editor-performance-audit/initialization-probe.mjs`.

These are one-sample, instrumented diagnostics, not a controlled timing benchmark. The work counts are the decisive evidence. Do not infer a browser speedup by subtracting these Node timings from the browser mount artifact.

## Attribution contract

“Paragraph” means the stable logical block, including paragraph-like headings and list items. It does not mean a physical backing text: several blocks can share that text after a split. Block identity must own attribution through moves and reparenting.

Use one actor dictionary and a small attribution record per block. Expose a readonly public value along these lines, adapting names to existing conventions:

```ts
type BlockAttribution = {
	createdBy?: ActorId;
	contributors: ReadonlySet<ActorId>;
	lastChangedBy?: ActorId;
};
```

This is a proposed logical shape, not an assertion that these types already exist. The replicated representation must support independently keyed contributor membership. Do not persist a whole array that concurrent writers overwrite. A readonly TypeScript annotation alone does not make a mutable `Set` safe; use the existing immutable publication boundary or a detached public snapshot.

- Actor IDs identify people or anonymous sessions, independently of Yjs client IDs. Store profile fields once per actor. Existing attribution references survive profile changes and client-ID rotation.
- Set `createdBy` when a user creates a block. Do not replace it on ordinary edits or moves.
- Add a contributor only when absent. Write `lastChangedBy` only when the actor changes. Same-actor typing after initialization must not append attribution history on every character.
- Treat contributors as a block-level historical membership summary, not an exact list of authors of surviving characters. Do not retain per-character provenance merely to reconstruct this summary. Document the treatment of undo explicitly and preserve any stronger already-accepted public contract through a tested transition.
- Concurrent contributor additions converge by union. `lastChangedBy` is the CRDT's deterministically resolved last writer, not a globally chronological claim. Do not invent wall-clock ordering guarantees.
- Text changes, mark changes, inline insertion/deletion/data changes, and meaningful block type/data changes attribute the affected block. Ignore semantic no-ops, selection, presence, reads, normalization-only work, and transport bookkeeping.
- A pure move/reparent preserves the moved block's attribution. Do not mark unrelated parents merely because their child order changed. If a compound command also changes content/type/data, attribute those actual changes.
- Creation and duplication stamp the new block's creator. A split gives the new block the splitter as creator, inherits relevant block contributors, and records the split actor on blocks whose content changes. A merge preserves the surviving block's creator, unions contributors, and records the merger. Do not recover character authors after discarding them.
- Applying remote state preserves its authors. Loading or hydrating must never relabel old content as the current actor's work. Unknown imported authors stay unknown. Distinguish an explicitly user-authored initial value from restoration/import and system bootstrap.
- Undo/redo is history replay, not a new author. Restore creator/last-change metadata when selective undo owns that change; preserve concurrent remote contributions and newer remote metadata. Historical contributor membership may remain after an undo, as documented. Test concurrent edits by different replicas of the same actor as well as different actors; write suppression must not cause another replica's contribution to disappear.

Ordinary content and its metadata must commit together at the existing document command/transaction boundary. No attribution-only follow-up transaction for typing. Preserve direct `document.facade.<op>` calls, explicit `document.transact`, view commands, nested batches, and plugin interception. Avoid a second editor-only capture path.

Do not label every raw Yjs transaction as an Edytor command. Define and test the supported direct-raw-write boundary rather than promising automatic block semantics for arbitrary engine mutations. Receivers must never author metadata to compensate for an unclassified remote update.

Native v14 attribution remains available in the raw vendored API. Remove the automatic Edytor text-capture/durability/projection pipeline from the default document. Do not delete upstream native renderers or encoding support merely because this product policy no longer uses them.

## Work units

Each unit delivers implementation, relevant tests, evidence, and removal of superseded code. Keep a short ledger. Finish baseline capture before product edits; use bounded independent parallel work only where file ownership and dependencies allow it.

### U0 — Freeze evidence and correct the measurement boundaries

Read the current implementation and related ledger entries. Record source hashes, package hashes, fixture/seed, harness revision, runtime/browser versions, and hardware. Preserve the existing browser and sizing artifacts under fixed names before generating another `latest` result.

Repair browser instrumentation before using stage budgets:

1. Record each transaction's identity, origin category, local/remote flag, timestamps, update bytes, and nesting/follow-up relationship. Pair each beginning with its own end; retain missing endpoints as missing rather than clamping them to plausible zeroes.
2. Separate input handler work, transaction bodies, observer/publication work, mirror reconciliation, first DOM observation, dispatch completion, and frame scheduling. Keep nested/inclusive spans explicit. Record individual samples, not only medians.
3. Split cold navigation, headless create/load, view construction, first DOM flush, and the existing all-blocks-present milestone. Verify the rendered count and content. Distinguish ordinary heap samples from a documented post-GC retained-heap diagnostic.
4. Capture focused 1k and 5k Chromium CPU/browser traces for mount and sustained typing. Count full projections, registry visits, run recomputations, wrappers reconciled, DOM scans, observers/timers, selection work, and geometry reads. Keep diagnostic overhead separate from final timing runs.
5. Preserve default history and awareness in comparisons. Use a private benchmark-only seam or matched before/after revisions to isolate attribution; do not add a public opt-out just to obtain a baseline.

Keep three comparisons where feasible: A current integrated text attribution, B paragraph attribution alone, C paragraph attribution plus editor fixes. This prevents crediting a DOM change with an attribution gain or vice versa.

Success: stage data can explain two transactions without mixing them; the benchmark still measures real packed-consumer input; raw sample records and trace evidence support any causal labels used later.

### U1 — Implement compact attribution on existing block/document owners

Start at `src/lib/crdt/{document.ts,edytor-doc.ts,nodes.ts,attribution/attribution.ts}` and the existing command/transaction wrappers. Find where the semantic operation and affected block IDs are already known.

Implement the attribution contract above with one semantic owner. Reuse the actor dictionary where appropriate. Detect no-op assignments before issuing CRDT writes. Keep profile updates out of user content history. Batch compound edits into the caller's existing user transaction; do not append an observer-driven second commit.

Test insert/delete/format, inline edits, block metadata, creation, duplication, split, merge, move, nested commands, direct facade use, and shared views. Cover unknown actor/import cases and a fixed actor using multiple replicas.

Success: attribution is on the default API, block identity carries it, concurrent contributors are not lost, and one ordinary typed edit produces one content update with its metadata when metadata changes.

### U2 — Remove the superseded text pipeline and simplify projection

Remove default per-edit `a/<nonce>/<seq>` ContentMap writes, replay/merge maintenance, text attribution decoration, author-induced text run splits, and attribution-only text invalidations. Remove the obsolete public text-attribution fields in the agreed API transition and update declaration/consumer fixtures.

Inspect `src/lib/crdt/text/runs.ts`, `src/lib/text/deltas.ts`, `src/lib/text/text.svelte.ts`, and readonly rendering. `Text.renderChildren` currently coalesces run boundaries via `mergeRenderDeltas`; remove that work only if its remaining semantics are fully covered by the canonical mark/content path. Preserve real formatting, inline boundaries, and plugin `transformText` behavior.

Keep block attribution separate from inline mark data. Exposing it must not require parsing every block's text or rebuilding the ordinary render tree. Immutable snapshots, reactive consumers, mid-transaction reads, and committed notifications remain correct.

Success: no ordinary text-level author machinery remains active; raw native v14 capabilities remain intact; application builds and packed type consumers use the new block surface correctly.

### U3 — Prove history, concurrency, durability, and upgrade behavior

Cover edits by Alice/Bob/Carol with offline delivery, duplicate delivery, different delivery orders, disjoint contributor additions, concurrent `lastChangedBy`, actor switching, repeated same-actor edits, and same actor on multiple replicas.

Test undo/redo after remote work, including edits that did not rewrite already-present membership or same-actor last-change fields. Test split/merge/move plus undo and reload. Do not restore an entire old attribution object over remote additions. Keep existing ownership-repair transactions where required; the one-transaction goal forbids an additional attribution transaction, not an unrelated rewrite of the proven undo repair.

Exercise `encode`/`loadDocument`, `attachDocument`, pending hydration, IndexedDB reconnect/reload/compaction, WebSocket synchronization, two views sharing one document, and owned/borrowed destruction.

Handle existing saved text-attribution documents deliberately. Reuse admission, schema, and storage-generation boundaries. Provide a tested conversion or a precise fail-closed upgrade path; never silently discard author data while reporting a successful lossless load. A conversion can summarize known per-text authors into block contributors, but it cannot invent reliable creation or global last-edit chronology absent in the old representation.

Deleting old keys does not guarantee reclaiming CRDT history bytes. Measure upgraded documents separately from fresh ones. If meaningful reclamation requires exporting into a fresh generation, document preserved content/marks/IDs and lost historical positions/history explicitly; do not transparently rebuild an actively shared document or connect generations as if they were interchangeable.

Success: peers converge on content and attribution; history does not steal remote authorship; upgrades have a tested compatibility contract; no opt-in assembly is required for normal consumers.

### U4 — Requalify size and update amplification

The earlier integrated measurement recorded 200 one-character edits with `encode()` 14,752 B versus 512 B, update traffic 19,458 B versus 4,965 B, 400 versus 200 update events, and 401 versus 201 IndexedDB rows. These are specific fixture results, not universal ratios or attribution-isolated latency evidence.

An encoding-only paragraph prototype with history enabled in every lane produced:

| Workload, 200 appends               | No attribution | Current text records | Paragraph prototype | Paragraph / no attribution |
| ----------------------------------- | -------------: | -------------------: | ------------------: | -------------------------: |
| One actor                           |          476 B |             13,313 B |               605 B |                     1.271× |
| Alice 100, then Bob 100             |          490 B |             13,557 B |               715 B |                     1.459× |
| Alice/Bob alternate every character |        2,074 B |             13,557 B |             5,894 B |                     2.842× |

See `.artifacts/attribution-sizing/{probe.mjs,results.json}`. This prototype synchronized sequentially and did not qualify concurrency, migration, or selective undo. It demonstrates feasibility, not finished product behavior. The alternating case rewrites last-writer metadata repeatedly and therefore still grows with edit count.

Reproduce matched scenarios through the supported document API, keeping history, profiles, client-ID widths, seed content, edit grouping, actor IDs, and persistence policy comparable. Record initial/final encoded bytes, attributable growth, update bytes/events, actual IndexedDB rows/bytes after flush, and load time. Include 200-edit and longer-lived histories, fresh and upgraded documents, single paragraph and multiple blocks.

Use prototype-relative budgets as initial targets for its exact fixture: at most 1.5×, 1.75×, and 3.25× no-attribution encoded size respectively. Explain any miss with bytes and semantics; do not falsify baselines, abbreviate realistic actor data only in one lane, or delete correctness to meet a ratio. Also report absolute overhead because ratios explode for tiny documents.

Success: no new per-edit text records, no attribution-added update/IDB row for ordinary typing, and no attribution metadata growth during repeated same-actor edits after membership/last-writer initialization. Content and ordinary Yjs edit history can still grow. Actor alternation and migrations must be reported honestly.

### U5 — Make text-wrapper refresh read only the affected content

Confirmed call chain at review time:

- `Text.insertAt`, `deleteAt`, and `formatAt` call `refreshFromProject` after the model write (`src/lib/text/text.svelte.ts`, around lines 338–378).
- `refreshFromProject` calls `edytor.projectedBlock(parentId)` (around line 203).
- `projectedBlock` reads `_projectedTree`; a facade-version change calls `facade.project()` and indexes the whole document (`src/lib/edytor.svelte.ts`, around lines 661–683).

This is full-document work to refresh one text segment, despite the later incremental `DocChange` mirror. Preserve immediate read-your-writes: simply deferring refresh until commit is incorrect for batched commands.

Use the existing block content surface (`DocBlock.items` / facade `contentItems`, after checking its current contract) or the smallest scoped extension at that owner. Preserve multiple text segments around inline nodes, segment identity, hidden/deleted blocks, marks, split/merge backing ownership, and the existing content grouping rule. Do not expose borrowed mutable engine values to the view.

Instrument `applyMirrorChange` and `flushMirror` fallbacks to distinguish necessary structural recovery from accidental full refresh. Do not remove the fallback for remount/remote/undo divergence just to lower a counter.

Success: a warmed ordinary edit in one independent paragraph does not call the full-document projection to refresh its text wrapper, does not reconcile unrelated wrappers, and remains correct inside a transaction containing subsequent reads and writes. Test these properties at 100, 1k, and 5k blocks.

### U6 — Bound placeholder repair and remove inert observer work

Confirmed sources:

- The facade change handler in `src/lib/edytor.svelte.ts` calls `removeStalePlaceholdersIn(this.node)` and then `scheduleRemoveStalePlaceholdersIn(this.node)` after `tick()` (around lines 625–634). The scheduler immediately calls the same full-root scan again.
- `src/lib/text/removeStalePlaceholders.ts` schedules immediate, microtask, rAF, a timer from rAF, and 50/250/1000 ms retries: up to seven executions per schedule, without cancellation or coalescing. The extra explicit scan makes eight global passes per handler invocation. These passes can overlap subsequent keystrokes.
- The per-text helper is local to the text's parent. Do not incorrectly call it a full-editor scan. It is invoked from `_setItems`, Svelte effects, and per-text MutationObservers, adding overlapping local retries.
- `src/lib/components/Text.svelte` has additional placeholder observers/timers. Trace actual scheduling rather than removing them by appearance.
- `Block.attach` in `src/lib/block/block.svelte.ts` creates a TreeWalker and one MutationObserver per non-void block. Its `acceptNode(node)` checks `node.parentElement === node`, which cannot match. It traverses but never removes anything (around lines 1010–1035).

Use affected content/structure IDs and existing DOM ownership to schedule repair for affected roots. Coalesce duplicates within the relevant flush; cancel owned pending callbacks on detach/destroy. Preserve any delayed repair whose necessity is demonstrated by a regression. Scope it to the live affected view/root and explain the race it covers.

Remove the inert block observer rather than changing its predicate to start deleting whitespace. Empty text nodes can be Svelte anchors; `domTextMutationObserver.ts` explicitly preserves them. Do not revive the currently unbound `noWhiteSpace` helper in `components/Edytor.svelte`, remove anchor-preservation logic, or blindly remove `domVersion`/`editorDomRevision` remount behavior.

Prove empty→nonempty→empty, deleting all marked text, Enter then undo, composition cancellation, inline separators, blurred programmatic updates, remote edits, and keyed remount behavior. Use real browser tests and existing DST witnesses. Wait beyond the longest retained retry when measuring idle cleanup after a typing burst.

Success: no full-editor placeholder scan on an ordinary single-paragraph edit; repair work follows affected roots; there is no accumulation of duplicate timers under sustained typing or callbacks acting on destroyed views; the useless block observer count disappears; visible placeholder and selection behavior is unchanged.

### U7 — Remove quadratic work from fresh initialization

Use the registry-count diagnostic above as the starting witness. Inspect the existing flow:

- `init()` in `edytor-doc.ts` loops over root specs and calls `M.insertBlock` inside one transaction (around lines 928–951).
- `insertBlock` in `placement/model.ts` asks for live siblings before ranking/inserting each root block (around lines 830–832).
- The shared model's `modelCtx()` calls `syncTransaction()` (`text/runs.ts`, around lines 1967–1996 and 2274). The transaction's changed sets accumulate; this bridge deliberately processes them again to preserve read-your-writes.

The quadratic count is established; identify which repeated dirty processing, block reads, ownership/placement refreshes, and sibling indexing account for it before patching. A registry scan cache alone does not address the measured work.

Prefer the smallest initialization/bulk-insert extension of the placement owner, using its existing rank generation and validation, or a correct change-consumption mechanism at the shared model if profiling shows that is the appropriate owner. Do not duplicate placement semantics in `document.ts`. Do not treat an unchanged `changed.size` or an already-seen type/key as proof no further write occurred: a transaction can modify the same text or attribute repeatedly.

Retain all-or-defined-failure input handling, root order, caller IDs, child nesting, marks/inlines, duplicate-ID rules, concurrent initialization policy, and bootstrap-before-history behavior. Test repeated edits/readbacks to the same key within a transaction and initialization followed by an immediate command. Import/validation staging must not publish partially admitted content.

Success: creating 1k/5k flat documents no longer repeats `N² + 2N` registry lookups. Counters and profiles show that equivalent work was not merely moved elsewhere. Creation time/scaling improves in repeated headless and browser runs; loading and normal editing do not regress. Keep the probe as diagnostic evidence and add the narrow relevant regression to the existing suite.

### U8 — Check remaining view fanout with real consumers

After U5–U7, re-profile. Address a remaining hotspot only when evidence identifies a bounded fix in these paths:

**Full-value consumers.** The existing commit handler already avoids a full `edytor.value` export when no `onChange`/plugin consumer exists. Preserve that optimization. `Block.value` recursively serializes the tree, and the benchmark page currently supplies no `onChange` callback. Add a lane with a real callback and one with a reactive `$derived` value consumer. Record explicit JSON serialization separately. Reuse existing immutable snapshot/subtree owners if avoiding repeated reconstruction is justified; do not promise O(1) for callers explicitly serializing an entire document. Never silently debounce/drop callbacks or replace the Svelte reactive revision with only a plain facade counter: that caused a previous real regression.

**Awareness and geometry.** `Edytor` subscribes to awareness `change` and `update` and refreshes presence on facade changes. `RemoteSelections.svelte` separately subscribes to both awareness events and document updates. `remoteSelection.ts` reads element and range rectangles. Count duplicated callbacks and actual geometry work with remote peers; these are not proven causes of the existing no-peer browser timings. Use semantic invalidation and, where appropriate, coalesce view geometry per frame. Preserve heartbeat/expiry protocol behavior, remote deletion, selection anchors, scroll/resize, multiple views, and teardown. With no visible remote selections, avoid unnecessary geometry reads.

**Shared backing.** Determine how much of the 50-block invalidation disappears with text attribution. For an insertion strictly inside one owned slice with no change to other slices or format context, unrelated block runs should be reusable. Boundary edits, ownership changes, and formatting may legitimately fan out. If broad invalidation remains expensive, refine the existing backing-to-owner dependency tracking only with differential tests against full recomputation. Do not restore dense per-character ownership or create a second sequence interpreter.

Success: each retained optimization has a trace/counter rationale and behavioral proof. If an area is insignificant or inherently full-output work, record that result and leave its architecture alone. Do not expand this unit into a renderer rewrite.

### U9 — Qualify correctness and performance on the final artifact

Use the existing browser harness, not synthetic `dispatchEvent` alone. Main timing comparisons can stay in Chromium; correctness must exercise Chromium, Firefox, and WebKit through the existing Playwright/DST setup. WebKit is engine coverage, not a claim to have tested shipping Safari or real iOS input.

Minimum performance coverage:

- Flat documents at small, 100, 500, 1k, 2k, and 5k blocks; repeat fresh create and encoded load separately.
- Marked text, nested blocks, empty paragraphs/placeholders, inline boundaries, and the existing shared-100k/50-block shape.
- Trusted sustained typing and deletion, plus the existing range-format, split/merge/move, undo/redo, and remote-update lanes affected by these changes.
- Default services enabled; callback-free, full-value-consumer, and active-remote-presence cases distinguished.
- p50/p95, warmup/sample count, handler/main-thread work, first DOM observation, first rAF, work counters, and any actual presentation evidence clearly named. Keep traces separate from uninstrumented timing runs.

Require a repeatable reduction in the targeted work and associated CPU/mount cost, with no material small-document regression beyond measured run variance. Record baseline variance before selecting timing budgets. Do not manufacture a universal 16 ms promise or pass a performance gate because rAF scheduling happened to land differently. A visible 5k improvement is the aim; the counter invariants in U5–U7 are hard acceptance criteria.

Run focused checks after each unit and the final relevant lanes:

```sh
pnpm test -- --run
pnpm test:dom
pnpm test:crdt
pnpm test:crdt:extensive
pnpm test:typecheck
pnpm test:dom:typecheck
pnpm check
pnpm lint
pnpm test:integration:serial
pnpm test:dst
DST_SEEDS=1-24 DST_STEPS=36 DST_SHRINK=0 pnpm test:dst
pnpm build
tests/packed-consumer/run.sh
pnpm bench:crdt
pnpm bench:browser
```

Check the current scripts before invoking them. Preserve unrelated edits; format only owned files. Serialize resource-heavy browser runs so load does not become an avoidable source of noise. Report missing browser binaries, skips, retries, and environmental failures exactly rather than calling an unrun lane green.

Success: final packed package, source hashes, tests, and measured artifacts all refer to the implementation being delivered. Update docs and public examples for the resulting API and remove contradictory default-text-attribution guidance.

## Earlier findings that must remain in scope

- The seed-96 rank-space defect is already fixed: `src/tests/crdt/random/corpus.test.ts` has an empty `KNOWN_MODEL_BUGS` map and refers to `hardening/u5-min-rank-rehome.test.ts`. Reconcile stale “still open” ledger wording instead of fixing it twice.
- Raw diagnostic corpus crashes involving skip/GC were previously reported under seeds 37/59/86/140; current code explicitly preserves frozen 86/140 artifacts. Recheck actual artifacts and schedules rather than equating a regenerated seed number with an old reproduction. Keep diagnostic versus supported-production paths explicit. Replay supported analogues involving reload, delete, move, and undo. A crash reachable through a supported document/provider path is a blocker and must be minimized and fixed; “upstream engine” is not an exemption. A raw adapter's intentionally lossy operation is not automatically a production failure. Document the reachability boundary without deleting evidence.
- Preserve the repaired reactive `value` invalidation, history-selection restoration, readonly teardown, lifecycle leases, and ownership-repair behavior recorded in the integration ledger. Green model tests do not substitute for their browser regressions.

## Review and delivery

Review the final diff against these failure modes:

1. Attribution moves to paragraphs visually, but the old per-edit capture log still grows underneath.
2. Metadata is stamped only by UI commands; headless edits or remote loading get different semantics.
3. Contributor arrays or snapshot restoration erase another writer's contribution.
4. A text edit looks incremental after commit but still projects the document during the command.
5. Placeholder scans move into another callback and still run over the entire editor, or pending retries survive destruction.
6. Faster initialization skips dirty updates when the same key changes twice, changes placement order, or defers invalid state until after publication.
7. A faster benchmark omits real consumers, default services, delayed work, correctness assertions, or package installation.
8. A source/trace naming assumption is presented as a measured causal result.

Deliver the changed code and a concise report with Outcome, Validation, and Risks. Include the public attribution contract, upgrade behavior, deleted mechanisms, before/after size and work/timing tables, commands and actual results, artifact locations/hashes, and any remaining correctness or performance limitation. Explain missed targets using evidence. Do not claim completion while an in-scope correctness gate is failing.
