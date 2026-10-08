/** @jsxImportSource ../../jsx */
/**
 * GX-01 (re-score 13): a pasted line whose kind joins no text — a list, a
 * code block, a divider (it renders none of its own, or is void or an
 * island) — is placed as a block, never joined into the host line. The host
 * text after the position stays in a shown line of the host's kind (Notion),
 * the pasted kind is kept, and the caret lands after the pasted content: the
 * end of its last shown line, or the start of the host's rest when the
 * pasted content shows none (a divider). At the start of the host, or in an
 * empty host, nothing is left behind as an empty line (`flow.inline`,
 * `flow.split`, `flow.apart`).
 *
 * Every row runs on the internal fragment path and the HTML path, and
 * asserts the no-hidden-content invariant (`invariants.ts`).
 *
 * Expected states are hand-authored from the contract rows and Notion.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { JSONBlock } from '$lib/utils/json.js';
import { codePlugin } from '$lib/plugins/code/CodePlugin.svelte';
import { mentionPlugin } from '../../atMention.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { EDYTOR_FRAGMENT_MIME } from '$lib/clipboard/types.js';
import { encodeClipboardJson } from '$lib/clipboard/serializeClipboardFragment.js';
import { runBeforeInputCommand } from '$lib/events/beforeInputCommands.js';
import { attemptOf } from '$lib/session/attempt.js';
import {
	dispatchClipboardPaste,
	dispatchCopy,
	dispatchDomKeyDown,
	flushDomUpdates,
	renderDomEdytor,
	setNativeSelection
} from '../../dom/test.utils.js';
import { hidden } from '$lib/selection/visibility.js';
import { expectNoHiddenContent } from './invariants.js';

afterEach(() => {
	document.body.innerHTML = '';
});

/** A block as `type "text"` with its children, ids and data dropped. */
type Outline = string | [string, Outline[]];
const outline = (block: JSONBlock): Outline => {
	const text = (block.content ?? []).map((p) => ('text' in p ? p.text : '@')).join('');
	const self = text ? `${block.type} "${text}"` : block.type;
	return block.children?.length ? [self, block.children.map(outline)] : self;
};
const doc = (edytor: Edytor) => (edytor.value.children ?? []).map(outline);

/** The caret as `text@offset`, collapsed. */
const caret = (edytor: Edytor) => {
	const { startText, yStart, isCollapsed } = edytor.selection.state;
	const text = (startText?.parent.value.content ?? []).map((p) => ('text' in p ? p.text : '@'));
	return `${text.join('')}@${yStart}${isCollapsed ? '' : ' (range)'}`;
};

type Shell = {
	name: string;
	json: JSONBlock;
	html: string | null;
	/** Its outline once placed. */
	placed: Outline;
	/** Where the caret lands when this shell ends the paste (`null`: the host's rest). */
	end: string | null;
};
const shells: Shell[] = [
	{
		name: 'a list',
		json: {
			type: 'unordered-list',
			children: [
				{ type: 'list-item', content: [{ text: 'one' }] },
				{ type: 'list-item', content: [{ text: 'two' }] }
			]
		},
		// HTML lists import as flat items (`bulleted-list-item`), which join as lines.
		html: null,
		placed: ['unordered-list', ['list-item "one"', 'list-item "two"']],
		end: 'two@3'
	},
	{
		name: 'a code block',
		json: { type: 'code', children: [{ type: 'codeLine', content: [{ text: 'let a' }] }] },
		html: '<pre><code>let a</code></pre>',
		placed: ['code', ['codeLine "let a"']],
		end: 'let a@5'
	},
	{
		name: 'a divider',
		json: { type: 'divider' },
		html: '<hr>',
		placed: 'divider',
		end: null
	}
];
const x: JSONBlock = { type: 'paragraph', content: [{ text: 'x' }] };

