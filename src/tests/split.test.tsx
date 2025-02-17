/** @jsxImportSource ./jsx */
import { describe, it } from 'vitest';
import { createTestEdytor } from './test.utils.js';

describe('converts document with natural text and marks', () => {
	it('should convert document with natural text and marks', () => {
		const { edytor, expect } = createTestEdytor(
			<root>
				<paragraph>
					Hello <bold>wo|rld</bold>!
				</paragraph>
			</root>
		);

		edytor.selection.state.startBlock?.splitBlock({
			index: edytor.selection.state.yStart,
			text: edytor.selection.state.startBlock?.firstText
		});

		expect(
			<root>
				<paragraph>
					Hello <bold>wo</bold>
				</paragraph>
				<paragraph>
					<bold>rld</bold>!
				</paragraph>
			</root>
		);
	});
});
