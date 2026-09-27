# The integrated Edytor document (v14)

`EdytorDocument` is the assembled document: **one** engine doc, **one**
shared facade (the only structural read/write surface), **one** awareness,
the local actor identity, document-level semantics (block roles + default
type), compact per-block attribution, and the default local history —
composed and lifecycle-owned in a single place.

It works **headlessly** (plain node, SSR, tests — no Svelte anywhere in the
graph) and it can be **shared by any number of `<Edytor>` views** — the
document is the thing views render, not something a view owns.

## Where things live

| import path          | what you get                                                            |
| -------------------- | ----------------------------------------------------------------------- |
| `edytor`             | everything below **plus** the `<Edytor>` component (needs a bundler)    |
| `edytor/crdt/edytor` | the identical non-component surface — node/SSR-safe entry point         |
| `edytor/crdt`        | the raw vendored v14 engine (`import * as Y`) — advanced, engine access |

`createDocument`/`loadDocument`/`attachDocument` are bound to the vendored
engine at module level — **no `bindCrdt` call and no engine import is
needed for document work**. `bindCrdt(Y)` remains the entry for the raw
provider/migration/sync stacks on docs you own yourself.

### Why no `edytor/crdt/document` subpath

The export map stays at three entries on purpose:

- `edytor/crdt/edytor` **is** the document entry point — the document API
  composes the same facade/admission/attribution/runtime the rest of the
  surface binds, so it ships inside the existing bound entry rather than
  beside it. A dedicated subpath would re-export a strict subset of the
  same files: nothing becomes importable that isn't already.
- `attachSync` types sync factories through the same `EdytorSync`
  interface the provider factories return — document and provider types
  are deliberately one graph.
- Bundlers already scope offline creation correctly: importing
  `createDocument` alone tree-shakes the provider/migration modules (they
  are side-effect-free), so a document-only bundle excludes transport
  code without a second entry point.
- `edytor/crdt` remains the raw engine for engine-injection and update
  plumbing; `edytor` remains the bundler-facing component surface.

If a real consumer need appears (e.g. a minimal runtime that must not
even _parse_ provider modules in node), a `crdt/document` entry can be
added non-breakingly — the packed-consumer lanes prove the current
three-entry graph is complete.

## Headless usage

### create → edit → undo → encode → load

```ts
import { createDocument, loadDocument } from 'edytor/crdt/edytor';

const document = createDocument({
	value: {
		children: [{ type: 'paragraph', id: 'p1', content: [{ text: 'hello' }] }]
	},
	actor: { id: 'user-42', name: 'Ada', color: '#7559ee' }
});

document.ready; // true — a seeded document is ready synchronously
document.readiness; // 'local' — this replica decided the content

const [block] = document.facade.project().children; // { id: 'p1', ... }
document.transact(() => document.facade.insertText(block.id, 5, ' world'));
document.facade.blockText(block.id); // 'hello world'

document.history.undo(); // 'hello' — the seed is never an undo step
document.history.redo(); // 'hello world'

const saved = document.encode(); // Uint8Array — full replicated state
const restored = loadDocument(saved); // fresh replica, readiness 'hydrated'
restored.facade.toJSON(); // identical JSON to the source

document.destroy();
restored.destroy();
```

`document.transact(cb)` groups a headless edit into one undo step;
`document.facade.<op>` calls outside it are still captured (untyped local
transactions are tracked). `document.history` is the shared
`UndoManager` — stacks are unbounded; prune with `document.clearHistory()`.

### Creating without a value — the provider-first path

`createDocument()` with no `value` stays **`pending`**: nothing is
seeded and nothing is broadcast, so a provider may still hydrate the doc
first. `document.sync(value?)` is the single readiness transition — it
seeds `value` on a still-fresh doc, adopts content on a hydrated one, and
is idempotent once ready.

**Seeds are deterministic** (arch-v2 R13, D-3). A seed is ONE update built
in a scratch doc whose writer id is a 32-bit hash of the generation and the
seed JSON: caller ids are kept, missing ids are derived from the hash and
position (an empty value seeds one `defaultType` block), and it is applied
with a non-local origin — never an undo step, no attribution stamp. Two
replicas seeding the same value write the same items, so a late identical
seed is a no-op and never erases an edit; different values union, and
blocks sharing an id resolve by last-writer-wins. Change a template's ids
when its content changes.

| `readiness`  | meaning                                    | gated surface                  |
| ------------ | ------------------------------------------ | ------------------------------ |
| `'pending'`  | undecided — a provider may still hydrate   | `history` refuses (see errors) |
| `'local'`    | seeded locally (`{value}` / seed-if-empty) | full surface                   |
| `'hydrated'` | adopted provider/`loadDocument`/migration  | full surface                   |

