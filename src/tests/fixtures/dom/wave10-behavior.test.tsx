/** @jsxImportSource ../../jsx */
/**
 * Wave 10 (`docs/reviews/2026-09-30-rescore-7.md`), view behaviors around
 * list containers: Turn into a kind that replaces the block (a divider, a
 * code block) never puts it directly in a list (AW-01); Tab and Shift+Tab
 * over a text range read the blocks the range touches, never the list it
 * enters (AW-02); a vetoed Turn into out of a list nested right in a list
 * changes nothing (AW-03); a block shed into a list can be reordered in it
 * (AW-06); Tab after a list ending in a block that holds no children is
 * refused, as under that block (AW-07); a pasted list's items join the list
 * they land in (AW-08). Follow-ups: Tab over a range running through a
 * list keeps the text in order (DR-behavior-1); a divider in an emptied
 * document is created (DR-behavior-2); a shed block's own kind keeps it in
 * its list (DR-behavior-3). Expected states are hand-authored from
 * Notion's behavior.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Plugin } from '$lib/plugins.js';
import type { JSONBlock } from '$lib/utils/json.js';
import { mentionPlugin } from '../../atMention.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { codePlugin } from '$lib/plugins/code/CodePlugin.svelte';
import { markdownShortcutsPlugin } from '$lib/plugins/markdownShortcuts.js';
import { slashMenuPlugin } from '$lib/plugins/slashMenu/slashMenuPlugin.js';
import { convertBlocks, convertToKind } from '$lib/kinds.js';
import { richTextOperations } from '$lib/plugins/richtext/richTextOperations.js';
import {
	dispatchClipboardPaste,
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

const text = (value: string) => [{ text: value }];
const block = (type: string, id: string, children?: JSONBlock[], value = id): JSONBlock => ({
	id,
	type,
	content: text(value),
	...(children && { children })
});
const p = (id: string, children?: JSONBlock[]) => block('paragraph', id, children);
const li = (id: string, children?: JSONBlock[]) => block('list-item', id, children);
const empty = (id: string) => block('list-item', id, undefined, '');
const divider = (id: string): JSONBlock => ({ id, type: 'divider' });
const list =
	(type: string) =>
	(id: string, children: JSONBlock[]): JSONBlock => ({ id, type, children });
const ul = list('unordered-list');
const ol = list('ordered-list');

/** The tree as `type "text"` lines, a block with children as `[line, children]`. */
const shape = ({ edytor }: View) => {
	const show = (b: JSONBlock): unknown => {
		const own = (b.content ?? []).map((part) => ('text' in part ? part.text : '@')).join('');
		const line = `${b.type} "${own}"`;
		return b.children?.length ? [line, b.children.map(show)] : line;
	};
	return (edytor.value.children ?? []).map(show);
};
const get = ({ edytor }: View, id: string) => edytor.idToBlock.get(id)!;
/** The caret's block kind and text, and its offset. */
const caret = ({ edytor }: View) => {
	const { startBlock, yStart } = edytor.selection.state;
	return [startBlock?.type, startBlock?.firstText?.stringContent, yStart];
};
const at = async (view: View, id: string, offset: number) => {
	view.edytor.selection.setAtTextOffset(get(view, id).firstText!, offset);
	await flushDomUpdates();
};
const range = async (view: View, from: string, to: string) => {
	view.edytor.selection.setAtRange(get(view, from).firstText!, 0, get(view, to).firstText!, 1);
	await flushDomUpdates();
};
const selectBlocks = async (view: View, ...ids: string[]) => {
	view.edytor.selection.selectBlocks(...ids.map((id) => get(view, id)));
	await flushDomUpdates();
};
const type = async (view: View, value: string) => {
	for (const data of value)
		await dispatchDomBeforeInput(view.editor, { inputType: 'insertText', data });
};
const turnInto = (digit: string) =>
	dispatchDomKeyDown(document, { key: digit, code: `Digit${digit}`, ctrlKey: true, altKey: true });
