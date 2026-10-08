/** @jsxImportSource ../../jsx */
/**
 * Re-score 13, selection units. Expected states are hand-authored from the
 * contract rows (`sel.blocks.exact`, `sel.shown`) and Notion.
 *
 * - GX-03: `setAtBlockRange()` over a list or a code block selects across its
 *   items or lines, and leaving a block selection (`selectBlocks()`) spans
 *   what it showed: a list's items, and a leading divider (the range starts
 *   at the end of the line before it, so it still covers it).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { JSONBlock } from '$lib/utils/json.js';
import { codePlugin } from '$lib/plugins/code/CodePlugin.svelte';
import { mentionPlugin } from '../../atMention.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import {
	dispatchClipboardPaste,
	dispatchCut,
	dispatchDomKeyDown,
	flushDomUpdates,
	renderDomEdytor,
	setNativeSelection
} from '../../dom/test.utils.js';
import { expectNoHiddenContent } from './invariants.js';

afterEach(() => {
	document.body.innerHTML = '';
});

const p = (id: string, text = id): JSONBlock => ({ id, type: 'paragraph', content: [{ text }] });
const children: JSONBlock[] = [
	p('a'),
	{
		id: 'L',
		type: 'unordered-list',
		children: [
			{ id: 'one', type: 'list-item', content: [{ text: 'one' }] },
			{ id: 'two', type: 'list-item', content: [{ text: 'two' }] }
		]
	},
	{
		id: 'C',
		type: 'code',
		children: [
			{ id: 'l1', type: 'codeLine', content: [{ text: 'let a' }] },
			{ id: 'l2', type: 'codeLine', content: [{ text: 'let bc' }] }
		]
	},
	p('x'),
	{ id: 'd', type: 'divider' },
	p('after')
];

const render = () =>
	renderDomEdytor(
		<root>
			<paragraph>|</paragraph>
		</root>,
		{ plugins: [richTextPlugin, mentionPlugin, codePlugin], value: { children } }
	);

/** The selection as `block@offset…block@offset` (text ends), or `blocks:…`. */
const shape = (edytor: Edytor) => {
	const { value } = edytor.selection;
	if (value.kind === 'blocks') return `blocks:${value.ids.join(',')}`;
	const { startText, endText, yStart, yEnd } = edytor.selection.state;
	return `${startText?.parent.id}@${yStart}…${endText?.parent.id}@${yEnd}`;
};
const block = (edytor: Edytor, id: string) => edytor.idToBlock.get(id)!;

describe('GX-03: block-range setters span what the blocks show', () => {
	it('setAtBlockRange over a list selects across its items', async () => {
		const { edytor } = await render();
		edytor.selection.setAtBlockRange(block(edytor, 'L'));
		await flushDomUpdates();
		expect(shape(edytor)).toBe('one@0…two@3');
	});

	it('setAtBlockRange over a code block selects across its lines', async () => {
		const { edytor } = await render();
		edytor.selection.setAtBlockRange(block(edytor, 'C'));
		await flushDomUpdates();
		expect(shape(edytor)).toBe('l1@0…l2@6');
	});

	it('setAtBlockRange over a divider keeps the current value (it shows no line)', async () => {
		const { edytor } = await render();
		edytor.selection.setAtBlockRange(block(edytor, 'x'));
		await flushDomUpdates();
		edytor.selection.setAtBlockRange(block(edytor, 'd'));
		await flushDomUpdates();
		expect(shape(edytor)).toBe('x@0…x@1');
	});

	it('leaving a block selection of [a, list] spans the list items', async () => {
		const { edytor } = await render();
		edytor.selection.selectBlocks(block(edytor, 'a'), block(edytor, 'L'));
		await flushDomUpdates();
		edytor.selection.selectBlocks();
		await flushDomUpdates();
		expect(shape(edytor)).toBe('a@0…two@3');
	});

	it('leaving a block selection of [divider, after] still covers the divider', async () => {
		const { edytor } = await render();
		edytor.selection.selectBlocks(block(edytor, 'd'), block(edytor, 'after'));
		await flushDomUpdates();
		edytor.selection.selectBlocks();
		await flushDomUpdates();
		expect(shape(edytor)).toBe('x@1…after@5');
		await dispatchDomKeyDown(document, { key: 'Backspace' });
		await flushDomUpdates();
		expect(edytor.value.children!.map((b) => b.type)).toEqual([
			'paragraph',
			'unordered-list',
			'code',
			'paragraph'
		]);
		expectNoHiddenContent(edytor);
	});

	it('a range set with an end in a list container ends at its last item', async () => {
		const { edytor } = await render();
		const list = block(edytor, 'L');
		edytor.selection.setAtRange(block(edytor, 'a').firstText, 0, list.content[0] as never, 0);
		await flushDomUpdates();
		expect(shape(edytor)).toBe('a@0…two@3');
	});
});