const render = (host: string) =>
	renderDomEdytor(
		<root>
			<paragraph>|</paragraph>
		</root>,
		{
			plugins: [richTextPlugin, mentionPlugin, codePlugin],
			value: {
				children: [
					{ id: 'before', type: 'paragraph', content: [{ text: 'before' }] },
					{ id: 'host', type: 'paragraph', content: host ? [{ text: host }] : [] }
				]
			}
		}
	);

const paths = {
	internal: (blocks: JSONBlock[]) => ({
		[EDYTOR_FRAGMENT_MIME]: encodeClipboardJson({
			version: 1,
			source: 'edytor',
			kind: 'blocks',
			blocks
		})
	}),
	html: (_: JSONBlock[], html: string) => ({ 'text/html': html })
};

const paste = async (
	host: string,
	offset: number,
	blocks: JSONBlock[],
	html: string,
	path: keyof typeof paths
) => {
	const { edytor, editor } = await render(host);
	await setNativeSelection(edytor, edytor.idToBlock.get('host')!.firstText, offset);
	await dispatchClipboardPaste(editor, paths[path](blocks, html));
	await flushDomUpdates();
	return edytor;
};

for (const path of ['internal', 'html'] as const)
	for (const s of shells.filter((s) => path === 'internal' || s.html !== null))
		describe(`GX-01 (${path}): ${s.name} pasted`, () => {
			const rest = s.end ?? ' world@0';
			const html = s.html ?? '';
			it('as the only line, mid-line: placed between the host halves', async () => {
				const edytor = await paste('hello world', 5, [s.json], html, path);
				expect(doc(edytor)).toEqual([
					'paragraph "before"',
					'paragraph "hello"',
					s.placed,
					'paragraph " world"'
				]);
				expectNoHiddenContent(edytor);
				expect(caret(edytor)).toBe(rest);
			});

			it('as the only line, at the end: placed after, a fresh line only for the caret', async () => {
				const edytor = await paste('hello world', 11, [s.json], html, path);
				expect(doc(edytor)).toEqual([
					'paragraph "before"',
					'paragraph "hello world"',
					s.placed,
					...(s.end ? [] : ['paragraph'])
				]);
				expectNoHiddenContent(edytor);
				expect(caret(edytor)).toBe(s.end ?? '@0');
			});

			it('as the only line, at the start: placed before, the host untouched', async () => {
				const edytor = await paste('hello world', 0, [s.json], html, path);
				expect(doc(edytor)).toEqual(['paragraph "before"', s.placed, 'paragraph "hello world"']);
				expectNoHiddenContent(edytor);
				expect(caret(edytor)).toBe(s.end ?? 'hello world@0');
			});

			it('as the only line, into an empty line: replaces it (kept only for the caret)', async () => {
				const edytor = await paste('', 0, [s.json], html, path);
				expect(doc(edytor)).toEqual([
					'paragraph "before"',
					s.placed,
					...(s.end ? [] : ['paragraph'])
				]);
				expectNoHiddenContent(edytor);
				expect(caret(edytor)).toBe(s.end ?? '@0');
			});

			it('as the last line, mid-line: the host rest stays in a shown line', async () => {
				const edytor = await paste('hello world', 5, [x, s.json], `<p>x</p>${html}`, path);
				expect(doc(edytor)).toEqual([
					'paragraph "before"',
					'paragraph "hellox"',
					s.placed,
					'paragraph " world"'
				]);
				expectNoHiddenContent(edytor);
				expect(caret(edytor)).toBe(rest);
			});

			it('as the last line, at the end', async () => {
				const edytor = await paste('hello world', 11, [x, s.json], `<p>x</p>${html}`, path);
				expect(doc(edytor)).toEqual([
					'paragraph "before"',
					'paragraph "hello worldx"',
					s.placed,
					...(s.end ? [] : ['paragraph'])
				]);
				expectNoHiddenContent(edytor);
				expect(caret(edytor)).toBe(s.end ?? '@0');
			});

			it('as the first line, mid-line: the last line joins the host rest', async () => {
				const edytor = await paste('hello world', 5, [s.json, x], `${html}<p>x</p>`, path);
				expect(doc(edytor)).toEqual([
					'paragraph "before"',
					'paragraph "hello"',
					s.placed,
					'paragraph "x world"'
				]);
				expectNoHiddenContent(edytor);
				expect(caret(edytor)).toBe('x world@1');
			});

			it('as the first line, at the end', async () => {
				const edytor = await paste('hello world', 11, [s.json, x], `${html}<p>x</p>`, path);
				expect(doc(edytor)).toEqual([
					'paragraph "before"',
					'paragraph "hello world"',
					s.placed,
					'paragraph "x"'
				]);
				expectNoHiddenContent(edytor);
				expect(caret(edytor)).toBe('x@1');
			});

			it('as the first line, at the start: the host keeps its line after', async () => {
				const edytor = await paste('hello world', 0, [s.json, x], `${html}<p>x</p>`, path);
				expect(doc(edytor)).toEqual(['paragraph "before"', s.placed, 'paragraph "xhello world"']);
				expectNoHiddenContent(edytor);
				expect(caret(edytor)).toBe('xhello world@1');
			});
		});

