/** @jsxImportSource ../../jsx */
/**
 * Wave 11 (`docs/reviews/2026-09-30-rescore-8.md`), kind placement: the
 * horizontal rule reads a block's emptiness as Turn into does, so inline
 * atoms count (BW-01); a command over several blocks refuses a vetoed part
 * only, as the document's own refusal of a part (BW-02); Turn into places
 * the kind a plugin's replacement names (BW-03); a list a Turn into split
 * stays split once the inserted block goes (BW-05); an outdent and a Turn
 * into split a list the same way (BW-06). Expected states are hand-authored.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Plugin } from '$lib/plugins.js';
import type { JSONBlock } from '$lib/utils/json.js';
import { mentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { codePlugin } from '$lib/plugins/code/CodePlugin.svelte';
import { blockMenuPlugin } from '$lib/plugins/blockMenu/blockMenuPlugin.js';
import { BLOCK_ACTIVATE_EVENT } from '$lib/plugins/blockHandles/BlockHandleController.svelte.js';
import { convertBlocks, convertToKind } from '$lib/kinds.js';
import { richTextOperations } from '$lib/plugins/richtext/richTextOperations.js';
import { markdownShortcutsPlugin } from '$lib/plugins/markdownShortcuts.js';
import {
	dispatchCut,
	dispatchDomBeforeInput,
	dispatchDomKeyDown,
	flushDomUpdates,
	renderDomEdytor
} from '../../dom/test.utils.js';

afterEach(() => {
	document.body.innerHTML = '';
});

const render = (plugins: Plugin[], children: JSONBlock[]) =>
	renderDomEdytor(
		<root>
			<paragraph>|</paragraph>
		</root>,
		{ plugins: [richTextPlugin, mentionPlugin, codePlugin, ...plugins], value: { children } }
	);
type View = Awaited<ReturnType<typeof render>>;

const block = (type: string, id: string, extra: Partial<JSONBlock> = {}): JSONBlock => ({
	id,
	type,
	content: [{ text: id }],
	...extra
});
const p = (id: string, extra?: Partial<JSONBlock>) => block('paragraph', id, extra);
const li = (id: string, extra?: Partial<JSONBlock>) => block('list-item', id, extra);
/** A block holding only a mention. */
const atom = (type: string, id: string): JSONBlock => ({
	id,
	type,
	content: [{ text: '' }, { id: `m-${id}`, type: 'mention', data: {} }, { text: '' }]
});
const list =
	(type: string) =>
	(id: string, children: JSONBlock[]): JSONBlock => ({ id, type, children });
const ul = list('unordered-list');
const ol = list('ordered-list');
const locked = { data: { locked: true } };

const shape = ({ edytor }: View) => {
	const show = (b: JSONBlock): unknown => {
		const own = (b.content ?? []).map((part) => ('text' in part ? part.text : '@')).join('');
		const line = `${b.type} "${own}"`;
		return b.children?.length ? [line, b.children.map(show)] : line;
	};
	return (edytor.value.children ?? []).map(show);
};
const get = ({ edytor }: View, id: string) => edytor.idToBlock.get(id)!;
const at = async (view: View, id: string, offset: number) => {
	view.edytor.selection.setAtTextOffset(get(view, id).firstText!, offset);
	await flushDomUpdates();
};
const row = (view: View, label: string) => view.edytor.kinds.find((kind) => kind.label === label)!;
const rule = (view: View) =>
	dispatchDomBeforeInput(view.editor, { inputType: 'insertHorizontalRule' });
const turnInto = (digit: string) =>
	dispatchDomKeyDown(document, { key: digit, code: `Digit${digit}`, ctrlKey: true, altKey: true });
const tab = (shiftKey = false) => dispatchDomKeyDown(document, { key: 'Tab', shiftKey });
const status = (view: View) => view.edytor.dispatcher.last?.status;

