/** @jsxImportSource ../../jsx */
/**
 * Wave 7 sweep: what a text range from a collapsed toggle's header reaches.
 * The hidden body is not selected (`del.range.hidden-body`, XW-01): marks,
 * copy and cut leave it as they find it. Expected states are hand-authored
 * from Notion's behavior.
 */
import { describe, expect, it } from 'vitest';
import { readEdytorClipboardFragment } from '$lib/clipboard/clipboard.js';
import { mentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { selectedTextSpans } from '$lib/selection/visibility.js';
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

/** `[toggle 'title' -> [p 'body'] (closed), p 'after']`. */
const collapsed = (body: { text: string; marks?: Record<string, true> }[] = [{ text: 'body' }]) =>
	renderDomEdytor(empty, {
		plugins: [richTextPlugin, mentionPlugin],
		value: {
			children: [
				{
					id: 'toggle',
					type: 'toggle',
					content: [{ text: 'title' }],
					children: [{ id: 'body', type: 'paragraph', content: body }]
				},
				{ id: 'after', type: 'paragraph', content: [{ text: 'after' }] }
			]
		}
	});
type Rendered = Awaited<ReturnType<typeof collapsed>>;

/** Select `toggle:2` to `after:3` ('tle' … 'aft'). */
const selectAcross = async ({ edytor }: Rendered) => {
	const text = (id: string) => edytor.idToBlock.get(id)!.firstText!;
	edytor.selection.setAtRange(text('toggle'), 2, text('after'), 3);
	await flushDomUpdates();
};

const clipboardEvent = (type: 'copy' | 'cut') => {
	const event = new Event(type, { bubbles: true, cancelable: true }) as ClipboardEvent;
	const data = new Map<string, string>();
	Object.defineProperty(event, 'clipboardData', {
		value: {
			getData: (format: string) => data.get(format) ?? '',
			setData: (format: string, value: string) => data.set(format, value)
		}
	});
	return event;
};

const bold = { bold: true } as const;

describe('marks over a range from a collapsed toggle header (SW7-delete)', () => {
	it('Mod+B marks the shown text only; the hidden body is untouched', async () => {
		const r = await collapsed();
		await selectAcross(r);
		await dispatchDomKeyDown(document, { key: 'b', ctrlKey: true });
		expect(canonicalTree(r.edytor)).toEqual([
			{
				type: 'toggle',
				content: [{ text: 'ti' }, { text: 'tle', marks: bold }],
				children: [{ type: 'paragraph', content: [{ text: 'body' }] }]
			},
			{ type: 'paragraph', content: [{ text: 'aft', marks: bold }, { text: 'er' }] }
		]);
	});

	it('Mod+B over shown text already bold removes it, whatever the hidden body holds', async () => {
		const r = await collapsed();
		const text = (id: string) => r.edytor.idToBlock.get(id)!.firstText!;
		await selectAcross(r);
		await dispatchDomKeyDown(document, { key: 'b', ctrlKey: true });
		r.edytor.selection.setAtRange(text('toggle'), 0, text('toggle'), 0);
		await flushDomUpdates();
		await selectAcross(r);
		await dispatchDomKeyDown(document, { key: 'b', ctrlKey: true });
		expect(canonicalTree(r.edytor)).toEqual([
			{
				type: 'toggle',
				content: [{ text: 'title' }],
				children: [{ type: 'paragraph', content: [{ text: 'body' }] }]
			},
			{ type: 'paragraph', content: [{ text: 'after' }] }
		]);
	});
});

describe('mixed marks over a range across blocks (SW7-delete)', () => {
	it('Mod+B over bold then plain text bolds all of it (Notion), not a per-block toggle', async () => {
		const { edytor } = await renderDomEdytor(empty, {
			plugins: [richTextPlugin, mentionPlugin],
			value: {
				children: [
					{ id: 'a', type: 'paragraph', content: [{ text: 'bold', marks: bold }] },
					{ id: 'b', type: 'paragraph', content: [{ text: 'plain' }] }
				]
			}
		});
		const text = (id: string) => edytor.idToBlock.get(id)!.firstText!;
		edytor.selection.setAtRange(text('a'), 0, text('b'), 5);
		await flushDomUpdates();
		await dispatchDomKeyDown(document, { key: 'b', ctrlKey: true });
		expect(canonicalTree(edytor)).toEqual([
			{ type: 'paragraph', content: [{ text: 'bold', marks: bold }] },
			{ type: 'paragraph', content: [{ text: 'plain', marks: bold }] }
		]);
	});
});

describe('copy and cut from a collapsed toggle header (SW7-delete)', () => {
	it.each(['copy', 'cut'] as const)(
		'%s writes what the range shows: the hidden body is not in the fragment',
		async (type) => {
			const r = await collapsed();
			await selectAcross(r);
			const event = clipboardEvent(type);
			r.editor.dispatchEvent(event);
			await flushDomUpdates();
			const fragment = readEdytorClipboardFragment(event.clipboardData);
			expect(fragment).toMatchObject({
				kind: 'blocks',
				blocks: [
					{ type: 'toggle', content: [{ text: 'tle' }] },
					{ type: 'paragraph', content: [{ text: 'aft' }] }
				]
			});
			expect(fragment?.kind === 'blocks' && fragment.blocks[0]!.children).toBeFalsy();
		}
	);

	it('cut leaves the hidden body in the document', async () => {
		const r = await collapsed();
		await selectAcross(r);
		const event = clipboardEvent('cut');
		r.editor.dispatchEvent(event);
		await flushDomUpdates();
		expect(canonicalTree(r.edytor)).toEqual([
			{
				type: 'toggle',
				content: [{ text: 'tier' }],
				children: [{ type: 'paragraph', content: [{ text: 'body' }] }]
			}
		]);
	});
});

describe('marks over a block selection that holds a collapsed toggle (FX-07)', () => {
	it.each([[['toggle']], [['toggle', 'after']], [['a', 'toggle']]])(
		'Mod+B over %j bolds exactly the members; the hidden body stays plain',
		async (ids) => {
			const { edytor } = await renderDomEdytor(empty, {
				plugins: [richTextPlugin, mentionPlugin],
				value: {
					children: [
						{ id: 'a', type: 'paragraph', content: [{ text: 'a' }] },
						{
							id: 'toggle',
							type: 'toggle',
							content: [{ text: 'head' }],
							children: [{ id: 'body', type: 'paragraph', content: [{ text: 'h' }] }]
						},
						{ id: 'after', type: 'paragraph', content: [{ text: 'z' }] }
					]
				}
			});
			edytor.selection.selectBlocks(...ids.map((id) => edytor.idToBlock.get(id)!));
			await flushDomUpdates();
			// The toolbar's state reads the same spans: the body is not among them.
			expect(selectedTextSpans(edytor).map(({ text }) => text.parent.id)).toEqual(ids);
			await dispatchDomKeyDown(document, { key: 'b', ctrlKey: true });
			const marked = (id: string) =>
				edytor.idToBlock.get(id)!.firstText!.value.every((part) => part.marks?.bold === true);
			expect(['a', 'toggle', 'body', 'after'].filter(marked)).toEqual(ids);
		}
	);
});

describe('the word keys over every block, a closed toggle last (SW15-keys-1)', () => {
	it('Mod+A three times, then Mod+→ and typing: the text lands at the end of the toggle’s header', async () => {
		const { edytor, editor } = await renderDomEdytor(empty, {
			plugins: [richTextPlugin, mentionPlugin],
			value: {
				children: [
					{ id: 'a', type: 'paragraph', content: [{ text: 'a' }] },
					{
						id: 'toggle',
						type: 'toggle',
						content: [{ text: 'head' }],
						children: [{ id: 'body', type: 'paragraph', content: [{ text: 'h' }] }]
					}
				]
			}
		});
		edytor.selection.setAtTextOffset(edytor.idToBlock.get('a')!.firstText, 0);
		await flushDomUpdates();
		for (let i = 0; i < 3; i++) await dispatchDomKeyDown(document, { key: 'a', ctrlKey: true });
		expect(edytor.selection.selectedBlocks.size).toBe(3);
		await dispatchDomKeyDown(document, { key: 'ArrowRight', ctrlKey: true });
		await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: 'Z' });
		await flushDomUpdates();
		expect(edytor.value.children?.[1]).toMatchObject({
			content: [{ text: 'headZ' }],
			children: [{ content: [{ text: 'h' }] }]
		});
	});
});
