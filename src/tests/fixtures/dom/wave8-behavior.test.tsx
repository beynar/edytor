/** @jsxImportSource ../../jsx */
/**
 * Wave 8, behaviors: the caret after a block-level command beside a line
 * holding an inline atom (YW-04); a toggle override whose children sit
 * directly under `<details>` (YW-12); nested closed toggles in copy and
 * delete. Expected states are hand-authored from Notion's behavior.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Plugin } from '$lib/plugins.js';
import type { JSONBlock } from '$lib/utils/json.js';
import { mentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { blockMenuPlugin } from '$lib/plugins/blockMenu/blockMenuPlugin.js';
import { BLOCK_ACTIVATE_EVENT } from '$lib/plugins/blockHandles/BlockHandleController.svelte.js';
import { bareTogglePlugin } from './Wave8BareToggle.svelte';
import { markdownShortcutsPlugin } from '$lib/plugins/markdownShortcuts.js';
import { codePlugin } from '$lib/plugins/code/CodePlugin.svelte';
import { createDocument } from '$lib/crdt/index.js';
import {
	canonicalTree,
	dispatchDomBeforeInput,
	dispatchDomKeyDown,
	flushDomUpdates,
	renderDomEdytor,
	type CanonicalBlock
} from '../../dom/test.utils.js';

afterEach(() => {
	document.body.innerHTML = '';
});

const render = (plugins: Plugin[], children: JSONBlock[]) =>
	renderDomEdytor(
		<root>
			<paragraph>|</paragraph>
		</root>,
		{ plugins: [richTextPlugin, mentionPlugin, ...plugins], value: { children } }
	);
type View = Awaited<ReturnType<typeof render>>;

const p = (id: string, children?: JSONBlock[]): JSONBlock => ({
	id,
	type: 'paragraph',
	content: [{ text: id }],
	...(children && { children })
});
/** A paragraph `hello @m world`: its line holds a mention between two texts. */
const atom = (id: string): JSONBlock => ({
	id,
	type: 'paragraph',
	content: [{ text: 'hello ' }, { type: 'mention', id: `${id}-m`, data: {} }, { text: ' world' }]
});
/** A toggle `id` with a text of its id; closed (its default). */
const toggle = (id: string, children: JSONBlock[]): JSONBlock => ({
	id,
	type: 'toggle',
	content: [{ text: id }],
	children
});
/** Each block's text, a mention read as `@`. */
const texts = ({ edytor }: View) =>
	canonicalTree(edytor).map((block: CanonicalBlock) =>
		(block.content ?? []).map((part) => ('text' in part ? part.text : '@')).join('')
	);
const typeZ = (view: View) =>
	dispatchDomBeforeInput(view.editor, { inputType: 'insertText', data: 'Z' });
const select = async ({ edytor }: View, ...ids: string[]) => {
	edytor.selection.selectBlocks(...ids.map((id) => edytor.idToBlock.get(id)!));
	await flushDomUpdates();
};
const key = (key: string) => dispatchDomKeyDown(document, { key });
const click = async (element: Element) => {
	element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
	element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
	await flushDomUpdates();
};
const menuDelete = async (view: View, id: string) => {
	const block = view.edytor.idToBlock.get(id)!;
	view.editor.dispatchEvent(
		new CustomEvent(BLOCK_ACTIVATE_EVENT, { detail: { block, anchor: block.node } })
	);
	await flushDomUpdates();
	await click(document.querySelector('[data-testid="block-menu-delete"]')!);
};

