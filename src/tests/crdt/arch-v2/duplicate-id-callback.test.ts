/**
 * NW-11 — `duplicateBlock(id, freshId)` names every copied block AND inline
 * atom through `freshId(oldId, kind)`. A block-only callback (one that
 * answers only block ids, e.g. `old => map.get(old)!`) must never throw:
 * an inline id it does not answer is minted fresh; a block id it does not
 * answer refuses the whole copy (zero writes).
 *
 * Expected values come from the NW-11 row, never from running the code.
 */
import { describe, expect, it } from 'vitest';
import { createDocument } from '../../../lib/crdt/index.js';
import type { DocBlock } from '../../../lib/crdt/index.js';

const seed = () =>
	createDocument({
		value: {
			children: [
				{
					id: 'p',
					type: 'paragraph',
					content: [{ text: 'hi ' }, { id: 'm1', type: 'mention', data: {} }, { text: '' }]
				}
			]
		}
	});

const atomsOf = (document: ReturnType<typeof seed>, id: string) =>
	(document.facade.toJSON().children.find((b) => b.id === id)?.content ?? []).filter(
		(part) => !('text' in part)
	) as { id: string; type: string }[];

describe('duplicateBlock with a block-only callback (NW-11)', () => {
	it('mints a fresh inline atom id instead of throwing (block handle)', () => {
		const document = seed();
		const map = new Map([['p', 'p2']]);
		let result: ReturnType<DocBlock['duplicate']> | undefined;
		expect(() => {
			result = document.facade.block('p').duplicate((old) => map.get(old)!);
		}).not.toThrow();
		expect(result).toMatchObject({ status: 'applied', ids: ['p2'] });
		const [atom] = atomsOf(document, 'p2');
		expect(atom?.type).toBe('mention');
		expect(typeof atom?.id).toBe('string');
		expect(atom?.id).not.toBe('m1');
		expect(atomsOf(document, 'p').map((a) => a.id)).toEqual(['m1']);
		document.destroy();
	});

	it('refuses (no throw, no write) when a block id is not answered', () => {
		const document = seed();
		const before = JSON.stringify(document.facade.toJSON());
		let result: ReturnType<DocBlock['duplicate']> | undefined;
		expect(() => {
			result = document.facade.duplicateBlock('p', () => undefined as unknown as string);
		}).not.toThrow();
		expect(result?.status).toBe('refused');
		expect(JSON.stringify(document.facade.toJSON())).toBe(before);
		document.destroy();
	});

	it('the typed callback receives the kind of each id', () => {
		const document = seed();
		const seen: [string, 'block' | 'inline'][] = [];
		const fresh: Parameters<DocBlock['duplicate']>[0] = (old, kind) => {
			seen.push([old, kind]);
			return `${old}-copy`;
		};
		expect(document.facade.block('p').duplicate(fresh).status).toBe('applied');
		expect(seen).toEqual([
			['p', 'block'],
			['m1', 'inline']
		]);
		expect(atomsOf(document, 'p-copy').map((a) => a.id)).toEqual(['m1-copy']);
		document.destroy();
	});
});
