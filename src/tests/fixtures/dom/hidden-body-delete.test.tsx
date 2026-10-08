/** @jsxImportSource ../../jsx */
/**
 * Wave 7 review follow-up (DR-delete): a text range covers a collapsed
 * toggle's hidden body exactly when deleting the range deletes the body
 * (`del.range.hidden-body`). Copy, cut, Backspace and marks agree on it, and
 * a multi-line paste or a divider that splits a collapsed header leaves the
 * body with the header, as Enter does. Expected states are hand-authored
 * from Notion's behavior.
 */
import { describe, expect, it } from 'vitest';
import { readEdytorClipboardFragment } from '$lib/clipboard/clipboard.js';
import { mentionPlugin } from '../../atMention.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { richTextOperations } from '$lib/plugins/richtext/richTextOperations.js';
import {
	canonicalTree,
	dispatchDomBeforeInput,
	dispatchDomKeyDown,
	flushDomUpdates,
	renderDomEdytor
} from '../../dom/test.utils.js';

const empty = (
	<root>
		<paragraph>|</paragraph>
	</root>
);

const toggle = {
	id: 'toggle',
	type: 'toggle',
	content: [{ text: 'title' }],
	children: [{ id: 'body', type: 'paragraph', content: [{ text: 'body' }] }]
};
const paragraph = (id: string) => ({ id, type: 'paragraph', content: [{ text: id }] });

/** `blocks` rendered, `toggle` closed over its `body`. */
const render = (...ids: ('before' | 'toggle' | 'after')[]) =>
	renderDomEdytor(empty, {
		plugins: [richTextPlugin, mentionPlugin],
		value: { children: ids.map((id) => (id === 'toggle' ? toggle : paragraph(id))) }
	});
type Rendered = Awaited<ReturnType<typeof render>>;

const text = ({ edytor }: Rendered, id: string) => edytor.idToBlock.get(id)!.firstText!;
const select = async (r: Rendered, [a, x]: [string, number], [b, y]: [string, number]) => {
	r.edytor.selection.setAtRange(text(r, a), x, text(r, b), y);
	await flushDomUpdates();
	r.edytor.undoManager.stopCapturing();
};

/** A clipboard event over `data` (shared, so a copy's data can be pasted). */
const clipboardEvent = (type: 'copy' | 'cut' | 'paste', data = new Map<string, string>()) => {
	const event = new Event(type, { bubbles: true, cancelable: true }) as ClipboardEvent;
	Object.defineProperty(event, 'clipboardData', {
		value: {
			getData: (format: string) => data.get(format) ?? '',
			setData: (format: string, value: string) => data.set(format, value),
			files: []
		}
	});
	return event;
};
const clip = async (r: Rendered, type: 'copy' | 'cut', data = new Map<string, string>()) => {
	const event = clipboardEvent(type, data);
	r.editor.dispatchEvent(event);
	await flushDomUpdates();
	return readEdytorClipboardFragment(event.clipboardData);
};

const body = { type: 'paragraph', content: [{ text: 'body' }] };
const initial = [
	{ type: 'paragraph', content: [{ text: 'before' }] },
	{ type: 'toggle', content: [{ text: 'title' }], children: [body] },
	{ type: 'paragraph', content: [{ text: 'after' }] }
];
const undo = () => dispatchDomKeyDown(document, { key: 'z', ctrlKey: true });
const bold = { bold: true } as const;

describe('copy, cut and Backspace agree on the hidden body (DR-delete-1)', () => {
	it('copy from the header start carries the body that Backspace then deletes', async () => {
		const r = await render('before', 'toggle', 'after');
		await select(r, ['toggle', 0], ['after', 3]);
		const data = new Map<string, string>();
		expect(await clip(r, 'copy', data)).toMatchObject({
			kind: 'blocks',
			blocks: [
				{ type: 'toggle', content: [{ text: 'title' }], children: [body] },
				{ type: 'paragraph', content: [{ text: 'aft' }] }
			]
		});
		await dispatchDomBeforeInput(r.editor, { inputType: 'deleteContentBackward' });
		expect(canonicalTree(r.edytor)).toEqual([
			{ type: 'paragraph', content: [{ text: 'before' }] },
			{ type: 'paragraph', content: [{ text: 'er' }] }
		]);
		// Pasting it back loses nothing: the body rides its header line.
		r.edytor.selection.setAtTextOffset(text(r, 'before'), 6);
		await flushDomUpdates();
		r.editor.dispatchEvent(clipboardEvent('paste', data));
		await flushDomUpdates();
		expect(canonicalTree(r.edytor)).toEqual([
			{ type: 'paragraph', content: [{ text: 'beforetitle' }], children: [body] },
			{ type: 'paragraph', content: [{ text: 'aft' }] },
			{ type: 'paragraph', content: [{ text: 'er' }] }
		]);
	});

	it('cut from the header start deletes what it copies, as Backspace does', async () => {
		const r = await render('before', 'toggle', 'after');
		await select(r, ['toggle', 0], ['after', 3]);
		expect(await clip(r, 'cut')).toMatchObject({
			blocks: [{ type: 'toggle', content: [{ text: 'title' }], children: [body] }, {}]
		});
		expect(canonicalTree(r.edytor)).toEqual([
			{ type: 'paragraph', content: [{ text: 'before' }] },
			{ type: 'paragraph', content: [{ text: 'er' }] }
		]);
		await undo();
		expect(canonicalTree(r.edytor)).toEqual(initial);
	});

	it('cut over a whole document opening with the toggle leaves an empty toggle, as Backspace', async () => {
		const r = await render('toggle', 'after');
		await select(r, ['toggle', 0], ['after', 5]);
		expect(await clip(r, 'cut')).toMatchObject({
			blocks: [{ type: 'toggle', content: [{ text: 'title' }], children: [body] }, {}]
		});
		expect(canonicalTree(r.edytor)).toEqual([{ type: 'toggle' }]);
	});

	it('cut from mid-header keeps the head, its body, and the fragment without it', async () => {
		const r = await render('before', 'toggle', 'after');
		await select(r, ['toggle', 2], ['after', 3]);
		const fragment = await clip(r, 'cut');
		expect(fragment?.kind === 'blocks' && fragment.blocks[0]!.children).toBeFalsy();
		expect(canonicalTree(r.edytor)).toEqual([
			{ type: 'paragraph', content: [{ text: 'before' }] },
			{ type: 'toggle', content: [{ text: 'tier' }], children: [body] }
		]);
	});
});