const slash = async (view: View, query: string) => {
	await type(view, `/${query}`);
	await dispatchDomKeyDown(document, { key: 'Enter', code: 'Enter' });
};
const undo = () => dispatchDomKeyDown(document, { key: 'z', ctrlKey: true });
const tab = (shiftKey = false) => dispatchDomKeyDown(document, { key: 'Tab', shiftKey });
const row = (view: View, label: string) => view.edytor.kinds.find((kind) => kind.label === label)!;

const U = 'unordered-list ""';
const O = 'ordered-list ""';

describe('Turn into a kind that replaces the block, in a list (AW-01)', () => {
	/** `u[a, b, e, c]`: e is an empty item. */
	const seed = () => [ul('u', [li('a'), li('b'), empty('e'), li('c')])];
	/** A divider after b: the list splits after b, a paragraph after the divider takes the caret. */
	const dividerAfterB = [
		[U, ['list-item "a"', 'list-item "b"']],
		'divider ""',
		'paragraph ""',
		[U, ['list-item ""', 'list-item "c"']]
	];
	/** e turned into a divider: it leaves the list, a paragraph after it takes the caret. */
	const dividerForE = [
		[U, ['list-item "a"', 'list-item "b"']],
		'divider ""',
		'paragraph ""',
		[U, ['list-item "c"']]
	];
	const codeAfterB = [
		[U, ['list-item "a"', 'list-item "b"']],
		['code ""', ['codeLine ""']],
		[U, ['list-item ""', 'list-item "c"']]
	];
	const codeForE = [
		[U, ['list-item "a"', 'list-item "b"']],
		['code ""', ['codeLine ""']],
		[U, ['list-item "c"']]
	];

	it('Divider on an item with text: inserted after it, outside the list; one undo restores it', async () => {
		const view = await render([], seed());
		const before = shape(view);
		expect(convertToKind(view.edytor, get(view, 'b'), row(view, 'Divider'))).toBe(true);
		await flushDomUpdates();
		expect(shape(view)).toEqual(dividerAfterB);
		expect(caret(view)).toEqual(['paragraph', '', 0]);
		await undo();
		expect(shape(view)).toEqual(before);
	});

	it('Divider on an empty item: the item leaves the list as the divider', async () => {
		const view = await render([], seed());
		expect(convertToKind(view.edytor, get(view, 'e'), row(view, 'Divider'))).toBe(true);
		await flushDomUpdates();
		expect(shape(view)).toEqual(dividerForE);
		expect(caret(view)).toEqual(['paragraph', '', 0]);
	});

	it('the slash menu’s Divider does the same, on an item with text and on an empty one', async () => {
		const withText = await render([slashMenuPlugin], seed());
		await at(withText, 'b', 0);
		await slash(withText, 'divider');
		expect(shape(withText)).toEqual(dividerAfterB);
		document.body.innerHTML = '';
		const emptyItem = await render([slashMenuPlugin], seed());
		await at(emptyItem, 'e', 0);
		await slash(emptyItem, 'divider');
		expect(shape(emptyItem)).toEqual(dividerForE);
	});

	it('typing "---" in an empty item does the same', async () => {
		const view = await render([markdownShortcutsPlugin], seed());
		await at(view, 'e', 0);
		await type(view, '---');
		expect(shape(view)).toEqual(dividerForE);
		expect(caret(view)).toEqual(['paragraph', '', 0]);
	});

	it('Code (Mod+Alt+8) on an item with text: the code block goes after it, outside the list', async () => {
		const view = await render([], seed());
		await at(view, 'b', 1);
		await turnInto('8');
		expect(shape(view)).toEqual(codeAfterB);
		expect(caret(view)).toEqual(['codeLine', '', 0]);
	});

	it('Code on an empty item, through the key, the slash menu and "```"', async () => {
		const key = await render([], seed());
		await at(key, 'e', 0);
		await turnInto('8');
		expect(shape(key)).toEqual(codeForE);
		expect(caret(key)).toEqual(['codeLine', '', 0]);
		document.body.innerHTML = '';
		const menu = await render([slashMenuPlugin], seed());
		await at(menu, 'e', 0);
		await slash(menu, 'code');
		expect(shape(menu)).toEqual(codeForE);
		document.body.innerHTML = '';
		const typed = await render([markdownShortcutsPlugin], seed());
		await at(typed, 'e', 0);
		await type(typed, '```');
		expect(shape(typed)).toEqual(codeForE);
	});

	it('in a list nested in an item, the divider stays under that item, after the list', async () => {
		const view = await render([], [ul('u', [li('a', [ul('u2', [li('b')])]), li('c')])]);
		expect(convertToKind(view.edytor, get(view, 'b'), row(view, 'Divider'))).toBe(true);
		await flushDomUpdates();
		expect(shape(view)).toEqual([
			[
				U,
				[['list-item "a"', [[U, ['list-item "b"']], 'divider ""', 'paragraph ""']], 'list-item "c"']
			]
		]);
	});

	it('in a list nested right in a list, the code block leaves both lists', async () => {
		const view = await render([], [ul('u', [ul('u2', [li('b'), li('c')]), li('d')])]);
		await at(view, 'b', 1);
		await turnInto('8');
		expect(shape(view)).toEqual([
			[U, [[U, ['list-item "b"']]]],
			['code ""', ['codeLine ""']],
			[U, [[U, ['list-item "c"']], 'list-item "d"']]
		]);
	});

	it('a divider after a paragraph at the root is unchanged: right after it', async () => {
		const view = await render([], [p('x'), p('y')]);
		expect(convertToKind(view.edytor, get(view, 'x'), row(view, 'Divider'))).toBe(true);
		await flushDomUpdates();
		expect(shape(view)).toEqual(['paragraph "x"', 'divider ""', 'paragraph ""', 'paragraph "y"']);
	});
});

