# CRDT v14 — migration & cutover runbook (U12)

Audience: **operators and integrators** upgrading an Edytor deployment from the
v13 (`yjs@13`) engine to the vendored v14 (`@y/y@14.0.0-rc.26`) substrate. This
is the document to hand to whoever owns the release. The engine/protocol detail
behind each claim lives in `crdt-v14-providers.md`; test evidence is in
`src/tests/crdt/migration/` and `src/tests/crdt/providers/` (29 tests,
`pnpm test:crdt`).

> **One-paragraph version:** v13 and v14 are _different engines_ that cannot
> share a live document. Migration is a **one-way, non-destructive JSON-level
> import** of each document's logical content into a new IndexedDB generation —
> block tree, marks, inline atoms, and logical `b_*`/`i_*` ids survive;
> **CRDT identity, edit history, undo stacks, pending offline updates, and
> presence do not.** The legacy database is never written, so rollback is
> always available until you choose to retire it.

## When migration applies

A document needs migrating iff **all** of these hold:

1. The deployment upgrades to a v14 Edytor build (any `0.0.11+` line carrying
   the `edytor/crdt` substrate — there is no version-detection shim; the
   integrator knows which build it ships).
2. The document was persisted by the v13 stack — i.e. an IndexedDB database
   named exactly `<name>` with `updates`/`custom` object stores (the
   `y-indexeddb` / `localProvider.ts` layout).
3. You want the existing content to appear for v14 clients instead of an
   empty document.

If no legacy `<name>` database exists, `migrate(name)` is a cheap no-op that
simply stamps the generation `active` (`{status:'active', empty:true}`) — so
running it unconditionally at boot is safe and recommended.

## What is preserved — and what is not

| Survives migration                              | Does NOT survive (by design)                                    |
| ----------------------------------------------- | --------------------------------------------------------------- |
| Block tree, nesting, order                      | CRDT item identities (`client:clock`)                           |
| Text content, marks, inline atoms, block `data` | CRDT history — the migrated doc has a fresh, empty edit history |
| Logical ids (`b_*`/`i_*`) — they are _data_     | Collaborative undo stacks (undo cannot cross the boundary)      |
|                                                 | Pending offline update _identity_ (see "still-offline peer")    |
|                                                 | Awareness/presence state (ephemeral anyway)                     |

This is a **JSON-level import**: the migrated document is a fresh v14 document
containing the same logical content. Never describe it to users as preserving
history or identity — `edytor.toJSON()` equality is the contract, nothing
deeper.

## The boot recipe (integrator wiring)

Migration is **explicit-only** — nothing in the runtime invokes it. A v13 user
opening the app post-upgrade otherwise lands on the empty `edytor-v14:<name>`
generation and sees a fresh document. The safe order is
**migrate first, provider second**: the migrator stamps the generation record
and appends the import row into `edytor-v14:<name>`, so a provider opened
afterwards passes the storage gate and hydrates the migrated content inside
the same `whenSynced`.

```ts
import * as Y from 'edytor/crdt';
import { bindCrdt } from 'edytor'; // or 'edytor/crdt/edytor' in plain node/SSR

const crdt = bindCrdt(Y);

const bootDocument = async (name: string) => {
	// 1. Settle this generation's migration state.
	const record = await crdt.migration.status(name); // cheap: one custom read
	if (record.status === 'none' || record.status === 'failed') {
		// 'none'   — never migrated. Run it: absent legacy DB →
		//            {status:'active', empty:true}; legacy rows → verified
		//            snapshot. Idempotent and single-winner across tabs.
		// 'failed' — claimable again; safe to retry (a pending-deps abort is
		//            retryable once the missing rows sync).
		const result = await crdt.migration.migrate(name);
		if (result.status === 'failed') {
			// Surface result.error — e.g. PendingLegacyUpdatesError: a peer's
			// offline rows never landed; retry later, do not force.
		}
	} else if (record.status === 'pending') {
		// Another tab is migrating — wait until its attempt (a lock that is
		// released with the tab) ends, then read the record.
		await crdt.migration.waitForSettled(name);
	}
	// 'rolledback' is an operator decision — never auto-migrate over it
	// (requires { force: true }).

	// 2. Open the provider — hydrates whatever the generation holds
	//    (migrated snapshot + any live rows) and joins the BC room.
	const doc = crdt.createDoc();
	const awareness = new crdt.Awareness(doc);
	const provider = new crdt.providers.IndexeddbPersistence(name, doc, { awareness });
	provider.on('schema-mismatch', (detail, p) => reportToOps(detail));
	provider.on('protocol-mismatch', (mismatch, p) => reportToOps(mismatch));
	provider.on('load-error', (err, p) => reportToOps(err));
	await provider.whenSynced;

	// 3. Init/bind the editor — the facade's init is a no-op on a migrated or
	//    hydrated doc (it already carries meta.v).
	const edytor = new Edytor({ doc, awareness, sync: true, value });
	// or the component prop form:
	// <Edytor sync={({ doc, awareness, synced }) => {
	//   const provider = new crdt.providers.IndexeddbPersistence(name, doc, { awareness });
	//   provider.whenSynced.then(() => synced(provider));
	//   return () => provider.destroy();
	// }} … />
};
```

