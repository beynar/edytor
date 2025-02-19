/** @jsxImportSource ./jsx */
import { describe, it } from 'vitest';
import { createTestEdytor, findBlockAndTextAtPath } from './test.utils';

describe('removeInlineBlock', () => {
	it('should remove an inline block at specified index', () => {
		const { edytor, expect } = createTestEdytor(
			<root>
				<paragraph>
					Hello<mention></mention>| world!
				</paragraph>
			</root>
		);

		const { block } = findBlockAndTextAtPath(edytor)([0, 2]);
		block?.removeInlineBlock({ index: 1 });

		expect(
			<root>
				<paragraph>Hello world!</paragraph>
			</root>
		);
	});
});
