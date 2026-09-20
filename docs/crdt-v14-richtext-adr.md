# ADR — U05 Rich Text: maintained run view, mark semantics, decorations

Status: accepted (U05). Supersedes: nothing. Builds on:
`docs/crdt-v14-text-ownership-adr.md` (U04 slices/ownership),
`docs/crdt-v14-move-adr.md` (U03 placement).

This document is the contract for the rich-text layer that renders and
exports block content: formatted text runs, inline atoms, annotations
(marks), and local-only decorations. The executable spec lives in
`src/tests/crdt/runs/golden.test.ts` (AN01–AN07 semantics),
`src/tests/crdt/runs/runs.test.ts` (view contract), and
`src/tests/crdt/runs/delta-contract.test.ts` (engine cache behavior).

---

## 1. Decision: a maintained run view over the ownership model

`src/lib/crdt/text/runs.ts` exposes `bindRuns(Y)` → `{ attach, computeAllRuns }`.

`attach(doc)` returns a `RunView` — an **incrementally maintained** projection
of every visible block's content as ordered, frozen _run_ objects:

```ts
type ContentRun =
	| { kind: 'text'; text: string; marks?: Record<string, unknown> }
	| { kind: 'inline'; id: string; type: string; data?: Record<string, unknown> };
```

### API surface

| Method                   | Contract                                                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `runs(id)`               | Frozen `readonly ContentRun[]` snapshot; `[]` for absent/hidden (merged-away, deleted) blocks. Lazily recomputes only when invalidated.                            |
| `snapshot(id)`           | Mutable deep copy of `runs(id)` — for callers that must own the data.                                                                                              |
| `contentJSON(id)`        | Public export shape `[{text, marks?} \| {id, type, data?}]` — matches `JSONText`/`JSONInlineBlock` in `src/lib/utils/json.ts`. Owned copies, never engine objects. |
| `version()`              | Monotonic counter bumped once per observed registry event (any change).                                                                                            |
| `blockVersion(id)`       | Bumps only when `id`'s snapshot actually changed. Ensures lazy recompute first.                                                                                    |
| `subscribe(cb)`          | `cb(version)` on every observed change.                                                                                                                            |
| `subscribeBlock(id, cb)` | `cb(runs)` only when `id`'s snapshot diffs. Primes the baseline at subscribe time — listeners never see the initial compute.                                       |
| `dispose()`              | Removes the registry observer; drops caches.                                                                                                                       |
| `debug`                  | `{recomputes, recomputed:Set, reset()}` — the instrument used by tests/bench.                                                                                      |
| `computeAllRuns(doc)`    | From-scratch baseline — the honest "full recompute" comparator and the fresh-projection oracle.                                                                    |

### Guarantees (tested)

- **Equivalence** — `runs(b)` always equals `computeAllRuns(doc).get(b)`
  after local edits, remote update application, undo/redo, and across
  split/merge/move (a 120-step random-op fuzz asserts it after _every_ step).
- **Granularity** — an edit to block A recomputes only the blocks whose
  flatten consulted the touched text/slice-lists. A 1-char insert in a
  1000-block doc recomputes 1 block; the other 999 keep array identity.
- **Identity** — unaffected blocks keep array _and_ run-object identity
  (`toBe`). Inside an edited block, runs outside the edited window keep
  object identity (prefix/suffix structural sharing via `reconcile`).
  Equal `marks`/`data` objects are interned — `===` holds for unchanged
  formatting and data.
- **Isolation** — snapshots are frozen at every level (array, run, marks,
  data). Nothing engine-internal crosses the API boundary.
- **Canonical shape** — adjacent text items with deep-equal marks merge
  into one run (segment boundaries are invisible at the run layer);
  inline atoms always stand alone.

---

## 2. Delta-cache verdict: POISONING/MUTATING — never expose it

Probed empirically (`delta-contract.test.ts`, 9 tests):

