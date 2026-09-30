/** @jsxImportSource ../../jsx */
/**
 * The nest backdrop (Notion): while a drop will nest the dragged blocks in
 * another block — an `inside` placement, or a before/after placement among
 * the children of a block that is not already their parent — that future
 * parent's own row gets a soft rounded tint, drawn by the overlay layer next
 * to the drop line (`[data-edytor-drop-backdrop]`, `data-shown` while it
 * applies), never by styling the block. It follows the placement and hides
 * for a plain before/after drop; the drop commits the placement it showed.
 * Driven through the real drag library's native events over a laid-out
 * block stack (jsdom has no layout). Expected states are hand-authored.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { JSONBlock } from '$lib/utils/json.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import { mentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { blockHandlesPlugin } from '$lib/plugins/blockHandles/blockHandlesPlugin.js';
import { HIDDEN } from '$lib/selection/visibility.js';
import { flushDomUpdates, renderDomEdytor } from '../../dom/test.utils.js';

afterEach(() => {
	// A drag a failed test left open would swallow the next test's.
	window.dispatchEvent(new MouseEvent('dragend', { bubbles: true }));
	document.body.innerHTML = '';
});

const ROW = 24;

const p = (id: string, children?: JSONBlock[]): JSONBlock => ({
	id,
	type: 'paragraph',
	content: [{ text: id }],
	...(children && { children })
});

const render = (children: JSONBlock[]) =>
	renderDomEdytor(
		<root>
			<paragraph>|</paragraph>
		</root>,
		{ plugins: [richTextPlugin, mentionPlugin, blockHandlesPlugin], value: { children } }
	);

/** Shown blocks as 24px rows; a block's box runs to the end of its shown descendants, 24px in per level. */
const layout = () => {
	const blocks = [...document.querySelectorAll<HTMLElement>('[data-edytor-block="true"]')];
	const shown = blocks.filter((node) => !node.closest(HIDDEN));
	for (const node of blocks) {
		const index = shown.indexOf(node);
		let depth = 0;
		for (let up = node.parentElement?.closest('[data-edytor-block="true"]'); up; )
			[depth, up] = [depth + 1, up.parentElement?.closest('[data-edytor-block="true"]')];
		const inner = shown.filter((other) => other !== node && node.contains(other)).length;
		const rect =
			index < 0
				? new DOMRect(0, 0, 0, 0)
				: new DOMRect(depth * ROW, index * ROW, 600 - depth * ROW, (inner + 1) * ROW);
		node.getBoundingClientRect = () => rect;
	}
};

const fire = (
	target: EventTarget,
	type: string,
	at: { clientX?: number; clientY?: number } = {}
) => {
	const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...at });
	const store: Record<string, string> = {};
	Object.defineProperty(event, 'dataTransfer', {
		value: {
			setData: (key: string, value: string) => (store[key] = value),
			getData: (key: string) => store[key] ?? '',
			get types() {
				return Object.keys(store);
			},
			setDragImage: () => {},
			dropEffect: 'move',
			effectAllowed: 'all',
			items: [],
			files: []
		}
	});
	target.dispatchEvent(event);
};
const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

/** A drag of `source`'s handle, moved over rows (`at`: 0 top … 1 bottom of the target's own row). */
const startDrag = async (edytor: Edytor, source: string) => {
	await flushDomUpdates();
	layout();
	const handle = document.querySelector<HTMLElement>(
		`[data-testid="block-handle"][data-block-id="${source}"]`
	)!;
	fire(handle, 'dragstart');
	await frame();
	/** `at`: 0 top … 1 bottom of the row; `x`: px right of the block's left edge. */
	const point = (target: string, at: number, x: number) => {
		const rect = edytor.idToBlock.get(target)!.node!.getBoundingClientRect();
		return { clientX: rect.left + x, clientY: rect.top + at * ROW };
	};
	return {
		over: async (target: string, at: number, x = FAR_RIGHT) => {
			const node = edytor.idToBlock.get(target)!.node!;
			fire(node, 'dragenter', point(target, at, x));
			fire(node, 'dragover', point(target, at, x));
			await frame();
		},
		drop: async (target: string, at: number, x = FAR_RIGHT) => {
			fire(edytor.idToBlock.get(target)!.node!, 'drop', point(target, at, x));
			await flushDomUpdates();
			await frame();
		}
	};
};