describe('marks cover the hidden body when the range covers its toggle (DR-delete-3)', () => {
	it('Mod+B over a range wholly containing the collapsed toggle bolds its body too', async () => {
		const r = await render('before', 'toggle', 'after');
		await select(r, ['before', 0], ['after', 5]);
		await dispatchDomKeyDown(document, { key: 'b', ctrlKey: true });
		expect(canonicalTree(r.edytor)).toEqual([
			{ type: 'paragraph', content: [{ text: 'before', marks: bold }] },
			{
				type: 'toggle',
				content: [{ text: 'title', marks: bold }],
				children: [{ type: 'paragraph', content: [{ text: 'body', marks: bold }] }]
			},
			{ type: 'paragraph', content: [{ text: 'after', marks: bold }] }
		]);
	});

	it('Mod+B from the header start takes the body with the toggle (what Backspace removes)', async () => {
		const r = await render('toggle', 'after');
		await select(r, ['toggle', 0], ['after', 3]);
		await dispatchDomKeyDown(document, { key: 'b', ctrlKey: true });
		expect(canonicalTree(r.edytor)).toEqual([
			{
				type: 'toggle',
				content: [{ text: 'title', marks: bold }],
				children: [{ type: 'paragraph', content: [{ text: 'body', marks: bold }] }]
			},
			{ type: 'paragraph', content: [{ text: 'aft', marks: bold }, { text: 'er' }] }
		]);
	});
});

describe('splitting a collapsed header keeps its hidden body with it (DR-delete-2)', () => {
	const head = (title: string) => ({
		type: 'toggle',
		content: [{ text: title }],
		children: [body]
	});

	it('pasting two lines over mid-header to mid-after', async () => {
		const r = await render('before', 'toggle', 'after');
		await select(r, ['toggle', 2], ['after', 3]);
		await dispatchDomBeforeInput(r.editor, { inputType: 'insertFromPaste', text: 'A\nB' });
		expect(canonicalTree(r.edytor)).toEqual([
			{ type: 'paragraph', content: [{ text: 'before' }] },
			head('tiA'),
			{ type: 'toggle', content: [{ text: 'Ber' }] }
		]);
		await undo();
		expect(canonicalTree(r.edytor)).toEqual(initial);
	});

	it('pasting three lines over mid-header to mid-after', async () => {
		const r = await render('before', 'toggle', 'after');
		await select(r, ['toggle', 2], ['after', 3]);
		await dispatchDomBeforeInput(r.editor, { inputType: 'insertFromPaste', text: 'A\nB\nC' });
		expect(canonicalTree(r.edytor)).toEqual([
			{ type: 'paragraph', content: [{ text: 'before' }] },
			head('tiA'),
			{ type: 'paragraph', content: [{ text: 'B' }] },
			{ type: 'toggle', content: [{ text: 'Cer' }] }
		]);
	});

	it('pasting two lines at a caret mid-header', async () => {
		const r = await render('toggle', 'after');
		await select(r, ['toggle', 2], ['toggle', 2]);
		await dispatchDomBeforeInput(r.editor, { inputType: 'insertFromPaste', text: 'A\nB' });
		expect(canonicalTree(r.edytor)).toEqual([
			head('tiA'),
			{ type: 'toggle', content: [{ text: 'Btle' }] },
			{ type: 'paragraph', content: [{ text: 'after' }] }
		]);
	});

	it('a divider inserted mid-header', async () => {
		const r = await render('toggle', 'after');
		await select(r, ['toggle', 2], ['toggle', 2]);
		richTextOperations(r.edytor).insertDividerAtSelection();
		await flushDomUpdates();
		expect(canonicalTree(r.edytor)).toEqual([
			head('ti'),
			{ type: 'divider' },
			{ type: 'paragraph', content: [{ text: 'tle' }] },
			{ type: 'paragraph', content: [{ text: 'after' }] }
		]);
	});

	it('an open toggle still hands its shown children to the last line (flow.split)', async () => {
		const r = await render('toggle', 'after');
		(r.edytor.idToBlock.get('toggle')!.node as HTMLDetailsElement).open = true;
		await select(r, ['toggle', 2], ['toggle', 2]);
		await dispatchDomBeforeInput(r.editor, { inputType: 'insertFromPaste', text: 'A\nB' });
		const tree = canonicalTree(r.edytor);
		expect(tree[0]).toEqual({ type: 'toggle', content: [{ text: 'tiA' }] });
		expect(tree[1]).toMatchObject({ content: [{ text: 'Btle' }], children: [body] });
	});
});