- `node.delta` is lazily materialized, then **the same live object is
  mutated in place** by every subsequent change. It is authoritative once
  integrated, but it is _shared and mutable_ — not a snapshot.
- Consumer mutation corrupts it permanently: writing to the cached object
  made `delta` return `"POISON!ED"` while `toDelta()` stayed correct —
  the engine does not detect or repair the damage.
- **Detached reads are hazardous**: reading `.delta` on a not-yet-integrated
  node materializes an empty cache that is never back-filled after
  integration — stale-empty until `clearCache()`.
- Local edits, remote updates, and undo/redo all keep the live cache in
  sync with a fresh `toDelta()` — it is _correct_, just _live_.

**Verdict: the cache is mutating and consumer-poisoning — usable only as
an internal live read path, never as a returned value.**

Rules adopted everywhere:

- `itemsOfRange` reads `.delta` only on integrated nodes; detached nodes go
  through `toDelta()` (the fresh-rendering path) — guarded in
  `text/model.ts`.
- The run view snapshots (clone + freeze) everything that crosses the API
  boundary; `contentJSON` produces plain JSON.
- Cost context (bench): `.delta.toJSON()` ~0.7µs vs `toDelta().toJSON()`
  ~3µs per content node — the cache is ~4× cheaper as a read path, which
  is why we keep it internally rather than paying fresh renders per read.

---

## 3. Invalidation & dependency tracking

One `observeDeep` on the registry node delivers `event.deltaDeep` — a
nested modify-delta whose root `attrs` are keyed by block id and whose
per-block `attrs` name the changed facets. Facets:

| Facet                                     | Meaning                                 | Action                                                                                            |
| ----------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `content`                                 | The block's text/inline content changed | dirty the text's atom row; invalidate blocks that consume this text                               |
| `slices`, `del`                           | Ownership structure changed             | bump `structureVersion` (lazy `computeOwners`); invalidate every consumer of the list's _effects_ |
| `at`, `id`, `type`, `data`, payload attrs | Placement/metadata                      | **ignored** — a move never recomputes runs                                                        |
| unknown attrs                             | Future schema extensions                | treated as structural (safe over-invalidation)                                                    |

**Dependency indexes** (all incremental, updated per event):

- _Forward deps_ — each cached block records which backing **texts** its
  flatten consulted and which **slice lists** it walked
  (`textConsumers`, `listConsumers`).
- _Reverse effects_ — each slice list records which texts its records
  ever covered and which lists its merge claims ever targeted — a union
  that never shrinks, so a removed record still invalidates its old range.
- _Block records_ — `blocks` map of `TextBlockRec` rebuilt per touched
  block only; `recordsByText` pruned/re-added on slices changes.

**Ownership is lazy-incremental**: `computeOwners` (the block-level map)
rebuilds only after a structural event; per-text `AtomRow`s
(owner+claim per atom) rebuild only for touched texts; slice-record anchor
resolutions are cached per `SliceEntry` and dropped when their text changes.

**Recompute is lazy** except for blocks with `subscribeBlock` listeners,
which recompute eagerly at event time so listeners are synchronous.

---

## 4. Mark semantics — the AN06 contract (specified, not inherited)

Marks are replicated as **v14 format items**: `setMark(k,v)` over a range
writes a format-START item `{k:v}` and a format-END item `{k:null}` into
the sequence. The active value of key `k` at any atom is the value of the
last-start item preceding it in sequence order; an end item restores null.
Concurrent items order by `(client,clock)` — deterministic and convergent
on every replica, in either delivery order.

Consequences pinned as the model contract (`golden.test.ts`):

- **Independent keys never interact** — concurrent different-key marks on
  the same range union in the marks object (`{color:'red', bold:true}`).
- **Same-key disjoint ranges both survive.**
- **Same-key overlapping ranges** — the overlap resolves to the
  later-ordered writer (item order — not value-based, not
  last-delivery-wins). Example, A=`red`[0,8), B=`blue`[3,11): `hel` red,
  `lo wo` blue, `rld` **unmarked** — the loser's end marker restores null
  where it lands inside the winner's exclusive suffix. This tail-clearing
  is the documented engine semantic we adopt, not an accident.
