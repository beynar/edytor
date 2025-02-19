/** @jsxImportSource ./jsx */
import { describe, it } from 'vitest';
import { createTestEdytor, findBlockAndTextAtPath } from './test.utils';

describe('unNestBlock', () => {
	it('should unnest a block from its parent', () => {
		const { edytor, expect } = createTestEdytor(
			<root>
				<ordered-list>
					<list-item>
						First
						<list-item>|Second</list-item>
					</list-item>
				</ordered-list>
			</root>
		);

		const { block } = findBlockAndTextAtPath(edytor)([0, 0, 0, 0]);
		block?.unNestBlock();

		expect(
			<root>
				<ordered-list>
					<list-item>First</list-item>
					<list-item>Second</list-item>
				</ordered-list>
			</root>
		);
	});
});
