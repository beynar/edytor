/** @jsxImportSource ../../jsx */
/**
 * Input rules, triggers and the public caret (WU-15, WU-24). Expected
 * values come from the API's contract (site `plugins/input-rules`,
 * `plugins/mention`, `plugins/page-link`) and Notion:
 *
 * - a caret is `{ block, offset }` in block offsets, an inline atom counting 1;
 * - an input rule replaces the matched text and the typed text as one
 *   command and one undo step (undo gives back the text before the typed
 *   character); a refused or declined replacement types the text as typed;
 * - `@` at a text's start or after whitespace opens the people menu; the
 *   text after it filters it; Enter picks the highlighted person: `@query`
 *   becomes a `mention` atom, the caret after it, one undo step; Escape
 *   closes it and keeps the text; `a@b` opens nothing;
 * - `[[` opens the page menu; a pick is an `<a>` atom to the page;
 * - the root holds the keyboard: it names the listbox and its highlighted row.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { JSONBlock } from '$lib/utils/json.js';
import type { InputRule, Plugin } from '$lib/plugins.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { codePlugin } from '$lib/plugins/code/CodePlugin.svelte';
import { createMentionPlugin, type MentionItem } from '$lib/plugins/mention/MentionPlugin.svelte';
import {
	createPageLinkPlugin,
	type PageLinkItem
} from '$lib/plugins/pageLink/PageLinkPlugin.svelte';
import {
	dispatchComposition,
	dispatchDomBeforeInput,
	dispatchDomKeyDown,
	flushDomUpdates,
	renderDomEdytor,
	type RenderDomEdytorOptions
} from '../../dom/test.utils.js';

afterEach(() => {
	document.body.innerHTML = '';
});

const p = (id: string, text = id): JSONBlock => ({ id, type: 'paragraph', content: [{ text }] });

const render = (
	children: JSONBlock[],
	plugins: Plugin[] = [],
	options: RenderDomEdytorOptions = {}
) =>
	renderDomEdytor(
		<root>
			<paragraph>|</paragraph>
		</root>,
		{ plugins: [...plugins, richTextPlugin], value: { children }, ...options }
	);

const type = async (editor: HTMLElement, value: string) => {
	for (const data of value) await dispatchDomBeforeInput(editor, { inputType: 'insertText', data });
};
const caretAt = async (edytor: Edytor, id: string, offset: number) => {
	edytor.selection.setCaret({ block: edytor.idToBlock.get(id)!, offset });
	await flushDomUpdates();
};
const named = (id: string | null) => (id ? document.getElementById(id) : null);
/** The block's content as text, an atom as `[type:label]`. */
const contentOf = (edytor: Edytor, id: string) =>
	(edytor.idToBlock.get(id)!.value.content ?? [])
		.map((part) =>
			'text' in part
				? part.text
				: `[${part.type}:${(part.data as Record<string, string>)?.label ?? (part.data as Record<string, string>)?.title}]`
		)
		.join('');
const caretOf = (edytor: Edytor) => {
	const caret = edytor.selection.caret;
	return caret && { block: caret.block.id, offset: caret.offset };
};

const EMOJI: Record<string, string> = { smile: '😄', heart: '❤️' };
const emoji: InputRule = {
	find: /:(\w+):$/,
	replace: ([, name]) => EMOJI[name!] ?? null
};
const emojiPlugin: Plugin = () => ({ inputRules: [emoji] });

describe('the caret in block offsets', () => {
	it('reads and sets a caret as { block, offset }, an atom counting 1', async () => {
		const { edytor } = await render([
			{
				id: 'a',
				type: 'paragraph',
				content: [{ text: 'hi ' }, { type: 'widget', data: {} }, { text: 'there' }]
			}
		]);
		await caretAt(edytor, 'a', 6);
		expect(caretOf(edytor)).toEqual({ block: 'a', offset: 6 });
		// The text after the atom: offset 6 is 2 into "there".
		expect(edytor.selection.state.startText?.stringContent).toBe('there');
		expect(edytor.selection.state.yStart).toBe(2);
		edytor.selection.setAtRange(
			edytor.idToBlock.get('a')!.firstText,
			0,
			edytor.idToBlock.get('a')!.firstText,
			2
		);
		expect(edytor.selection.caret).toBeNull();
	});

	it('dispatcher.caret takes { block, offset }', async () => {
		const { edytor } = await render([p('a', 'hello')]);
		const block = edytor.idToBlock.get('a')!;
		edytor.dispatcher.caret({ block, offset: 3 });
		expect(caretOf(edytor)).toEqual({ block: 'a', offset: 3 });
	});

	it('addInlineBlock takes a block offset', async () => {
		const { edytor } = await render([p('a', 'hello')]);
		const block = edytor.idToBlock.get('a')!;
		const after = block.addInlineBlock({ offset: 2, block: { type: 'widget', data: {} } });
		expect(after?.stringContent).toBe('llo');
		expect(block.value.content).toEqual([
			{ text: 'he' },
			expect.objectContaining({ type: 'widget' }),
			{ text: 'llo' }
		]);
	});
});