const drop = (edytor: Edytor, data: Record<string, string>) =>
	runBeforeInputCommand(
		edytor,
		attemptOf(edytor, {
			inputType: 'insertFromDrop',
			data: null,
			dataTransfer: {
				types: Object.keys(data),
				files: [],
				getData: (type: string) => data[type] ?? ''
			} as unknown as DataTransfer,
			cancelable: true
		})
	);

describe('GX-01: the reported shapes on the real copy, drop and range paths', () => {
	it('a copy of hello…two pasted at keep| keeps " this tail" shown (the review repro)', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>|</paragraph>
			</root>,
			{
				plugins: [richTextPlugin, mentionPlugin, codePlugin],
				value: {
					children: [
						{ id: 'hello', type: 'paragraph', content: [{ text: 'hello' }] },
						{
							id: 'ul',
							type: 'unordered-list',
							children: [
								{ id: 'one', type: 'list-item', content: [{ text: 'one' }] },
								{ id: 'two', type: 'list-item', content: [{ text: 'two' }] }
							]
						},
						{ id: 'keep', type: 'paragraph', content: [{ text: 'keep this tail' }] }
					]
				}
			}
		);
		const text = (id: string) => edytor.idToBlock.get(id)!.firstText;
		await setNativeSelection(edytor, text('hello'), 0, text('two'), 3);
		const copied = await dispatchCopy(editor);
		await setNativeSelection(edytor, text('keep'), 4);
		await dispatchClipboardPaste(editor, copied.clipboardData);
		await flushDomUpdates();
		const list: Outline = ['unordered-list', ['list-item "one"', 'list-item "two"']];
		expect(doc(edytor)).toEqual([
			'paragraph "hello"',
			list,
			'paragraph "keephello"',
			list,
			'paragraph " this tail"'
		]);
		expectNoHiddenContent(edytor);
		expect(caret(edytor)).toBe('two@3');
		const pasted = edytor.value.children![3]!.children!.at(-1)!.id;
		expect(edytor.selection.state.startText?.parent.id).toBe(pasted);
	});

	it('a drop of x + a divider at hello| world', async () => {
		const { edytor } = await render('hello world');
		await setNativeSelection(edytor, edytor.idToBlock.get('host')!.firstText, 5);
		await drop(edytor, { 'text/html': '<p>x</p><hr>' });
		await flushDomUpdates();
		expect(doc(edytor)).toEqual([
			'paragraph "before"',
			'paragraph "hellox"',
			'divider',
			'paragraph " world"'
		]);
		expectNoHiddenContent(edytor);
	});

	it('x + a code block pasted over "lo wo" keeps "rld" shown', async () => {
		const { edytor, editor } = await render('hello world');
		const host = edytor.idToBlock.get('host')!.firstText;
		await setNativeSelection(edytor, host, 3, host, 8);
		await dispatchClipboardPaste(editor, { 'text/html': '<p>x</p><pre><code>let a</code></pre>' });
		await flushDomUpdates();
		expect(doc(edytor)).toEqual([
			'paragraph "before"',
			'paragraph "helx"',
			['code', ['codeLine "let a"']],
			'paragraph "rld"'
		]);
		expectNoHiddenContent(edytor);
		expect(caret(edytor)).toBe('let a@5');
	});
});