Reads (`facade.project()`, `facade.toJSON()`), `attachSync`,
`adoptSemantics`, `trackOrigin`, `sync()` and `destroy()` are legal while
pending.

### `loadDocument` — restoring bytes

`loadDocument(update, options?)` decodes and integrates the payload onto a
**scratch** doc first and gates the merged result — a corrupt payload or a
schema this build cannot own refuses **before** the facade/history/
awareness ever compose, and your bytes are never touched. A v13-era layout
refuses with `UnsupportedDocError` `'legacy'` — that is the migration path
(`docs/crdt-v14-migration.md`), not a load.

`clientID`/`guid` are **never** restored — only the replicated state is.

### `attachDocument` — composing around a doc you own

```ts
import * as Y from 'edytor/crdt';
import { attachDocument } from 'edytor/crdt/edytor';

const doc = new Y.Doc();
const document = attachDocument(doc, { actor: { id: 'user-42' } });

document.doc === doc; // borrowed, not owned
document.readiness; // 'pending' — attach never auto-seeds
document.sync(); // seeds one default paragraph on a still-fresh doc

document.destroy(); // releases document services — doc is NOT destroyed
doc.destroy(); // the borrowed doc is yours to finish with
```

The borrowed doc is gated **before** composition; a refusal leaves it
byte-identical and re-attachable once its state heals. Reattaching the
same raw doc returns the **same** document and retains one more reference
— each acquired reference needs its own `destroy()`.

### `attachSync` — providers without a view

```ts
import * as Y from 'edytor/crdt';
import { bindCrdt, createDocument } from 'edytor/crdt/edytor';

const crdt = bindCrdt(Y);
const document = createDocument(); // pending — the provider hydrates first

document.attachSync(crdt.providers.createIndexeddbSync('my-doc'), {
	value: { children: [] } // seeded only if hydration leaves a fresh doc
});
```

`attachSync(syncFactory, { value? })` hands `{ doc, awareness, synced, failed }`
to any `EdytorSync`-shaped factory — the exact contract `<Edytor {sync}>`
consumes. Readiness is **settle-or-bound**: a document with content is
`hydrated` as soon as a provider settles; an EMPTY one seeds `value` only
once every attached provider reported `synced`/`failed`, was torn down, or
reached its bound — `factory.bound` ms, `DEFAULT_READINESS_BOUND` (1000)
for a provider that cannot report "settled" (a websocket alone in a new
room). `createIndexeddbSync` always settles (`bound: Infinity`). A factory
that throws never attached and decides nothing. The returned cleanup is
tracked: `document.destroy()` runs it — provider lifetime is the
document's, not a view's.

The same factories sit on the package root for Svelte consumers
(`import { createIndexeddbSync, createWebsocketSync } from 'edytor'`) —
identical binding, same document contract.

### Attribution — who wrote what

```ts
document.attribution.block(blockId);
// { createdBy, contributors, lastChangedBy } | undefined — compact
// per-block record (U1), stamped inside the owning op's transaction
document.attribution.actorOf(document.clientID); // 'user-42' (this replica's actor)
document.attribution.actors.get('user-42'); // { name: 'Ada', color: '#7559ee' }
document.attribution.setProfile({ name: 'Ada L.' }); // republish the u/<actor> profile
document.attribution.legacy(); // merged ContentMap over pre-existing a/ records, or null
```

Ordinary editing writes **no per-edit attribution** (U2): a keystroke is
one transaction, and the block-level `b/<blockId>` record + `l`
lastChangedBy stamp ride inside it. Durable authorship is per block —
`createdBy` (insert stamp; seeded blocks have none), `contributors` (monotonic union, outside undo
scope), `lastChangedBy` (LWW on the block node, inside undo scope). The
replicated `u/`/`c/` actor dictionary travels inside `encode()` output.

Documents saved by pre-U2 builds keep their `a/` per-edit records
verbatim — preserved through `encode()`/sync and decoded on demand by
`attribution.legacy()` (feed it to the engine's `createAttributionsRenderer`
for a rendered history view). This build never appends `a/` records; old
replicas that still do merge cleanly. Full contract:
`src/lib/crdt/attribution/attribution.ts` + the U2 ledger entry.

Projected content reads carry **no** authorship fields:
`facade.project()`/`toJSON()`/`view.runs()`/`contentItems()` emit plain
`{text, marks}`/`{id, type, data}` items and never split runs at author
boundaries.

Three deliberate scope boundaries on `attribution.block()`:

