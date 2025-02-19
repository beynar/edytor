/** @jsxImportSource ./jsx */
import { describe, it } from 'vitest';
import { createTestEdytor } from './test.utils.js';

describe('add block after operations', () => {
	it('should add a child block to an empty paragraph', () => {
		const { edytor, expect } = createTestEdytor(
			<root>
				<paragraph>Parent text|</paragraph>
			</root>
		);

		edytor.selection.state.startBlock?.addChildBlock({
			index: 0,
			text: edytor.selection.state.startText
		});

		expect(
			<root>
				<paragraph>
					Parent text
					<paragraph></paragraph>
				</paragraph>
			</root>
		);
	});

	it('should add a child block to a paragraph with formatted content', () => {
		const { edytor, expect } = createTestEdytor(
			<root>
				<paragraph>
					<bold>Important:|</bold> This is formatted
				</paragraph>
			</root>
		);

		edytor.selection.state.startBlock?.addChildBlock({
			index: 0,
			text: edytor.selection.state.startText
		});

		expect(
			<root>
				<paragraph>
					<bold>Important:</bold> This is formatted
					<paragraph></paragraph>
				</paragraph>
			</root>
		);
	});

	it('should add a child block to an already nested structure', () => {
		const { edytor, expect } = createTestEdytor(
			<root>
				<paragraph>
					Parent content
					<paragraph>Existing child|</paragraph>
				</paragraph>
			</root>
		);

		edytor.selection.state.startBlock?.addChildBlock({
			index: 0,
			text: edytor.selection.state.startText
		});

		expect(
			<root>
				<paragraph>
					Parent content
					<paragraph>
						Existing child
						<paragraph></paragraph>
					</paragraph>
				</paragraph>
			</root>
		);
	});

	it('should add child block at the end when index exceeds children length', () => {
		const { edytor, expect } = createTestEdytor(
			<root>
				<paragraph>
					Parent|
					<paragraph>Child 1</paragraph>
					<paragraph>Child 2</paragraph>
				</paragraph>
			</root>
		);

		edytor.selection.state.startBlock?.addChildBlock({
			index: 5, // Index larger than number of children
			text: edytor.selection.state.startText
		});

		expect(
			<root>
				<paragraph>
					Parent
					<paragraph></paragraph>
					<paragraph>Child 1</paragraph>
					<paragraph>Child 2</paragraph>
				</paragraph>
			</root>
		);
	});

	it('should handle negative indices by inserting at the beginning', () => {
		const { edytor, expect } = createTestEdytor(
			<root>
				<paragraph>
					Parent|
					<paragraph>Child 1</paragraph>
					<paragraph>Child 2</paragraph>
				</paragraph>
			</root>
		);

		edytor.selection.state.startBlock?.addChildBlock({
			index: -1, // Negative index
			text: edytor.selection.state.startText
		});

		expect(
			<root>
				<paragraph>
					Parent
					<paragraph></paragraph>
					<paragraph>Child 1</paragraph>
					<paragraph>Child 2</paragraph>
				</paragraph>
			</root>
		);
	});
});