Rules that make this safe:

- **Order matters.** Persist appends (the `updates` store is never cleared),
  so a migration that runs _while a provider is already open_ still lands
  correctly on disk — but that tab only sees the migrated content on next
  hydration unless you bridge explicitly (`Y.applyUpdate(doc, result.update)`).
- **Concurrent tabs serialize on the migration lock** — see next section.
- **The legacy `<name>` DB is never written** — v13 installs keep working on
  their own data, and `rollback(name)` + `force` stays an explicit recovery
  path.
- **Websocket rooms:** BC room name = the generation DB name
  (`edytor-v14:<name>`); websocket `roomName` is whatever the integrator
  passes — v13 and v14 clients must use _different_ room names if both stacks
  share a relay (the envelope gate will drop cross-version frames either way —
  see "Wire contract").

## Concurrent tabs and arbitration

`claim → read → materialize → rebuild → verify → persist`. At most one tab
imports a given name at a time, and that exclusivity ends with the tab:

- **The attempt is a lock** (`navigator.locks`, lock name
  `edytor-v14-migration:<name>`), not a durable record — so there is no
  lease, owner, expiry or polling. A crashed tab releases it with the tab; a
  thrown phase releases it with the call. Where `navigator.locks` is absent
  (Node 22) an in-process mutex stands in.
- Other callers queue behind the holder (`wait:true` default) and then
  observe `alreadyActive`. `wait:false` asks for the lock `ifAvailable` and
  returns `{status:'busy'}` immediately — safe for callers that prefer to
  proceed: the provider stamps an empty generation itself and still opens,
  just without the import yet.
- `status(name)` reports `pending` while any tab holds the attempt (it asks
  the lock manager), the durable record otherwise. `waitForSettled(name)`
  waits until no tab holds it, then reads the record.
- **Progress is one transaction**: the import row is **appended** and the
  `active` record written in one IndexedDB `readwrite` transaction — a
  completed import is visible iff both committed. A crash before that commit
  leaves nothing; the next run re-imports cleanly.
- `migrate` is safe against an _already-live v14 provider_: the store is
  append-only for every writer, so provider rows are never cleared,
  overwritten or orphaned.

`leaseMs`, `owner`, `pollMs` and `waitMs` are accepted and ignored (they
described the retired lease); the durable record never carries a lease or an
owner.

## Statuses and failure modes

`MigrationRecord.status`: `none` → `active` | `failed` | `rolledback` (stored);
`status()` also reports `pending` while a tab holds the attempt lock — it is
never stored.

