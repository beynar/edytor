/** @jsxImportSource ../../jsx */
/**
 * Layouts on the clipboard (docs/columns-plan.md §5):
 *
 * - export: `<div data-edytor-columns><div data-edytor-column
 *   data-width="…">…</div>…</div>`; plain text: the blocks in order;
 * - import: the `parse` hooks claim those two attributes back (with the
 *   width), every other `div` still flattens;
 * - the internal fragment round-trips a layout (copied whole, D3) and the
 *   blocks of a column;
 * - a layout pasted inside a column is placed as its blocks, in reading
 *   order (D2, `flow.layout`): no layout lands in a column.
 *
 * Expected states are hand-authored.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { JSONBlock } from '$lib/utils/json.js';
import { EDYTOR_FRAGMENT_MIME } from '$lib/clipboard/types.js';
import { dispatchClipboardPaste, dispatchCopy, flushDomUpdates } from '../../dom/test.utils.js';
import {
	block,
	caret,
	caretIn,
	column,
	columns,
	contractDoc,
	p,
	renderColumns
} from './columns.helpers.js';

afterEach(() => {
	document.body.innerHTML = '';
});

/** The displayed tree as `type:text` lines, children nested. */
const outline = (edytor: Edytor) => {
	const walk = (blocks: JSONBlock[] = []): unknown[] =>
		blocks.map((b) => {
			const own = `${b.type}:${(b.content ?? []).map((c) => ('text' in c ? c.text : '@')).join('')}`;
			const width = b.data?.width !== undefined ? `@${b.data.width}` : '';
			return b.children?.length ? [own + width, walk(b.children)] : own + width;
		});
	return walk(edytor.value.children);
};

const LAYOUT = [
	'columns:',
	[
		['column:@2', ['paragraph:a', 'paragraph:a2']],
		['column:', ['paragraph:b']]
	]
];
const doc = () => [
	p('P', 'p'),
	columns('C', column('K1', [p('A', 'a'), p('A2', 'a2')], 2), column('K2', [p('B', 'b')])),
	p('Z', 'z')
];

const copyBlocks = async (edytor: Edytor, editor: HTMLElement, ...ids: string[]) => {
	edytor.selection.selectBlocks(...ids.map((id) => block(edytor, id)));
	await flushDomUpdates();
	return (await dispatchCopy(editor)).clipboardData;
};

describe('export', () => {
	it('the layout as marked divs with the widths; plain text is the blocks in order', async () => {
		const { edytor, editor } = await renderColumns(doc());
		const data = await copyBlocks(edytor, editor, 'A', 'A2', 'B');
		const html = data['text/html']!.replace(/^.*?hidden><\/span>/, '');
		expect(html).toBe(
			'<div data-edytor-columns>' +
				'<div data-edytor-column data-width="2"><p>a</p><p>a2</p></div>' +
				'<div data-edytor-column data-width="1"><p>b</p></div>' +
				'</div>'
		);
		expect(data['text/plain']).toBe('a\na2\nb');
	});
});

describe('import', () => {
	it('claims the marked divs back, widths included', async () => {
		const { edytor, editor } = await renderColumns([p('P', '')]);
		await caretIn(edytor, 'P', 0);
		await dispatchClipboardPaste(editor, {
			'text/html':
				'<div data-edytor-columns><div data-edytor-column data-width="2"><p>a</p><p>a2</p></div>' +
				'<div data-edytor-column><p>b</p></div></div>'
		});
		expect(outline(edytor)).toEqual([LAYOUT]);
	});

	it('a column’s leading paragraph stays its block, never the column’s own text', async () => {
		const { edytor, editor } = await renderColumns([p('P', '')]);
		await caretIn(edytor, 'P', 0);
		await dispatchClipboardPaste(editor, {
			'text/html':
				'<div data-edytor-columns><div data-edytor-column>left</div>' +
				'<div data-edytor-column><p>right</p></div></div>'
		});
		expect(outline(edytor)).toEqual([
			[
				'columns:',
				[
					['column:', ['paragraph:left']],
					['column:', ['paragraph:right']]
				]
			]
		]);
	});

	it('any other div still flattens', async () => {
		const { edytor, editor } = await renderColumns([p('P', '')]);
		await caretIn(edytor, 'P', 0);
		await dispatchClipboardPaste(editor, {
			'text/html': '<div class="row"><div><p>x</p></div><div><p>y</p></div></div>'
		});
		expect(outline(edytor)).toEqual(['paragraph:x', 'paragraph:y']);
	});
});

describe('the internal fragment', () => {
	it('round-trips a whole layout (copied as one, D3) after a block', async () => {
		const { edytor, editor } = await renderColumns(doc());
		const data = await copyBlocks(edytor, editor, 'A', 'A2', 'B');
		expect(data[EDYTOR_FRAGMENT_MIME]).toBeTruthy();
		await caretIn(edytor, 'Z', 1);
		await dispatchClipboardPaste(editor, data);
		expect(outline(edytor)).toEqual(['paragraph:p', LAYOUT, 'paragraph:z', LAYOUT]);
		const ids = edytor.value.children!.map((b) => b.id);
		expect(ids[3]).not.toBe('C');
	});

	it('round-trips blocks copied from inside a column, as blocks', async () => {
		const { edytor, editor } = await renderColumns(doc());
		const data = await copyBlocks(edytor, editor, 'A', 'A2');
		await caretIn(edytor, 'Z', 1);
		await dispatchClipboardPaste(editor, data);
		expect(outline(edytor)).toEqual([
			'paragraph:p',
			LAYOUT,
			'paragraph:z',
			'paragraph:a',
			'paragraph:a2'
		]);
	});

	it('a layout pasted inside a column lands as its blocks, in reading order (D2)', async () => {
		const { edytor, editor } = await renderColumns(doc());
		const data = await copyBlocks(edytor, editor, 'A', 'A2', 'B');
		await caretIn(edytor, 'B', 1);
		await dispatchClipboardPaste(editor, data);
		expect(outline(edytor)).toEqual([
			'paragraph:p',
			[
				'columns:',
				[
					['column:@2', ['paragraph:a', 'paragraph:a2']],
					['column:', ['paragraph:b', 'paragraph:a', 'paragraph:a2', 'paragraph:b']]
				]
			],
			'paragraph:z'
		]);
		const { block: at } = caret(edytor);
		expect(block(edytor, at!).parent?.id).toBe('K2');
	});

	it('pasted as HTML inside a column: its lines, as pasted lines (the first joins the text)', async () => {
		const { edytor, editor } = await renderColumns(contractDoc());
		await caretIn(edytor, 'B', 1);
		await dispatchClipboardPaste(editor, {
			'text/html':
				'<div data-edytor-columns><div data-edytor-column><p>x</p></div>' +
				'<div data-edytor-column><p>y</p></div></div>'
		});
		const k2 = edytor.value.children![1]!.children![1]!;
		expect(
			k2.children!.map((b) => `${b.type}:${(b.content?.[0] as { text: string })?.text}`)
		).toEqual(['paragraph:bx', 'paragraph:y']);
	});
});
