/**
 * GX-05 (headless half): the facade's `unNestBlocks(ids)` is one plan, so
 * blocks with an unlisted sibling between them land together and that
 * sibling ends up before them (document-api.mdx says so). One call per run
 * of adjacent siblings keeps the order, as the editor's `moveBlocks` `out`
 * and Shift+Tab do (src/tests/fixtures/dom/gx-api-20260930.test.tsx).
 */
import { describe, expect, it } from 'vitest';
import { createDocument, defaultSemantics, type JSONBlock } from '$lib/crdt/index.js';

const p = (id: string): JSONBlock => ({ id, type: 'paragraph', content: [{ text: id }] });
const li = (id: string): JSONBlock => ({ id, type: 'list-item', content: [{ text: id }] });
const value = {
	children: [
		p('p'),
		{ id: 'u', type: 'unordered-list', children: 'abcde'.split('').map(li) },
		p('q')
	]
};

/** The document's text in reading order. */
const reading = (blocks: readonly JSONBlock[]): string[] =>
	blocks.flatMap((b) => [
		...(b.content ?? []).map((part) => ('text' in part ? part.text : '')),
		...reading(b.children ?? [])
	]);

describe('GX-05: facade unNestBlocks over a gap', () => {
	it('one call gathers [a, c]: the unlisted b reads before a', () => {
		const document = createDocument({ value, semantics: defaultSemantics });
		expect(document.facade.unNestBlocks(['a', 'c']).status).toBe('applied');
		expect(reading(document.facade.project().children).join('|')).toBe('p|b|a|c|d|e|q');
		document.destroy();
	});

	it('one call per run keeps the order', () => {
		const document = createDocument({ value, semantics: defaultSemantics });
		document.transact(() => {
			document.facade.unNestBlocks(['a']);
			document.facade.unNestBlocks(['c']);
		});
		expect(reading(document.facade.project().children).join('|')).toBe('p|a|b|c|d|e|q');
		document.destroy();
	});
});