| Failure                       | Status   | Meaning / action                                                                                                                                                                                           |
| ----------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PendingLegacyUpdatesError`   | `failed` | Legacy rows contain pending structs (a peer's offline updates whose dependencies never landed). **Fail closed** — content is never silently dropped. Retry once the peer syncs; do not `force` to skip it. |
| Non-legacy schema             | `failed` | The `<name>` DB does not hold the v13 Edytor schema — refuses rather than importing garbage.                                                                                                               |
| Another tab holds the attempt | `busy`   | Another tab is migrating (`wait:false` only). Wait (`waitForSettled`) or proceed without the import.                                                                                                       |
| `rolledback`                  | —        | Operator decision. `migrate` refuses unless `{force:true}`.                                                                                                                                                |

Interrupted migrations recover by construction: the row and the `active`
record commit together, so a crash at any point before that commit leaves
nothing behind and the next run re-imports; after it → `alreadyActive`.

## Rollback procedure

```ts
await crdt.migration.rollback(name);
```

- Marks the generation `rolledback` and **clears its `updates` rows** — the
  v14 generation is emptied, not deleted.
- The legacy `<name>` database is untouched — the v13 stack keeps working on
  its own data immediately. Rollback is therefore the "point the old build at
  the old data again" operation.
- A subsequent `migrate` requires `{force:true}` — rollback is an explicit
  operator decision, not a state the boot recipe should auto-clear.
- To also wipe the v14 generation entirely: `crdt.providers.clearDocument(name)`
  (only touches the `edytor-v14:<name>` database).

## Verification

`migrate` verifies before activating — do not re-implement this, but know what
it guarantees:

1. **materialize**: legacy `updates` rows are applied to a scratch v14 doc and
   the v13 Edytor schema is materialized to `JSONDoc` (root `content` map →
   `children` sequence → block maps). Anything that is not the v13 Edytor
   schema is rejected (`failed`). Pending dependencies fail closed.
2. **rebuild**: `edytorDoc.restore(doc, specs)` — into a fresh doc for a
   first import, into the generation's hydrated state for `force`; logical
   ids preserved, `mig-*` deterministic fallbacks for missing ones (assigned
   once, to the JSON both the import and the verify read).
3. **verify**: the migrated state is applied to a _second_ scratch doc and
   its `toJSON()` — ids included — must deep-equal the materialized legacy
   JSON, else `failed`.
4. **persist**: one transaction appends the row and writes `active`.

Operator-level verification after a release: for a sampled document,
`status(name)` → `active`; open the doc and compare `edytor.value` (or
`facade.toJSON()`) against a pre-upgrade JSON export. `MigrateResult.json`
carries the materialized JSON for exactly this comparison when the call ran
the import.

## What happens to a still-offline v13 peer (be honest with users)

A v13 client that was **offline through the cutover** and comes back later:

- Its locally stored updates live in the legacy `<name>` DB, which the v14
  stack never writes or live-maps. **Those edits do not appear in the v14
  document automatically.** This is a hard boundary, not a bug.
- If the v13 client still runs the _old build_, it keeps working against the
  legacy DB — and against any v13 websocket rooms — in a **split-brain
  universe**: v13 peers see v13 state, v14 peers see v14 state. The wire
  envelope prevents corrupting each other (next section), but nothing merges
  the content. Ship the new build everywhere before announcing cutover.
- **Recovery path for stranded edits**: while the legacy DB is intact, those
  offline rows can still be imported — `migrate(name, {force:true})` re-reads
  the legacy store wholesale and **restores it in place**: it hydrates the
  generation and, in one CRDT edit, gives every legacy id back its legacy
  type, data, position and content (clearing deletions made since) and
  deletes every block created since; the diff is appended. This replaces,
  it does not merge: anything written into v14 since the first migration is
  superseded by the legacy materialization. Legacy ids — and each block's
  engine identity — are kept, so deep links and anchors survive, and two
  devices that force independently converge on one copy.
  Prefer: get the straggler online with the _old_ build, let its pending
  updates land in the legacy DB (clearing the pending-deps failure mode), then
  run the forced re-import during a quiet window.
- A v13 client that _joins a v14 room_ sends frames the v14 side drops at the
  envelope (`'protocol-mismatch'`, `{expected:14, found:0}`); symmetrically the
  v13 client ignores v14 frames. Nobody corrupts anybody — they just never
  meet.

## Wire contract — for ops/security review

### Transport envelope (`crdt/protocols/envelope.ts`)

Every provider message — BroadcastChannel room traffic _and_ websocket frames —
is prefixed:

```
varuint PROTOCOL_VERSION (=14) | varuint messageType | payload
```

`14` is unreachable as a v13 message type (v13 types are 0–3). The gate is
**fail-closed in both directions**:

- v14 reader on a v13 frame: decodes `version = 0..3 ≠ 14` → drops **before
  any sync decoding**, emits `'protocol-mismatch'`. v13 updates can never
  reach `applyUpdate` on a v14 doc.
- v13 reader on a v14 frame: decodes message type `14`, finds no handler,
  drops it.

Message types inside the envelope keep the y-websocket numbering: sync `0`,
awareness `1`, auth `2`, query-awareness `3`. (Migration no longer announces
over a BroadcastChannel room — `edytor-v14-migration:<name>` names its lock.)

**Scope — read this before signing off.** The envelope authenticates that a
peer speaks the v14 wire protocol; it does **not** authenticate payload
provenance. A v14 frame carrying v13-shaped update payloads will decode and
integrate (structs land on legacy root keys — invisible to the v14 projection
but persisted and replicated). Peers in a room are trusted to ship well-formed
v14 structs; the application-schema gate (`meta.v`) bounds what a confused or
forged peer can do to the _projected_ document. If you need real peer
authentication, that is the websocket `auth` message (`protocols/auth.ts`) +
your server — not the envelope.

### Application-schema gate (`meta.v`)

Documents carry `meta.v` (currently `1`) + `meta.schema` (`'edytor-doc'`) as
replicated attributes. Providers enforce:

- **unversioned** (registry content without `meta.v`): update **quarantined** —
  never persisted, never broadcast, never applied to a hydrating doc.
- **unsupported** (`meta.v` names a version this build doesn't speak):
  content still syncs (a replica cannot refuse structs it shares a protocol
  with) but `'schema-mismatch'` fires so skew is observable.

Both emit `'schema-mismatch'` once per problem-state transition, mirrored
through `'message-error'` carrying the `SchemaMismatchError`. Schema-version
coexistence is **LWW**, not dual-version — detect mixed-version rooms via the
signal.

### Storage gate (IndexedDB generation)

- v14 opens `edytor-v14:<name>` — never the legacy `<name>` database.
- On creation the provider stamps `custom.generation =
{engine:'yjs-v14', protocol:14}` and _verifies it before applying a single
  stored row_. Populated-without-record or foreign record →
  `GenerationMismatchError`, `'load-error'` fires, `whenSynced` rejects —
  fail closed.
- `clearDocument(name)` deletes only the v14 generation.

### Observability events (the contract, not console noise)

`'protocol-mismatch'`, `'message-error'` (corrupt payloads, unknown message
types, mirrored schema errors), `'permission-denied'` (ws auth),
`'load-error'` (generation gate), `'schema-mismatch'` (application gate).
Wire these into ops surfacing — they are how you notice version skew,
forged/confused peers, and stuck migrations.

## API summary

`bindCrdt(Y).migration` → `{ migrate, rollback, status, waitForSettled }`.

- `migrate(name, opts?)` → `MigrateResult` (`active|busy|failed|rolledback`;
  `alreadyActive`, `empty`, `doc`, `update`, `json`, `sourceRows`, `error`).
  `update` is the migrated state — feed it through the document admission
  path: `loadDocument(result.update)` restores it as a `hydrated` document
  through the same gate every load crosses (U8; `attachDocument(result.doc)`
  - `sync()` is the equivalent in-place path). The appended row is its diff
    against what the generation held (the whole state for a first import).
    `MigrateOptions`: `sourceName`, `force`, `wait`, `onPhase` (testing hook:
    `claim`, `read`, `materialize`, `rebuild`, `verify`, `persist`); `leaseMs`,
    `waitMs`, `pollMs`, `owner` are accepted no-ops.
- `status(name)` → `MigrationRecord` (`{v, status, migratedAt?,
rolledbackAt?, sourceRows?, sourceBytes?, error?}`); `pending` while a tab
  holds the attempt lock.
- `waitForSettled(name)` → the record once no tab holds the attempt lock.
- `rollback(name)` → marks `rolledback`, clears generation rows.

## Evidence pointers

- `src/tests/crdt/migration/` + `src/tests/crdt/providers/` — 29 tests:
  CO01 (four recorded v13 fixtures decode to pinned JSON; offline-peer pending
  update applies incrementally; non-legacy rejected), CO02 (end-to-end
  migration → real-provider hydration; legacy DB byte-identical afterwards;
  logical ids preserved / CRDT identity reset; empty and foreign DBs), CO03
  (concurrent migrators → one row + one `alreadyActive`; idempotent re-run;
  crash-resume at each boundary; rollback requires `force`).
- `src/tests/crdt/arch-v2/t5-migration.test.ts` — the lock, the atomic
  commit, and `force` as restore-definition (F-T3, F-T15, F-T16, the
  in-process fallback); the browser half of F-T16 in
  `tests/editor-dom/collaboration.spec.ts`.
- `src/tests/crdt/fixtures/legacy-v13/` — durable v13 binary fixtures +
  generator.
- Two-page browser proof of the provider/generation stack (Chromium, Firefox,
  WebKit collaboration specs): `docs/crdt-v14-browser-proof.md`.