const U = 'unordered-list ""';
const O = 'ordered-list ""';

describe('The horizontal rule on a block holding only an inline atom (BW-01)', () => {
	const inList = () => [ul('u', [atom('list-item', 'a'), li('c')])];
	/** Turn into Divider's result on `inList`: the item stays whole, the list splits after it. */
	const afterItem = [[U, ['list-item "@"']], 'divider ""', 'paragraph ""', [U, ['list-item "c"']]];

	it('Turn into Divider keeps the mention (the reference)', async () => {
		const view = await render([], inList());
		expect(convertToKind(view.edytor, get(view, 'a'), row(view, 'Divider'))).toBe(true);
		await flushDomUpdates();
		expect(shape(view)).toEqual(afterItem);
	});

	it('in a list item, the native rule keeps the mention and goes after the item', async () => {
		const view = await render([], inList());
		await at(view, 'a', 0);
		await rule(view);
		expect(shape(view)).toEqual(afterItem);
	});

	it('in a list item, insertDividerAtSelection does the same', async () => {
		const view = await render([], inList());
		await at(view, 'a', 0);
		expect(richTextOperations(view.edytor).insertDividerAtSelection()).toBeTruthy();
		await flushDomUpdates();
		expect(shape(view)).toEqual(afterItem);
	});

	it('at the root, the native rule keeps the mention: the divider goes before it, the caret stays', async () => {
		const view = await render([], [atom('paragraph', 'a'), p('c')]);
		await at(view, 'a', 0);
		await rule(view);
		expect(shape(view)).toEqual(['divider ""', 'paragraph "@"', 'paragraph "c"']);
		expect(view.edytor.selection.state.startBlock?.id).toBe('a');
	});

	it('at the root, insertDividerAtSelection does the same', async () => {
		const view = await render([], [atom('paragraph', 'a'), p('c')]);
		await at(view, 'a', 0);
		expect(richTextOperations(view.edytor).insertDividerAtSelection()).toBeTruthy();
		await flushDomUpdates();
		expect(shape(view)).toEqual(['divider ""', 'paragraph "@"', 'paragraph "c"']);
	});
});

describe('A veto on one block of a command over several (BW-02)', () => {
	const veto: Plugin = () => ({
		onBeforeOperation: ({ block, prevent }) => {
			if ((block as { data?: { locked?: boolean } })?.data?.locked) prevent();
		}
	});
	const seed = () => [p('a'), p('b'), p('c', locked), p('d')];
	/** Each block converts but the locked one, as a block the document refuses. */
	const converted = ['paragraph "a"', 'heading "b"', 'paragraph "c"', 'heading "d"'];

	it('Mod+Alt+1 over b..d converts b and d, keeps c, and reports applied', async () => {
		const view = await render([veto], seed());
		view.edytor.selection.setAtRange(get(view, 'b').firstText!, 0, get(view, 'd').firstText!, 1);
		await flushDomUpdates();
		await turnInto('1');
		expect(shape(view)).toEqual(converted);
		expect(status(view)).toBe('applied');
	});

	it('convertBlocks answers true for the same result', async () => {
		const view = await render([veto], seed());
		const blocks = ['b', 'c', 'd'].map((id) => get(view, id));
		expect(convertBlocks(view.edytor, blocks, row(view, 'Heading 1'))).toBe(true);
		expect(shape(view)).toEqual(converted);
		expect(status(view)).toBe('applied');
	});

	it('when every block is vetoed, nothing changes, it answers false and reports refused', async () => {
		const view = await render([veto], [p('b', locked), p('c', locked)]);
		const blocks = ['b', 'c'].map((id) => get(view, id));
		expect(convertBlocks(view.edytor, blocks, row(view, 'Heading 1'))).toBe(false);
		expect(shape(view)).toEqual(['paragraph "b"', 'paragraph "c"']);
		expect(status(view)).toBe('refused');
	});

	it('Tab over a block selection with a gap moves the runs it may move, and reports applied', async () => {
		const view = await render([veto], [p('z'), p('a', locked), p('m'), p('e')]);
		view.edytor.selection.selectBlocks(get(view, 'a'), get(view, 'e'));
		await flushDomUpdates();
		await tab();
		expect(shape(view)).toEqual([
			'paragraph "z"',
			'paragraph "a"',
			['paragraph "m"', ['paragraph "e"']]
		]);
		expect(status(view)).toBe('applied');
	});
});