describe('Tab and Shift+Tab over a text range entering a list (AW-02)', () => {
	/** Run `keys` over a text range, then over the same rows block-selected: both results. */
	const both = async (seed: () => JSONBlock[], [from, to]: [string, string], shiftKey: boolean) => {
		const text = await render([], seed());
		await range(text, from, to);
		await tab(shiftKey);
		const byText = shape(text);
		document.body.innerHTML = '';
		const blocks = await render([], seed());
		await selectBlocks(blocks, from, to);
		await tab(shiftKey);
		return [byText, shape(blocks)];
	};

	it('Shift+Tab from a nested paragraph to a first item: each leaves its parent', async () => {
		const [byText, byBlocks] = await both(
			() => [p('a', [p('m')]), ul('u', [li('c'), li('d')])],
			['m', 'c'],
			true
		);
		expect(byText).toEqual([
			'paragraph "a"',
			'paragraph "m"',
			'paragraph "c"',
			[U, ['list-item "d"']]
		]);
		expect(byText).toEqual(byBlocks);
	});

	it('Shift+Tab from the last item of a list to the first of the next: both leave their lists', async () => {
		const [byText, byBlocks] = await both(
			() => [ul('u', [li('a'), li('b')]), ul('u2', [li('c'), li('d')])],
			['b', 'c'],
			true
		);
		expect(byText).toEqual([
			[U, ['list-item "a"']],
			'paragraph "b"',
			'paragraph "c"',
			[U, ['list-item "d"']]
		]);
		expect(byText).toEqual(byBlocks);
	});

	it('Tab from a paragraph to a first item nests the paragraph only, never the whole list', async () => {
		const [byText, byBlocks] = await both(
			() => [p('a'), p('m'), ul('u', [li('c'), li('d')])],
			['m', 'c'],
			false
		);
		expect(byText).toEqual([
			['paragraph "a"', ['paragraph "m"']],
			[U, ['list-item "c"', 'list-item "d"']]
		]);
		expect(byText).toEqual(byBlocks);
	});

	it('the text range stays selected', async () => {
		const view = await render([], [p('a', [p('m')]), ul('u', [li('c'), li('d')])]);
		await range(view, 'm', 'c');
		await tab(true);
		const { startBlock, endBlock } = view.edytor.selection.state;
		expect([startBlock?.id, endBlock?.id]).toEqual(['m', 'c']);
	});
});

