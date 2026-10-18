/**
 * Every edytor document carries edytor's rule before it integrates anything
 * (`edytor-doc.ts` `adoptRules`): a registry value a concurrent creation
 * replaced keeps its subtree (fork patch YP14, `keepingReplaced`). The
 * engine decides what a replaced value keeps when it integrates, so a
 * document that took updates under the engine's default could lose a
 * subtree its peers keep, forever: the facade refuses it loudly instead of
 * adopting it. (The order of two move records needs no rule: a record names
 * the chain it is sorted by, fork patch YP22.)
 */
// @ts-nocheck -- tests reach the engine's document directly.
import { describe, expect, it } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindEdytorDoc } from '../../../lib/crdt/edytor-doc.js';
import { attachDocument, createDocument, loadDocument } from '../../../lib/crdt/document.js';

const E = bindEdytorDoc(Y);
const saved = () => {
	const d = createDocument({
		value: { children: [{ id: 'p', type: 'paragraph', content: [{ text: 'p' }] }] }
	});
	const bytes = d.encode();
	d.destroy();
	return bytes;
};
const RULES = /took updates before it carried edytor's rules/;

describe('a document takes edytor’s rules before any update', () => {
	it('a plain engine document that integrated an update is refused by the facade and by attachDocument', () => {
		const raw = new Y.Doc();
		Y.applyUpdate(raw, saved());
		expect(() => E.create(raw)).toThrow(RULES);
		expect(() => attachDocument(raw)).toThrow(RULES);
		// Nothing was written to it while refusing.
		expect(raw.keepReplaced ?? null).toBeNull();
	});

	it('an empty engine document is adopted (the rule comes first), so is one created with it', () => {
		const empty = new Y.Doc();
		const ed = E.create(empty);
		expect(empty.keepReplaced).not.toBeNull();
		Y.applyUpdate(empty, saved());
		expect(ed.listBlockIds()).toEqual(['p']);
		const made = E.newDoc();
		Y.applyUpdate(made, saved());
		expect(() => E.create(made)).not.toThrow();
		expect(loadDocument(saved()).facade.listBlockIds()).toEqual(['p']);
	});
});
