/**
 * A retype between kinds of a different display shape (childless, island,
 * or line kind) rebuilds placement, whatever the line kind is named.
 */
import { describe, expect, it } from 'vitest';
import { createDocument } from '../../../lib/crdt/index.js';

/** `id:type[children]` of the visible tree. */
const typed = (ed) => {
	const show = (b) =>
		`${b.id}:${b.type}${b.children?.length ? `[${b.children.map(show).join(',')}]` : ''}`;
	return ed.toJSON().children.map(show).join(' ');
};

describe('a retype out of a lines island re-places the former lines', () => {
	for (const lineKind of ['codeLine', 'undefined']) {
		it(`with the line kind named "${lineKind}"`, () => {
			const document = createDocument({
				value: {
					children: [
						{
							id: 'C',
							type: 'code',
							children: [
								{
									id: 'L1',
									type: lineKind,
									children: [{ id: 'X', type: 'paragraph' }]
								}
							]
						}
					]
				},
				semantics: {
					roles: { code: { island: true, lines: true }, box: { island: true } },
					defaultChild: { code: lineKind }
				}
			});
			expect(document.facade.setBlockType('C', 'box').status).toBe('applied');
			expect(typed(document.facade)).toBe('C:box[L1:paragraph[X:paragraph]]');
			document.destroy();
		});
	}
});
