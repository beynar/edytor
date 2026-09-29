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