describe('the caret beside a line holding an inline atom (YW-04)', () => {
	it.each(['Backspace', 'Delete'])(
		'%s over the block after it lands at the end of its line',
		async (name) => {
			const view = await render([], [atom('a'), p('x')]);
			await select(view, 'x');
			await key(name);
			await typeZ(view);
			expect(texts(view)).toEqual(['hello @ worldZ']);
		}
	);

	it.each(['Backspace', 'Delete'])(
		'%s over the first block lands at the start of the next line',
		async (name) => {
			const view = await render([], [p('x'), atom('a')]);
			await select(view, 'x');
			await key(name);
			await typeZ(view);
			expect(texts(view)).toEqual(['Zhello @ world']);
		}
	);

	it('the block menu Delete lands where the keyboard does', async () => {
		for (const doc of [
			[atom('a'), p('x')],
			[p('x'), atom('a')]
		]) {
			const keyboard = await render([], doc);
			await select(keyboard, 'x');
			await key('Backspace');
			await typeZ(keyboard);
			const expected = texts(keyboard);
			document.body.innerHTML = '';
			const menu = await render([blockMenuPlugin], doc);
			await menuDelete(menu, 'x');
			await typeZ(menu);
			expect(texts(menu)).toEqual(expected);
			document.body.innerHTML = '';
		}
	});

	it.each([
		['a line on each side', [p('a'), p('x'), p('b')], ['x'], ['aZ', 'b']],
		[
			'two blocks with a line on each side',
			[p('a'), p('x'), p('y'), p('b')],
			['x', 'y'],
			['aZ', 'b']
		],
		// A child promoted into the deleted block's place takes the caret (FW-05).
		[
			'a closed toggle between two lines',
			[p('a'), toggle('x', [p('body')]), p('z')],
			['x'],
			['a', 'Zbody', 'z']
		],
		[
			'a parent between two lines',
			[p('a'), p('x', [p('x1'), p('x2')]), p('b')],
			['x'],
			['a', 'Zx1', 'x2', 'b']
		],
		['a parent as the last block', [p('a'), p('x', [p('x1')])], ['x'], ['a', 'Zx1']],
		[
			'a parent and the block before it',
			[p('a'), p('w'), p('x', [p('x1')]), p('b')],
			['w', 'x'],
			['a', 'Zx1', 'b']
		]
	])(
		'with %s, the keyboard and the block menu Delete put the caret in the same place (DR-behavior-1)',
		async (_, doc, ids, expected) => {
			for (const name of ['Backspace', 'Delete']) {
				const keyboard = await render([], doc);
				await select(keyboard, ...ids);
				await key(name);
				await typeZ(keyboard);
				expect(texts(keyboard)).toEqual(expected);
				document.body.innerHTML = '';
			}
			const menu = await render([blockMenuPlugin], doc);
			if (ids.length > 1) await select(menu, ...ids);
			await menuDelete(menu, ids[0]);
			await typeZ(menu);
			expect(texts(menu)).toEqual(expected);
		}
	);

	it('Escape puts the caret at the end of the first selected block’s line', async () => {
		const view = await render([], [p('x'), atom('a'), p('z')]);
		// Selected in reverse order: the document order decides, not insertion.
		await select(view, 'z', 'a');
		await key('Escape');
		expect(view.edytor.selection.selectedBlocks.size).toBe(0);
		await typeZ(view);
		expect(texts(view)).toEqual(['x', 'hello @ worldZ', 'z']);
	});

	it('Escape on a list ends its last shown line (DR-behavior-3)', async () => {
		const item = (id: string, children?: JSONBlock[]): JSONBlock => ({
			...p(id, children),
			type: 'list-item'
		});
		const list: JSONBlock = {
			id: 'L',
			type: 'ordered-list',
			children: [item('one', [item('two')]), item('three', [toggle('t', [p('body')])])]
		};
		const view = await render([], [p('a'), list, p('z')]);
		await select(view, 'L');
		await key('Escape');
		await typeZ(view);
		const flat = (blocks: CanonicalBlock[]): string[] =>
			blocks.flatMap((b) => [
				(b.content ?? []).map((part) => ('text' in part ? part.text : '@')).join(''),
				...flat(b.children ?? [])
			]);
		// The closed toggle's header is the list's last shown line, not its body.
		expect(flat(canonicalTree(view.edytor))).toEqual([
			'a',
			'',
			'one',
			'two',
			'three',
			'tZ',
			'body',
			'z'
		]);
	});

	it('a void block before the set is passed over to the nearest line', async () => {
		const view = await render([], [atom('a'), { id: 'd', type: 'divider' } as JSONBlock, p('x')]);
		await select(view, 'x');
		await key('Backspace');
		await typeZ(view);
		expect(texts(view)).toEqual(['hello @ worldZ', '']);
	});
});

const caret = ({ edytor }: View) => {
	const { startBlock, yStart, isCollapsed } = edytor.selection.state;
	return [startBlock?.id, yStart, isCollapsed];
};

