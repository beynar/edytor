/** @jsxImportSource ../../jsx */
/**
 * arch-v2 — checkpoint R4 rows (dom lane): snippets receive declared view
 * objects, extensions id-only handles (plan §2.4 "Snippet view objects",
 * "Handles"; §9.3 R4; §11.1 K5).
 *
 * - A block snippet receives `{id, type, data, selected, focused, …}` read from
 *   its cell and the selection — not the block's wrapper; its `data` follows a
 *   committed change. Its `handle` is the block's id-only handle.
 * - An inline-atom snippet receives `{id, type, data, selected, …}`.
 * - The core registers the block element (R5: snippets render inner markup).
 *
 * Expected values come from the plan rows, never from running the code.
 */
import { describe, expect, it } from 'vitest';
import { createRawSnippet } from 'svelte';
import { Block } from '$lib/block/block.svelte.js';
import { InlineBlock } from '$lib/block/inlineBlock.svelte.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { mentionPlugin } from '../../atMention.svelte';
import type { Plugin } from '$lib/plugins.js';
import { flushDomUpdates, renderDomEdytor } from '../../dom/test.utils.js';

/** Red on the reference (`arch-v2/ref-r4`); green since R4a. */
const row = it;
/** Green on the reference: a regression guard. */
const pin = it;

type Seen = { block?: any; atom?: any; node?: HTMLElement };

/** A `note` kind and a `tag` atom whose snippets record what they receive. */
const recorder =
	(seen: Seen): Plugin =>
	() => ({
		blocks: {
			note: {
				rendersContent: false,
				snippet: createRawSnippet((payload: () => { block: any }) => ({
					render: () => '<div data-note></div>',
					setup: (node: Element) => {
						seen.block = payload().block;
						seen.node = node as HTMLElement;
					}
				})) as never
			}
		},
		inlineBlocks: {
			tag: createRawSnippet((payload: () => { block: any }) => ({
				render: () => '<b>#</b>',
				setup: () => {
					seen.atom = payload().block;
				}
			})) as never
		}
	});

const mount = async (seen: Seen) =>
	renderDomEdytor(
		<root>
			<paragraph>ab</paragraph>
		</root>,
		{
			plugins: [richTextPlugin, mentionPlugin, recorder(seen)],
			value: {
				children: [
					{
						id: 'p',
						type: 'paragraph',
						content: [{ text: 'a' }, { id: 't', type: 'tag', data: {} }, { text: 'b' }]
					},
					{ id: 'n', type: 'note', data: { level: 1 } }
				]
			}
		}
	);

describe('snippets receive declared view objects', () => {
	row('a block snippet receives {id, type, data, selected, focused}, not a wrapper', async () => {
		const seen: Seen = {};
		const { edytor } = await mount(seen);
		const view = seen.block;
		expect(view).toBeTruthy();
		expect(view instanceof Block).toBe(false);
		const note = edytor.root!.children[1]!;
		expect([view.id, view.type, view.data]).toEqual([note.id, 'note', { level: 1 }]);
		expect([view.selected, view.focused]).toEqual([false, false]);
		expect(view.handle).toBe(note);

		note.setBlock({ value: { data: { level: 2 } } });
		await flushDomUpdates();
		expect(view.data).toEqual({ level: 2 });
	});

	row('an inline-atom snippet receives {id, type, data, selected}, not a wrapper', async () => {
		const seen: Seen = {};
		await mount(seen);
		const atom = seen.atom;
		expect(atom).toBeTruthy();
		expect(atom instanceof InlineBlock).toBe(false);
		expect([atom.type, atom.data, atom.selected]).toEqual(['tag', {}, false]);
	});

	pin('the core registers the block element around the snippet (R5)', async () => {
		const seen: Seen = {};
		const { edytor } = await mount(seen);
		const note = edytor.root!.children[1]!;
		expect(note.node).toBe(seen.node?.parentElement);
		expect(note.node?.getAttribute('data-edytor-id')).toBe(note.id);
	});
});
