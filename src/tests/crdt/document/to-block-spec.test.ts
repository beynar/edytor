/**
 * UW-40 (adversarial review 2026-09-29) — `toBlockSpec`: headless consumers
 * holding canonical JSON (from `toJSON`, a template, an import) insert it
 * through the facade without re-implementing id minting. Imports mirror the
 * public `edytor/crdt/edytor` surface (`$lib/crdt/index.js` in-repo).
 */
import { describe, expect, it } from 'vitest';
import { createDocument, toBlockSpec, type JSONBlock } from '../../../lib/crdt/index.js';

const template: JSONBlock = {
	type: 'paragraph',
	data: { tone: 'warm' },
	content: [{ text: 'hi ' }, { type: 'mention', id: 'm1', data: { name: 'ann' } }],
	children: [{ type: 'paragraph', content: [{ text: 'child', marks: { bold: true } }] }]
};

describe('toBlockSpec', () => {
	it('mints the ids JSON leaves out and keeps the ones it carries', () => {
		const spec = toBlockSpec({ ...template, id: 'kept' });
		expect(spec.id).toBe('kept');
		expect(spec.children?.[0]?.id).toEqual(expect.any(String));
		expect(spec.content).toEqual([
			{ kind: 'text', text: 'hi ' },
			{ kind: 'inline', id: 'm1', type: 'mention', data: { name: 'ann' } }
		]);
	});

	it('duplicates a block of the document with fresh ids', () => {
		const document = createDocument({ value: { children: [{ ...template, id: 'src' }] } });
		const { facade } = document;
		facade.insertBlock(
			{ parent: null, index: 1 },
			toBlockSpec(facade.blockJSON('src'), { freshIds: true })
		);

		const [original, copy] = facade.toJSON().children;
		expect(copy!.id).not.toBe('src');
		expect(copy!.children![0]!.id).not.toBe(original!.children![0]!.id);
		const strip = ({ id: _id, ...rest }: JSONBlock): unknown => ({
			...rest,
			content: rest.content?.map((part) => ('type' in part ? { ...part, id: '' } : part)),
			children: rest.children?.map(strip)
		});
		expect(strip(copy!)).toEqual(strip(original!));
		document.destroy();
	});
});
