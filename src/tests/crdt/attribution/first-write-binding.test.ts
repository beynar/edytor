/**
 * `attr.binding.first-write` (`docs/editor-delete-contract.md`): a replica's
 * actor binding (`c/<clientID>`, and its profile `u/<actorId>` when the
 * stored one differs) is written inside the first local transaction that
 * writes under its client id, never at attach. A replica that only reads
 * leaves the stored document byte-identical; its first edit's one update
 * carries the binding, so every struct it writes resolves to its actor on
 * every replica that holds the struct; a later edit writes no second one.
 */
import { describe, expect, it } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { createDocument, loadDocument, type DocumentActor } from '../../../lib/crdt/index.js';
import { authoredDocument, docValue, firstBlock } from './helpers.js';

const alice: DocumentActor = { id: 'alice', name: 'Alice', color: '#a11' };
const bob: DocumentActor = { id: 'bob', name: 'Bob', color: '#1b1' };

/** The update events of `document` while `fn` runs. */
const updatesOf = (document: { doc: Y.Doc }, fn: () => void): Uint8Array[] => {
	const out: Uint8Array[] = [];
	const on = (update: Uint8Array) => out.push(update);
	document.doc.on('update', on);
	try {
		fn();
	} finally {
		document.doc.off('update', on);
	}
	return out;
};

/** Whether the store holds any struct written under `client`. */
const wroteUnder = (doc: Y.Doc, client: number) => doc.store.clients.has(client);

describe('attr.binding.first-write: the actor binding goes with the first write', () => {
	it('a replica that only reads leaves the stored document byte-identical', () => {
		const a = authoredDocument(docValue('hello'), alice);
		a.transact(() => a.facade.insertText(firstBlock(a).id, 5, '!'));
		const stored = a.encode();
		a.destroy();
		const reference = loadDocument(stored).encode();
		const viewer = loadDocument(stored, { actor: bob });
		// What a view does on a page it only reads: history, reads, presence.
		viewer.history;
		viewer.facade.toJSON();
		viewer.facade.project();
		viewer.attribution.block(firstBlock(viewer).id);
		void viewer.attribution.actors;
		viewer.awareness.setLocalStateField('selections', {});
		expect(wroteUnder(viewer.doc, viewer.clientID)).toBe(false);
		expect(viewer.attribution.actorOf(viewer.clientID)).toBeUndefined();
		expect(viewer.encode()).toEqual(reference);
		viewer.destroy();
	});

	it('the first edit carries the binding, in its one update; a later edit writes none', () => {
		const a = authoredDocument(docValue('hello'), alice);
		const stored = a.encode();
		a.destroy();
		const b = loadDocument(stored, { actor: bob });
		const id = firstBlock(b).id;
		const first = updatesOf(b, () => b.transact(() => b.facade.insertText(id, 0, 'B')));
		expect(first).toHaveLength(1);
		// A replica that receives that one update resolves the writer.
		const peer = loadDocument(stored, { actor: alice });
		Y.applyUpdate(peer.doc, first[0]!);
		expect(peer.attribution.actorOf(b.clientID)).toBe('bob');
		expect(peer.attribution.actors.get('bob')).toEqual({ name: 'Bob', color: '#1b1' });
		expect(peer.attribution.block(id)?.lastChangedBy).toBe('bob');
		// The second edit touches the attribution root no more.
		const root = b.doc.get('attribution');
		const keys = [...root.attrKeys()].sort();
		const second = updatesOf(b, () => b.transact(() => b.facade.insertText(id, 1, 'b')));
		expect(second).toHaveLength(1);
		const decoded = Y.decodeUpdate(second[0]!);
		const dictionary = peer.doc.get('attribution');
		Y.applyUpdate(peer.doc, second[0]!);
		expect(
			decoded.structs.some(
				(s) => s instanceof Y.Item && (s.parent === dictionary || s.parent === 'attribution')
			)
		).toBe(false);
		expect([...root.attrKeys()].sort()).toEqual(keys);
		b.destroy();
		peer.destroy();
	});

	it('a new document binds with its seed edit; one that adopts a bound doc keeps the binding', () => {
		const d = createDocument({ value: docValue('x'), actor: alice });
		// The seed is written under the seed's own ids: no binding yet.
		expect(d.attribution.actorOf(d.clientID)).toBeUndefined();
		d.transact(() => d.facade.insertText(firstBlock(d).id, 1, 'y'));
		expect(d.attribution.actorOf(d.clientID)).toBe('alice');
		const before = d.encode();
		d.transact(() => d.facade.insertText(firstBlock(d).id, 2, 'z'));
		const root = d.doc.get('attribution');
		expect(root.getAttr(`c/${d.clientID}`)).toBe('alice');
		expect(before.length).toBeGreaterThan(0);
		d.destroy();
	});

	it("setProfile is a write: the profile and the replica's binding go together", () => {
		const a = authoredDocument(docValue('hello'), alice);
		const stored = a.encode();
		a.destroy();
		const b = loadDocument(stored, { actor: bob });
		const updates = updatesOf(b, () => b.attribution.setProfile({ name: 'Bobby' }));
		expect(updates).toHaveLength(1);
		expect(b.attribution.actorOf(b.clientID)).toBe('bob');
		expect(b.attribution.actors.get('bob')).toEqual({ name: 'Bobby' });
		b.destroy();
	});

	it('a remote update writes no binding: only a local write does', () => {
		const a = authoredDocument(docValue('hello'), alice);
		const stored = a.encode();
		const b = loadDocument(stored, { actor: bob });
		const typed = updatesOf(a, () =>
			a.transact(() => a.facade.insertText(firstBlock(a).id, 0, 'A'))
		);
		const echoed = updatesOf(b, () => Y.applyUpdate(b.doc, typed[0]!));
		expect(echoed).toHaveLength(1);
		expect(wroteUnder(b.doc, b.clientID)).toBe(false);
		expect(b.attribution.actorOf(b.clientID)).toBeUndefined();
		a.destroy();
		b.destroy();
	});
});
