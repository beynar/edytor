/**
 * arch-v2 §8.1 — checkpoint D2 row F-D2: document order is one answer.
 *
 * `root > [X > [box(island) > [A]], Y]`: the next block after A is `Y` for
 * every consumer (plan §8.1 F-D2; rule R5: "document order (one pre-order
 * over visible blocks; island sealing is a policy the operation applies)";
 * O7). Expected values come from the plan row, never from the engine.
 *
 * Red on the reference (P1: the facade's walk stops at the island, the
 * view's does not; there is no `order`/`compare`); green since D2.
 *
 * Consumers covered:
 * - the document: `order()`, `compare(a, b)`, `next(id)`, `previous(id)`;
 * - the document with the island-sealing policy the block-selection keys
 *   pass (`{ sealed: true }`): a walk never enters an island it did not
 *   start in, so leaving `box` from inside it still reaches `Y`;
 * - the view: `Block.closestNextBlock` / `closestPreviousBlock` handles,
 *   `edytor.blockAfter`, and the block-range walk `edytor.blocksBetween`.
 */
// @ts-nocheck -- tests drive the vendored engine JS directly (excluded lane).
import { describe, expect, test } from 'vitest';
import { Y } from '../../../lib/crdt/engine.js';
import { attachDocument } from '../../../lib/crdt/index.js';
import { bindEdytorDoc } from '../../../lib/crdt/edytor-doc.js';
import { Edytor } from '../../../lib/edytor.svelte.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';

const E = bindEdytorDoc(Y);
const REMOTE = { remote: true };

const p = (id: string, text: string, children?: unknown[], type = 'paragraph') => ({
	id,
	type,
	content: [{ kind: 'text', text }],
	...(children ? { children } : {})
});

/** `root > [X > [box(island) > [A]], Y]` */
const CONTENT = [p('X', 'xx', [p('box', 'bb', [p('A', 'aa')], 'box')]), p('Y', 'yy')];

const roles = { box: { island: true } };

const seed = (): Uint8Array => {
	const doc = new Y.Doc();
	doc.clientID = 10;
	E.create(doc, { roleOf: (t: string) => roles[t] }).init({ content: CONTENT });
	return Y.encodeStateAsUpdate(doc);
};

const facade = () => {
	const doc = new Y.Doc();
	doc.clientID = 20;
	Y.applyUpdate(doc, seed(), REMOTE);
	return E.create(doc, { roleOf: (t: string) => roles[t] });
};

const noopSnippet = (() => null) as never;
const boxPlugin = () => ({ blocks: { box: { snippet: noopSnippet, island: true } } });

const view = () => {
	const doc = new Y.Doc();
	doc.clientID = 30;
	Y.applyUpdate(doc, seed(), REMOTE);
	const document = attachDocument(doc);
	document.sync();
	return new Edytor({ document, plugins: [richTextPlugin, boxPlugin] });
};

describe('F-D2 — order is one answer', () => {
	test('document: the pre-order over visible blocks puts Y right after A', () => {
		const ed = facade();
		expect(ed.order()).toEqual(['X', 'box', 'A', 'Y']);
		expect(ed.next('A')).toBe('Y');
		expect(ed.previous('Y')).toBe('A');
		expect(ed.compare('A', 'Y')).toBeLessThan(0);
		expect(ed.compare('Y', 'A')).toBeGreaterThan(0);
		expect(ed.compare('A', 'A')).toBe(0);
		expect(ed.compare('X', 'A')).toBeLessThan(0);
	});

	test('document, island-sealed walk (block selection): leaving the island still reaches Y', () => {
		const ed = facade();
		expect(ed.next('A', { sealed: true })).toBe('Y');
		// From outside, an island is one unit: its interior is never entered.
		expect(ed.next('X', { sealed: true })).toBe('box');
		expect(ed.next('box', { sealed: true })).toBe('Y');
		expect(ed.previous('Y', { sealed: true })).toBe('box');
	});

	test('document: the island seal of the merge is the merge rule, not the order (G6)', () => {
		const ed = facade();
		expect(ed.mergeForward('A').status).toBe('refused');
		expect(ed.blockText('A')).toBe('aa');
		expect(ed.blockText('Y')).toBe('yy');
	});

	test('view: handles and walkers read the same order', () => {
		const edytor = view();
		const A = edytor.idToBlock.get('A');
		const Yb = edytor.idToBlock.get('Y');
		expect(A?.closestNextBlock?.id).toBe('Y');
		expect(Yb?.closestPreviousBlock?.id).toBe('A');
		expect(edytor.blockAfter(A)?.id).toBe('Y');
		expect(edytor.blockAfter(A, { sealed: true })?.id).toBe('Y');
		expect(edytor.blocksBetween(A, Yb).map((b) => b.id)).toEqual(['A', 'Y']);
		expect(edytor.compareBlocks(A, Yb)).toBeLessThan(0);
		expect(edytor.facade.next('A')).toBe('Y');
	});
});