/**
 * GX-02: a selected container (a list: it shows only its items) stands for
 * its whole subtree, as its highlight shows: delete, cut, copy, paste and
 * typing over it, and the formatting keys, act on its items too.
 */
describe('GX-02: a grip-selected list acts on its items', () => {
	const listDoc: JSONBlock[] = [
		p('a'),
		{
			id: 'L',
			type: 'unordered-list',
			children: [
				{ id: 'one', type: 'list-item', content: [{ text: 'one' }] },
				{ id: 'two', type: 'list-item', content: [{ text: 'two' }] }
			]
		},
		p('b')
	];
	const renderList = () =>
		renderDomEdytor(
			<root>
				<paragraph>|</paragraph>
			</root>,
			{ plugins: [richTextPlugin, mentionPlugin, codePlugin], value: { children: listDoc } }
		);
	type Outline = string | [string, Outline[]];
	const outline = (b: JSONBlock): Outline => {
		const text = (b.content ?? [])
			.map((part) => ('text' in part ? (part.marks?.bold ? `*${part.text}*` : part.text) : '@'))
			.join('');
		const self = text ? `${b.type} "${text}"` : b.type;
		return b.children?.length ? [self, b.children.map(outline)] : self;
	};
	const doc = (edytor: Edytor) => (edytor.value.children ?? []).map(outline);
	const grip = async (edytor: Edytor, id = 'L') => {
		// What the list's handle does (`BlockHandleController.selectBlock`).
		expect(block(edytor, id).movable).toBe(true);
		edytor.selection.selectBlocks(block(edytor, id));
		await flushDomUpdates();
	};

	for (const key of ['Backspace', 'Delete'])
		it(`${key} removes the list with its items`, async () => {
			const { edytor } = await renderList();
			await grip(edytor);
			await dispatchDomKeyDown(document, { key });
			await flushDomUpdates();
			expect(doc(edytor)).toEqual(['paragraph "a"', 'paragraph "b"']);
		});

	it('cut, then paste after b: the list moves intact', async () => {
		const { edytor, editor } = await renderList();
		await grip(edytor);
		const cut = await dispatchCut(editor);
		await flushDomUpdates();
		expect(doc(edytor)).toEqual(['paragraph "a"', 'paragraph "b"']);
		expect(cut.clipboardData['text/plain']).toContain('one');
		await setNativeSelection(edytor, block(edytor, 'b').firstText, 1);
		await dispatchClipboardPaste(editor, cut.clipboardData);
		await flushDomUpdates();
		expect(doc(edytor)).toEqual([
			'paragraph "a"',
			'paragraph "b"',
			['unordered-list', ['list-item "one"', 'list-item "two"']]
		]);
		expectNoHiddenContent(edytor);
	});

	it('Mod+B bolds the items and keeps the list selected', async () => {
		const { edytor } = await renderList();
		await grip(edytor);
		await dispatchDomKeyDown(document, { key: 'b', metaKey: true, ctrlKey: true });
		await flushDomUpdates();
		expect(doc(edytor)).toEqual([
			'paragraph "a"',
			['unordered-list', ['list-item "*one*"', 'list-item "*two*"']],
			'paragraph "b"'
		]);
		expect(shape(edytor)).toBe('blocks:L');
	});

	it('typing over it replaces the list, items included', async () => {
		const { edytor, editor } = await renderList();
		await grip(edytor);
		await dispatchClipboardPaste(editor, { 'text/plain': 'x' });
		await flushDomUpdates();
		expect(doc(edytor)).toEqual(['paragraph "a"', 'paragraph "x"', 'paragraph "b"']);
	});

	describe('DR-behavior-2: a grip-selected code block acts on its lines', () => {
		const codeDoc: JSONBlock[] = [
			p('a'),
			{
				id: 'C',
				type: 'code',
				children: [
					{ id: 'l1', type: 'codeLine', content: [{ text: 'let a' }] },
					{ id: 'l2', type: 'codeLine', content: [{ text: 'let b' }] }
				]
			},
			p('b')
		];
		const renderCode = () =>
			renderDomEdytor(
				<root>
					<paragraph>|</paragraph>
				</root>,
				{ plugins: [richTextPlugin, mentionPlugin, codePlugin], value: { children: codeDoc } }
			);
		for (const key of ['Backspace', 'Delete'])
			it(`${key} removes the code block with its lines`, async () => {
				const { edytor } = await renderCode();
				await grip(edytor, 'C');
				await dispatchDomKeyDown(document, { key });
				await flushDomUpdates();
				expect(doc(edytor)).toEqual(['paragraph "a"', 'paragraph "b"']);
			});
		it('cut, then paste after b: the code block moves intact', async () => {
			const { edytor, editor } = await renderCode();
			await grip(edytor, 'C');
			const cut = await dispatchCut(editor);
			await flushDomUpdates();
			expect(doc(edytor)).toEqual(['paragraph "a"', 'paragraph "b"']);
			expect(cut.clipboardData['text/plain']).toContain('let a');
			await setNativeSelection(edytor, block(edytor, 'b').firstText, 1);
			await dispatchClipboardPaste(editor, cut.clipboardData);
			await flushDomUpdates();
			expect(doc(edytor)).toEqual([
				'paragraph "a"',
				'paragraph "b"',
				['code', ['codeLine "let a"', 'codeLine "let b"']]
			]);
			expectNoHiddenContent(edytor);
		});
		it('Mod+B marks its lines, as a range over them does; it stays selected', async () => {
			const { edytor } = await renderCode();
			await grip(edytor, 'C');
			await dispatchDomKeyDown(document, { key: 'b', metaKey: true, ctrlKey: true });
			await flushDomUpdates();
			expect(doc(edytor)).toEqual([
				'paragraph "a"',
				['code', ['codeLine "*let a*"', 'codeLine "*let b*"']],
				'paragraph "b"'
			]);
			expect(shape(edytor)).toBe('blocks:C');
		});
	});

	it('DR-behavior-4: Mod+B on a list leaves the hidden body of a closed toggle as it is', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>|</paragraph>
			</root>,
			{
				plugins: [richTextPlugin, mentionPlugin, codePlugin],
				value: {
					children: [
						p('a'),
						{
							id: 'L',
							type: 'unordered-list',
							children: [
								{
									id: 'one',
									type: 'list-item',
									content: [{ text: 'one' }],
									children: [
										{
											id: 'T',
											type: 'toggle',
											content: [{ text: 'T' }],
											children: [p('body')]
										}
									]
								}
							]
						},
						p('b')
					]
				}
			}
		);
		expect((block(edytor, 'T').node as HTMLDetailsElement).open).toBe(false);
		await grip(edytor);
		await dispatchDomKeyDown(document, { key: 'b', metaKey: true, ctrlKey: true });
		await flushDomUpdates();
		expect(doc(edytor)).toEqual([
			'paragraph "a"',
			['unordered-list', [['list-item "*one*"', [['toggle "*T*"', ['paragraph "body"']]]]]],
			'paragraph "b"'
		]);
		// Its delete takes the list whole, the hidden body with it.
		await dispatchDomKeyDown(document, { key: 'Backspace' });
		await flushDomUpdates();
		expect(doc(edytor)).toEqual(['paragraph "a"', 'paragraph "b"']);
	});

	it('DR-behavior-3: Turn into over a grip-selected list keeps the converted items selected', async () => {
		const { edytor } = await renderList();
		await grip(edytor);
		await dispatchDomKeyDown(document, {
			key: '2',
			code: 'Digit2',
			metaKey: true,
			ctrlKey: true,
			altKey: true
		});
		await flushDomUpdates();
		expect(doc(edytor)).toEqual([
			'paragraph "a"',
			'heading "one"',
			'heading "two"',
			'paragraph "b"'
		]);
		expect(shape(edytor)).toBe('blocks:one,two');
		await dispatchDomKeyDown(document, { key: 'Backspace' });
		await flushDomUpdates();
		expect(doc(edytor)).toEqual(['paragraph "a"', 'paragraph "b"']);
	});

	it('Shift+↑ from the first item adds the list: Backspace removes all of it', async () => {
		const { edytor } = await renderList();
		edytor.selection.selectBlocks(block(edytor, 'one'));
		await flushDomUpdates();
		await dispatchDomKeyDown(document, { key: 'ArrowUp', shiftKey: true });
		await flushDomUpdates();
		expect(shape(edytor)).toBe('blocks:one,L');
		await dispatchDomKeyDown(document, { key: 'Backspace' });
		await flushDomUpdates();
		expect(doc(edytor)).toEqual(['paragraph "a"', 'paragraph "b"']);
	});
});