describe('a toggle override with no child wrapper (YW-12)', () => {
	const bare = (children: JSONBlock[], plugins: Plugin[] = []) =>
		renderDomEdytor(
			<root>
				<paragraph>|</paragraph>
			</root>,
			{
				plugins: [bareTogglePlugin, richTextPlugin, mentionPlugin, ...plugins],
				value: { children }
			}
		);

	it('renders the body directly under the closed <details>', async () => {
		const view = await bare([toggle('t', [p('body')]), p('z')]);
		const body = view.edytor.idToBlock.get('body')!.node!;
		expect(body.parentElement?.tagName).toBe('DETAILS');
	});

	it.each(['Backspace', 'Delete'])(
		'%s over the selected closed toggle lands on its promoted body',
		async (name) => {
			const view = await bare([toggle('t', [p('body')]), p('z')]);
			await select(view, 't');
			await key(name);
			expect(texts(view)).toEqual(['body', 'z']);
			expect(caret(view)).toEqual(['body', 0, true]);
		}
	);

	it('the block menu Delete of the closed toggle lands on its promoted body', async () => {
		const view = await bare([p('a'), toggle('t', [p('body')]), p('z')], [blockMenuPlugin]);
		await menuDelete(view, 't');
		expect(texts(view)).toEqual(['a', 'body', 'z']);
		expect(caret(view)).toEqual(['body', 0, true]);
	});

	it.each(['Backspace', 'Delete'])(
		'%s over the closed toggle after a line lands on its promoted body too (DR-behavior-1)',
		async (name) => {
			const view = await bare([p('a'), toggle('t', [p('body')]), p('z')]);
			await select(view, 't');
			await key(name);
			expect(texts(view)).toEqual(['a', 'body', 'z']);
			expect(caret(view)).toEqual(['body', 0, true]);
		}
	);

	it('a range from the toggle’s start deletes its body, as with the default snippet', async () => {
		for (const plugins of [[bareTogglePlugin], []]) {
			const view = await renderDomEdytor(
				<root>
					<paragraph>|</paragraph>
				</root>,
				{
					plugins: [...plugins, richTextPlugin, mentionPlugin],
					value: { children: [toggle('t', [p('body')]), p('zed')] }
				}
			);
			const { edytor } = view;
			const [t, z] = [edytor.idToBlock.get('t')!, edytor.idToBlock.get('zed')!];
			edytor.selection.setAtRange(t.firstText!, 0, z.firstText!, 1);
			await flushDomUpdates();
			await key('Backspace');
			expect(texts(view)).toEqual(['ed']);
			document.body.innerHTML = '';
		}
	});
});

describe('nested closed toggles: copy and delete agree', () => {
	const doc = () => [p('a'), toggle('o', [toggle('i', [p('deep')])]), p('zed')];
	const range = async ({ edytor }: View, from: number) => {
		const [o, z] = [edytor.idToBlock.get('o')!, edytor.idToBlock.get('zed')!];
		edytor.selection.setAtRange(o.firstText!, from, z.firstText!, 1);
		await flushDomUpdates();
	};
	const copied = async (view: View) => {
		const event = new Event('copy', { bubbles: true, cancelable: true }) as ClipboardEvent;
		const data = new Map<string, string>();
		Object.defineProperty(event, 'clipboardData', {
			value: {
				getData: (t: string) => data.get(t) ?? '',
				setData: (t: string, v: string) => data.set(t, v)
			}
		});
		view.editor.dispatchEvent(event);
		await flushDomUpdates();
		return data.get('text/plain') ?? '';
	};

	it('from the outer header’s start, both reach the inner toggle and its body', async () => {
		const view = await render([], doc());
		await range(view, 0);
		const text = await copied(view);
		expect(text).toContain('i');
		expect(text).toContain('deep');
		await key('Backspace');
		expect(texts(view)).toEqual(['a', 'ed']);
	});

	it('from inside the outer header, neither reaches the hidden body', async () => {
		const view = await render([], doc());
		await range(view, 1);
		const text = await copied(view);
		expect(text).not.toContain('deep');
		await key('Backspace');
		expect(canonicalTree(view.edytor).map((b) => [b.type, (b.children ?? []).length])).toEqual([
			['paragraph', 0],
			['toggle', 1]
		]);
		expect(texts(view)).toEqual(['a', 'oed']);
	});
});