describe('A vetoed Turn into of an item of a list nested right in a list (AW-03)', () => {
	const veto: Plugin = () => ({
		onBeforeOperation: ({ operation, prevent }) => {
			if (operation === 'setBlock') prevent();
		}
	});
	const seed = () => [ul('u', [ul('u2', [li('b'), li('c')]), li('d')])];
	const unchanged = [[U, [[U, ['list-item "b"', 'list-item "c"']], 'list-item "d"']]];

	it('Mod+Alt+2 changes nothing and reports refused', async () => {
		const view = await render([veto], seed());
		await at(view, 'c', 1);
		await turnInto('2');
		expect(shape(view)).toEqual(unchanged);
		expect(view.edytor.dispatcher.last?.status).toBe('refused');
	});

	it('convertToKind answers false and changes nothing', async () => {
		const view = await render([veto], seed());
		expect(convertToKind(view.edytor, get(view, 'c'), row(view, 'Heading 2'))).toBe(false);
		expect(shape(view)).toEqual(unchanged);
	});

	it('typing "# " keeps the typed text and the lists', async () => {
		const view = await render([veto, markdownShortcutsPlugin], seed());
		await at(view, 'c', 0);
		await type(view, '# ');
		expect(shape(view)).toEqual([
			[U, [[U, ['list-item "b"', 'list-item "# c"']], 'list-item "d"']]
		]);
	});

	it('without the veto, the conversion and its lifts are one undo step', async () => {
		const view = await render([], seed());
		await at(view, 'c', 1);
		await turnInto('2');
		expect(shape(view)).toEqual([
			[U, [[U, ['list-item "b"']]]],
			'heading "c"',
			[U, ['list-item "d"']]
		]);
		expect(view.edytor.dispatcher.last?.status).toBe('applied');
		await undo();
		expect(shape(view)).toEqual(unchanged);
	});
});

describe('A block shed into a list is reordered within it (AW-06)', () => {
	const seed = () => [ul('u', [li('a'), divider('x'), li('c')])];

	it('the facade answers yes for a reorder in its own list, no for another list', async () => {
		const view = await render([], [...seed(), ul('v', [li('z')])]);
		const { facade } = view.edytor;
		expect(facade.canPlace(['x'], 'u')).toBe(true);
		expect(facade.canPlace(['x', 'c'], 'u')).toBe(true);
		expect(facade.canPlace(['x'], 'v')).toBe(false);
	});

	it('moving it up or down passes its neighbouring items; with an item it moves too', async () => {
		const view = await render([], seed());
		const { edytor } = view;
		expect(edytor.moveBlocks({ blocks: [get(view, 'x')], direction: 'up' }).length).toBe(1);
		expect(shape(view)).toEqual([[U, ['divider ""', 'list-item "a"', 'list-item "c"']]]);
		expect(
			edytor.moveBlocks({ blocks: [get(view, 'x'), get(view, 'a')], direction: 'down' }).length
		).toBe(2);
		expect(shape(view)).toEqual([[U, ['list-item "c"', 'divider ""', 'list-item "a"']]]);
	});
});