describe('Turn into places the kind a plugin’s replacement names (BW-03)', () => {
	const replacing =
		(from: string, to: JSONBlock): Plugin =>
		() => ({
			onBeforeOperation: ({ operation, payload }) => {
				const value = (payload as { value?: JSONBlock }).value;
				if (operation === 'setBlock' && value?.type === from) return { value: { ...value, ...to } };
			}
		});

	it('a replacement that fits the list keeps the item in it', async () => {
		const view = await render(
			[replacing('heading', { type: 'list-item', data: {} })],
			[ul('u', [li('a'), li('b'), li('c')])]
		);
		expect(convertToKind(view.edytor, get(view, 'b'), row(view, 'Heading 1'))).toBe(true);
		await flushDomUpdates();
		expect(shape(view)).toEqual([[U, ['list-item "a"', 'list-item "b"', 'list-item "c"']]]);
	});

	it('a replacement that does not fit is lifted for that kind', async () => {
		const view = await render(
			[replacing('list-item', { type: 'heading', data: { level: 1 } })],
			[ol('o', [li('a'), li('b'), li('c')])]
		);
		// Numbered list on an item of an ordered list keeps it an item; the plugin makes it a heading.
		expect(convertToKind(view.edytor, get(view, 'b'), row(view, 'Numbered list'))).toBe(true);
		await flushDomUpdates();
		expect(shape(view)).toEqual([[O, ['list-item "a"']], 'heading "b"', [O, ['list-item "c"']]]);
	});
});

describe('A list split by Turn into stays split (BW-05)', () => {
	it('deleting the divider and the paragraph after it leaves two lists', async () => {
		const view = await render([], [ol('o', [li('a'), li('b'), li('c')])]);
		expect(convertToKind(view.edytor, get(view, 'b'), row(view, 'Divider'))).toBe(true);
		await flushDomUpdates();
		const [, divider, paragraph] = view.edytor.root!.children;
		view.edytor.deleteBlocks({ blocks: [divider!, paragraph!] });
		await flushDomUpdates();
		expect(shape(view)).toEqual([
			[O, ['list-item "a"', 'list-item "b"']],
			[O, ['list-item "c"']]
		]);
	});
});

describe('An outdent and a Turn into split a list the same way (BW-06)', () => {
	const seed = () => [ul('u', [li('a'), li('b'), li('c')])];
	/** The tree with container ids, so the half that keeps the list shows. */
	const ids = ({ edytor }: View) =>
		edytor.root!.children.map((b) => (b.isContainer ? [b.id, b.children.map((c) => c.id)] : b.id));

	it('Shift+Tab and Heading 1 on a middle item: the list keeps the items after it', async () => {
		const outdent = await render([], seed());
		await at(outdent, 'b', 0);
		await tab(true);
		const byOutdent = ids(outdent);
		document.body.innerHTML = '';
		const turned = await render([], seed());
		await at(turned, 'b', 0);
		await turnInto('1');
		expect(shape(turned)).toEqual([[U, ['list-item "a"']], 'heading "b"', [U, ['list-item "c"']]]);
		const byTurn = ids(turned);
		expect(byOutdent[1]).toBe('b');
		expect(byOutdent[2]).toEqual(['u', ['c']]);
		expect(byTurn.slice(1)).toEqual(byOutdent.slice(1));
	});
});

