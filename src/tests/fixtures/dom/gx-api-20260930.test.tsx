/** @jsxImportSource ../../jsx */
/**
 * Wave 16 (`docs/reviews/2026-09-30-rescore-13.md`), public API units:
 * `edytor.moveBlocks` `in`/`out` over siblings with an unselected block
 * between them moves each run of adjacent siblings on its own, as Tab and
 * Shift+Tab do, so the text keeps its order (GX-05); a throwing
 * `edytor.transact` keeps its writes and still normalizes them (GX-07).
 * Expected states are hand-authored.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Plugin } from '$lib/plugins.js';
import type { JSONBlock } from '$lib/utils/json.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { flushDomUpdates, renderDomEdytor } from '../../dom/test.utils.js';

afterEach(() => {
	document.body.innerHTML = '';
});

const render = (children: JSONBlock[], plugins: Plugin[] = [richTextPlugin]) =>
	renderDomEdytor(
		<root>
			<paragraph>|</paragraph>
		</root>,
		{ plugins, value: { children } }
	);
type View = Awaited<ReturnType<typeof render>>;

const block = (type: string, id: string, children?: JSONBlock[]): JSONBlock => ({
	id,
	type,
	content: [{ text: id }],
	...(children && { children })
});
const p = (id: string, children?: JSONBlock[]) => block('paragraph', id, children);
const li = (id: string) => block('list-item', id);
const ul = (id: string, children: JSONBlock[]): JSONBlock => ({
	id,
	type: 'unordered-list',
	children
});
const shape = ({ edytor }: View) => {
	const show = (b: JSONBlock): unknown => {
		const own = (b.content ?? []).map((part) => ('text' in part ? part.text : '@')).join('');
		const line = `${b.type} "${own}"`;
		return b.children?.length ? [line, b.children.map(show)] : line;
	};
	return (edytor.value.children ?? []).map(show);
};
const blocks = ({ edytor }: View, ...ids: string[]) => ids.map((id) => edytor.idToBlock.get(id)!);

describe('GX-05: moveBlocks in/out over a gap moves each run on its own, never reordering', () => {
	it('out of a list: [a, c] of [a..e] leaves b between them', async () => {
		const view = await render([p('p'), ul('u', ['a', 'b', 'c', 'd', 'e'].map(li)), p('q')]);
		const request = { blocks: blocks(view, 'a', 'c'), direction: 'out' as const };
		expect(view.edytor.canMoveBlocks(request)).toBe(true);
		const moved = view.edytor.moveBlocks(request);
		expect(moved.map((b) => b.id)).toEqual(['a', 'c']);
		expect(shape(view)).toEqual([
			'paragraph "p"',
			'paragraph "a"',
			['unordered-list ""', ['list-item "b"']],
			'paragraph "c"',
			['unordered-list ""', ['list-item "d"', 'list-item "e"']],
			'paragraph "q"'
		]);
		expect(view.edytor.dispatcher.last?.status).toBe('applied');
		view.edytor.historyUndo();
		await flushDomUpdates();
		expect(shape(view), 'one undo step').toEqual([
			'paragraph "p"',
			[
				'unordered-list ""',
				['list-item "a"', 'list-item "b"', 'list-item "c"', 'list-item "d"', 'list-item "e"']
			],
			'paragraph "q"'
		]);
	});

	it('out of a paragraph: each run adopts only the siblings after it', async () => {
		const view = await render([
			p(
				'p',
				['a', 'b', 'c', 'd'].map((id) => p(id))
			)
		]);
		view.edytor.moveBlocks({ blocks: blocks(view, 'a', 'c'), direction: 'out' });
		expect(shape(view)).toEqual([
			'paragraph "p"',
			['paragraph "a"', ['paragraph "b"']],
			['paragraph "c"', ['paragraph "d"']]
		]);
	});

	it('in: [a, c] nest under x and b, so b stays between them', async () => {
		const view = await render(['x', 'a', 'b', 'c', 'd'].map((id) => p(id)));
		const moved = view.edytor.moveBlocks({ blocks: blocks(view, 'c', 'a'), direction: 'in' });
		expect(moved.map((b) => b.id)).toEqual(['a', 'c']);
		expect(shape(view)).toEqual([
			['paragraph "x"', ['paragraph "a"']],
			['paragraph "b"', ['paragraph "c"']],
			'paragraph "d"'
		]);
	});

	it('a run that cannot move stays; the others move (as Tab does)', async () => {
		const view = await render(['a', 'b', 'c'].map((id) => p(id)));
		const request = { blocks: blocks(view, 'a', 'c'), direction: 'in' as const };
		expect(view.edytor.canMoveBlocks(request)).toBe(true);
		expect(view.edytor.moveBlocks(request).map((b) => b.id)).toEqual(['c']);
		expect(shape(view)).toEqual(['paragraph "a"', ['paragraph "b"', ['paragraph "c"']]]);
	});

	it('a block listed twice moves once', async () => {
		const view = await render([p('p', [p('a'), p('b')])]);
		const [a] = blocks(view, 'a');
		expect(view.edytor.moveBlocks({ blocks: [a!, a!], direction: 'out' }).map((b) => b.id)).toEqual(
			['a']
		);
		expect(shape(view)).toEqual(['paragraph "p"', ['paragraph "a"', ['paragraph "b"']]]);
	});

	it('adjacent siblings still move as one group, and siblings of two parents are refused', async () => {
		const view = await render([p('x'), p('a'), p('b', [p('c')])]);
		expect(view.edytor.canMoveBlocks({ blocks: blocks(view, 'a', 'c'), direction: 'in' })).toBe(
			false
		);
		view.edytor.moveBlocks({ blocks: blocks(view, 'a', 'b'), direction: 'in' });
		expect(shape(view)).toEqual([
			['paragraph "x"', ['paragraph "a"', ['paragraph "b"', ['paragraph "c"']]]]
		]);
	});
});

describe('GX-07: a throwing edytor.transact keeps its writes and normalizes them', () => {
	it('the normalization a write requested runs before the throw leaves', async () => {
		const normalized: string[] = [];
		const spy: Plugin = (editor) => {
			const defs = richTextPlugin(editor);
			const paragraph = defs.blocks!.paragraph!;
			defs.blocks!.paragraph = {
				...paragraph,
				normalizeContent: ({ block }) => void normalized.push(block.id)
			};
			return defs;
		};
		const view = await render([p('a')], [spy]);
		const [a] = blocks(view, 'a');
		expect(() =>
			view.edytor.transact(() => {
				a.setBlock({ value: { data: { y: 2 } } });
				throw new Error('fn failed');
			})
		).toThrow('fn failed');
		expect(a.data).toEqual({ y: 2 });
		expect(normalized).toEqual(['a']);
		// The view is not left inside a transaction: a later write normalizes too.
		a.setBlock({ value: { data: { y: 3 } } });
		expect(normalized).toEqual(['a', 'a']);
	});

	it("a normalizer that then throws is logged: the caller's error is the one that surfaces (DR-rest-2)", async () => {
		const spy: Plugin = (editor) => {
			const defs = richTextPlugin(editor);
			const paragraph = defs.blocks!.paragraph!;
			defs.blocks!.paragraph = {
				...paragraph,
				normalizeContent: ({ block }) => {
					if ((block.data as { y?: number }).y === 2) throw new Error('normalizer failed');
				}
			};
			return defs;
		};
		const view = await render([p('a')], [spy]);
		const [a] = blocks(view, 'a');
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		expect(() =>
			view.edytor.transact(() => {
				a.setBlock({ value: { data: { y: 2 } } });
				throw new Error('fn failed');
			})
		).toThrow('fn failed');
		expect(String(logged.mock.calls.at(-1)?.[1])).toBe('Error: normalizer failed');
		logged.mockRestore();
		// Without a caller's error, the normalizer's own surfaces.
		expect(() => view.edytor.transact(() => a.setBlock({ value: { data: { y: 2 } } }))).toThrow(
			'normalizer failed'
		);
	});
});
