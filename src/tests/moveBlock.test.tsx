/** @jsxImportSource ./jsx */
import { describe, it } from 'vitest';
import { createTestEdytor } from './test.utils.js';

describe('move block operations', () => {
	it('should move a block to a new position at the same level', () => {
		const { edytor, expect } = createTestEdytor(
			<root>
				<paragraph>First|</paragraph>
				<paragraph>Second</paragraph>
				<paragraph>Third</paragraph>
			</root>
		);

		edytor.selection.state.startBlock?.moveBlock({
			path: [2]
		});

		expect(
			<root>
				<paragraph>Second</paragraph>
				<paragraph>Third</paragraph>
				<paragraph>First</paragraph>
			</root>
		);
	});

	it('should move a block into a nested position', () => {
		const { edytor, expect } = createTestEdytor(
			<root>
				<paragraph>First|</paragraph>
				<paragraph>
					Parent
					<paragraph>Child</paragraph>
				</paragraph>
			</root>
		);

		edytor.selection.state.startBlock?.moveBlock({
			path: [1, 1]
		});

		expect(
			<root>
				<paragraph>
					Parent
					<paragraph>Child</paragraph>
					<paragraph>First</paragraph>
				</paragraph>
			</root>
		);
	});

	it('should move a nested block to root level', () => {
		const { edytor, expect } = createTestEdytor(
			<root>
				<paragraph>
					Parent
					<paragraph>Child|</paragraph>
				</paragraph>
				<paragraph>Last</paragraph>
			</root>
		);

		edytor.selection.state.startBlock?.moveBlock({
			path: [1]
		});

		expect(
			<root>
				<paragraph>Parent</paragraph>
				<paragraph>Child</paragraph>
				<paragraph>Last</paragraph>
			</root>
		);
	});

	it('should handle moving a block with children', () => {
		const { edytor, expect } = createTestEdytor(
			<root>
				<paragraph>First|</paragraph>
				<paragraph>Second</paragraph>
				<paragraph>
					Parent
					<paragraph>Child</paragraph>
				</paragraph>
			</root>
		);

		edytor.selection.state.startBlock?.moveBlock({
			path: [2, 0]
		});

		expect(
			<root>
				<paragraph>Second</paragraph>
				<paragraph>
					Parent
					<paragraph>First</paragraph>
					<paragraph>Child</paragraph>
				</paragraph>
			</root>
		);
	});

	it('should not move a block with invalid path', () => {
		const { edytor, expect } = createTestEdytor(
			<root>
				<paragraph>First|</paragraph>
				<paragraph>Second</paragraph>
			</root>
		);

		edytor.selection.state.startBlock?.moveBlock({
			path: [-1]
		});

		expect(
			<root>
				<paragraph>First</paragraph>
				<paragraph>Second</paragraph>
			</root>
		);
	});

	it('should not move a block with empty path array', () => {
		const { edytor, expect } = createTestEdytor(
			<root>
				<paragraph>First|</paragraph>
				<paragraph>Second</paragraph>
			</root>
		);

		edytor.selection.state.startBlock?.moveBlock({
			path: []
		});

		expect(
			<root>
				<paragraph>First</paragraph>
				<paragraph>Second</paragraph>
			</root>
		);
	});

	it('should not move a block to a non-existent path', () => {
		const { edytor, expect } = createTestEdytor(
			<root>
				<paragraph>First|</paragraph>
				<paragraph>Second</paragraph>
			</root>
		);

		edytor.selection.state.startBlock?.moveBlock({
			path: [5, 2, 1]
		});

		expect(
			<root>
				<paragraph>First</paragraph>
				<paragraph>Second</paragraph>
			</root>
		);
	});

	it('should handle moving a block with formatted content', () => {
		const { edytor, expect } = createTestEdytor(
			<root>
				<paragraph>
					<bold>Important:|</bold> This is formatted
				</paragraph>
				<paragraph>Second</paragraph>
			</root>
		);

		edytor.selection.state.startBlock?.moveBlock({
			path: [1]
		});

		expect(
			<root>
				<paragraph>Second</paragraph>
				<paragraph>
					<bold>Important:</bold> This is formatted
				</paragraph>
			</root>
		);
	});

	it('should handle moving a block with multiple levels of nesting', () => {
		const { edytor, expect } = createTestEdytor(
			<root>
				<paragraph>
					Level 1
					<paragraph>
						Level 2<paragraph>Level 3|</paragraph>
					</paragraph>
				</paragraph>
				<paragraph>Target</paragraph>
			</root>
		);

		edytor.selection.state.startBlock?.moveBlock({
			path: [1]
		});

		expect(
			<root>
				<paragraph>
					Level 1<paragraph>Level 2</paragraph>
				</paragraph>
				<paragraph>Level 3</paragraph>
				<paragraph>Target</paragraph>
			</root>
		);
	});

	it('should handle moving a block to its own child position (which should be prevented)', () => {
		const { edytor, expect } = createTestEdytor(
			<root>
				<paragraph>
					Parent|
					<paragraph>Child 1</paragraph>
					<paragraph>Child 2</paragraph>
				</paragraph>
			</root>
		);

		edytor.selection.state.startBlock?.moveBlock({
			path: [0, 1]
		});

		expect(
			<root>
				<paragraph>
					Parent
					<paragraph>Child 1</paragraph>
					<paragraph>Child 2</paragraph>
				</paragraph>
			</root>
		);
	});

	it('should handle moving a block with mixed content types', () => {
		const { edytor, expect } = createTestEdytor(
			<root>
				<paragraph>
					<bold>Mixed|</bold>
					<paragraph>Nested</paragraph>
					<italic>Content</italic>
				</paragraph>
				<paragraph>Target</paragraph>
			</root>
		);

		edytor.selection.state.startBlock?.moveBlock({
			path: [1]
		});

		expect(
			<root>
				<paragraph>Target</paragraph>
				<paragraph>
					<bold>Mixed</bold>
					<paragraph>Nested</paragraph>
					<italic>Content</italic>
				</paragraph>
			</root>
		);
	});
});
