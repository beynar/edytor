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
and persists the snapshot row into `edytor-v14:<name>`, so a provider opened
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
		// Another tab owns the claim — wait for its settle (expired leases
		// count as settled).
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

- **Order matters.** Persist is additive (`MIGRATION_SNAPSHOT_KEY`; the
  `updates` store is never cleared), so a migration that runs _while a
  provider is already open_ still lands correctly on disk — but that tab only
  sees the migrated content on next hydration unless you bridge explicitly
  (`Y.applyUpdate(doc, Y.encodeStateAsUpdate(result.doc))`).
- **Concurrent tabs serialize on the claim** — see next section.
- **The legacy `<name>` DB is never written** — v13 installs keep working on
  their own data, and `rollback(name)` + `force` stays an explicit recovery
  path.
- **Websocket rooms:** BC room name = the generation DB name
  (`edytor-v14:<name>`); websocket `roomName` is whatever the integrator
  passes — v13 and v14 clients must use _different_ room names if both stacks
  share a relay (the envelope gate will drop cross-version frames either way —
  see "Wire contract").

## Concurrent tabs and arbitration

`claim → read → materialize → rebuild → verify → persist → activate →
announce`. Exactly one caller wins the claim:

- The `migration` record in the generation's `custom` store is written inside
  **one IndexedDB `readwrite` transaction** — IndexedDB serializes read-write
  transactions over a store, so concurrent `migrate(name)` calls in different
  tabs produce exactly one `{status:'pending', owner, leaseUntil}` owner.
- Losers wait (`wait:true` default; poll every `pollMs` 150 ms + a fast path
  via the `edytor-v14-migration:<name>` BroadcastChannel room) then observe
  `alreadyActive`. `wait:false` returns `{status:'busy'}` immediately — safe
  for callers that prefer to proceed, because the claim already stamped the
  generation record and the provider will still pass the storage gate (just
  without the snapshot yet).
- A `pending` lease that expires (`leaseMs`, default 30 s — crashed tab) is
  reclaimable: `waitForSettled` treats an expired lease as settled, so resume
  latency is bounded by `leaseMs`, not `waitMs`.
- Every phase is idempotent; resume re-runs the import into the same
  generation. The migrated doc is rebuilt from scratch and persisted as one
  row, so a re-run cannot duplicate identities.
- `migrate` is also safe against an _already-live v14 provider_: persist is
  additive and never clears provider rows.

## Statuses and failure modes

`MigrationRecord.status`: `none` → `pending` → `active` | `failed` |
`rolledback`.

| Failure                           | Status   | Meaning / action                                                                                                                                                                                           |
| --------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PendingLegacyUpdatesError`       | `failed` | Legacy rows contain pending structs (a peer's offline updates whose dependencies never landed). **Fail closed** — content is never silently dropped. Retry once the peer syncs; do not `force` to skip it. |
| Non-legacy schema                 | `failed` | The `<name>` DB does not hold the v13 Edytor schema — refuses rather than importing garbage.                                                                                                               |
| Claim lost / another owner active | `busy`   | Another tab is migrating (or holds an unexpired lease). Wait or proceed without the snapshot.                                                                                                              |
| `rolledback`                      | —        | Operator decision. `migrate` refuses unless `{force:true}`.                                                                                                                                                |

Interrupted migrations recover by construction: crash before `persist` → next
run re-imports cleanly; crash after `persist` but before `activate` → next run
re-imports and overwrites the same snapshot key; crash after `activate` →
`alreadyActive`.

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
2. **rebuild**: `edytorDoc.init(doc, {content})` — the same path used for
   fresh docs; logical ids preserved, `mig-*` deterministic fallbacks for
   missing ones.
3. **verify**: the produced snapshot is applied to a _second_ scratch doc and
   its `toJSON()` must deep-equal the materialized legacy JSON, else `failed`.
4. **persist/activate**: one snapshot row + one record write.

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
  the legacy store wholesale and rebuilds. This is a _fresh import_, not a
  merge: anything written into v14 since the first migration is replaced by
  the legacy materialization (the snapshot row is overwritten; live v14 rows
  in the store are preserved but the JSON comparison is against legacy).
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
awareness `1`, auth `2`, query-awareness `3`, plus `7` for migration
announcements on the separate `edytor-v14-migration:<name>` room.

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
  `update` is the persisted v14 snapshot itself — feed it through the
  document admission path: `loadDocument(result.update)` restores the
  migrated state as a `hydrated` document through the same staged gate
  every load crosses (U8; `attachDocument(result.doc)` + `sync()` is the
  equivalent in-place path). `MigrateOptions`: `sourceName`, `leaseMs`
  (30 s), `waitMs` (30 s), `pollMs` (150 ms), `owner`, `force`, `wait`,
  `onPhase` (testing hook).
- `status(name)` → `MigrationRecord` (`{v, status, owner?, leaseUntil?,
migratedAt?, rolledbackAt?, sourceRows?, sourceBytes?, error?}`).
- `waitForSettled(name, {waitMs, pollMs})` → resolves on first non-`pending`
  record (expired leases count as settled).
- `rollback(name)` → marks `rolledback`, clears generation rows, announces.

## Evidence pointers

- `src/tests/crdt/migration/` + `src/tests/crdt/providers/` — 29 tests:
  CO01 (four recorded v13 fixtures decode to pinned JSON; offline-peer pending
  update applies incrementally; non-legacy rejected), CO02 (end-to-end
  migration → real-provider hydration; legacy DB byte-identical afterwards;
  logical ids preserved / CRDT identity reset; empty and foreign DBs), CO03
  (concurrent migrators → one snapshot + one `alreadyActive`; idempotent
  re-run; crash-resume at each boundary; rollback requires `force`).
- `src/tests/crdt/fixtures/legacy-v13/` — durable v13 binary fixtures +
  generator.
- Two-page browser proof of the provider/generation stack (Chromium, Firefox,
  WebKit collaboration specs): `docs/crdt-v14-browser-proof.md`.
