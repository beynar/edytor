/** @jsxImportSource ./jsx */
import { describe, it } from 'vitest';
import { createTestEdytor, findBlockAndTextAtPath } from './test.utils';

describe('split text operations', () => {
	it('should split text in the middle of a word', () => {
		const { edytor, expect } = createTestEdytor(
			<root>
				<paragraph>Hello wo|rld!</paragraph>
			</root>
		);

		edytor.selection.state.startBlock?.splitBlock({
			index: edytor.selection.state.yStart,
			text: edytor.selection.state.startText
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
			text: edytor.selection.state.startText
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
			text: edytor.selection.state.startText
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
			text: edytor.selection.state.startText
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
			text: edytor.selection.state.startText
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
			text: edytor.selection.state.startText
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
			text: edytor.selection.state.startText
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
			text: edytor.selection.state.startText
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
			text: edytor.selection.state.startText
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
			text: edytor.selection.state.startText
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
	it('should split text when cursor is at the end of a nested block', () => {
		const { edytor, expect } = createTestEdytor(
			<root>
				<ordered-list>
					<list-item>
						<bold>End of block|</bold>
					</list-item>
				</ordered-list>
			</root>
		);

		edytor.selection.state.startBlock?.splitBlock({
			index: edytor.selection.state.yStart,
			text: edytor.selection.state.startText
		});

		expect(
			<root>
				<ordered-list>
					<list-item>
						<bold>End of block</bold>
					</list-item>
					<list-item></list-item>
				</ordered-list>
			</root>
		);
	});
	it('should split text when cursor is at the start of a nested block', () => {
		const { edytor, expect } = createTestEdytor(
			<root>
				<ordered-list>
					<list-item>
						<bold>|Start of block</bold>
					</list-item>
				</ordered-list>
			</root>
		);

		edytor.selection.state.startBlock?.splitBlock({
			index: edytor.selection.state.yStart,
			text: edytor.selection.state.startText
		});

		expect(
			<root>
				<ordered-list>
					<list-item></list-item>
					<list-item>
						<bold>Start of block</bold>
					</list-item>
				</ordered-list>
			</root>
		);
	});

	it('should handle splitting text with special characters and emojis', () => {
		const { edytor, expect } = createTestEdytor(
			<root>
				<paragraph>Hello 👋 wo|rld 🌍!</paragraph>
			</root>
		);

		edytor.selection.state.startBlock?.splitBlock({
			index: edytor.selection.state.yStart,
			text: edytor.selection.state.startText
		});

		expect(
			<root>
				<paragraph>Hello 👋 wo</paragraph>
				<paragraph>rld 🌍!</paragraph>
			</root>
		);
	});

	it('should handle splitting with empty text nodes between formatted text', () => {
		const { edytor, expect } = createTestEdytor(
			<root>
				<paragraph>
					<bold>Hello</bold>
					{''}
					<italic>wo|rld</italic>
				</paragraph>
			</root>
		);

		edytor.selection.state.startBlock?.splitBlock({
			index: edytor.selection.state.yStart,
			text: edytor.selection.state.startText
		});

		expect(
			<root>
				<paragraph>
					<bold>Hello</bold>
					<italic>wo</italic>
				</paragraph>
				<paragraph>
					<italic>rld</italic>
				</paragraph>
			</root>
		);
	});

	it('should handle splitting text with multiple consecutive spaces', () => {
		const { edytor, expect } = createTestEdytor(
			<root>
				<paragraph>Hello wo|rld !</paragraph>
			</root>
		);

		edytor.selection.state.startBlock?.splitBlock({
			index: edytor.selection.state.yStart,
			text: edytor.selection.state.startText
		});

		expect(
			<root>
				<paragraph>Hello wo</paragraph>
				<paragraph>rld !</paragraph>
			</root>
		);
	});

	it('should handle splitting in multi-level nested lists', () => {
		const { edytor, expect } = createTestEdytor(
			<root>
				<ordered-list>
					<list-item>
						First level
						<ordered-list>
							<list-item>Second level with |split</list-item>
						</ordered-list>
					</list-item>
				</ordered-list>
			</root>
		);

		edytor.selection.state.startBlock?.splitBlock({
			index: edytor.selection.state.yStart,
			text: edytor.selection.state.startText
		});

		expect(
			<root>
				<ordered-list>
					<list-item>
						First level
						<ordered-list>
							<list-item>Second level with </list-item>
							<list-item>split</list-item>
						</ordered-list>
					</list-item>
				</ordered-list>
			</root>
		);
	});

	it('should split text with mention before cursor', () => {
		const { edytor, expect } = createTestEdytor(
			<root>
				<paragraph>
					Hello <mention data-id="123">@John</mention> wo|rld!
				</paragraph>
			</root>
		);

		edytor.selection.state.startBlock?.splitBlock({
			index: edytor.selection.state.yStart,
			text: edytor.selection.state.startText
		});

		expect(
			<root>
				<paragraph>
					Hello <mention data-id="123">@John</mention> wo
				</paragraph>
				<paragraph>rld!</paragraph>
			</root>
		);
	});

	it('should split text with mention after cursor', () => {
		const { edytor, expect } = createTestEdytor(
			<root>
				<paragraph>
					Hello wo|rld <mention data-id="123">@John</mention>!
				</paragraph>
			</root>
		);

		edytor.selection.state.startBlock?.splitBlock({
			index: edytor.selection.state.yStart,
			text: edytor.selection.state.startText
		});

		expect(
			<root>
				<paragraph>Hello wo</paragraph>
				<paragraph>
					rld <mention data-id="123">@John</mention>!
				</paragraph>
			</root>
		);
	});

	it('should split text with multiple mentions and formatting', () => {
		const { edytor, expect } = createTestEdytor(
			<root>
				<paragraph>
					<bold>Hello</bold> <mention id="123">@John</mention> and <italic>wo|rld</italic>{' '}
					<mention id="456">@Jane</mention>
				</paragraph>
			</root>
		);

		edytor.selection.state.startBlock?.splitBlock({
			index: edytor.selection.state.yStart,
			text: edytor.selection.state.startText
		});

		expect(
			<root>
				<paragraph>
					<bold>Hello</bold> <mention id="123">@John</mention> and <italic>wo</italic>
				</paragraph>
				<paragraph>
					<italic>rld</italic> <mention id="456">@Jane</mention>
				</paragraph>
			</root>
		);
	});

	it('should split a paragraph with nested paragraphs', () => {
		const { edytor, expect } = createTestEdytor(
			<root>
				<paragraph>
					Start of text |with nested paragraph
					<paragraph>Nested paragraph content</paragraph>
				</paragraph>
			</root>
		);

		edytor.selection.state.startBlock?.splitBlock({
			index: edytor.selection.state.yStart,
			text: edytor.selection.state.startText
		});

		expect(
			<root>
				<paragraph>Start of text </paragraph>
				<paragraph>
					with nested paragraph
					<paragraph>Nested paragraph content</paragraph>
				</paragraph>
			</root>
		);
	});
	it('should split a nested paragraph with nested paragraphs', () => {
		const { edytor, expect } = createTestEdytor(
			<root>
				<paragraph>
					Start of text with nested paragraph
					<paragraph>
						Nested paragraph |content
						<paragraph>Another Nested paragraph content</paragraph>
					</paragraph>
				</paragraph>
			</root>
		);

		edytor.selection.state.startBlock?.splitBlock({
			index: edytor.selection.state.yStart,
			text: edytor.selection.state.startText
		});

		expect(
			<root>
				<paragraph>
					Start of text with nested paragraph
					<paragraph>Nested paragraph </paragraph>
					<paragraph>
						content
						<paragraph>Another Nested paragraph content</paragraph>
					</paragraph>
				</paragraph>
			</root>
		);
	});
});

describe('splitBlock', () => {
	it('should split a block at cursor position', () => {
		const { edytor, expect } = createTestEdytor(
			<root>
				<paragraph>Hello| world!</paragraph>
			</root>
		);

		const { block, text } = findBlockAndTextAtPath(edytor)([0, 0]);
		block?.splitBlock({ index: 5, text });

		expect(
			<root>
				<paragraph>Hello</paragraph>
				<paragraph> world!</paragraph>
			</root>
		);
	});
});