- **Contained ranges** — the inner write wins its range; the outer write
  keeps only its exclusive prefix (its end marker clears the rest).
- **Concurrent set vs unset** — the null write wins the contested range
  (verified `hello` unmarked + ` world` bold in both orders).
- **Insert inside a marked range** — a _local_ unmarked insert is wrapped
  by the engine in negation items and stays unmarked (splits the run);
  a _concurrent_ insert written on a replica that lacked the mark lands
  between the format brackets and **adopts the mark** (`lXo` all bold).
- **Boundary typing** — an insert at a mark edge lands outside unless it
  carries the mark; a marked insert at the right edge extends the run.

Object-valued marks (annotation payloads like `{comment:{id:'c1'}}`)
split runs by value — each distinct value is its own run boundary.

---

## 5. Annotations & endpoints (AN07)

Annotations are marks on atoms; their "endpoints" are not positions but the
first/last atoms carrying the mark — so endpoint semantics are atomic, not
offset-based:

- Inserts at either endpoint stay **outside** the annotation unless they
  carry the mark themselves (verified for concurrent inserts at both ends).
- Deleting an endpoint atom shrinks the annotation from that side — the
  rest survives (`world`→`orld` keeps `comment:'c1'`).
- Split/merge carry marks with their atoms: splitting at an annotation's
  left edge puts the whole annotation on the sibling; deleting the
  sibling's endpoint atom then merging back yields the shrunk annotation.
- Relative-anchor slice records (U04) already give the containment rules
  for the _ownership_ layer; the mark layer needs no additional machinery.

---

## 6. Inline atoms (AN03)

- Atoms are `Y.Node` items inside the content sequence; identity is engine
  identity — an atom crossed by a split seam moves **whole, once** to the
  sibling (verified through split/merge/undo and concurrent split+edit).
- `M.setInlineData(doc, blockId, inlineId, data)` — a replicated attr write
  that preserves identity and invalidates only the owning block; inside
  that block the atom's run is rebuilt while neighboring runs keep object
  identity (bench: 2/3 runs reused).
- Concurrent `removeInline` vs `setInlineData`: **the delete wins** — the
  sequence-delete tombstones the atom; the attr write lands on the
  tombstone and does not resurrect it (both delivery orders).
- `removeInline`/`setInlineData` iterate `toArray()` with explicit
  position tracking — a multi-char string is ONE array element, so array
  index ≠ sequence position (a real bug found by these tests: the space
  before the atom was deleted instead of the atom).

---

## 7. Decorations (AN05) — pure local overlay

**Decision: decorations are a pure overlay over persistent run snapshots,
not a separate replicated type and not part of the view's maintained
state.** `decorateRuns(runs, decorations)` is a pure exported function:

```ts
type LocalDecoration = { from: number; to: number; key: string; value: unknown };
decorateRuns(runs, decos) → readonly DecoratedRun[]  // frozen
```

- Text runs split at decoration boundaries; each piece carries
  `decorations` = the ordered union of covering `{key: value}` (later
  decorations override; `value: undefined` removes the key over its range).
  Persistent `marks` pass through by reference (interned).
- An inline atom is one display position — never split; covering
  decorations attach to it.
- Offsets are display positions (text char = 1, atom = 1) — the same unit
  as model-level text ops.
- Proven non-replicating: applying decorations emits **zero** updates
  (asserted via `doc.on('update')` count), never enters `contentJSON` or
  `project()`, and remote persistent marks survive local decoration —
  the overlay recomposes on the converged runs.

This is the seam a Prism/syntax plugin or a suggestion/spellcheck plugin
uses: compute `decorateRuns(view.snapshot(b), localDecos)` in render.

---

## 8. Readonly / export (AN04)