describe('input rules', () => {
	it('a string replaces the match: one step, the caret after it, undo gives the text typed before', async () => {
		const { edytor, editor } = await render([p('a', 'hi :smile')], [emojiPlugin]);
		await caretAt(edytor, 'a', 9);
		const steps = edytor.undoManager.undoStack.length;
		await type(editor, ':');
		expect(contentOf(edytor, 'a')).toBe('hi 😄');
		expect(caretOf(edytor)).toEqual({ block: 'a', offset: 5 });
		expect(edytor.undoManager.undoStack.length).toBe(steps + 1);
		edytor.historyUndo();
		await flushDomUpdates();
		expect(contentOf(edytor, 'a')).toBe('hi :smile');
	});

	it('typing goes on after the replacement', async () => {
		const { edytor, editor } = await render([p('a', '')], [emojiPlugin]);
		await caretAt(edytor, 'a', 0);
		await type(editor, 'I :heart: it');
		expect(contentOf(edytor, 'a')).toBe('I ❤️ it');
	});

	it('a declined match types the text as typed', async () => {
		const { edytor, editor } = await render([p('a', 'hi :nope')], [emojiPlugin]);
		await caretAt(edytor, 'a', 8);
		await type(editor, ':');
		expect(contentOf(edytor, 'a')).toBe('hi :nope:');
		expect(caretOf(edytor)).toEqual({ block: 'a', offset: 9 });
	});

	it('a refused replacement types the text as typed and keeps the match', async () => {
		const veto: Plugin = () => ({
			onBeforeOperation: ({ operation, prevent }) => {
				if (operation === 'deleteContentAtRange') prevent();
			}
		});
		const { edytor, editor } = await render([p('a', 'hi :smile')], [emojiPlugin, veto]);
		await caretAt(edytor, 'a', 9);
		await type(editor, ':');
		expect(contentOf(edytor, 'a')).toBe('hi :smile:');
		expect(caretOf(edytor)).toEqual({ block: 'a', offset: 10 });
	});

	it('ctx.from and ctx.to are block offsets: after an inline atom too', async () => {
		const seen: number[][] = [];
		const probe: Plugin = () => ({
			inputRules: [
				{
					find: /->$/,
					replace: (_match, { from, to }) => {
						seen.push([from, to]);
						return '→';
					}
				}
			]
		});
		const { edytor, editor } = await render(
			[
				{
					id: 'a',
					type: 'paragraph',
					content: [{ text: 'ab' }, { type: 'widget', data: {} }, { text: 'c-' }]
				}
			],
			[probe]
		);
		await caretAt(edytor, 'a', 5);
		await type(editor, '>');
		// "ab" (2) + the atom (1) + "c" (1): the match starts at 4, the caret is at 5.
		expect(seen).toEqual([[4, 5]]);
		expect(edytor.idToBlock.get('a')!.lastText?.stringContent).toBe('c→');
	});

	it('the first rule that writes wins; a declining one hands over to the next', async () => {
		const first: InputRule = { find: /x$/, replace: () => false };
		const second: InputRule = { find: /ax$/, replace: () => 'Y' };
		const { edytor, editor } = await render(
			[p('a', 'a')],
			[() => ({ inputRules: [first, second] })]
		);
		await caretAt(edytor, 'a', 1);
		await type(editor, 'x');
		expect(contentOf(edytor, 'a')).toBe('Y');
	});

	it('ctx.remove leads the rule operation: one step, refused together', async () => {
		const arrowTodo: Plugin = () => ({
			inputRules: [
				{
					find: /^->\s$/,
					replace: (_match, { block, from, remove }) =>
						from === 0 &&
						remove(() => {
							block.type = 'todo-item';
						})
				}
			]
		});
		const { edytor, editor } = await render([p('a', '-')], [arrowTodo]);
		await caretAt(edytor, 'a', 1);
		const steps = edytor.undoManager.undoStack.length;
		await type(editor, '> buy');
		const block = edytor.idToBlock.get('a')!;
		expect(block.type).toBe('todo-item');
		expect(contentOf(edytor, 'a')).toBe('buy');
		edytor.historyUndo();
		await flushDomUpdates();
		edytor.historyUndo();
		await flushDomUpdates();
		expect(edytor.idToBlock.get('a')!.type).toBe('paragraph');
		expect(contentOf(edytor, 'a')).toBe('->');
		expect(edytor.undoManager.undoStack.length).toBeGreaterThanOrEqual(steps);

		const veto: Plugin = () => ({
			onBeforeOperation: ({ operation, prevent }) => {
				if (operation === 'setBlock') prevent();
			}
		});
		document.body.innerHTML = '';
		const vetoed = await render([p('b', '->')], [arrowTodo, veto]);
		await caretAt(vetoed.edytor, 'b', 2);
		await type(vetoed.editor, ' ');
		expect(vetoed.edytor.idToBlock.get('b')!.type).toBe('paragraph');
		expect(contentOf(vetoed.edytor, 'b')).toBe('-> ');
	});

	it('rules do not run in a code block', async () => {
		const { edytor, editor } = await render(
			[
				{
					id: 'code',
					type: 'code',
					children: [{ id: 'line', type: 'codeLine', content: [{ text: ':smile' }] }]
				}
			],
			[emojiPlugin, codePlugin]
		);
		await caretAt(edytor, 'line', 6);
		await type(editor, ':');
		expect(contentOf(edytor, 'line')).toBe(':smile:');
	});
});

