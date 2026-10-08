/** @jsxImportSource ../../../jsx */
import { mentionPlugin } from '../../../atMention.svelte';
import type { Plugin } from '$lib/plugins.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { defineFixtures, defineModelTransformFixture } from '../../types.js';
import { findBlockAndTextAtPath } from '../../../test.utils.js';

const noopSnippet = (() => null) as never;

const isolatedBlocksPlugin: Plugin = () => ({
	blocks: {
		'island-block': {
			snippet: noopSnippet,
			island: true
		}
	}
});

export const fixtures = defineFixtures([
	defineModelTransformFixture({
		description: 'adds a child block to an empty parent block',
		input: (
			<root>
				<paragraph>Parent|</paragraph>
			</root>
		),
		run: ({ edytor }) =>
			edytor.selection.state.startBlock?.addChildBlock({
				block: { type: 'paragraph' },
				index: 0
			}),
		output: (
			<root>
				<paragraph>
					Parent
					<paragraph></paragraph>
				</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'adds multiple child blocks at the requested index',
		input: (
			<root>
				<paragraph>
					Parent|
					<paragraph>Existing child</paragraph>
				</paragraph>
			</root>
		),
		run: ({ edytor }) =>
			edytor.selection.state.startBlock?.addChildBlocks({
				blocks: [
					{ type: 'paragraph', content: [{ text: 'Inserted 1' }] },
					{ type: 'paragraph', content: [{ text: 'Inserted 2' }] }
				],
				index: 0
			}),
		output: (
			<root>
				<paragraph>
					Parent
					<paragraph>Inserted 1</paragraph>
					<paragraph>Inserted 2</paragraph>
					<paragraph>Existing child</paragraph>
				</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'clamps overflow bulk child insertion to the end of the child list',
		input: (
			<root>
				<paragraph>
					Parent|
					<paragraph>Child 1</paragraph>
					<paragraph>Child 2</paragraph>
				</paragraph>
			</root>
		),
		run: ({ edytor }) =>
			edytor.selection.state.startBlock?.addChildBlocks({
				blocks: [{ type: 'paragraph', content: [{ text: 'Inserted' }] }],
				index: 99
			}),
		output: (
			<root>
				<paragraph>
					Parent
					<paragraph>Child 1</paragraph>
					<paragraph>Child 2</paragraph>
					<paragraph>Inserted</paragraph>
				</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'clamps negative bulk child insertion to the beginning of the child list',
		input: (
			<root>
				<paragraph>
					Parent|
					<paragraph>Child 1</paragraph>
					<paragraph>Child 2</paragraph>
				</paragraph>
			</root>
		),
		run: ({ edytor }) =>
			edytor.selection.state.startBlock?.addChildBlocks({
				blocks: [{ type: 'paragraph', content: [{ text: 'Inserted' }] }],
				index: -1
			}),
		output: (
			<root>
				<paragraph>
					Parent
					<paragraph>Inserted</paragraph>
					<paragraph>Child 1</paragraph>
					<paragraph>Child 2</paragraph>
				</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'clamps overflow single child insertion to the end of the child list',
		input: (
			<root>
				<paragraph>
					Parent|
					<paragraph>Child 1</paragraph>
					<paragraph>Child 2</paragraph>
				</paragraph>
			</root>
		),
		run: ({ edytor }) =>
			edytor.selection.state.startBlock?.addChildBlock({
				block: { type: 'paragraph', content: [{ text: 'Inserted' }] },
				index: 99
			}),
		result: { kind: 'block', path: [0, 2], type: 'paragraph' },
		output: (
			<root>
				<paragraph>
					Parent
					<paragraph>Child 1</paragraph>
					<paragraph>Child 2</paragraph>
					<paragraph>Inserted</paragraph>
				</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'clamps negative single child insertion to the beginning of the child list',
		input: (
			<root>
				<paragraph>
					Parent|
					<paragraph>Child 1</paragraph>
					<paragraph>Child 2</paragraph>
				</paragraph>
			</root>
		),
		run: ({ edytor }) =>
			edytor.selection.state.startBlock?.addChildBlock({
				block: { type: 'paragraph', content: [{ text: 'Inserted' }] },
				index: -1
			}),
		result: { kind: 'block', path: [0, 0], type: 'paragraph' },
		output: (
			<root>
				<paragraph>
					Parent
					<paragraph>Inserted</paragraph>
					<paragraph>Child 1</paragraph>
					<paragraph>Child 2</paragraph>
				</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'is a no-op when removing the root block',
		input: (
			<root>
				<paragraph>First</paragraph>
			</root>
		),
		run: ({ edytor }) => edytor.root?.removeBlock(),
		result: { kind: 'void' },
		output: (
			<root>
				<paragraph>First</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'removes a sibling block with no children',
		input: (
			<root>
				<paragraph>First paragraph</paragraph>
				<paragraph>|Second paragraph|</paragraph>
				<paragraph>Third paragraph</paragraph>
			</root>
		),
		run: ({ edytor }) => edytor.selection.state.startBlock?.removeBlock(),
		output: (
			<root>
				<paragraph>First paragraph</paragraph>
				<paragraph>Third paragraph</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'removes a nested list item and keeps its children',
		input: (
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
		),
		run: ({ edytor }) => edytor.selection.state.startBlock?.removeBlock({ keepChildren: true }),
		output: (
			<root>
				<ordered-list>
					<list-item>First item</list-item>
					<list-item>Child 1</list-item>
					<list-item>Child 2</list-item>
					<list-item>Last item</list-item>
				</ordered-list>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'removes a nested list item and drops its children',
		input: (
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
		),
		run: ({ edytor }) => edytor.selection.state.startBlock?.removeBlock({ keepChildren: false }),
		output: (
			<root>
				<ordered-list>
					<list-item>First item</list-item>
					<list-item>Last item</list-item>
				</ordered-list>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'removes a block that contains inline content',
		input: (
			<root>
				<paragraph>First</paragraph>
				<paragraph>
					|Hello <mention></mention> world|
				</paragraph>
				<paragraph>Last</paragraph>
			</root>
		),
		run: ({ edytor }) => edytor.selection.state.startBlock?.removeBlock(),
		output: (
			<root>
				<paragraph>First</paragraph>
				<paragraph>Last</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'nests a block under the previous sibling',
		input: (
			<root>
				<ordered-list>
					<list-item>First</list-item>
					<list-item>|Second</list-item>
				</ordered-list>
			</root>
		),
		run: ({ edytor }) => {
			const { block } = findBlockAndTextAtPath(edytor)([0, 1, 0]);
			return block.nestBlock();
		},
		output: (
			<root>
				<ordered-list>
					<list-item>
						First
						<list-item>Second</list-item>
					</list-item>
				</ordered-list>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'preserves a nested block subtree when nesting under the previous sibling',
		input: (
			<root>
				<ordered-list>
					<list-item>First</list-item>
					<list-item>
						|Second
						<list-item>Child</list-item>
					</list-item>
				</ordered-list>
			</root>
		),
		run: ({ edytor }) => {
			const { block } = findBlockAndTextAtPath(edytor)([0, 1, 0]);
			return block.nestBlock();
		},
		result: { kind: 'block', path: [0, 0, 0], type: 'list-item' },
		output: (
			<root>
				<ordered-list>
					<list-item>
						First
						<list-item>
							Second
							<list-item>Child</list-item>
						</list-item>
					</list-item>
				</ordered-list>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'does nothing when nesting the first sibling in a list',
		input: (
			<root>
				<ordered-list>
					<list-item>|First</list-item>
					<list-item>Second</list-item>
				</ordered-list>
			</root>
		),
		run: ({ edytor }) => {
			const { block } = findBlockAndTextAtPath(edytor)([0, 0, 0]);
			return block.nestBlock();
		},
		output: (
			<root>
				<ordered-list>
					<list-item>First</list-item>
					<list-item>Second</list-item>
				</ordered-list>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'unnests a block from its parent',
		input: (
			<root>
				<ordered-list>
					<list-item>
						First
						<list-item>|Second</list-item>
					</list-item>
				</ordered-list>
			</root>
		),
		run: ({ edytor }) => {
			const { block } = findBlockAndTextAtPath(edytor)([0, 0, 0, 0]);
			return block.unNestBlock();
		},
		output: (
			<root>
				<ordered-list>
					<list-item>First</list-item>
					<list-item>Second</list-item>
				</ordered-list>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'unnesting a middle child takes its following siblings along as its children',
		input: (
			<root>
				<ordered-list>
					<list-item>
						Parent
						<list-item>First child</list-item>
						<list-item>|Second child</list-item>
						<list-item>Third child</list-item>
					</list-item>
					<list-item>Tail</list-item>
				</ordered-list>
			</root>
		),
		run: ({ edytor }) => {
			const { block } = findBlockAndTextAtPath(edytor)([0, 0, 1, 0]);
			return block.unNestBlock();
		},
		result: { kind: 'block', path: [0, 1], type: 'list-item' },
		output: (
			<root>
				<ordered-list>
					<list-item>
						Parent
						<list-item>First child</list-item>
					</list-item>
					<list-item>
						Second child
						<list-item>Third child</list-item>
					</list-item>
					<list-item>Tail</list-item>
				</ordered-list>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'the `out` move of a middle child takes its following siblings along too',
		input: (
			<root>
				<paragraph>
					Parent
					<paragraph>First</paragraph>
					<paragraph>|Second</paragraph>
					<paragraph>Third</paragraph>
				</paragraph>
				<paragraph>Tail</paragraph>
			</root>
		),
		run: ({ edytor }) => {
			const { block } = findBlockAndTextAtPath(edytor)([0, 1, 0]);
			return edytor.moveBlocks({ blocks: [block], direction: 'out' })[0];
		},
		result: { kind: 'block', path: [1], type: 'paragraph' },
		output: (
			<root>
				<paragraph>
					Parent
					<paragraph>First</paragraph>
				</paragraph>
				<paragraph>
					Second
					<paragraph>Third</paragraph>
				</paragraph>
				<paragraph>Tail</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'an `out` move of sibling blocks hands the siblings after the last one to it',
		input: (
			<root>
				<paragraph>
					Parent
					<paragraph>First</paragraph>
					<paragraph>|Second</paragraph>
					<paragraph>Third</paragraph>
					<paragraph>Fourth</paragraph>
				</paragraph>
			</root>
		),
		run: ({ edytor }) => {
			const find = findBlockAndTextAtPath(edytor);
			const blocks = [find([0, 1, 0]).block, find([0, 2, 0]).block];
			return edytor.moveBlocks({ blocks, direction: 'out' }).length;
		},
		output: (
			<root>
				<paragraph>
					Parent
					<paragraph>First</paragraph>
				</paragraph>
				<paragraph>Second</paragraph>
				<paragraph>
					Third
					<paragraph>Fourth</paragraph>
				</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'a void block cannot adopt: its following siblings stay with the parent',
		input: (
			<root>
				<paragraph>
					Parent
					<paragraph>|First</paragraph>
					<divider />
					<paragraph>Third</paragraph>
				</paragraph>
			</root>
		),
		run: ({ edytor }) => {
			const { block } = findBlockAndTextAtPath(edytor)([0, 0, 0]);
			return block.nextBlock?.unNestBlock();
		},
		result: { kind: 'block', path: [1], type: 'divider' },
		output: (
			<root>
				<paragraph>
					Parent
					<paragraph>First</paragraph>
					<paragraph>Third</paragraph>
				</paragraph>
				<divider />
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'does nothing when unnesting a top-level child of the root',
		input: (
			<root>
				<paragraph>|First</paragraph>
				<paragraph>Second</paragraph>
			</root>
		),
		run: ({ edytor }) => edytor.selection.state.startBlock?.unNestBlock(),
		output: (
			<root>
				<paragraph>First</paragraph>
				<paragraph>Second</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'moves a block to a new position at the same level',
		input: (
			<root>
				<paragraph>First|</paragraph>
				<paragraph>Second</paragraph>
				<paragraph>Third</paragraph>
			</root>
		),
		run: ({ edytor }) => edytor.selection.state.startBlock?.moveBlock({ path: [2] }) ?? null,
		result: { kind: 'block', path: [2], type: 'paragraph' },
		output: (
			<root>
				<paragraph>Second</paragraph>
				<paragraph>Third</paragraph>
				<paragraph>First</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'preserves marks and subtree when moving a block',
		input: (
			<root>
				<paragraph>
					<bold>First|</bold>
					<paragraph>Child</paragraph>
				</paragraph>
				<paragraph>Second</paragraph>
			</root>
		),
		run: ({ edytor }) => edytor.selection.state.startBlock?.moveBlock({ path: [1] }) ?? null,
		result: { kind: 'block', path: [1], type: 'paragraph' },
		output: (
			<root>
				<paragraph>Second</paragraph>
				<paragraph>
					<bold>First</bold>
					<paragraph>Child</paragraph>
				</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'moves a block into a nested target',
		input: (
			<root>
				<paragraph>First|</paragraph>
				<paragraph>
					Parent
					<paragraph>Child</paragraph>
				</paragraph>
			</root>
		),
		run: ({ edytor }) => edytor.selection.state.startBlock?.moveBlock({ path: [1, 1] }),
		output: (
			<root>
				<paragraph>
					Parent
					<paragraph>Child</paragraph>
					<paragraph>First</paragraph>
				</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description:
			'nests a block inside its next sibling via moveBlock (shared-prefix path [0,0]→[0,1,0])',
		input: (
			<root>
				<paragraph>
					Parent
					<paragraph>Source|</paragraph>
					<paragraph>Target</paragraph>
				</paragraph>
			</root>
		),
		run: ({ edytor }) => edytor.selection.state.startBlock?.moveBlock({ path: [0, 1, 0] }) ?? null,
		result: { kind: 'block', path: [0, 0, 0], type: 'paragraph' },
		output: (
			<root>
				<paragraph>
					Parent
					<paragraph>
						Target
						<paragraph>Source</paragraph>
					</paragraph>
				</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'nests a block inside a next sibling that already has children',
		input: (
			<root>
				<paragraph>
					Parent
					<paragraph>Source|</paragraph>
					<paragraph>
						Target
						<paragraph>Existing child</paragraph>
					</paragraph>
				</paragraph>
			</root>
		),
		run: ({ edytor }) => edytor.selection.state.startBlock?.moveBlock({ path: [0, 1, 1] }) ?? null,
		result: { kind: 'block', path: [0, 0, 1], type: 'paragraph' },
		output: (
			<root>
				<paragraph>
					Parent
					<paragraph>
						Target
						<paragraph>Existing child</paragraph>
						<paragraph>Source</paragraph>
					</paragraph>
				</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'moves a block under a deeply nested destination block',
		input: (
			<root>
				<paragraph>
					Outer
					<paragraph>
						Middle
						<paragraph>
							Inner
							<paragraph>Existing child</paragraph>
						</paragraph>
					</paragraph>
				</paragraph>
				<paragraph>Source|</paragraph>
				<paragraph>Tail</paragraph>
			</root>
		),
		run: ({ edytor }) =>
			edytor.selection.state.startBlock?.moveBlock({ path: [0, 0, 0, 1] }) ?? null,
		result: { kind: 'block', path: [0, 0, 0, 1], type: 'paragraph' },
		output: (
			<root>
				<paragraph>
					Outer
					<paragraph>
						Middle
						<paragraph>
							Inner
							<paragraph>Existing child</paragraph>
							<paragraph>Source</paragraph>
						</paragraph>
					</paragraph>
				</paragraph>
				<paragraph>Tail</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'moves a nested block back to the root level',
		input: (
			<root>
				<paragraph>
					Parent
					<paragraph>Child|</paragraph>
				</paragraph>
				<paragraph>Last</paragraph>
			</root>
		),
		run: ({ edytor }) => edytor.selection.state.startBlock?.moveBlock({ path: [1] }),
		output: (
			<root>
				<paragraph>Parent</paragraph>
				<paragraph>Child</paragraph>
				<paragraph>Last</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'moves a deeply nested block back to a non-nested root position',
		input: (
			<root>
				<paragraph>Alpha</paragraph>
				<paragraph>
					Outer
					<paragraph>
						Middle
						<paragraph>
							Deep|
							<paragraph>Nested child</paragraph>
						</paragraph>
					</paragraph>
				</paragraph>
				<paragraph>Omega</paragraph>
			</root>
		),
		run: ({ edytor }) => edytor.selection.state.startBlock?.moveBlock({ path: [1] }) ?? null,
		result: { kind: 'block', path: [1], type: 'paragraph' },
		output: (
			<root>
				<paragraph>Alpha</paragraph>
				<paragraph>
					Deep
					<paragraph>Nested child</paragraph>
				</paragraph>
				<paragraph>
					Outer
					<paragraph>Middle</paragraph>
				</paragraph>
				<paragraph>Omega</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'does not mutate the caller path array when moving a block',
		input: (
			<root>
				<paragraph>First|</paragraph>
				<paragraph>Second</paragraph>
				<paragraph>Third</paragraph>
			</root>
		),
		run: ({ edytor }) => {
			const path = [2];
			const result = edytor.selection.state.startBlock?.moveBlock({ path }) ?? null;
			if (path.length !== 1 || path[0] !== 2) {
				throw new Error('moveBlock mutated the caller path array');
			}
			return result;
		},
		result: { kind: 'block', path: [2], type: 'paragraph' },
		output: (
			<root>
				<paragraph>Second</paragraph>
				<paragraph>Third</paragraph>
				<paragraph>First</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'does nothing when asked to move to an invalid path',
		input: (
			<root>
				<paragraph>First|</paragraph>
				<paragraph>Second</paragraph>
			</root>
		),
		run: ({ edytor }) => edytor.selection.state.startBlock?.moveBlock({ path: [5, 2, 1] }),
		output: (
			<root>
				<paragraph>First</paragraph>
				<paragraph>Second</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'does nothing when asked to move with an empty or negative path',
		input: (
			<root>
				<paragraph>First|</paragraph>
				<paragraph>Second</paragraph>
			</root>
		),
		run: ({ edytor }) => {
			const block = edytor.selection.state.startBlock;
			const emptyResult = block?.moveBlock({ path: [] }) ?? null;
			const negativeResult = block?.moveBlock({ path: [-1] }) ?? null;
			if (emptyResult !== null || negativeResult !== null) {
				throw new Error('Expected invalid moveBlock paths to return null');
			}
			return null;
		},
		result: { kind: 'null' },
		output: (
			<root>
				<paragraph>First</paragraph>
				<paragraph>Second</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'prevents moving a block into its own descendant path',
		input: (
			<root>
				<paragraph>
					Parent|
					<paragraph>Child 1</paragraph>
					<paragraph>Child 2</paragraph>
				</paragraph>
			</root>
		),
		run: ({ edytor }) => edytor.selection.state.startBlock?.moveBlock({ path: [0, 1] }),
		output: (
			<root>
				<paragraph>
					Parent
					<paragraph>Child 1</paragraph>
					<paragraph>Child 2</paragraph>
				</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'does not move a block inside a void block',
		input: (
			<root>
				<paragraph>Source|</paragraph>
				<divider></divider>
				<paragraph>Tail</paragraph>
			</root>
		),
		run: ({ edytor }) => edytor.selection.state.startBlock?.moveBlock({ path: [1, 0] }) ?? null,
		result: { kind: 'null' },
		output: (
			<root>
				<paragraph>Source</paragraph>
				<divider></divider>
				<paragraph>Tail</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'does not move a block inside an island block',
		plugins: [richTextPlugin, mentionPlugin, isolatedBlocksPlugin],
		input: (
			<root>
				<paragraph>Source|</paragraph>
				<island-block>Island</island-block>
				<paragraph>Tail</paragraph>
			</root>
		),
		run: ({ edytor }) => edytor.selection.state.startBlock?.moveBlock({ path: [1, 0] }) ?? null,
		result: { kind: 'null' },
		output: (
			<root>
				<paragraph>Source</paragraph>
				<island-block>Island</island-block>
				<paragraph>Tail</paragraph>
			</root>
		)
	})
]);
