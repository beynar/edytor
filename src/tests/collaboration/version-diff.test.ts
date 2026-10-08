/**
 * The block-level diff of a version against the current document (version
 * history panel). The expected values come from the definitions on the
 * site's `server/history-panel` page: a block is matched by id; `removed`
 * is in the version only, `added` in the current document only, `changed`
 * in both with another type, data or content; a move alone is no change.
 * The preview is the version with each added block inserted where the
 * current document has it: after its nearest earlier sibling the preview
 * holds under the same parent, else first under that parent.
 */
import { describe, expect, it } from 'vitest';
import { versionDiff } from '$lib/collaboration/history/diff.js';
import type { JSONBlock, JSONDoc } from '$lib/utils/json.js';

const p = (id: string, text: string, children?: JSONBlock[]): JSONBlock => ({
	type: 'paragraph',
	id,
	data: {},
	content: [{ text }],
	...(children ? { children } : {})
});

/** The ids of a tree, in reading order, with their depth. */
const outline = (doc: JSONDoc): string[] => {
	const out: string[] = [];
	const walk = (blocks: JSONBlock[], depth: number) => {
		for (const block of blocks) {
			out.push(`${'  '.repeat(depth)}${block.id}`);
			walk(block.children ?? [], depth + 1);
		}
	};
	walk(doc.children, 0);
	return out;
};

describe('versionDiff', () => {
	it('reports nothing when the version equals the document', () => {
		const doc = { children: [p('a', 'one'), p('b', 'two', [p('c', 'three')])] };
		const diff = versionDiff(doc, structuredClone(doc));
		expect([...diff.changes]).toEqual([]);
		expect([diff.added, diff.removed, diff.changed]).toEqual([0, 0, 0]);
		expect(diff.preview).toEqual(doc);
	});

	it('marks a block only the version holds as removed', () => {
		const version = { children: [p('a', 'one'), p('b', 'two')] };
		const current = { children: [p('a', 'one')] };
		const diff = versionDiff(version, current);
		expect(Object.fromEntries(diff.changes)).toEqual({ b: 'removed' });
		expect(diff.removed).toBe(1);
		expect(outline(diff.preview)).toEqual(['a', 'b']);
	});

	it('marks a block only the document holds as added and shows it where the document has it', () => {
		const version = { children: [p('a', 'one'), p('c', 'three')] };
		const current = { children: [p('a', 'one'), p('b', 'two'), p('c', 'three')] };
		const diff = versionDiff(version, current);
		expect(Object.fromEntries(diff.changes)).toEqual({ b: 'added' });
		expect(diff.added).toBe(1);
		expect(outline(diff.preview)).toEqual(['a', 'b', 'c']);
		// The added block shows its current content.
		expect(diff.preview.children[1]).toEqual(p('b', 'two'));
	});

	it('places an added first child first under its parent, and its added children under it', () => {
		const version = { children: [p('a', 'one', [p('x', 'kept')])] };
		const current = {
			children: [p('a', 'one', [p('n', 'new', [p('m', 'newer')]), p('x', 'kept')])]
		};
		const diff = versionDiff(version, current);
		expect(Object.fromEntries(diff.changes)).toEqual({ n: 'added', m: 'added' });
		expect(outline(diff.preview)).toEqual(['a', '  n', '    m', '  x']);
	});

	it('marks a block whose text, type or data differ as changed', () => {
		const version = {
			children: [
				p('a', 'one'),
				p('b', 'two'),
				{ type: 'todo', id: 'c', data: { checked: false }, content: [{ text: 'task' }] },
				p('d', 'same')
			]
		};
		const current = {
			children: [
				p('a', 'one!'),
				{ ...p('b', 'two'), type: 'heading' },
				{ type: 'todo', id: 'c', data: { checked: true }, content: [{ text: 'task' }] },
				p('d', 'same')
			]
		};
		const diff = versionDiff(version, current);
		expect(Object.fromEntries(diff.changes)).toEqual({ a: 'changed', b: 'changed', c: 'changed' });
		expect(diff.changed).toBe(3);
		// The preview shows the version's content.
		expect(outline(diff.preview)).toEqual(['a', 'b', 'c', 'd']);
		expect(diff.preview.children[0]!.content).toEqual([{ text: 'one' }]);
	});

	it('counts a mark as a change, and ignores key order and absent empty data or marks', () => {
		const version = {
			children: [
				{ type: 'paragraph', id: 'a', content: [{ text: 'bold', marks: { bold: true } }] },
				{ type: 'paragraph', id: 'b', data: { x: 1, y: 2 }, content: [{ text: 'b' }] },
				{ type: 'paragraph', id: 'c', content: [{ text: 'c', marks: {} }] }
			]
		};
		const current = {
			children: [
				{ type: 'paragraph', id: 'a', data: {}, content: [{ text: 'bold' }] },
				{ type: 'paragraph', id: 'b', data: { y: 2, x: 1 }, content: [{ text: 'b' }] },
				{ type: 'paragraph', id: 'c', data: {}, content: [{ text: 'c' }] }
			]
		};
		expect(Object.fromEntries(versionDiff(version, current).changes)).toEqual({ a: 'changed' });
	});

	it('does not count a move, nor a change of children, as a change of the block', () => {
		const version = { children: [p('a', 'one', [p('b', 'two')]), p('c', 'three')] };
		const current = { children: [p('c', 'three'), p('a', 'one'), p('b', 'two')] };
		const diff = versionDiff(version, current);
		expect([...diff.changes]).toEqual([]);
		// The preview keeps the version's structure.
		expect(outline(diff.preview)).toEqual(['a', '  b', 'c']);
	});

	it('keeps the version data of the document in the preview', () => {
		const version: JSONDoc = { data: { title: 'Then' }, children: [p('a', 'one')] };
		const current: JSONDoc = { data: { title: 'Now' }, children: [p('a', 'one')] };
		expect(versionDiff(version, current).preview.data).toEqual({ title: 'Then' });
	});

	it('leaves its inputs untouched', () => {
		const version = { children: [p('a', 'one')] };
		const current = { children: [p('a', 'one'), p('b', 'two', [p('c', 'three')])] };
		const [v, c] = [structuredClone(version), structuredClone(current)];
		versionDiff(version, current);
		expect([version, current]).toEqual([v, c]);
	});

	it('takes proxied inputs, such as a Svelte $state', () => {
		const version = { children: [p('a', 'one')] };
		const current = { children: [p('a', 'two')] };
		const diff = versionDiff(new Proxy(version, {}), new Proxy(current, {}));
		expect(Object.fromEntries(diff.changes)).toEqual({ a: 'changed' });
		expect(diff.preview).toEqual(version);
	});
});
