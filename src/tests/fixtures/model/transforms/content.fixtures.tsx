/** @jsxImportSource ../../../jsx */
import { expect } from 'vitest';

import { expectBlockInvariantSnapshot } from '../../../test.utils.js';
import { addMentionAtSelection } from '../../helpers/model.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import { InlineBlock } from '$lib/block/inlineBlock.svelte.js';
import { defineFixtures, defineModelTransformFixture } from '../../types.js';
import { selectionState } from '../../../selection.js';

/** Remove the inline atom at `index` of the selection's block's content. */
const removeAtom = (edytor: Edytor, index: number) => {
	const block = selectionState(edytor).startBlock!;
	return edytor.removeInline(block.id, block.content[index]!.id);
};

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
		description: 'adds an inline block into an empty text node',
		input: (
			<root>
				<paragraph>|</paragraph>
			</root>
		),
		run: ({ edytor }) => addMentionAtSelection(edytor),
		result: { kind: 'applied' },
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
		run: ({ edytor }) => removeAtom(edytor, 1),
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
		run: ({ edytor }) => removeAtom(edytor, 1),
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
		run: ({ edytor }) => removeAtom(edytor, 1),
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
		run: ({ edytor }) => removeAtom(edytor, 1),
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
		run: ({ edytor }) => removeAtom(edytor, 1),
		output: (
			<root>
				<paragraph>
					<bold>Hello world</bold>
				</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'is refused when the block shows no such inline atom',
		input: (
			<root>
				<paragraph>
					Hello|<mention></mention> world
				</paragraph>
			</root>
		),
		run: ({ edytor }) => edytor.removeInline(selectionState(edytor).startBlock!.id, 'no-such-atom'),
		result: { kind: 'refused' },
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
			const targetBlock = selectionState(edytor).startBlock;
			const sourceBlock = edytor.root?.children[1];
			if (!targetBlock || !sourceBlock) {
				throw new Error('Missing block fixtures for the append');
			}

			let at = edytor.document.displayLength(targetBlock.id);
			for (const part of sourceBlock.content) {
				if (part instanceof InlineBlock) {
					edytor.insertInline(targetBlock.id, at++, { type: part.type, data: { ...part.data } });
					continue;
				}
				for (const { text, marks } of part.value) {
					edytor.insertText(targetBlock.id, at, text, marks ?? {});
					at += text.length;
				}
			}
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
			const block = selectionState(edytor).startBlock;
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
			const block = selectionState(edytor).startBlock;
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
			const block = selectionState(edytor).startBlock;
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
