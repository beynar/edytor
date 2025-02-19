/** @jsxImportSource ./jsx */
import { describe, it } from 'vitest';
import { createTestEdytor, findBlockAndTextAtPath } from './test.utils';

describe('addInlineBlock', () => {
	it('should add an inline block at cursor position', () => {
		const { edytor, expect } = createTestEdytor(
			<root>
				<paragraph>Hello| world!</paragraph>
			</root>
		);

		const { block, text } = findBlockAndTextAtPath(edytor)([0, 0]);
		block?.addInlineBlock({
			index: 5,
			block: { type: 'mention' },
			text
		});

		expect(
			<root>
				<paragraph>
					Hello<mention></mention> world!
				</paragraph>
			</root>
		);
	});
});