const PEOPLE: MentionItem[] = [
	{ id: 'u1', label: 'Ada Lovelace' },
	{ id: 'u2', label: 'Alan Turing' },
	{ id: 'u3', label: 'Grace Hopper' }
];
const people = (query: string) =>
	PEOPLE.filter((person) => person.label.toLowerCase().includes(query.toLowerCase()));
const rows = () => [...document.querySelectorAll('[data-testid="trigger-menu-item"]')];
/** The rows' names (a person's row shows an initial before it). */
const labels = () =>
	rows().map((row) => row.querySelector('.name')?.textContent ?? row.textContent?.trim());

describe('the @ mention menu', () => {
	const mentions = createMentionPlugin({ items: people });

	it('opens at the caret, filters by the query, and Enter inserts the person', async () => {
		const { edytor, editor } = await render([p('a', 'hi ')], [mentions]);
		await caretAt(edytor, 'a', 3);
		const steps = edytor.undoManager.undoStack.length;
		await type(editor, '@');
		expect(labels()).toEqual(['Ada Lovelace', 'Alan Turing', 'Grace Hopper']);
		await type(editor, 'tur');
		expect(labels()).toEqual(['Alan Turing']);
		const typed = edytor.undoManager.undoStack.length;
		const { defaultPrevented } = await dispatchDomKeyDown(document, { key: 'Enter' });
		expect(defaultPrevented).toBe(true);
		expect(contentOf(edytor, 'a')).toBe('hi [mention:Alan Turing]');
		expect(caretOf(edytor)).toEqual({ block: 'a', offset: 4 });
		expect(rows()).toEqual([]);
		expect(edytor.undoManager.undoStack.length).toBeGreaterThan(steps);
		// The pick is one step of its own: undo gives back the typed query.
		expect(edytor.undoManager.undoStack.length).toBe(typed + 1);
		edytor.historyUndo();
		await flushDomUpdates();
		expect(contentOf(edytor, 'a')).toBe('hi @tur');
	});

	it('the arrows move the highlight, which the root names', async () => {
		const { edytor, editor } = await render([p('a', '')], [mentions]);
		await caretAt(edytor, 'a', 0);
		await type(editor, '@');
		const listbox = named(editor.getAttribute('aria-controls'));
		expect(listbox?.getAttribute('role')).toBe('listbox');
		expect(listbox?.getAttribute('aria-label')).toBe('People');
		expect(editor.getAttribute('aria-haspopup')).toBe('listbox');
		expect(named(editor.getAttribute('aria-activedescendant'))).toBe(rows()[0]);
		await dispatchDomKeyDown(document, { key: 'ArrowDown' });
		expect(named(editor.getAttribute('aria-activedescendant'))).toBe(rows()[1]);
		await dispatchDomKeyDown(document, { key: 'ArrowDown' });
		await dispatchDomKeyDown(document, { key: 'ArrowDown' });
		// Wraps around.
		expect(rows()[0]?.getAttribute('aria-selected')).toBe('true');
		await dispatchDomKeyDown(document, { key: 'ArrowUp' });
		await dispatchDomKeyDown(document, { key: 'Enter' });
		expect(contentOf(edytor, 'a')).toBe('[mention:Grace Hopper]');
		expect(editor.hasAttribute('aria-controls')).toBe(false);
	});

	it('Escape closes the menu and keeps the text', async () => {
		const { edytor, editor } = await render([p('a', '')], [mentions]);
		await caretAt(edytor, 'a', 0);
		await type(editor, '@ad');
		const { defaultPrevented } = await dispatchDomKeyDown(document, { key: 'Escape' });
		expect(defaultPrevented).toBe(true);
		expect(rows()).toEqual([]);
		expect(contentOf(edytor, 'a')).toBe('@ad');
		// Typing on does not reopen it.
		await type(editor, 'a');
		expect(rows()).toEqual([]);
	});

	it('an @ inside a word opens nothing (an email)', async () => {
		const { edytor, editor } = await render([p('a', 'ada')], [mentions]);
		await caretAt(edytor, 'a', 3);
		await type(editor, '@');
		expect(document.querySelector('[data-testid="trigger-menu"]')).toBeNull();
	});

	it('a query no one matches shows No results; a space after it closes the menu', async () => {
		const { edytor, editor } = await render([p('a', '')], [mentions]);
		await caretAt(edytor, 'a', 0);
		await type(editor, '@zz');
		expect(document.querySelector('[data-testid="trigger-menu-empty"]')?.textContent?.trim()).toBe(
			'No results'
		);
		const { defaultPrevented } = await dispatchDomKeyDown(document, { key: 'Enter' });
		// Enter with no row is the editor's (a new block).
		expect(defaultPrevented).toBe(false);
	});

	it('a space after an unmatched query closes the menu', async () => {
		const { edytor, editor } = await render([p('a', '')], [mentions]);
		await caretAt(edytor, 'a', 0);
		await type(editor, '@zz ');
		expect(document.querySelector('[data-testid="trigger-menu"]')).toBeNull();
	});

	it('the caret leaving the query closes the menu', async () => {
		const { edytor, editor } = await render([p('a', 'x '), p('b', 'y')], [mentions]);
		await caretAt(edytor, 'a', 2);
		await type(editor, '@');
		expect(rows().length).toBe(3);
		await caretAt(edytor, 'b', 1);
		expect(document.querySelector('[data-testid="trigger-menu"]')).toBeNull();
	});

	it('async items: the newest query wins', async () => {
		const pending: { query: string; resolve: (rows: MentionItem[]) => void }[] = [];
		const slow = createMentionPlugin({
			items: (query) => new Promise<MentionItem[]>((resolve) => pending.push({ query, resolve }))
		});
		const { edytor, editor } = await render([p('a', '')], [slow]);
		await caretAt(edytor, 'a', 0);
		await type(editor, '@a');
		expect(pending.map((call) => call.query)).toEqual(['', 'a']);
		pending[1]!.resolve([PEOPLE[0]!]);
		await flushDomUpdates();
		// The older answer, arriving late, is dropped.
		pending[0]!.resolve(PEOPLE);
		await flushDomUpdates();
		expect(labels()).toEqual(['Ada Lovelace']);
	});

	it('a refused pick keeps the query and puts the caret after it', async () => {
		const veto: Plugin = () => ({
			onBeforeOperation: ({ operation, prevent }) => {
				if (operation === 'addInlineBlock') prevent();
			}
		});
		const { edytor, editor } = await render([p('a', '')], [mentions, veto]);
		await caretAt(edytor, 'a', 0);
		await type(editor, '@ad');
		await dispatchDomKeyDown(document, { key: 'Enter' });
		expect(contentOf(edytor, 'a')).toBe('@ad');
		expect(caretOf(edytor)).toEqual({ block: 'a', offset: 3 });
	});

	it('an IME commit of "@ad" opens the menu with its query', async () => {
		const { edytor, editor } = await render([p('a', 'x ')], [mentions]);
		await caretAt(edytor, 'a', 2);
		await dispatchComposition(editor, [
			{ type: 'compositionstart' },
			{ type: 'beforeinput', inputType: 'insertCompositionText', data: '@ad' },
			{ type: 'compositionend', data: '@ad' }
		]);
		await flushDomUpdates();
		expect(contentOf(edytor, 'a')).toBe('x @ad');
		expect(labels()).toEqual(['Ada Lovelace']);
	});

	it('the atom copies as @name', async () => {
		const { edytor } = await render([
			{
				id: 'a',
				type: 'paragraph',
				content: [{ text: 'hi ' }, { type: 'mention', data: { id: 'u1', label: 'Ada' } }]
			}
		]);
		expect(edytor.inlineBlocks.has('mention')).toBe(false);
		const { edytor: withPlugin } = await render(
			[
				{
					id: 'b',
					type: 'paragraph',
					content: [{ text: 'hi ' }, { type: 'mention', data: { id: 'u1', label: 'Ada' } }]
				}
			],
			[mentions]
		);
		expect(withPlugin.inlineBlocks.get('mention')?.plain?.({ id: 'u1', label: 'Ada' })).toBe(
			'@Ada'
		);
		expect(document.querySelector('[data-edytor-mention]')?.textContent).toBe('@Ada');
	});

	it('a readonly view opens no menu', async () => {
		const { edytor, editor } = await render([p('a', '')], [mentions], { readonly: true });
		await caretAt(edytor, 'a', 0);
		await type(editor, '@');
		expect(document.querySelector('[data-testid="trigger-menu"]')).toBeNull();
	});
});

