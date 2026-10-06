/**
 * H7 (`hist.purge.horizon`): in a view, an undo of a step the room stored
 * before the purge horizon restores nothing and reports `noop`
 * (`dispatcher.last`); a newer step still undoes (`applied`).
 */
import { describe, expect, it } from 'vitest';
import { Y } from '$lib/crdt/engine.js';
import { bindCrdt, createDocument, defaultSemantics } from '$lib/crdt/index.js';
import { Edytor } from '$lib/edytor.svelte.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import type { JSONDoc } from '$lib/utils/json.js';

const crdt = bindCrdt(Y);
const PURGE = Symbol('purge');

const value: JSONDoc = {
	children: [
		{ id: 'p1', type: 'paragraph', content: [{ text: 'one' }] },
		{ id: 'p2', type: 'paragraph', content: [{ text: 'two' }] },
		{ id: 'p3', type: 'paragraph', content: [{ text: 'three' }] }
	]
};

describe('H7: an undo older than the purge horizon', () => {
	it('restores nothing (`noop`); a newer step undoes (`applied`)', () => {
		const room = createDocument({ value, semantics: defaultSemantics });
		const document = createDocument({
			value,
			actor: { id: 'ada' },
			history: { captureTimeout: 0 },
			semantics: defaultSemantics
		});
		const view = new Edytor({ document, plugins: [richTextPlugin] });
		const send = (from: { doc: Y.Doc }, to: { doc: Y.Doc }) =>
			crdt.sync.applyRemote(
				to.doc,
				Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc)),
				'remote'
			);
		const ids = () => document.facade.toJSON().children.map((block) => block.id);

		document.transact(() => document.facade.deleteBlocks(['p2']));
		send(document, room);
		// The room's epoch, then a newer step the room had not stored at it.
		const horizon = { at: 1, sv: Y.encodeStateVector(room.doc) };
		document.transact(() => document.facade.deleteBlocks(['p3']));
		send(document, room);
		room.doc.transact(() => crdt.doc.purge(room.doc, room.facade, horizon), PURGE);
		send(room, document);
		expect(ids()).toEqual(['p1']);

		view.historyUndo();
		expect(view.dispatcher.last).toEqual({ operation: 'undo', status: 'applied' });
		expect(ids()).toEqual(['p1', 'p3']);
		view.historyUndo();
		expect(view.dispatcher.last).toEqual({ operation: 'undo', status: 'noop' });
		expect(ids()).toEqual(['p1', 'p3']);

		view.destroy();
		document.destroy();
		room.destroy();
	});
});