- **Lineage, not visible-text authorship (product decision,
  2026-09-24).** `contributors(id)` names actors who committed an edit
  _addressing_ block `id`, plus the pre-split snapshot a split/merge
  copies to siblings — it is block-identity lineage. After a concurrent
  split, an actor's text can render in the new sibling while the actor
  appears only on the source's record (pinned:
  `src/tests/crdt/attribution/block-identity.test.ts` "P2-7"). UI may
  present it as "edited this block" lineage and must **not** present it
  as authorship of the text currently visible in that paragraph. A true
  "who wrote this text" surface is a separate, range-level feature (atom
  ownership in `text/runs.ts` is internal to undo/GC and is not an
  authorship oracle).
- **Deletes stamp nothing.** `deleteBlock` leaves `contributors` and
  `lastChangedBy` untouched — `lastChangedBy` names the author of the
  last _content_ change, not the deleter, and `contributors` stays the
  set of writers. A deleted block's `b/` record persists (records live
  outside undo scope) but `attribution.block(id)` on a non-live block is
  tombstone data — check `facade.hasBlock(id)` if liveness matters.
- **Pure moves stamp nothing.** Reparenting/reordering a block is not an
  authorship change to its content.

Undoing an insert frees the block id while its `b/` record survives; a
later block created under the recycled id overwrites `createdBy` and
clears the dead contributor set — attribution belongs to the live block,
never to the ghost.

#### Opt-in: per-block lineage ring (`lineage.depth`)

`createDocument`/`loadDocument`/`attachDocument` accept
`lineage: { depth }` (default off — `0`/absent performs **zero** lineage
writes and stays byte-identical to the unattributed schema). With
`depth > 0`, every block's `b/<id>` record carries a bounded ring of
displaced-state checkpoints:

```ts
const document = createDocument({ actor, lineage: { depth: 20 } });
document.attribution.history(blockId);
// [{ actor, by, seq, time, block }] — oldest → newest, ≤ depth,
//  undefined when the block carries no record
```

An entry lands when a write **displaces** the block's current
`lastChangedBy` owner — i.e. the first time actor B edits a block last
touched by actor A, the pre-write subtree is captured as
`{actor: 'a', by: 'b', block: <JSONBlock snapshot>}`. Same-actor edits
append nothing: the ring stores transitions, not keystrokes, so cost is
paid only on genuine handoffs. Destructive events capture
unconditionally (the same-actor rule would drop the only recovery copy):

- `deleteBlock` — the deleted subtree lands on the orphaned record,
  which stays readable via `history()` ("restore what X deleted");
- `mergeBlocks`/`mergeBackward`/`mergeForward` — the absorbed block's
  final state lands on its own record, the survivor's displaced state
  on its ring;
- `undo()`/`redo()` via the facade's undo manager — every touched
  block's pre-replay state is captured before the replay runs.

`block` is a canonical `JSONBlock` (the `toJSON` subtree shape: `type`,
`id`, `data`, un-tagged `content`, `children`) captured **before** the
displacing write, inside the same transaction — a refused or no-op
write appends nothing. Restoring an entry is an ordinary edit:

```ts
const entry = document.attribution.history(id)!.at(-1)!;
document.transact(() => {
	document.facade.setBlock(id, {
		content: (entry.block.content ?? []).map((c) =>
			'text' in c
				? { kind: 'text', text: c.text, marks: c.marks }
				: {
						kind: 'inline',
						id: c.id!,
						type: c.type,
						data: c.data
					}
		)
	});
});
```

The restore itself lands a new entry (the state it displaced), so
recovery is non-destructive by construction. Boundaries:

- **Incarnation-scoped** — the ring lives on the `b/<id>` record, which
  is stamped to the block's node item; undo/redo resurrection follows
  the `redone` line and keeps the ring, while an unrelated reuse of the
  id can never inherit it (facade `insertBlock` refuses registry ids
  outright, live or deleted).
- **Convergent cap** — entries are replicated list items appended under
  the op's transaction. Each entry carries its writer's depth (`d`) and
  THE retention bound is `max(d)` over surviving entries — one
  watermark applied identically on append (same-tx trim), on receive
  (`afterTransaction` repair for rings pushed over-cap by concurrent
  appends under partition), and on read (`history()`). A shallow
  replica therefore can never evict a deeper writer's surviving history
  on any path — not on receipt, not on its own next append — and the
  bound shrinks only once the deepest entries have themselves aged out.
  `depth` is therefore a LIVE-entry bound, not a storage bound: trimmed
  entries leave tombstone structs (~45–100B per handoff measured) that
  only compaction can reclaim.
- **`seq` is not an id** — it is the ring position at append; trimming
  rewinds the counter and concurrent replicas can assign the same
  position. Treat array order as the truth, never `seq` equality.
