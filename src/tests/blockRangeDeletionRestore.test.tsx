/** @jsxImportSource ./jsx */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOperationEdytor, runBeforeInput } from './test.utils.js';

// D13, rewritten at arch-v2 D6 against the invariant that replaced the
// mechanism: a spanning delete is the document's range deletion, which
// names the caret (`del.range.caret`); the command writes it through the
// ordinary selection write (its own mount handling), so there is no
// fire-and-forget retry cadence left to reject or to log at a cap.
// Headless, no text ever has a connected DOM node. (The fixture was
// `foo|` → `|bar`, a range ending on the tail's start, which merged; under
// `del.range.flat`'s `yEnd == 0` row the tail is untouched, so the range
// now ends inside the tail.)
describe('block-range deletion caret', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('merges the spanning delete and settles quietly with the caret at the seam', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { edytor } = createOperationEdytor(
			<root>
				<paragraph>fo|o</paragraph>
				<paragraph>b|ar</paragraph>
			</root>
		);

		await runBeforeInput(edytor, { inputType: 'deleteContentBackward' });
		expect(edytor.root!.children.map((block) => block.firstText.stringContent)).toEqual(['foar']);

		await new Promise((resolve) => setTimeout(resolve, 250));

		expect(errorSpy).not.toHaveBeenCalled();
		expect(edytor.selection.state.startText?.stringContent).toBe('foar');
		expect(edytor.selection.state.yStart).toBe(2);
	});
});