describe('Tab after a list ending in a block that holds no children (AW-07)', () => {
	const seed = () => [ul('u', [li('a'), divider('x')]), p('q')];

	it('is refused, as Tab under that block is; nothing moves', async () => {
		const view = await render([], seed());
		await at(view, 'q', 0);
		await tab();
		expect(shape(view)).toEqual([[U, ['list-item "a"', 'divider ""']], 'paragraph "q"']);
		expect(view.edytor.dispatcher.last?.status).toBe('refused');
	});

	it('a drop inside the list is refused the same way', async () => {
		const view = await render([], seed());
		const request = {
			blocks: [get(view, 'q')],
			target: get(view, 'u'),
			position: 'inside' as const
		};
		expect(view.edytor.canMoveBlocks(request)).toBe(false);
	});
});

describe('A pasted list joins the list it lands in (AW-08)', () => {
	const paste = async (view: View, html: string, plain: string) =>
		dispatchClipboardPaste(view.editor, { 'text/html': html, 'text/plain': plain });

	it('an <ol> pasted into the middle of an ordered list’s item gives items', async () => {
		const view = await render([], [ol('o', [li('a'), li('bb'), li('c')])]);
		await at(view, 'bb', 1);
		await paste(view, '<ol><li>x</li><li>y</li></ol>', 'x\ny');
		expect(shape(view)).toEqual([
			[O, ['list-item "a"', 'list-item "bx"', 'list-item "yb"', 'list-item "c"']]
		]);
	});

	it('a <ul> of three pasted into an unordered list’s item gives items', async () => {
		const view = await render([], [ul('u', [li('a'), li('bb')])]);
		await at(view, 'bb', 1);
		await paste(view, '<ul><li>x</li><li>m</li><li>y</li></ul>', 'x\nm\ny');
		expect(shape(view)).toEqual([
			[U, ['list-item "a"', 'list-item "bx"', 'list-item "m"', 'list-item "yb"']]
		]);
	});

	it('into an empty item, the item stays an item', async () => {
		const view = await render([], [ol('o', [li('a'), empty('e')])]);
		await at(view, 'e', 0);
		await paste(view, '<ol><li>x</li></ol>', 'x');
		expect(shape(view)).toEqual([[O, ['list-item "a"', 'list-item "x"']]]);
	});

	it('the other list kind keeps its kind, as Turn into does', async () => {
		const view = await render([], [ol('o', [li('a'), li('bb')])]);
		await at(view, 'bb', 1);
		await paste(view, '<ul><li>x</li><li>y</li></ul>', 'x\ny');
		expect(shape(view)).toEqual([
			[O, ['list-item "a"', 'list-item "bx"', 'bulleted-list-item "yb"']]
		]);
	});
});

describe('Sweep: the list’s own kind on a block shed into it (SW10-lists-1)', () => {
	/** `u[a, h, c]`: h is a heading a merge shed into the list (DR-crdt-1). */
	const seed = () => [ul('u', [li('a'), block('heading', 'h'), li('c')])];

	it('Bulleted list (Mod+Alt+5) makes it the list’s item, in place', async () => {
		const view = await render([], seed());
		await at(view, 'h', 1);
		await turnInto('5');
		expect(shape(view)).toEqual([[U, ['list-item "a"', 'list-item "h"', 'list-item "c"']]]);
	});

	it('typing "- " at its start does the same', async () => {
		const view = await render([markdownShortcutsPlugin], seed());
		await at(view, 'h', 0);
		await type(view, '- ');
		expect(shape(view)).toEqual([[U, ['list-item "a"', 'list-item "h"', 'list-item "c"']]]);
	});

	it('another kind takes it out of the list, as it does an item', async () => {
		const view = await render([], seed());
		await at(view, 'h', 1);
		await turnInto('6');
		expect(shape(view)).toEqual([
			[U, ['list-item "a"']],
			'numbered-list-item "h"',
			[U, ['list-item "c"']]
		]);
	});
});