describe('Sweep: one emptiness rule, inline atoms count (SW11-kinds-1..3)', () => {
	const code = (id: string): JSONBlock => ({
		id,
		type: 'code',
		children: [{ id: `${id}1`, type: 'codeLine', content: [{ text: 'x' }] }]
	});
	const press = async (element: Element) => {
		element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
		element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		await flushDomUpdates();
	};

	it('Delete after a mention, before a code block, keeps the mention (SW11-kinds-1)', async () => {
		const view = await render([], [atom('paragraph', 'a'), code('k')]);
		view.edytor.selection.setAtTextOffset(get(view, 'a').lastText!, 0);
		await flushDomUpdates();
		await dispatchDomBeforeInput(view.editor, { inputType: 'deleteContentForward' });
		expect(shape(view)).toEqual(['paragraph "@"', ['code ""', ['codeLine "x"']]]);
	});

	it('Backspace before a mention, after a code block, keeps the mention (SW11-kinds-2)', async () => {
		const view = await render([], [code('k'), atom('paragraph', 'a')]);
		await at(view, 'a', 0);
		await dispatchDomBeforeInput(view.editor, { inputType: 'deleteContentBackward' });
		expect(shape(view)).toEqual([['code ""', ['codeLine "x"']], 'paragraph "@"']);
	});

	it('+ beside a paragraph holding a mention adds a block below it (SW11-kinds-3)', async () => {
		const view = await render([], [atom('paragraph', 'a'), p('c')]);
		await press(document.querySelector('[data-testid="block-add"]')!);
		// No slash menu here: the `+` adds the empty block at once.
		expect(shape(view)).toEqual(['paragraph "@"', 'paragraph ""', 'paragraph "c"']);
	});
});

describe('Sweep: the block menu’s Delete over several blocks is one command (SW11-kinds-4)', () => {
	/** The operations page's example: a locked block is never removed. */
	const lockedBlocks: Plugin = (edytor) => ({
		onBeforeOperation: ({ effect, prevent }) => {
			if (!effect) return;
			const leaving = [...effect.removes, ...effect.merges.map(([from]) => from)];
			if (leaving.some((id) => edytor.idToBlock.get(id)?.data.locked)) prevent();
		}
	});
	const seed = () => [p('a'), p('b', locked), p('c')];
	const unchanged = ['paragraph "a"', 'paragraph "b"', 'paragraph "c"'];

	it('with a locked block selected, nothing is deleted, as with the keyboard', async () => {
		const view = await render([blockMenuPlugin, lockedBlocks], seed());
		const blocks = ['a', 'b', 'c'].map((id) => get(view, id));
		view.edytor.selection.selectBlocks(...blocks);
		await flushDomUpdates();
		view.editor.dispatchEvent(
			new CustomEvent(BLOCK_ACTIVATE_EVENT, {
				detail: { block: blocks[0], anchor: blocks[0]!.node }
			})
		);
		await flushDomUpdates();
		const button = document.querySelector('[data-testid="block-menu-delete"]')!;
		button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
		button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		await flushDomUpdates();
		expect(shape(view)).toEqual(unchanged);
		expect(status(view)).toBe('refused');
	});

	it('the keyboard’s block delete (the reference)', async () => {
		const view = await render([lockedBlocks], seed());
		view.edytor.selection.selectBlocks(...['a', 'b', 'c'].map((id) => get(view, id)));
		await flushDomUpdates();
		await dispatchDomKeyDown(document, { key: 'Backspace' });
		expect(shape(view)).toEqual(unchanged);
	});
});

