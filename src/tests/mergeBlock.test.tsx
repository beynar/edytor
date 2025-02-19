/** @jsxImportSource ./jsx */
import { describe, it } from 'vitest';
import { createTestEdytor, findBlockAndTextAtPath } from './test.utils';

describe('mergeBlock', () => {
	it('should merge block with previous block', () => {
		const { edytor, expect } = createTestEdytor(
			<root>
				<paragraph>Hello</paragraph>
				<paragraph>|world!</paragraph>
			</root>
		);

		const { block } = findBlockAndTextAtPath(edytor)([1, 0]);
		block?.mergeBlockBackward();

		expect(
			<root>
				<paragraph>Helloworld!</paragraph>
			</root>
		);
	});
});
