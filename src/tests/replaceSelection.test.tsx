/** @vitest-environment jsdom */
/** @jsxImportSource ./jsx */
import { describe, expect, test } from 'vitest';

import {
	getSelectionReplacementState,
	replaceSelectionWithCollapsedTargetSync
} from '$lib/selection/replaceSelection.js';
import { createOperationEdytor } from './test.utils.js';

describe('selection replacement snapshots', () => {
	test('uses the saved cross-block range after the live selection moves', async () => {
		const { edytor } = createOperationEdytor(
			<root>
				<paragraph>Al|pha</paragraph>
				<paragraph>Br|avo</paragraph>
				<paragraph>Charlie</paragraph>
			</root>
		);
		const replacementState = getSelectionReplacementState(edytor);
		const originalStartText = replacementState.startText;
		const driftTarget = edytor.root!.children[2]!.firstText;

		await edytor.selection.setAtTextOffset(driftTarget, 3);
		const target = replaceSelectionWithCollapsedTargetSync(edytor, replacementState);

		expect(target).toEqual({ text: originalStartText, offset: 2 });
		expect(
			edytor.value.children.map((block) =>
				block.content?.map((part) => ('text' in part ? part.text : '')).join('')
			)
		).toEqual(['Alavo', 'Charlie']);
	});
});
