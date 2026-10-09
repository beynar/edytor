/** @jsxImportSource ../../jsx */
/**
 * A keystroke's view work does not grow with the page (`view.scale`): the
 * same keys in a block in the middle of 1,000 and of 5,000 top-level
 * paragraphs cost the same counted work — the DOM nodes the editor's code
 * inspects (`nodeType` reads: the strict root once walked every child of the
 * host), the block attributes recomputed (the selection's membership reads,
 * `isSelected`/`isFocused` and the sets' `has`: a caret moving to another
 * block once re-ran every block's), the block
 * handles resolved (`idToBlock.block`: the handles' near band and a block's
 * siblings once took a handle for every top-level block) and the layout
 * reads (`getBoundingClientRect`). A scaling contract, no wall clock: the
 * counts at 5,000 blocks stay within a small constant of those at 1,000.
 *
 * The browser's own share (its caret and IME bookkeeping, layout of the
 * page) is not counted here: `tests/editor-dom/large-page-scale.spec.ts`
 * counts what needs layout, the profile (`large-page.profile.spec.ts`) times it.
 */
import { describe, expect, it } from 'vitest';
import { SvelteSet } from 'svelte/reactivity';
import type { Block } from '$lib/block/block.svelte.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { arrowMovePlugin } from '$lib/plugins/arrowMove/arrowMove.js';
import type { JSONDoc } from '$lib/utils/json.js';
import {
	dispatchDomBeforeInput,
	dispatchDomKeyDown,
	flushDomUpdates,
	renderDomEdytor
} from '../../dom/test.utils.js';

const SMALL = 1_000;
const LARGE = 5_000;

const page = (blocks: number): JSONDoc => ({
	children: Array.from({ length: blocks }, (_, i) => ({
		id: `b${i}`,
		type: 'paragraph',
		content: [{ text: `Block ${i} lorem ipsum` }]
	}))
});

type Counts = { nodes: number; attributes: number; handles: number; layout: number };

/** Counts the work `run` does: wraps the reads each counter names, restored after. */
const counted = async (edytor: Edytor, run: () => Promise<unknown>): Promise<Counts> => {
	const counts: Counts = { nodes: 0, attributes: 0, handles: 0, layout: 0 };
	const nodeType = Object.getOwnPropertyDescriptor(Node.prototype, 'nodeType')!;
	const rect = Element.prototype.getBoundingClientRect;
	const { selection, idToBlock } = edytor;
	const { isSelected, isFocused } = selection;
	const block = idToBlock.block;
	Object.defineProperty(Node.prototype, 'nodeType', {
		...nodeType,
		get() {
			// The editor's own reads (jsdom's style matching reads it too).
			if (/\/src\/lib\//.test(new Error().stack?.split('\n')[2] ?? '')) counts.nodes++;
			return nodeType.get!.call(this);
		}
	});
	Element.prototype.getBoundingClientRect = function (this: Element) {
		counts.layout++;
		return rect.call(this);
	};
	selection.isSelected = (b) => (counts.attributes++, isSelected(b));
	selection.isFocused = (b) => (counts.attributes++, isFocused(b));
	// A read of either set's membership is one too (a block's flag read from the set).
	const sets = [selection.selectedBlocks, selection.focusedBlocks] as Set<Block>[];
	for (const set of sets)
		set.has = (b) => (counts.attributes++, SvelteSet.prototype.has.call(set, b));
	idToBlock.block = (id) => (counts.handles++, block(id));
	try {
		await run();
		await flushDomUpdates();
		// The overlay's frame (block handles, chrome) runs after the key.
		await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve)));
		await flushDomUpdates();
	} finally {
		Object.defineProperty(Node.prototype, 'nodeType', nodeType);
		Element.prototype.getBoundingClientRect = rect;
		selection.isSelected = isSelected;
		selection.isFocused = isFocused;
		for (const set of sets) delete (set as { has?: unknown }).has;
		idToBlock.block = block;
	}
	return counts;
};

const mac = () => /Mac|iPod|iPhone|iPad/.test(window.navigator.platform);

const KEYS = ['type', 'enter', 'caret', 'move'] as const;
type Key = (typeof KEYS)[number];

/** Each key once, its counts: in the middle block, at the end of its text. */
const measure = async (blocks: number): Promise<Record<Key, Counts>> => {
	const { edytor, editor, unmount } = await renderDomEdytor(
		<root>
			<paragraph>x</paragraph>
		</root>,
		{
			value: page(blocks),
			autoSelectFixture: false,
			// No block handles: without layout every block is near and has one
			// (the Playwright row counts the handles with layout).
			plugins: [richTextPlugin, arrowMovePlugin],
			blockHandles: false
		}
	);
	const middle = edytor.idToBlock.get(`b${Math.floor(blocks / 2)}`)!;
	edytor.selection.setCaret({ block: middle, offset: middle.firstText!.length });
	await flushDomUpdates();
	const keys: Record<Key, () => Promise<unknown>> = {
		type: () => dispatchDomBeforeInput(editor, { inputType: 'insertText', data: 'x' }),
		enter: () => dispatchDomBeforeInput(editor, { inputType: 'insertParagraph' }),
		// The caret to the block before (an arrow, a click: the model's caret move).
		caret: async () => {
			const block = edytor.selection.caret!.block.previousBlock!;
			edytor.selection.setCaret({ block, offset: 0 });
			await flushDomUpdates();
		},
		move: () =>
			dispatchDomKeyDown(editor, {
				key: 'ArrowDown',
				code: 'ArrowDown',
				shiftKey: true,
				metaKey: mac(),
				ctrlKey: !mac()
			})
	};
	const result = {} as Record<Key, Counts>;
	for (const key of KEYS) {
		// Warm: the first key of a kind builds what later ones reuse.
		await keys[key]();
		await flushDomUpdates();
		result[key] = await counted(edytor, keys[key]);
	}
	// The keys did what they say: two Enters split two blocks off.
	expect(edytor.root!.children.length).toBe(blocks + 2);
	unmount();
	return result;
};

describe('view.scale — a keystroke costs the same on a page five times longer', () => {
	it('counts each key at 1,000 and at 5,000 blocks', async () => {
		const views = { [SMALL]: await measure(SMALL), [LARGE]: await measure(LARGE) };
		for (const key of KEYS)
			for (const counter of ['nodes', 'attributes', 'handles', 'layout'] as const) {
				const small = views[SMALL][key][counter];
				const large = views[LARGE][key][counter];
				// The same work, give or take a constant (no factor of the page's size).
				expect(large, `${key}: ${counter} (${small} at 1,000)`).toBeLessThanOrEqual(small + 16);
			}
	});
});
