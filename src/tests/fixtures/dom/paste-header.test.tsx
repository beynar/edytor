/** @jsxImportSource ../../jsx */
/**
 * HX-10 (re-score 14): a paste at the end of a container's header whose
 * body shows (a callout with nested lines, an open toggle) leads the body,
 * which stays under the header, as Enter opens a first child there
 * (`flow.header`). A closed toggle's hidden body stays under it too, and
 * the paste goes after it, as Enter adds a sibling.
 *
 * HX-09: clipboard.mdx's placement wording, probed: HTML list items join as
 * lines; after a pasted image, as after a divider, the caret takes the next
 * line, and an empty line it lands in is kept.
 *
 * Expected states are hand-authored from Notion and the contract rows.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { JSONBlock } from '$lib/utils/json.js';
import { codePlugin } from '$lib/plugins/code/CodePlugin.svelte';
import { mentionPlugin } from '../../atMention.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { imagePlugin } from '$lib/plugins/image/ImagePlugin.svelte';
import { EDYTOR_FRAGMENT_MIME } from '$lib/clipboard/types.js';
import { encodeClipboardJson } from '$lib/clipboard/serializeClipboardFragment.js';
import {
	dispatchClipboardPaste,
	dispatchDomKeyDown,
	flushDomUpdates,
	renderDomEdytor,
	setNativeSelection
} from '../../dom/test.utils.js';
import { expectNoHiddenContent } from './invariants.js';
import { hidden } from '$lib/selection/visibility.js';

afterEach(() => {
	document.body.innerHTML = '';
});

type Outline = string | [string, Outline[]];
const outline = (block: JSONBlock): Outline => {
	const text = (block.content ?? []).map((p) => ('text' in p ? p.text : '@')).join('');
	const self = text ? `${block.type} "${text}"` : block.type;
	return block.children?.length ? [self, block.children.map(outline)] : self;
};
const doc = (edytor: Edytor) => (edytor.value.children ?? []).map(outline);
const caret = (edytor: Edytor) => {
	const { startText, yStart, isCollapsed } = edytor.selection.state;
	const text = (startText?.parent.value.content ?? []).map((p) => ('text' in p ? p.text : '@'));
	return `${text.join('')}@${yStart}${isCollapsed ? '' : ' (range)'}`;
};

const render = async (type: 'callout' | 'toggle', open = true) => {
	const rendered = await renderDomEdytor(
		<root>
			<paragraph>|</paragraph>
		</root>,
		{
			plugins: [richTextPlugin, mentionPlugin, codePlugin],
			value: {
				children: [
					{
						id: 'host',
						type,
						content: [{ text: 'hello world' }],
						children: [{ id: 'body', type: 'paragraph', content: [{ text: 'body' }] }]
					},
					{ id: 'after', type: 'paragraph', content: [{ text: 'after' }] }
				]
			}
		}
	);
	const node = rendered.edytor.idToBlock.get('host')!.node as HTMLDetailsElement;
	if (type === 'toggle') node.open = open;
	await flushDomUpdates();
	return rendered;
};

const internal = (blocks: JSONBlock[]) => ({
	[EDYTOR_FRAGMENT_MIME]: encodeClipboardJson({
		version: 1,
		source: 'edytor',
		kind: 'blocks',
		blocks
	})
});
const x: JSONBlock = { type: 'paragraph', content: [{ text: 'x' }] };
const code: JSONBlock = {
	type: 'code',
	children: [{ type: 'codeLine', content: [{ text: 'let a' }] }]
};

const paste = async (
	type: 'callout' | 'toggle',
	offset: number,
	data: Record<string, string>,
	open = true
) => {
	const { edytor, editor } = await render(type, open);
	await setNativeSelection(edytor, edytor.idToBlock.get('host')!.firstText, offset);
	await dispatchClipboardPaste(editor, data);
	await flushDomUpdates();
	return edytor;
};

for (const type of ['callout', 'toggle'] as const)
	describe(`HX-10: a paste at the end of ${type === 'callout' ? 'a callout' : 'an open toggle'}'s header leads its body`, () => {
		const host = `${type} "hello world"`;
		const rows: [string, Record<string, string>, Outline[], string][] = [
			['a divider (html)', { 'text/html': '<hr>' }, ['divider', 'paragraph'], '@0'],
			['a divider (fragment)', internal([{ type: 'divider' }]), ['divider', 'paragraph'], '@0'],
			['a code block', internal([code]), [['code', ['codeLine "let a"']]], 'let a@5'],
			['x + a divider', { 'text/html': '<p>x</p><hr>' }, ['divider', 'paragraph'], '@0'],
			['a divider + x', { 'text/html': '<hr><p>x</p>' }, ['divider', 'paragraph "x"'], 'x@1'],
			[
				'two lines',
				internal([x, { type: 'paragraph', content: [{ text: 'y' }] }]),
				['paragraph "y"'],
				'y@1'
			]
		];
		for (const [name, data, lead, at] of rows)
			it(`${name}: the body stays under the header, after the pasted lines`, async () => {
				const edytor = await paste(type, 11, data);
				const joined = name.startsWith('x +') || name === 'two lines';
				expect(doc(edytor)).toEqual([
					[joined ? `${type} "hello worldx"` : host, [...lead, 'paragraph "body"']],
					'paragraph "after"'
				]);
				expectNoHiddenContent(edytor);
				expect(caret(edytor)).toBe(at);
			});

		it('matches Enter at the same spot: a first child, the body kept', async () => {
			const { edytor } = await render(type);
			await setNativeSelection(edytor, edytor.idToBlock.get('host')!.firstText, 11);
			await dispatchDomKeyDown(edytor.idToBlock.get('host')!.firstText!.node!, { key: 'Enter' });
			await flushDomUpdates();
			expect(doc(edytor)).toEqual([[host, ['paragraph', 'paragraph "body"']], 'paragraph "after"']);
		});

		it('one undo step puts the header back as it was', async () => {
			const edytor = await paste(type, 11, { 'text/html': '<hr>' });
			await dispatchDomKeyDown(document, { key: 'z', ctrlKey: true, metaKey: true });
			await flushDomUpdates();
			expect(doc(edytor)).toEqual([[host, ['paragraph "body"']], 'paragraph "after"']);
		});
	});

describe('HX-10: an open toggle without nested lines', () => {
	const toggle = async (text: string, data: Record<string, string>) => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>|</paragraph>
			</root>,
			{
				plugins: [richTextPlugin, mentionPlugin, codePlugin],
				value: {
					children: [{ id: 'host', type: 'toggle', content: text ? [{ text }] : [] }]
				}
			}
		);
		(edytor.idToBlock.get('host')!.node as HTMLDetailsElement).open = true;
		await flushDomUpdates();
		await setNativeSelection(edytor, edytor.idToBlock.get('host')!.firstText, text.length);
		await dispatchClipboardPaste(editor, data);
		await flushDomUpdates();
		return edytor;
	};

	it('with text: a code block pasted at its end is its first nested line', async () => {
		const edytor = await toggle('hello', internal([code]));
		expect(doc(edytor)).toEqual([['toggle "hello"', [['code', ['codeLine "let a"']]]]]);
		expect(caret(edytor)).toBe('let a@5');
	});

	// SW18: pasting into an empty toggle header keeps the toggle (Notion), as
	// clipboard.mdx says; what follows the first line is its first nested line.
	it('empty: one heading gives it the text only; it stays a toggle', async () => {
		const edytor = await toggle('', { 'text/html': '<h2>H</h2>' });
		expect(doc(edytor)).toEqual(['toggle "H"']);
		expect(caret(edytor)).toBe('H@1');
	});

	it('empty: a heading then x: it stays a toggle, x is its first nested line', async () => {
		const edytor = await toggle('', { 'text/html': '<h2>H</h2><p>x</p>' });
		expect(doc(edytor)).toEqual([['toggle "H"', ['paragraph "x"']]]);
		expectNoHiddenContent(edytor);
		expect(caret(edytor)).toBe('x@1');
	});

	it('empty: plain text lines: the second is its first nested line, not a toggle', async () => {
		const edytor = await toggle('', { 'text/plain': 'a\nb' });
		expect(doc(edytor)).toEqual([['toggle "a"', ['paragraph "b"']]]);
		expect(caret(edytor)).toBe('b@1');
	});

	it('empty: a code block replaces it, as it replaces any empty block', async () => {
		const edytor = await toggle('', internal([code]));
		expect(doc(edytor)).toEqual([['code', ['codeLine "let a"']]]);
		expect(caret(edytor)).toBe('let a@5');
	});
});

// SW18: a closed toggle (a new toggle is closed) keeps its kind too when a
// paste fills its empty header; its hidden body is not shown under a heading.
describe("SW18: a paste into a closed toggle's empty header keeps the toggle", () => {
	const closed = async (
		body: boolean,
		data: Record<string, string>,
		{ type = 'toggle', text = '' } = {}
	) => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>|</paragraph>
			</root>,
			{
				plugins: [richTextPlugin, mentionPlugin, codePlugin],
				value: {
					children: [
						{
							id: 'host',
							type,
							content: text ? [{ text }] : [],
							...(body
								? { children: [{ id: 'body', type: 'paragraph', content: [{ text: 'body' }] }] }
								: {})
						},
						{ id: 'after', type: 'paragraph', content: [{ text: 'after' }] }
					]
				}
			}
		);
		const host = edytor.idToBlock.get('host')!;
		(host.node as HTMLDetailsElement).open = false;
		await flushDomUpdates();
		await setNativeSelection(edytor, host.firstText, text.length);
		await dispatchClipboardPaste(editor, data);
		await flushDomUpdates();
		return edytor;
	};
	/** The pasted blocks the view hides (only the host's own body may be). */
	const hiddenPasted = (edytor: Edytor) => {
		const all = (blocks: JSONBlock[] = []): JSONBlock[] =>
			blocks.flatMap((b) => [b, ...all(b.children)]);
		return all(edytor.value.children)
			.filter((b) => b.id !== 'body' && hidden(edytor.idToBlock.get(b.id!)!))
			.map((b) => b.type);
	};

	it('with a hidden body, one heading: the toggle takes the text; the body stays hidden', async () => {
		const edytor = await closed(true, { 'text/html': '<h2>H</h2>' });
		expect(doc(edytor)).toEqual([['toggle "H"', ['paragraph "body"']], 'paragraph "after"']);
		expect(caret(edytor)).toBe('H@1');
	});

	it('with a hidden body, a heading then x: x goes after it, as Enter adds a toggle', async () => {
		const edytor = await closed(true, { 'text/html': '<h2>H</h2><p>x</p>' });
		expect(doc(edytor)).toEqual([
			['toggle "H"', ['paragraph "body"']],
			'toggle "x"',
			'paragraph "after"'
		]);
		expectNoHiddenContent(edytor);
		expect(caret(edytor)).toBe('x@1');
	});

	it('without a body, one heading: it stays a toggle', async () => {
		const edytor = await closed(false, { 'text/html': '<h2>H</h2>' });
		expect(doc(edytor)).toEqual(['toggle "H"', 'paragraph "after"']);
		expect(caret(edytor)).toBe('H@1');
	});

	// DR-crdt-1: a closed toggle shows no children, so a pasted line's nested lines
	// never land in its hidden body: they go after it, shown, the caret ending them.
	const nestedHtml = { 'text/html': '<ul><li>a<ul><li>b</li></ul></li></ul>' };
	const nested: JSONBlock = {
		type: 'bulleted-list-item',
		content: [{ text: 'a' }],
		children: [{ type: 'bulleted-list-item', content: [{ text: 'b' }] }]
	};
	const nestedFragment = internal([nested]);
	for (const [name, data] of [
		['html', nestedHtml],
		['fragment', nestedFragment]
	] as const)
		it(`DR-crdt-1: without a body, a nested list (${name}): its nested line goes after it`, async () => {
			const edytor = await closed(false, data);
			expect(doc(edytor)).toEqual(['toggle "a"', 'bulleted-list-item "b"', 'paragraph "after"']);
			expect(hiddenPasted(edytor)).toEqual([]);
			expect(caret(edytor)).toBe('b@1');
		});

	it('DR-crdt-1: with a hidden body, a nested list: the body stays hidden, b goes after', async () => {
		const edytor = await closed(true, nestedFragment);
		expect(doc(edytor)).toEqual([
			['toggle "a"', ['paragraph "body"']],
			'bulleted-list-item "b"',
			'paragraph "after"'
		]);
		expect(hiddenPasted(edytor)).toEqual([]);
		expect(caret(edytor)).toBe('b@1');
	});

	it('DR-crdt-1: at the end of a closed header with text, a nested list', async () => {
		const edytor = await closed(true, nestedHtml, { text: 'abc' });
		expect(doc(edytor)).toEqual([
			['toggle "abca"', ['paragraph "body"']],
			'bulleted-list-item "b"',
			'paragraph "after"'
		]);
		expect(hiddenPasted(edytor)).toEqual([]);
		expect(caret(edytor)).toBe('b@1');
	});

	it('DR-crdt-1: a code block then a nested list: the toggle takes a, b goes after it', async () => {
		const edytor = await closed(true, internal([code, nested]));
		expect(doc(edytor)).toEqual([
			['code', ['codeLine "let a"']],
			['toggle "a"', ['paragraph "body"']],
			'bulleted-list-item "b"',
			'paragraph "after"'
		]);
		expect(hiddenPasted(edytor)).toEqual([]);
		expect(caret(edytor)).toBe('b@1');
	});

	// DR-crdt-2: any closed `<details>` hides its body, the legacy `details` kind too.
	it('DR-crdt-2: a closed `details` block keeps its kind; its body stays hidden', async () => {
		const edytor = await closed(true, { 'text/html': '<h2>H</h2>' }, { type: 'details' });
		expect(doc(edytor)).toEqual([['details "H"', ['paragraph "body"']], 'paragraph "after"']);
		expect(hiddenPasted(edytor)).toEqual([]);
		expect(caret(edytor)).toBe('H@1');
	});
});

