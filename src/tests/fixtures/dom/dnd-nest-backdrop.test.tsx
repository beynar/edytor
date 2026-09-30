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
 * edge); nearer the left, the lower half is after (at the level whose text
 * column is nearest, for the last block of a nested group).
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
const indicator = () => document.querySelector<HTMLElement>('[data-edytor-drop-indicator]');
const position = () => indicator()?.dataset.position;
/** The block the placement is relative to (`data-edytor-block-drop-position`). */
const indicated = () =>
	document.querySelector<HTMLElement>('[data-edytor-block-drop-position]')?.dataset.edytorId;
/** The bar's layer-relative left and vertical center (the layer sits at 0,0; the bar is 4px). */
const bar = () => {
	const { left, top } = indicator()!.style;
	return { left: parseFloat(left), center: parseFloat(top) + 2 };
};

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

	it("covers a parent's own row, not its children (its lower half: its first child's slot)", async () => {
		const { edytor } = await render([p('a', [p('a1'), p('a2')]), p('x')]);
		const drag = await startDrag(edytor, 'x');
		await drag.over('a', 0.5);
		expect(position()).toBe('before');
		expect(indicated()).toBe('a1');
		expect(backdrop()).toEqual({ id: 'a', box: ['0px', '0px', '600px', '24px'] });
		await drag.drop('a', 0.5);
		expect(tree(edytor)).toEqual([['a', ['x', 'a1', 'a2']]]);
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
		expect(position()).toBe('before');
		expect(indicated()).toBe('a1');
		expect(backdrop()?.id).toBe('a');
		await drag.drop('a', 0.5);
		expect(tree(edytor)).toEqual([['a', ['x', 'a1', 'a2']]]);
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

/**
 * Atlassian's list-item hitbox decides the half (reorder-before or
 * reorder-after, `blocked` when the document refuses every placement of
 * that half), following Pragmatic drag and drop's tree guidance: an
 * expanded block offers no "after" on its own row, and the last block of a
 * nested group reparents to the level the pointer's x picks.
 */
describe('the tree rules on top of the list-item hitbox', () => {
	it("an expanded parent's lower half is its first child's slot, the bar at that child, not below the subtree", async () => {
		const { edytor } = await render([p('a', [p('a1'), p('a2')]), p('b'), p('x')]);
		const drag = await startDrag(edytor, 'x');
		for (const x of [NEAR_LEFT, FAR_RIGHT]) {
			await drag.over('a', 0.75, x);
			expect(position()).toBe('before');
			expect(indicated()).toBe('a1');
			// At a1's top (24px), indented to its column (24px): not at the subtree's end (72px).
			expect(bar()).toEqual({ left: 24, center: 24 });
			expect(backdrop()?.id).toBe('a');
		}
		// Its top half is still before it.
		await drag.over('a', 0.25);
		expect([position(), indicated()]).toEqual(['before', 'a']);
		await drag.over('a', 0.75, NEAR_LEFT);
		await drag.drop('a', 0.75, NEAR_LEFT);
		expect(tree(edytor)).toEqual([['a', ['x', 'a1', 'a2']], 'b']);
	});

	it('a closed toggle is not expanded: its lower half is after it, below its row', async () => {
		const { edytor } = await render([
			{ id: 't', type: 'toggle', content: [{ text: 't' }], children: [p('t1')] },
			p('b'),
			p('x')
		]);
		await flushDomUpdates();
		(edytor.idToBlock.get('t')!.node as HTMLDetailsElement).open = false;
		const drag = await startDrag(edytor, 'x');
		await drag.over('t', 0.75, NEAR_LEFT);
		expect([position(), indicated()]).toEqual(['after', 't']);
		expect(backdrop()).toBeNull();
		await drag.drop('t', 0.75, NEAR_LEFT);
		expect(tree(edytor)).toEqual([['t', ['t1']], 'x', 'b']);
	});

	/** x (a root block) first, then a > b > c > d: d is the last block of every group. */
	const deep = () => [p('x'), p('a', [p('b', [p('c', [p('d')])])])];

	it.each([
		// d's text column (72px), then one nest step left per level: c, b, then the root.
		{ x: 4, level: 'd', parent: 'c', result: [['a', [['b', [['c', ['d', 'x']]]]]]] },
		{ x: -24, level: 'c', parent: 'b', result: [['a', [['b', [['c', ['d']], 'x']]]]] },
		{ x: -48, level: 'b', parent: 'a', result: [['a', [['b', [['c', ['d']]]], 'x']]] },
		{ x: -72, level: 'a', parent: undefined, result: [['a', [['b', [['c', ['d']]]]]], 'x'] }
	])(
		"the last nested block, x at $level's column: after $level",
		async ({ x, level, parent, result }) => {
			const { edytor } = await render(deep());
			const drag = await startDrag(edytor, 'x');
			await drag.over('d', 0.75, x);
			expect([position(), indicated()]).toEqual(['after', level]);
			// Below d's row (it ends at 120px), indented to the level's column.
			const column = edytor.idToBlock.get(level)!.node!.getBoundingClientRect().left;
			expect(bar()).toEqual({ left: column, center: 120 });
			expect(backdrop()?.id).toBe(parent);
			await drag.drop('d', 0.75, x);
			expect(tree(edytor)).toEqual(result);
		}
	);

	it('a level the document refuses gives way to the nearest one that fits', async () => {
		const item = (id: string): JSONBlock => ({ id, type: 'list-item', content: [{ text: id }] });
		const { edytor } = await render([
			p('a', [{ id: 'L', type: 'unordered-list', children: ['one', 'two'].map(item) }]),
			p('x')
		]);
		const drag = await startDrag(edytor, 'x');
		// Just left of two's text, its own level is nearest; but a paragraph never sits
		// in a list, so the drop lands at the next nearest level: after the list, in a.
		await drag.over('two', 0.75, -4);
		expect([position(), indicated()]).toEqual(['after', 'L']);
		expect(backdrop()?.id).toBe('a');
		await drag.drop('two', 0.75, -4);
		expect(tree(edytor)).toEqual([['a', [['L', ['one', 'two']], 'x']]]);
	});

	it('marks a refused half blocked and shows the placement it gives way to', async () => {
		const item = (id: string): JSONBlock => ({ id, type: 'list-item', content: [{ text: id }] });
		const { edytor } = await render([
			{ id: 'L', type: 'unordered-list', children: ['one', 'two'].map(item) },
			p('x')
		]);
		const drag = await startDrag(edytor, 'x');
		// Before an item: a paragraph never sits directly in a list. The lower half nests.
		await drag.over('one', 0.25, FAR_RIGHT);
		expect(indicator()?.dataset.blocked).toBe('true');
		expect([position(), indicated()]).toEqual(['inside', 'one']);
		await drag.over('one', 0.75, FAR_RIGHT);
		expect(indicator()?.dataset.blocked).toBeUndefined();
		expect([position(), indicated()]).toEqual(['inside', 'one']);
		await drag.drop('one', 0.25, FAR_RIGHT);
		expect(tree(edytor)).toEqual([['L', [['one', ['x']], 'two']]]);
	});
});

describe('the handles during a drag', () => {
	it('let the pointer through to the blocks under them, the source handle excepted', async () => {
		const { edytor } = await render([p('a', [p('a1')]), p('x')]);
		const drag = await startDrag(edytor, 'x');
		const host = (id: string) =>
			document.querySelector<HTMLElement>(
				`[data-edytor-block-handle-host][data-block-id="${id}"]`
			)!;
		await flushDomUpdates();
		// a1's handle sits over a's column: a drop level.
		expect(host('a1').dataset.dragging).toBe('true');
		expect(host('a').dataset.dragging).toBe('true');
		// Chrome cancels a drag whose source stops taking the pointer as it starts.
		expect(host('x').dataset.dragging).toBeUndefined();
		await drag.drop('a1', 0.25);
		await flushDomUpdates();
		expect(host('a1').dataset.dragging).toBeUndefined();
	});
});

describe('a group dragged from under its parent', () => {
	it("leaves the block before it last: that block's lower half reaches the parent's level", async () => {
		const { edytor } = await render([p('a', [p('a1'), p('a2')]), p('b')]);
		const drag = await startDrag(edytor, 'a2');
		// At a's column (a1 sits at 24px): after a, a2 outdented.
		await drag.over('a1', 0.75, -24);
		expect([position(), indicated()]).toEqual(['after', 'a']);
		expect(backdrop()).toBeNull();
		await drag.drop('a1', 0.75, -24);
		expect(tree(edytor)).toEqual([['a', ['a1']], 'a2', 'b']);
	});
});

/**
 * A block every shown child of which is dragged shows none: its own row and
 * the gap its children leave under it reparent as the last block of a
 * nested group does, the pointer's x picking the level down to the root.
 * Inside it, they would stay where they are: never offered.
 */
describe('a block whose shown children are all dragged', () => {
	it("the document's last block: its only child moves out after it, to the root", async () => {
		const { edytor } = await render([p('z'), p('a', [p('a1')])]);
		const drag = await startDrag(edytor, 'a1');
		// Its lower half, near the left or far right: after it, never inside it.
		for (const x of [NEAR_LEFT, FAR_RIGHT]) {
			await drag.over('a', 0.75, x);
			expect([position(), indicated()]).toEqual(['after', 'a']);
			expect(backdrop()).toBeNull();
		}
		// Its top half is still before it.
		await drag.over('a', 0.25);
		expect([position(), indicated()]).toEqual(['before', 'a']);
		// Left of a1 (a's column), on its row, then below it.
		for (const at of [0.75, 1.2]) {
			await drag.over('a1', at, -24);
			expect([position(), indicated()]).toEqual(['after', 'a']);
			expect(backdrop()).toBeNull();
		}
		await drag.drop('a1', 1.2, -24);
		expect(tree(edytor)).toEqual(['z', 'a', 'a1']);
	});

	it('a block in the middle of the document: its only child moves out after it', async () => {
		const { edytor } = await render([p('z'), p('a', [p('a1')]), p('b')]);
		const drag = await startDrag(edytor, 'a1');
		await drag.over('a1', 0.75, -24);
		expect([position(), indicated()]).toEqual(['after', 'a']);
		expect(backdrop()).toBeNull();
		await drag.drop('a1', 0.75, -24);
		expect(tree(edytor)).toEqual(['z', 'a', 'a1', 'b']);
	});

	it("the only child of an only child: the pointer's x picks each level, down to the root", async () => {
		const { edytor } = await render([p('z'), p('a', [p('b', [p('c')])])]);
		const drag = await startDrag(edytor, 'c');
		// c's row starts at 48px: b's column is 24px left of it, a's (the root) 48px.
		await drag.over('c', 0.75, -24);
		expect([position(), indicated()]).toEqual(['after', 'b']);
		expect(backdrop()?.id).toBe('a');
		await drag.over('b', 0.75, -24);
		expect([position(), indicated()]).toEqual(['after', 'a']);
		expect(backdrop()).toBeNull();
		await drag.over('c', 0.75, -48);
		expect([position(), indicated()]).toEqual(['after', 'a']);
		await drag.drop('c', 0.75, -48);
		expect(tree(edytor)).toEqual(['z', ['a', ['b']], 'c']);
	});

	it('a group dragging every child of the last block moves out after it', async () => {
		const { edytor } = await render([p('z'), p('a', [p('a1'), p('a2')])]);
		const block = (id: string) => edytor.idToBlock.get(id)!;
		edytor.selection.selectBlocks(block('a1'), block('a2'));
		const drag = await startDrag(edytor, 'a1');
		for (const [target, at, x] of [
			['a', 0.75, NEAR_LEFT],
			['a2', 0.75, -24]
		] as const) {
			await drag.over(target, at, x);
			expect([position(), indicated()]).toEqual(['after', 'a']);
		}
		await drag.drop('a2', 0.75, -24);
		expect(tree(edytor)).toEqual(['z', 'a', 'a1', 'a2']);
	});
});

/**
 * Below the document's last block (Notion): no block is under the pointer,
 * so no drop target is either; the last placement stays — the last block's
 * and its ancestors' targets stick — and the pointer's x still picks its
 * level. Leaving the editor clears it; a row the pointer comes back over
 * takes its own placement.
 */
describe("below the document's last block", () => {
	/** A pointer move over a raw point of `target` (no block under it). */
	const move = async (target: EventTarget, clientX: number, clientY: number) => {
		fire(target, 'dragenter', { clientX, clientY });
		fire(target, 'dragover', { clientX, clientY });
		await frame();
	};
	const bottom = (edytor: Edytor) =>
		edytor.idToBlock.get(edytor.value.children.at(-1)!.id!)!.node!.getBoundingClientRect().bottom;

	it.each([
		// a1's column is 24px, a's (the root) 0px.
		{ x: 46, level: 'a1', parent: 'a', result: [['a', ['a1', 'x']]] },
		{ x: 2, level: 'a', parent: undefined, result: [['a', ['a1']], 'x'] }
	])(
		'a last block with a nested child: 30px below it, x at $level picks after $level',
		async ({ x, level, parent, result }) => {
			const { edytor } = await render([p('x'), p('a', [p('a1')])]);
			const drag = await startDrag(edytor, 'x');
			await drag.over('a1', 0.75, NEAR_LEFT);
			expect([position(), indicated()]).toEqual(['after', 'a1']);
			const below = bottom(edytor) + 30;
			// Both levels in turn, then the one picked: the placement stays, x picks its level.
			for (const [at, id] of [
				[46, 'a1'],
				[2, 'a'],
				[x, level]
			] as const) {
				await move(edytor.node!, at, below);
				expect([position(), indicated()]).toEqual(['after', id]);
			}
			expect(backdrop()?.id).toBe(parent);
			fire(edytor.node!, 'drop', { clientX: x, clientY: below });
			await flushDomUpdates();
			await frame();
			expect(tree(edytor)).toEqual(result);
		}
	);

	it('a flat last block: 30px below it, after it', async () => {
		const { edytor } = await render([p('x'), p('a'), p('b')]);
		const drag = await startDrag(edytor, 'x');
		await drag.over('b', 0.75, NEAR_LEFT);
		expect([position(), indicated()]).toEqual(['after', 'b']);
		const below = bottom(edytor) + 30;
		await move(edytor.node!, NEAR_LEFT, below);
		expect([position(), indicated()]).toEqual(['after', 'b']);
		expect(backdrop()).toBeNull();
		fire(edytor.node!, 'drop', { clientX: NEAR_LEFT, clientY: below });
		await flushDomUpdates();
		await frame();
		expect(tree(edytor)).toEqual(['a', 'b', 'x']);
	});

	it('a row the pointer comes back over takes its placement; leaving the editor clears it', async () => {
		const { edytor } = await render([p('x'), p('a'), p('b', [p('b1')])]);
		const drag = await startDrag(edytor, 'x');
		await drag.over('b1', 0.75, NEAR_LEFT);
		const below = bottom(edytor) + 30;
		await move(edytor.node!, 2, below);
		expect([position(), indicated()]).toEqual(['after', 'b']);
		// Back over a row: that row's placement.
		await drag.over('a', 0.25);
		expect([position(), indicated()]).toEqual(['before', 'a']);
		await drag.over('b1', 0.75, NEAR_LEFT);
		await move(edytor.node!, 2, below);
		expect([position(), indicated()]).toEqual(['after', 'b']);
		// Out of the editor, right of its column: nothing sticks.
		await move(document.body, 700, below);
		expect(indicator()).toBeNull();
		expect(backdrop()).toBeNull();
		expect(document.querySelector('[data-edytor-block-drop-position]')).toBeNull();
		fire(document.body, 'drop', { clientX: 700, clientY: below });
		await flushDomUpdates();
		await frame();
		expect(tree(edytor)).toEqual(['x', 'a', ['b', ['b1']]]);
	});
});

describe('a drag released over its own blocks', () => {
	// The last child of a nested group: every level after it reaches its parent's.
	it.each([
		{ at: 0.25, x: FAR_RIGHT },
		{ at: 0.75, x: FAR_RIGHT },
		{ at: 0.75, x: NEAR_LEFT },
		{ at: 0.5, x: 300 },
		{ at: 0.75, x: -24 }
	])('offers nothing over its own row ($at, x $x): the drop changes nothing', async ({ at, x }) => {
		const { edytor } = await render([p('a', [p('a1'), p('a2')]), p('b')]);
		const drag = await startDrag(edytor, 'a2');
		await drag.over('a2', at, x);
		expect(indicator()).toBeNull();
		expect(backdrop()).toBeNull();
		await drag.drop('a2', at, x);
		expect(tree(edytor)).toEqual([['a', ['a1', 'a2']], 'b']);
	});

	it('offers nothing over its own children: the drop changes nothing', async () => {
		const { edytor } = await render([p('a', [p('a1'), p('a2', [p('a2x')])]), p('b')]);
		const drag = await startDrag(edytor, 'a2');
		for (const [at, x] of [
			[0.25, FAR_RIGHT],
			[0.75, FAR_RIGHT],
			[0.75, -48]
		]) {
			await drag.over('a2x', at, x);
			expect(indicator()).toBeNull();
		}
		await drag.drop('a2x', 0.75, -48);
		expect(tree(edytor)).toEqual([['a', ['a1', ['a2', ['a2x']]]], 'b']);
	});
});