/**
 * Pointer x offsets from a block's left edge. The nest threshold is one step
 * (24px) right of the block's text start (jsdom has no text rects: its left
 * edge); a nested block's first 20px are its outdent gutter.
 */
const FAR_RIGHT = 100;
const NEAR_LEFT = 22;

/** The shown backdrop: the future parent's id and its layer-relative box (the layer sits at 0,0). */
const backdrop = () => {
	const node = document.querySelector<HTMLElement>(
		'[data-edytor-drop-backdrop][data-shown="true"]'
	);
	if (!node) return null;
	const { left, top, width, height } = node.style;
	return { id: node.dataset.blockId, box: [left, top, width, height] };
};
const position = () =>
	document.querySelector<HTMLElement>('[data-edytor-drop-indicator]')?.dataset.position;

const tree = (edytor: Edytor) => {
	const walk = (children: JSONBlock[] = []): unknown[] =>
		children.map((block) => (block.children?.length ? [block.id, walk(block.children)] : block.id));
	return walk(edytor.value.children);
};

describe('the nest backdrop', () => {
	it("tints the future parent's row for an inside drop, from the overlay layer", async () => {
		const { edytor } = await render([p('a'), p('b'), p('c'), p('x')]);
		const drag = await startDrag(edytor, 'x');
		await drag.over('b', 0.5);

		expect(position()).toBe('inside');
		expect(backdrop()).toEqual({ id: 'b', box: ['0px', '24px', '600px', '24px'] });
		// Drawn by the overlay layer, never by styling the block.
		const node = document.querySelector('[data-edytor-drop-backdrop]')!;
		expect(node.parentElement?.hasAttribute('data-edytor-overlay')).toBe(true);
		expect(edytor.idToBlock.get('b')!.node!.style.background).toBe('');

		await drag.drop('b', 0.5);
		expect(tree(edytor)).toEqual(['a', ['b', ['x']], 'c']);
		expect(document.querySelector('[data-edytor-drop-backdrop]')).toBeNull();
	});

	it('shows no backdrop for a plain before or after drop', async () => {
		const { edytor } = await render([p('a'), p('b'), p('c'), p('x')]);
		const drag = await startDrag(edytor, 'x');
		await drag.over('b', 0.05);
		expect(position()).toBe('before');
		expect(backdrop()).toBeNull();
		await drag.over('c', 0.95, NEAR_LEFT);
		expect(position()).toBe('after');
		expect(backdrop()).toBeNull();
		await drag.drop('c', 0.95, NEAR_LEFT);
		expect(tree(edytor)).toEqual(['a', 'b', 'c', 'x']);
	});

	it('follows the placement as it changes, and the drop commits the one shown', async () => {
		const { edytor } = await render([p('a'), p('b'), p('c'), p('x')]);
		const drag = await startDrag(edytor, 'x');
		await drag.over('b', 0.5);
		expect(backdrop()?.id).toBe('b');
		await drag.over('c', 0.5);
		expect(backdrop()).toEqual({ id: 'c', box: ['0px', '48px', '600px', '24px'] });
		await drag.over('c', 0.05);
		expect(position()).toBe('before');
		expect(backdrop()).toBeNull();
		await drag.over('a', 0.5);
		expect(backdrop()?.id).toBe('a');
		await drag.drop('a', 0.5);
		expect(tree(edytor)).toEqual([['a', ['x']], 'b', 'c']);
	});

	it("covers a parent's own row, not its children", async () => {
		const { edytor } = await render([p('a', [p('a1'), p('a2')]), p('x')]);
		const drag = await startDrag(edytor, 'x');
		await drag.over('a', 0.5);
		expect(position()).toBe('inside');
		expect(backdrop()).toEqual({ id: 'a', box: ['0px', '0px', '600px', '24px'] });
		await drag.drop('a', 0.5);
		expect(tree(edytor)).toEqual([['a', ['a1', 'a2', 'x']]]);
	});

	it("reaches a parent's own row from below: its child's placement does not stick there", async () => {
		const { edytor } = await render([p('a', [p('a1'), p('a2')]), p('x')]);
		const drag = await startDrag(edytor, 'x');
		await drag.over('a1', 0.5);
		expect(backdrop()?.id).toBe('a1');
		// The pointer on a's own row, 12px above a1: inside a1's sticky band.
		const text = edytor.idToBlock.get('a')!.firstText!.node!;
		const hit = document.elementFromPoint;
		document.elementFromPoint = () => text as Element;
		try {
			await drag.over('a', 0.5);
		} finally {
			document.elementFromPoint = hit;
		}
		expect(position()).toBe('inside');
		expect(backdrop()?.id).toBe('a');
		await drag.drop('a', 0.5);
		expect(tree(edytor)).toEqual([['a', ['a1', 'a2', 'x']]]);
	});

	it("keeps the first item's placement across its list's top padding: a list has no row of its own", async () => {
		const item = (id: string): JSONBlock => ({ id, type: 'list-item', content: [{ text: id }] });
		const { edytor } = await render([
			p('x'),
			{ id: 'L', type: 'unordered-list', children: ['one', 'two', 'three'].map(item) }
		]);
		const drag = await startDrag(edytor, 'three');
		// A padded list (the Notion theme pads every block): its box starts 4px above its first item.
		const list = edytor.idToBlock.get('L')!.node!;
		const one = edytor.idToBlock.get('one')!.node!.getBoundingClientRect();
		const box = list.getBoundingClientRect();
		const padded = new DOMRect(box.left, one.top - 4, box.width, box.bottom - one.top + 4);
		list.getBoundingClientRect = () => padded;
		await drag.over('one', 0.05);
		expect(position()).toBe('before');
		const indicated = () =>
			document.querySelector<HTMLElement>('[data-edytor-block-drop-position]')?.dataset.edytorId;
		expect(indicated()).toBe('one');
		// Overshooting the first item into the list's padding, where a browser hits the list.
		const hit = document.elementFromPoint;
		document.elementFromPoint = () => list as Element;
		try {
			for (const above of [3, 0.2]) {
				const at = { clientX: one.left + 100, clientY: one.top - above };
				fire(list, 'dragenter', at);
				fire(list, 'dragover', at);
				await frame();
				expect(position()).toBe('before');
				expect(indicated()).toBe('one');
			}
			fire(list, 'drop', { clientX: one.left + 100, clientY: one.top - 0.2 });
			await flushDomUpdates();
			await frame();
		} finally {
			document.elementFromPoint = hit;
		}
		expect(tree(edytor)).toEqual(['x', ['L', ['three', 'one', 'two']]]);
	});

	it('tints the parent a before/after drop brings the blocks into', async () => {
		const { edytor } = await render([p('a', [p('a1'), p('a2')]), p('x')]);
		const drag = await startDrag(edytor, 'x');
		await drag.over('a1', 0.95, NEAR_LEFT);
		expect(position()).toBe('after');
		expect(backdrop()?.id).toBe('a');
		await drag.drop('a1', 0.95, NEAR_LEFT);
		expect(tree(edytor)).toEqual([['a', ['a1', 'x', 'a2']]]);
	});

	it('shows none for a reorder among the same parent’s children', async () => {
		const { edytor } = await render([p('a', [p('a1'), p('a2')]), p('x')]);
		const drag = await startDrag(edytor, 'a2');
		await drag.over('a1', 0.05);
		expect(position()).toBe('before');
		expect(backdrop()).toBeNull();
		await drag.drop('a1', 0.05);
		expect(tree(edytor)).toEqual([['a', ['a2', 'a1']], 'x']);
	});

	it('tints the item a drop inside a list nests under (its last item)', async () => {
		const { edytor } = await render([
			{
				id: 'L',
				type: 'unordered-list',
				children: ['one', 'two'].map((id) => ({
					id,
					type: 'list-item',
					content: [{ text: id }]
				}))
			},
			p('x')
		]);
		const drag = await startDrag(edytor, 'x');
		await drag.over('L', 0.5);
		expect(position()).toBe('inside');
		expect(backdrop()?.id).toBe('two');
		await drag.drop('L', 0.5);
		expect(tree(edytor)).toEqual([['L', ['one', ['two', ['x']]]]]);
	});

	it('takes its color from --edytor-drop-backdrop-color', async () => {
		const { edytor } = await render([p('a'), p('b'), p('x')]);
		edytor.idToBlock.get('b')!.node!.style.setProperty('--edytor-drop-backdrop-color', 'red');
		const drag = await startDrag(edytor, 'x');
		await drag.over('b', 0.5);
		const node = document.querySelector<HTMLElement>('[data-edytor-drop-backdrop]')!;
		expect(node.style.getPropertyValue('--edytor-drop-backdrop-color')).toBe('red');
		await drag.drop('b', 0.5);
	});
});

