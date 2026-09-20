/** @jsxImportSource ../../../jsx */
import { defineFixtures, defineModelTransformFixture } from '../../types.js';
import { splitAtSelection } from '../../helpers/model.js';
import { findBlockAndTextAtPath } from '../../../test.utils.js';

export const fixtures = defineFixtures([
	defineModelTransformFixture({
		description: 'splits text in the middle of a word',
		input: (
			<root>
				<paragraph>Hello wo|rld!</paragraph>
			</root>
		),
		run: ({ edytor }) => splitAtSelection(edytor),
		output: (
			<root>
				<paragraph>Hello wo</paragraph>
				<paragraph>rld!</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'splits text with marks correctly',
		input: (
			<root>
				<paragraph>
					Hello <bold>wo|rld</bold>!
				</paragraph>
			</root>
		),
		run: ({ edytor }) => splitAtSelection(edytor),
		output: (
			<root>
				<paragraph>
					Hello <bold>wo</bold>
				</paragraph>
				<paragraph>
					<bold>rld</bold>!
				</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'splits at the beginning of a line',
		input: (
			<root>
				<paragraph>|Hello world!</paragraph>
			</root>
		),
		run: ({ edytor }) => splitAtSelection(edytor),
		output: (
			<root>
				<paragraph></paragraph>
				<paragraph>Hello world!</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'splits at the end of a line',
		input: (
			<root>
				<paragraph>Hello world!|</paragraph>
			</root>
		),
		run: ({ edytor }) => splitAtSelection(edytor),
		output: (
			<root>
				<paragraph>Hello world!</paragraph>
				<paragraph></paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'splits text with multiple marks and formatting',
		input: (
			<root>
				<paragraph>
					Hello{' '}
					<bold>
						<italic>wo|rld</italic>
					</bold>{' '}
					<underline>today</underline>!
				</paragraph>
			</root>
		),
		run: ({ edytor }) => splitAtSelection(edytor),
		output: (
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
		)
	}),
	defineModelTransformFixture({
		description: 'splits nested list items correctly',
		input: (
			<root>
				<ordered-list>
					<list-item>First item</list-item>
					<list-item>Second item with |nested content</list-item>
					<list-item>Third item</list-item>
				</ordered-list>
			</root>
		),
		run: ({ edytor }) => splitAtSelection(edytor),
		output: (
			<root>
				<ordered-list>
					<list-item>First item</list-item>
					<list-item>Second item with </list-item>
					<list-item>nested content</list-item>
					<list-item>Third item</list-item>
				</ordered-list>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'handles splitting text with special characters and emojis',
		input: (
			<root>
				<paragraph>Hello 👋 wo|rld 🌍!</paragraph>
			</root>
		),
		run: ({ edytor }) => splitAtSelection(edytor),
		output: (
			<root>
				<paragraph>Hello 👋 wo</paragraph>
				<paragraph>rld 🌍!</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'splits text with multiple mentions and formatting',
		input: (
			<root>
				<paragraph>
					<bold>Hello</bold> <mention id="123">@John</mention> and <italic>wo|rld</italic>{' '}
					<mention id="456">@Jane</mention>
				</paragraph>
			</root>
		),
		run: ({ edytor }) => splitAtSelection(edytor),
		output: (
			<root>
				<paragraph>
					<bold>Hello</bold> <mention id="123">@John</mention> and <italic>wo</italic>
				</paragraph>
				<paragraph>
					<italic>rld</italic> <mention id="456">@Jane</mention>
				</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'splits a paragraph with nested paragraphs',
		input: (
			<root>
				<paragraph>
					Start of text |with nested paragraph
					<paragraph>Nested paragraph content</paragraph>
				</paragraph>
			</root>
		),
		run: ({ edytor }) => splitAtSelection(edytor),
		result: { kind: 'block', path: [1], type: 'paragraph' },
		output: (
			<root>
				<paragraph>Start of text </paragraph>
				<paragraph>
					with nested paragraph
					<paragraph>Nested paragraph content</paragraph>
				</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'splits whitespace-only text and preserves an editable empty block on both sides',
		input: (
			<root>
				<paragraph> | </paragraph>
			</root>
		),
		run: ({ edytor }) => splitAtSelection(edytor),
		result: { kind: 'block', path: [1], type: 'paragraph' },
		output: (
			<root>
				<paragraph> </paragraph>
				<paragraph> </paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'splits a nested paragraph that already has nested paragraphs',
		input: (
			<root>
				<paragraph>
					Start of text with nested paragraph
					<paragraph>
						Nested paragraph |content
						<paragraph>Another Nested paragraph content</paragraph>
					</paragraph>
				</paragraph>
			</root>
		),
		run: ({ edytor }) => splitAtSelection(edytor),
		output: (
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
		)
	}),
	defineModelTransformFixture({
		description: 'supports direct split invocation with an explicit block and text path',
		input: (
			<root>
				<paragraph>Hello| world!</paragraph>
			</root>
		),
		run: ({ edytor }) => {
			const { block, text } = findBlockAndTextAtPath(edytor)([0, 0]);
			return block.splitBlock({ index: 5, text });
		},
		output: (
			<root>
				<paragraph>Hello</paragraph>
				<paragraph> world!</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'returns null when splitting a block without a parent',
		input: (
			<root>
				<paragraph>Hello| world!</paragraph>
			</root>
		),
		run: ({ edytor }) => {
			const { text } = findBlockAndTextAtPath(edytor)([0, 0]);
			return edytor.root?.splitBlock({ index: 5, text }) ?? null;
		},
		result: { kind: 'null' },
		output: (
			<root>
				<paragraph>Hello world!</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'is a no-op when merging backward without a previous block',
		input: (
			<root>
				<paragraph>|Hello</paragraph>
			</root>
		),
		run: ({ edytor }) => edytor.selection.state.startBlock?.mergeBlockBackward() ?? null,
		result: { kind: 'null' },
		output: (
			<root>
				<paragraph>Hello</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'delegates backward merge to a forward merge when the first block is empty',
		input: (
			<root>
				<paragraph>|</paragraph>
				<paragraph>World</paragraph>
			</root>
		),
		run: ({ edytor }) => edytor.selection.state.startBlock?.mergeBlockBackward() ?? null,
		result: { kind: 'block', path: [0], type: 'paragraph' },
		output: (
			<root>
				<paragraph>World</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'merges a block backward into the previous block',
		input: (
			<root>
				<paragraph>Hello</paragraph>
				<paragraph>|world!</paragraph>
			</root>
		),
		run: ({ edytor }) => edytor.selection.state.startBlock?.mergeBlockBackward(),
		output: (
			<root>
				<paragraph>Helloworld!</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'merges backward, keeps the subtree order, and returns the merge target',
		input: (
			<root>
				<paragraph>Parent</paragraph>
				<paragraph>
					|Child carrier
					<paragraph>Nested 1</paragraph>
					<paragraph>Nested 2</paragraph>
				</paragraph>
				<paragraph>Last</paragraph>
			</root>
		),
		run: ({ edytor }) => edytor.selection.state.startBlock?.mergeBlockBackward() ?? null,
		result: { kind: 'block', path: [0], type: 'paragraph' },
		output: (
			<root>
				<paragraph>ParentChild carrier</paragraph>
				<paragraph>Nested 1</paragraph>
				<paragraph>Nested 2</paragraph>
				<paragraph>Last</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'merges backward while preserving marks',
		input: (
			<root>
				<paragraph>
					<bold>Hello</bold>
				</paragraph>
				<paragraph>
					<bold>|world!</bold>
				</paragraph>
			</root>
		),
		run: ({ edytor }) => edytor.selection.state.startBlock?.mergeBlockBackward(),
		output: (
			<root>
				<paragraph>
					<bold>Helloworld!</bold>
				</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'merges backward when the source block starts with inline content',
		input: (
			<root>
				<paragraph>Hello</paragraph>
				<paragraph>
					|<mention></mention>world
				</paragraph>
			</root>
		),
		run: ({ edytor }) => edytor.selection.state.startBlock?.mergeBlockBackward(),
		output: (
			<root>
				<paragraph>
					Hello<mention></mention>world
				</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'merges backward into an empty previous block',
		input: (
			<root>
				<paragraph></paragraph>
				<paragraph>|World</paragraph>
			</root>
		),
		run: ({ edytor }) => edytor.selection.state.startBlock?.mergeBlockBackward(),
		output: (
			<root>
				<paragraph>World</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'merges a block forward into the current block and returns the merge target',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
				<paragraph>world!</paragraph>
			</root>
		),
		run: ({ edytor }) => edytor.selection.state.startBlock?.mergeBlockForward() ?? null,
		result: { kind: 'block', path: [0], type: 'paragraph' },
		output: (
			<root>
				<paragraph>Helloworld!</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'is a no-op when merging forward without a next block',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		),
		run: ({ edytor }) => edytor.selection.state.startBlock?.mergeBlockForward() ?? null,
		result: { kind: 'null' },
		output: (
			<root>
				<paragraph>Hello</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'merges forward into an empty current block',
		input: (
			<root>
				<paragraph>|</paragraph>
				<paragraph>World</paragraph>
			</root>
		),
		run: ({ edytor }) => edytor.selection.state.startBlock?.mergeBlockForward() ?? null,
		result: { kind: 'block', path: [0], type: 'paragraph' },
		output: (
			<root>
				<paragraph>World</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description:
			'merges forward and preserves the next block children as siblings after the merge target',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
				<paragraph>
					world
					<paragraph>Child</paragraph>
				</paragraph>
				<paragraph>Last</paragraph>
			</root>
		),
		run: ({ edytor }) => edytor.selection.state.startBlock?.mergeBlockForward(),
		output: (
			<root>
				<paragraph>Helloworld</paragraph>
				<paragraph>Child</paragraph>
				<paragraph>Last</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'updates both block type and content',
		input: (
			<root>
				<paragraph>|Hello world!</paragraph>
			</root>
		),
		run: ({ edytor }) =>
			edytor.selection.state.startBlock?.setBlock({
				value: { type: 'list-item', content: [{ text: 'Hello world!' }] }
			}),
		output: (
			<root>
				<list-item>Hello world!</list-item>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'supports type-only changes without clearing existing content',
		input: (
			<root>
				<paragraph>|Hello world!</paragraph>
			</root>
		),
		run: ({ edytor }) =>
			edytor.selection.state.startBlock?.setBlock({ value: { type: 'list-item' } }),
		output: (
			<root>
				<list-item>Hello world!</list-item>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'supports content-only replacement without changing block type',
		input: (
			<root>
				<paragraph>|Hello world!</paragraph>
			</root>
		),
		run: ({ edytor }) =>
			edytor.selection.state.startBlock?.setBlock({
				value: { type: 'paragraph', content: [{ text: 'Updated content' }] }
			}),
		output: (
			<root>
				<paragraph>Updated content</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'supports children-only replacement without clearing block content',
		input: (
			<root>
				<paragraph>
					Parent|
					<paragraph>Old child</paragraph>
				</paragraph>
			</root>
		),
		run: ({ edytor }) =>
			edytor.selection.state.startBlock?.setBlock({
				value: {
					type: 'paragraph',
					children: [{ type: 'paragraph', content: [{ text: 'New child' }] }]
				}
			}),
		output: (
			<root>
				<paragraph>
					Parent
					<paragraph>New child</paragraph>
				</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'supports empty content replacement without changing the block type',
		input: (
			<root>
				<paragraph>|Hello world!</paragraph>
			</root>
		),
		run: ({ edytor }) =>
			edytor.selection.state.startBlock?.setBlock({
				value: { type: 'paragraph', content: [] }
			}),
		output: (
			<root>
				<paragraph></paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'supports empty children replacement while preserving the block content',
		input: (
			<root>
				<paragraph>
					Parent|
					<paragraph>Old child</paragraph>
				</paragraph>
			</root>
		),
		run: ({ edytor }) =>
			edytor.selection.state.startBlock?.setBlock({
				value: { type: 'paragraph', children: [] }
			}),
		output: (
			<root>
				<paragraph>Parent</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'supports data-only replacement',
		input: (
			<root>
				<paragraph>|Hello world!</paragraph>
			</root>
		),
		run: ({ edytor }) =>
			edytor.selection.state.startBlock?.setBlock({
				value: { type: 'paragraph', data: { align: 'center' } }
			}),
		output: (
			<root>
				<paragraph align="center">Hello world!</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'normalizes mixed inline content when replacing block content',
		input: (
			<root>
				<paragraph>|Hello world!</paragraph>
			</root>
		),
		run: ({ edytor }) =>
			edytor.selection.state.startBlock?.setBlock({
				value: {
					type: 'paragraph',
					content: [{ type: 'mention' }, { text: 'center' }, { type: 'mention' }]
				}
			}),
		output: (
			<root>
				<paragraph>
					<mention></mention>center<mention></mention>
				</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'inserts a sibling block before the current block',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		),
		run: ({ edytor }) => {
			const { block } = findBlockAndTextAtPath(edytor)([0, 0]);
			return block.insertBlockBefore({
				block: { type: 'paragraph', content: [{ text: 'Before' }] }
			});
		},
		output: (
			<root>
				<paragraph>Before</paragraph>
				<paragraph>Hello</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'returns null when inserting a sibling before the root block',
		input: (
			<root>
				<paragraph>Hello</paragraph>
			</root>
		),
		run: ({ edytor }) =>
			edytor.root?.insertBlockBefore({
				block: { type: 'paragraph', content: [{ text: 'Before' }] }
			}) ?? null,
		result: { kind: 'null' },
		output: (
			<root>
				<paragraph>Hello</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'inserts a sibling block after the current block',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		),
		run: ({ edytor }) => {
			const { block } = findBlockAndTextAtPath(edytor)([0, 0]);
			return block.insertBlockAfter({
				block: { type: 'paragraph', content: [{ text: 'After' }] }
			});
		},
		output: (
			<root>
				<paragraph>Hello</paragraph>
				<paragraph>After</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'returns null when inserting a sibling after the root block',
		input: (
			<root>
				<paragraph>Hello</paragraph>
			</root>
		),
		run: ({ edytor }) =>
			edytor.root?.insertBlockAfter({
				block: { type: 'paragraph', content: [{ text: 'After' }] }
			}) ?? null,
		result: { kind: 'null' },
		output: (
			<root>
				<paragraph>Hello</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description:
			'preserves the current subtree when inserting a sibling after a block with children',
		input: (
			<root>
				<paragraph>
					Parent|
					<paragraph>Child</paragraph>
				</paragraph>
			</root>
		),
		run: ({ edytor }) => {
			const { block } = findBlockAndTextAtPath(edytor)([0, 0]);
			return block.insertBlockAfter({
				block: { type: 'paragraph', content: [{ text: 'After' }] }
			});
		},
		result: { kind: 'block', path: [1], type: 'paragraph' },
		output: (
			<root>
				<paragraph>
					Parent
					<paragraph>Child</paragraph>
				</paragraph>
				<paragraph>After</paragraph>
			</root>
		)
	})
]);