- **Snapshot-safe** — `history()` deep-copies every entry; mutating a
  returned `block` cannot corrupt replicated state.
- **No attribution recursion** — ring writes live on the `blockattr`
  root outside undo scope, and capture runs only from facade ops/`undo()`
  — a lineage write never triggers another lineage write.
- **Not a timeline** — the ring records "the last N displaced states",
  not every edit. Deep point-in-time needs the engine snapshot path
  (`snapshot`/`createDocFromSnapshot`), which `gc` retention governs.

### Actors and presence

`actor: { id, name?, color? }` is the **durable** author identity —
published into awareness as `actor` plus the `user` display profile remote
carets read. With no actor supplied the document mints an opaque
`anon-<uuid>` id — account-free sessions stay valid.

## Views — one document, one or many `<Edytor>` views

```svelte
<script lang="ts">
	import { Edytor, createDocument, richTextPlugin } from 'edytor';

	const document = createDocument({
		value: { children: [{ type: 'paragraph', content: [{ text: 'shared' }] }] }
	});
	const plugins = [richTextPlugin];
</script>

<Edytor {document} {plugins} />
<Edytor {document} {plugins} />
```

Every `<Edytor {document}>` on the same document shares the one facade
(one maintained run view), one history (one undo stack — per-view caret
restoration still scopes to the view that issued the undo) and one
awareness (per-view presence states merge onto it). Plugin-implied
structural roles (`void`/`island`, `defaultType`) adopt onto the document
— a conflicting second declaration raises `SemanticConflictError` instead
of silently reshaping the shared doc.

A view never destroys an injected `document` — the caller that created it
owns its lifetime (and with the dedupe rule, every `attachDocument`
reference needs its own `destroy()`).

With a provider, attach `sync` on **one** view — the factory attaches to
the document (document-lifetime), not to the view. The document keeps one
provider per transport target (the IndexedDB name; the websocket server URL
and room), so views that each evaluate `createIndexeddbSync('my-doc')` still
share one provider; a custom factory without a `target` key is its own
target:

```svelte
<Edytor {document} {plugins} sync={createIndexeddbSync('my-doc')} />
<Edytor {document} {plugins} />
```

Sibling views mount/unmount freely — the provider only dies with
`document.destroy()`. Providers attach while the component tree
initializes; an editable view without `sync` decides a still-`pending`
injected document at mount only if no provider is in flight, otherwise it
waits for readiness; a ready document syncs views immediately.

## Errors worth knowing

| error                    | when                                                                       |
| ------------------------ | -------------------------------------------------------------------------- |
| `DocumentNotReadyError`  | `history` (or other readiness-gated service) used while `pending`          |
| `DocumentDestroyedError` | any gated service used after the last `destroy()` reference released       |
| `SemanticConflictError`  | a view/caller contributes document semantics contradicting an adopted rule |
| `UndecodableUpdateError` | `loadDocument` payload cannot decode/integrate at all                      |
| `UnsupportedDocError`    | foreign doc object, or `'legacy'` v13 layout — route to migration          |
| `SchemaMismatchError`    | schema claim this build cannot own (`unversioned`/`unsupported`/`foreign`) |

Every content-entry path crosses the same **admission gate**
(`admission.ts` — the same vocabulary the provider staging gate runs):
create, load, attach, `sync()` and provider hydration are validated in the
same order. **Refusal preserves data** — refused docs keep their content,
refused updates keep their bytes, refused stored rows are never deleted.

## Ownership rules (the short version)

- `createDocument`/`loadDocument` **own** their engine doc — `destroy()`
  tears down undo manager, facade lease, attribution controller, awareness
  (if document-created), tracked sync cleanups and the doc, exactly once.
- `attachDocument` **borrows** — `destroy()` releases the services, never
  `doc.destroy()`s the borrowed doc; an injected `awareness` follows the
  same rule.
- Double-`destroy()` is a safe no-op; each deduplicated attach reference
  releases exactly once.

## Honest limits

- IndexedDB persistence is **local browser storage**, not durability
  infrastructure; websocket sync needs a y-protocols-compatible relay.
  See `docs/crdt-v14-providers.md` for exactly what is proven where —
  no wire-compat claim beyond it applies here either.
- No hosted auth, permissions, or collaboration infrastructure — the
  auth-protocol surface exists for transports that implement it.
- Block attribution is a constant-size record per touched block plus the
  `l` attr — a keystroke adds no attribution records at all (U2). Legacy
  `a/` records on pre-U2 documents persist verbatim; their retention/GC
  contract is unchanged (they key content ids, not bytes).
