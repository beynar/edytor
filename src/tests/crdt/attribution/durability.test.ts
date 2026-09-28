/**
 * U2 — legacy `a/`/`u/`/`c/` compatibility: documents carrying records
 * written by pre-U2 builds keep them verbatim through load/encode/sync;
 * new edits never append `a/` records; `attribution.legacy()` decodes the
 * merged ContentMap for consumers that still render authorship history.
 *
 * The `a/` records under test are seeded by {@link writeLegacyRecord} —
 * byte-identical to what the retired capture wrote (`encodeContentMap`
 * under `a/<nonce>/<seq>` on the `attribution` root).
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindIndexeddbProvider } from '../../../lib/crdt/providers/indexeddb.js';
import {
	applyUpdate,
	attrsOn,
	contentNodeOf,
	deleteCovered,
	docValue,
	firstBlock,
	insertAttrs,
	itemsOf,
	legacyMapFor,
	recordKeys,
	wireDocs,
	writeLegacyRecord,
	authoredDocument
} from './helpers.js';
import {
	attachDocument,
	createDocument,
	loadDocument,
	type DocumentActor,
	type EdytorDocument
} from '../../../lib/crdt/index.js';

const providers = bindIndexeddbProvider(Y);

const alice: DocumentActor = { id: 'alice', name: 'Alice', color: '#a11' };
const bob: DocumentActor = { id: 'bob', name: 'Bob' };
const carol: DocumentActor = { id: 'carol', name: 'Carol' };

let dbCounter = 0;
const uniqueName = (base: string) => `${base}-${dbCounter++}`;

/** `key → hex(payload)` snapshot of a doc's `a/` records — the byte-level state. */
const legacyBytes = (document: EdytorDocument): Record<string, string> => {
	const root = document.doc.get('attribution');
	const out: Record<string, string> = {};
	for (const key of root.attrKeys()) {
		if (!key.startsWith('a/')) continue;
		const value = root.getAttr(key);
		out[key] =
			value instanceof Uint8Array
				? Array.from(value, (b) => b.toString(16).padStart(2, '0')).join('')
				: String(value);
	}
	return out;
};

/**
 * Hydrate `b` from `a`'s full encoded state and mark it ready — the
 * "peer joined late" path (equivalent to provider hydration).
 */
const joinLate = (a: EdytorDocument, b: EdytorDocument): void => {
	applyUpdate(b.doc, a.encode());
	b.sync();
};

/** Seed a two-record legacy history: two authors over halves of the block's first item. */
const seedLegacy = (a: EdytorDocument, blockId: string): void => {
	const first = itemsOf(contentNodeOf(a, blockId))[0]!;
	const half = Math.max(1, Math.floor(first.length / 2));
	writeLegacyRecord(a.doc, 'a/legacy0/0', legacyMapFor([{ id: first.id, length: half }], 'alice'));
	writeLegacyRecord(
		a.doc,
		'a/legacy0/1',
		legacyMapFor(
			[
				{
					id: { client: first.id.client, clock: first.id.clock + half },
					length: first.length - half
				}
			],
			'carol'
		)
	);
};

