# CRDT v14 — Gate H adversarial review

Date: 2026-09-21. Branch: `feat/crdt-v14-engine` (HEAD `d9b7de0`).
Reviewer: independent Gate H pass over the R1–R5 hardening repairs plus the
two bonus fixes (module-level undo-repair lease, deterministic rehome rank).
Mandate: break the repairs; convergence and a green suite are not evidence of
semantic safety. No production file was modified; all probes live under
`src/tests/crdt/hardening/gateH-*.test.ts` (50 executed tests across 7 files —
`gateH-r1-probes` runs 5 seeded facade schedules from one `test()` site).

## Verdict summary

| Repair                                              | Verdict               | Basis                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1/P4 — vendored `updateMarkerFormats` repair       | **PASS**              | 22 pinned + 10 adversarial probes green; nested-remote-apply stale-marker attack is structurally defended; invalidation verified on every path exercised                                                                                                                                   |
| R2 — IndexedDB refused-schema compaction protection | **PASS**              | Refusal blocks compaction (including a refusal discovered mid-`storeState`); the getAll→getLastKey foreign-commit window is closed by IDB transaction serialization (verified, not assumed); refused docs still persist local writes; destroy/double-store clean                           |
| R3 — replicated undo-ownership repair               | **FAIL**              | Repair gate `transaction.origin instanceof Y.UndoManager` is bypassed by any outer transaction and by undo-after-last-dispose → permanently wrong ownership that broadcasts to peers                                                                                                       |
| R4 — public snapshot isolation                      | **PASS-with-caveats** | JSON-contract isolation holds everywhere probed; non-JSON values at raw/replicated boundaries crash or poison (remote BigInt attr → read crash on every replica; local BigInt mark → commit-throw poison); `DocChange.order` arrays alias the retained diff baseline unfrozen              |
| R5 — commit-bound notifications                     | **PASS-with-caveats** | Deferral/dedup/mid-tx-subscribe correct; a throwing listener permanently starves other blocks' notifications for that commit (`pendingNotify` cleared before publish); undo+repair emits a torn committed frame (R3's unrepaired state is published before the repair)                     |
| R6 — strict oracle / fault injection                | **FAIL**              | Three demonstrated invisible-fault classes survive the hardened oracle: wrong mark **value** on authorized keys, wrong-**offset** inserts, false-return foreign-peer writes; `recordedTombstones`/`markLedger` are write-only dead ledgers; `mutated-edit` is documented but never emitted |
| Bonus — module-level undo-repair lease              | **PASS-with-caveats** | Mechanics verified (one listener per doc, idempotent dispose, re-arm on re-create); the lease design creates the post-dispose undo window recorded under R3                                                                                                                                |
| Bonus — deterministic rehome rank                   | **PASS**              | Pinned 5/5 + 25-block cross-replica order stress green                                                                                                                                                                                                                                     |

## Commands run

```
npx vitest run src/tests/crdt/hardening/          # full lane
  → 14 files, 111 tests: 104 pass / 7 fail
    (the 7 failures are intentional RED defect-evidence probes, below)
```

Per-file: `r1-p4-format` 22✓ · `r2-idb-compaction` 10✓ · `r3-undo-ownership`
11✓ · `r4-snapshot-isolation` 5✓ · `r5-commit-notify` 6✓ · `r6-oracle-injection`
2✓ · `u5-min-rank-rehome` 5✓ · `gateH-r1-probes` 10✓ · `gateH-r2-probes` 3✓ ·
`gateH-r3-probes` 5✓/2✗ · `gateH-r4-probes` 13✓ · `gateH-r5-probes` 5✓/1✗ ·
`gateH-r6-probes` 1✓/4✗ · `gateH-lifecycle-probes` 6✓.

All gateH probe files are collected by the suite glob and every probe's target
branch was observed to execute (console instrumentation asserted the sneaky
path ran — e.g. `[r6-foreign] foreignLanded=true`, `[r5-flicker]
broken-intermediate-observed=true`). Three earlier probe drafts were corrected
or discarded where the probe itself was wrong — see "Probe corrections" below;
throwaway diagnostics were removed from the tree.