describe('HX-10: a closed toggle keeps its hidden body; the paste goes after it', () => {
	it('a divider at the end of a closed toggle header', async () => {
		const edytor = await paste('toggle', 11, { 'text/html': '<hr>' }, false);
		expect(doc(edytor)).toEqual([
			['toggle "hello world"', ['paragraph "body"']],
			'divider',
			'paragraph',
			'paragraph "after"'
		]);
		expectNoHiddenContent(edytor);
		expect(caret(edytor)).toBe('@0');
	});
});

describe('HX-09: the clipboard page, probed', () => {
	const paragraph = async (host: string, offset: number, data: Record<string, string>) => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>|</paragraph>
			</root>,
			{
				plugins: [richTextPlugin, mentionPlugin, codePlugin, imagePlugin],
				value: {
					children: [
						{ id: 'before', type: 'paragraph', content: [{ text: 'before' }] },
						{ id: 'host', type: 'paragraph', content: host ? [{ text: host }] : [] }
					]
				}
			}
		);
		await setNativeSelection(edytor, edytor.idToBlock.get('host')!.firstText, offset);
		await dispatchClipboardPaste(editor, data);
		await flushDomUpdates();
		return edytor;
	};
	const list = { 'text/html': '<ul><li>one</li><li>two</li></ul>' };
	const image = internal([
		{ type: 'image', data: { src: 'https://example.com/a.png' }, content: [{ text: 'cap' }] }
	]);

	it('HTML list items at hello| world join as lines', async () => {
		const edytor = await paragraph('hello world', 5, list);
		expect(doc(edytor)).toEqual([
			'paragraph "before"',
			'paragraph "helloone"',
			'bulleted-list-item "two world"'
		]);
	});

	it('HTML list items at |hello world join as lines too', async () => {
		const edytor = await paragraph('hello world', 0, list);
		expect(doc(edytor)).toEqual([
			'paragraph "before"',
			'paragraph "one"',
			'bulleted-list-item "twohello world"'
		]);
	});

	it('an image at the end: the caret on a fresh line after it', async () => {
		const edytor = await paragraph('hello world', 11, image);
		expect(doc(edytor)).toEqual([
			'paragraph "before"',
			'paragraph "hello world"',
			'image "cap"',
			'paragraph'
		]);
		expect(caret(edytor)).toBe('@0');
	});

	it('an image into an empty line: the line stays after it for the caret', async () => {
		const edytor = await paragraph('', 0, image);
		expect(doc(edytor)).toEqual(['paragraph "before"', 'image "cap"', 'paragraph']);
		expect(edytor.selection.state.startText?.parent.id).toBe('host');
		expect(caret(edytor)).toBe('@0');
	});
});