describe("Notion's drop zones: the row's halves, and a nest threshold", () => {
	it('the lower half near the left places after, as a sibling, with no backdrop', async () => {
		const { edytor } = await render([p('a'), p('b'), p('x')]);
		const drag = await startDrag(edytor, 'x');
		await drag.over('a', 0.55, NEAR_LEFT);
		expect(position()).toBe('after');
		expect(backdrop()).toBeNull();
		await drag.drop('a', 0.55, NEAR_LEFT);
		expect(tree(edytor)).toEqual(['a', 'x', 'b']);
	});

	it('the lower half right of the threshold nests, with the backdrop shown', async () => {
		const { edytor } = await render([p('a'), p('b'), p('x')]);
		const drag = await startDrag(edytor, 'x');
		// Just past one step right of the text start: 24px.
		await drag.over('a', 0.55, 25);
		expect(position()).toBe('inside');
		expect(backdrop()?.id).toBe('a');
		// Back left of it, the same half: a sibling again.
		await drag.over('a', 0.9, 23);
		expect(position()).toBe('after');
		expect(backdrop()).toBeNull();
		await drag.over('a', 0.9, 40);
		expect(position()).toBe('inside');
		await drag.drop('a', 0.9, 40);
		expect(tree(edytor)).toEqual([['a', ['x']], 'b']);
	});

	it('the top half places before, however far right', async () => {
		const { edytor } = await render([p('a'), p('b'), p('x')]);
		const drag = await startDrag(edytor, 'x');
		for (const x of [NEAR_LEFT, FAR_RIGHT, 400]) {
			await drag.over('b', 0.45, x);
			expect(position()).toBe('before');
			expect(backdrop()).toBeNull();
		}
		await drag.drop('b', 0.45, 400);
		expect(tree(edytor)).toEqual(['a', 'x', 'b']);
	});

	it('a block that cannot hold children never nests: past the threshold it is after', async () => {
		const { edytor } = await render([
			p('a'),
			{ id: 'hr', type: 'divider', content: [], children: [] },
			p('x')
		]);
		const drag = await startDrag(edytor, 'x');
		await drag.over('hr', 0.9, FAR_RIGHT);
		expect(position()).toBe('after');
		expect(backdrop()).toBeNull();
		await drag.drop('hr', 0.9, FAR_RIGHT);
		expect(tree(edytor)).toEqual(['a', 'hr', 'x']);
	});
});