---

## R1/P4 — vendored `updateMarkerFormats` (ynode.js): **PASS**

Challenged: marker-cache validity under boundary inserts, undo-restored
format items, remote-vs-local marker clearing, marker-seeded anchors, and a
nested `applyUpdate` inside a local transaction (the suspected stale-marker
channel — `transaction.local` would be true for the outer frame).

Findings:

- The nested-remote-apply attack **does not reproduce**: `readUpdateV2` sets
  `transaction.local = false` (`vendor/yjs/src/utils/encoding.js:249`), so the
  marker pool treats the transaction as remote and clears snapshots even when
  the apply ran inside an outer local transaction. Verified by probe
  (`nested-local applyUpdate leaves stale marker snapshots` — defended, plus a
  no-prior-markers control).
- Undo/redo marker clearing verified — format items resurrected by undo do not
  leave stale snapshots (`undo resurrects format items; markers cleared` —
  differential vs marker-disabled engine).
- Facade-level randomized differential replay (5 × 60-op schedules) compares
  semantic order/content, not bytes — placement ranks intentionally randomize
  (`Math.random` in `placement/model.ts`), so byte equality was an invalid
  probe invariant (corrected, see below).

Residual risk: marker seeding depends on anchor-linkage checks at insert; the
probes covered the documented anchor paths but not every possible delta shape.
Confidence high, coverage not exhaustive.

## R2 — IndexedDB refused-schema compaction: **PASS**

Challenged: admitted-vs-stored skew — could a foreign row be committed inside
the fetch window and deleted unfetched? Could refusal be bypassed by a second
instance, by concurrent `storeState`, or by destroy mid-flight?

Findings:

- The `getAll` → `getLastKey` interleave window is **structurally closed**:
  an injected foreign write on a second pre-opened connection commits outside
  the provider's readwrite transaction (IDB serializes same-store
  transactions). Observed: `wKey=4 _dbref=3 rowsAfter=2 wSurvives=true
docHasW=false` — the unfetched row survives; compaction does not subsume it.
- Refusal discovered _inside_ `storeState`'s own fetch blocks that same call
  (the check runs after the fetch).
- A refused doc still persists valid local writes, keeps hydrating valid peer
  rows, and never wedges: `[r2 probes]` refused-doc writes → 3+ rows, poison
  survives every compaction attempt.
- A second live instance on the same DB independently re-refuses and also
  never compacts.
- `destroy()` during an in-flight `storeState`: `storeErr=null`, store
  consistent, fresh provider hydrates cleanly (`whenSynced` resolves,
  `synced=true`). Two concurrent `storeState` calls on a clean doc leave all
  content intact.

Caveat (not a defect): `_hydrationRefused` is instance-scoped and permanent —
compaction stays blocked for the instance's lifetime even if the refusing rows
are later superseded. That is the intended fail-closed contract; note that any
_non-refusing_ provider on the same generation DB could still compact those
rows (the generation-scoped DB name makes a schema-incompatible co-tenant
unlikely).

## R3 — replicated undo-ownership repair: **FAIL**

The repair itself is correct **when it fires**: plain `um.undo()` restores
`tail='world'` with fresh replicated claims; reload, two-peer, merge-undo,
foreign-atom, and zero-record probes all pass (pinned 11 + 5 probe tests
green).

The gate does not fire in two reachable ways:

1. **Nested transaction** — `ed.transact(() => um.undo())` or
   `doc.transact(() => um.undo(), customOrigin)`: the UndoManager's internal
   transaction joins the outer one, so the committed transaction's `origin`
   is the outer origin and `tr.origin instanceof Y.UndoManager`
   (`edytor-doc.ts:570`) is false → the observer returns early, no repair
   claims are written, and the resurrected atoms own to the wrong block.
   Observed: `b="hello world"`, `tail=""` (expected `b="hello "`,
   `tail="world"`). Two RED probes pin this.
   `ed.transact` is a **public facade API** documented for batching ops into
   one undo step — nesting `um.undo()` inside it is a natural call shape, not
   an abuse.