describe('Sweep: formatting and duplicating over several blocks skip a vetoed one (SW11-kinds-5)', () => {
	const veto: Plugin = () => ({
		onBeforeOperation: ({ block, prevent }) => {
			if ((block as { data?: { locked?: boolean } })?.data?.locked) prevent();
		}
	});
	const bold = ({ edytor }: View) =>
		edytor.root!.children.map((b) =>
			(b.value.content ?? []).some((part) => 'marks' in part && part.marks?.bold)
		);

	it('Mod+B over a range across a locked block bolds the others', async () => {
		const view = await render([veto], [p('a'), p('b', locked), p('c')]);
		view.edytor.selection.setAtRange(get(view, 'a').firstText!, 0, get(view, 'c').firstText!, 1);
		await flushDomUpdates();
		await dispatchDomKeyDown(document, { key: 'b', ctrlKey: true });
		expect(bold(view)).toEqual([true, false, true]);
	});

	it('the block menu’s Duplicate over a selection with a locked block copies the others', async () => {
		const view = await render([blockMenuPlugin, veto], [p('a', locked), p('c')]);
		const blocks = ['a', 'c'].map((id) => get(view, id));
		view.edytor.selection.selectBlocks(...blocks);
		await flushDomUpdates();
		view.editor.dispatchEvent(
			new CustomEvent(BLOCK_ACTIVATE_EVENT, {
				detail: { block: blocks[1], anchor: blocks[1]!.node }
			})
		);
		await flushDomUpdates();
		const button = document.querySelector('[data-testid="block-menu-duplicate"]')!;
		button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
		button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		await flushDomUpdates();
		expect(shape(view)).toEqual(['paragraph "a"', 'paragraph "c"', 'paragraph "c"']);
	});
});

describe('Sweep: the horizontal rule reads the caret’s block offset beside an inline atom (SW11-kinds-6)', () => {
	const mixed = (id: string, before: string, after: string): JSONBlock => ({
		id,
		type: 'paragraph',
		content: [{ text: before }, { id: `m-${id}`, type: 'mention', data: {} }, { text: after }]
	});

	it('after a mention ending the line, the divider goes after the line', async () => {
		const view = await render([], [mixed('a', 'ab', '')]);
		view.edytor.selection.setAtTextOffset(get(view, 'a').lastText!, 0);
		await flushDomUpdates();
		await rule(view);
		expect(shape(view)).toEqual(['paragraph "ab@"', 'divider ""', 'paragraph ""']);
	});

	it('before a mention mid-line, the line splits at the caret', async () => {
		const view = await render([], [mixed('a', 'ab', 'cd')]);
		await at(view, 'a', 2);
		await rule(view);
		expect(shape(view)).toEqual(['paragraph "ab"', 'divider ""', 'paragraph "@cd"']);
	});
});

describe('Turn into runs the new kind’s normalizeContent (DR-code-1)', () => {
	/** The Task kind of blocks.mdx: one line, a line break is removed. */
	const task: Plugin = () => ({
		blocks: {
			task: {
				presets: [{ label: 'Task', icon: '☐', data: { done: false }, markdown: ['>> '] }],
				normalizeContent: ({ block }) => {
					const text = block.firstText;
					const at = text?.stringContent.indexOf('\n') ?? -1;
					if (text && at !== -1) return () => text.deleteAt(at, 1);
				}
			}
		}
	});
	const broken = (type: string, id: string): JSONBlock => ({
		id,
		type,
		content: [{ text: 'x\ny' }]
	});

	it('in place: a paragraph with a line break turned into a task is one line', async () => {
		const view = await render([task], [broken('paragraph', 'a')]);
		expect(convertToKind(view.edytor, get(view, 'a'), row(view, 'Task'))).toBe(true);
		await flushDomUpdates();
		expect(shape(view)).toEqual(['task "xy"']);
	});

	it('lifted: a list item with a line break turned into a task is one line', async () => {
		const view = await render([task], [ul('u', [li('a'), broken('list-item', 'b'), li('c')])]);
		expect(convertToKind(view.edytor, get(view, 'b'), row(view, 'Task'))).toBe(true);
		await flushDomUpdates();
		expect(shape(view)).toEqual([[U, ['list-item "a"']], 'task "xy"', [U, ['list-item "c"']]]);
	});

	it('the markdown shortcut does the same', async () => {
		const view = await render([task, markdownShortcutsPlugin], [broken('paragraph', 'a')]);
		await at(view, 'a', 0);
		for (const data of ['>', '>', ' '])
			await dispatchDomBeforeInput(view.editor, { inputType: 'insertText', data });
		await flushDomUpdates();
		expect(shape(view)).toEqual(['task "xy"']);
	});
});

