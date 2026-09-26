# Adversarial review of plan-v1 — lens: CRDT constraints (vendored Yjs v14)

Status: complete (F1–F13 + summary).

Scope: what the vendored engine (`src/lib/crdt/vendor/yjs/src`, rc.26 + P1/P4/P5/P6) and CRDT semantics actually
permit, checked against plan-v1's rules R1–R13, the deletion ledger and the falsification table. Every claim below
was executed against the vendored engine; probe scripts live in
`scratchpad/arch/crdt-attack-probes/*.mjs` (run with `node <file>`; no repo file was modified).

Method notes (what the guarantee is, independent of today's classes):
- G-undo-owner: undo of a text delete puts the text back where the deleting user saw it, on every replica.
- G-undo-intent: one user action is one undo step; undo restores the document state before that action.
- G-redo: redo is available after undo until a new local edit.
- G-seed: opening a document never duplicates or erases content, for any timing of provider replies.
- G-contain: an incompatible write never spreads to replicas that did not produce it.

Claims that checked out and are NOT attacked (so the reader knows they were tested):
- V2 base mechanics: `minimizeFormatChanges` (ynode.js:285-297) passes zero-length tombstones and equal format items;
  `redoItem` places the copy between `item.left` and `item` (UndoManager.js:457-459, 523). Reproduced.
- Boundary + nonce survive undo/redo of a split: redo re-creates the registry node's attrs (including `n`) from the
  redo stack's `deletes` (parent node first, UndoManager.js:443-451), and the boundary copy carries `{s, n}` because redo copies content (:523).
- Anchor rule 1 / F-D15 under boundaries: a left-affine caret at a split-born block start binds the boundary item
  (RelativePosition.js:155-186) and resolves after it (:313); history-independent in both shapes. Reproduced by reading.
- Typing at stream edges with formatted boundaries lands in the right stream (insertContent nulls unspecified
  current formats, ynode.js:340-363; the walk stops at the live boundary).

---

## F1 — BLOCKER — The boundary-format rule does not make R16 hold: a three-peer delete ‖ format race sends undone text into the new block

Plan refs: §1.2 R2 ("a split inserts one boundary carrying the formats of the first live character at the split
point"), §2.1 "Split" and "Undo of a text delete", Step 2 V2 ("Confirmed, with a condition"), §1.3 row 3, L5
(272 xloc undo repair deleted), F-U4a–c, CP10 abandon criterion, K1.

Scenario (probe `a5-concurrent-format-min.mjs`, 3 peers, deterministic for every client-id order tried):
1. Backing text `"hello " {s:t} "world tail"`; the tail stream `t` shows `world tail`.
2. A deletes `world` (tracked). Concurrently B bolds `world`.
3. C receives A's delete first, then B's format. The engine does not remove redundant formats on receipt of a format:
   the receiver runs `cleanupYTextFormatting` (probe `why-no-cleanup.mjs` shows the follow-up local transaction) but
   each gap scan starts at the previous content item and exits at once (Transaction.js:184-199,
   transaction-helpers.js:364-378; `remote-format-cleanup4.mjs`: 4 live format items stay after two concurrent
   identical bolds). Only the delete-receipt path (`cleanupContextlessFormattingGap`) prunes, and only when the format
   is already present. So C's deletion gap still holds live `[bold:true] … [bold:null]` around the tombstones.
4. C splits `t` at display offset 0. Per the plan's rule the boundary carries the formats of the first live
   character, `' '` of ` tail` = `{}` → `insertContent` turns that into `{bold:null}` and `minimizeFormatChanges`
   stops at the live `[bold:true]` (value ≠ null). The boundary `{s:u}` lands **before** the tombstones.
5. A undoes. `redoItem` puts each copy between the tombstone's current left neighbour and the tombstone — after the
   new boundary.

Result on all replicas: `["hello ",[{s:t},{s:u}],"world tail"]` — `t` is empty and `world` is in `u`. R16 violated,
converged, one update. With arrival order B-then-A at C the gap is cleaned by the contextless cleanup and the text
returns to `t`, so the outcome depends on delivery order, not on anything the splitter chose.

Why the rule cannot be patched by choosing other formats: the walk passes a live format item only if the requested
value for its key equals the item's value. Two live same-key items with different values before the last tombstone
(e.g. B bolds `wo` and D bolds `rld` concurrently with the delete: `[b:t] w o [b:null] [b:t] r l d [b:null]`) cannot
both be passed by any single format map, so the public `insert` cannot put the boundary after the tombstone run.
The crdt reader already said "choosing 'after the tombstones' needs an insert-after-item primitive the public API
does not expose" (reader-crdt-core A-5); the judge's `{formats of first live char}` rule covers only the
single-writer shapes F-U4a–c.

Why the plan's gates would not catch it: F-U4a–c are two-peer, sequential shapes; F-D13's properties (a)–(d) do not
include R16 (undo returns text to its pre-delete displayer); the abandon criterion fires only on F-U4a–c or F-D13.
The repair it would replace (redone-space contest) is indifferent to format items, so this is a regression hidden
behind a deleted mechanism.

Repair: (1) make the split normalize its gap inside the same transaction — delete the live format items between the
split point and the last tombstone that the engine's own `cleanupFormattingGap` would delete (non-last per key), then
insert the boundary with the values of the surviving items (cheap, but the undone text then loses the concurrent
formats whose items were removed); or (2) add a vendor patch "insert after this item" (recorded in UPSTREAM.md)
and place the boundary after the tombstone run explicitly (keeps concurrent formats). Either way add F-U4e (this
probe, both arrival orders, 2 formatters) and make "undo returns text to its pre-delete displayer" a property of the
F-D13 corpus with a concurrent-format generator. Until then V2 is "confirmed for single-writer gaps only" and L5
cannot be booked.

## F2 — MAJOR — R3's "tombstone the content items … for storage only" is not storage-only: it breaks the pinned split rescue (ST02a) and turns undo-of-delete into copy-resurrection that loses offline edits

Plan refs: §2.1 "Delete `b`" (second bullet: "tombstone the content items (never the boundary items) of those streams.
This is for storage only … Undo re-integrates those items in place"), R3, O6, L9 ("view-side tombstoning … → 0",
generalized to every path), CP1 (delete with claims), CP10 spike contract (ST01–ST03 listed), D9 (copy-on-move
named as the bug class to avoid).

Why it exists today: the view's `removeBlock` tombstones the displayed parts first because under slice records
"atoms released inside a neighbour's covering slice claim … would otherwise re-surface there"
(block/block.utils.ts:291-297). Under R2 that leak cannot happen — a dead block's stream is hidden by its `del` —
so the tombstoning has no correctness job left, and it has two costs the plan does not list.

1. It breaks ST02a on every path. `src/tests/crdt/scenarios/active-text.ts:647-665` pins "delete source vs split —
   the sibling rescues its claimed tail": A `deleteBlock('b1')` ‖ B `splitBlock('b1', 6, 's1')` ⇒ `text(s1) ===
   'world'`, both delivery orders and reload (headless `ops`, so green today). Probe `st02a-delete-tombstone.mjs`:
   with the plan's delete (set `del` + tombstone the stream) `s1` shows `""` for both client orders; without the
   tombstoning it shows `world`. The concurrent split inserts `{s:s1}` inside the stream A tombstoned, so the rescued
   block is alive but empty.
2. It makes undo of a block delete a copy operation. Undo cannot un-delete items; it integrates *copies*
   (`redoItem`, UndoManager.js:523), so an offline peer's concurrent edits to that text land on the dead originals.
   Probe `delete-tombstone-undo-offline.mjs`: A deletes block `b` ("hello world") and undoes; offline P deletes
   `world` and bolds `hello`; after sync `b` reads `hello world` with no bold — P's delete is resurrected and P's
   format is lost (the `resurrected-delete` / `lost-edit` classes D9 names). Without the tombstoning the undo only
   flips `del` back and `b` reads **hello** + ` ` as P intended. It also makes undoing a large block delete cost
   O(content) wire bytes instead of one attribute item, and it exposes the copies to F1.

Repair: delete = set `del` on the block and on the blocks it displays (that part of R3 is right and fixes X1); do not
tombstone content. Dead text then stays live, which is the honest price: reclaiming it safely needs a causal
stability signal (every replica has seen the delete) that an opaque relay does not provide. Keep ST02a in the CP1
contract, and add F-D17: "delete `b`, undo, while an offline peer deletes/formats inside `b`; the peer's edits
survive".

## F3 — MAJOR — Composition previews that "bypass undo" make undo after IME resurrect the preview or undo the wrong step

Plan refs: R8 ("preview writes are mechanical: they bypass hooks and are never an undo step"), §2.4 category table
("Replicated composition previews … mechanical writes that bypass hooks and undo"), L7, D-6, D-7, D32, K4, CP6.

Engine fact: `popStackItem` redoes every item in the stack item's `deletes` unless it is also in the same stack
item's `inserts` (UndoManager.js:84-93, "Never redo structs in stackItem.insertions because they were created and
deleted in the same capture interval"). If previews are written under an untracked origin, the commit that "replaces
exactly the preview" records the preview items as deletions but not as insertions.

Probe `composition-undo2.mjs` (`Hello` typed, then a composition, then one undo):

| composition | commit as the plan states it | after one undo | expected |
|---|---|---|---|
| `n → に → … → にほん`, final `日本` | replace preview (one tracked command) | `Helloにほん` (preview resurrected) | `Hello` |
| `ㅎ → 하 → 한`, final `한` | replace preview with equal text | `Hello한` (nothing visibly undone) | `Hello` |
| same | commit is a no-op because final == preview | `한` (undid the *previous* step, `Hello`) | `Hello` |

With previews tracked and merged by `captureTimeout` (today's behavior) the same undo gives `Hello`. No existing
test pins "undo right after a committed composition"; only the DST history oracle (`expectedHistorySemantic`,
tests/editor-dst/runner.ts:1465-1491) could catch it, and only when a synthetic composition is followed by undo.

The engine-correct designs each break another plan rule: (a) previews tracked and merged into the commit's stack item
(contradicts "never an undo step"); (b) commit = untracked delete of the preview + tracked insert of the final text
(contradicts R7 "exactly one transaction"; peers see a transient gap); (c) add the preview ids to the stack item's
`inserts` in `stack-item-added/updated` (edits engine-internal stack state). Repair: pick (a) and state it: the
dispatcher opens a capture window at compositionstart (`stopCapturing()`), previews are tracked under the view
origin, the window is held open by refreshing `um.lastChange` before each preview write (a plain public field;
`captureTimeout` alone splits a composition with a >500 ms pause into several steps), and cancel is a tracked delete
inside the same window (so the window collapses to no net change and is skipped by `popStackItem`). Add F-I15: "compose `にほん` → `日本`, undo ⇒ pre-composition text; redo ⇒ `日本`",
plus the equal-text and cancel variants.

## F4 — MAJOR — History cannot run as a dispatcher command: any enclosing transaction or tracked post-undo write kills redo

Plan refs: R7 ("It then runs exactly one transaction, applies the undo-step policy"), §4.3 `session/commands.ts`
("one transaction → normalization once per touched parent → undo policy"), `session/history.ts`, CP4, F-U1/F-U6,
F-U3 ("exactly one wire update per undo … with lineage on and off"), O19 (lineage capture from the touched set).

Engine facts (probes `nested-undo.mjs`, `nested-undo-untracked.mjs`):
- The redo stack is filled only by `afterTransactionHandler` while `um.undoing` is true
  (UndoManager.js:207-217). `undo()` sets and clears that flag around `popStackItem` (:337-345), whose inner
  `transact` joins any enclosing transaction. So `doc.transact(() => um.undo(), viewOrigin)` commits after the flag
  is cleared: the undo is recorded as a new *undo* item and the redo stack is cleared. Measured: after the wrapped
  undo, undo=2/redo=0 and `redo()` returns null; with an untracked or UndoManager origin the redo stack stays empty
  too.
- Any tracked write after an undo (e.g. the dispatcher's "normalization once per touched parent") runs the
  "neither undoing nor redoing: delete redoStack" branch (:220-223). Measured: redo stack 1 → 0.
- A lineage capture "inside the undo's own transaction" (the crdt reader's C13 fix, needed for F-U3 with lineage on)
  cannot be done by wrapping either. It works only from a `beforeTransaction` listener that checks
  `um.undoing || um.redoing` (probe `lineage-in-undo.mjs`: 1 update, redo intact) — a mechanism the plan never names.
- Fold-derived attribution (R6 "attribution … derive from one fold") must exclude undo/redo transactions or it
  overwrites the `l` item that undo just restored (R25 "last changer restored by undo", attribution/block.ts:19-25).

Today's code is safe only because `historyUndo` calls `document.history.undo()` bare (edytor.svelte.ts:446-458).

Repair: make history a named exception to R7: the dispatcher does permission + selection bookkeeping around a bare
`um.undo()/redo()`, never opens a transaction, never normalizes afterwards under a tracked origin (normalization after
history, if needed, runs untracked and is documented as not undoable), and lineage capture hangs off
`beforeTransaction` + `um.undoing`. Add F-U9: "undo/redo through every channel keeps redo available; a normalizer that
fires after undo does not clear the redo stack".

## F5 — MAJOR — "Seed only under fresh ids" duplicates any non-empty initial value; D-3 understates the cost as one empty paragraph

Plan refs: R13 ("… and only under fresh ids"), O17, L56, D-3 ("Two concurrent seeders may leave one extra empty
paragraph"), F-T4, F-T6.

CRDT fact: concurrent creators converge only through equal keys (registry map-attr LWW, E2) — fresh ids can never
dedupe. Today's documented contract is "concurrent inits with identical ids dedupe the same way, different ids
union" (edytor-doc.ts:40-44; `document.sync` keeps caller ids: document.ts:636-640; `jsonBlockToSpec(block, false)`
json.ts:349-355).

Scenario: an app passes the same template `value` (with ids) to every client of a new room. Two clients open it
within the settle bound, or one client's bound elapses before a slow Step2 arrives. Under R13 both seed the whole
template under fresh ids → the room holds the template twice (N seeders → N copies). F-T4 ("nothing duplicated") is
only exercised with the room reply arriving inside the settle window; F-T6 uses an empty value.

This is a real trade-off, not a bug to wish away: equal ids risk overwrite (P4b/P4c), fresh ids risk duplication.
Probe `deterministic-seed.mjs` measures the three seed strategies on two peers (concurrent seeds; and a late seed
arriving after the room's first block was edited):

| seed strategy | concurrent seeds | late seed after an edit |
|---|---|---|
| fresh ids (plan R13) | template twice (`p1-1, p1-3, p2-2, p2-4`) | template twice, edit kept on one copy |
| caller ids (today) | one copy | **edit erased** (`p1:Title` — the higher client id's node wins the map LWW; here the late seeder's) |
| deterministic seed update (fixed seed clientID, deterministic ids/nonces/ranks, applied with `applyUpdate`) | one copy | one copy, **edit kept** (the seed items already exist, so the late apply is a no-op) |

So the plan trades today's erasure risk (P4b/P4c) for a duplication risk that is worse for every non-empty value,
while an item-level idempotent seed removes both for identical seeds. Repair: build the seed in a scratch doc under a
reserved writer clientID with deterministic ids, nonces (`n`) and ranks (the `rand.ts` seam), and integrate it with
`applyUpdate` (non-local, so never an undo step); only then apply "seed only after settle-or-bound". State D-3 as
"identical seeds are idempotent; different seeds union". Add F-T11 (two clients, same non-empty value, both
orders, reply after the bound) and F-T12 (late identical seed after an edit keeps the edit).

## F6 — MINOR — D-17's proposed answer for F-U4d is not what the engine produces; enforcing it needs a repair write

Plan refs: F-U4d ("proposed: the block B's split assigned it to, `u`"), D-17, CP10 abandon criterion ("the spike needs
any repair write").

Probe `f-u4d.mjs`: A deletes `world`; B (not yet having the delete) splits the tail at 0, before the still-live `w`;
A undoes before receiving the split. The undo copy and B's boundary have the same origin and the same right origin,
so YATA orders them by client id. Measured: clientA < clientB → `world` in `t`; clientA > clientB → `world` in `u`
(identical with and without marks). No formats choice changes that; only a follow-up write could. So D-17 as
proposed re-introduces the kind of repair the abandon criterion forbids. Repair: decide "YATA order (convergent,
client-order dependent)" and pin that, like D-1 does for TX06a.
Note that V2's "in both the sequential and the concurrent order" was measured with a single client-id assignment
(`a5-boundary-undo.mjs`: A=1, B=2); the concurrent half of V2 is the same client-order coin flip, not a verification.

## F7 — MINOR — D44 says `redone` is never read by a derivation, but the retained attribution module decides incarnations by walking `redone`; the plan adds a second incarnation identity instead of reusing its own

Plan refs: D44, §2.1 ("attribution … product feature, unchanged"), §4.1 `doc/attribution/*` ("incarnation stamp"),
§2.1 nonce `n` ("settles concurrent same-id creation").

Evidence: `ensureRecord` keeps or swaps a `b/<id>` record by comparing the record's `i` (the node item's
`client:clock`) and, on mismatch, walks the local-only `redone` chain (`sameIncarnationLine`,
attribution/block.ts:304-353). Its header records the resulting replica dependence ("a stamp on a replica that
received a redo REMOTELY may see a stale `i` and swap early", block.ts:57-63). The plan keeps this unchanged and adds
the registry nonce `n`, which survives undo/redo by construction (redo copies the attr item's content,
UndoManager.js:443-451, 523) — i.e. the plan now holds two answers to "which incarnation of block X is this", with
different redo semantics, one replicated and one replica-local. Repair: key `b/<id>` records by the replicated `n`
(stamp `i = n`), delete `sameIncarnationLine` and the pre-incarnation heal, and make D44 true.

## F8 — MINOR — Moving the schema into the frame word changes failure containment: a same-generation foreign stamp now spreads to and bricks every replica

Plan refs: D-2, R13, O18 (`writable`: "a foreign stamp was observed"), L55 (staging and the "eight outbound gates"
deleted), F-T2(b).

Today a foreign/unsupported `meta.v` is refused at the receiver *before* integration (`applyUpdateStaged`,
protocols/sync.ts:303-384) and a doc already in a problem state neither persists nor broadcasts
(crdt-v14-providers.md "Outbound path"). Under the plan, frames carry only the sender's build generation, so a
same-generation writer (raw `document.doc` access, a buggy same-generation build, or any unauthenticated peer —
AGENTS.md: no auth/permissions exist) produces a stamp that every peer integrates, persists to its container, and
then turns read-only on. Map-attr LWW makes the newest stamp win and a read-only document cannot write a corrective
one, so the room stays read-only on every device. The plan presents D-2 as strictly better; it is a containment
regression. Repair: keep one cheap inbound check in `sync/room` — refuse (and report) any update whose insert set
touches `meta` with a value other than this build's stamp (the `canApplyDirect` scan already detects meta writes,
sync.ts:190-300) — and keep the outbound quarantine for a doc that is already read-only.

## F9 — MINOR — R2 does not define a block's stream when its boundary is not live, and "the registry is never replaced" is false under concurrency

Plan refs: R2 ("A block's own text runs from its boundary item, or from index 0 of its own backing text"), §2.1
("content → backing text — created lazily; a split-born block never needs one"; "registry … never replaced; ids never
reused"), F-D13(c).

Engine facts: a map-attr write on an existing key replaces the old node and tombstones its whole subtree (reader E2;
placement/model.ts:879-883), and undoing a block insert deletes the registry node item (UndoManager.js:99-104), whose `ContentType.delete`
tombstones every child list and attr item (structs/Item.js:1479-1501). Either way the fresh block's backing text
dies with every boundary in it. Scenario: A pastes block P (fresh backing text); B presses Enter inside P, creating split-born `u` (boundary in
P's text) and types into `u`; A undoes the paste. `u`'s record is B's and stays live; its boundary and text are gone.
Same outcome with concurrent `insertBlock({id: 'x'})` on two peers (caller ids are part of the public API, F-D7).
The plan gives no rule for such a block: it is visible (not deleted, self-owned) but has no stream, and "created
lazily" would give it an own backing text — after which a late-arriving boundary would give it two stream sources.
Today's slice model degrades to "claims resolve to nothing"; the plan needs the equivalent sentence. Repair: define
`stream(b)` = after its live boundary, else index 0 of its own text if one exists, else empty; forbid creating an own
text for a split-born block (typing into a streamless split-born block creates the text and records the choice in
its record, so a late boundary is inert by nonce); add the undo-of-paste case to F-D13's generator.

## F10 — MINOR — Split moves merge claims by copy, so a concurrent undo of that merge is silently re-merged

Plan refs: §2.1 Split ("Move the merge claims that follow k to the new block"), §1.1 ("no move primitive"), D9/D10
(copy-move named as the bug class the representation avoids).

With no move primitive, "move" is delete-original + insert-copy. If the peer who merged `c` into `b` undoes that
merge while another peer splits `b` before `c`'s content, the undo deletes the original `{m:c}` item (already dead)
and the split's copy on `u` survives: after sync `c` stays merged (into `u`), the undoing user sees the undo reverted.
Today's split materializes higher-generation records, the same class of copy, so this is parity, not a regression —
but it is the one place where the plan re-introduces copy-move while claiming to have removed it. Repair: keep claims
where they are and let the display walk decide ("claims of `b` whose target content lies after the split point
display in `u`") — or pin the anomaly as a decision.

## F11 — MINOR — The "fold cursor" cannot be driven by `transaction.changed`; read-your-writes needs a clock/delete-range watermark the plan does not describe

Plan refs: §2.4 per-doc index ("folded once per transaction from the engine's changed/insert/delete sets (fold
cursor); mid-transaction reads fold pending entries first (read-your-writes, linear)"), L10 ("the quadratic
in-transaction re-fold (probe C10) goes too"), K7, F-O5.

Engine facts: `transaction.changed` is `Map<type, Set<parentSub>>` filled by `addChangedTypeToTransaction`
(transaction-helpers.js:211-216): a second edit to an already-changed text adds nothing, so a cursor over its
entries misses it; types created in the same transaction are never added. `IdRanges.add` extends the last range in
place and `getIds()` sorts and merges the array in place (ids.js:116-150), so "the ranges not yet folded" is not an
append-only suffix either. What is monotone is the local client's clock within a local transaction; deletes need a
per-client set difference. That is implementable, but it is the part that decides whether the C10 quadratic
really goes, and whether a read after "insert, read, insert into the same text" sees the second insert. Repair: name
the watermark (local clock + folded delete IdSet) in §2.4 and add to F-O5 "insert → read → insert into the same text
→ read" and "delete → read → delete in the same text → read" inside one transaction.

## F12 — MINOR — "Deletion wins" does not survive selective undo while `del` is one LWW attribute

Plan refs: R3 ("Deletion wins"), §2.1 (`attrs type, data, del?, n`), D11 ("explicit replicated `del` (wins)").

Probe `double-delete-undo.mjs`: A and P delete the same block concurrently (both write `del = true`); A then undoes
its own delete. When A's item is the map-attr winner (A's client id higher), A's undo deletes it and the key reads
absent on every replica — the block reappears although P deleted it too. With the other client order it stays
deleted. Same with R3's transitive `del` on merged blocks. Pre-existing (today's `del` is the same single attr), but
the plan states R3 as a rule the representation guarantees. The placement model already avoids this shape by keying
candidates per writer (`at: {"<seq>.<client>": …}`). Repair: represent deletion as per-writer marks (`del/<client> =
true`, "deleted iff any live mark"), so an undo removes only its own mark; one extra read in `isLive`. Add F-D18:
concurrent double delete, one undo, both client orders ⇒ still deleted.

## F13 — MINOR — `force` as a replace-edit (D40) has no legal op under the plan's own identity rules

Plan refs: D40 ("`force` = hydrate → replace transaction → append its diff"), O67, F-T3 ("every trial and tab equals
the legacy materialization"), O1/D2 ("registry keys never reused"), D-12 ("no implicit revive"), R3.

The migration verifies by comparing the produced JSON, ids included, against the legacy materialization
(`withFallbackIds`, migration/migrate.ts:551-565), and the first migration keeps legacy ids. A forced re-run over a
hydrated container whose post-migration edits deleted a legacy block must bring that id back. Under the plan the id
is taken by a deleted definition (insert refuses the collision, `setBlock` refuses reused child ids, and there is no
revive op), so the replace either mints fresh ids — and then the verify step and F-T3 fail on ids — or it cannot
reproduce the legacy document. Two devices forcing independently with fresh ids also duplicate content once they
sync. Repair: give migration one explicit, documented "restore definition" op (clear the delete marks of an existing
id and rewrite its type/data/content/placement in place; with F12's per-writer marks this is "delete all marks"),
used only by `force`; or declare that `force` produces fresh ids and compare id-free JSON in verify and F-T3.

---

## Summary for the judge

| # | Sev. | One line | Caught by the plan's gates? |
|---|---|---|---|
| F1 | blocker | Boundary-format rule fails R16 under a 3-peer delete ‖ format race (v14 leaves redundant live formats in the gap); L5's deletion rests on it | No: F-U4a–c are 2-peer; F-D13 has no R16 property |
| F2 | major | Delete-time tombstoning breaks ST02a on every path and makes undo-of-delete copy-based (offline edits lost) | ST02a yes (at CP1/CP10); the offline-edit loss no |
| F3 | major | Composition previews that bypass undo ⇒ undo resurrects the preview / undoes the wrong step | Only by chance in DST |
| F4 | major | History cannot live inside "one command, one transaction"; post-undo tracked writes clear redo; F-U3-with-lineage has no mechanism | Redo break yes; lineage/one-update no |
| F5 | major | Fresh-id seeding duplicates non-empty values; a deterministic seed update removes both duplication and erasure | No (F-T4/F-T6 miss the timing and the non-empty value) |
| F6 | minor | D-17 (F-U4d → `u`) is a client-id coin flip; V2's "concurrent order" was one client assignment | n/a (tracked) |
| F7 | minor | D44 vs attribution's `redone` walk; two incarnation identities | No |
| F8 | minor | Frame-level schema generation spreads a same-generation foreign stamp and bricks every replica | No |
| F9 | minor | R2 undefined for streamless split-born blocks; registry "never replaced" false under concurrency | No |
| F10 | minor | Split moves merge claims by copy (the D9/D10 bug class) | No |
| F11 | minor | Fold cursor cannot use `transaction.changed`; needs a clock/delete watermark | Partly (F-O5) |
| F12 | minor | `del` as one LWW attr: selective undo of a concurrent double delete resurrects the block | No |
| F13 | minor | `force` replace-edit needs a revive op the identity rules forbid (verify compares ids) | F-T3 would fail if an edit deleted a legacy block |

What survives: R2's core mechanics (walk past tombstones, redo placement, nonce through undo/redo, boundary-bound
anchors, edge typing) check out in the engine. The plan's main bet is not wrong, but its verification is narrower
than its claims: every counterexample above that the gates miss involves a third writer, a concurrent format, an
offline peer, or an undo — exactly the axes (§8 "concurrent calls", "failure midway", "two features combined") the
method says to test.