2. **Undo after last facade dispose** — the module-level lease detaches the
   repair listener when the last facade on the doc disposes. A still-referenced
   UndoManager's `undo()` then produces the same broken state (`b="hello
world"`, `tail=""`), which **persists after a new facade attaches** —
   repair only fires on live `update` events, it is never reconciled
   retroactively. (Lease mechanics themselves are correct: re-created facades
   re-arm and repair new undos — verified.)

Semantic consequence: the unrepaired state is _committed and broadcast_ — it
replicates the wrong ownership to every peer, and subscribers see it as a
committed frame (see R5). This is precisely the class of corruption the repair
exists to prevent, reachable through the public API.

A correct fix likely needs the gate keyed on the transaction's **contents**
(e.g. detect undo-produced resurrection in `insertSet`/`deleteSet` rather than
the origin object) or a marker the UndoManager stamps regardless of nesting —
out of scope here (no production changes allowed).

## R4 — public snapshot isolation: **PASS-with-caveats**

The frozen/interned boundary holds for everything the JSON contract covers:

- Caller-held marks objects and array-valued marks cannot reach engine state
  post-write (write-side clone verified).
- Raw `Map` mark values normalize on read; mutating the caller's `Map` is
  inert.
- `__proto__` mark keys: local store and wire form agree (no divergence).
- `DocChange.content` runs arrays are deeply frozen (`Object.isFrozen` on
  runs and marks; mutation throws); `meta.data` and `added` subtrees are
  `cloneJson`/`protectItems` copies.
- `setBlockData` with cyclic input throws at write — clean refusal.

Confirmed defects/caveats:

- **D1 (availability, cross-replica):** a remote BigInt block `data` attr
  replicates fine (`writeAny` encodes BigInt) and then `cloneJson`/intern
  `JSON.stringify` throws `TypeError` on **every replica's read path**
  (`runs`/`blockDataOf`/snapshot surfaces). Any peer — or a malformed update —
  can permanently break reads for all replicas.
- **D2 (poison, local):** a local BigInt _mark_ writes successfully at the
  ynode layer but `ContentFormat.write` → `writeJSON` throws at commit/encode
  → the transaction's state is non-replicable and encoding the doc throws.
- **D3 (minor):** `DocChange.order` arrays are unfrozen and alias the
  retained `prev` snapshot (`edytor-doc.ts:1093` hands the snap array to
  subscribers). Vandalizing one perturbs the next commit's diff (verified:
  over-reports; a suppressed diff would require the caller to guess the
  upcoming order — contrived, but the aliasing is real).
- **D4 (surprise, not a leak):** `decorateRuns` deep-freezes caller-owned
  decoration `value` objects in place — mutation of caller data as a side
  effect (`callerValueFrozen=true threw=true`).

R4's repair scope — public payloads cannot mutate live state — holds. D1/D2
are boundary-validation defects this review surfaced; they are reachable
through replication/raw writes and documented here because the task required
challenging non-JSON payloads.

## R5 — commit-bound notifications: **PASS-with-caveats**

Mechanism verified: mid-transaction recompute is invisible to subscribers;
`pendingNotify` defers to commit; dedup suppresses change-then-revert; a
subscriber attached inside a transaction sees exactly one committed
notification (`['AXY']`); a listener performing a reentrant write does not
corrupt the flush (`seen=['A1'], b='BR'`).

Confirmed defects/caveats:

- **D5 (exception blast radius — RED probe):** `flushPending` clears
  `pendingNotify` _before_ the publish loop (`runs.ts:1073-1076`) and
  `publish` sets the `publishedRuns` watermark _before_ invoking listeners
  (`runs.ts:1033-1037`). A throwing listener on block A aborts the batch —
  block B's committed change is **never notified** (`seenB=[]` after the
  commit AND after a later unrelated commit — permanently stale until B next
  changes; the RED probe asserts `toContain('B2')`). Later listeners on the
  _same_ block skip that commit's state (`seen2` jumped `A!` → `A!?`).
  `callAll` (lib0 `function.js:17-27`) continues past a throw for
  engine-level fs callbacks, but the facade's own listener loop is a plain
  `for` — one bad subscriber starves the rest of the commit.