const PAGES: PageLinkItem[] = [
	{ id: 'p1', title: 'Roadmap', icon: '🗺️' },
	{ id: 'p2', title: 'Meeting notes', href: 'https://example.com/notes' },
	{ id: 'p3', title: 'Bad', href: 'javascript:alert(1)' }
];

describe('the [[ page link menu', () => {
	const pages = createPageLinkPlugin({
		search: async (query) =>
			PAGES.filter((page) => page.title.toLowerCase().includes(query.toLowerCase())),
		href: (page) => `/pages/${page.id}`
	});

	it('[[ opens the menu; a pick inserts a link to the page', async () => {
		const { edytor, editor } = await render([p('a', 'see ')], [pages]);
		await caretAt(edytor, 'a', 4);
		await type(editor, '[[road');
		await flushDomUpdates();
		expect(rows().map((row) => row.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
			'🗺️ Roadmap'
		]);
		await dispatchDomKeyDown(document, { key: 'Enter' });
		expect(contentOf(edytor, 'a')).toBe('see [pageLink:Roadmap]');
		expect(caretOf(edytor)).toEqual({ block: 'a', offset: 5 });
		const link = document.querySelector<HTMLAnchorElement>('[data-edytor-page-link]');
		expect(link?.getAttribute('href')).toBe('/pages/p1');
		expect(link?.textContent).toBe('🗺️Roadmap');
	});

	it('a page href is sanitized: a script URL is dropped', async () => {
		const { edytor, editor } = await render([p('a', '')], [pages]);
		await caretAt(edytor, 'a', 0);
		await type(editor, '[[bad');
		await flushDomUpdates();
		await dispatchDomKeyDown(document, { key: 'Enter' });
		const data = edytor.idToBlock.get('a')!.value.content?.find((part) => 'type' in part);
		expect(data && 'data' in data ? data.data : null).toEqual({ id: 'p3', title: 'Bad' });
		expect(document.querySelector('[data-edytor-page-link]')?.hasAttribute('href')).toBe(false);
	});

	it('a single [ opens nothing', async () => {
		const { edytor, editor } = await render([p('a', '')], [pages]);
		await caretAt(edytor, 'a', 0);
		await type(editor, '[r');
		await flushDomUpdates();
		expect(document.querySelector('[data-testid="trigger-menu"]')).toBeNull();
	});
});
