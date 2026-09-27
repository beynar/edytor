/** @jsxImportSource ../../../jsx */
import { expect } from 'vitest';

import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { mentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
import { codePlugin } from '$lib/plugins/code/CodePlugin.svelte';
import { imagePlugin } from '$lib/plugins/image/ImagePlugin.svelte';
import type { Plugin } from '$lib/plugins.js';
import { expectOperationResult, removeIds } from '../../../test.utils.js';
import { emptyFixture } from '../../helpers/model.js';
import { defineFixtures, defineModelTransformFixture } from '../../types.js';

const noopSnippet = (() => null) as never;

const structuralBranchPlugin: Plugin = () => ({
	blocks: {
		'void-block': {
			snippet: noopSnippet,
			void: true
		},
		'island-block': {
			snippet: noopSnippet,
			island: true
		}
	}
});

export const fixtures = defineFixtures([
	defineModelTransformFixture({
		description: 'does not nest under a previous void block',
		input: (
			<root>
				<void-block>Locked</void-block>
				<paragraph>|Child</paragraph>
			</root>
		),
		plugins: [richTextPlugin, mentionPlugin, structuralBranchPlugin],
		run: ({ edytor }) => edytor.selection.state.startBlock?.nestBlock() ?? null,
		result: { kind: 'null' },
		output: (
			<root>
				<void-block>Locked</void-block>
				<paragraph>Child</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'does not nest under a previous island block',
		input: (
			<root>
				<island-block>Island</island-block>
				<paragraph>|Child</paragraph>
			</root>
		),
		plugins: [richTextPlugin, mentionPlugin, structuralBranchPlugin],
		run: ({ edytor }) => edytor.selection.state.startBlock?.nestBlock() ?? null,
		result: { kind: 'null' },
		output: (
			<root>
				<island-block>Island</island-block>
				<paragraph>Child</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'does not merge backward into a previous void block',
		input: (
			<root>
				<void-block>Locked</void-block>
				<paragraph>|Child</paragraph>
			</root>
		),
		plugins: [richTextPlugin, mentionPlugin, structuralBranchPlugin],
		run: ({ edytor }) => edytor.selection.state.startBlock?.mergeBlockBackward() ?? null,
		result: { kind: 'null' },
		output: (
			<root>
				<void-block>Locked</void-block>
				<paragraph>Child</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'does not merge backward into an image void block',
		input: (
			<root>
				<image>caption</image>
				<paragraph>|Child</paragraph>
			</root>
		),
		plugins: [richTextPlugin, mentionPlugin, imagePlugin],
		run: ({ edytor }) => edytor.selection.state.startBlock?.mergeBlockBackward() ?? null,
		result: { kind: 'null' },
		output: (
			<root>
				<image>caption</image>
				<paragraph>Child</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'does not merge forward from a void block',
		input: (
			<root>
				<void-block>Locked|</void-block>
				<paragraph>Child</paragraph>
			</root>
		),
		plugins: [richTextPlugin, mentionPlugin, structuralBranchPlugin],
		run: ({ edytor }) => edytor.selection.state.startBlock?.mergeBlockForward() ?? null,
		result: { kind: 'null' },
		output: (
			<root>
				<void-block>Locked</void-block>
				<paragraph>Child</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'prevents merging backward when the code line is the only child',
		input: emptyFixture,
		plugins: [richTextPlugin, mentionPlugin, codePlugin],
		value: {
			children: [
				{
					type: 'code',
					children: [{ type: 'codeLine', content: [{ text: '|const a = 1;' }] }]
				}
			]
		},
		run: ({ edytor }) => {
			// The veto refuses the command; the dispatcher catches `prevent()` (S1).
			edytor.selection.state.startBlock?.mergeBlockBackward();
			expect(edytor.dispatcher.last).toMatchObject({ status: 'refused' });
			return null;
		},
		assert: ({ edytor }) => {
			expect(removeIds(structuredClone(edytor.root?.value.children ?? []))).toEqual([
				{
					type: 'code',
					data: {},
					children: [{ type: 'codeLine', data: {}, content: [{ text: 'const a = 1;' }] }]
				}
			]);
		}
	}),
	defineModelTransformFixture({
		description: 'prevents merging forward when the code line is the last child',
		input: emptyFixture,
		plugins: [richTextPlugin, mentionPlugin, codePlugin],
		value: {
			children: [
				{
					type: 'code',
					children: [{ type: 'codeLine', content: [{ text: '|const a = 1;' }] }]
				}
			]
		},
		run: ({ edytor }) => {
			edytor.selection.state.startBlock?.mergeBlockForward();
			expect(edytor.dispatcher.last).toMatchObject({ status: 'refused' });
			return null;
		},
		assert: ({ edytor }) => {
			expect(removeIds(structuredClone(edytor.root?.value.children ?? []))).toEqual([
				{
					type: 'code',
					data: {},
					children: [{ type: 'codeLine', data: {}, content: [{ text: 'const a = 1;' }] }]
				}
			]);
		}
	}),
	defineModelTransformFixture({
		description: 'splits multiline code-line content into sibling code lines during normalization',
		input: emptyFixture,
		plugins: [richTextPlugin, mentionPlugin, codePlugin],
		value: {
			children: [
				{
					type: 'code',
					children: [{ type: 'codeLine', content: [{ text: '|const a = 1;' }] }]
				}
			]
		},
		run: ({ edytor }) =>
			edytor.selection.state.startBlock?.setBlock({
				value: {
					type: 'codeLine',
					content: [{ text: 'const a = 1;\nconst b = 2;\nconst c = 3;' }]
				}
			}),
		assert: ({ edytor }) => {
			expect(removeIds(structuredClone(edytor.root?.value.children ?? []))).toEqual([
				{
					type: 'code',
					data: {},
					children: [
						{ type: 'codeLine', data: {}, content: [{ text: 'const a = 1;' }] },
						{ type: 'codeLine', data: {}, content: [{ text: 'const b = 2;' }] },
						{ type: 'codeLine', data: {}, content: [{ text: 'const c = 3;' }] }
					]
				}
			]);
		}
	}),
	defineModelTransformFixture({
		description: 'treats direct block transformations as no-ops',
		input: (
			<root>
				<paragraph>Hello| world</paragraph>
			</root>
		),
		readonly: true,
		run: ({ edytor }) => {
			const { startBlock, startText, yStart } = edytor.selection.state;
			return startBlock?.addInlineBlock({
				index: yStart,
				block: { type: 'mention' },
				text: startText!
			});
		},
		result: { kind: 'void' },
		output: (
			<root>
				<paragraph>Hello world</paragraph>
			</root>
		)
	}),
	defineModelTransformFixture({
		description: 'moves mention-rich content without dropping inline blocks',
		input: (
			<root>
				<paragraph>
					Hello <mention id="123">@Ada</mention>|
				</paragraph>
				<paragraph>Last</paragraph>
			</root>
		),
		run: ({ edytor }) => edytor.selection.state.startBlock?.moveBlock({ path: [1] }) ?? null,
		result: { kind: 'block', path: [1], type: 'paragraph' },
		output: (
			<root>
				<paragraph>Last</paragraph>
				<paragraph>
					Hello <mention id="123">@Ada</mention>
				</paragraph>
			</root>
		)
	})
]);