describe('Turn into puts the caret in the block a plugin’s replacement names (DR-code-4)', () => {
	const retarget: Plugin = () => ({
		onBeforeOperation: ({ operation, payload }) => {
			const block = (payload as { block?: JSONBlock }).block;
			if (operation === 'insertBlockAfter' && block?.type === 'code')
				return { block: { type: 'quote', content: [{ text: '' }], children: [] } };
		}
	});

	it('Code after a line, rewritten to a quote: the caret goes into the quote', async () => {
		const view = await render([retarget], [p('a')]);
		expect(convertToKind(view.edytor, get(view, 'a'), row(view, 'Code'))).toBe(true);
		await flushDomUpdates();
		expect(shape(view)).toEqual(['paragraph "a"', 'quote ""']);
		const caret = view.edytor.selection.state.startText?.parent;
		expect(caret?.type).toBe('quote');
	});
});

describe('Every block-selection delete runs onDeleteSelectedBlocks (DR-code-2)', () => {
	const keeping: Plugin = () => ({ onDeleteSelectedBlocks: ({ prevent }) => prevent() });
	const seed = () => [p('a'), p('b'), p('c')];
	const unchanged = ['paragraph "a"', 'paragraph "b"', 'paragraph "c"'];
	const selectAB = async (view: View) => {
		const blocks = ['a', 'b'].map((id) => get(view, id));
		view.edytor.selection.selectBlocks(...blocks);
		await flushDomUpdates();
		return blocks;
	};

	it('the block menu’s Delete keeps the blocks, as Backspace does', async () => {
		const view = await render([keeping, blockMenuPlugin], seed());
		const blocks = await selectAB(view);
		view.editor.dispatchEvent(
			new CustomEvent(BLOCK_ACTIVATE_EVENT, {
				detail: { block: blocks[0], anchor: blocks[0]!.node }
			})
		);
		await flushDomUpdates();
		const button = document.querySelector('[data-testid="block-menu-delete"]')!;
		button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
		button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		await flushDomUpdates();
		expect(shape(view)).toEqual(unchanged);
	});

	it('Backspace keeps them (the reference)', async () => {
		const view = await render([keeping], seed());
		await selectAB(view);
		await dispatchDomKeyDown(document, { key: 'Backspace' });
		expect(shape(view)).toEqual(unchanged);
	});

	it('cut keeps them (the clipboard is written)', async () => {
		const view = await render([keeping], seed());
		await selectAB(view);
		await dispatchCut(view.editor);
		await flushDomUpdates();
		expect(shape(view)).toEqual(unchanged);
	});

	it('the menu’s selected blocks are what the hook sees', async () => {
		const seen: string[][] = [];
		const watching: Plugin = () => ({
			onDeleteSelectedBlocks: ({ selectedBlocks }) => {
				seen.push(selectedBlocks.map((b) => b.id));
			}
		});
		const view = await render([watching, blockMenuPlugin], seed());
		const blocks = await selectAB(view);
		view.editor.dispatchEvent(
			new CustomEvent(BLOCK_ACTIVATE_EVENT, {
				detail: { block: blocks[0], anchor: blocks[0]!.node }
			})
		);
		await flushDomUpdates();
		const button = document.querySelector('[data-testid="block-menu-delete"]')!;
		button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
		button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		await flushDomUpdates();
		expect(seen).toEqual([['a', 'b']]);
		expect(shape(view)).toEqual(['paragraph "c"']);
	});
});
