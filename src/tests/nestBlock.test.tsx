/** @jsxImportSource ./jsx */
import { describe, it } from 'vitest';
import { createTestEdytor, findBlockAndTextAtPath } from './test.utils';

describe('nestBlock', () => {
	it('should nest a block under the previous block', () => {
		const { edytor, expect } = createTestEdytor(
			<root>
				<ordered-list>
					<list-item>First</list-item>
					<list-item>|Second</list-item>
				</ordered-list>
			</root>
		);

		const { block } = findBlockAndTextAtPath(edytor)([0, 1, 0]);
		block?.nestBlock();

		expect(
			<root>
				<ordered-list>
					<list-item>
						First
						<list-item>Second</list-item>
					</list-item>
				</ordered-list>
			</root>
		);
	});
});