describe('the block menu’s “Turn into” flyout opened with the mouse (SW8-plugins-1)', () => {
	const open = async (view: View) => {
		const block = view.edytor.idToBlock.get('x')!;
		view.editor.dispatchEvent(
			new CustomEvent(BLOCK_ACTIVATE_EVENT, { detail: { block, anchor: block.node } })
		);
		await flushDomUpdates();
	};
	const menuKey = async (key: string) => {
		const input = document.querySelector('[data-testid="block-menu"] input')!;
		input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
		await flushDomUpdates();
	};
	const highlighted = () => {
		const rows = [...document.querySelectorAll('.block-menu-flyout .block-menu-row')];
		return rows.findIndex((row) => row.getAttribute('data-selected') === 'true');
	};
	const turn = () => document.querySelector('[data-testid="block-menu-turn"]')!;

	it.each([
		['hovering', (row: Element) => row.dispatchEvent(new MouseEvent('mouseenter'))],
		['clicking', (row: Element) => row.dispatchEvent(new MouseEvent('click', { bubbles: true }))]
	] as const)('%s it highlights its first kind, not a stale one', async (_, act) => {
		const view = await render([blockMenuPlugin], [p('x')]);
		await open(view);
		turn().dispatchEvent(new MouseEvent('mouseenter'));
		await flushDomUpdates();
		await menuKey('ArrowDown');
		await menuKey('ArrowDown');
		expect(highlighted()).toBe(2);
		await menuKey('ArrowLeft');
		expect(highlighted()).toBe(-1);
		act(turn());
		await flushDomUpdates();
		expect(highlighted()).toBe(0);
	});
});

describe('markdown shortcuts read the insertion point, not the caret (SW8-plugins-2)', () => {
	it('an insertText away from the caret never completes a shortcut at the caret', async () => {
		const view = await render(
			[markdownShortcutsPlugin],
			[{ id: 'x', type: 'paragraph', content: [{ text: 'a *b' }] }]
		);
		const text = view.edytor.idToBlock.get('x')!.firstText!;
		view.edytor.selection.setAtTextOffset(text, 4);
		await flushDomUpdates();
		text.insertText({ value: '*', start: 1, end: 1 });
		await flushDomUpdates();
		expect(canonicalTree(view.edytor)).toEqual([
			{ type: 'paragraph', content: [{ text: 'a* *b' }] }
		]);
	});

	it('nor a block prefix: `#` inserted mid-block keeps the paragraph', async () => {
		const view = await render(
			[markdownShortcutsPlugin],
			[{ id: 'x', type: 'paragraph', content: [{ text: '# ab' }] }]
		);
		const text = view.edytor.idToBlock.get('x')!.firstText!;
		view.edytor.selection.setAtTextOffset(text, 1);
		await flushDomUpdates();
		text.insertText({ value: ' ', start: 4, end: 4 });
		await flushDomUpdates();
		expect(canonicalTree(view.edytor)).toEqual([
			{ type: 'paragraph', content: [{ text: '# ab ' }] }
		]);
	});
});

describe('the menus focus the editor as the editor itself does (SW8-plugins-3)', () => {
	const drawn = () => {
		const selection = window.getSelection()!;
		return [selection.anchorNode?.textContent, selection.anchorOffset, selection.isCollapsed];
	};

	it('the block menu Delete draws its caret, and its focus is no user gesture', async () => {
		const view = await render([blockMenuPlugin], [p('a'), p('x'), p('zed')]);
		view.edytor.selection.setAtTextOffset(view.edytor.idToBlock.get('zed')!.firstText!, 2);
		await flushDomUpdates();
		const block = view.edytor.idToBlock.get('x')!;
		view.editor.dispatchEvent(
			new CustomEvent(BLOCK_ACTIVATE_EVENT, { detail: { block, anchor: block.node } })
		);
		await flushDomUpdates();
		const serial = view.edytor.intentSerial;
		(document.querySelector('[data-testid="block-menu-delete"]') as HTMLElement).click();
		expect(view.edytor.intentSerial).toBe(serial);
		await flushDomUpdates();
		expect(caret(view)).toEqual(['a', 1, true]);
		expect(drawn()).toEqual(['a', 1, true]);
	});
});