describe('GX-01: one undo step', () => {
	it('undo puts the host line back whole', async () => {
		const edytor = await paste('hello world', 5, [x, { type: 'divider' }], '', 'internal');
		expect(doc(edytor)).toEqual([
			'paragraph "before"',
			'paragraph "hellox"',
			'divider',
			'paragraph " world"'
		]);
		await dispatchDomKeyDown(document, { key: 'z', ctrlKey: true, metaKey: true });
		await flushDomUpdates();
		expect(doc(edytor)).toEqual(['paragraph "before"', 'paragraph "hello world"']);
	});
});

describe('SW16-paste-1: a paste into a code line lands as plain code lines', () => {
	const inCode = () =>
		renderDomEdytor(
			<root>
				<paragraph>|</paragraph>
			</root>,
			{
				plugins: [richTextPlugin, mentionPlugin, codePlugin],
				value: {
					children: [
						{
							id: 'c',
							type: 'code',
							children: [{ id: 'host', type: 'codeLine', content: [{ text: 'hello world' }] }]
						}
					]
				}
			}
		);
	const list = shells[0]!.json;
	const rows: [string, Record<string, string>, Outline[], string][] = [
		[
			'x + a list',
			paths.internal([x, list]),
			['codeLine "hellox"', 'codeLine "one"', 'codeLine "two world"'],
			'two world@3'
		],
		[
			'a block-selection copy of a list',
			{
				[EDYTOR_FRAGMENT_MIME]: encodeClipboardJson({
					version: 1,
					source: 'edytor',
					kind: 'blocks',
					blocks: [list],
					whole: true
				})
			},
			['codeLine "helloone"', 'codeLine "two world"'],
			'two world@3'
		],
		[
			'x + a code block',
			paths.internal([x, shells[1]!.json]),
			['codeLine "hellox"', 'codeLine "let a world"'],
			'let a world@5'
		],
		['x + a divider', paths.html([], '<p>x</p><hr>'), ['codeLine "hellox world"'], 'hellox world@6']
	];
	for (const [name, data, lines, at] of rows)
		it(`${name}: its lines, nested ones included, no block inside the code block`, async () => {
			const { edytor, editor } = await inCode();
			await setNativeSelection(edytor, edytor.idToBlock.get('host')!.firstText, 5);
			await dispatchClipboardPaste(editor, data);
			await flushDomUpdates();
			expect(doc(edytor)).toEqual([['code', lines]]);
			expectNoHiddenContent(edytor);
			expect(caret(edytor)).toBe(at);
		});
});

describe('SW16-paste-2: a paste into an emptied document ends the caret after it', () => {
	for (const [name, blocks, end] of [
		['a list', [shells[0]!.json], 'two@3'],
		['x + a code block', [x, shells[1]!.json], 'let a@5']
	] as const)
		it(`${name}: the caret ends the last pasted line`, async () => {
			const { edytor, editor } = await renderDomEdytor(
				<root>
					<paragraph>|</paragraph>
				</root>,
				{
					plugins: [richTextPlugin, mentionPlugin, codePlugin],
					value: { children: [{ id: 'a', type: 'paragraph', content: [{ text: 'a' }] }] }
				}
			);
			edytor.selection.selectBlocks(edytor.idToBlock.get('a')!);
			await flushDomUpdates();
			await dispatchDomKeyDown(document, { key: 'Backspace' });
			await flushDomUpdates();
			expect(edytor.facade.virtual()).not.toBeNull();
			await dispatchClipboardPaste(editor, paths.internal([...blocks]));
			await flushDomUpdates();
			expectNoHiddenContent(edytor);
			expect(caret(edytor)).toBe(end);
		});
});

