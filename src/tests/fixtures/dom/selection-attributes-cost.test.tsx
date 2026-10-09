/** @jsxImportSource ../../jsx */
/**
 * A selection change rebuilds the block element attributes of the blocks it
 * selects, focuses, deselects or blurs, never those of the others: a caret
 * moving to another block (Enter, an arrow key, a click) costs the two
 * blocks, not the page (`Block.svelte` reads one boolean per block for each
 * of `selectedBlocks` and `focusedBlocks`). Counted by a kind whose declared
 * attributes count their reads: each build of a block's attributes spreads
 * them once.
 */
import { describe, expect, it } from 'vitest';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import type { JSONBlock } from '$lib/utils/json.js';
import { attributeProbePlugin } from '../../dom/AttributeProbeKind.svelte';
import { flushDomUpdates, renderDomEdytor } from '../../dom/test.utils.js';

const BLOCKS = 20;
const ids = Array.from({ length: BLOCKS }, (_, i) => `p${i}`);
const value = {
	children: ids.map((id): JSONBlock => ({ id, type: 'probe', content: [{ text: `text ${id}` }] }))
};

const render = async () => {
	const reads: string[] = [];
	const view = await renderDomEdytor(
		<root>
			<paragraph>a</paragraph>
		</root>,
		{ value, plugins: [attributeProbePlugin(reads), richTextPlugin] }
	);
	await flushDomUpdates();
	const attribute = (id: string, name: string) =>
		view.edytor.idToBlock.get(id)!.node!.getAttribute(`data-edytor-${name}`);
	return { ...view, reads, attribute };
};

describe('a selection change costs the blocks it changes', () => {
	it('a caret moving to another block rebuilds the attributes of those two blocks only', async () => {
		const { edytor, reads, attribute } = await render();
		edytor.selection.setCaret({ block: edytor.idToBlock.get('p3')!, offset: 2 });
		await flushDomUpdates();
		expect(attribute('p3', 'focused')).toBe('true');
		reads.length = 0;

		edytor.selection.setCaret({ block: edytor.idToBlock.get('p12')!, offset: 1 });
		await flushDomUpdates();
		expect([...new Set(reads)].sort()).toEqual(['p12', 'p3']);
		expect([attribute('p3', 'focused'), attribute('p12', 'focused')]).toEqual([null, 'true']);
	});

	it('a caret moving inside its block rebuilds no attributes', async () => {
		const { edytor, reads } = await render();
		const block = edytor.idToBlock.get('p5')!;
		edytor.selection.setCaret({ block, offset: 1 });
		await flushDomUpdates();
		reads.length = 0;

		edytor.selection.setCaret({ block, offset: 4 });
		await flushDomUpdates();
		expect(reads).toEqual([]);
	});

	it('selecting blocks rebuilds the attributes of the blocks selected and blurred only', async () => {
		const { edytor, reads, attribute } = await render();
		edytor.selection.setCaret({ block: edytor.idToBlock.get('p0')!, offset: 0 });
		await flushDomUpdates();
		reads.length = 0;

		edytor.selection.select({ kind: 'blocks', ids: ['p7', 'p8'] });
		await flushDomUpdates();
		expect([...new Set(reads)].sort()).toEqual(['p0', 'p7', 'p8']);
		expect(['p0', 'p7', 'p8', 'p9'].map((id) => attribute(id, 'selected'))).toEqual([
			null,
			'true',
			'true',
			null
		]);
		reads.length = 0;

		edytor.selection.select({ kind: 'none' });
		await flushDomUpdates();
		expect([...new Set(reads)].sort()).toEqual(['p7', 'p8']);
		expect(['p7', 'p8'].map((id) => attribute(id, 'selected'))).toEqual([null, null]);
	});
});
