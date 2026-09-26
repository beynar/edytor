# CRDT v14 — Gate F1 Review (follow-up WU1–WU4)

Adversarial review of the CRDT v14 follow-up work units on `feat/crdt-v14-engine`
before WU5 (measured performance work) begins. Everything below was verified by
running code — no claim was taken from the ledger or prior gate reviews without
reproduction. No production files were edited; the only additions are the
real-defect probes under `src/tests/crdt/gateF1/`.

Review surface, per the follow-up prompt:

- **WU1** ownership soundness (concurrent splits, left-edge inserts, fragmented
  coverage, segment-boundary inserts, revive anchoring, concurrent tail
  deletion, `DEAD` serialization/control-flow safety)
- **WU2** typed nodes (compat removal, fake adapters, duplicated algorithms,
  multi-backing seams, read-your-writes, semantic mirrors, preserve regressions)
- **WU3a** strict-oracle honesty (can real loss be mislabeled
  `convergent-loss`; pending-state justification; all-replica checks; crash /
  permanent-loss injection)
- **WU3b** staging (full-state staging cost at scale, unsupported schema/state
  handling, first-contact SyncStep2, fast paths)
- **WU4** integration proof (BroadcastChannel isolation with `disableBc`,
  relay-transport honesty, packed-consumer mount/edit, permutation/duplication)
- **Cross-cutting** (console leftovers, new suppressions, weakened tests,
  `DocChange` completeness, skips/TODOs)

---

## Ranked findings

### F1 — CONFIRMED production defect: `alreadyCovered` skips the revive record for a _losing_ end-record; typed text lands in a different block

**Severity: high — user-visible semantic corruption, convergent, single replica,
reachable through legal ops only.** This is a real defect in
`src/lib/crdt/text/model.ts`, not a test artifact.

The empty-display revive path in `insertIntoText` decides whether to write a
revive slice record like this (`text/model.ts:685-691`):

```ts
const alreadyCovered = rec.entries.some((e) => {
	if (!isSliceRecord(e.payload)) return false;
	const p = e.payload;
	if (p.t !== b || p.e.a !== 0 || p.e.i !== null) return false;
	const r = own.resolvedRange(e, ownText);
	return r !== null && r[0] <= tLen;
});
```

It verifies that a record on the block's own slices list **covers** the
end-of-text insert point — coverage _existence_. It never checks coverage
_winning_. An end-sentinel (`e:END`) record that covers the append point but
**loses** the ownership race to a higher-generation rival record satisfies the
check, the revive record is skipped (`text/model.ts:702-713`), and the appended
atoms are claimed by the rival block. The characters the user typed into block
`v` appear in block `thief` — deterministically, on every replica.

**Reproduction** (`src/tests/crdt/gateF1/wu1-ownership.test.ts`, probe 1 — the
two `it.fails` assertions are the defect):

```ts
ops.mergeBlocks(A, 'v', 'c'); // c claims v's list; c displays 'abc'
ops.splitBlock(A, 'c', 1, 'thief'); // thief materializes 'bc' as {t:v,s:'b',e:END,g1}
ops.deleteBlock(A, 'c'); // claim inert; v unhidden, displays 'a'
ops.deleteText(A, 'v', 0, 1); // 'a' tombstoned; thief's {…,END,g1} now
// covers all of T_v and wins (g1 > g0)
// → v is a LIVE block displaying ''
ops.insertText(A, 'v', 0, 'X'); // alreadyCovered: v's own {B,E,g0} record
// covers the end → revive skipped →
// 'X' appended at T_v[2], thief wins it
// text(A,'v') === ''     — v stays empty   (expected 'X')
// text(A,'thief') === 'bcX'               (expected 'bc')
```

Second variant in the same file shows two consecutive inserts (`X`, `Y`) both
stolen: `v === ''`, `thief === 'bcXY'`. Convergence still holds — the steal is
deterministic — so `assertConverged`/`assertAllStructurallyValid` do not fire;
the corruption is _semantically_ wrong while _convergently_ consistent.