- **D6 (torn committed frame — joint with R3):** `doc._transaction` is nulled
  before cleanup (`Transaction.js:431`), so deep-observe `handleEvent` →
  `flushPending` publishes the _unrepaired_ post-undo state; the repair
  listener runs later on the `update` event (`Transaction.js:320`) and writes
  a follow-up transaction. Observed on `subscribeBlock`:
  `seenB=["hello world","hello "]` — the wrong-ownership state is delivered
  as a committed notification. The `onChange`/DocChange surface shows the
  same tear: `#0 origin=UndoManager content={b:"hello world"}` then
  `#1 origin=Symbol(edytor.undo-ownership-repair) content={tail:"world",
b:"hello "}`. Any consumer mirroring committed notifications renders the
  resurrected text inside the wrong block for one frame.

Both are real; D5 is an R5 mechanism defect, D6 is the observable surface of
R3's two-transaction design.

## R6 — strict oracle / fault injection: **FAIL**

The pinned R6a/R6b faults (unrequested delete, unrequested merge inside
`setMark`) are now caught, and the positive control confirms the envelope is
not vacuous (an extra `undo` injected inside `setMark` → `unrequested-effect`
→ `ok=false`).

But the envelope authorizes the wrong things in three demonstrated ways — all
four probes RED with the attack confirmed to have landed:

- **R6v — mark values are unauthenticated.** The `setMark` envelope is
  `Map<atomKey, Set<keyName>>` (`runner.ts:1008-1012`): it authorizes _which
  keys_ may change, never _what value_. `setMark(b=true)` answered with
  `b='CORRUPTED'` → `ok=true`, verdict `present`. The `markLedger`
  (`runner.ts:647`) that would catch this is **write-only** — filled at
  744-748, read nowhere; worse, it records the adapter's actual (corrupt)
  value as authorized. The `mutated-edit` class documented at `runner.ts:66`
  is never emitted by any code path.
- **R6o — insert position is unauthenticated.** `atomsIn` bounds
  `{texts, count}` only (`runner.ts:933`). `insertText` at offset 3 instead
  of the scheduled 1 → `ok=true`, both tags `present`. The oracle has no
  reference model, so same-text wrong-position writes are inherently
  invisible — a real "stale-view intent" hole.
- **R6f — false-return foreign writes are unauthenticated.** `after` skips
  tag recording when the op returns falsy (`runner.ts:948`), and
  `captureOpState` diffs only the executing peer. An adapter writing
  `'µFW'` onto a _different_ peer's doc then returning `false` →
  `ok=true`, `verdicts={}`, `foreignLanded=true` — the unrequested write
  converged on every replica at the barrier and no oracle ever looked at it.
- **R6s — a post-commit injected `undo` that reverts the just-applied
  `setMark` is invisible** (reverting the authorized key on authorized atoms
  diffs within the key-set envelope). `ok=true`; the mark simply never
  happened, undetected.