describe('Sweep: the native insertHorizontalRule in a list (SW10-lists-2)', () => {
	const seed = () => [ul('u', [li('a'), li('b'), empty('e'), li('c')])];
	const rule = (view: View) =>
		dispatchDomBeforeInput(view.editor, { inputType: 'insertHorizontalRule' });

	it('after an item with text, the divider goes after it, outside the list', async () => {
		const view = await render([], seed());
		await at(view, 'b', 1);
		await rule(view);
		expect(shape(view)).toEqual([
			[U, ['list-item "a"', 'list-item "b"']],
			'divider ""',
			'paragraph ""',
			[U, ['list-item ""', 'list-item "c"']]
		]);
		expect(caret(view)).toEqual(['paragraph', '', 0]);
	});

	it('in an empty item, the item leaves the list as the divider', async () => {
		const view = await render([], seed());
		await at(view, 'e', 0);
		await rule(view);
		expect(shape(view)).toEqual([
			[U, ['list-item "a"', 'list-item "b"']],
			'divider ""',
			'paragraph ""',
			[U, ['list-item "c"']]
		]);
	});

	it('mid-text in an item, the text stays whole and the divider goes after it', async () => {
		const view = await render([], [ul('u', [li('ab'), li('c')])]);
		await at(view, 'ab', 1);
		await rule(view);
		expect(shape(view)).toEqual([
			[U, ['list-item "ab"']],
			'divider ""',
			'paragraph ""',
			[U, ['list-item "c"']]
		]);
	});
});

describe('Sweep: Turn into in an emptied document (SW10-lists-3)', () => {
	/** A document whose only block was deleted: it shows the virtual paragraph. */
	const emptied = async (plugins: Plugin[] = []) => {
		const view = await render(plugins, [p('x')]);
		get(view, 'x').removeBlock();
		await flushDomUpdates();
		return view;
	};

	it('Mod+Alt+1 turns the empty line into a heading, the caret in it', async () => {
		const view = await emptied();
		const [line] = view.edytor.root!.children;
		expect(line?.convertible).toBe(true);
		view.edytor.selection.setAtTextOffset(line!.firstText!, 0);
		await flushDomUpdates();
		await turnInto('1');
		expect(shape(view)).toEqual(['heading ""']);
		expect(caret(view)).toEqual(['heading', '', 0]);
	});

	it('Mod+Alt+8 turns it into a code block', async () => {
		const view = await emptied();
		view.edytor.selection.setAtTextOffset(view.edytor.root!.children[0]!.firstText!, 0);
		await flushDomUpdates();
		await turnInto('8');
		expect(shape(view)).toEqual([['code ""', ['codeLine ""']]]);
	});
});

describe('Tab and Shift+Tab over a text range that runs through a list (DR-behavior-1)', () => {
	it('Tab from the paragraph above a list to the one below nests all of it, in order', async () => {
		const view = await render([], [p('z'), p('a'), ul('u', [li('c'), li('d')]), p('e')]);
		await range(view, 'a', 'e');
		await tab();
		expect(shape(view)).toEqual([
			['paragraph "z"', ['paragraph "a"', [U, ['list-item "c"', 'list-item "d"']], 'paragraph "e"']]
		]);
		const { startBlock, endBlock } = view.edytor.selection.state;
		expect([startBlock?.id, endBlock?.id]).toEqual(['a', 'e']);
	});

	it('Shift+Tab over the same span nested in a paragraph outdents it, in order', async () => {
		const view = await render([], [p('x', [p('a'), ul('u', [li('c'), li('d')]), p('e')])]);
		await range(view, 'a', 'e');
		await tab(true);
		expect(shape(view)).toEqual([
			'paragraph "x"',
			'paragraph "a"',
			[U, ['list-item "c"', 'list-item "d"']],
			'paragraph "e"'
		]);
	});

	it('a block selection with a gap moves each run on its own, never reordering', async () => {
		const view = await render([], [p('z'), p('a'), p('m'), p('e')]);
		await selectBlocks(view, 'a', 'e');
		await tab();
		expect(shape(view)).toEqual([
			['paragraph "z"', ['paragraph "a"']],
			['paragraph "m"', ['paragraph "e"']]
		]);
	});
});