describe('DR-behavior-1: a paste into an emptied document ends on a shown line', () => {
	const toggle: JSONBlock = {
		type: 'toggle',
		content: [{ text: 'T' }],
		children: [{ type: 'paragraph', content: [{ text: 'body' }] }]
	};
	const nested: JSONBlock = {
		type: 'paragraph',
		content: [{ text: 'P' }],
		children: [{ type: 'paragraph', content: [{ text: 'kid' }] }]
	};
	const emptied = async () => {
		const rendered = await renderDomEdytor(
			<root>
				<paragraph>|</paragraph>
			</root>,
			{
				plugins: [richTextPlugin, mentionPlugin, codePlugin],
				value: { children: [{ id: 'a', type: 'paragraph', content: [{ text: 'a' }] }] }
			}
		);
		rendered.edytor.selection.selectBlocks(rendered.edytor.idToBlock.get('a')!);
		await flushDomUpdates();
		await dispatchDomKeyDown(document, { key: 'Backspace' });
		await flushDomUpdates();
		expect(rendered.edytor.facade.virtual()).not.toBeNull();
		return rendered;
	};
	const fragment = (blocks: JSONBlock[], whole: boolean) => ({
		[EDYTOR_FRAGMENT_MIME]: encodeClipboardJson({
			version: 1,
			source: 'edytor',
			kind: 'blocks',
			blocks,
			...(whole ? { whole } : {})
		})
	});
	for (const [name, data, end] of [
		['a toggle with a body', fragment([toggle], false), 'T@1'],
		['a toggle with a body (whole)', fragment([toggle], true), 'T@1'],
		[
			'a toggle as HTML',
			{ 'text/html': '<details><summary>T</summary><p>body</p></details>' },
			'T@1'
		],
		['a paragraph with a nested child', fragment([nested], false), 'P@1'],
		['a paragraph with a nested child (whole)', fragment([nested], true), 'P@1']
	] as const)
		it(`${name}: the caret ends its own line, never a hidden or nested one`, async () => {
			const { edytor, editor } = await emptied();
			await dispatchClipboardPaste(editor, data);
			await flushDomUpdates();
			expectNoHiddenContent(edytor);
			expect(caret(edytor)).toBe(end);
			expect(hidden(edytor.selection.state.startBlock!)).toBe(false);
		});
});

describe('SW16-behavior-1: a divider pasted into an emptied document leaves a line for the caret', () => {
	for (const [name, data, placed] of [
		['a divider', paths.internal([shells[2]!.json]), ['divider', 'paragraph']],
		['a divider as HTML', { 'text/html': '<hr>' }, ['divider', 'paragraph']],
		[
			'x + a divider',
			paths.internal([x, shells[2]!.json]),
			['paragraph "x"', 'divider', 'paragraph']
		]
	] as const)
		it(`${name}: a paragraph after it holds the caret`, async () => {
			const { edytor, editor } = await renderDomEdytor(
				<root>
					<paragraph>|</paragraph>
				</root>,
				{
					plugins: [richTextPlugin, mentionPlugin, codePlugin],
					value: { children: [{ id: 'a', type: 'paragraph', content: [{ text: 'a' }] }] }
				}
			);
			edytor.selection.selectBlocks(edytor.idToBlock.get('a')!);
			await flushDomUpdates();
			await dispatchDomKeyDown(document, { key: 'Backspace' });
			await flushDomUpdates();
			expect(edytor.facade.virtual()).not.toBeNull();
			await dispatchClipboardPaste(editor, data);
			await flushDomUpdates();
			expect(doc(edytor)).toEqual(placed);
			expect(caret(edytor)).toBe('@0');
			expect(edytor.selection.state.startBlock?.index).toBe(placed.length - 1);
		});
});