- **Dead oracle facts:** `recordedTombstones` (`runner.ts:641`, written at 718) is likewise never consulted — the barrier's `found.deleted →
'tombstoned' → deleted-legit` path authorizes every tombstone; protection
  currently rests entirely on the op-time envelope. And `intentViolations`
  is dropped from both the success and the violations return shapes
  (`runner.ts:1643-1664`) — populated only on `aborted`, so the causal detail
  is unavailable precisely when a seed fails at the barrier.

Net: the hardened oracle still cannot distinguish several classes of
schedule-unauthorized semantic corruption. R6b-class structural attacks are
closed; value-, position-, and failure-channel attacks are open.

## Bonus — module-level undo-repair lease: **PASS-with-caveats**

`undoRepairLeases` (`edytor-doc.ts:483`) verified: first facade installs one
listener, N facades share it, `dispose` is idempotent, last dispose detaches,
re-created facade re-arms and repairs correctly. The caveat is the post-dispose
window recorded under R3 — an undo that lands while no facade leases the
listener produces permanently unrepaired state. That is a consequence of the
repair's event-driven design, not a lease-accounting bug.

## Bonus — deterministic rehome rank: **PASS**

Pinned `u5-min-rank-rehome` 5/5 green. Stress: 15 seeded blocks all rehomed
through candidate-less moves plus 10 index-0 inserts → identical order on a
synced replica, no duplicates (`n=25`).

---

## Probe corrections (evidence hygiene)

- **R1 differential replay** initially asserted byte-identical stores across
  independent runs — invalid: placement ranks mint `Math.random` tie-breakers
  in production. Corrected to semantic order/content comparison.
- **R1 anchor round-trips** initially demanded anchors for hidden/merged
  blocks — relaxed to the model's visibility semantics.
- **R2 interleave probe** initially injected asynchronously and missed the
  transaction window; corrected to a pre-opened synchronous connection — the
  window turned out to be closed by IDB serialization (recorded as a defense,
  not a defect).
- **R6o** initially used `tag ≠ text` so the oracle's substring atom location
  could never find the atoms (false `lost-edit`); corrected to `tag === text`.
- **R6c control** initially injected `undo` _after_ `setMark` — it popped the
  setMark's own just-pushed stack item (a no-op-ish revert). Corrected to
  inject _before_ the mark (pops the older insert item → tombstones → caught).
  The original shape was kept as probe R6s — it demonstrates the revert-the-
  request hole.
- **R4 BigInt snapshot probe** — the raw `t.insert` throws at write, so the
  snapshot/crash path is unreachable via that vector; the reachable vectors
  (remote attr, local mark-then-commit) are the two pinned defects.

## Unverified / residual areas

- R1: marker seeding over every possible delta shape is not exhaustive —
  probes covered retain/insert/format boundaries, deletes through spans,
  undo/redo, remote integration, and randomized facade schedules.
- R3: whether the nested-transaction hole also affects `redo`-of-resurrecting-
  ops (a redo that resurrects content) — the probed nested redo re-deleted
  correctly; a redo that resurrects after intervening ops was not exercised.
- R4: `Proxy`-valued marks and `Date` values through the raw engine path;
  `snapshot()`/`contentJSON()` crash surface is inferred (same `JSON.stringify`
  interner) since the BigInt write itself throws.
- R6: net-op delivery is harness-owned (`peer-set.ts` `deliver`/`syncPeer` use
  `Y.applyUpdate` directly) — adapters cannot inject there; the `Peer.reload`/
  `persist` surface was not adversarially probed.
- No browser-lane or multi-client provider testing was in this review's scope.

## Required follow-ups (for the author, not this review)

1. R3: re-key the repair trigger off transaction contents (resurrection in
   `insertSet`), not `origin instanceof Y.UndoManager` — or have UndoManager
   stamp an origin marker that survives outer-transaction joining; reconcile
   ownership on facade attach for state committed while unleased.
2. R5: isolate listener exceptions in `publish`/`flushPending` (per-listener
   try/catch or rethrow-after-batch) and clear `pendingNotify` entries only
   after their publish completes.
3. R4: reject non-JSON mark/attr values at the facade write boundary
   (`sanitizeWireJson` already has the violation walker — escalate dev-warn to
   refuse) and make the interner total (safe fallback) so a hostile replica
   cannot crash reads.
4. R6: make `markLedger`/`recordedTombstones` load-bearing at the barrier
   (emit `mutated-edit`, gate `deleted-legit` on recorded tombstones), add a
   positional/content check or reference-model comparison for inserts, and
   treat falsy-returning ops' foreign-peer effects as violations — plus return
   `intentViolations` on all result paths.
