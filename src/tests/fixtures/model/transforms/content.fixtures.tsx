/** @jsxImportSource ../../../jsx */
import { expect } from 'vitest';

import { expectBlockInvariantSnapshot } from '../../../test.utils.js';
import { addMentionAtSelection } from '../../helpers/model.js';
import { defineFixtures, defineModelTransformFixture } from '../../types.js';

export const fixtures = defineFixtures([
	defineModelTransformFixture({
		description: 'adds an inline block in the middle of plain text',
		input: (
			<root>
				<paragraph>Hello| world!</paragraph>
			</root>
		),
		run: ({ edytor }) => addMentionAtSelection(edytor),
		output: (
			<root>
				<paragraph>
					Hello<mention></mention> world!
				</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'adds an inline block at the start of a block',
		input: (
			<root>
				<paragraph>|Hello world!</paragraph>
			</root>
		),
		run: ({ edytor }) => addMentionAtSelection(edytor),
		output: (
			<root>
				<paragraph>
					<mention></mention>Hello world!
				</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'adds an inline block at the end of a block',
		input: (
			<root>
				<paragraph>Hello world!|</paragraph>
			</root>
		),
		run: ({ edytor }) => addMentionAtSelection(edytor),
		output: (
			<root>
				<paragraph>
					Hello world!<mention></mention>
				</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'adds an inline block inside marked text while preserving marks on both sides',
		input: (
			<root>
				<paragraph>
					<bold>Hello| world</bold>
				</paragraph>
			</root>
		),
		run: ({ edytor }) => addMentionAtSelection(edytor),
		output: (
			<root>
				<paragraph>
					<bold>Hello</bold>
					<mention></mention>
					<bold> world</bold>
				</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description:
			'adds an inline block between two inline blocks without leaking empty text to the serialized value',
		input: (
			<root>
				<paragraph>
					<mention></mention>|<mention></mention>
				</paragraph>
			</root>
		),
		run: ({ edytor }) => addMentionAtSelection(edytor),
		output: (
			<root>
				<paragraph>
					<mention></mention>
					<mention></mention>
					<mention></mention>
				</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'adds an inline block into an empty text node and returns the trailing caret text',
		input: (
			<root>
				<paragraph>|</paragraph>
			</root>
		),
		run: ({ edytor }) => addMentionAtSelection(edytor),
		result: { kind: 'text', path: [0, 2], content: '' },
		output: (
			<root>
				<paragraph>
					<mention></mention>
				</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description:
			'removes an inline block from the middle of text and coalesces the surrounding text parts',
		input: (
			<root>
				<paragraph>
					Hello<mention></mention>| world!
				</paragraph>
			</root>
		),
		run: ({ edytor }) => edytor.selection.state.startBlock?.removeInlineBlock({ index: 1 }),
		output: (
			<root>
				<paragraph>Hello world!</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'removes an inline block at the start boundary',
		input: (
			<root>
				<paragraph>
					<mention></mention>|world
				</paragraph>
			</root>
		),
		run: ({ edytor }) => edytor.selection.state.startBlock?.removeInlineBlock({ index: 1 }),
		output: (
			<root>
				<paragraph>world</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'removes an inline block at the end boundary',
		input: (
			<root>
				<paragraph>
					Hello|<mention></mention>
				</paragraph>
			</root>
		),
		run: ({ edytor }) => edytor.selection.state.startBlock?.removeInlineBlock({ index: 1 }),
		output: (
			<root>
				<paragraph>Hello</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'removes the only inline block in a block and keeps the block editable',
		input: (
			<root>
				<paragraph>
					|<mention></mention>
				</paragraph>
			</root>
		),
		run: ({ edytor }) => edytor.selection.state.startBlock?.removeInlineBlock({ index: 1 }),
		output: (
			<root>
				<paragraph></paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description:
			'merges marked text back together after removing an inline block between identical marks',
		input: (
			<root>
				<paragraph>
					<bold>Hello</bold>
					<mention></mention>|<bold> world</bold>
				</paragraph>
			</root>
		),
		run: ({ edytor }) => edytor.selection.state.startBlock?.removeInlineBlock({ index: 1 }),
		output: (
			<root>
				<paragraph>
					<bold>Hello world</bold>
				</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'is a no-op when the requested content index is text instead of an inline block',
		input: (
			<root>
				<paragraph>Hello| world</paragraph>
			</root>
		),
		run: ({ edytor }) => edytor.selection.state.startBlock?.removeInlineBlock({ index: 0 }),
		output: (
			<root>
				<paragraph>Hello world</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'is a no-op when the requested content index is out of range',
		input: (
			<root>
				<paragraph>
					Hello|<mention></mention> world
				</paragraph>
			</root>
		),
		run: ({ edytor }) => edytor.selection.state.startBlock?.removeInlineBlock({ index: 99 }),
		output: (
			<root>
				<paragraph>
					Hello<mention></mention> world
				</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description:
			'appends mixed marked text and inline content without leaving adjacent content fragments',
		input: (
			<root>
				<paragraph>
					Hello<mention></mention>|
				</paragraph>
				<paragraph>
					<bold> world</bold>
					<mention></mention>
				</paragraph>
			</root>
		),
		run: ({ edytor }) => {
			const targetBlock = edytor.selection.state.startBlock;
			const sourceBlock = edytor.root?.children[1];
			if (!targetBlock || !sourceBlock) {
				throw new Error('Missing block fixtures for pushContentIntoBlock');
			}

			targetBlock.pushContentIntoBlock({ value: sourceBlock.content });
		},
		output: (
			<root>
				<paragraph>
					Hello<mention></mention>
					<bold> world</bold>
					<mention></mention>
				</paragraph>
				<paragraph>
					<bold> world</bold>
					<mention></mention>
				</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'stores a plain string suggestion and appends it when accepted',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		),
		run: ({ edytor }) => {
			const block = edytor.selection.state.startBlock;
			if (!block) {
				throw new Error('Missing block fixture for the text suggestion');
			}

			edytor.suggestions.add({ end: block.id }, [
				{ type: block.type, content: [{ text: ' world' }] }
			]);
			if (edytor.suggestions.at(block.id).end.length !== 1) {
				throw new Error('Expected a single plain-text suggestion');
			}

			edytor.suggestions.at(block.id).end.at(-1)?.accept();
		},
		assert: ({ edytor }) => {
			expect(edytor.suggestions.list).toEqual([]);
		},
		output: (
			<root>
				<paragraph>Hello world</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'groups inline-rich suggestions and normalizes them when accepted',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		),
		run: ({ edytor }) => {
			const block = edytor.selection.state.startBlock;
			if (!block) {
				throw new Error('Missing block fixture for grouped suggestion test');
			}

			edytor.suggestions.add({ end: block.id }, [
				{
					type: block.type,
					content: [
						{ type: 'mention', data: { id: '42' } },
						{ text: ' world', marks: { bold: true } }
					]
				}
			]);

			// The atom, then its run of text (no sentinel texts; the ghost text is not content).
			if (edytor.suggestions.at(block.id).end.at(-1)?.content[0]?.content?.length !== 2) {
				throw new Error('Expected grouped suggestions: the inline block, then the text run');
			}

			edytor.suggestions.at(block.id).end.at(-1)?.accept();
		},
		assert: ({ edytor }) => {
			expectBlockInvariantSnapshot(edytor);
		},
		output: (
			<root>
				<paragraph>
					Hello<mention id="42"></mention>
					<bold> world</bold>
				</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'a discarded suggestion is gone, and accepting none is a no-op',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		),
		run: ({ edytor }) => {
			const block = edytor.selection.state.startBlock;
			if (!block) {
				throw new Error('Missing block fixture for suggestion reset test');
			}

			edytor.suggestions
				.add({ end: block.id }, [{ type: block.type, content: [{ text: ' world' }] }])
				.discard();
			edytor.suggestions.at(block.id).end.at(-1)?.accept();
		},
		assert: ({ edytor }) => {
			expect(edytor.suggestions.list).toEqual([]);
		},
		output: (
			<root>
				<paragraph>Hello</paragraph>
			</root>
		)
	})
]);
