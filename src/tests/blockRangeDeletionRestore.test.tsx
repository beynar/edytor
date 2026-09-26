/** @jsxImportSource ./jsx */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOperationEdytor, runBeforeInput } from './test.utils.js';

// D13 — the block-range-deletion selection restore runs on a retry
// cadence because the target text remounts asynchronously. It must not
// reject out of a fire-and-forget timeout at the cap (unhandled
// rejection) and must not throw evaluating `firstText` on a contentless
// fallback block. Headless, no text ever has a connected DOM node, so
// every attempt misses and the cap is exercised deterministically.
describe('restoreSelectionAfterBlockRangeDeletion', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('merges the spanning delete and resolves quietly at the retry cap', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { edytor } = createOperationEdytor(
			<root>
				<paragraph>foo|</paragraph>
				<paragraph>|bar</paragraph>
			</root>
		);

		await runBeforeInput(edytor, { inputType: 'deleteContentBackward' });
		expect(edytor.root!.children.map((block) => block.firstText.stringContent)).toEqual(['foobar']);

		// 10 attempts at ~10ms — wait past the cap with real timers.
		await new Promise((resolve) => setTimeout(resolve, 250));

		expect(errorSpy).toHaveBeenCalledTimes(1);
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('block range'));
	});
});
