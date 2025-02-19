/** @jsxImportSource ./jsx */
import { describe, it } from 'vitest';
import { createTestEdytor, findBlockAndTextAtPath } from './test.utils';

describe('setBlock', () => {
	it('should update block properties', () => {
		const { edytor, expect } = createTestEdytor(
			<root>
				<paragraph>|Hello world!</paragraph>
			</root>
		);

		edytor.selection.state.startBlock?.setBlock({
			value: {
				type: 'list-item',
				content: [{ text: 'Hello world!' }]
			}
		});

		expect(
			<root>
				<list-item>Hello world!</list-item>
			</root>
		);
	});
});
