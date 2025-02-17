/** @jsxImportSource ./jsx */
import { describe, it } from 'vitest';
import { createTestEdytor } from './test.utils.js';

describe('split text operations', () => {
	it('should split text in the middle of a word', () => {
		const { edytor, expect } = createTestEdytor(
			<root>
				<paragraph>Hello wo|rld!</paragraph>
			</root>
		);

		edytor.selection.state.startBlock?.splitBlock({
			index: edytor.selection.state.yStart,
			text: edytor.selection.state.startBlock?.firstText
		});

		expect(
			<root>
				<paragraph>Hello wo</paragraph>
				<paragraph>rld!</paragraph>
			</root>
		);
	});

	it('should split text with marks correctly', () => {
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

	it('should split at the beginning of a line', () => {
		const { edytor, expect } = createTestEdytor(
			<root>
				<paragraph>|Hello world!</paragraph>
			</root>
		);

		edytor.selection.state.startBlock?.splitBlock({
			index: edytor.selection.state.yStart,
			text: edytor.selection.state.startBlock?.firstText
		});

		expect(
			<root>
				<paragraph></paragraph>
				<paragraph>Hello world!</paragraph>
			</root>
		);
	});

	it('should split at the end of a line', () => {
		const { edytor, expect } = createTestEdytor(
			<root>
				<paragraph>Hello world!|</paragraph>
			</root>
		);

		edytor.selection.state.startBlock?.splitBlock({
			index: edytor.selection.state.yStart,
			text: edytor.selection.state.startBlock?.firstText
		});

		expect(
			<root>
				<paragraph>Hello world!</paragraph>
				<paragraph></paragraph>
			</root>
		);
	});

	it('should split text with multiple marks and formatting', () => {
		const { edytor, expect } = createTestEdytor(
			<root>
				<paragraph>
					Hello{' '}
					<bold>
						<italic>wo|rld</italic>
					</bold>{' '}
					<underline>today</underline>!
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
					Hello{' '}
					<bold>
						<italic>wo</italic>
					</bold>
				</paragraph>
				<paragraph>
					<bold>
						<italic>rld</italic>
					</bold>{' '}
					<underline>today</underline>!
				</paragraph>
			</root>
		);
	});

	it('should split between words with whitespace', () => {
		const { edytor, expect } = createTestEdytor(
			<root>
				<paragraph>Hello | world!</paragraph>
			</root>
		);

		edytor.selection.state.startBlock?.splitBlock({
			index: edytor.selection.state.yStart,
			text: edytor.selection.state.startBlock?.firstText
		});

		expect(
			<root>
				<paragraph>Hello </paragraph>
				<paragraph> world!</paragraph>
			</root>
		);
	});

	it('should split nested blocks correctly', () => {
		const { edytor, expect } = createTestEdytor(
			<root>
				<ordered-list>
					<list-item>First item</list-item>
					<list-item>Second item with |nested content</list-item>
					<list-item>Third item</list-item>
				</ordered-list>
			</root>
		);

		edytor.selection.state.startBlock?.splitBlock({
			index: edytor.selection.state.yStart,
			text: edytor.selection.state.startBlock?.firstText
		});

		expect(
			<root>
				<ordered-list>
					<list-item>First item</list-item>
					<list-item>Second item with </list-item>
					<list-item>nested content</list-item>
					<list-item>Third item</list-item>
				</ordered-list>
			</root>
		);
	});

	it('should split deeply nested blocks with mixed formatting', () => {
		const { edytor, expect } = createTestEdytor(
			<root>
				<ordered-list>
					<list-item>
						<bold>Important:</bold> This is a <italic>complex|ly formatted</italic> nested structure
					</list-item>
				</ordered-list>
			</root>
		);

		edytor.selection.state.startBlock?.splitBlock({
			index: edytor.selection.state.yStart,
			text: edytor.selection.state.startBlock?.firstText
		});

		expect(
			<root>
				<ordered-list>
					<list-item>
						<bold>Important:</bold> This is a <italic>complex</italic>
					</list-item>
					<list-item>
						<italic>ly formatted</italic> nested structure
					</list-item>
				</ordered-list>
			</root>
		);
	});

	it('should split text within a nested list structure', () => {
		const { edytor, expect } = createTestEdytor(
			<root>
				<ordered-list>
					<list-item>First item</list-item>
					<list-item>Second |item with content</list-item>
					<list-item>Third item</list-item>
				</ordered-list>
			</root>
		);

		edytor.selection.state.startBlock?.splitBlock({
			index: edytor.selection.state.yStart,
			text: edytor.selection.state.startBlock?.firstText
		});

		expect(
			<root>
				<ordered-list>
					<list-item>First item</list-item>
					<list-item>Second </list-item>
					<list-item>item with content</list-item>
					<list-item>Third item</list-item>
				</ordered-list>
			</root>
		);
	});

	it('should split text in deeply nested blocks with mixed content', () => {
		const { edytor, expect } = createTestEdytor(
			<root>
				<ordered-list>
					<list-item>
						<bold>Important:</bold> This is a <italic>complex|ly formatted</italic> nested structure
					</list-item>
				</ordered-list>
			</root>
		);

		edytor.selection.state.startBlock?.splitBlock({
			index: edytor.selection.state.yStart,
			text: edytor.selection.state.startBlock?.firstText
		});

		expect(
			<root>
				<ordered-list>
					<list-item>
						<bold>Important:</bold> This is a <italic>complex</italic>
					</list-item>
					<list-item>
						<italic>ly formatted</italic> nested structure
					</list-item>
				</ordered-list>
			</root>
		);
	});
});
