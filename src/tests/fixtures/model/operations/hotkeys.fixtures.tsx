/** @jsxImportSource ../../../jsx */
import { expect } from 'vitest';

import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { mentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
import { codePlugin } from '$lib/plugins/code/CodePlugin.svelte';
import { emptyFixture } from '../../helpers/model.js';
import { defineFixtures, defineModelOperationFixture } from '../../types.js';
import { runHotkey } from '../../../test.utils.js';

export const fixtures = defineFixtures([
	defineModelOperationFixture({
		description: 'undoes and redoes document changes with mod+z and mod+shift+z',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			const startText = edytor.selection.state.startText;
			if (!startText) {
				throw new Error('Missing startText for undo/redo test');
			}

			startText.insertText({ value: '!' });
			await runHotkey(edytor, 'mod+z');
			await runHotkey(edytor, 'mod+shift+z');
		},
		output: (
			<root>
				<paragraph>Hello!</paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'splits the current block at the end with mod+enter',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		),
		run: ({ edytor }) => runHotkey(edytor, 'mod+enter'),
		expectSelection: { startBlockPath: [1], yStart: 0, yEnd: 0, isCollapsed: true },
		output: (
			<root>
				<paragraph>Hello</paragraph>
				<paragraph></paragraph>
			</root>
		),
		assert: async ({ result }) => {
			if (!(result as { defaultPrevented?: boolean }).defaultPrevented) {
				throw new Error('Expected mod+enter to prevent the native event');
			}
		}
	}),
	defineModelOperationFixture({
		description: 'moves from text-range selection to block selection with repeated mod+a',
		input: (
			<root>
				<paragraph>Hel|lo</paragraph>
				<paragraph>World</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			await runHotkey(edytor, 'mod+a');
			await runHotkey(edytor, 'mod+a');
		},
		expectSelection: { selectedBlockPaths: [[0]] }
	}),
	defineModelOperationFixture({
		description: 'inserts a tab character inside a code line',
		input: emptyFixture,
		plugins: [richTextPlugin, mentionPlugin, codePlugin],
		value: {
			children: [
				{
					type: 'code',
					children: [{ type: 'codeLine', content: [{ text: 'const value = |1;' }] }]
				}
			]
		},
		run: ({ edytor }) => runHotkey(edytor, 'tab'),
		expectSelection: { startBlockPath: [0, 0], yStart: 15, yEnd: 15, isCollapsed: true },
		output: {
			value: {
				children: [
					{
						type: 'code',
						data: {},
						children: [{ type: 'codeLine', data: {}, content: [{ text: 'const value = \t1;' }] }]
					}
				]
			}
		} as never
	}),
	defineModelOperationFixture({
		description: 'accepts code suggestions on tab and clears the suggestion state',
		input: emptyFixture,
		plugins: [richTextPlugin, mentionPlugin, codePlugin],
		value: {
			children: [
				{
					type: 'code',
					children: [{ type: 'codeLine', content: [{ text: 'const value = 1;|' }] }]
				}
			]
		},
		run: async ({ edytor }) => {
			const startBlock = edytor.selection.state.startBlock;
			if (!startBlock) {
				throw new Error('Missing startBlock for code suggestion test');
			}

			startBlock.suggestions = [[{ text: ' // done' }]];
			await runHotkey(edytor, 'tab');
		},
		output: {
			value: {
				children: [
					{
						type: 'code',
						data: {},
						children: [
							{ type: 'codeLine', data: {}, content: [{ text: 'const value = 1; // done' }] }
						]
					}
				]
			}
		} as never,
		assert: ({ edytor }) => {
			expect(edytor.selection.state.startBlock?.suggestions ?? null).toBeNull();
		}
	}),
	defineModelOperationFixture({
		description: 'clears code suggestions on escape',
		input: emptyFixture,
		plugins: [richTextPlugin, mentionPlugin, codePlugin],
		value: {
			children: [
				{
					type: 'code',
					children: [{ type: 'codeLine', content: [{ text: 'const value = 1;|' }] }]
				}
			]
		},
		run: async ({ edytor }) => {
			const startBlock = edytor.selection.state.startBlock;
			if (!startBlock) {
				throw new Error('Missing startBlock for suggestion clear test');
			}

			startBlock.suggestions = [[{ text: ' // done' }]];
			await runHotkey(edytor, 'escape');
		},
		assert: ({ edytor }) => {
			expect(edytor.selection.state.startBlock?.suggestions ?? null).toBeNull();
		}
	}),
	defineModelOperationFixture({
		description: 'routes shift+enter in code lines to insertParagraph',
		input: emptyFixture,
		plugins: [richTextPlugin, mentionPlugin, codePlugin],
		value: {
			children: [
				{
					type: 'code',
					children: [{ type: 'codeLine', content: [{ text: 'const value = 1;|' }] }]
				}
			]
		},
		run: ({ edytor }) => runHotkey(edytor, 'shift+enter'),
		expectSelection: { startBlockPath: [0, 1], yStart: 0, yEnd: 0, isCollapsed: true },
		output: {
			value: {
				children: [
					{
						type: 'code',
						data: {},
						children: [
							{ type: 'codeLine', data: {}, content: [{ text: 'const value = 1;' }] },
							{ type: 'paragraph', data: {} }
						]
					}
				]
			}
		} as never
	})
]);