describe('A divider in an emptied document (DR-behavior-2)', () => {
	const emptied = async (plugins: Plugin[] = []) => {
		const view = await render(plugins, [p('x')]);
		get(view, 'x').removeBlock();
		await flushDomUpdates();
		view.edytor.selection.setAtTextOffset(view.edytor.root!.children[0]!.firstText!, 0);
		await flushDomUpdates();
		return view;
	};
	const after = ['divider ""', 'paragraph ""'];

	it('the native insertHorizontalRule creates the divider, a paragraph after it takes the caret', async () => {
		const view = await emptied();
		await dispatchDomBeforeInput(view.editor, { inputType: 'insertHorizontalRule' });
		expect(shape(view)).toEqual(after);
		expect(caret(view)).toEqual(['paragraph', '', 0]);
		expect(view.edytor.dispatcher.last?.status).toBe('applied');
		await undo();
		expect(view.edytor.value.children ?? []).toEqual([]);
	});

	it('richTextOperations’ insertDividerAtSelection does the same', async () => {
		const view = await emptied();
		expect(richTextOperations(view.edytor).insertDividerAtSelection()).toBeTruthy();
		expect(shape(view)).toEqual(after);
	});

	it('convertToKind with Divider does the same', async () => {
		const view = await emptied();
		const [line] = view.edytor.root!.children;
		expect(convertToKind(view.edytor, line, row(view, 'Divider'))).toBe(true);
		expect(shape(view)).toEqual(after);
		expect(caret(view)).toEqual(['paragraph', '', 0]);
	});
});

describe('Turn into a shed block’s own kind keeps it in its list (DR-behavior-3)', () => {
	const seed = (shed: JSONBlock) => [ul('u', [li('a'), shed, li('c')])];
	const heading: JSONBlock = { ...block('heading', 'h'), data: { level: 'h1' } };
	const todo: JSONBlock = { ...block('todo-item', 'h'), data: { checked: true } };
	const inPlace = (type: string) => [[U, ['list-item "a"', `${type} "h"`, 'list-item "c"']]];
	const data = (view: View) => get(view, 'h').value.data;

	it('Heading 2 (Mod+Alt+2) on a shed heading changes its level, in place', async () => {
		const view = await render([], seed(heading));
		await at(view, 'h', 1);
		await turnInto('2');
		expect(shape(view)).toEqual(inPlace('heading'));
		expect(data(view)).toEqual({ level: 'h2' });
	});

	it('typing "## " at its start does the same', async () => {
		const view = await render([markdownShortcutsPlugin], seed(heading));
		await at(view, 'h', 0);
		await type(view, '## ');
		expect(shape(view)).toEqual(inPlace('heading'));
		expect(data(view)).toEqual({ level: 'h2' });
	});

	it('Quote on a shed quote changes nothing', async () => {
		const view = await render([], seed(block('quote', 'h')));
		await at(view, 'h', 1);
		convertToKind(view.edytor, get(view, 'h'), row(view, 'Quote'));
		expect(shape(view)).toEqual(inPlace('quote'));
	});

	it('To-do list on a shed to-do keeps it in the list', async () => {
		const view = await render([], seed(todo));
		await at(view, 'h', 1);
		convertToKind(view.edytor, get(view, 'h'), row(view, 'To-do list'));
		expect(shape(view)).toEqual(inPlace('todo-item'));
	});

	it('several selected rows, the shed one among them, keep it in the list too', async () => {
		const view = await render([], seed(heading));
		await selectBlocks(view, 'a', 'h');
		convertBlocks(view.edytor, [get(view, 'h')], row(view, 'Heading 2'));
		expect(shape(view)).toEqual(inPlace('heading'));
	});
});
