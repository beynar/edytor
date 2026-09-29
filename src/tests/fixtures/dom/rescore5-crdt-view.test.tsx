/** @jsxImportSource ../../jsx */
/**
 * Re-score 5 view rows for the CRDT units. YW-02, Notion parity for the key
 * path next to a container that renders no content (a structural list):
 * Delete at the end of the block above a list pulls its first item's text
 * up and the list keeps the rest (or goes, emptied); Backspace at the start
 * of a list's first item lifts it out as a paragraph. YW-07: Enter never
 * writes an empty type. Expected states are hand-authored.
 */
import { describe, expect, it } from 'vitest';
import type { JSONBlock } from '$lib/utils/json.js';
import { mentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { imagePlugin } from '$lib/plugins/image/ImagePlugin.svelte';
import {
	dispatchDomBeforeInput,
	dispatchDomKeyDown,
	flushDomUpdates,
	renderDomEdytor,
	setNativeSelection
} from '../../dom/test.utils.js';
import type { EngineDoc, EngineNode } from '$lib/crdt/engine-api.js';

const empty = (
	<root>
		<paragraph>|</paragraph>
	</root>
);

const render = (children: JSONBlock[]) =>
	renderDomEdytor(empty, { plugins: [richTextPlugin, mentionPlugin], value: { children } });
type Mounted = Awaited<ReturnType<typeof render>>;

const text = (value: string) => [{ text: value }];
const seed = (kind: string, items: string[]): JSONBlock[] => [
	{ type: 'paragraph', content: text('p') },
	{ type: kind, children: items.map((i) => ({ type: 'list-item', content: text(i) })) }
];

/** `type "text"` per block, children nested. */
const shape = (edytor: Mounted['edytor']) => {
	const show = (b: JSONBlock): unknown => {
		const own = (b.content ?? []).map((part) => ('text' in part ? part.text : '@')).join('');
		return b.children?.length ? [`${b.type} "${own}"`, b.children.map(show)] : `${b.type} "${own}"`;
	};
	return (edytor.value.children ?? []).map(show);
};
const caret = (edytor: Mounted['edytor']) => {
	const { startBlock, yStart, isCollapsed } = edytor.selection.state;
	return [startBlock?.type, startBlock?.firstText?.stringContent, yStart, isCollapsed];
};

const at = async (edytor: Mounted['edytor'], path: number[], end: boolean) => {
	let block = edytor.root!;
	for (const index of path) block = block.children[index]!;
	const t = end ? block.lastText! : block.firstText!;
	edytor.selection.setAtTextOffset(t, end ? t.length : 0);
	await flushDomUpdates();
};

describe.each(['unordered-list', 'ordered-list'])('YW-02 key path next to a %s', (kind) => {
	it('Delete at the end of the block above pulls the first item up; the list keeps the rest', async () => {
		const { edytor, editor } = await render(seed(kind, ['a', 'b']));
		await at(edytor, [0], true);
		await dispatchDomBeforeInput(editor, { inputType: 'deleteContentForward' });
		expect(shape(edytor)).toEqual(['paragraph "pa"', [`${kind} ""`, ['list-item "b"']]]);
		expect(caret(edytor)).toEqual(['paragraph', 'pa', 1, true]);
	});

	it('Delete above a one-item list pulls the item up; the emptied list goes', async () => {
		const { edytor, editor } = await render(seed(kind, ['a']));
		await at(edytor, [0], true);
		await dispatchDomBeforeInput(editor, { inputType: 'deleteContentForward' });
		expect(shape(edytor)).toEqual(['paragraph "pa"']);
		expect(caret(edytor)).toEqual(['paragraph', 'pa', 1, true]);
	});

	it('Backspace at the start of the first item lifts it out as a paragraph', async () => {
		const { edytor, editor } = await render(seed(kind, ['a', 'b']));
		await at(edytor, [1, 0], false);
		await dispatchDomBeforeInput(editor, { inputType: 'deleteContentBackward' });
		expect(shape(edytor)).toEqual([
			'paragraph "p"',
			'paragraph "a"',
			[`${kind} ""`, ['list-item "b"']]
		]);
		expect(caret(edytor)).toEqual(['paragraph', 'a', 0, true]);
		// The next Backspace merges it into the paragraph above.
		await dispatchDomBeforeInput(editor, { inputType: 'deleteContentBackward' });
		expect(shape(edytor)).toEqual(['paragraph "pa"', [`${kind} ""`, ['list-item "b"']]]);
	});

	it('Backspace at the start of the only item lifts it out; the emptied list goes', async () => {
		const { edytor, editor } = await render(seed(kind, ['a']));
		await at(edytor, [1, 0], false);
		await dispatchDomBeforeInput(editor, { inputType: 'deleteContentBackward' });
		expect(shape(edytor)).toEqual(['paragraph "p"', 'paragraph "a"']);
		expect(caret(edytor)).toEqual(['paragraph', 'a', 0, true]);
	});

	it('Backspace at the start of a middle item still merges into the one above', async () => {
		const { edytor, editor } = await render(seed(kind, ['a', 'b', 'c']));
		await at(edytor, [1, 1], false);
		await dispatchDomBeforeInput(editor, { inputType: 'deleteContentBackward' });
		expect(shape(edytor)).toEqual([
			'paragraph "p"',
			[`${kind} ""`, ['list-item "ab"', 'list-item "c"']]
		]);
		expect(caret(edytor)).toEqual(['list-item', 'ab', 1, true]);
	});

	it('Backspace at the start of the last item outdents it out of the list as a paragraph', async () => {
		const { edytor, editor } = await render(seed(kind, ['a', 'b']));
		await at(edytor, [1, 1], false);
		await dispatchDomBeforeInput(editor, { inputType: 'deleteContentBackward' });
		expect(shape(edytor)).toEqual([
			'paragraph "p"',
			[`${kind} ""`, ['list-item "a"']],
			'paragraph "b"'
		]);
		expect(caret(edytor)).toEqual(['paragraph', 'b', 0, true]);
	});

	it('one undo restores the list after either key', async () => {
		for (const [path, end, inputType] of [
			[[0], true, 'deleteContentForward'],
			[[1, 0], false, 'deleteContentBackward']
		] as const) {
			const { edytor, editor } = await render(seed(kind, ['a']));
			const before = shape(edytor);
			await at(edytor, [...path], end);
			await dispatchDomBeforeInput(editor, { inputType });
			expect(shape(edytor)).not.toEqual(before);
			edytor.historyUndo();
			await flushDomUpdates();
			expect(shape(edytor)).toEqual(before);
		}
	});
});

/**
 * SW8-roles-2: a list left with no item (by concurrent edits) renders
 * nothing and sealed its neighbours; the key that meets it removes it.
 */
describe('SW8-roles-2: the keys remove a list left with no item', () => {
	const seed: JSONBlock[] = [
		{ type: 'paragraph', content: text('p') },
		{ type: 'unordered-list', children: [] },
		{ type: 'paragraph', content: text('z') }
	];
	it('Backspace at the start of the block below', async () => {
		const { edytor, editor } = await render(seed);
		await at(edytor, [2], false);
		await dispatchDomBeforeInput(editor, { inputType: 'deleteContentBackward' });
		expect(shape(edytor)).toEqual(['paragraph "p"', 'paragraph "z"']);
		expect(caret(edytor)).toEqual(['paragraph', 'z', 0, true]);
	});
	it('Delete at the end of the block above', async () => {
		const { edytor, editor } = await render(seed);
		await at(edytor, [0], true);
		await dispatchDomBeforeInput(editor, { inputType: 'deleteContentForward' });
		expect(shape(edytor)).toEqual(['paragraph "p"', 'paragraph "z"']);
		expect(caret(edytor)).toEqual(['paragraph', 'p', 1, true]);
	});
});

/**
 * YW-07: Enter at the end of a block with children (`liftContent`) passed
 * the view's `block.type` as the tail type, which is `''` while a peer's
 * retype is half-delivered; the new block kept `''` on every replica. It now
 * takes the parent's default child (next to DR-crdt-1's duplicate row).
 */
describe('YW-07: Enter at the end of a typeless block with children', () => {
	it('the new block takes its parent’s default child, never an empty type', async () => {
		const { edytor, editor } = await render([
			{
				id: 'Q',
				type: 'quote',
				content: text('q'),
				children: [
					{
						id: 'A',
						type: 'paragraph',
						content: text('hello'),
						children: [{ id: 'A1', type: 'paragraph', content: text('a1') }]
					}
				]
			}
		]);
		// The transient state: the attr's current value deleted, its replacement not yet here.
		const nodeOf = (id: string): EngineNode => {
			const node = edytor.facade.model.blockNodeOf(edytor.doc as unknown as EngineDoc, id);
			if (node === null) throw new Error(`no block node for ${id}`);
			return node;
		};
		nodeOf('A').deleteAttr('type');
		await flushDomUpdates();
		const a = edytor.idToBlock.get('A')!;
		edytor.selection.setAtTextOffset(a.lastText!, 5);
		await flushDomUpdates();
		await dispatchDomBeforeInput(editor, { inputType: 'insertParagraph' });
		const born = edytor.facade.order().filter((id) => !['Q', 'A', 'A1'].includes(id));
		expect(born).toHaveLength(1);
		expect(nodeOf(born[0]!).getAttr('type')).toBe('paragraph');
	});
});

/**
 * DR-crdt-3: Shift+Tab handed the items after the outdented item to it,
 * now a paragraph: bare items under it, no list. The list now splits
 * around it (Notion).
 */
describe.each(['unordered-list', 'ordered-list'])('DR-crdt-3 key path in a %s', (kind) => {
	it('Shift+Tab on a middle item → a paragraph between two lists of that kind', async () => {
		const { edytor, editor } = await render(seed(kind, ['a', 'b', 'c']));
		await at(edytor, [1, 1], false);
		await dispatchDomKeyDown(editor, { key: 'Tab', code: 'Tab', shiftKey: true });
		await flushDomUpdates();
		expect(shape(edytor)).toEqual([
			'paragraph "p"',
			[`${kind} ""`, ['list-item "a"']],
			'paragraph "b"',
			[`${kind} ""`, ['list-item "c"']]
		]);
		expect(caret(edytor)).toEqual(['paragraph', 'b', 0, true]);
		edytor.historyUndo();
		await flushDomUpdates();
		expect(shape(edytor)).toEqual([
			'paragraph "p"',
			[`${kind} ""`, ['list-item "a"', 'list-item "b"', 'list-item "c"']]
		]);
	});
});

/**
 * DR-crdt-4: a selection across the seam above a list (Shift+Right at the
 * end of the paragraph, then Delete, Backspace or a typed character)
 * dissolved the list; it now agrees with the Delete key.
 */
describe.each(['unordered-list', 'ordered-list'])('DR-crdt-4 seam range above a %s', (kind) => {
	for (const [name, input] of [
		['Delete', { inputType: 'deleteContentForward' }],
		['Backspace', { inputType: 'deleteContentBackward' }],
		['typing', { inputType: 'insertText', data: 'x' }]
	] as const)
		it(`${name} → the first item's text joins the paragraph; the list keeps the rest`, async () => {
			const { edytor, editor } = await render(seed(kind, ['a', 'b']));
			const p = edytor.root!.children[0]!.firstText!;
			const a = edytor.root!.children[1]!.children[0]!.firstText!;
			await setNativeSelection(edytor, p, 1, a, 0);
			await dispatchDomBeforeInput(editor, input);
			await flushDomUpdates();
			const joined = name === 'typing' ? 'pxa' : 'pa';
			expect(shape(edytor)).toEqual([`paragraph "${joined}"`, [`${kind} ""`, ['list-item "b"']]]);
		});
});

/**
 * ZW-01 (re-score 6): nothing but an item lands directly in a list. A block
 * a key sheds into a list becomes its item; Tab after a list nests under
 * its last item (Notion). Hand-authored from the unit's "Done when".
 */
describe('ZW-01: the keys never leave a non-item directly in a list', () => {
	const li = (value: string, children?: JSONBlock[]): JSONBlock => ({
		type: 'list-item',
		content: text(value),
		...(children && { children })
	});
	const p = (value: string, children?: JSONBlock[]): JSONBlock => ({
		type: 'paragraph',
		content: text(value),
		...(children && { children })
	});
	const ul = (...items: JSONBlock[]): JSONBlock => ({ type: 'unordered-list', children: items });

	it('Delete above a list whose first item has a paragraph child → the child is an item', async () => {
		const { edytor, editor } = await render([p('p'), ul(li('a', [p('child')]), li('b'))]);
		await at(edytor, [0], true);
		await dispatchDomBeforeInput(editor, { inputType: 'deleteContentForward' });
		expect(shape(edytor)).toEqual([
			'paragraph "pa"',
			['unordered-list ""', ['list-item "child"', 'list-item "b"']]
		]);
	});

	it('…and above a one-item list → the list keeps the child as its item', async () => {
		const { edytor, editor } = await render([p('p'), ul(li('a', [p('child')]))]);
		await at(edytor, [0], true);
		await dispatchDomBeforeInput(editor, { inputType: 'deleteContentForward' });
		expect(shape(edytor)).toEqual(['paragraph "pa"', ['unordered-list ""', ['list-item "child"']]]);
	});

	it('Backspace at a middle item with a paragraph child → the child is an item', async () => {
		const { edytor, editor } = await render([p('p'), ul(li('a'), li('b', [p('child')]), li('c'))]);
		await at(edytor, [1, 1], false);
		await dispatchDomBeforeInput(editor, { inputType: 'deleteContentBackward' });
		expect(shape(edytor)).toEqual([
			'paragraph "p"',
			['unordered-list ""', ['list-item "ab"', 'list-item "child"', 'list-item "c"']]
		]);
	});

	it('Backspace at a paragraph nested last under the last item → an item of the list', async () => {
		const { edytor, editor } = await render([p('p'), ul(li('a', [p('x')]))]);
		await at(edytor, [1, 0, 0], false);
		await dispatchDomBeforeInput(editor, { inputType: 'deleteContentBackward' });
		expect(shape(edytor)).toEqual([
			'paragraph "p"',
			['unordered-list ""', ['list-item "a"', 'list-item "x"']]
		]);
	});

	it('Tab on a paragraph after a list → it nests under the last item; one undo restores', async () => {
		const { edytor } = await render([p('p'), ul(li('a'), li('b')), p('q')]);
		const before = shape(edytor);
		await at(edytor, [2], false);
		await dispatchDomKeyDown(document, { key: 'Tab', code: 'Tab' });
		expect(shape(edytor)).toEqual([
			'paragraph "p"',
			['unordered-list ""', ['list-item "a"', ['list-item "b"', ['paragraph "q"']]]]
		]);
		edytor.historyUndo();
		await flushDomUpdates();
		expect(shape(edytor)).toEqual(before);
	});

	it('Tab over two paragraphs after a list → both nest under the last item', async () => {
		const { edytor } = await render([p('p'), ul(li('a'), li('b')), p('q'), p('r')]);
		const [q, r] = edytor.root!.children.slice(2);
		edytor.selection.setAtRange(q!.firstText!, 0, r!.firstText!, 1);
		await flushDomUpdates();
		await dispatchDomKeyDown(document, { key: 'Tab', code: 'Tab' });
		expect(shape(edytor)).toEqual([
			'paragraph "p"',
			[
				'unordered-list ""',
				['list-item "a"', ['list-item "b"', ['paragraph "q"', 'paragraph "r"']]]
			]
		]);
	});
});

/**
 * DR-crdt-1/2 (follow-up review of ZW-01): the outdent's answer is one —
 * the move command's `out` step (a text range plus Shift+Tab, the block
 * handle's Alt+ArrowLeft, `canMoveBlocks`) asks the outdent plan itself, so
 * a paragraph under an item outdents into the list as its item on every
 * path. An image nested under a bullet stays an image when a key sheds it
 * into the list. Hand-authored.
 */
describe('DR-crdt-1/2: outdent and shed blocks next to a list, on every path', () => {
	const li = (value: string, children?: JSONBlock[]): JSONBlock => ({
		type: 'list-item',
		content: text(value),
		...(children && { children })
	});
	const p = (value: string): JSONBlock => ({ type: 'paragraph', content: text(value) });
	const ul = (...items: JSONBlock[]): JSONBlock => ({ type: 'unordered-list', children: items });
	const outdented = [
		'paragraph "p"',
		['unordered-list ""', ['list-item "a"', 'list-item "x"', 'list-item "y"']]
	];

	it('Shift+Tab over two paragraphs under an item → both are items of the list', async () => {
		const { edytor } = await render([p('p'), ul(li('a', [p('x'), p('y')]))]);
		const [x, y] = edytor.root!.children[1]!.children[0]!.children;
		edytor.selection.setAtRange(x!.firstText!, 0, y!.firstText!, 1);
		await flushDomUpdates();
		await dispatchDomKeyDown(document, { key: 'Tab', code: 'Tab', shiftKey: true });
		expect(shape(edytor)).toEqual(outdented);
	});

	it('canMoveBlocks/moveBlocks `out` agree with Shift+Tab on one such paragraph', async () => {
		const { edytor } = await render([p('p'), ul(li('a', [p('x')]))]);
		const x = edytor.root!.children[1]!.children[0]!.children[0]!;
		expect(edytor.canMoveBlocks({ blocks: [x], direction: 'out' })).toBe(true);
		expect(edytor.moveBlocks({ blocks: [x], direction: 'out' })).toHaveLength(1);
		await flushDomUpdates();
		expect(shape(edytor)).toEqual([
			'paragraph "p"',
			['unordered-list ""', ['list-item "a"', 'list-item "x"']]
		]);
	});

	it('Backspace at a bullet with an image child → the image still renders', async () => {
		const { edytor, editor } = await renderDomEdytor(empty, {
			plugins: [richTextPlugin, mentionPlugin, imagePlugin],
			value: {
				children: [
					p('p'),
					ul(li('a'), li('b', [{ type: 'image', data: { src: 'https://x.test/a.png' } }]), li('c'))
				]
			}
		});
		expect(editor.querySelectorAll('[data-edytor-image]')).toHaveLength(1);
		await at(edytor, [1, 1], false);
		await dispatchDomBeforeInput(editor, { inputType: 'deleteContentBackward' });
		expect(shape(edytor)).toEqual([
			'paragraph "p"',
			['unordered-list ""', ['list-item "ab"', 'image ""', 'list-item "c"']]
		]);
		expect(editor.querySelectorAll('[data-edytor-image]')).toHaveLength(1);
		const image = edytor.root!.children[1]!.children[1]!;
		expect(image.value.data).toEqual({ src: 'https://x.test/a.png' });
	});
});
