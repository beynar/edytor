/** @jsxImportSource ./jsx */
import { describe, test, it } from 'vitest';
import { createTestEdytor, findBlockAndTextAtPath } from './test.utils';

describe('Delete block', () => {
	test('delete empty paragraph', async () => {
		const { edytor, expect } = createTestEdytor(
			<root>
				<paragraph>First paragraph</paragraph>
				<paragraph>|</paragraph>
			</root>
		);

		edytor.selection.state.startBlock?.removeBlock();

		expect(
			<root>
				<paragraph>First paragraph</paragraph>
			</root>
		);
	});

	test('delete paragraph with content', async () => {
		const { edytor, expect } = createTestEdytor(
			<root>
				<paragraph>First paragraph</paragraph>
				<paragraph>|Second paragraph|</paragraph>
				<paragraph>Third paragraph</paragraph>
			</root>
		);

		edytor.selection.state.startBlock?.removeBlock();

		expect(
			<root>
				<paragraph>First paragraph</paragraph>
				<paragraph>Third paragraph</paragraph>
			</root>
		);
	});

	test('delete nested list item', async () => {
		const { edytor, expect } = createTestEdytor(
			<root>
				<ordered-list>
					<list-item>First item</list-item>
					<list-item>|Second item|</list-item>
					<list-item>Third item</list-item>
				</ordered-list>
			</root>
		);

		edytor.selection.state.startBlock?.removeBlock();

		expect(
			<root>
				<ordered-list>
					<list-item>First item</list-item>
					<list-item>Third item</list-item>
				</ordered-list>
			</root>
		);
	});

	test('delete block with children and keep them', async () => {
		const { edytor, expect } = createTestEdytor(
			<root>
				<ordered-list>
					<list-item>First item</list-item>
					<list-item>
						|Parent item
						<list-item>Child 1</list-item>
						<list-item>Child 2</list-item>
					</list-item>
					<list-item>Last item</list-item>
				</ordered-list>
			</root>
		);

		edytor.selection.state.startBlock?.removeBlock({ keepChildren: true });

		expect(
			<root>
				<ordered-list>
					<list-item>First item</list-item>
					<list-item>Child 1</list-item>
					<list-item>Child 2</list-item>
					<list-item>Last item</list-item>
				</ordered-list>
			</root>
		);
	});

	test('delete block with children without keeping them', async () => {
		const { edytor, expect } = createTestEdytor(
			<root>
				<ordered-list>
					<list-item>First item</list-item>
					<list-item>
						|Parent item
						<list-item>Child 1</list-item>
						<list-item>Child 2</list-item>
					</list-item>
					<list-item>Last item</list-item>
				</ordered-list>
			</root>
		);

		edytor.selection.state.startBlock?.removeBlock({ keepChildren: false });

		expect(
			<root>
				<ordered-list>
					<list-item>First item</list-item>
					<list-item>Last item</list-item>
				</ordered-list>
			</root>
		);
	});

	test('delete block with inline content', async () => {
		const { edytor, expect } = createTestEdytor(
			<root>
				<paragraph>First paragraph</paragraph>
				<paragraph>
					|Text with <mention>@user</mention> mention|
				</paragraph>
				<paragraph>Last paragraph</paragraph>
			</root>
		);

		edytor.selection.state.startBlock?.removeBlock();

		expect(
			<root>
				<paragraph>First paragraph</paragraph>
				<paragraph>Last paragraph</paragraph>
			</root>
		);
	});

	test('cannot delete root block', async () => {
		const { edytor, expect } = createTestEdytor(
			<root>
				|<paragraph>Content</paragraph>
			</root>
		);

		edytor.selection.state.startBlock?.removeBlock();

		expect(
			<root>
				<paragraph>Content</paragraph>
			</root>
		);
	});

	it('should delete a block and keep its children', () => {
		const { edytor, expect } = createTestEdytor(
			<root>
				<ordered-list>
					<list-item>First|</list-item>
					<list-item>Second</list-item>
				</ordered-list>
			</root>
		);

		const { block } = findBlockAndTextAtPath(edytor)([0, 0, 0]);
		block?.removeBlock({ keepChildren: true });

		expect(
			<root>
				<ordered-list>
					<list-item>Second</list-item>
				</ordered-list>
			</root>
		);
	});
});