`contentJSON(id)` is the readonly/export surface — the public
`{text, marks?}`/`{id, type, data?}` JSON shape. Exported snapshots are
immutable in time: later edits never mutate a previously returned array
(they are owned copies). Live delta objects never cross the boundary.

The agreement invariant — live `.delta`, fresh `toDelta()`, the maintained
view, and the export all describe the same content — is asserted in the
AN04 scenario, including after remote application and persist→reload.

---

## 9. Measurements (bench:runs — `bench/results/runs-latest.json`)

Method: env-gated vitest bench (`BENCH_RUNS=1 pnpm bench:runs`), wall-clock
`performance.now()`, warmup + sample counts recorded per workload, Node
v24 / darwin-arm64. The instrument is `view.debug.recomputes` — the real
recompute counter, not a simulation.

| Workload                                          | Result                                                                                              |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Cold first read — 1000 blocks (attach + all runs) | ~6.0 ms mean (fresh doc ~11 ms incl. update apply)                                                  |
| Warm `runs()` per block                           | ~0.3 µs                                                                                             |
| Warm `contentJSON()` per block                    | ~0.4 µs                                                                                             |
| `computeAllRuns` full recompute (1000 blocks)     | ~4.1 ms                                                                                             |
| Local 1-char insert                               | event ~5.3 ms (first event), recompute **1 block** ~0.12 ms; 20/20 sampled other blocks reused      |
| Unrelated edit, full re-read of 1000 blocks       | 999/1000 reused, 0.19 ms total                                                                      |
| Remote 1-char insert                              | apply ~0.21 ms + recompute 1 block ~0.04 ms                                                         |
| Split block                                       | invalidates exactly head + sibling (2 recomputes)                                                   |
| Merge blocks                                      | invalidates exactly owner + merged-away (2 recomputes)                                              |
| Inline metadata update                            | 1 block recomputed; 2/3 runs inside it reused                                                       |
| `.delta.toJSON()` vs `toDelta().toJSON()`         | ~0.7 µs vs ~3 µs (cache ~4× cheaper)                                                                |
| Scaling (cold read all)                           | 100 → 1.1 ms, 1000 → 8.8 ms, 4000 → 56 ms (≈linear); re-read after 1 edit: 0.04–0.43 ms, N−1 reused |

vs the U04 ownership wire numbers (unchanged): split-100k ~334 B,
merge-100k ~35 B.

---

## 10. Limitations & U06 handoff

- **Same-key tail-clearing** is real engine behavior we adopted, but it
  can surprise: a concurrent same-key write's exclusive suffix may lose
  the mark. If product semantics ever require "both exclusive parts keep
  their value", the mark representation must change (e.g. per-atom attrs
  or model-level mark rewriting) — that is a data-model decision for a
  later unit, not something the run view can paper over.
- The view invalidates at **block granularity** — a 1-char edit recomputes
  the whole block's runs (runs inside it are still structurally shared).
  Sub-block incremental recompute is possible but unjustified at these
  numbers (~0.12 ms/block).
- `version()` counts _observed_ transactions, not _content_ changes — a
  pure move bumps it while changing no runs (per-block versions are the
  precise signal).
- `attach` is keyed by `WeakMap<doc>` — reloads produce a new doc object,
  so views re-attach cleanly; consumers holding a view across reload must
  re-attach (the scenario tests do exactly this).
- No selection/IME/history integration yet (U09); the run view is a read
  surface — edits still go through `bindModel` ops.
- Decorations are a function-level overlay; a maintained decoration layer
  (e.g. incremental Prism re-lexing) is a plugin concern, not U05.
- The `data`/`type`/payload attrs of a block do not affect runs and are
  deliberately not observed as content facets — if a future block type
  stores render-relevant payload it must be added to `facetOf`.
- U06 will assemble the document model on top of this: the run view +
  placement projection + ownership are the three maintained projections it
  composes; `contentJSON` is already the export shape it needs.
