/**
 * Fork P14's rule (a registry value a concurrent creation of the same id
 * replaced keeps its subtree, `id.same.concurrent`) belongs to edytor
 * documents only: each one carries it (`doc.keepReplaced`), and binding the
 * engine never changes the class default (`Doc.keepReplaced`), so another
 * document of the same engine in the process keeps upstream's semantics.
 *
 * An edytor document is one the library made or adopted before it
 * integrated anything: `crdt.createDoc()`, `facade.newDoc()`, a facade's
 * `create(doc)`, `createDocument()`, `attachDocument(doc)`.
 */
// @ts-nocheck -- tests reach raw engine internals (excluded lane).
import { describe, expect, it } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindEdytorDoc } from '../../../lib/crdt/edytor-doc.js';
import { bindCrdt } from '../../../lib/crdt/index.js';
import { attachDocument, createDocument } from '../../../lib/crdt/index.js';
import { keepRegistryLosers } from '../../../lib/crdt/incarnations.js';

const E = bindEdytorDoc(Y);
const crdt = bindCrdt(Y);
const LIVE = 2 ** 26;

describe('keepReplaced is per document', () => {
	it('binding the engine leaves the class default as upstream has it', () => {
		expect(Y.Doc.keepReplaced).toBeNull();
		expect(new Y.Doc().keepReplaced).toBeNull();
	});

	it('every edytor document carries the registry rule', () => {
		expect(crdt.createDoc().keepReplaced).toBe(keepRegistryLosers);
		expect(E.newDoc().keepReplaced).toBe(keepRegistryLosers);
		const raw = new Y.Doc();
		E.create(raw);
		expect(raw.keepReplaced).toBe(keepRegistryLosers);
		expect(createDocument().doc.keepReplaced).toBe(keepRegistryLosers);
		const attached = new Y.Doc();
		attachDocument(attached);
		expect(attached.keepReplaced).toBe(keepRegistryLosers);
	});

	it('a rule the caller set on its document stays', () => {
		const own = () => false;
		const doc = new Y.Doc();
		doc.keepReplaced = own;
		E.create(doc);
		expect(doc.keepReplaced).toBe(own);
	});

	it('a plain document of the same engine deletes a replaced value’s subtree (upstream)', () => {
		const write = (clientID: number, text: string) => {
			const doc = new Y.Doc();
			doc.clientID = clientID;
			const node = new Y.Node('n');
			doc.get('m').setAttr('k', node);
			node.insert(0, text);
			return doc;
		};
		const a = write(LIVE + 1, 'a');
		const b = write(LIVE + 2, 'b');
		Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
		Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
		// The loser (the smaller client's node) is deleted with its text on both.
		for (const doc of [a, b]) {
			let kept = 0;
			doc.store.clients.get(LIVE + 1).forEach((s) => {
				if (!s.deleted) kept++;
			});
			expect(kept).toBe(0);
		}
	});
});
