/** @jsxImportSource ../../jsx */
/**
 * arch-v2 §8.5 — checkpoint D2 row F-P1 (`block-extend`): block-selection
 * extension walks the one document order.
 *
 * `A{A1, A2, A3}, B`; select A3; Shift+Up twice; Shift+Down →
 * `{A2,A3}` → `{A1,A2,A3}` → `{A2,A3}` (plan §8.5 F-P1; K7 "Shift+ArrowUp/Down
 * extend it in document order"). Expected values come from the plan row.
 * Red on the reference (root-index-only order stalls the second Shift+Up).
 */
import { describe, expect, test } from 'vitest';
import { dispatchDomKeyDown, renderDomEdytor } from '../../dom/test.utils.js';
import type { Edytor } from '$lib/edytor.svelte.js';

/** Selected blocks as their own text, in document order of their paths. */
const selectedTexts = (edytor: Edytor) =>
	Array.from(edytor.selection.selectedBlocks)
		.map((block) => ({ path: block.path.join('.'), text: block.content[0]?.stringContent }))
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
		.map((entry) => entry.text);

describe('F-P1 — block-selection extension in a nested list', () => {
	test.fails('select A3; Shift+Up twice; Shift+Down', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>
					A<paragraph>A1</paragraph>
					<paragraph>A2</paragraph>
					<paragraph>A3|</paragraph>
				</paragraph>
				<paragraph>B</paragraph>
			</root>
		);

		// Select A3 as a block: the select-all ladder (text range, then the block).
		await dispatchDomKeyDown(document, { key: 'a', code: 'KeyA', metaKey: true });
		await dispatchDomKeyDown(document, { key: 'a', code: 'KeyA', metaKey: true });
		expect(selectedTexts(edytor)).toEqual(['A3']);

		await dispatchDomKeyDown(document, { key: 'ArrowUp', shiftKey: true });
		expect(selectedTexts(edytor)).toEqual(['A2', 'A3']);

		await dispatchDomKeyDown(document, { key: 'ArrowUp', shiftKey: true });
		expect(selectedTexts(edytor)).toEqual(['A1', 'A2', 'A3']);

		await dispatchDomKeyDown(document, { key: 'ArrowDown', shiftKey: true });
		expect(selectedTexts(edytor)).toEqual(['A2', 'A3']);
	});
});