describe('legacy compat — save/load', () => {
	it('encode → loadDocument preserves every legacy record byte-for-byte', () => {
		const a = authoredDocument(docValue('hi'), alice);
		const block = firstBlock(a);
		seedLegacy(a, block.id);

		const restored = loadDocument(a.encode(), { actor: bob });
		expect(legacyBytes(restored)).toEqual(legacyBytes(a));
		// The replicated dictionary survived too — attach adds the NEW
		// replica's own c/<clientID> binding on top.
		expect(restored.attribution.actors.get('alice')).toEqual({
			name: 'Alice',
			color: '#a11'
		});
		expect(restored.attribution.actorOf(a.clientID)).toBe('alice');
		restored.destroy();
		a.destroy();
	});

	it('legacy() decodes the merged ContentMap (insert + delete attrs)', () => {
		const a = authoredDocument(docValue('hi'), alice);
		const block = firstBlock(a);
		expect(a.attribution.legacy()).toBeNull(); // fresh doc — no records
		seedLegacy(a, block.id);

		const map = a.attribution.legacy()!;
		expect(map).not.toBeNull();
		const first = itemsOf(contentNodeOf(a, block.id))[0]!;
		const half = Math.max(1, Math.floor(first.length / 2));
		expect(attrsOn(map.inserts, first.id, half)).toContain('insert:alice');
		expect(
			attrsOn(map.inserts, { client: first.id.client, clock: first.id.clock + half }, 1)
		).toContain('insert:carol');

		// A delete-side record decodes into `deletes`.
		const dead = { id: { client: 4242, clock: 0 }, length: 3 };
		writeLegacyRecord(a.doc, 'a/legacy0/2', legacyMapFor([dead], 'bob', 'deletes'));
		expect(deleteCovered(a, 'bob')).toBe(3);
		a.destroy();
	});

	it('new edits on a restored doc append no a/ records and leave legacy state untouched', () => {
		const a = authoredDocument(docValue('hi'), alice);
		const block = firstBlock(a);
		seedLegacy(a, block.id);
		const restored = loadDocument(a.encode(), { actor: bob });
		const before = legacyBytes(restored);
		const firstId = itemsOf(contentNodeOf(restored, block.id))[0]!.id;

		restored.transact(() => restored.facade.insertText(block.id, 2, '!'));
		restored.transact(() => restored.facade.deleteText(block.id, 0, 1));
		expect(recordKeys(restored)).toEqual(Object.keys(before).sort());
		expect(legacyBytes(restored)).toEqual(before);
		// The decoded map still covers the OLD item ids — tombstoned or live,
		// untouched by the new edits.
		expect(attrsOn(restored.attribution.legacy()!.inserts, firstId, 1)).toContain('insert:alice');
		restored.destroy();
		a.destroy();
	});
});

describe('legacy compat — IndexedDB', () => {
	it('a fresh provider-hydrated doc replays persisted legacy records', async () => {
		const name = uniqueName('attr-idb');
		const a = authoredDocument(docValue('hi'), alice);
		const block = firstBlock(a);
		seedLegacy(a, block.id);
		const pA = new providers.IndexeddbPersistence(name, a.doc as never);
		await pA.whenSynced;
		// Compact to a snapshot row — the a/ records ride the same bytes.
		await providers.storeState(pA);
		await pA.destroy();
		const expected = legacyBytes(a);

		const docB = new Y.Doc();
		const pB = new providers.IndexeddbPersistence(name, docB);
		await pB.whenSynced;
		const b = attachDocument(docB, { actor: bob });
		b.sync();
		expect(legacyBytes(b)).toEqual(expected);
		expect(insertAttrs(b, block.id)).toContain('insert:alice');
		expect(b.attribution.actorOf(a.clientID)).toBe('alice');
		await pB.destroy();
		b.destroy();
		a.destroy();
	});
});