describe('Mod+A climbs text → block → document in every kind (sweep)', () => {
	const block = (type: string, extra: Partial<JSONBlock> = {}): JSONBlock => ({
		id: 'k',
		type,
		content: [{ text: 'hello ' }, { type: 'mention', id: 'k-m', data: {} }, { text: ' world' }],
		...extra
	});
	const kinds: [string, JSONBlock[], string][] = [
		['paragraph', [p('a'), block('paragraph'), p('z')], 'k'],
		['heading', [p('a'), block('heading'), p('z')], 'k'],
		['quote', [p('a'), block('quote'), p('z')], 'k'],
		['callout', [p('a'), block('callout'), p('z')], 'k'],
		['to-do', [p('a'), block('todo-item'), p('z')], 'k'],
		[
			'bulleted item with a child',
			[p('a'), block('bulleted-list-item', { children: [p('c')] }), p('z')],
			'k'
		],
		['open toggle with a child', [p('a'), block('toggle', { children: [p('c')] }), p('z')], 'k'],
		['closed toggle with a child', [p('a'), block('toggle', { children: [p('c')] }), p('z')], 'k'],
		[
			'list item',
			[
				p('a'),
				{
					id: 'l',
					type: 'unordered-list',
					children: [
						block('list-item'),
						{ ...block('list-item'), id: 'k2', content: [{ text: 'two' }] }
					]
				},
				p('z')
			],
			'k'
		]
	];

	it.each(kinds)('%s', async (name, children, id) => {
		const view = await render([], children);
		const { edytor } = view;
		const target = edytor.idToBlock.get(id)!;
		if (name.startsWith('open')) {
			(target.node as HTMLDetailsElement).open = true;
			await flushDomUpdates();
		}
		edytor.selection.setAtTextOffset(target.firstText!, 2);
		await flushDomUpdates();
		const mod = () => dispatchDomKeyDown(document, { key: 'a', ctrlKey: true });
		await mod();
		const { startBlock, endBlock, yStart, isCollapsed } = edytor.selection.state;
		expect([startBlock?.id, endBlock?.id, yStart, isCollapsed]).toEqual([id, id, 0, false]);
		expect(edytor.selection.projection.isAtEndOfBlock).toBe(true);
		await mod();
		expect([...edytor.selection.selectedBlocks].map((b) => b.id)).toEqual([id]);
		// Escape returns to the end of the block's own line.
		await key('Escape');
		await typeZ(view);
		const all = canonicalTree(edytor).flatMap(function flat(b): CanonicalBlock[] {
			return [b, ...(b.children ?? []).flatMap(flat)];
		});
		const lines = all.map((b) =>
			(b.content ?? []).map((part) => ('text' in part ? part.text : '@')).join('')
		);
		expect(lines).toContain('hello @ worldZ');
		await mod();
		await mod();
		await mod();
		expect(edytor.selection.selectedBlocks.size).toBe(edytor.facade.order().length);
	});
});

describe('Delete in an empty block before a code block, after a divider (SW8-plugins-4)', () => {
	it('the caret goes to the end of the line before the divider, not into the code', async () => {
		const view = await render(
			[codePlugin],
			[
				atom('a'),
				{ id: 'd', type: 'divider' } as JSONBlock,
				{ id: 'e', type: 'paragraph' } as JSONBlock,
				{ id: 'c', type: 'code', children: [{ type: 'codeLine', content: [{ text: 'x' }] }] }
			]
		);
		view.edytor.selection.setAtTextOffset(view.edytor.idToBlock.get('e')!.firstText!, 0);
		await flushDomUpdates();
		await dispatchDomBeforeInput(view.editor, { inputType: 'deleteContentForward' });
		expect(canonicalTree(view.edytor).map((b) => b.type)).toEqual(['paragraph', 'divider', 'code']);
		await typeZ(view);
		expect(texts(view)[0]).toBe('hello @ worldZ');
	});
});

describe('del.range.island-kept holds only for a lines island (DR-behavior-2)', () => {
	const cell = (id: string, text: string) => ({ id, type: 'cell', content: [{ text }] });
	const make = () =>
		createDocument({
			value: {
				children: [
					{ id: 'P', type: 'paragraph', content: [{ text: 'p' }] },
					{
						id: 'T',
						type: 'table',
						children: [
							{ id: 'R1', type: 'row', children: [cell('c1', '1'), cell('c2', '2')] },
							{ id: 'R2', type: 'row', children: [cell('c3', '3'), cell('c4', '4')] }
						]
					},
					{ id: 'Z', type: 'paragraph', content: [{ text: 'z' }] }
				]
			},
			semantics: {
				roles: { table: { island: true } },
				rendersContent: { table: false, row: false }
			}
		}).facade;
	const ids = (blocks: JSONBlock[]): unknown[] =>
		blocks.map((b) => (b.children?.length ? [b.id, ids(b.children)] : b.id));

	it('a range over a whole table never shrinks the grid to one cell', () => {
		const doc = make();
		doc.apply(doc.prepare.deleteRange({ block: 'c1', offset: 0 }, { block: 'c4', offset: 1 }));
		// Not `lines`: the island is not kept as one emptied cell (the rule before YW-03).
		expect(ids(doc.toJSON().children)).toEqual(['P', 'Z']);
	});
});
