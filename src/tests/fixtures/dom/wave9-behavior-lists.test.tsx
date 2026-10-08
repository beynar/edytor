/** @jsxImportSource ../../jsx */
/**
 * Wave 9 follow-up, list items (DR-behavior): Enter in an empty item of a
 * nested list outdents it level by level, then ends the list (DR-behavior-1);
 * Turn into on an item of a list nested right in a list leaves every list
 * (DR-behavior-2); Turn into the kind an item already shows as keeps it in
 * its list, and the menus name it by that kind (DR-behavior-3). Expected
 * states are hand-authored from Notion's behavior.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Plugin } from '$lib/plugins.js';
import type { JSONBlock } from '$lib/utils/json.js';
import { mentionPlugin } from '../../atMention.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { toolbarPlugin } from '$lib/plugins/toolbar/toolbarPlugin.js';
import { markdownShortcutsPlugin } from '$lib/plugins/markdownShortcuts.js';
import { slashMenuPlugin } from '$lib/plugins/slashMenu/slashMenuPlugin.js';
import { rowOf } from '$lib/kinds.js';
import {
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
		{ plugins: [richTextPlugin, mentionPlugin, ...plugins], value: { children } }
	);
type View = Awaited<ReturnType<typeof render>>;

const text = (value: string) => [{ text: value }];
const li = (id: string, children?: JSONBlock[]): JSONBlock => ({
	id,
	type: 'list-item',
	content: text(id),
	...(children && { children })
});
const empty = (id: string): JSONBlock => ({ id, type: 'list-item', content: text('') });
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
const caret = ({ edytor }: View) => {
	const { startBlock, yStart } = edytor.selection.state;
	return [startBlock?.id, yStart];
};
const at = async (view: View, id: string, offset: number) => {
	view.edytor.selection.setAtTextOffset(get(view, id).firstText!, offset);
	await flushDomUpdates();
};
const enter = (view: View) => dispatchDomBeforeInput(view.editor, { inputType: 'insertParagraph' });
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

const U = 'unordered-list ""';
const O = 'ordered-list ""';

describe('Enter in an empty item of a nested list (DR-behavior-1)', () => {
	/** `u[a > [u2[b, e]], c]`: e is the empty last item of a list nested in item a. */
	const seed = () => [ul('u', [li('a', [ul('u2', [li('b'), empty('e')])]), li('c')])];

	it('outdents one level per Enter, then ends the list; the caret stays in the item', async () => {
		const view = await render([], seed());
		await at(view, 'e', 0);
		await enter(view);
		// Out of the sub-list: an item under a, as Shift+Tab lifts it (SW8-roles-4).
		expect(shape(view)).toEqual([
			[U, [['list-item "a"', [[U, ['list-item "b"']], 'list-item ""']], 'list-item "c"']]
		]);
		expect(caret(view)).toEqual(['e', 0]);
		await enter(view);
		// Out of a: an item of the outer list, after a.
		expect(shape(view)).toEqual([
			[U, [['list-item "a"', [[U, ['list-item "b"']]]], 'list-item ""', 'list-item "c"']]
		]);
		expect(caret(view)).toEqual(['e', 0]);
		await enter(view);
		// Out of the list: a paragraph splitting it (SW9-lists-1).
		expect(shape(view)).toEqual([
			[U, [['list-item "a"', [[U, ['list-item "b"']]]]]],
			'paragraph ""',
			[U, ['list-item "c"']]
		]);
		expect(caret(view)).toEqual(['e', 0]);
	});

	it('the first two Enters match two Shift+Tabs', async () => {
		const keys = await render([], seed());
		await at(keys, 'e', 0);
		await enter(keys);
		await enter(keys);
		const expected = shape(keys);
		document.body.innerHTML = '';
		const tabs = await render([], seed());
		await at(tabs, 'e', 0);
		await dispatchDomKeyDown(document, { key: 'Tab', shiftKey: true });
		await dispatchDomKeyDown(document, { key: 'Tab', shiftKey: true });
		expect(shape(tabs)).toEqual(expected);
	});

	it('an empty item under an item of another kind still splits it', async () => {
		const view = await render([], [li('a', [{ id: 'x', type: 'paragraph', content: text('') }])]);
		await at(view, 'x', 0);
		await enter(view);
		expect(shape(view)).toEqual([['list-item "a"', ['paragraph ""', 'paragraph ""']]]);
	});
});