describe('legacy compat — live sync', () => {
	it('mixed old/new state converges both directions; new edits append no a/ records', () => {
		const a = authoredDocument(docValue('hi'), alice);
		const block = firstBlock(a);
		seedLegacy(a, block.id);
		const b = createDocument({ actor: bob });
		joinLate(a, b);
		const unwire = wireDocs(a, b);
		const aRecords = recordKeys(a).sort();
		expect(recordKeys(b).sort()).toEqual(aRecords);

		// An "old replica" append: b writes an a/ record the way a pre-U2
		// capture would — it merges onto a without disturbing anything.
		const items = itemsOf(contentNodeOf(b, block.id));
		writeLegacyRecord(b.doc, 'a/oldpeer/0', legacyMapFor(items.slice(0, 1), 'bob'));
		expect(recordKeys(a).sort()).toEqual([...aRecords, 'a/oldpeer/0'].sort());
		expect(insertAttrs(a, block.id)).toContain('insert:bob');

		// New edits on the NEW build append nothing under a/.
		b.transact(() => b.facade.insertText(block.id, 0, 'B'));
		a.transact(() => a.facade.insertText(block.id, 0, 'A'));
		expect(recordKeys(a).sort()).toEqual([...aRecords, 'a/oldpeer/0'].sort());
		expect(recordKeys(b).sort()).toEqual(recordKeys(a).sort());

		// Block attribution (U1) still converges alongside the legacy state.
		expect(a.attribution.block(block.id)).toEqual(b.attribution.block(block.id));
		expect(a.attribution.block(block.id)?.lastChangedBy).toBe('alice');

		unwire();
		a.destroy();
		b.destroy();
	});

	it('metadata-first delivery: a record landing before its content is preserved', () => {
		const a = authoredDocument(docValue('hi'), alice);
		const block = firstBlock(a);
		const docD = new Y.Doc();
		applyUpdate(docD, a.encode());
		const d = attachDocument(docD, { actor: carol });
		d.sync();

		// A record for content d does not have yet — merges cleanly.
		const items = itemsOf(contentNodeOf(a, block.id));
		const updates: Uint8Array[] = [];
		const collect = (u: Uint8Array) => updates.push(u);
		a.doc.on('update', collect);
		writeLegacyRecord(a.doc, 'a/late/0', legacyMapFor(items.slice(0, 1), 'alice'));
		a.doc.off('update', collect);
		expect(updates).toHaveLength(1);

		Y.applyUpdate(docD, updates[0]!, 'test');
		const x = items[0]!;
		const map = d.attribution.legacy()!;
		expect(attrsOn(map.inserts, x.id, x.length)).toContain('insert:alice');

		// Duplicate delivery stays convergent (attr LWW on the same key).
		Y.applyUpdate(docD, updates[0]!, 'test');
		expect(attrsOn(d.attribution.legacy()!.inserts, x.id, x.length)).toEqual(['insert:alice']);
		d.destroy();
		a.destroy();
	});
});

describe('legacy compat — retention / GC', () => {
	it('delete-side records survive payload GC — ids, not bytes, are attributed', () => {
		const a = authoredDocument(docValue('gone'), alice);
		const block = firstBlock(a);
		a.transact(() => a.facade.insertText(block.id, 0, 'X'));
		const x = itemsOf(contentNodeOf(a, block.id))[0]!;
		writeLegacyRecord(a.doc, 'a/legacy0/0', legacyMapFor([x], 'alice'));
		writeLegacyRecord(a.doc, 'a/legacy0/1', legacyMapFor([x], 'alice', 'deletes'));
		a.transact(() => a.facade.deleteText(block.id, 0, 1));
		// The tombstone is `keep`-marked while it sits in the undo stack —
		// clearing history releases it for collection.
		a.clearHistory();

		const set = Y.createIdSet();
		set.add(x.id.client, x.id.clock, x.length);
		Y.gcIdSet(a.doc as never, set);
		// The payload is unrecoverable — the struct's content was replaced
		// by a deleted-marker (the id range itself remains as tombstone
		// metadata; full GC replacement happens when the parent dies).
		const structs = (
			a.doc as unknown as { store: { clients: Map<number, unknown[]> } }
		).store.clients.get(x.id.client)!;
		const i = Y.findIndexSS(structs as never[], x.id.clock);
		const it = structs[i] as {
			constructor: { name: string };
			content: { constructor: { name: string } };
		};
		expect(it.constructor.name === 'GC' || it.content.constructor.name === 'ContentDeleted').toBe(
			true
		);
		// Legacy records survive: they key id-ranges, not payloads.
		const map = a.attribution.legacy()!;
		expect(attrsOn(map.deletes, x.id, x.length)).toContain('delete:alice');
		expect(attrsOn(map.inserts, x.id, x.length)).toContain('insert:alice');
		a.destroy();
	});
});
