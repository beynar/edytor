/** @jsxImportSource ../../../jsx */
import { expect } from 'vitest';

import { defineFixtures, defineModelTransformFixture } from '../../types.js';
import { deleteBlockRangeAtSelection } from '../../helpers/model.js';

export const fixtures = defineFixtures([
	defineModelTransformFixture({
		description: 'treats a two-marker fixture as a non-collapsed selection',
		input: (
			<root>
				<paragraph>Hello |world|!</paragraph>
			</root>
		),
		run: () => null,
		assert: ({ edytor }) => {
			expect(edytor.selection.state.isCollapsed).toBe(false);
			expect(edytor.selection.state.isTextSpanning).toBe(false);
			expect(edytor.selection.state.isBlockSpanning).toBe(false);
			expect(edytor.selection.state.length).toBe(5);
			expect(edytor.selection.state.content).toBe('world');
		}
	}),
	defineModelTransformFixture({
		description: 'deletes content within a single text part',
		input: (
			<root>
				<paragraph>Hello |world|!</paragraph>
			</root>
		),
		run: ({ edytor }) => deleteBlockRangeAtSelection(edytor),
		output: (
			<root>
				<paragraph>Hello !</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'deletes only an inline block when the range starts and ends on its boundaries',
		input: (
			<root>
				<paragraph>
					Hello|<mention></mention>|world
				</paragraph>
			</root>
		),
		run: ({ edytor }) => deleteBlockRangeAtSelection(edytor),
		output: (
			<root>
				<paragraph>Helloworld</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'deletes across multiple text parts in a single block',
		input: (
			<root>
				<paragraph>
					Hello <bold>|world</bold> and <italic>mo|re</italic>
				</paragraph>
			</root>
		),
		run: ({ edytor }) => deleteBlockRangeAtSelection(edytor),
		output: (
			<root>
				<paragraph>
					Hello <italic>re</italic>
				</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'deletes across an inline block and collapses the remaining text back together',
		input: (
			<root>
				<paragraph>
					Hello |<mention></mention>wo|rld
				</paragraph>
			</root>
		),
		run: ({ edytor }) => deleteBlockRangeAtSelection(edytor),
		output: (
			<root>
				<paragraph>Hello rld</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'deletes the full content of a block and leaves an editable empty paragraph',
		input: (
			<root>
				<paragraph>|Hello world!|</paragraph>
			</root>
		),
		run: ({ edytor }) => deleteBlockRangeAtSelection(edytor),
		output: (
			<root>
				<paragraph></paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description:
			'deletes across marked text and inline content without leaving split text fragments',
		input: (
			<root>
				<paragraph>
					<bold>Hello |wo</bold>
					<mention></mention>
					<italic>rl|d</italic>
				</paragraph>
			</root>
		),
		run: ({ edytor }) => deleteBlockRangeAtSelection(edytor),
		output: (
			<root>
				<paragraph>
					<bold>Hello </bold>
					<italic>d</italic>
				</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'falls back to same-block range deletion and returns the collapsed caret target',
		input: (
			<root>
				<paragraph>Hello |world|!</paragraph>
			</root>
		),
		run: ({ edytor }) => edytor.deleteContentWithinSelection({}),
		result: { kind: 'cursor', path: [0, 0], offset: 6 },
		output: (
			<root>
				<paragraph>Hello !</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'deletes across blocks and merges the remaining tail into the start block',
		input: (
			<root>
				<paragraph>Fi|rst</paragraph>
				<paragraph>Middle</paragraph>
				<paragraph>La|st</paragraph>
			</root>
		),
		run: ({ edytor }) => edytor.deleteContentWithinSelection({}),
		output: (
			<root>
				<paragraph>Fist</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description:
			'deletes from an exact block start to an exact block end and keeps the root editable',
		input: (
			<root>
				<paragraph>|First</paragraph>
				<paragraph>Second|</paragraph>
			</root>
		),
		run: ({ edytor }) => edytor.deleteContentWithinSelection({}),
		output: (
			<root>
				<paragraph></paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description:
			'deletes across blocks and preserves end-block children under the start-block parent',
		input: (
			<root>
				<paragraph>Fi|rst</paragraph>
				<paragraph>
					Se|cond
					<paragraph>Child</paragraph>
				</paragraph>
			</root>
		),
		run: ({ edytor }) => edytor.deleteContentWithinSelection({}),
		output: (
			<root>
				<paragraph>Ficond</paragraph>
				<paragraph>Child</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description:
			'deletes across blocks while preserving start and end subtrees in the correct places',
		input: (
			<root>
				<paragraph>
					Fi|rst
					<paragraph>Start child</paragraph>
				</paragraph>
				<paragraph>
					Se|cond
					<paragraph>End child</paragraph>
				</paragraph>
			</root>
		),
		run: ({ edytor }) => edytor.deleteContentWithinSelection({}),
		output: (
			<root>
				<paragraph>Ficond</paragraph>
				<paragraph>End child</paragraph>
			</root>
		)
	})
]);