describe('Turn into on an item of a list nested right in a list (DR-behavior-2)', () => {
	it('the first item leaves both lists, before them', async () => {
		const view = await render([], [ul('u', [ul('u2', [li('b'), li('c')]), li('d')])]);
		await at(view, 'b', 1);
		await turnInto('2');
		expect(shape(view)).toEqual(['heading "b"', [U, [[U, ['list-item "c"']], 'list-item "d"']]]);
		expect(caret(view)).toEqual(['b', 1]);
		expect(view.edytor.dispatcher.last?.status).toBe('applied');
	});

	it('a middle item splits both lists; one undo restores them', async () => {
		const seed = [ul('u', [ul('u2', [li('b'), li('c'), li('x')]), li('d')])];
		const view = await render([], seed);
		const before = shape(view);
		await at(view, 'c', 1);
		await turnInto('2');
		expect(shape(view)).toEqual([
			[U, [[U, ['list-item "b"']]]],
			'heading "c"',
			[U, [[U, ['list-item "x"']], 'list-item "d"']]
		]);
		await undo();
		expect(shape(view)).toEqual(before);
	});

	it('the markdown shortcut on the last item does the same', async () => {
		const view = await render(
			[markdownShortcutsPlugin],
			[ul('u', [ul('u2', [li('b'), li('c')]), li('d')])]
		);
		await at(view, 'c', 0);
		await type(view, '# ');
		expect(shape(view)).toEqual([
			[U, [[U, ['list-item "b"']]]],
			'heading "c"',
			[U, ['list-item "d"']]
		]);
	});

	it('the slash menu on the first item does the same, its query removed; one undo restores it', async () => {
		const view = await render(
			[slashMenuPlugin],
			[ul('u', [ul('u2', [li('b'), li('c')]), li('d')])]
		);
		await at(view, 'b', 0);
		await slash(view, 'h2');
		expect(shape(view)).toEqual(['heading "b"', [U, [[U, ['list-item "c"']], 'list-item "d"']]]);
		// One step back: the lists as they were, the typed query back.
		await undo();
		expect(shape(view)).toEqual([
			[U, [[U, ['list-item "/h2b"', 'list-item "c"']], 'list-item "d"']]
		]);
	});

	it('an item of a list nested in an item stays under that item', async () => {
		const view = await render([], [ul('u', [li('a', [ul('u2', [li('b')])])])]);
		await at(view, 'b', 1);
		await turnInto('2');
		expect(shape(view)).toEqual([[U, [['list-item "a"', ['heading "b"']]]]]);
	});
});

describe('Turn into the kind an item already shows as (DR-behavior-3)', () => {
	const three = (of: typeof ul) => [of('l', [li('a'), li('b'), li('c')])];

	it('Numbered list on an item of an ordered list keeps it in the list', async () => {
		const view = await render([], three(ol));
		await at(view, 'b', 1);
		await turnInto('6');
		expect(shape(view)).toEqual([[O, ['list-item "a"', 'list-item "b"', 'list-item "c"']]]);
		expect(caret(view)).toEqual(['b', 1]);
	});

	it('Bulleted list on an item of an unordered list keeps it in the list', async () => {
		const view = await render([], three(ul));
		await at(view, 'b', 1);
		await turnInto('5');
		expect(shape(view)).toEqual([[U, ['list-item "a"', 'list-item "b"', 'list-item "c"']]]);
	});

	it('the slash menu’s Numbered list on an ordered item removes only its query', async () => {
		const view = await render([slashMenuPlugin], three(ol));
		await at(view, 'b', 0);
		await slash(view, 'ol');
		expect(shape(view)).toEqual([[O, ['list-item "a"', 'list-item "b"', 'list-item "c"']]]);
	});

	it('the other list kind still takes the item out of the list', async () => {
		const view = await render([], three(ol));
		await at(view, 'b', 1);
		await turnInto('5');
		expect(shape(view)).toEqual([
			[O, ['list-item "a"']],
			'bulleted-list-item "b"',
			[O, ['list-item "c"']]
		]);
	});

	it('typing "- " or "1. " at an item’s start acts as on a flat item of that kind', async () => {
		const flat = await render(
			[markdownShortcutsPlugin],
			[{ id: 'f', type: 'bulleted-list-item', content: text('f') }]
		);
		await at(flat, 'f', 0);
		await type(flat, '- ');
		const flatText = get(flat, 'f').firstText!.stringContent;
		document.body.innerHTML = '';

		const bullets = await render([markdownShortcutsPlugin], three(ul));
		await at(bullets, 'b', 0);
		await type(bullets, '- ');
		expect(shape(bullets)).toEqual([
			[U, ['list-item "a"', `list-item "${flatText.replace('f', 'b')}"`, 'list-item "c"']]
		]);
		document.body.innerHTML = '';

		const numbers = await render([markdownShortcutsPlugin], three(ol));
		await at(numbers, 'b', 0);
		await type(numbers, '1. ');
		expect(shape(numbers)).toEqual([[O, ['list-item "a"', 'list-item "b"', 'list-item "c"']]]);
	});

	it('the menus name an item by its list’s kind', async () => {
		const view = await render(
			[toolbarPlugin],
			[...three(ul), ...three(ol).map((l) => ({ ...l, id: 'o', children: [li('n')] }))]
		);
		expect(rowOf(view.edytor, get(view, 'b'))?.label).toBe('Bulleted list');
		expect(rowOf(view.edytor, get(view, 'n'))?.label).toBe('Numbered list');
		view.edytor.selection.setAtRange(get(view, 'b').firstText!, 0, get(view, 'b').firstText!, 1);
		await flushDomUpdates();
		expect(document.querySelector('.toolbar-type')?.textContent).toBe('Bulleted list');
	});
});