// DR-rest-1: an empty header whose body shows keeps its kind and data; a pasted
// first line gives it its text only, so the body stays under it, as after Enter.
for (const type of ['callout', 'toggle'] as const)
	describe(`DR-rest-1: a paste into ${type === 'callout' ? 'a callout' : 'an open toggle'}'s empty header keeps it`, () => {
		const empty = async (data: Record<string, string>) => {
			const { edytor, editor } = await renderDomEdytor(
				<root>
					<paragraph>|</paragraph>
				</root>,
				{
					plugins: [richTextPlugin, mentionPlugin, codePlugin],
					value: {
						children: [
							{
								id: 'host',
								type,
								data: { icon: 'i' },
								content: [],
								children: [{ id: 'body', type: 'paragraph', content: [{ text: 'body' }] }]
							},
							{ id: 'after', type: 'paragraph', content: [{ text: 'after' }] }
						]
					}
				}
			);
			const host = edytor.idToBlock.get('host')!;
			if (type === 'toggle') (host.node as HTMLDetailsElement).open = true;
			await flushDomUpdates();
			await setNativeSelection(edytor, host.firstText, 0);
			await dispatchClipboardPaste(editor, data);
			await flushDomUpdates();
			return edytor;
		};
		const heading: JSONBlock = { type: 'heading', data: { level: 'h2' }, content: [{ text: 'H' }] };
		const rows: [string, Record<string, string>, Outline[], string][] = [
			[
				'a heading + a divider (html)',
				{ 'text/html': '<h2>H</h2><hr>' },
				['divider', 'paragraph'],
				'@0'
			],
			[
				'a heading + a divider (fragment)',
				internal([heading, { type: 'divider' }]),
				['divider', 'paragraph'],
				'@0'
			],
			['a heading + x (html)', { 'text/html': '<h2>H</h2><p>x</p>' }, ['paragraph "x"'], 'x@1'],
			['one heading (html)', { 'text/html': '<h2>H</h2>' }, [], 'H@1'],
			['one heading (fragment)', internal([heading]), [], 'H@1']
		];
		for (const [name, data, lead, at] of rows)
			it(`${name}: the header takes the text, keeps its kind, the body stays`, async () => {
				const edytor = await empty(data);
				expect(doc(edytor)).toEqual([
					[`${type} "H"`, [...lead, 'paragraph "body"']],
					'paragraph "after"'
				]);
				expect(edytor.value.children![0]!.data).toMatchObject({ icon: 'i' });
				expectNoHiddenContent(edytor);
				expect(caret(edytor)).toBe(at);
			});
	});