User-level reachability: merge a paragraph into the next (Backspace at start),
split the merged block mid-content (Enter), delete that block, delete the
original's remaining text, then type into the emptied original. That is an
ordinary editing sequence.

**Fix direction.** `alreadyCovered` must ask "does a record on `b`'s list _win_
the appended range", not "does one cover it". The appended atoms occupy
`[tLen, tLen+len)` and are claimed by the best `(g, resolved-start, stamp)`
record covering that range across **all** holders. The minimal correct check:
determine the ownership winner at the append position (equivalently, whether
`b`'s end-record is the highest-priority record covering `[tLen, ∞)`); if the
winner is not `b`, write the revive record anyway — its
`{s:anchorAt(tLen), e:END, g:maxG+1}` shape already deterministically wins the
appended atoms without touching the rival's owned range. Alternatively, drop
the `alreadyCovered` skip entirely and always write the revive record (cost:
one extra record per revive — bounded, and the double-display hazard the skip
was avoiding needs to be re-examined: two _winning_ records for `b` at the same
range would be needed to double-display, and a losing record cannot).

### F2 — WU3b staging cost is ~300× a direct apply; every inbound remote update pays it

**Severity: high for the performance phase — this IS the workload WU5 exists
to fix; it is also the single largest measured cost in the collab path.**

Measured (`src/tests/crdt/gateF1/wu3b-staging.test.ts`, three runs —
301×, 305×, 312×):

```
live doc: 1,000 blocks, full-state encode = 306,840 bytes
100 incoming updates × ~35 B each (keystroke-sized)
applyUpdateStaged:  ~1,745 ms total → 17.45 ms/update
                    (scratch-build+apply ≈ 8.9 ms of it)
direct applyUpdate:    ~5.7 ms total → 0.057 ms/update
overhead: ~305×
```

Every inbound `SyncStep2` **and** every incremental `Update` is routed through
`applyUpdateStaged` on **both** providers — `websocket.ts:168-183`,
`indexeddb.ts:532-552`. Each call performs
`new Y.Doc() + encodeStateAsUpdate(live) + applyUpdate(scratch) + checkSchema`
(`protocols/sync.ts:110-140`). There is **no fast path**: a remote keystroke on
a 1,000-block document blocks the main thread ~17 ms per update _per remote
peer_, and the cost scales with live-document size (the dominant term is
encoding the live state into the scratch doc). A 100-update remote burst ≈
1.7 s of staging work; on a 10k-block document this extrapolates to ~170 ms
per remote keystroke — unusable.

The design rationale in the comment is correct for BroadcastChannel
(connectionless → every update must self-validate), and the ws provider
reuses it (a peer can send a schema-breaking update mid-session). But most
updates can never change the schema verdict: `checkSchema` reads `meta.v` and
registry emptiness, so only an update that **writes the `meta` root item**
(or deletes under it) can move the merged state to unsupported/unversioned.

**Fix direction (WU5 work item, not a blocker):** cheap-decode the update's
struct parents — if no struct integrates into or deletes under the `meta`
item, the merged verdict equals the live verdict; apply directly (optionally
re-`checkSchema` the live doc after, which is microseconds). Stage only
meta-touching updates — first-contact `SyncStep2` stays staged regardless.
This preserves refuse-before-mutate exactly where it is needed and removes
~99% of the measured cost for ordinary editing traffic.

### F3 — WU3a: the strict oracle cannot see an ownership-steal — `moved` is unconditional legit evidence

**Severity: medium — test-harness honesty gap; the exact class of defect
found in F1 is invisible to the corpus.**

`classifyTagAtoms` (`src/tests/crdt/harness/ops/model-ops.ts:200-221`) reports
an atom displaying under a different _visible_ owner as `{ kind: 'moved' }`.
The runner maps `has('moved')` → `moved-edit` (`runner.ts:644`), which sits in
the strict adapter's legit-evidence set (`runner.ts:110-112`). The oracle
verifies atom **survival**, not atom **ownership**.

Concrete proof (`src/tests/crdt/gateF1/wu3a-oracle.test.ts`, probe A): the
confirmed F1 steal reproduces, the stolen `X` atoms classify
`moved → owner: 'thief'`, and `expectedViolations(ops)` contains
`moved-edit` but not `lost-edit`. In the corpus this defect is recorded as
routine evidence — `moved-edit` fired 141 times across the green 150-seed
run; a steal would be entry #142.

**Fix direction:** the runner knows which structural ops were scheduled. A
`moved` verdict whose owner-change has no corresponding scheduled
move/split/merge touching that block is unexplained — flag it (new
`stolen-edit` hard class) rather than folding into `moved-edit`. Cheaper
version: a `moved` atom whose _display parentage_ of owner-vs-target is
unrelated to any scheduled op is suspicious.

### F4 — WU3a: `sawLoss` is a run-global flag — it excuses ANY hard-everywhere atom, uncorrelated to what was actually destroyed

**Severity: medium — test-harness honesty gap; real `uncovered`/`gone` defects
inside a lossy run are mislabeled `convergent-loss`.**

`runner.ts:276-277` sets `sawPendingDrop`/`sawStateRegression` when **any**
scheduled `reloadSnap`/`reloadLog` drops pending items or regresses a state
vector; `sawLoss` at `:477` is their disjunction — one bit for the whole run.
The verdict at `:631-643` then classifies any atom that is hard
(`uncovered`/`gone`/`unreachable`) on **every** replica as `convergent-loss`
whenever `sawLoss || hasDestroyedPendingDeps(peers, sawLoss)` — and
`hasDestroyedPendingDeps` (`:172-192`) itself just returns `sawLoss` when
pending residue exists. The same flag folds `resurrected-delete` into
`convergent-loss` (`:584`).

A real ownership/coverage defect that leaves an atom uncovered on all replicas
inside a run that merely _contains_ a lossy reload is therefore recorded as
legit evidence. Pinned by probe B in `wu3a-oracle.test.ts` (static assertion on
the exact branch so a silent refactor surfaces).

This is a genuine epistemic limit, not sloppiness: post-hoc, an atom whose
covering record was dropped in transit is indistinguishable from one whose
record was never written — **unless** correlated per-update (a covering record
written in the same update as a surviving atom cannot have been selectively
dropped).

**Fix direction:** correlate the loss events with the updates they destroyed —
e.g. record which client-clocks each lossy reload regressed, and only excuse
hard fates whose covering write falls in a destroyed clock range; or treat
same-update atom-survives-but-record-gone as `lost-edit` unconditionally.
Track as a follow-up; not a WU5 blocker.

### F5 — Schema boundary validates `meta.v` only; `meta.schema` (manifest name) is never compared

**Severity: low–medium — a real boundary gap with a narrow trigger.**

`checkSchema` (`edytor-doc.ts:230-237`) reads `meta.v` and registry emptiness
only. `init` writes `meta.schema = 'edytor-doc'` (`SCHEMA.name`), and the
manifest comment (`edytor-doc.ts:129`) says the pair tells a replica which
schema generation wrote the doc — but the name is never enforced. Probe
(`wu3b-staging.test.ts`): a doc with `meta.v = 1` + `meta.schema =
'not-edytor'` merges and applies through `applyUpdateStaged` —
`{applied: true, problem: null}`.

Trigger requires a foreign doc carrying our root names _and_ `meta.v = 1` —
realistically only a fork/renamed variant of this codebase — but the name
exists precisely to disambiguate same-version schemas, and the boundary is
documented as a schema gate, not a version gate.

**Fix direction:** `checkSchema` additionally returns a problem when
`meta.schema` is present and `!== SCHEMA_NAME` (absent = tolerate, for
forward/backward compat of the name field itself — decide deliberately).

### F6 — Facade stale-view caveat confirmed real (documented, unreachable from runtime code)

**Severity: informational.**

Inside one `doc.transact`, a facade read memoizes the view on `stateVersion`;
a **raw** engine write via the `d.model`/`d.text` escape hatches does not bump
the version, so a subsequent facade read in the same transaction serves the
stale view. Pinned by `wu2-nodes.test.ts` ("raw engine write between two
facade reads" → `len=3` vs actual 6). This matches the documented caveat on
`write()` in `edytor-doc.ts`. No runtime consumer hits it — every mutation in
`src/lib` routes through facade `write()` wrappers; the escape hatches are
used only by tests and the facade itself. Keep the caveat documented; consider
an assertion or a dev-mode warning if raw-write+same-tx-read ever becomes a
consumer pattern.

---

## Verified-clean areas

### WU1 — ownership soundness (except F1)

All probes in `src/tests/crdt/gateF1/wu1-ownership.test.ts` except the two
intentional F1 failures **pass**:

- **3 concurrent splits then left-edge insert** — peers split the same backing
  at 3/5/8 concurrently; the seam-preserving partition
  `[0,3)|[3,5)|[5,8)|[8,E)` survives, a left-edge insert into the middle block
  lands on the right owner, per-atom ownership row exact.
- **Left-edge insert into a 3-way fragmented record** — disjoint
  `[3,5)∪[7,8)∪[9,E)` coverage re-anchored per resolved seg; rival-owned holes
  (`fg`, `i`) preserved exactly — the WU1 per-seg rewrite works.
- **Concurrent left-edge inserts** on two replicas — both chars survive,
  converge.
- **Revive racing a concurrent tail deletion** — insert into the empty head +
  concurrent delete of the whole tail: convergent, the insert survives.
- **Boundary (non-interior) inserts at seg seams** — inserts at the seam
  between disjoint segs land left, never inside a rival's hole.

`DEAD` symbol: `Symbol('edytor.crdt.dead')`, a `unique symbol` — verified it is
compared by identity in model/runs/facade consumers, never serialized as a
block id, and a real block literally named `"dead"` is covered by
`src/tests/crdt/text/ownership-regression.test.ts` (text, children, anchors,
merges, deletion, undo, reload, continued editing — all pass as ordinary
blocks). Control-flow safe: `DEAD` is a sink marker, not an exit code.

### WU2 — typed nodes / compat removal

- `src/lib/crdt/compat.ts` is **deleted**; zero production references to
  `FACADE_MUTATORS`, `yRootBlock`, `.yText`, `.yBlock`, `.yChildren`,
  `.yContent`, fake `.doc`, `_docVersion` outside docs comments and the three
  engine-boundary internals (`text/model.ts`, `placement/model.ts`,
  `engine-api.ts`) that legitimately read `._item`.
- `src/lib/crdt/nodes.ts` `DocBlock`/`DocText`/`DocInline` **delegate** to the
  facade (`doc.insertText` → `M.insertText`…) — no duplicated algorithms.
- `src/tests/crdt/gateF1/wu2-nodes.test.ts` — 7/7 pass:
  - Multi-backing display (block merged over two claimed lists → 3 backing
    texts): `insertText` at every offset incl. exact seams and display end;
    `setMark` across the own→claim seam splits runs correctly; `splitBlock`
    at a multi-backing seam partitions ownership exactly; converged +
    structurally valid after sync.
  - Read-your-writes inside `doc.transact`: insert→length/text, split→sibling
    content, move→parent/path all observe the write (the `version`-token
    invalidation works).
- DOM suite: **142/142 green** (`vitest.dom.config`) — incl. `lifecycle-dom`
  (5: remount, destroy-once, observer settle), collaboration DOM (7),
  undo-redo/marks/beforeinput fixtures inside `dom.test.ts` (130) +
  `attachmentLifecycle` (2). Mirror/facade CRDT tests green (17/17).

### WU3b — correctness edges (cost is F2)

`wu3b-staging.test.ts` (4/4 pass):

- A refused update leaves the live doc **byte-identical** (state re-encoded
  and compared).
- Unsupported `meta.v` is refused `{applied:false, problem:{kind:'unsupported'}}`.
- First-contact `SyncStep2` carrying a full 1,000-block state applies through
  the staging path (1,001 children incl. bootstrap) — handshake works.
- `synced` on the ws provider only fires when the SyncStep2 payload was
  actually `applied` (`websocket.ts:198-205`) — no false synced on refusal.

### WU4 — integration proof honesty

- `tests/editor-dom/collaboration-websocket.spec.ts` — **6/6 chromium pass**
  (7.3 s): two independent browser contexts, `disableBc: true` forced at the
  route (`src/routes/test/dom/+page.svelte:410`), and the spec _proves_
  transport rather than assuming it: `relay.forwarded.length > 0` with every
  frame's byte-0 `=== 14` (v14 envelope), `relay.pendingCount(room) >= 2`
  while held (edits verifiably do NOT cross), then permuted + duplicated +
  delayed + dropped delivery converges with **content** assertions
  (`'PA>alpha'`, `'PB>gamma'`), awareness caret over the socket, undo inverse
  traveling the socket, WU1 ownership regressions over real TCP. The header
  honestly labels permute/duplicate as deliberate harness faults, not TCP
  claims.
- `tests/packed-consumer/run.sh` — **ALL PASSED**, re-run in this review:
  node runtime smoke; vite client build; SSR render of the readonly surface;
  **real chromium mount** — `waitForSelector` on editable+readonly roots,
  click into `[data-edytor-text]` + `keyboard.type('!')` through the real
  input path, `facade.insertText` through the programmatic path,
  `[data-edytor-mark="bold"]` plugin rendering, `contenteditable=false` +
  `aria-readonly` readonly surface, `unmount()` detaches, zero page errors;
  strict `tsc` under nodenext **and** bundler with `skipLibCheck:false`.
  Honest SKIP reporting if the browser binary is missing — a skipped mount is
  printed, never claimed.

### WU3a — what does work

- All replicas are consulted: hard fates on `peers[0]` are re-classified on
  `peers[1..]` and must be hard **everywhere** to escalate (`runner.ts:633-634`).
- `upstream-engine-crash` is legit only on the raw diagnostic adapter —
  strict adapters treat a crash as a hard failure (`runner.ts:130`).
- Loss injection is real: `reloadSnap`/`reloadLog` = stale-snapshot restore
  (permanent integrated-state loss) + pending drop; `drop`/partitions are
  transient. Crash detection via `ENGINE_INTERNAL_CRASH` stack frames; seeds
  86/140 repros persist as fixtures.
- Corpus `CRDT_ADAPTER=doc` re-run here: **162/162 green**,
  `convergent-loss×15, deleted-legit×150, moved-edit×141`, 0 violations.

### Cross-cutting

- `console.*` in the lib diff: only the two `console.error` calls in
  `protocols/sync.ts` mirroring upstream's error-visibility behavior
  (deliberate). Test-side `console.log` additions are the documented
  per-seed-verdict corpus report.
- No new `as never`/`as any`/`@ts-ignore`/`@ts-expect-error` in the lib diff;
  `as unknown as EngineDoc` casts are the pre-existing structural boundary
  pattern. `nodes.ts` itself is suppression-free.
- Test diffs are **strengthenings**, not weakenings: `compaction-schema`
  (v2-peer refusal signal + docA never leaves supported schema) and
  `envelope` (self-poisoned hydration refusal + `schema-mismatch` signal)
  assert more than the versions they replaced; gate1 tests updated only for
  the `DEAD` symbol.
- `DocChange` (`edytor-doc.ts:338-357`) is complete: origin, local, version,
  added (full subtrees), removed, moved, meta, content (maintained runs),
  order (new child lists) — matches the U06/U11 contract incl. the skeleton
  snapshot optimization.
- No new skips/TODOs/FIXMEs in the test diff.

---

## Honest limits of this review

- The F1 defect and all ownership probes run at the **model level**
  (`Y.Doc` + facade + harness peers) — per `AGENTS.md` the fixture harness
  does not model real browser selection; the user-visible manifestation is
  inferred from the converged document state, which is the same state the DOM
  renders.
- The staging numbers are single-machine, representative runs (~301×/~312×
  across three measurements); the **magnitude** is stable, the exact factor is
  not a spec.
- Re-run lanes: corpus `doc` adapter (162), gateF1 suite (20), DOM suite
  (142), mirror/facade (17), ws relay chromium (6), packed consumer (full).
  **Not** re-run: `model`/`raw` corpus adapters, the full `test:crdt` suite
  (~1,233 tests), firefox/webkit ws lanes, mobile projects.
- The F4 `sawLoss` masking is demonstrated by code-path analysis plus a
  static-branch pinning probe — not a full end-to-end lossy-run
  misclassification demo (constructing one requires injecting a real defect
  into the schedule DSL, which the DSL cannot express).
- F1's fix is described, not implemented — production edits were out of scope.

---

## Verdict

**Not yet green for WU5 — one correctness fix first.** _(superseded — see
the resolution section below; all findings are now resolved and the lanes
are green.)_

F1 is a confirmed, user-visible production defect reachable through ordinary
editing: text typed into an emptied block lands in a different block,
convergently, on every replica. It must be fixed before the "verified working
editor" claim the performance phase builds on can be made. The fix is small
and localized (the `alreadyCovered` check at `text/model.ts:685-691` —
verify winning, not existence).

Once F1 lands, WU5 may begin — and should treat **F2 as its first work item**:
the ~305× per-inbound-update staging cost is exactly the performance problem
this phase exists to measure and remove, with a concrete fast-path design
already sketched (stage only meta-touching updates).

F3/F4 (oracle blind spots) and F5 (schema-name gap) are tracked follow-ups,
not blockers: they weaken the safety net and the boundary's precision, not
the runtime's correctness. F6 is informational.

Evidence added this review (all untracked, `src/tests/crdt/gateF1/`):

- `wu1-ownership.test.ts` — 8 probes; the two F1 assertions are marked
  `it.fails` (the lane stays green while the defect is live and goes red the
  moment the fix lands).
- `wu2-nodes.test.ts` — 7 probes; all pass (multi-backing seams,
  read-your-writes, stale-view caveat pinned).
- `wu3a-oracle.test.ts` — 2 probes; pass, demonstrating F3/F4.
- `wu3b-staging.test.ts` — 4 probes; pass, measuring F2 + schema-name gap (F5).

---

## Resolution (2026-09-21) — all findings closed, lanes green

Every finding above is now resolved in the working tree. No git mutations.

### F1 — RESOLVED (engine fix, generalized beyond the reported shape)

Root cause: the insert paths trusted **coverage existence**, never
**coverage winning**. The empty-display revive path skipped its claim
record whenever _any_ record on the block's own list covered the append
point — including a losing one — so a rival's higher-generation claim
owned the typed atoms and displayed them under a different block.

Fix in `src/lib/crdt/text/model.ts`, one mechanism applied at every
insert boundary:

- `claimRoutesToB` (new, `model.ts:~654`) replays the exact
  `(g, resolved-start, stamp)` contest `computeOwnership` runs —
  `ClaimKey`/`claimKeyBetter` were extracted as the shared comparator —
  at the freshly inserted position with post-insert anchor resolution.
  No pre-existing record boundary can fall inside a new atom run (records
  only reference atoms that existed when they were written), so one
  point decides the whole run's owner.
- **Empty display** (`model.ts:~727`): the manual end-sentinel scan was
  replaced by `claimRoutesToB` — the revive record is written iff the
  append winner does not route to `b`.
- **Display-end append** (`model.ts:~862`): the previously bare
  `text.insert` at the last segment's right edge now checks
  `claimRoutesToB` and writes a `{insertAt, insertAt+n, g:maxG+1}` claim
  on `b`'s own list when a rival wins — appended last so display order
  stays append-last. This is the generalization the random corpus found:
  seed-20 typed at the end of a partially claimed block and the atoms
  were born inside the rival's split claim (`stolen:sp20-49` — a real
  steal the F3 oracle caught before the fix landed).
- **Left edge** (`model.ts:~785`): the `isB` shortcut is gone — even a
  begin-sentinel record can lose a contested prepend to a rival ending
  exactly at the insert point, so every left-edge insert now takes the
  existing per-seg record rewrite (`g = maxG+1`, claims the new atoms for
  the typed-into seg's holder).

`wu1-ownership.test.ts` runs 11 probes — the two `it.fails` markers are
removed and the suite covers rival-wins-partial/split coverage, revive
with a dead current owner, and inserts at a coverage seam. All pass.

### F3 — RESOLVED (`stolen` verdict)

`classifyTagAtoms` takes a `TagClassifyContext`: `insertOwners` (owners
that already claimed the atoms at insert time — the at-birth steal
signature; persists as `stolen` even when the owner is also in
`legitOwners`) and `legitOwners` (every split `newId`/merge `intoId` the
schedule recorded, PLUS the atoms' home block — the natural owner that
reclaims them when a claim dissolves — and the insert target). A visible
owner outside that set is `stolen` → `stolen-edit`, a hard violation on
every strict lane. Corpus validation: the first cut over-flagged
legitimate claim-dissolve reverts (seed-46); adding the home block to
`legitOwners` resolved the false positives while real steals (seed-20)
still fired — and disappeared once the F1 engine fix landed.

### F4 — RESOLVED (correlated loss)

`runner.ts` records `lostRanges` — the item-id ranges each lossy reload
actually destroyed (pending-struct + pending-deleteSet ranges captured
pre-reload, plus regressed state-vector tails) — and snapshots the
post-barrier stranded-pending residue as `strandedRanges`. A
hard-on-every-replica atom is `convergent-loss` only when its own id or
one of its coverage deps (`tagAtomDeps` — claim stamps of every covering
record, any holder) intersects either set. The run-global `sawLoss`
excuse is gone from the tag path; the WU3a injection probe proves a real
destroyed-by-reload loss stays `convergent-loss` while unrelated injected
`uncovered` fates stay `lost-edit`.

### F5 — RESOLVED (schema manifest enforced)

`checkSchema` (`edytor-doc.ts:243`) validates `meta.schema` alongside
`meta.v`: `kind:'foreign'` when the version is supported but the manifest
name is missing or different (`SCHEMA_NAME = 'edytor-doc'`). A bare
foreign manifest on an otherwise untouched doc is still a foreign claim.
`SchemaMismatchError` reports the observed name distinctly. The staging
boundary (`applyUpdateStaged`) and every outbound path inherit the check
unchanged; the WU3b foreign-schema probe now asserts refusal. Any future
staging fast path must keep `checkSchema` non-bypassable — refusal
semantics are part of the boundary contract, recorded in the ledger's
WU5 checklist.

### F2 — deferred to WU5 by design (checklist item recorded)

Staging is unchanged: every inbound update still merges into a scratch
doc, `checkSchema`s, then applies. Latest measurement on a 1,000-block
document: full-state encode 305,840B; 100 updates staged 1,858.4ms
(**18.58ms/update**) vs direct 5.5ms (0.055ms/update) — ~337× overhead,
consistent with the review's ~305–312× range. The ledger's WU5 checklist
carries the fast-path item (skip staging for updates that cannot touch
`meta`) with the explicit constraint that schema validation must stay
non-bypassable.

### F6 — verified, unchanged

The facade stale-view caveat (raw engine writes inside a transaction can
leave the memoized view stale until commit) remains documented at
`edytor-doc.ts:544-549` and pinned by `wu2-nodes.test.ts`.

### Final lanes (this run)

- `pnpm test:crdt` — **1,285 passed / 7 skipped / 0 failed** (49 files;
  corpus 470/470 across raw+model+doc — evidence only `moved-edit`,
  `deleted-legit`, `convergent-loss`; zero `stolen-edit`, zero `lost-edit`)
- `pnpm test` — **1,273 passed / 0 failed** (62 files; 1 skipped, 11 todo)
- `pnpm test:dom` — **142 passed / 0 failed** (3 files)
- `pnpm check` — **0 errors / 0 warnings**
- `pnpm lint` — **clean**

**Green for WU5.** The engine's ownership model now guarantees typed
atoms belong to the typed-into block at every insert boundary; the oracle
can tell a steal from a move; loss excuses are atom-correlated; the
schema boundary checks the manifest name. WU5 should open with the F2
staging fast path under the non-bypassable-schema constraint.
